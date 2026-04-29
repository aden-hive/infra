#!/usr/bin/env bash
# Roll a new build of the hive-novnc Firecracker template end-to-end.
#
#   ./roll-template.sh                        # bumps colonies-vN by reading registry, builds, registers
#   ./roll-template.sh -t my-tag              # use an explicit registry tag
#   ./roll-template.sh -a hivev4              # also register a different alias (creates env if missing)
#   ./roll-template.sh --skip-sync            # skip rsync of local hive-src to orchestrator (build-only)
#
# What it does, idempotently, in order:
#   1. rsync sandbox-images/hive-novnc/ from this checkout → orchestrator host
#   2. docker build + push to local registry as <ALIAS>:<TAG>  (via ssh)
#   3. stop nomad-managed orchestrator long enough to free port 5007
#   4. orchestrator/bin/create-build → Firecracker rootfs+memfile snapshot
#   5. restart nomad → orchestrator
#   6. INSERT into postgres env_builds + env_build_assignments → new build active
#   7. probe e2b API to confirm alias→buildID has flipped
#
# Why a script: every step has a footgun (port-5007 conflict with nomad
# respawn, build-cache env vars, postgres alias mapping). Running them
# one-by-one from a shell drifts every time.
#
# Requires:
#   - SSH access to $ORCH_HOST as $ORCH_USER (default: ubuntu@135.148.52.236)
#   - psql + redis-cli on the orchestrator
#   - The e2b API at https://api.vm.open-hive.com (read-only, just for verify)

set -euo pipefail

ORCH_USER="${ORCH_USER:-ubuntu}"
ORCH_HOST="${ORCH_HOST:-135.148.52.236}"
ORCH="${ORCH_USER}@${ORCH_HOST}"
ALIAS="${HIVE_TEMPLATE_ALIAS:-hivev3}"
TAG=""
SKIP_SYNC=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--tag) TAG="$2"; shift 2 ;;
    -a|--alias) ALIAS="$2"; shift 2 ;;
    --skip-sync) SKIP_SYNC=1; shift ;;
    -h|--help) sed -n '1,/^$/p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ── 0. resolve registry tag ───────────────────────────────────────────
if [[ -z "$TAG" ]]; then
  echo "→ inspecting registry for next colonies-vN tag"
  EXISTING=$(ssh "$ORCH" "curl -sS http://127.0.0.1:5000/v2/hive-novnc/tags/list" \
              | python3 -c "import json,sys; print(' '.join(json.load(sys.stdin).get('tags',[])))")
  N=$(echo "$EXISTING" | tr ' ' '\n' | sed -n 's/^colonies-v\([0-9]\+\)$/\1/p' | sort -n | tail -1)
  N=$((${N:-0} + 1))
  TAG="colonies-v$N"
  echo "  next tag: $TAG"
fi

IMAGE="127.0.0.1:5000/hive-novnc:${TAG}"
NEW_BUILD_ID="$(uuidgen)"

# ── 1. rsync source → orchestrator ───────────────────────────────────
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$SKIP_SYNC" -eq 0 ]]; then
  echo "→ rsync ${ROOT}/ → ${ORCH}:/home/${ORCH_USER}/infra/sandbox-images/hive-novnc/"
  rsync -a --delete \
    --exclude='__pycache__' --exclude='.venv' --exclude='*.pyc' \
    "${ROOT}/" "${ORCH}:/home/${ORCH_USER}/infra/sandbox-images/hive-novnc/"
fi

# ── 2. docker build + push ───────────────────────────────────────────
echo "→ docker build $IMAGE (no-cache)"
ssh "$ORCH" "cd /home/${ORCH_USER}/infra/sandbox-images/hive-novnc && \
  sudo docker build --no-cache -t ${IMAGE} -t 127.0.0.1:5000/hive-novnc:latest . 2>&1 | tail -3"

echo "→ docker push $IMAGE"
ssh "$ORCH" "sudo docker push ${IMAGE} 2>&1 | tail -2 && sudo docker push 127.0.0.1:5000/hive-novnc:latest 2>&1 | tail -2"

# ── 3. stop nomad → free :5007 ───────────────────────────────────────
# nomad respawns the orchestrator alloc on any kill; stopping the agent
# itself is the only way to keep the port free long enough for create-build.
echo "→ stopping nomad agent + orchestrator alloc"
ssh "$ORCH" "
  sudo systemctl stop nomad
  sleep 2
  sudo pkill -KILL -f 'nomad executor' 2>/dev/null || true
  sudo pkill -KILL -f 'bin/orchestrator' 2>/dev/null || true
  sudo pkill -KILL -f 'bin/api' 2>/dev/null || true
  sleep 2
  if sudo ss -tlnp | grep -q ':5007'; then
    echo '!! 5007 still bound — refusing to continue'
    sudo ss -tlnp | grep ':5007'
    exit 1
  fi
"

# ── 4. create-build → Firecracker snapshot ───────────────────────────
echo "→ create-build → $NEW_BUILD_ID"
ssh "$ORCH" "
  cd /home/${ORCH_USER}/infra/sandbox-images/hive-novnc
  sudo timeout 900 /usr/bin/env \
    STORAGE_PROVIDER=Local \
    LOCAL_TEMPLATE_STORAGE_BASE_PATH=/orchestrator/build-cache/templates \
    LOCAL_BUILD_CACHE_STORAGE_BASE_PATH=/orchestrator/build-cache \
    USE_LOCAL_NAMESPACE_STORAGE=true \
    ENVIRONMENT=local \
    DOCKERHUB_REMOTE_REPOSITORY_PROVIDER=Local \
    HOST_BUSYBOX_DIR=/fc-busybox \
    HOST_KERNELS_DIR=/fc-kernels \
    FIRECRACKER_VERSIONS_DIR=/fc-versions \
    HOST_ENVD_PATH=/fc-envd/envd \
    /home/${ORCH_USER}/infra/packages/orchestrator/bin/create-build \
      -to-build $NEW_BUILD_ID \
      -template $ALIAS \
      -vcpu 2 -memory 2560 -disk 6144 \
      -hugepages=false \
      -fromImage $IMAGE \
      -storage /orchestrator/build-cache 2>&1 | tail -3
"

# ── 5. restart nomad ─────────────────────────────────────────────────
echo "→ restart nomad"
ssh "$ORCH" "
  sudo systemctl start nomad
  for i in 1 2 3 4 5 6 7 8; do
    sleep 2
    if sudo ss -tlnp | grep -q 'orchestrator.*:5007'; then
      echo '   orchestrator back on 5007 (\$i tries)'
      break
    fi
  done
"

# ── 6. register build → make it the active build for the alias ───────
# This is the step the underlying create-build CLI does NOT do — it
# writes the snapshot to disk but leaves the e2b API/postgres mapping
# pointing at the previous build. Without this, fresh sandboxes still
# spawn from the old build.
echo "→ register build in postgres"
ssh "$ORCH" "
  PGPASSWORD=\$(sudo cat /proc/\$(pgrep -f 'bin/api' | head -1)/environ 2>/dev/null \
    | tr '\0' '\n' | grep '^POSTGRES_CONNECTION_STRING=' \
    | sed 's|.*//e2b:||;s|@.*||')
  ENV_ID=\$(PGPASSWORD=\$PGPASSWORD psql -h 127.0.0.1 -U e2b -d e2b -tAc \
    \"select env_id from env_aliases where alias='${ALIAS}'\")
  TEAM_ID=\$(PGPASSWORD=\$PGPASSWORD psql -h 127.0.0.1 -U e2b -d e2b -tAc \
    \"select team_id from envs where id='\$ENV_ID'\")
  if [[ -z \"\$ENV_ID\" || -z \"\$TEAM_ID\" ]]; then
    echo \"!! alias '${ALIAS}' has no env mapping in postgres — register the env first\"
    exit 1
  fi
  PGPASSWORD=\$PGPASSWORD psql -h 127.0.0.1 -U e2b -d e2b <<SQL
INSERT INTO env_builds (
  id, created_at, updated_at, finished_at,
  status, vcpu, ram_mb, free_disk_size_mb, total_disk_size_mb,
  kernel_version, firecracker_version, env_id, envd_version,
  reason, status_group, team_id
) VALUES (
  '$NEW_BUILD_ID', NOW(), NOW(), NOW(),
  'uploaded', 2, 2560, 4096, 6144,
  'vmlinux-6.1.158', 'v1.12.1_210cbac', \$ENV_ID, '0.1.0',
  '{}'::jsonb, 'ready', \$TEAM_ID
);
INSERT INTO env_build_assignments (env_id, build_id, tag, source)
VALUES (\$ENV_ID, '$NEW_BUILD_ID', 'default', 'app');
SQL
"

# ── 7. verify via the e2b API ────────────────────────────────────────
echo "→ verify with e2b API"
E2B_KEY=$(kubectl exec -n staging staging-hive-app-6fc9ff85c9-55hnt -- env 2>/dev/null \
  | grep '^E2B_API_KEY=' | cut -d= -f2- || true)
if [[ -n "$E2B_KEY" ]]; then
  curl -sS -m 5 https://api.vm.open-hive.com/templates -H "X-API-Key: $E2B_KEY" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); \
      print('alias=', [t['aliases'] for t in d if '${ALIAS}' in t['aliases']]); \
      print('buildID=', [t['buildID'] for t in d if '${ALIAS}' in t['aliases']])"
else
  echo "  (skipped — no kubectl access for E2B_API_KEY; check https://api.vm.open-hive.com/templates manually)"
fi

cat <<DONE

═══════════════════════════════════════════════════════════════════
  Template rolled.
    alias    : ${ALIAS}
    image    : ${IMAGE}
    build_id : ${NEW_BUILD_ID}
═══════════════════════════════════════════════════════════════════

Next sandbox spawn will use the new build. Old running sandboxes are
unchanged (they hold the previous build snapshot in memory).
DONE
