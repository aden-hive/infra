package storage

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"time"
)

// runOK executes argv with a hard 60s default timeout (overridable via
// the per-request ctx deadline) and returns stdout. Stderr is
// captured + included in the error message on non-zero exit so the
// agent's systemd journal carries a useful trail.
func runOK(ctx context.Context, name string, args ...string) (string, error) {
	if _, deadlineSet := ctx.Deadline(); !deadlineSet {
		c, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		ctx = c
	}

	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	start := time.Now()

	err := cmd.Run()
	dur := time.Since(start)
	// One log line per command — useful when the UI shows "freed 300 GB"
	// and we want to audit what was actually run.
	log.Printf("exec name=%s args=%q exit=%v dur_ms=%d stderr_head=%q",
		name, redactArgs(args), err, dur.Milliseconds(), head(stderr.String(), 200))

	if err != nil {
		// Wrap with stderr's first line so the UI sees the actual reason
		// (e.g. mc auth failure, psql permission denied).
		stderrFirstLine := strings.SplitN(strings.TrimSpace(stderr.String()), "\n", 2)[0]
		return stdout.String(), fmt.Errorf("%s failed (%v): %s", name, err, stderrFirstLine)
	}
	return stdout.String(), nil
}

// runVoid is runOK when the caller doesn't need stdout (sweeps).
func runVoid(ctx context.Context, name string, args ...string) error {
	_, err := runOK(ctx, name, args...)
	return err
}

// redactArgs is the log-formatter for command lines. Any token that
// LOOKS like a secret (long alphanum, contains "password=") gets
// replaced with <redacted>. Cheap pattern-match — not a security
// boundary, just keeps logs scannable.
func redactArgs(args []string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		switch {
		case len(a) > 40 && !strings.ContainsAny(a, "/= "):
			// long opaque blob — probably a token
			out[i] = "<redacted>"
		case strings.Contains(strings.ToLower(a), "password="):
			out[i] = "password=<redacted>"
		default:
			out[i] = a
		}
	}
	return out
}

func head(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
