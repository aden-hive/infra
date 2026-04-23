#!/bin/bash
# Startup script for the Hive-noVNC PoC VM (Container-Optimized OS).
# Fetches the Kimi API key from Secret Manager using the VM's default
# service account, then pulls and runs the sandbox image.

set -eu
exec > /var/log/hive-novnc-startup.log 2>&1

PROJECT=aden-487803
SECRET_NAME=hive-kimi-api-key
REGISTRY=us-central1-docker.pkg.dev
IMAGE="${REGISTRY}/${PROJECT}/sandbox-images/hive-novnc:dev"

# /root is read-only on COS, so give docker-credential-gcr a writable HOME.
export HOME=/var/hive-startup
mkdir -p "${HOME}/.docker"

# Wire Artifact Registry auth for root's Docker context.
docker-credential-gcr configure-docker --registries="${REGISTRY}" >/dev/null

# Fetch KIMI_API_KEY from Secret Manager using the VM's SA.
TOKEN=$(curl -sfS -H 'Metadata-Flavor: Google' \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

KIMI_API_KEY=$(curl -sfS -H "Authorization: Bearer ${TOKEN}" \
  "https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${SECRET_NAME}/versions/latest:access" \
  | python3 -c "import json,sys,base64; print(base64.b64decode(json.load(sys.stdin)['payload']['data']).decode())")

docker pull "${IMAGE}"
docker rm -f hive-novnc 2>/dev/null || true
docker run -d --name hive-novnc \
  --restart unless-stopped \
  --shm-size=2g \
  -p 6080:6080 -p 8787:8787 \
  -e KIMI_API_KEY="${KIMI_API_KEY}" \
  "${IMAGE}"

echo "startup complete: $(date -u)"
