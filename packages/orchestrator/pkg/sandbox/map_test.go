//go:build linux

package sandbox

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/e2b-dev/infra/packages/orchestrator/pkg/sandbox/network"
)

func TestMapLifecycleItemsRemainAfterMarkStopping(t *testing.T) {
	t.Parallel()

	sandboxes := NewSandboxesMap()
	sbx := testMapSandbox(t, "sandbox-1", "lifecycle-1")

	sandboxes.TrackLifecycle(t.Context(), sbx, SandboxStateRunning)
	sandboxes.MarkRunning(t.Context(), sbx)
	require.Len(t, sandboxes.Items(), 1)
	require.Len(t, sandboxes.LifecycleItemsByState(SandboxStateRunning), 1)

	marked := sandboxes.MarkStopping(t.Context(), sbx.Runtime.SandboxID, sbx.LifecycleID)
	require.True(t, marked)
	require.Empty(t, sandboxes.Items())
	require.Len(t, sandboxes.LifecycleItems(), 1)
	require.Len(t, sandboxes.LifecycleItemsByState(SandboxStateStopping), 1)

	sandboxes.MarkStopped(t.Context(), sbx)
	require.Empty(t, sandboxes.LifecycleItems())
}

func TestMapLifecycleItemsAllowDuplicateSandboxIDs(t *testing.T) {
	t.Parallel()

	sandboxes := NewSandboxesMap()
	oldSbx := testMapSandbox(t, "sandbox-1", "lifecycle-old")
	newSbx := testMapSandbox(t, "sandbox-1", "lifecycle-new")

	sandboxes.TrackLifecycle(t.Context(), oldSbx, SandboxStateStopping)
	sandboxes.TrackLifecycle(t.Context(), newSbx, SandboxStateRunning)

	require.Len(t, sandboxes.LifecycleItems(), 2)
	require.Len(t, sandboxes.LifecycleItemsByState(SandboxStateStopping), 1)
	require.Len(t, sandboxes.LifecycleItemsByState(SandboxStateRunning), 1)
}

func testMapSandbox(t *testing.T, sandboxID, lifecycleID string) *Sandbox {
	t.Helper()

	slot, err := network.NewSlot("test", 1, network.Config{}, network.NoopEgressProxy{})
	require.NoError(t, err)

	return &Sandbox{
		LifecycleID: lifecycleID,
		Metadata: &Metadata{
			Config: NewConfig(Config{}),
			Runtime: RuntimeMetadata{
				SandboxID: sandboxID,
			},
		},
		Resources: &Resources{Slot: slot},
	}
}
