package volumes

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/e2b-dev/infra/packages/shared/pkg/grpc/orchestrator"
)

func TestVolume(t *testing.T) {
	t.Parallel()

	s, rootPath, volumeInfo := setupTestService(t)

	// create volume
	_, err := s.CreateVolume(t.Context(), &orchestrator.CreateVolumeRequest{
		Volume: volumeInfo,
	})
	require.NoError(t, err)

	_, err = os.Stat(rootPath)
	require.NoError(t, err)

	// delete volume — soft-delete: the directory moves to .trash/<ts>-<name>
	// rather than disappearing. Verify both: the original path is gone AND
	// a matching entry exists in the trash. Guards against the data-loss
	// vector the soft-delete change was added to close (accidental wipe
	// becomes a 30-day recoverable mistake).
	_, err = s.DeleteVolume(t.Context(), &orchestrator.DeleteVolumeRequest{
		Volume: volumeInfo,
	})
	require.NoError(t, err)

	_, err = os.Stat(rootPath)
	require.ErrorIs(t, err, os.ErrNotExist)

	trashRoot := filepath.Join(filepath.Dir(filepath.Dir(rootPath)), ".trash")
	entries, err := os.ReadDir(trashRoot)
	require.NoError(t, err, "trash root should exist after soft-delete")
	require.Len(t, entries, 1, "exactly one trash entry expected")
	require.Truef(t,
		strings.HasSuffix(entries[0].Name(), filepath.Base(rootPath)),
		"trash entry %q should end with the original volume folder name %q",
		entries[0].Name(), filepath.Base(rootPath),
	)
}

func TestVolume_DeleteIsIdempotent(t *testing.T) {
	t.Parallel()

	s, _, volumeInfo := setupTestService(t)

	// First delete: trashes the freshly-created directory.
	_, err := s.CreateVolume(t.Context(), &orchestrator.CreateVolumeRequest{
		Volume: volumeInfo,
	})
	require.NoError(t, err)

	_, err = s.DeleteVolume(t.Context(), &orchestrator.DeleteVolumeRequest{
		Volume: volumeInfo,
	})
	require.NoError(t, err)

	// Second delete on the same volume: source is gone, but we don't
	// want to fail the API call — hive-backend's destroy(userId) flow
	// can retry deletes during reconcile and shouldn't error on a
	// volume that's already in the trash.
	_, err = s.DeleteVolume(t.Context(), &orchestrator.DeleteVolumeRequest{
		Volume: volumeInfo,
	})
	require.NoError(t, err, "second delete on already-trashed volume must be a no-op")
}
