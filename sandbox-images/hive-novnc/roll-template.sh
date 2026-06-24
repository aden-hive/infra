#!/usr/bin/env bash
# Roll a new build of the hive-novnc Firecracker template end-to-end.
#
#   ./roll-template.sh                       # bumps colonies-vN, builds, registers
#   ./roll-template.sh -t my-tag             # use an explicit registry tag
#   ./roll-template.sh -a hivev4             # also register a different alias
#   ./roll-template.sh --skip-sync           # skip the local→orchestrator rsync
#   ./roll-template.sh --skip-runtime-sync   # skip refreshing hive-src/ from the fork
#   ./roll-template.sh check                 # run env-snapshot + storage probe against
#                                              the *current* alias (no roll)
#
# What it does, idempotently, in order:
#   0. sync hive-src/ from $HOME/aden/hive-desktop-runtime (via sync-hive-src.sh)
#   1. rsync sandbox-images/hive-novnc/ from this checkout → orchestrator host
#   2. docker build + push to local registry as hive-novnc:<TAG>
#   3. snapshot the *running* orchestrator's env vars (storage / registry / paths)
#   4. orchestrator/bin/create-build with the orchestrator's env BUT every
#      sandbox-network port shifted by +100 (so create-build's listeners and
#      iptables-redirect targets don't collide with the live orch's). →
#      Firecracker rootfs+memfile snapshot (lands in MinIO when STORAGE_PROVIDER=AWSBucket)
#   5. probe the snapshot's storage destination — every expected file present?
#   6. INSERT into postgres env_builds + env_build_assignments → new build active
#      (with source_rev / image_tag stamped into env_builds.reason for forensics)
#   7. probe e2b API to confirm alias→buildID has flipped
#
# Notably absent (and intentional): no nomad stop / orchestrator kill. The live
# orchestrator + api keep running the entire time. Any sandboxes the user has
# in flight are unaffected — no SIGTERM cascade, no firecracker reap, no
# blink. The trade-off is one new failure mode: if create-build crashes
# mid-run, it might leave leaked iptables rules in chains on its shifted
# port range (5110-5118). The boot-time orphan reaper handles the firecracker
# cleanup; the iptables leak is at worst cosmetic until the next reboot.
#
# Footguns this script handles for you:
#   - create-build does NOT register the build with the e2b API. Postgres
#     `env_build_assignments` is what the alias resolution reads.
#   - The orchestrator runs with STORAGE_PROVIDER=AWSBucket+minio in production;
#     the prior version of this script hardcoded STORAGE_PROVIDER=Local and
#     wrote snapshots to a path the orchestrator never looks at — silent
#     half-roll. Now we read the env from the live orchestrator process.
#   - We verify the snapshot exists in the storage backend BEFORE flipping the
#     alias, so a busted build leaves the previous good build live.
#
# Requires:
#   - SSH access to $ORCH_HOST as $ORCH_USER (default: ubuntu@135.148.52.236)
#   - psql + redis-cli + mc on the orchestrator
#   - The e2b API at https://api.vm.open-hive.com (read-only, just for verify)

set -euo pipefail

ORCH_USER="${ORCH_USER:-ubuntu}"
ORCH_HOST="${ORCH_HOST:-135.148.52.236}"
ORCH="${ORCH_USER}@${ORCH_HOST}"
ALIAS="${HIVE_TEMPLATE_ALIAS:-hivev3}"
TAG=""
SKIP_SYNC=0
SKIP_RUNTIME_SYNC=0
SUBCOMMAND="roll"

# ── arg parse ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--tag) TAG="$2"; shift 2 ;;
    -a|--alias) ALIAS="$2"; shift 2 ;;
    --skip-sync) SKIP_SYNC=1; shift ;;
    --skip-runtime-sync) SKIP_RUNTIME_SYNC=1; shift ;;
    check) SUBCOMMAND="check"; shift ;;
    -h|--help) sed -n '1,/^$/p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── shared helpers ────────────────────────────────────────────────────

# Snapshot the running orchestrator's env vars over SSH. Returns the keys
# create-build cares about as `KEY=VALUE` lines on stdout, suitable for
# wrapping into `env $(...)` further down. If no orchestrator is running,
# returns nothing (caller handles).
snapshot_orchestrator_env() {
  # Use -x (exact match against the basename) + filter to only commands
  # whose first arg IS the orchestrator binary path. Otherwise the bash
  # subshell running this SSH heredoc itself matches `-f bin/orchestrator`
  # — pgrep then picks the bash by PID order, sudo cat returns bash's
  # env (no STORAGE_PROVIDER), grep returns 1, pipefail trips set -e in
  # the caller, script aborts silently with no useful error. Caused
  # every "exit 1" roll-fail today.
  ssh "$ORCH" '
    PID=$(pgrep -x orchestrator | head -1)
    [[ -z "$PID" ]] && exit 0
    sudo cat /proc/$PID/environ 2>/dev/null | tr "\0" "\n" | grep -E "^(STORAGE_PROVIDER|TEMPLATE_BUCKET_NAME|BUILD_CACHE_BUCKET_NAME|AWS_ENDPOINT_URL_S3|AWS_REGION|AWS_S3_USE_PATH_STYLE|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|ARTIFACTS_REGISTRY_PROVIDER|DOCKERHUB_REMOTE_REPOSITORY_PROVIDER|DOCKERHUB_REMOTE_REPOSITORY_URL|REGISTRY_DOCKER_REPOSITORY_NAME|HOST_BUSYBOX_DIR|HOST_KERNELS_DIR|FIRECRACKER_VERSIONS_DIR|HOST_ENVD_PATH|ENVIRONMENT|USE_LOCAL_NAMESPACE_STORAGE|LOCAL_TEMPLATE_STORAGE_BASE_PATH|LOCAL_BUILD_CACHE_STORAGE_BASE_PATH|NODE_IP)="
  '
}

# Probe the storage backend for a specific build_id. Returns 0 if all six
# expected files exist (memfile, memfile.header, metadata.json, rootfs.ext4,
# rootfs.ext4.header, snapfile), 1 otherwise. Branches on STORAGE_PROVIDER.
verify_snapshot_in_storage() {
  local build_id="$1"
  local env_blob="$2"
  local provider bucket local_path
  provider=$(echo "$env_blob" | grep '^STORAGE_PROVIDER=' | head -1 | cut -d= -f2-)
  bucket=$(echo "$env_blob" | grep '^TEMPLATE_BUCKET_NAME=' | head -1 | cut -d= -f2-)
  local_path=$(echo "$env_blob" | grep '^LOCAL_TEMPLATE_STORAGE_BASE_PATH=' | head -1 | cut -d= -f2-)

  case "$provider" in
    AWSBucket)
      # MinIO: file-listing under /srv/minio/<bucket>/<build-id>/.
      # mc is also on the host but `ls` over SSH is simpler and faster.
      ssh "$ORCH" "
        for f in memfile memfile.header metadata.json rootfs.ext4 rootfs.ext4.header snapfile; do
          if ! sudo test -e /srv/minio/${bucket}/${build_id}/\$f; then
            echo \"  missing: /srv/minio/${bucket}/${build_id}/\$f\"
            exit 1
          fi
        done
      "
      ;;
    Local)
      ssh "$ORCH" "
        for f in memfile memfile.header metadata.json rootfs.ext4 rootfs.ext4.header snapfile; do
          if ! sudo test -f ${local_path}/${build_id}/\$f; then
            echo \"  missing: ${local_path}/${build_id}/\$f\"
            exit 1
          fi
        done
      "
      ;;
    *)
      echo "  unknown STORAGE_PROVIDER='$provider' — can't verify; refusing to flip" >&2
      return 1
      ;;
  esac
}

# Verify the live orchestrator + api are both healthy BEFORE we run
# create-build alongside them. If they aren't running, fall back to the
# legacy stop-nomad behavior (which is then necessary, because create-build
# can no longer rely on an existing namespace pool / NFS proxy etc).
verify_orchestrator_running() {
  ssh "$ORCH" bash -s <<'REMOTE'
    orch=$(sudo ss -tlnp 2>/dev/null | grep -E ':5007 .*"orchestrator"' | head -1)
    api=$(sudo ss -tlnp 2>/dev/null | grep -E ':3000 .*"api"' | head -1)
    if [[ -z "$orch" || -z "$api" ]]; then
      echo "(orchestrator or api NOT running; co-resident build cannot proceed)" >&2
      exit 1
    fi
    # Also verify our shifted ports (5107-5118) are FREE — they're the
    # listeners create-build will bind. A collision means a prior
    # create-build crashed without cleanup; either kill it or pick a
    # different shift.
    for port in 5107 5110 5111 5112 5116 5117 5118; do
      if sudo ss -tlnp 2>/dev/null | grep -q ":$port "; then
        echo "!! shifted port :$port already bound — leftover from a prior crashed create-build?" >&2
        sudo ss -tlnp | grep ":$port " >&2
        exit 1
      fi
    done
    echo "(orchestrator + api healthy; shifted ports free)"
REMOTE
}

# Legacy stop/start kept for emergency rollback — currently unused. If you
# need to fall back to the disruptive behavior (e.g. you found a bug in the
# co-resident path), wrap the create-build call in stop_orchestrator /
# start_orchestrator the way the script did before this change.
_legacy_stop_orchestrator() {
  ssh "$ORCH" bash -s <<'REMOTE'
    sudo systemctl stop nomad
    sleep 2
    for port in 5007 3000; do
      pid=$(sudo ss -tlnp 2>/dev/null | awk -v p=":$port " '$0 ~ p { match($0, /pid=([0-9]+)/, m); print m[1]; exit }')
      if [[ -n "$pid" ]]; then
        sudo kill -KILL "$pid" 2>/dev/null || true
      fi
    done
    for i in $(seq 1 30); do
      sleep 2
      if ! sudo ss -tlnp 2>/dev/null | grep -q ":5007 "; then
        echo "  :5007 free after ${i} polls"
        exit 0
      fi
    done
    echo "!! :5007 still bound after 60s; refusing to continue" >&2
    sudo ss -tlnp | grep ":5007 " >&2
    exit 1
REMOTE
}

_legacy_start_orchestrator() {
  ssh "$ORCH" bash -s <<'REMOTE'
    sudo systemctl start nomad
    for i in $(seq 1 30); do
      sleep 2
      orch=$(sudo ss -tlnp 2>/dev/null | grep -E ':5007 .*"orchestrator"' | head -1)
      api=$(sudo ss -tlnp 2>/dev/null | grep -E ':3000 .*"api"' | head -1)
      if [[ -n "$orch" && -n "$api" ]]; then
        echo "  orchestrator+api back after ${i} polls"
        exit 0
      fi
    done
    echo "!! orchestrator (:5007) or api (:3000) not back after 60s" >&2
    sudo ss -tlnp 2>/dev/null | grep -E ":(5007|3000) " >&2
    exit 1
REMOTE
}

# ── check subcommand ──────────────────────────────────────────────────
# Run env-snapshot + storage probe against the *currently active* build for
# the alias. Useful when triaging "spawns are failing" before re-rolling.
if [[ "$SUBCOMMAND" == "check" ]]; then
  echo "→ checking current state of alias '$ALIAS'"
  ENV_BLOB=$(snapshot_orchestrator_env)
  if [[ -z "$ENV_BLOB" ]]; then
    echo "  no orchestrator running; can't snapshot env" >&2
    exit 1
  fi
  echo "  storage_provider=$(echo "$ENV_BLOB" | grep ^STORAGE_PROVIDER= | cut -d= -f2-)"

  CUR_BUILD=$(ssh "$ORCH" "
    PGPASSWORD=\$(sudo cat /proc/\$(pgrep -f 'bin/api' | head -1)/environ 2>/dev/null \
      | tr '\0' '\n' | grep '^POSTGRES_CONNECTION_STRING=' \
      | sed 's|.*//e2b:||;s|@.*||')
    PGPASSWORD=\$PGPASSWORD psql -h 127.0.0.1 -U e2b -d e2b -tAc \
      \"select build_id from env_build_assignments
        where env_id=(select env_id from env_aliases where alias='${ALIAS}')
        order by created_at desc limit 1\"
  ")
  CUR_BUILD=$(echo "$CUR_BUILD" | tr -d '[:space:]')
  echo "  active build_id: $CUR_BUILD"

  if verify_snapshot_in_storage "$CUR_BUILD" "$ENV_BLOB"; then
    echo "✅  snapshot files present; orchestrator should be able to spawn"
    exit 0
  else
    echo "❌  snapshot files MISSING — fresh sandbox spawns will fail with 'sandbox files not found'"
    exit 1
  fi
fi

# ── 0. resolve registry tag + sync runtime ────────────────────────────
if [[ "$SKIP_RUNTIME_SYNC" -eq 0 ]]; then
  echo "→ syncing hive-src/ from \$HIVE_SRC (default \$HOME/aden/hive-desktop-runtime)"
  bash "$ROOT/sync-hive-src.sh"
fi

# Drift warning: if the AppImage's bundled hive-runtime rev is on disk and
# differs from the one we're about to bake into the VM template, flag it.
APPIMAGE_REV_PATHS=(
  "$HOME/aden/hive-desktop/release/OpenHive-0.1.0-linux-x64/resources/hive/.hive-source-rev"
  "$HOME/aden/hive-desktop/vendor/hive/.hive-source-rev"
)
for p in "${APPIMAGE_REV_PATHS[@]}"; do
  if [[ -f "$p" && -f "$ROOT/hive-src/.hive-source-rev" ]]; then
    APP_REV=$(cat "$p")
    VM_REV=$(cat "$ROOT/hive-src/.hive-source-rev")
    if [[ "$APP_REV" != "$VM_REV" ]]; then
      echo "  ⚠ drift: AppImage hive-runtime is at $APP_REV, VM template will be at $VM_REV"
      echo "    ($p vs $ROOT/hive-src/.hive-source-rev)"
    fi
    break
  fi
done

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

# Capture the runtime source rev/branch so we can stamp it into env_builds.reason.
SOURCE_REV=""
SOURCE_BRANCH=""
if [[ -f "$ROOT/hive-src/.hive-source-rev" ]]; then
  SOURCE_REV=$(cat "$ROOT/hive-src/.hive-source-rev")
fi
if [[ -f "$ROOT/hive-src/.hive-source-branch" ]]; then
  SOURCE_BRANCH=$(cat "$ROOT/hive-src/.hive-source-branch")
fi

# ── 1. rsync source → orchestrator ───────────────────────────────────
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

# ── 3. snapshot the orchestrator's env BEFORE we stop it ─────────────
# This is the change that fixes the 2026-04-29 outage: the orchestrator
# runs with STORAGE_PROVIDER=AWSBucket + minio creds in production. The
# prior version of this script hardcoded STORAGE_PROVIDER=Local and the
# build snapshot landed in a place the orchestrator never reads.
echo "→ snapshotting orchestrator env (storage / registry / host paths)"
ENV_BLOB=$(snapshot_orchestrator_env)
if [[ -z "$ENV_BLOB" ]]; then
  echo "!! no orchestrator running — can't determine storage provider" >&2
  exit 1
fi
ENV_PROVIDER=$(echo "$ENV_BLOB" | grep '^STORAGE_PROVIDER=' | cut -d= -f2-)
echo "  STORAGE_PROVIDER=${ENV_PROVIDER}"
echo "  $(echo "$ENV_BLOB" | wc -l) env vars captured"

# ── 4. verify co-resident build is safe → orch + api healthy, ports free ──
echo "→ verifying live orchestrator + api are healthy, shifted ports free"
verify_orchestrator_running

# ── 5. create-build → snapshot to whichever storage the orch uses ────
echo "→ create-build → $NEW_BUILD_ID  (running co-resident with live orch on shifted ports 5107-5118)"
# Build env-arg block where EACH line ends with `\` so the whole thing
# parses as a single backslash-continued command. The previous version
# only put `\` after `env`, so only the first KEY=VAL reached create-build;
# the rest became standalone shell-local assignments and create-build
# panicked at storage.go:168 reading TEMPLATE_BUCKET_NAME.
#
# Shift every sandbox-network port by +100 so create-build's listeners
# (sandbox proxy, NFS proxy, portmapper, hyperloop, tcp firewall) don't
# collide with the live orch's. The build's VM has its veth iptables
# REDIRECT rules generated by network.go using these env-supplied ports,
# so the build's envd talks to create-build's NFS proxy on :5111 — not
# the orch's :5011 — and never sees /srv/hivedata (correctly, since the
# build is template-prep, not a user sandbox).
SHIFTED_PORT_ENV=$(cat <<'PORTS'
SANDBOX_HYPERLOOP_PROXY_PORT=5110
SANDBOX_NFS_PROXY_PORT=5111
SANDBOX_PORTMAPPER_PORT=5112
SANDBOX_TCP_FIREWALL_HTTP_PORT=5116
SANDBOX_TCP_FIREWALL_TLS_PORT=5117
SANDBOX_TCP_FIREWALL_OTHER_PORT=5118
PORTS
)
ENV_ARGS=$(printf "%s\n%s" "$ENV_BLOB" "$SHIFTED_PORT_ENV" | sed 's|^|    |; s|$| \\|')
# Ready-check: block the snapshot until `hive serve` binds 8787 so resumed
# VMs already have it open. Default ready-cmd is `sleep 20`, which often
# snapshots while hive is still in skill-loading → fresh spawns return
# `502 The sandbox is running but port is not open` for the next ~60s.
# We poll for up to 180s; the Go side caps at 10 min so this is well within.
READY_CMD='for i in $(seq 1 180); do curl -sS --connect-timeout 1 http://127.0.0.1:8787/ -o /dev/null 2>&1 && exit 0; sleep 1; done; echo "hive serve never bound :8787" >&2; exit 1'
ssh "$ORCH" "
  cd /home/${ORCH_USER}/infra/sandbox-images/hive-novnc
  sudo timeout 900 /usr/bin/env \\
$ENV_ARGS
    /home/${ORCH_USER}/infra/packages/orchestrator/bin/create-build \\
      -to-build $NEW_BUILD_ID \\
      -template $ALIAS \\
      -vcpu 2 -memory 4096 -disk 6144 \\
      -hugepages=false \\
      -proxy-port 5107 \\
      -ready-cmd '$READY_CMD' \\
      -fromImage $IMAGE 2>&1 | tail -40
"

# ── 6. verify snapshot is in the storage location the orch reads ─────
echo "→ verifying snapshot files in storage backend"
if ! verify_snapshot_in_storage "$NEW_BUILD_ID" "$ENV_BLOB"; then
  echo "!! snapshot verification FAILED — refusing to flip the alias." >&2
  echo "   alias '$ALIAS' still points at the previous build_id." >&2
  echo "   Inspect the broken build with: ./roll-template.sh check -a $ALIAS" >&2
  echo "   (live orch + api were not touched; cluster is still up)" >&2
  exit 1
fi
echo "  ✓ all six expected files present"

# ── 7. (no-op) live orchestrator + api were never stopped ────────────
# Old version: stopped nomad in step 4, restarted here. New version: the
# build ran co-resident with the live orch the whole time. Nothing to
# bring back up.
#
# HOWEVER: e2b's template cache caches env_build rows by env_id in the
# api process's memory. New `env_build_assignments` rows we INSERT below
# in step 8 are NOT visible until the cache evicts (TTL ~1m). For a fresh
# roll to be picked up immediately by /sandboxes calls, we'd nudge the
# api job. For now we just trust the cache TTL — the seamless mode means
# the user's existing sandbox keeps working on the prior build, and the
# next spawn within ~1m gets the new build. If you need instant switch,
# do `NOMAD_TOKEN=… nomad alloc restart -task api <alloc>` after step 8.
echo "→ (skip restart — orchestrator + api stayed up the whole time)"

# ── 8. register build → make it the active build for the alias ───────
# Stamps source_rev / source_branch / image_tag into env_builds.reason
# so a later forensics query can answer "which commit was that build
# from?" instantly without grepping through orchestrator logs.
echo "→ register build in postgres (with source-rev forensics)"
REASON_JSON=$(printf '{"source_rev":"%s","source_branch":"%s","image_tag":"%s","rolled_at":"%s"}' \
              "$SOURCE_REV" "$SOURCE_BRANCH" "$TAG" "$(date -u +%FT%TZ)")

ssh "$ORCH" "
  PGPASSWORD=\$(sudo cat /proc/\$(pgrep -f 'bin/api' | head -1)/environ 2>/dev/null \
    | tr '\0' '\n' | grep '^POSTGRES_CONNECTION_STRING=' \
    | sed 's|.*//e2b:||;s|@.*||')
  ENV_ID=\$(PGPASSWORD=\$PGPASSWORD psql -h 127.0.0.1 -U e2b -d e2b -tAc \
    \"select env_id from env_aliases where alias='${ALIAS}'\")
  TEAM_ID=\$(PGPASSWORD=\$PGPASSWORD psql -h 127.0.0.1 -U e2b -d e2b -tAc \
    \"select team_id from envs where id='\$ENV_ID'\")
  if [[ -z \"\$ENV_ID\" || -z \"\$TEAM_ID\" ]]; then
    echo \"!! alias '${ALIAS}' has no env mapping in postgres — register the env first\" >&2
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
  'uploaded', 2, 4096, 4096, 6144,
  'vmlinux-6.1.158', 'v1.12.1_210cbac', '\$ENV_ID', '0.5.14',
  '$REASON_JSON'::jsonb, 'ready', '\$TEAM_ID'
);
INSERT INTO env_build_assignments (env_id, build_id, tag, source)
VALUES ('\$ENV_ID', '$NEW_BUILD_ID', 'default', 'app');
SQL
"

# ── 9. verify via the e2b API ────────────────────────────────────────
echo "→ verify with e2b API"
E2B_KEY=""
# Try to discover the API key from a staging-hive-app pod if kubectl is
# available. Falls back to manual verification instructions otherwise.
if command -v kubectl >/dev/null 2>&1; then
  POD=$(kubectl -n staging get pods -o name 2>/dev/null | grep 'staging-hive-app' | head -1 | sed 's|pod/||')
  if [[ -n "$POD" ]]; then
    E2B_KEY=$(kubectl -n staging exec "$POD" -- env 2>/dev/null \
      | grep '^E2B_API_KEY=' | cut -d= -f2- || true)
  fi
fi
if [[ -n "$E2B_KEY" ]]; then
  curl -sS -m 5 https://api.vm.open-hive.com/templates -H "X-API-Key: $E2B_KEY" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); \
      print('alias=', [t['aliases'] for t in d if '${ALIAS}' in t['aliases']]); \
      print('buildID=', [t['buildID'] for t in d if '${ALIAS}' in t['aliases']])"
else
  echo "  (skipped — no E2B_API_KEY discovered; verify manually:"
  echo "    curl https://api.vm.open-hive.com/templates -H 'X-API-Key: \$E2B_KEY')"
fi

cat <<DONE

═══════════════════════════════════════════════════════════════════
  Template rolled.
    alias       : ${ALIAS}
    image       : ${IMAGE}
    build_id    : ${NEW_BUILD_ID}
    source_rev  : ${SOURCE_REV:-(unset)}
    source_branch: ${SOURCE_BRANCH:-(unset)}
═══════════════════════════════════════════════════════════════════

Next sandbox spawn will use the new build. Old running sandboxes are
unchanged (they hold the previous build snapshot in memory).

Run \`./parity-test.sh --colony parity_smoke\` to confirm a colony
behaves equivalently against this template vs the local runtime.
DONE
