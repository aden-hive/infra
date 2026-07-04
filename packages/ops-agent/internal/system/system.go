// Package system reads host-level resource snapshots from /proc and /sys
// and maintains a rolling 1h ring buffer for sparklines.
//
// The snapshot is intentionally a flat key→number shape so the portal
// can render each metric as its own series without thinking. Anything
// derived (memory %used, disk %full) is computed once here so the
// browser doesn't have to.
package system

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Snapshot is one tick of host-level resource state. Values are absolute
// (e.g. bytes for memory) so the portal can decide how to format them.
type Snapshot struct {
	CapturedAt string `json:"captured_at"`

	// Memory in bytes. `Available` is what the kernel calls "MemAvailable":
	// the right number for "could I start a new process now without
	// triggering OOM" — NOT total - used. Used = Total - Available so the
	// chart of "what's consumed" matches what `free` shows.
	MemTotalBytes     uint64  `json:"mem_total_bytes"`
	MemAvailableBytes uint64  `json:"mem_available_bytes"`
	MemUsedBytes      uint64  `json:"mem_used_bytes"`
	MemUsedPct        float64 `json:"mem_used_pct"`

	SwapTotalBytes uint64  `json:"swap_total_bytes"`
	SwapUsedBytes  uint64  `json:"swap_used_bytes"`
	SwapUsedPct    float64 `json:"swap_used_pct"`

	// Load averages from /proc/loadavg.
	Load1  float64 `json:"load1"`
	Load5  float64 `json:"load5"`
	Load15 float64 `json:"load15"`

	// CPU count for normalizing load (load == cpus → 100% saturation).
	NumCPU int `json:"num_cpu"`

	// Uptime in seconds since boot.
	UptimeSec float64 `json:"uptime_sec"`

	// Disk usage for the volume mount point (where every team's data
	// lives) and the orchestrator's working dir (snapshots, builds).
	DiskHivedata DiskStat `json:"disk_hivedata"`
	DiskOrch     DiskStat `json:"disk_orch"`

	// Sum of /proc/<pid>/stat for ALL firecracker processes. Useful for
	// "how much of the host is the VM fleet consuming."
	FCTotalCount    int     `json:"fc_total_count"`
	FCTotalCPUPct   float64 `json:"fc_total_cpu_pct"` // sum of recent %CPU samples
	FCTotalRSSMiB   uint64  `json:"fc_total_rss_mib"`

	// Errors encountered while reading individual fields. Reported per
	// field so the page can still render the parts that worked.
	Errors map[string]string `json:"errors,omitempty"`
}

type DiskStat struct {
	Path        string  `json:"path"`
	TotalBytes  uint64  `json:"total_bytes"`
	UsedBytes   uint64  `json:"used_bytes"`
	AvailBytes  uint64  `json:"avail_bytes"`
	UsedPct     float64 `json:"used_pct"`
	Available   bool    `json:"available"`
}

// History is the goroutine-safe rolling buffer + last-snapshot cache.
type History struct {
	procRoot string
	interval time.Duration
	size     int

	// Optional fleet roll-up folded into every sample (fc_total_*).
	// Nil leaves those fields zero. Set before Run — not synchronized.
	fcTotals func() (count int, cpuPct float64, rssMiB uint64)

	mu      sync.RWMutex
	current Snapshot
	ring    []Snapshot // newest at the tail; len ≤ size
}

// SetFCTotals wires the firecracker sampler's totals into each sample.
// Must be called before Run.
func (h *History) SetFCTotals(fn func() (count int, cpuPct float64, rssMiB uint64)) {
	h.fcTotals = fn
}

func NewHistory(procRoot string, interval time.Duration, size int) *History {
	return &History{
		procRoot: procRoot,
		interval: interval,
		size:     size,
		ring:     make([]Snapshot, 0, size),
	}
}

// Run blocks. Cancel ctx to stop. Samples once at startup so the very
// first /system call from the portal isn't an empty payload.
func (h *History) Run(ctx context.Context) {
	h.tick()
	t := time.NewTicker(h.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.tick()
		}
	}
}

// Snapshot returns the most recent sample plus the full history slice
// (defensive copy — callers can range over it without lock concerns).
func (h *History) Snapshot() (Snapshot, []Snapshot) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	cur := h.current
	hist := make([]Snapshot, len(h.ring))
	copy(hist, h.ring)
	return cur, hist
}

func (h *History) tick() {
	snap := Collect(h.procRoot)
	if h.fcTotals != nil {
		snap.FCTotalCount, snap.FCTotalCPUPct, snap.FCTotalRSSMiB = h.fcTotals()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.current = snap
	if len(h.ring) >= h.size {
		copy(h.ring, h.ring[1:])
		h.ring = h.ring[:h.size-1]
	}
	h.ring = append(h.ring, snap)
}

// Collect synchronously reads one snapshot. Safe to call from anywhere.
// Partial failures populate `Errors` rather than returning a sentinel.
func Collect(procRoot string) Snapshot {
	s := Snapshot{
		CapturedAt: time.Now().UTC().Format(time.RFC3339),
		NumCPU:     runtime.NumCPU(),
		Errors:     map[string]string{},
	}

	if err := readMemInfo(filepath.Join(procRoot, "meminfo"), &s); err != nil {
		s.Errors["meminfo"] = err.Error()
	}
	if err := readLoadAvg(filepath.Join(procRoot, "loadavg"), &s); err != nil {
		s.Errors["loadavg"] = err.Error()
	}
	if err := readUptime(filepath.Join(procRoot, "uptime"), &s); err != nil {
		s.Errors["uptime"] = err.Error()
	}

	s.DiskHivedata = statfsOrZero("/srv/hivedata")
	s.DiskOrch = statfsOrZero("/orchestrator")

	if len(s.Errors) == 0 {
		s.Errors = nil
	}
	return s
}

// ─── /proc parsers ──────────────────────────────────────────────────

func readMemInfo(path string, s *Snapshot) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var memTotalKB, memAvailKB, swapTotalKB, swapFreeKB uint64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		// MemTotal:        12345 kB
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		key := strings.TrimSuffix(fields[0], ":")
		val, perr := strconv.ParseUint(fields[1], 10, 64)
		if perr != nil {
			continue
		}
		switch key {
		case "MemTotal":
			memTotalKB = val
		case "MemAvailable":
			memAvailKB = val
		case "SwapTotal":
			swapTotalKB = val
		case "SwapFree":
			swapFreeKB = val
		}
	}
	s.MemTotalBytes = memTotalKB * 1024
	s.MemAvailableBytes = memAvailKB * 1024
	if s.MemTotalBytes >= s.MemAvailableBytes {
		s.MemUsedBytes = s.MemTotalBytes - s.MemAvailableBytes
	}
	if s.MemTotalBytes > 0 {
		s.MemUsedPct = float64(s.MemUsedBytes) * 100 / float64(s.MemTotalBytes)
	}
	s.SwapTotalBytes = swapTotalKB * 1024
	if swapTotalKB >= swapFreeKB {
		s.SwapUsedBytes = (swapTotalKB - swapFreeKB) * 1024
	}
	if s.SwapTotalBytes > 0 {
		s.SwapUsedPct = float64(s.SwapUsedBytes) * 100 / float64(s.SwapTotalBytes)
	}
	return nil
}

func readLoadAvg(path string, s *Snapshot) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	// Format: "0.11 0.14 0.21 1/4547 12345"
	fields := strings.Fields(strings.TrimSpace(string(b)))
	if len(fields) < 3 {
		return nil
	}
	s.Load1, _ = strconv.ParseFloat(fields[0], 64)
	s.Load5, _ = strconv.ParseFloat(fields[1], 64)
	s.Load15, _ = strconv.ParseFloat(fields[2], 64)
	return nil
}

func readUptime(path string, s *Snapshot) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	// Format: "12345.67 56789.01"   (uptime  idle)
	fields := strings.Fields(strings.TrimSpace(string(b)))
	if len(fields) < 1 {
		return nil
	}
	s.UptimeSec, _ = strconv.ParseFloat(fields[0], 64)
	return nil
}

func statfsOrZero(path string) DiskStat {
	d := DiskStat{Path: path}
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return d
	}
	d.Available = true
	d.TotalBytes = st.Blocks * uint64(st.Bsize)
	d.AvailBytes = st.Bavail * uint64(st.Bsize)
	if d.TotalBytes >= d.AvailBytes {
		d.UsedBytes = d.TotalBytes - d.AvailBytes
	}
	if d.TotalBytes > 0 {
		d.UsedPct = float64(d.UsedBytes) * 100 / float64(d.TotalBytes)
	}
	return d
}
