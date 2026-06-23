package reaper

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// findFirecrackerPIDs is the load-bearing pure logic — it walks a /proc-shaped
// directory tree, checks each PID's `comm`, and reports the firecracker PIDs.
// The actual SIGKILL is a thin syscall wrapper that's not worth mocking; the
// integration path (running orchestrator boot) covers it.

func TestFindFirecrackerPIDs_DetectsByCommName(t *testing.T) {
	fakeProc := t.TempDir()
	// Two firecracker processes, one nginx, one bash. Mimics what /proc looks like.
	writeFakeProcess(t, fakeProc, 100, "firecracker")
	writeFakeProcess(t, fakeProc, 101, "firecracker")
	writeFakeProcess(t, fakeProc, 200, "nginx")
	writeFakeProcess(t, fakeProc, 201, "bash")

	pids, err := findFirecrackerPIDs(fakeProc)
	require.NoError(t, err)
	assert.ElementsMatch(t, []int{100, 101}, pids)
}

func TestFindFirecrackerPIDs_SkipsNonNumericEntries(t *testing.T) {
	// /proc has plenty of non-PID entries (cpuinfo, meminfo, sys, irq, …).
	// Skipping them silently is the right behavior; an error would mask
	// real PID scanning issues.
	fakeProc := t.TempDir()
	writeFakeProcess(t, fakeProc, 100, "firecracker")
	require.NoError(t, os.WriteFile(filepath.Join(fakeProc, "cpuinfo"), []byte("processor: 0"), 0o644))
	require.NoError(t, os.MkdirAll(filepath.Join(fakeProc, "sys", "kernel"), 0o755))

	pids, err := findFirecrackerPIDs(fakeProc)
	require.NoError(t, err)
	assert.Equal(t, []int{100}, pids)
}

func TestFindFirecrackerPIDs_HandlesDisappearingProcess(t *testing.T) {
	// /proc/<pid>/comm can disappear between ReadDir and ReadFile if the
	// process exits mid-scan. The scanner must skip silently — losing a
	// stale entry is fine; treating it as an error would block the reaper
	// every boot.
	fakeProc := t.TempDir()
	writeFakeProcess(t, fakeProc, 100, "firecracker")
	// Process 999 has the dir but no `comm` file (simulates concurrent exit).
	require.NoError(t, os.MkdirAll(filepath.Join(fakeProc, "999"), 0o755))

	pids, err := findFirecrackerPIDs(fakeProc)
	require.NoError(t, err)
	assert.Equal(t, []int{100}, pids)
}

func TestFindFirecrackerPIDs_IgnoresCommTrailingNewline(t *testing.T) {
	// Real /proc/<pid>/comm always has a trailing newline. The matcher
	// must trim it; without that the equality check would always fail.
	fakeProc := t.TempDir()
	pidDir := filepath.Join(fakeProc, "100")
	require.NoError(t, os.MkdirAll(pidDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(pidDir, "comm"), []byte("firecracker\n"), 0o644))

	pids, err := findFirecrackerPIDs(fakeProc)
	require.NoError(t, err)
	assert.Equal(t, []int{100}, pids)
}

func TestReapOrphanFirecrackers_NoOpWhenFlagUnset(t *testing.T) {
	// Default-off behavior: upstream multi-orch-per-node deployments
	// would mangle each other's sandboxes if we reaped unconditionally.
	// The flag is the explicit opt-in.
	t.Setenv(envFlag, "")
	tmpDir := t.TempDir()
	// Put a fake sock to confirm it survives a no-op reaper call.
	sockPath := filepath.Join(tmpDir, "fc-bystander-abc.sock")
	require.NoError(t, os.WriteFile(sockPath, []byte{}, 0o644))

	n, err := ReapOrphanFirecrackers(t.Context(), tmpDir)
	require.NoError(t, err)
	assert.Equal(t, 0, n)
	_, statErr := os.Stat(sockPath)
	assert.NoError(t, statErr, "sock should be untouched when reaper is disabled")
}

func TestReapOrphanFirecrackers_CleansSocketsWhenEnabled(t *testing.T) {
	// When enabled with no live firecrackers (the steady state after a
	// clean shutdown), the reaper should still scrub leftover sock files
	// so the next sandbox spawn doesn't collide on bind(2).
	t.Setenv(envFlag, "true")
	tmpDir := t.TempDir()
	for _, name := range []string{"fc-alpha-001.sock", "fc-beta-002.sock"} {
		require.NoError(t, os.WriteFile(filepath.Join(tmpDir, name), nil, 0o644))
	}
	// A non-fc file in the same dir should survive — only `fc-*.sock`
	// belongs to our domain.
	require.NoError(t, os.WriteFile(filepath.Join(tmpDir, "supervisord.pid"), nil, 0o644))

	_, err := ReapOrphanFirecrackers(t.Context(), tmpDir)
	require.NoError(t, err)

	for _, name := range []string{"fc-alpha-001.sock", "fc-beta-002.sock"} {
		_, statErr := os.Stat(filepath.Join(tmpDir, name))
		assert.True(t, os.IsNotExist(statErr), "expected %s removed", name)
	}
	_, statErr := os.Stat(filepath.Join(tmpDir, "supervisord.pid"))
	assert.NoError(t, statErr, "non-fc file must not be touched")
}

// writeFakeProcess sets up a /proc/<pid>/comm entry that findFirecrackerPIDs
// can read. The format mirrors the real kernel: one line, trailing newline.
func writeFakeProcess(t *testing.T, procRoot string, pid int, comm string) {
	t.Helper()
	pidDir := filepath.Join(procRoot, strconv.Itoa(pid))
	require.NoError(t, os.MkdirAll(pidDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(pidDir, "comm"), []byte(comm+"\n"), 0o644))
}
