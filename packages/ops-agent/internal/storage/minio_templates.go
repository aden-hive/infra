package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// MinIOTemplates reaps every build_id in the e2b-templates MinIO bucket
// that ISN'T in the keep set:
//
//   keep = (per env_id: 2 most-recent build_ids) ∪ (any build whose
//          env_build_assignments.created_at is < 24h old, regardless
//          of rank)
//
// The 24h grace covers in-flight rolls — the snapshot files land in
// MinIO seconds AFTER `env_build_assignments` gets its INSERT, so a
// scan running between the two would otherwise nuke the just-rolled
// build.
type MinIOTemplates struct {
	// PgRunner / McRunner are exec hooks so tests can mock. Default is
	// to shell out to `sudo -u postgres psql` and `mc`.
	BucketAlias string // e.g. "local/e2b-templates"
	// KeepLatestN per env_id. 2 = current + last-known-good fallback.
	KeepLatestN int
	// GraceHours — any assignment created within this window is kept
	// regardless of rank.
	GraceHours int
}

// NewMinIOTemplates with sane defaults.
func NewMinIOTemplates() *MinIOTemplates {
	return &MinIOTemplates{
		BucketAlias: "local/e2b-templates",
		KeepLatestN: 2,
		GraceHours:  24,
	}
}

func (m *MinIOTemplates) ID() string    { return "minio-templates" }
func (m *MinIOTemplates) Label() string { return "MinIO e2b-templates (orphan builds)" }
func (m *MinIOTemplates) Description() string {
	return fmt.Sprintf("Removes build_id directories under MinIO %s whose env_build_assignments row is older than the %d most-recent per env_id and outside the %dh grace window.",
		m.BucketAlias, m.KeepLatestN, m.GraceHours)
}

func (m *MinIOTemplates) Scan(ctx context.Context) (ScanResult, error) {
	return m.scanOrSweep(ctx, true /*dryRun*/)
}

func (m *MinIOTemplates) Sweep(ctx context.Context, dryRun bool) (SweepResult, error) {
	scan, err := m.scanOrSweep(ctx, true /*dryRun*/)
	res := SweepResult{
		DryRun:  dryRun,
		SweptAt: time.Now().UTC(),
	}
	if err != nil {
		res.Errors = []string{err.Error()}
		return res, err
	}
	res.Items = make([]SweptItem, 0, scan.CandidateCount)
	start := time.Now()
	// Re-fetch the candidates with their full S3 paths so we can `mc rm`.
	candidates, _, errs := m.collectCandidates(ctx)
	if len(errs) > 0 {
		res.Errors = append(res.Errors, errs...)
	}
	for _, c := range candidates {
		item := SweptItem{Name: c.BuildID, Bytes: c.Bytes}
		if !dryRun {
			// mc rm --recursive --force returns 0 even when the dir is
			// gone; that's fine, idempotent.
			if err := runVoid(ctx, "mc", "rm", "--recursive", "--force", c.MCPath); err != nil {
				item.Error = err.Error()
			} else {
				item.Deleted = true
			}
		}
		if item.Deleted || dryRun {
			res.DeletedCount++
			res.FreedBytes += item.Bytes
		}
		res.Items = append(res.Items, item)
	}
	res.Items = capItemsForResponse(res.Items)
	res.DurationMs = time.Since(start).Milliseconds()
	return res, nil
}

// ─── implementation ────────────────────────────────────────────────

type candidate struct {
	BuildID string // the UUID directory name
	MCPath  string // full mc path: "local/e2b-templates/<build-id>/"
	Bytes   uint64 // sum of objects under that prefix
}

// scanOrSweep is the shared discovery pass. The Sweep wrapper above
// just adds the actual mc rm calls.
func (m *MinIOTemplates) scanOrSweep(ctx context.Context, dryRun bool) (ScanResult, error) {
	candidates, _, errs := m.collectCandidates(ctx)
	res := ScanResult{
		CandidateCount: len(candidates),
		ScannedAt:      time.Now().UTC(),
		SafetyHints:    errs,
	}
	for _, c := range candidates {
		res.ReclaimableBytes += c.Bytes
	}
	for i, c := range candidates {
		if i >= 5 {
			break
		}
		res.Sample = append(res.Sample, c.BuildID)
	}
	_ = dryRun
	return res, nil
}

// collectCandidates returns the set of MinIO build_id dirs NOT in the
// keep set, along with their byte sizes. Errors are collected into
// `hints` so the cleaner can still partially run.
func (m *MinIOTemplates) collectCandidates(ctx context.Context) ([]candidate, map[string]struct{}, []string) {
	var hints []string

	// Step 1: keep-set from postgres
	keep, err := m.fetchKeepSet(ctx)
	if err != nil {
		hints = append(hints, "postgres keep-set fetch failed: "+err.Error())
		// If we can't read keep-set, NEVER offer deletes — bail.
		return nil, keep, hints
	}

	// Step 2: enumerate MinIO prefixes
	entries, err := m.listBuildDirs(ctx)
	if err != nil {
		hints = append(hints, "mc ls failed: "+err.Error())
		return nil, keep, hints
	}

	candidates := make([]candidate, 0, len(entries))
	for _, e := range entries {
		if _, ok := keep[e.BuildID]; ok {
			continue
		}
		candidates = append(candidates, e)
	}
	return candidates, keep, hints
}

// fetchKeepSet returns the build_ids we MUST NOT delete.
//
// SQL (single round-trip):
//
//	WITH ranked AS (
//	  SELECT build_id, env_id, created_at,
//	         ROW_NUMBER() OVER (PARTITION BY env_id ORDER BY created_at DESC) AS rn
//	    FROM env_build_assignments
//	)
//	SELECT DISTINCT build_id::text
//	  FROM ranked
//	 WHERE rn <= $1
//	    OR created_at > NOW() - ($2 || ' hours')::interval;
func (m *MinIOTemplates) fetchKeepSet(ctx context.Context) (map[string]struct{}, error) {
	sql := fmt.Sprintf(`WITH ranked AS (
  SELECT build_id, env_id, created_at,
         ROW_NUMBER() OVER (PARTITION BY env_id ORDER BY created_at DESC) AS rn
    FROM env_build_assignments)
SELECT DISTINCT build_id::text
  FROM ranked
 WHERE rn <= %d
    OR created_at > NOW() - INTERVAL '%d hours';`, m.KeepLatestN, m.GraceHours)

	stdout, err := runOK(ctx, "sudo", "-u", "postgres", "psql", "-d", "e2b", "-tA", "-c", sql)
	if err != nil {
		return nil, err
	}
	keep := make(map[string]struct{}, 16)
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		keep[line] = struct{}{}
	}
	return keep, nil
}

// listBuildDirs runs `mc ls --json <bucket>/` and returns each
// top-level directory's name + recursive byte size.
//
// We need TWO mc passes: one to list directories, one (per dir) to
// compute size via `mc du --json`. mc du is recursive by default and
// reports the total in a single JSON line per target.
func (m *MinIOTemplates) listBuildDirs(ctx context.Context) ([]candidate, error) {
	// `mc ls --json <bucket>/` returns one JSON object per line. Each
	// line has fields {status, type, key, size, etag, ...}. Dirs have
	// type="folder" and key="<name>/".
	lsOut, err := runOK(ctx, "mc", "ls", "--json", m.BucketAlias+"/")
	if err != nil {
		return nil, err
	}
	type lsEntry struct {
		Type string `json:"type"`
		Key  string `json:"key"`
		Size uint64 `json:"size"`
	}
	dirs := []string{}
	for _, line := range strings.Split(lsOut, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var e lsEntry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			continue
		}
		// mc's ls reports build dirs as type "folder" with trailing slash.
		// Just in case it ever reports type "" with a slash, accept both.
		key := strings.TrimSuffix(e.Key, "/")
		if key == "" {
			continue
		}
		dirs = append(dirs, key)
	}

	// Bytes via `mc du --json <bucket>/<dir>/` — one call per dir is
	// 30+ RPCs over LAN but the bucket has ~120 dirs, so still well
	// under a second total.
	out := make([]candidate, 0, len(dirs))
	for _, dir := range dirs {
		if err := ctx.Err(); err != nil {
			break
		}
		path := m.BucketAlias + "/" + dir + "/"
		duOut, err := runOK(ctx, "mc", "du", "--json", path)
		if err != nil {
			// Don't abort the whole scan on a single-dir read failure.
			out = append(out, candidate{BuildID: dir, MCPath: path, Bytes: 0})
			continue
		}
		// Last JSON line is the totals row.
		var size uint64
		for _, line := range strings.Split(duOut, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			var d struct {
				Size uint64 `json:"size"`
			}
			if err := json.Unmarshal([]byte(line), &d); err == nil && d.Size > 0 {
				size = d.Size
			}
		}
		out = append(out, candidate{BuildID: dir, MCPath: path, Bytes: size})
	}
	return out, nil
}

// _ keeps the import necessary at the file scope when strconv isn't
// used elsewhere (yet) — silence unused-import warnings during dev.
var _ = strconv.Itoa
