// Package firecracker scans /proc for firecracker processes and computes
// a per-process %CPU over a short rolling window.
//
// Why not parse `ps -eo pcpu`: that's the cumulative-since-process-start
// average, which is useless for "is this thing pinning a vCPU right
// now". We hold our own two-snapshot delta over `interval` (default 5s)
// so the reported pct matches what `top` would show.
package firecracker

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Proc is the per-firecracker process row returned to clients.
type Proc struct {
	PID       int     `json:"pid"`
	SandboxID string  `json:"sandbox_id,omitempty"` // parsed from --api-sock arg
	APISock   string  `json:"api_sock,omitempty"`
	CPUPct    float64 `json:"cpu_pct"`              // rolling-window average
	AgeSec    float64 `json:"age_sec"`              // elapsed wall-clock since start
	RSSMiB    uint64  `json:"rss_mib"`
	State     string  `json:"state"`                // /proc/<pid>/status:State
}

// Sampler maintains a goroutine-safe latest snapshot. Run() polls every
// `interval`; Snapshot() returns the most recent slice in O(1).
type Sampler struct {
	procRoot string
	interval time.Duration

	mu    sync.RWMutex
	last  []Proc
	prior map[int]procStat // jiffies-at-prior-tick for delta math
}

type procStat struct {
	utime    uint64
	stime    uint64
	starttime uint64 // jiffies since boot
	captured time.Time
}

func NewSampler(procRoot string, interval time.Duration) *Sampler {
	return &Sampler{
		procRoot: procRoot,
		interval: interval,
		prior:    map[int]procStat{},
	}
}

// Run blocks. Cancel ctx to stop.
func (s *Sampler) Run(ctx context.Context) {
	s.tick()
	t := time.NewTicker(s.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick()
		}
	}
}

// Snapshot returns a defensive copy of the latest scan.
func (s *Sampler) Snapshot() []Proc {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Proc, len(s.last))
	copy(out, s.last)
	return out
}

// ─── internals ──────────────────────────────────────────────────────

// sockRe parses sandbox id out of `--api-sock /tmp/fc-<sbx>-<rand>.sock`.
// The orchestrator generates that path via SandboxFiles in
// shared/pkg/storage/sandbox.go — the prefix `fc-` and the dash-delimited
// `sbx-random.sock` shape are stable.
var sockRe = regexp.MustCompile(`/tmp/fc-([^-]+)-[^.]+\.sock`)

func (s *Sampler) tick() {
	entries, err := os.ReadDir(s.procRoot)
	if err != nil {
		return
	}

	now := time.Now()
	uptimeJiffies := bootJiffies(s.procRoot, now)
	clkTck := userHZ() // kernel default 100 Hz; we sample with 100 Hz assumption

	newProcs := make([]Proc, 0, 4)
	newPrior := make(map[int]procStat, len(s.prior))

	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		comm, err := os.ReadFile(filepath.Join(s.procRoot, e.Name(), "comm"))
		if err != nil {
			continue
		}
		if strings.TrimSpace(string(comm)) != "firecracker" {
			continue
		}

		// cmdline → extract --api-sock
		cmdlineBytes, _ := os.ReadFile(filepath.Join(s.procRoot, e.Name(), "cmdline"))
		// argv is NUL-separated; turn into space-separated for the regex.
		cmdline := strings.ReplaceAll(string(cmdlineBytes), "\x00", " ")
		var sock, sbxID string
		if m := sockRe.FindStringSubmatch(cmdline); m != nil {
			sock = m[0]
			sbxID = m[1]
		}

		// stat → utime/stime/starttime
		stat, ok := readProcStat(filepath.Join(s.procRoot, e.Name(), "stat"))
		if !ok {
			continue
		}

		// CPU% over the window
		cpuPct := 0.0
		if p, ok := s.prior[pid]; ok && !p.captured.IsZero() {
			elapsed := now.Sub(p.captured).Seconds()
			if elapsed > 0 {
				totalJiff := float64((stat.utime + stat.stime) - (p.utime + p.stime))
				// jiff / clkTck = seconds of CPU; / elapsed = ratio
				cpuPct = (totalJiff / float64(clkTck)) / elapsed * 100
			}
		}
		newPrior[pid] = procStat{
			utime:    stat.utime,
			stime:    stat.stime,
			starttime: stat.starttime,
			captured: now,
		}

		// age (wall-clock since process start)
		ageSec := 0.0
		if uptimeJiffies > 0 && stat.starttime > 0 {
			started := float64(uptimeJiffies-stat.starttime) / float64(clkTck)
			ageSec = started
		}

		// status → RSS + state
		rssMiB, state := readStatus(filepath.Join(s.procRoot, e.Name(), "status"))

		newProcs = append(newProcs, Proc{
			PID:       pid,
			SandboxID: sbxID,
			APISock:   sock,
			CPUPct:    cpuPct,
			AgeSec:    ageSec,
			RSSMiB:    rssMiB,
			State:     state,
		})
	}

	s.mu.Lock()
	s.last = newProcs
	s.prior = newPrior
	s.mu.Unlock()
}

type rawStat struct {
	utime     uint64
	stime     uint64
	starttime uint64
}

// readProcStat parses /proc/<pid>/stat. Fields are space-separated EXCEPT
// comm (field 2) which is `(name)` and may contain spaces/parens; we
// strip everything up to and including the rightmost `)` before splitting.
// Field indices (1-based, post-stripping): 1=pid, 2=state, 14=utime,
// 15=stime, 22=starttime.
func readProcStat(path string) (rawStat, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return rawStat{}, false
	}
	s := string(b)
	closeParen := strings.LastIndex(s, ")")
	if closeParen == -1 {
		return rawStat{}, false
	}
	// After ")" : "  S 12345 ..." — fields shift, first post-paren
	// token is field 3 (state).
	rest := strings.Fields(s[closeParen+1:])
	if len(rest) < 21 {
		return rawStat{}, false
	}
	// rest[0] = field 3 = state
	// rest[11] = field 14 = utime
	// rest[12] = field 15 = stime
	// rest[19] = field 22 = starttime
	utime, _ := strconv.ParseUint(rest[11], 10, 64)
	stime, _ := strconv.ParseUint(rest[12], 10, 64)
	starttime, _ := strconv.ParseUint(rest[19], 10, 64)
	return rawStat{utime: utime, stime: stime, starttime: starttime}, true
}

func readStatus(path string) (rssMiB uint64, state string) {
	f, err := os.Open(path)
	if err != nil {
		return 0, ""
	}
	defer f.Close()
	buf := make([]byte, 4096)
	n, _ := f.Read(buf)
	for _, line := range strings.Split(string(buf[:n]), "\n") {
		if strings.HasPrefix(line, "VmRSS:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, _ := strconv.ParseUint(fields[1], 10, 64)
				rssMiB = kb / 1024
			}
		} else if strings.HasPrefix(line, "State:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				state = fields[1]
			}
		}
	}
	return rssMiB, state
}

// bootJiffies returns "jiffies since boot at time `now`" — used to
// compute process wall-clock age. Combining /proc/uptime (seconds) with
// the kernel HZ gives the number we want.
func bootJiffies(procRoot string, _ time.Time) uint64 {
	b, err := os.ReadFile(filepath.Join(procRoot, "uptime"))
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) < 1 {
		return 0
	}
	upSec, _ := strconv.ParseFloat(fields[0], 64)
	return uint64(upSec * float64(userHZ()))
}

// userHZ is the kernel's clock-tick rate. Practically always 100, but
// the syscall is cheap; we cache after first read.
var (
	clkTckOnce sync.Once
	clkTck     int = 100
)

func userHZ() int {
	clkTckOnce.Do(func() {
		// Could shell out to `getconf CLK_TCK`, but 100 is the universal
		// default and reading /proc doesn't expose it directly. Keep
		// fallback unless someone overrides via env.
		if v := os.Getenv("HIVE_OPS_USER_HZ"); v != "" {
			if i, err := strconv.Atoi(v); err == nil && i > 0 {
				clkTck = i
			}
		}
	})
	return clkTck
}
