package dockerhub

import (
	"context"
	"fmt"

	"github.com/google/go-containerregistry/pkg/name"
	containerregistry "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/daemon"
)

// DaemonRemoteRepository resolves default-registry image references against
// the host's local Docker daemon. Useful for single-node / operator-host
// template builds where images are preloaded via `docker load` and there is
// no proxy registry available.
type DaemonRemoteRepository struct{}

func NewDaemonRemoteRepository() *DaemonRemoteRepository {
	return &DaemonRemoteRepository{}
}

func (d *DaemonRemoteRepository) GetImage(ctx context.Context, tag string, _ containerregistry.Platform) (containerregistry.Image, error) {
	ref, err := name.ParseReference(tag)
	if err != nil {
		return nil, fmt.Errorf("invalid image reference %q: %w", tag, err)
	}

	img, err := daemon.Image(ref, daemon.WithContext(ctx))
	if err != nil {
		return nil, fmt.Errorf("failed to get image %q from local docker daemon: %w", tag, err)
	}

	return img, nil
}

func (d *DaemonRemoteRepository) Close() error { return nil }
