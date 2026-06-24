// Package storage exposes disk-reclaim categories as a uniform
// scan/sweep interface. Each category knows how to:
//   - enumerate its delete-candidates (Scan, never mutates)
//   - actually delete them (Sweep, with a dry-run guard)
//
// Adding a new category = one new file implementing Category + one
// registration line in registry.go. The agent's HTTP handlers and the
// portal UI iterate over the registry generically.
package storage

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Category is the contract every cleaner implements. Scan / Sweep
// receive a context with the agent's per-request budget already
// applied; long-running sweeps must respect cancellation.
type Category interface {
	// ID is a stable kebab-case identifier sent over the wire ("minio-templates").
	ID() string
	// Label is human-facing ("MinIO e2b-templates").
	Label() string
	// Description is a one-liner shown under the label in the portal.
	Description() string

	// Scan returns what WOULD be reclaimed, without touching anything.
	Scan(ctx context.Context) (ScanResult, error)

	// Sweep deletes the candidates. If dryRun is true it behaves like
	// Scan (returns the same numbers) but doesn't mutate. Each cleaner
	// is responsible for its own batching and rate-limiting.
	Sweep(ctx context.Context, dryRun bool) (SweepResult, error)
}

// ScanResult is what /storage/scan returns per category.
type ScanResult struct {
	ReclaimableBytes uint64    `json:"reclaimable_bytes"`
	CandidateCount   int       `json:"candidate_count"`
	Sample           []string  `json:"sample,omitempty"` // first ~5 candidate names for UI hint
	ScannedAt        time.Time `json:"scanned_at"`
	// SafetyHints surface non-fatal "you might want to know" warnings,
	// e.g. "active build under 24h not in keep-set — included anyway".
	SafetyHints []string `json:"safety_hints,omitempty"`
}

// SweepResult is the post-deletion summary.
type SweepResult struct {
	DryRun       bool          `json:"dry_run"`
	DeletedCount int           `json:"deleted_count"`
	FreedBytes   uint64        `json:"freed_bytes"`
	Errors       []string      `json:"errors,omitempty"`
	DurationMs   int64         `json:"duration_ms"`
	SweptAt      time.Time     `json:"swept_at"`
	// Items lists the things processed, capped at maxItemsInResponse to
	// keep the JSON tight. Useful for UI audit.
	Items []SweptItem `json:"items,omitempty"`
}

// SweptItem is a single processed object. `Deleted` is false in dry-run.
type SweptItem struct {
	Name    string `json:"name"`
	Bytes   uint64 `json:"bytes"`
	Deleted bool   `json:"deleted"`
	Error   string `json:"error,omitempty"`
}

const maxItemsInResponse = 200

// Registry is the agent's set of categories. Use NewRegistry to construct.
type Registry struct {
	mu         sync.RWMutex
	cats       []Category
	byID       map[string]Category
}

func NewRegistry(cats ...Category) *Registry {
	r := &Registry{byID: map[string]Category{}}
	for _, c := range cats {
		r.cats = append(r.cats, c)
		r.byID[c.ID()] = c
	}
	return r
}

// All returns the categories in registration order.
func (r *Registry) All() []Category {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Category, len(r.cats))
	copy(out, r.cats)
	return out
}

// Get returns one category by ID, or (nil, false).
func (r *Registry) Get(id string) (Category, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	c, ok := r.byID[id]
	return c, ok
}

// ScanAll runs Scan on every registered category in parallel and
// returns a stable-ordered map of results. Per-category errors are
// returned in the response; the function itself only fails if no
// category could even start.
type ScanAllReport struct {
	Categories []ScanAllItem `json:"categories"`
	ScannedAt  time.Time     `json:"scanned_at"`
}

type ScanAllItem struct {
	ID          string     `json:"id"`
	Label       string     `json:"label"`
	Description string     `json:"description"`
	Result      ScanResult `json:"result,omitempty"`
	Error       string     `json:"error,omitempty"`
}

func (r *Registry) ScanAll(ctx context.Context) ScanAllReport {
	cats := r.All()
	type indexed struct {
		i      int
		result ScanResult
		err    error
	}
	resCh := make(chan indexed, len(cats))
	for i, c := range cats {
		go func(i int, c Category) {
			res, err := c.Scan(ctx)
			resCh <- indexed{i: i, result: res, err: err}
		}(i, c)
	}
	out := make([]ScanAllItem, len(cats))
	for range cats {
		r := <-resCh
		c := cats[r.i]
		item := ScanAllItem{
			ID:          c.ID(),
			Label:       c.Label(),
			Description: c.Description(),
			Result:      r.result,
		}
		if r.err != nil {
			item.Error = r.err.Error()
		}
		out[r.i] = item
	}
	// Sort by reclaimable bytes desc so the UI surfaces the big wins first.
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Result.ReclaimableBytes > out[j].Result.ReclaimableBytes
	})
	return ScanAllReport{Categories: out, ScannedAt: time.Now().UTC()}
}

// SweepSelected runs Sweep on each requested category id, in series so
// concurrent disk pressure stays bounded. Unknown ids return an error
// entry rather than failing the batch.
type SweepBatchReport struct {
	DryRun     bool                `json:"dry_run"`
	Categories []SweepBatchItem    `json:"categories"`
	SweptAt    time.Time           `json:"swept_at"`
}

type SweepBatchItem struct {
	ID     string      `json:"id"`
	Label  string      `json:"label"`
	Result SweepResult `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
}

func (r *Registry) SweepSelected(ctx context.Context, ids []string, dryRun bool) SweepBatchReport {
	report := SweepBatchReport{
		DryRun:  dryRun,
		SweptAt: time.Now().UTC(),
	}
	if len(ids) == 0 {
		return report
	}
	for _, id := range ids {
		c, ok := r.Get(id)
		if !ok {
			report.Categories = append(report.Categories, SweepBatchItem{
				ID:    id,
				Error: "unknown category id",
			})
			continue
		}
		item := SweepBatchItem{ID: c.ID(), Label: c.Label()}
		res, err := c.Sweep(ctx, dryRun)
		if err != nil {
			item.Error = err.Error()
		}
		item.Result = res
		report.Categories = append(report.Categories, item)
	}
	return report
}

// ─── shared helpers (kept here so all cleaners use them) ───────────

// truncate keeps the first n items, returning the truncated slice
// without panicking when len < n.
func truncate[T any](s []T, n int) []T {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// capItemsForResponse trims a sweep's Items slice to the response cap,
// leaving the totals untouched. The full audit goes to systemd logs.
func capItemsForResponse(items []SweptItem) []SweptItem {
	if len(items) <= maxItemsInResponse {
		return items
	}
	return items[:maxItemsInResponse]
}

// errJoin concatenates multiple errors into one for the SweepResult
// error list. Pure cosmetic — keeps log lines short.
func errJoin(errs []error) []string {
	if len(errs) == 0 {
		return nil
	}
	out := make([]string, 0, len(errs))
	for _, e := range errs {
		if e == nil {
			continue
		}
		out = append(out, e.Error())
	}
	return out
}

// ErrNotConfigured is returned by categories that can't run because
// the agent is missing a credential/env they need. Surfaced to the UI
// so the user sees "MinIO templates: not configured" instead of a
// stack trace.
var ErrNotConfigured = errors.New("not configured")

// formatBytes is shared in tests; the UI does its own formatting.
func formatBytes(b uint64) string {
	units := []string{"B", "KiB", "MiB", "GiB", "TiB"}
	v := float64(b)
	i := 0
	for v >= 1024 && i < len(units)-1 {
		v /= 1024
		i++
	}
	return fmt.Sprintf("%.1f %s", v, units[i])
}
