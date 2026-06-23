// Package reaper contains the boot-time orphan-firecracker cleanup.
//
// The orchestrator's in-memory sandbox state is non-persistent: every restart
// (template roll, panic, nomad restart, OOM) starts with an empty
// `sandbox.Map`. Firecracker processes spawned by the prior orchestrator,
// however, do NOT die with their parent — they're launched via
// `ip netns exec` and reparent to init when the orchestrator goes away. Each
// orphan keeps its guest VM's vCPU thread spinning, pinning ~100% of a host
// vCPU indefinitely.
//
// On a 16-vCPU host we observed 6 orphans pinning 6 vCPUs for up to 60 days,
// dragging the load average to 96 and starving the NFS proxy enough that
// sandboxes started blocking on NFS RPC reads (kernel `D` state on
// `rpc_wait_bit_killable`). End-user symptom: TCP listen-backlog overflow
// inside the VM, "fetch failed" on the desktop.
//
// `ReapOrphanFirecrackers` runs synchronously at orchestrator startup,
// before any sandbox-creation requests are accepted, and SIGKILLs every
// firecracker process visible in `/proc`. In-flight sandboxes are not
// "lost" by this — the restart itself orphans them (the new orchestrator
// has no record of them, so subsequent gRPC calls return NotFound), and
// the firecracker is the only stateful piece left on disk to clean up.
package reaper

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"go.uber.org/zap"

	"github.com/e2b-dev/infra/packages/shared/pkg/logger"
)

// envFlag — must be exactly "true" to enable. Defaults off so upstream's
// multi-orchestrator-per-node setups (where two orch instances might share
// a node's /tmp and accidentally kill each other's sandboxes) keep their
// previous behavior. Hive's nomad job sets this to "true" since hive runs
// at most one orchestrator per node.
const envFlag = "REAP_ORPHAN_FIRECRACKERS_ON_BOOT"

// commName is what /proc/<pid>/comm reports for the firecracker binary.
// Truncated to 15 chars per the kernel's TASK_COMM_LEN, but "firecracker"
// is 11 chars so it fits unchanged.
const commName = "firecracker"

// ReapOrphanFirecrackers terminates every firecracker process on the host
// and removes stale API sockets, but only when env REAP_ORPHAN_FIRECRACKERS_ON_BOOT="true".
// Returns the number of processes successfully killed. Errors from individual
// kills are logged but not returned — partial cleanup is still useful.
//
// `tmpDir` is where the orchestrator's SandboxFiles places API sockets
// (typically /tmp). Used for cleaning up stale `fc-*.sock` files so the
// next bind(2) doesn't collide.
func ReapOrphanFirecrackers(ctx context.Context, tmpDir string) (int, error) {
	if os.Getenv(envFlag) != "true" {
		return 0, nil
	}

	pids, err := findFirecrackerPIDs("/proc")
	if err != nil {
		return 0, fmt.Errorf("scan /proc: %w", err)
	}

	if len(pids) == 0 {
		logger.L().Info(ctx, "no orphan firecracker processes found at boot")
		return 0, nil
	}

	reaped := 0
	for _, pid := range pids {
		if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
			// Process may have already exited between our scan and the
			// kill — treat ESRCH as success.
			if err == syscall.ESRCH {
				continue
			}
			logger.L().Warn(ctx, "failed to SIGKILL orphan firecracker",
				zap.Int("pid", pid),
				zap.Error(err),
			)
			continue
		}
		reaped++
	}

	// Clean up stale API sockets so the next sandbox spawn doesn't fail
	// on bind() with EADDRINUSE. Best-effort — a leftover sock without a
	// process is fine to remove; a sock owned by a still-living process
	// (one we failed to kill) will rebind successfully because the kernel
	// is about to reclaim it as the parent process dies.
	socks, _ := filepath.Glob(filepath.Join(tmpDir, "fc-*.sock"))
	for _, s := range socks {
		_ = os.Remove(s)
	}

	logger.L().Info(ctx, "reaped orphan firecrackers at boot",
		zap.Int("reaped", reaped),
		zap.Int("found", len(pids)),
		zap.Int("sockets_removed", len(socks)),
	)
	return reaped, nil
}

// findFirecrackerPIDs walks procDir (typically "/proc") looking for processes
// whose `comm` is exactly "firecracker". Exported in this form so tests can
// supply a fake /proc.
func findFirecrackerPIDs(procDir string) ([]int, error) {
	entries, err := os.ReadDir(procDir)
	if err != nil {
		return nil, err
	}

	pids := make([]int, 0, 4)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			// /proc has non-numeric entries (cpuinfo, meminfo, etc.) —
			// skip them silently.
			continue
		}
		commBytes, err := os.ReadFile(filepath.Join(procDir, e.Name(), "comm"))
		if err != nil {
			// Process exited between ReadDir and ReadFile — fine, skip.
			continue
		}
		if strings.TrimSpace(string(commBytes)) != commName {
			continue
		}
		pids = append(pids, pid)
	}
	return pids, nil
}
