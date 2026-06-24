// Package e2bclient is a tiny HTTP client for the e2b orchestration API.
// Only the read endpoints we need for the observability page.
package e2bclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Sandbox struct {
	SandboxID    string `json:"sandboxID"`
	TemplateID   string `json:"templateID"`
	State        string `json:"state"`
	StartedAt    string `json:"startedAt"`
	EndAt        string `json:"endAt"`
	Metadata     any    `json:"metadata"`
	Lifecycle    any    `json:"lifecycle"`
	VolumeMounts any    `json:"volumeMounts"`
}

type Client struct {
	base   string
	apiKey string
	http   *http.Client
}

func New(base, apiKey string) *Client {
	return &Client{
		base:   base,
		apiKey: apiKey,
		http: &http.Client{
			Timeout: 7 * time.Second,
		},
	}
}

// ListSandboxes hits GET /sandboxes. e2b returns an array directly.
// Returns (nil, err) on any failure; partial errors are caller-visible.
func (c *Client) ListSandboxes(ctx context.Context) ([]Sandbox, error) {
	if c.apiKey == "" {
		return nil, errors.New("e2b api key not configured (HIVE_OPS_E2B_API_KEY)")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", c.base+"/sandboxes", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-API-Key", c.apiKey)
	req.Header.Set("Accept", "application/json")

	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	if res.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
		return nil, fmt.Errorf("e2b /sandboxes returned %d: %s", res.StatusCode, string(b))
	}

	var out []Sandbox
	dec := json.NewDecoder(res.Body)
	if err := dec.Decode(&out); err != nil {
		return nil, fmt.Errorf("decode /sandboxes: %w", err)
	}
	return out, nil
}
