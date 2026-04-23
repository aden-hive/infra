package dockerhub

import (
	"context"
	"fmt"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	containerregistry "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

// RegistryRemoteRepository pulls source OCI images from a generic
// registry (Docker Distribution / registry:2, Harbor, self-hosted
// Quay, etc.) using docker config.json credentials.
// HTTP is allowed via name.Insecure so that single-node deployments
// can run a local registry:2 on 127.0.0.1:5000 without TLS.
type RegistryRemoteRepository struct {
	repositoryURL string
}

func NewRegistryRemoteRepository(repositoryURL string) *RegistryRemoteRepository {
	return &RegistryRemoteRepository{repositoryURL: repositoryURL}
}

func (r *RegistryRemoteRepository) GetImage(ctx context.Context, tag string, platform containerregistry.Platform) (containerregistry.Image, error) {
	tagWithoutRegistry, err := removeRegistryFromTag(tag)
	if err != nil {
		return nil, fmt.Errorf("error removing registry from tag: %w", err)
	}

	ref, err := name.ParseReference(r.repositoryURL+"/"+tagWithoutRegistry, name.Insecure)
	if err != nil {
		return nil, fmt.Errorf("invalid image reference: %w", err)
	}

	img, err := remote.Image(ref,
		remote.WithAuthFromKeychain(authn.DefaultKeychain),
		remote.WithPlatform(platform),
		remote.WithContext(ctx),
	)
	if err != nil {
		return nil, fmt.Errorf("error pulling image from %s: %w", r.repositoryURL, err)
	}

	return img, nil
}

func (r *RegistryRemoteRepository) Close() error { return nil }
