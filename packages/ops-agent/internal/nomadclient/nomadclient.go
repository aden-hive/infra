// Package nomadclient queries the nomad HTTP api (default :4646) for
// orchestrator/api/client-proxy job status.
//
// Returns just enough to render "are my services healthy" — alloc state,
// task health, recent restart count, last restart reason. Never the full
// alloc payload (PII, secrets in env).
package nomadclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

type Client struct {
	base  string
	token string
	http  *http.Client
}

// Tracked is the set of nomad jobs we'd surface on the portal. Everything
// else (logs-collector, redis, otel-collector, …) is omitted to keep the
// page focused on the workspace-VM critical path.
// trackedJobs is the set we render in the portal. template-manager runs as
// a co-located service inside the orchestrator job (see
// ORCHESTRATOR_SERVICES env in iac/provider-ovh/nomad/orchestrator.hcl)
// rather than its own nomad job, so it's not in this list.
var trackedJobs = []string{
	"orchestrator",
	"api",
	"client-proxy",
}

// JobRow is one row in the response.
type JobRow struct {
	Name           string      `json:"name"`
	Status         string      `json:"status"`           // running / dead / pending
	Healthy        bool        `json:"healthy"`          // any failing alloc → false
	AllocCount     int         `json:"alloc_count"`
	HealthyAllocs  int         `json:"healthy_allocs"`
	Allocs         []AllocRow  `json:"allocs"`
	Error          string      `json:"error,omitempty"`
}

type AllocRow struct {
	ID            string             `json:"id"`
	NodeID        string             `json:"node_id,omitempty"`
	ClientStatus  string             `json:"client_status"`
	DesiredStatus string             `json:"desired_status"`
	TaskStates    map[string]TaskRow `json:"task_states"`
	CreateTime    string             `json:"create_time,omitempty"`
}

type TaskRow struct {
	State        string `json:"state"`
	Failed       bool   `json:"failed"`
	RestartCount int    `json:"restart_count"`
	LastEvent    string `json:"last_event,omitempty"`
	LastEventAt  string `json:"last_event_at,omitempty"`
}

func New(base, token string) *Client {
	return &Client{
		base:  base,
		token: token,
		http:  &http.Client{Timeout: 5 * time.Second},
	}
}

// JobsSummary fetches all tracked jobs in parallel, returning per-job
// rows even when some queries fail. Returns a top-level error only when
// the nomad api itself is unreachable (and even then, the partial slice
// it returns may still be useful for debugging).
func (c *Client) JobsSummary(ctx context.Context) ([]JobRow, error) {
	if c.base == "" {
		return nil, errors.New("nomad addr not configured")
	}

	type res struct {
		row JobRow
	}
	resCh := make(chan res, len(trackedJobs))
	for _, name := range trackedJobs {
		go func(n string) {
			row := c.fetchOne(ctx, n)
			resCh <- res{row: row}
		}(name)
	}
	rows := make([]JobRow, 0, len(trackedJobs))
	for range trackedJobs {
		rows = append(rows, (<-resCh).row)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Name < rows[j].Name })
	return rows, nil
}

func (c *Client) fetchOne(ctx context.Context, name string) JobRow {
	row := JobRow{Name: name}

	// Job-level state
	job, err := c.getJSON(ctx, "/v1/job/"+name)
	if err != nil {
		row.Error = "job: " + err.Error()
		return row
	}
	if m, ok := job.(map[string]any); ok {
		if v, ok := m["Status"].(string); ok {
			row.Status = v
		}
	}

	// Allocs
	allocs, err := c.getJSON(ctx, "/v1/job/"+name+"/allocations")
	if err != nil {
		row.Error = "allocs: " + err.Error()
		return row
	}
	arr, ok := allocs.([]any)
	if !ok {
		row.Error = "allocs: unexpected shape"
		return row
	}

	for _, raw := range arr {
		am, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		// Skip allocations that have been replaced — terminal allocs
		// pollute the view otherwise.
		desired := asString(am["DesiredStatus"])
		if desired == "stop" {
			continue
		}
		ar := AllocRow{
			ID:            asString(am["ID"]),
			NodeID:        asString(am["NodeID"]),
			ClientStatus:  asString(am["ClientStatus"]),
			DesiredStatus: desired,
			TaskStates:    map[string]TaskRow{},
			CreateTime:    asNanoTime(am["CreateTime"]),
		}
		if ts, ok := am["TaskStates"].(map[string]any); ok {
			for tname, tval := range ts {
				tm, ok := tval.(map[string]any)
				if !ok {
					continue
				}
				tr := TaskRow{
					State:        asString(tm["State"]),
					Failed:       asBool(tm["Failed"]),
					RestartCount: asInt(tm["Restarts"]),
				}
				if ev, ok := tm["Events"].([]any); ok && len(ev) > 0 {
					if last, ok := ev[len(ev)-1].(map[string]any); ok {
						tr.LastEvent = asString(last["DisplayMessage"])
						tr.LastEventAt = asNanoTime(last["Time"])
					}
				}
				ar.TaskStates[tname] = tr
			}
		}
		row.Allocs = append(row.Allocs, ar)
		row.AllocCount++
		if ar.ClientStatus == "running" {
			row.HealthyAllocs++
		}
	}
	row.Healthy = row.AllocCount > 0 && row.HealthyAllocs == row.AllocCount
	return row
}

func (c *Client) getJSON(ctx context.Context, path string) (any, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.base+path, nil)
	if err != nil {
		return nil, err
	}
	if c.token != "" {
		req.Header.Set("X-Nomad-Token", c.token)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return nil, fmt.Errorf("HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(b)))
	}
	var v any
	if err := json.NewDecoder(res.Body).Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

// ─── shape helpers (nomad returns mixed types in json blobs) ────────

func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func asBool(v any) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	return false
}

func asInt(v any) int {
	if f, ok := v.(float64); ok {
		return int(f)
	}
	return 0
}

// asNanoTime converts nomad's numeric nanosecond timestamps to RFC3339.
// Some endpoints return seconds-since-epoch, some nanoseconds — guess
// by magnitude (anything > year 3000 in seconds is probably nanos).
func asNanoTime(v any) string {
	f, ok := v.(float64)
	if !ok || f == 0 {
		return ""
	}
	var t time.Time
	if f > 1e16 {
		t = time.Unix(0, int64(f)).UTC()
	} else {
		t = time.Unix(int64(f), 0).UTC()
	}
	return t.Format(time.RFC3339)
}
