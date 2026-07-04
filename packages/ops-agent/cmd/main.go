// hive-ops-agent — read-only system + sandbox observability daemon.
//
// Runs on the orchestrator host, exposes JSON on 127.0.0.1:5099 (or the
// port specified by HIVE_OPS_BIND). Caddy fronts it on
// https://api.vm.open-hive.com/ops/* with a Bearer-token gate, so the
// agent itself is unauthenticated and trusts its loopback bind.
//
// All endpoints return JSON, never mutate state, and tolerate partial
// failures (a busted nomad query still lets the rest of the page render).
//
// Endpoints:
//   GET /healthz       — { ok: true }
//   GET /system        — current snapshot + 1h history of meminfo/loadavg
//   GET /firecracker   — every firecracker process w/ sandboxId, %cpu, age, rss
//   GET /sandboxes     — e2b catalog joined with firecracker list
//   GET /nomad         — orchestrator/api/client-proxy alloc status
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aden/hive-ops-agent/internal/e2bclient"
	"github.com/aden/hive-ops-agent/internal/firecracker"
	"github.com/aden/hive-ops-agent/internal/nomadclient"
	"github.com/aden/hive-ops-agent/internal/storage"
	"github.com/aden/hive-ops-agent/internal/system"
)

const (
	defaultBindAddr      = "127.0.0.1:5099"
	defaultE2BAPIBase    = "https://api.vm.open-hive.com"
	defaultNomadAddr     = "http://127.0.0.1:4646"
	defaultProcRoot      = "/proc"
	defaultRequestBudget = 8 * time.Second

	// 1 hour history at one sample every 30s → 120 points. Enough for a
	// sparkline that shows "load was bad an hour ago, it's better now"
	// without holding more than ~12 KiB per metric series in RAM.
	systemSampleInterval = 30 * time.Second
	systemHistorySize    = 120
	firecrackerInterval  = 5 * time.Second
)

type server struct {
	procRoot      string
	nomad         *nomadclient.Client
	e2b           *e2bclient.Client
	requestBudget time.Duration
	procSampler   *firecracker.Sampler
	sysHistory    *system.History
	cleaners      *storage.Registry
}

func main() {
	bindAddr := envOr("HIVE_OPS_BIND", defaultBindAddr)
	procRoot := envOr("HIVE_OPS_PROC_ROOT", defaultProcRoot)
	e2bBase := envOr("HIVE_OPS_E2B_BASE", defaultE2BAPIBase)
	nomadAddr := envOr("HIVE_OPS_NOMAD_ADDR", defaultNomadAddr)

	// Credentials. Optional — endpoints that need them return their
	// degraded payload with an error field rather than 500'ing.
	e2bKey := os.Getenv("HIVE_OPS_E2B_API_KEY")
	nomadToken := strings.TrimSpace(os.Getenv("HIVE_OPS_NOMAD_TOKEN"))
	if path := os.Getenv("HIVE_OPS_NOMAD_TOKEN_FILE"); path != "" && nomadToken == "" {
		if b, err := os.ReadFile(path); err == nil {
			nomadToken = strings.TrimSpace(string(b))
		} else {
			log.Printf("warn: HIVE_OPS_NOMAD_TOKEN_FILE=%s read failed: %v", path, err)
		}
	}

	ctx, stop := context.WithCancel(context.Background())
	defer stop()

	s := &server{
		procRoot:      procRoot,
		nomad:         nomadclient.New(nomadAddr, nomadToken),
		e2b:           e2bclient.New(e2bBase, e2bKey),
		requestBudget: defaultRequestBudget,
		procSampler:   firecracker.NewSampler(procRoot, firecrackerInterval),
		sysHistory:    system.NewHistory(procRoot, systemSampleInterval, systemHistorySize),
		cleaners: storage.NewRegistry(
			storage.NewMinIOTemplates(),
			storage.NewDockerRegistryTags(),
			storage.NewDockerDangling(),
			storage.NewVolumeTrash(),
		),
	}

	// Fold the firecracker fleet totals into every system sample so the
	// portal's fleet stat card + sparkline track /firecracker's view.
	s.sysHistory.SetFCTotals(func() (int, float64, uint64) {
		procs := s.procSampler.Snapshot()
		var cpu float64
		var rss uint64
		for _, p := range procs {
			cpu += p.CPUPct
			rss += p.RSSMiB
		}
		return len(procs), cpu, rss
	})

	// Two long-lived samplers. Each writes into its own ring buffer so
	// every /endpoint can return instantly without doing any /proc work
	// on the request path (kept under 5ms when the buffers are warm).
	go s.procSampler.Run(ctx)
	go s.sysHistory.Run(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", handleHealth)
	mux.HandleFunc("/system", s.handleSystem)
	mux.HandleFunc("/firecracker", s.handleFirecracker)
	mux.HandleFunc("/sandboxes", s.handleSandboxes)
	mux.HandleFunc("/nomad", s.handleNomad)
	mux.HandleFunc("/storage/scan", s.handleStorageScan)
	mux.HandleFunc("/storage/sweep", s.handleStorageSweep)

	srv := &http.Server{
		Addr:              bindAddr,
		Handler:           withRequestLogging(mux),
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      defaultRequestBudget + 2*time.Second,
	}

	log.Printf("hive-ops-agent listening on %s (proc=%s, e2b=%s, nomad=%s, e2bKey=%s, nomadToken=%s)",
		bindAddr, procRoot, e2bBase, nomadAddr,
		redactPresence(e2bKey), redactPresence(nomadToken))
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("listen: %v", err)
	}
}

// ─── handlers ───────────────────────────────────────────────────────

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]any{
		"ok": true,
		"ts": time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *server) handleSystem(w http.ResponseWriter, _ *http.Request) {
	current, hist := s.sysHistory.Snapshot()
	writeJSON(w, map[string]any{
		"current": current,
		"history": hist,
		"sample_interval_sec": int(systemSampleInterval.Seconds()),
	})
}

func (s *server) handleFirecracker(w http.ResponseWriter, _ *http.Request) {
	procs := s.procSampler.Snapshot()
	writeJSON(w, map[string]any{
		"procs":      procs,
		"count":      len(procs),
		"sampled_at": time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *server) handleSandboxes(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.requestBudget)
	defer cancel()

	// e2b list + proc snapshot in parallel so the join sees both within
	// the same ~ms — important on a busy host where one read could be
	// 4s while the other is 4ms.
	type e2bResult struct {
		sbx []e2bclient.Sandbox
		err error
	}
	c := make(chan e2bResult, 1)
	go func() {
		v, err := s.e2b.ListSandboxes(ctx)
		c <- e2bResult{sbx: v, err: err}
	}()
	procs := s.procSampler.Snapshot()
	res := <-c

	procIdx := make(map[string]firecracker.Proc, len(procs))
	for _, p := range procs {
		if p.SandboxID == "" {
			continue
		}
		procIdx[p.SandboxID] = p
	}

	type joined struct {
		SandboxID    string  `json:"sandbox_id"`
		TemplateID   string  `json:"template_id,omitempty"`
		State        string  `json:"state"`
		StartedAt    string  `json:"started_at,omitempty"`
		EndAt        string  `json:"end_at,omitempty"`
		HasHostProc  bool    `json:"has_host_proc"`
		HostPID      int     `json:"host_pid,omitempty"`
		HostCPUPct   float64 `json:"host_cpu_pct,omitempty"`
		HostAgeSec   float64 `json:"host_age_sec,omitempty"`
		HostRSSMiB   uint64  `json:"host_rss_mib,omitempty"`
		Tags         []string `json:"tags"`
		Lifecycle    any     `json:"lifecycle,omitempty"`
		VolumeMounts any     `json:"volume_mounts,omitempty"`
		Metadata     any     `json:"metadata,omitempty"`
	}

	out := make([]joined, 0, len(res.sbx)+len(procs))
	seen := make(map[string]struct{}, len(res.sbx))
	for _, sb := range res.sbx {
		j := joined{
			SandboxID:    sb.SandboxID,
			TemplateID:   sb.TemplateID,
			State:        sb.State,
			StartedAt:    sb.StartedAt,
			EndAt:        sb.EndAt,
			Lifecycle:    sb.Lifecycle,
			VolumeMounts: sb.VolumeMounts,
			Metadata:     sb.Metadata,
			Tags:         []string{},
		}
		if p, ok := procIdx[sb.SandboxID]; ok {
			j.HasHostProc = true
			j.HostPID = p.PID
			j.HostCPUPct = p.CPUPct
			j.HostAgeSec = p.AgeSec
			j.HostRSSMiB = p.RSSMiB
		}
		// Cross-ref flags. "ghost" = e2b says running but no host proc;
		// usually means the row hasn't been reconciled after a kill, or
		// the firecracker died without notifying e2b. The reconciler in
		// hive-backend handles the second case on its own loop.
		if sb.State == "running" && !j.HasHostProc {
			j.Tags = append(j.Tags, "ghost")
		}
		out = append(out, j)
		seen[sb.SandboxID] = struct{}{}
	}

	for _, p := range procs {
		if p.SandboxID == "" {
			continue
		}
		if _, ok := seen[p.SandboxID]; ok {
			continue
		}
		// Host proc with no e2b record — orphan. The reaper kills these
		// on orchestrator boot, but this view shows them between boots.
		out = append(out, joined{
			SandboxID:   p.SandboxID,
			State:       "orphan",
			HasHostProc: true,
			HostPID:     p.PID,
			HostCPUPct:  p.CPUPct,
			HostAgeSec:  p.AgeSec,
			HostRSSMiB:  p.RSSMiB,
			Tags:        []string{"orphan"},
		})
	}

	body := map[string]any{
		"sandboxes": out,
		"count":     len(out),
		"sampled_at": time.Now().UTC().Format(time.RFC3339),
	}
	if res.err != nil {
		body["e2b_error"] = res.err.Error()
	}
	writeJSON(w, body)
}

func (s *server) handleNomad(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.requestBudget)
	defer cancel()

	report, err := s.nomad.JobsSummary(ctx)
	body := map[string]any{
		"jobs":       report,
		"sampled_at": time.Now().UTC().Format(time.RFC3339),
	}
	if err != nil {
		body["error"] = err.Error()
	}
	writeJSON(w, body)
}

// handleStorageScan: read-only, returns reclaimable bytes per category.
// Budget is generous (60s) because `mc du` over 100+ build dirs takes
// ~10-20s in practice.
func (s *server) handleStorageScan(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	report := s.cleaners.ScanAll(ctx)
	writeJSON(w, report)
}

// handleStorageSweep: the destructive call. Body shape:
//
//	{ "categories": ["minio-templates", "docker-registry-tags"], "dry_run": true }
//
// Unknown ids are reported per-item rather than 400'ing the whole
// request — so a future agent that has dropped a category doesn't break
// a portal that's still asking for it.
func (s *server) handleStorageSweep(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Categories []string `json:"categories"`
		DryRun     *bool    `json:"dry_run"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad json body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if len(body.Categories) == 0 {
		http.Error(w, "categories[] required", http.StatusBadRequest)
		return
	}
	// Default to dry-run when the field is omitted — caller has to
	// explicitly say `false` to actually delete. Belt-and-braces: an
	// accidentally-curl'd POST without a body is safe.
	dry := true
	if body.DryRun != nil {
		dry = *body.DryRun
	}
	// Long budget — a real sweep of MinIO can take a minute or two.
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	report := s.cleaners.SweepSelected(ctx, body.Categories, dry)
	writeJSON(w, report)
}

// ─── plumbing ───────────────────────────────────────────────────────

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func redactPresence(v string) string {
	if v == "" {
		return "<unset>"
	}
	return "<set>"
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		log.Printf("json encode failed: %v", err)
	}
}

func withRequestLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, code: 200}
		next.ServeHTTP(rec, r)
		log.Printf("method=%s path=%s status=%d dur_ms=%d remote=%s",
			r.Method, r.URL.Path, rec.code, time.Since(start).Milliseconds(), r.RemoteAddr)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (r *statusRecorder) WriteHeader(c int) {
	r.code = c
	r.ResponseWriter.WriteHeader(c)
}
