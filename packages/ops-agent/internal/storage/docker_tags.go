package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// DockerRegistryTags reaps old `colonies-vN` image tags from the local
// docker registry at 127.0.0.1:5000. Strategy: keep `KeepLatestN`
// numerically-newest plus `latest` and any non-`colonies-vN` tags
// (we treat anything that doesn't match the pattern as "human-named,
// don't touch").
//
// Per-tag delete is a TWO-step dance against the registry HTTP API
// (RFC: docker distribution v2):
//   1. HEAD /v2/<name>/manifests/<tag>  with Accept covering both docker-v2
//      and OCI media types (buildkit pushes OCI image indexes; the registry
//      404s if the Accept list doesn't include the stored type)
//      → returns `Docker-Content-Digest` header
//   2. DELETE /v2/<name>/manifests/<digest>
//
// AFTER all deletes we need `registry garbage-collect` inside the
// registry container to actually free disk — registry's HTTP DELETE
// just unlinks the manifest, the blobs hang around until GC.
type DockerRegistryTags struct {
	RegistryURL string // e.g. "http://127.0.0.1:5000"
	Repo        string // e.g. "hive-novnc"
	KeepLatestN int
	// Container name to exec the GC in. If empty, GC is skipped and the
	// blobs stay around until next manual GC.
	RegistryContainerName string
}

func NewDockerRegistryTags() *DockerRegistryTags {
	return &DockerRegistryTags{
		RegistryURL:           "http://127.0.0.1:5000",
		Repo:                  "hive-novnc",
		KeepLatestN:           3,
		RegistryContainerName: "registry",
	}
}

func (d *DockerRegistryTags) ID() string    { return "docker-registry-tags" }
func (d *DockerRegistryTags) Label() string { return "Docker registry tags (old colonies-vN)" }
func (d *DockerRegistryTags) Description() string {
	return fmt.Sprintf("Deletes %s/%s:colonies-vN tags older than the %d most-recent. `latest` and human-named tags are preserved.", d.RegistryURL, d.Repo, d.KeepLatestN)
}

func (d *DockerRegistryTags) Scan(ctx context.Context) (ScanResult, error) {
	cands, hints, err := d.collect(ctx)
	res := ScanResult{
		CandidateCount: len(cands),
		ScannedAt:      time.Now().UTC(),
		SafetyHints:    hints,
	}
	if err != nil {
		return res, err
	}
	for _, c := range cands {
		res.ReclaimableBytes += c.bytes
	}
	for i, c := range cands {
		if i >= 5 {
			break
		}
		res.Sample = append(res.Sample, c.tag)
	}
	return res, nil
}

func (d *DockerRegistryTags) Sweep(ctx context.Context, dryRun bool) (SweepResult, error) {
	res := SweepResult{DryRun: dryRun, SweptAt: time.Now().UTC()}
	start := time.Now()
	cands, hints, err := d.collect(ctx)
	if err != nil {
		res.Errors = append(res.Errors, err.Error())
		res.Errors = append(res.Errors, hints...)
		res.DurationMs = time.Since(start).Milliseconds()
		return res, err
	}
	for _, c := range cands {
		item := SweptItem{Name: c.tag, Bytes: c.bytes}
		if !dryRun && c.digest != "" {
			if err := d.deleteManifest(ctx, c.digest); err != nil {
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
	// Trigger the registry GC after live deletes so the blobs actually go.
	if !dryRun && res.DeletedCount > 0 && d.RegistryContainerName != "" {
		// `docker exec <container> bin/registry garbage-collect /etc/docker/registry/config.yml`
		if err := runVoid(ctx, "docker", "exec", d.RegistryContainerName,
			"bin/registry", "garbage-collect", "/etc/docker/registry/config.yml"); err != nil {
			res.Errors = append(res.Errors, "registry GC failed: "+err.Error())
		}
	}
	res.Items = capItemsForResponse(res.Items)
	res.DurationMs = time.Since(start).Milliseconds()
	return res, nil
}

// ─── internals ─────────────────────────────────────────────────────

var versionedTagRe = regexp.MustCompile(`^colonies-v(\d+)$`)

type tagCandidate struct {
	tag    string
	digest string
	bytes  uint64
	vNum   int
}

func (d *DockerRegistryTags) collect(ctx context.Context) ([]tagCandidate, []string, error) {
	var hints []string
	// 1. List tags
	tagsURL := fmt.Sprintf("%s/v2/%s/tags/list", d.RegistryURL, d.Repo)
	out, err := runOK(ctx, "curl", "-sS", "-m", "5", tagsURL)
	if err != nil {
		return nil, hints, err
	}
	var resp struct {
		Name string   `json:"name"`
		Tags []string `json:"tags"`
	}
	if err := json.Unmarshal([]byte(out), &resp); err != nil {
		return nil, hints, fmt.Errorf("parse tag list: %w", err)
	}

	// 2. Categorize. Only colonies-vN tags are sweep-eligible.
	versioned := []tagCandidate{}
	for _, tag := range resp.Tags {
		m := versionedTagRe.FindStringSubmatch(tag)
		if m == nil {
			continue
		}
		n, _ := strconv.Atoi(m[1])
		versioned = append(versioned, tagCandidate{tag: tag, vNum: n})
	}
	// Sort by version DESC. Keep first KeepLatestN.
	sort.Slice(versioned, func(i, j int) bool {
		return versioned[i].vNum > versioned[j].vNum
	})
	if len(versioned) <= d.KeepLatestN {
		return nil, hints, nil
	}
	candidates := versioned[d.KeepLatestN:]

	// 3. Resolve digest + content length per candidate. Both come from
	// HEAD /manifests with the manifest-v2 Accept header. Size is the
	// Content-Length of THAT manifest (not the image's full unpacked
	// size — but close enough as a "this is what frees on registry GC"
	// signal).
	for i := range candidates {
		digest, length, herr := d.headManifest(ctx, candidates[i].tag)
		if herr != nil {
			hints = append(hints, fmt.Sprintf("%s: head failed: %v", candidates[i].tag, herr))
			continue
		}
		candidates[i].digest = digest
		candidates[i].bytes = length
	}
	return candidates, hints, nil
}

// headManifest does the curl -I dance to grab Docker-Content-Digest.
// Returns ("", 0, err) on any HTTP non-2xx.
func (d *DockerRegistryTags) headManifest(ctx context.Context, tag string) (string, uint64, error) {
	url := fmt.Sprintf("%s/v2/%s/manifests/%s", d.RegistryURL, d.Repo, tag)
	out, err := runOK(ctx, "curl", "-sSI", "-m", "5",
		"-H", "Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
		url)
	if err != nil {
		return "", 0, err
	}
	// curl exits 0 on HTTP errors; surface the status instead of the
	// misleading "no digest in response".
	if first := strings.SplitN(out, "\n", 2)[0]; !strings.Contains(first, " 200") {
		return "", 0, fmt.Errorf("HEAD returned %s", strings.TrimSpace(first))
	}
	// Parse the response headers naively.
	var digest string
	var length uint64
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		// Case-insensitive header names. Docker-Content-Digest is the
		// canonical case, but some intermediaries lowercase.
		lower := strings.ToLower(line)
		switch {
		case strings.HasPrefix(lower, "docker-content-digest:"):
			digest = strings.TrimSpace(line[len("Docker-Content-Digest:"):])
		case strings.HasPrefix(lower, "content-length:"):
			n, perr := strconv.ParseUint(strings.TrimSpace(line[len("Content-Length:"):]), 10, 64)
			if perr == nil {
				length = n
			}
		}
	}
	if digest == "" {
		return "", 0, fmt.Errorf("no digest in response")
	}
	return digest, length, nil
}

func (d *DockerRegistryTags) deleteManifest(ctx context.Context, digest string) error {
	url := fmt.Sprintf("%s/v2/%s/manifests/%s", d.RegistryURL, d.Repo, digest)
	out, err := runOK(ctx, "curl", "-sS", "-m", "10",
		"-X", "DELETE",
		"-o", "/dev/null", "-w", "%{http_code}",
		url)
	if err != nil {
		return err
	}
	code := strings.TrimSpace(out)
	if code != "202" && code != "204" && code != "200" {
		return fmt.Errorf("DELETE returned %s", code)
	}
	// Drain status text we discarded via -o /dev/null; nothing else to do.
	_ = http.StatusAccepted
	return nil
}
