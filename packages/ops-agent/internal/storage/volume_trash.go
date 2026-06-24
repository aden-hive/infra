package storage

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// VolumeTrash sweeps soft-deleted per-team volumes from
// /srv/hivedata/.trash that are older than RetentionDays.
//
// This mirrors what /etc/cron.daily/hive-volume-trash-sweep already
// does on the host (the cron handles the unattended case). The cleaner
// surface is provided so the UI button can force-run it on demand,
// useful when an operator just soft-deleted a large volume and wants
// the bytes back immediately.
type VolumeTrash struct {
	TrashRoot      string
	RetentionDays  int
}

func NewVolumeTrash() *VolumeTrash {
	return &VolumeTrash{
		TrashRoot:     "/srv/hivedata/.trash",
		RetentionDays: 30,
	}
}

func (v *VolumeTrash) ID() string    { return "volume-trash" }
func (v *VolumeTrash) Label() string { return "Volume .trash (>30d soft-deletes)" }
func (v *VolumeTrash) Description() string {
	return fmt.Sprintf("Removes %s/<unix-ts>-vol-<uuid> entries older than %d days. Mirrors the daily cron (/etc/cron.daily/hive-volume-trash-sweep) — run from the UI when you've just soft-deleted a large volume and want the bytes back.", v.TrashRoot, v.RetentionDays)
}

func (v *VolumeTrash) Scan(ctx context.Context) (ScanResult, error) {
	res := ScanResult{ScannedAt: time.Now().UTC()}
	cands, err := v.collect(ctx)
	if err != nil {
		// trash root doesn't exist yet — that's fine, just an empty scan.
		if os.IsNotExist(err) {
			return res, nil
		}
		return res, err
	}
	for _, c := range cands {
		res.ReclaimableBytes += c.bytes
	}
	res.CandidateCount = len(cands)
	for i, c := range cands {
		if i >= 5 {
			break
		}
		res.Sample = append(res.Sample, filepath.Base(c.path))
	}
	return res, nil
}

func (v *VolumeTrash) Sweep(ctx context.Context, dryRun bool) (SweepResult, error) {
	res := SweepResult{DryRun: dryRun, SweptAt: time.Now().UTC()}
	start := time.Now()
	cands, err := v.collect(ctx)
	if err != nil && !os.IsNotExist(err) {
		res.Errors = append(res.Errors, err.Error())
		res.DurationMs = time.Since(start).Milliseconds()
		return res, err
	}
	for _, c := range cands {
		item := SweptItem{Name: filepath.Base(c.path), Bytes: c.bytes}
		if !dryRun {
			if err := os.RemoveAll(c.path); err != nil {
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

type trashCand struct {
	path  string
	bytes uint64
}

func (v *VolumeTrash) collect(ctx context.Context) ([]trashCand, error) {
	entries, err := os.ReadDir(v.TrashRoot)
	if err != nil {
		return nil, err
	}
	cutoff := time.Now().Add(-time.Duration(v.RetentionDays) * 24 * time.Hour)
	out := make([]trashCand, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		full := filepath.Join(v.TrashRoot, e.Name())
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(cutoff) {
			continue
		}
		bytes, _ := dirBytes(full)
		out = append(out, trashCand{path: full, bytes: bytes})
		if err := ctx.Err(); err != nil {
			break
		}
	}
	return out, nil
}

// dirBytes is a recursive sum of file sizes under root. Used by both
// VolumeTrash and (in future) any other filesystem cleaner.
func dirBytes(root string) (uint64, error) {
	var total uint64
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable, keep walking
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		total += uint64(info.Size())
		return nil
	})
	return total, err
}

// guard against unused import if filepath.WalkDir's strings sibling is
// removed in a future refactor.
var _ = strings.ToLower
