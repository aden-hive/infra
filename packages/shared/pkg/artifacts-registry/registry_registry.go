package artifacts_registry

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	containerregistry "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/remote/transport"
)

// RegistryArtifactsRegistry stores template artifacts in a generic OCI
// registry (Docker Distribution / registry:2, Harbor, self-hosted Quay, etc.)
// using docker config.json credentials. HTTP is allowed via name.Insecure
// so single-node deployments can run registry:2 on 127.0.0.1:5000 without TLS.
//
// Repository name (e.g. "127.0.0.1:5000/e2b-templates") must be set via
// REGISTRY_DOCKER_REPOSITORY_NAME. Images are addressed as
// {repositoryName}/{templateId}:{buildId}.
type RegistryArtifactsRegistry struct {
	repositoryName string
}

var (
	RegistryRepositoryNameEnvVar = "REGISTRY_DOCKER_REPOSITORY_NAME"
)

func NewRegistryArtifactsRegistry() (*RegistryArtifactsRegistry, error) {
	name := os.Getenv(RegistryRepositoryNameEnvVar)
	if name == "" {
		return nil, fmt.Errorf("%s environment variable is not set", RegistryRepositoryNameEnvVar)
	}

	return &RegistryArtifactsRegistry{repositoryName: name}, nil
}

func (r *RegistryArtifactsRegistry) GetTag(_ context.Context, templateId string, buildId string) (string, error) {
	return fmt.Sprintf("%s/%s:%s", r.repositoryName, templateId, buildId), nil
}

func (r *RegistryArtifactsRegistry) GetImage(ctx context.Context, templateId string, buildId string, platform containerregistry.Platform) (containerregistry.Image, error) {
	imageURL, err := r.GetTag(ctx, templateId, buildId)
	if err != nil {
		return nil, fmt.Errorf("failed to get image URL: %w", err)
	}

	ref, err := name.ParseReference(imageURL, name.Insecure)
	if err != nil {
		return nil, fmt.Errorf("invalid image reference: %w", err)
	}

	img, err := remote.Image(ref,
		remote.WithAuthFromKeychain(authn.DefaultKeychain),
		remote.WithPlatform(platform),
		remote.WithContext(ctx),
	)
	if err != nil {
		if isNotFound(err) {
			return nil, ErrImageNotExists
		}
		return nil, fmt.Errorf("error pulling image: %w", err)
	}

	return img, nil
}

func (r *RegistryArtifactsRegistry) Delete(ctx context.Context, templateId string, buildId string) error {
	imageURL, err := r.GetTag(ctx, templateId, buildId)
	if err != nil {
		return fmt.Errorf("failed to get image URL: %w", err)
	}

	ref, err := name.ParseReference(imageURL, name.Insecure)
	if err != nil {
		return fmt.Errorf("invalid image reference: %w", err)
	}

	if err := remote.Delete(ref,
		remote.WithAuthFromKeychain(authn.DefaultKeychain),
		remote.WithContext(ctx),
	); err != nil {
		if isNotFound(err) {
			return ErrImageNotExists
		}
		return fmt.Errorf("failed to delete image: %w", err)
	}

	return nil
}

func isNotFound(err error) bool {
	var terr *transport.Error
	if errors.As(err, &terr) {
		return terr.StatusCode == 404
	}
	return false
}
