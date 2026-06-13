package volumes

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/e2b-dev/infra/packages/shared/pkg/grpc/orchestrator"
)

// trashSubdir is the per-volume-type "soft-delete bucket". A delete
// request renames /<root>/team-<uuid>/vol-<uuid> into this directory
// instead of os.RemoveAll'ing it; an external sweeper (configured via
// /etc/cron.daily) removes entries older than 30 days. Recovery: rename
// the entry back to its original path AND re-insert the volume row in
// hive-backend's account_vm.e2b_volume_id.
//
// The 30-day window matches the user-facing language on Stop in the
// desktop app ("your storage will be kept"); changing one without the
// other will surprise users.
const trashSubdir = ".trash"

func (s *Service) DeleteVolume(
	ctx context.Context,
	request *orchestrator.DeleteVolumeRequest,
) (r *orchestrator.DeleteVolumeResponse, err error) {
	_, span := tracer.Start(ctx, "delete volume")
	defer func() {
		setSpanStatus(span, err)
		span.End()
	}()

	fullPath, err := s.getVolumeRootPath(ctx, request.GetVolume())
	if err != nil {
		return nil, fmt.Errorf("failed to build volume path: %w", err)
	}

	// Pre-soft-delete: if the directory's already gone (idempotent
	// delete, or two calls racing), treat as success. Same semantics as
	// the prior os.RemoveAll behavior — that swallowed ENOENT silently
	// too, since RemoveAll returns nil for missing paths.
	if _, statErr := os.Stat(fullPath); errors.Is(statErr, os.ErrNotExist) {
		span.AddEvent("volume already absent — nothing to soft-delete", trace.WithAttributes(
			attribute.String("path", fullPath),
		))
		return &orchestrator.DeleteVolumeResponse{}, nil
	}

	// Resolve the volume-type root so .trash/ lands as a sibling of the
	// team-<uuid> directory tree, not inside any single team. Falling
	// back to filepath.Dir(filepath.Dir(...)) is brittle on path edge
	// cases (e.g. trailing slashes), but keeps the trash colocated on
	// the same filesystem so os.Rename is atomic (cross-device EXDEV
	// would otherwise force a copy+delete and lose the atomicity).
	volumeTypeRoot, ok := s.config.PersistentVolumeMounts[request.GetVolume().GetVolumeType()]
	if !ok {
		// Defensive: we already built a path off this volumeType above,
		// so the map lookup must succeed. If it doesn't, fail loud.
		return nil, fmt.Errorf("volume type %q not in PersistentVolumeMounts (lookup raced with config reload?)", request.GetVolume().GetVolumeType())
	}

	trashRoot := filepath.Join(volumeTypeRoot, trashSubdir)
	if err := os.MkdirAll(trashRoot, 0o755); err != nil {
		return nil, fmt.Errorf("failed to create trash root %q: %w", trashRoot, err)
	}

	// Trash name: <unix-ts>-<vol-uuid-segment>. Timestamp prefix makes
	// the cron sweeper's "older than N days" filter trivial (sort by
	// name, drop everything before the cutoff timestamp). The vol-uuid
	// segment from the original path tail keeps the original volume id
	// recoverable for the rename-back workflow.
	trashName := fmt.Sprintf("%d-%s", time.Now().Unix(), filepath.Base(fullPath))
	trashPath := filepath.Join(trashRoot, trashName)

	span.AddEvent("soft-deleting volume to trash", trace.WithAttributes(
		attribute.String("from", fullPath),
		attribute.String("to", trashPath),
	))

	if err := os.Rename(fullPath, trashPath); err != nil {
		return nil, fmt.Errorf("failed to move volume %q to trash %q: %w", fullPath, trashPath, err)
	}

	return &orchestrator.DeleteVolumeResponse{}, nil
}
