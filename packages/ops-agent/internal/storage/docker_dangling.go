package storage

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

// DockerDangling reclaims docker daemon's unused image layers via
// `docker image prune -af --filter "until=24h"`. The 24h cliff means
// in-flight builds don't lose their intermediate stages.
type DockerDangling struct {
	Until string // e.g. "24h"
}

func NewDockerDangling() *DockerDangling {
	return &DockerDangling{Until: "24h"}
}

func (d *DockerDangling) ID() string    { return "docker-dangling-layers" }
func (d *DockerDangling) Label() string { return "Docker daemon dangling layers" }
func (d *DockerDangling) Description() string {
	return "docker image prune -af --filter until=" + d.Until +
		" — daemon-side image cache reclaim, leaves anything used in the last " + d.Until + "."
}

func (d *DockerDangling) Scan(ctx context.Context) (ScanResult, error) {
	res := ScanResult{ScannedAt: time.Now().UTC()}
	// `docker system df --format json` returns the high-level "what's
	// reclaimable" view per type. Aggregating that is a good-enough
	// preview. The actual prune may free more (it includes intermediate
	// layers tracked by image cache that df doesn't surface).
	out, err := runOK(ctx, "docker", "system", "df", "--format", "{{json .}}")
	if err != nil {
		return res, err
	}
	// Each line is one type. Sum images + buildcache reclaimable.
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var row struct {
			Type        string `json:"Type"`
			Reclaimable string `json:"Reclaimable"`
		}
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			continue
		}
		if row.Type != "Images" && row.Type != "Build Cache" {
			continue
		}
		// "Reclaimable" comes as "3.51GB (25%)" or similar; pull the
		// leading number.
		b := parseHumanBytes(row.Reclaimable)
		res.ReclaimableBytes += b
		res.Sample = append(res.Sample, row.Type+": "+row.Reclaimable)
		res.CandidateCount++
	}
	return res, nil
}

func (d *DockerDangling) Sweep(ctx context.Context, dryRun bool) (SweepResult, error) {
	res := SweepResult{DryRun: dryRun, SweptAt: time.Now().UTC()}
	start := time.Now()
	// Re-scan to get the pre-prune reclaimable number for the report.
	scan, err := d.Scan(ctx)
	res.FreedBytes = scan.ReclaimableBytes
	res.DeletedCount = scan.CandidateCount
	if err != nil {
		res.Errors = append(res.Errors, err.Error())
	}
	if dryRun {
		res.DurationMs = time.Since(start).Milliseconds()
		return res, nil
	}
	if err := runVoid(ctx, "docker", "image", "prune", "-af", "--filter", "until="+d.Until); err != nil {
		res.Errors = append(res.Errors, "image prune: "+err.Error())
	}
	if err := runVoid(ctx, "docker", "builder", "prune", "-af", "--filter", "until="+d.Until); err != nil {
		res.Errors = append(res.Errors, "builder prune: "+err.Error())
	}
	res.DurationMs = time.Since(start).Milliseconds()
	return res, nil
}

// parseHumanBytes converts strings like "3.51GB" or "120MB" or
// "3.51GB (25%)" to bytes. Forgiving — anything unparseable returns 0
// so a single malformed row doesn't poison the total.
func parseHumanBytes(s string) uint64 {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, " "); i > 0 {
		s = s[:i] // drop the "(25%)" tail
	}
	if s == "" || s == "0" {
		return 0
	}
	// Split numeric prefix from unit suffix.
	split := -1
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || c == '.') {
			split = i
			break
		}
	}
	var numStr, unit string
	if split < 0 {
		numStr = s
	} else {
		numStr = s[:split]
		unit = strings.ToUpper(s[split:])
	}
	if numStr == "" {
		return 0
	}
	v, err := strconv.ParseFloat(numStr, 64)
	if err != nil {
		return 0
	}
	mult := uint64(1)
	switch unit {
	case "B", "":
		mult = 1
	case "KB", "KIB":
		mult = 1 << 10
	case "MB", "MIB":
		mult = 1 << 20
	case "GB", "GIB":
		mult = 1 << 30
	case "TB", "TIB":
		mult = 1 << 40
	}
	return uint64(v * float64(mult))
}
