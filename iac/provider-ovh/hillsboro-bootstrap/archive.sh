#!/usr/bin/env bash
# archive.sh — Phase 1 of the OVH VM migration.
#
# Produces a self-describing snapshot of the source box's state under
# /var/backups/migration/, then uploads to GCS at
#   gs://${BUCKET}/${SOURCE_HOSTNAME}/${TIMESTAMP}/
#
# The pattern:
#   - Atomic snapshots first (Postgres/Consul/Nomad/Redis) — MVCC-fast.
#   - Live tarballs of static-enough trees (etc, opt, orchestrator, hive-profiles).
#   - Age-encrypted tarballs for secret trees (letsencrypt, ssh, ovh-e2b, hive, minio).
#   - MinIO bucket mirror in two passes with a 5-min write-quiescence
#     between them so no template push falls into a hole.
#   - Everything under /var/backups/migration, sha256'd, upload atomic.
#
# The whole run is idempotent and resumable via --phase. If the disk is
# tight (VA is 94% full — 57 G free), start with --phase snapshots
# followed by --phase upload for those, then delete the local copies
# before doing --phase tarballs. archive.sh does NOT do this staging
# for you (it would need to know your free-space policy); it just does
# whatever phase you ask for.
#
# Usage:
#   sudo ./archive.sh [--bucket gs://…] [--phase all|snapshots|tarballs|minio|upload]
#                     [--age-recipient <age-pubkey-string>]
#                     [--stage-dir /var/backups/migration]
#                     [--dry-run]
#
# Env fallbacks (all optional; flags win):
#   BUCKET, AGE_RECIPIENT, STAGE_DIR, GCS_KEY_FILE, POSTGRES_DB, REDIS_PASS
#
# Requires (on the box): gcloud, gsutil, mc, age, zstd, jq, consul, redis-cli,
#                        pg_dump, sudo access to /etc/* trees.

set -euo pipefail

# ── defaults ────────────────────────────────────────────────────────────
BUCKET="${BUCKET:-gs://hive-vm-migration-2026-08}"
STAGE_DIR="${STAGE_DIR:-/var/backups/migration}"
AGE_RECIPIENT="${AGE_RECIPIENT:-}"
GCS_KEY_FILE="${GCS_KEY_FILE:-/etc/vm-migration/gcs-key.json}"
POSTGRES_DB="${POSTGRES_DB:-e2b}"
REDIS_PASS="${REDIS_PASS:-}"
PHASE="all"
DRY_RUN=0

# Static list of what we back up. Central so the manifest generator and
# the tar/upload loops stay in sync.
declare -A SECRET_TREES=(
  # relative path in stage dir → source tree on box
  [etc-letsencrypt.tar.zst.age]=/etc/letsencrypt
  [etc-ssh.tar.zst.age]=/etc/ssh
  [etc-ovh-e2b.tar.zst.age]=/etc/ovh-e2b
  [etc-hive.tar.zst.age]=/etc/hive
  [etc-minio.tar.zst.age]=/etc/minio
  [etc-default-hive-ops-agent.tar.zst.age]=/etc/default/hive-ops-agent
  [etc-default-hive-ops-caddy.tar.zst.age]=/etc/default/hive-ops-caddy
)
declare -A OPEN_TARS=(
  [opt-hive-browser-farm.tar.zst]=/opt/hive-browser-farm
  [opt-consul.tar.zst]=/opt/consul
  [opt-nomad.tar.zst]=/opt/nomad
  [orchestrator.tar.zst]=/orchestrator
  [var-lib-hive-profiles.tar.zst]=/var/lib/hive-profiles
  [fc-kernels.tar.zst]=/fc-kernels
  [fc-versions.tar.zst]=/fc-versions
  [fc-envd.tar.zst]=/fc-envd
)

# ── arg parse ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket)          BUCKET="$2"; shift 2 ;;
    --phase)           PHASE="$2"; shift 2 ;;
    --age-recipient)   AGE_RECIPIENT="$2"; shift 2 ;;
    --stage-dir)       STAGE_DIR="$2"; shift 2 ;;
    --dry-run)         DRY_RUN=1; shift ;;
    -h|--help)         sed -n '1,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                 echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$PHASE" in
  all|snapshots|tarballs|minio|upload) ;;
  *) echo "invalid --phase: $PHASE (allowed: all|snapshots|tarballs|minio|upload)" >&2; exit 2 ;;
esac

if [[ -z "$AGE_RECIPIENT" && "$PHASE" != "minio" ]]; then
  echo "error: --age-recipient (or AGE_RECIPIENT env) required to encrypt secret tarballs." >&2
  echo "       Generate on your laptop: age-keygen -o migration.age.key" >&2
  echo "       Then use the public-key line ('# public key: age1…')." >&2
  exit 2
fi

# ── helpers ─────────────────────────────────────────────────────────────
log() { echo "[archive $(date -u +%FT%TZ)] $*"; }
run() { if (( DRY_RUN )); then echo "  DRY-RUN: $*"; else eval "$@"; fi; }

require_cmd() {
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || { echo "missing binary: $c" >&2; exit 1; }
  done
}
require_cmd tar zstd age gsutil sha256sum jq consul redis-cli
[ "$(id -u)" -eq 0 ] || { echo "must run as root (or via sudo)" >&2; exit 1; }

TS="$(date -u +%Y-%m-%dT%H-%MZ)"
SOURCE_HOSTNAME="$(hostname -s)"
SOURCE_IPV4="$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | grep -v '^10\.' | grep -v '^172\.' | grep -v '^192\.168\.' | head -1)"
GCS_PREFIX="${BUCKET}/${SOURCE_HOSTNAME}/${TS}"

log "source=${SOURCE_HOSTNAME} ip=${SOURCE_IPV4} bucket_prefix=${GCS_PREFIX}"
log "stage=${STAGE_DIR} phase=${PHASE} dry_run=${DRY_RUN}"

# Stage dir setup — safe against re-invocation.
run "install -d -m 0700 -o root -g root '${STAGE_DIR}'"

# ── phase: snapshots (atomic; fast; MVCC-consistent) ────────────────────
if [[ "$PHASE" == "all" || "$PHASE" == "snapshots" ]]; then
  log "→ snapshots"

  # pg_dump uses MVCC — no lock, atomic across the DB.
  if command -v pg_dump >/dev/null 2>&1; then
    log "  pg_dump ${POSTGRES_DB}"
    # Redirect stdout instead of `-f`: `sudo -u postgres` demotes the child,
    # and postgres user has no write on /var/backups/migration (root:0700).
    # The `>` binds in the parent shell (root), so file creation is fine.
    run "sudo -u postgres pg_dump -Fc -d '${POSTGRES_DB}' > '${STAGE_DIR}/e2b.pgcustom'"
    log "  pg_dumpall -g (roles/perms)"
    run "sudo -u postgres pg_dumpall -g > '${STAGE_DIR}/globals.sql'"
  else
    log "  pg_dump not installed; skipping"
  fi

  # Consul snapshot — raft-consistent.
  if systemctl is-active --quiet consul; then
    log "  consul snapshot save"
    run "consul snapshot save '${STAGE_DIR}/consul.snap'"
  else
    log "  consul not active; skipping snapshot"
  fi

  # Nomad snapshot — best-effort (VA's nomad is broken).
  if systemctl is-active --quiet nomad 2>/dev/null; then
    log "  nomad operator snapshot save (best-effort)"
    run "nomad operator snapshot save '${STAGE_DIR}/nomad.snap' || echo '  (nomad snapshot failed; skipping — expected on VA)'"
  else
    log "  nomad not active; skipping snapshot"
  fi

  # Redis RDB — BGSAVE derived, atomic.
  if [[ -n "$REDIS_PASS" ]]; then
    log "  redis --rdb"
    run "redis-cli -a '${REDIS_PASS}' --no-auth-warning --rdb '${STAGE_DIR}/redis-dump.rdb'"
  else
    # Try to read requirepass from /etc/redis/redis.conf as a fallback.
    RPW="$(grep -E '^\s*requirepass\s' /etc/redis/redis.conf 2>/dev/null | awk '{print $2}' | tr -d '\r' || true)"
    if [[ -n "${RPW}" ]]; then
      log "  redis --rdb (password from /etc/redis/redis.conf)"
      run "redis-cli -a '${RPW}' --no-auth-warning --rdb '${STAGE_DIR}/redis-dump.rdb'"
    else
      log "  redis password unknown (pass --REDIS_PASS or set requirepass in /etc/redis/redis.conf); skipping"
    fi
  fi
fi

# ── phase: tarballs (live tar; static-enough trees) ─────────────────────
if [[ "$PHASE" == "all" || "$PHASE" == "tarballs" ]]; then
  log "→ tarballs"

  # /etc excluding sensitive trees (those get their own age-encrypted tars).
  ETC_EXCLUDES=(
    --exclude=etc/letsencrypt
    --exclude=etc/ssh
    --exclude=etc/ovh-e2b
    --exclude=etc/hive
    --exclude=etc/minio
    --exclude=etc/default/hive-ops-agent
    --exclude=etc/default/hive-ops-caddy
  )
  log "  etc.tar.zst"
  run "tar --zstd -cf '${STAGE_DIR}/etc.tar.zst' -C / ${ETC_EXCLUDES[@]} etc"

  # Encrypted secret bundles — one per sensitive tree.
  for out in "${!SECRET_TREES[@]}"; do
    src="${SECRET_TREES[$out]}"
    [[ -e "$src" ]] || { log "  skip $src (not present)"; continue; }
    log "  ${out}  ← ${src}"
    # tar --zstd | age -r → single stream; leaves nothing on disk unencrypted.
    parent="$(dirname "$src")"; base="$(basename "$src")"
    run "tar --zstd -cf - -C '${parent}' '${base}' | age -r '${AGE_RECIPIENT}' -o '${STAGE_DIR}/${out}'"
  done

  # Open tarballs — static enough to tar live.
  for out in "${!OPEN_TARS[@]}"; do
    src="${OPEN_TARS[$out]}"
    [[ -e "$src" ]] || { log "  skip $src (not present)"; continue; }
    # /opt/hive-browser-farm excludes node_modules; /orchestrator excludes build/.
    extra=""
    case "$src" in
      /opt/hive-browser-farm) extra="--exclude=hive-browser-farm/node_modules --exclude=hive-browser-farm/dist" ;;
      /orchestrator)          extra="--exclude=orchestrator/build" ;;
    esac
    parent="$(dirname "$src")"; base="$(basename "$src")"
    log "  ${out}  ← ${src}${extra:+  (${extra})}"
    run "tar --zstd -cf '${STAGE_DIR}/${out}' -C '${parent}' ${extra} '${base}'"
  done

  # Inventory of the box, for post-facto forensics.
  log "  inventory-*.txt"
  run "systemctl list-units --state=running --no-pager > '${STAGE_DIR}/inventory-systemctl.txt'"
  run "dpkg -l > '${STAGE_DIR}/inventory-dpkg.txt'"
  run "ip -4 -o addr show > '${STAGE_DIR}/inventory-ip.txt'"
  run "ss -tulpn > '${STAGE_DIR}/inventory-ss.txt' 2>/dev/null || true"
  run "iptables-save > '${STAGE_DIR}/inventory-iptables.txt' 2>/dev/null || true"
  run "ufw status verbose > '${STAGE_DIR}/inventory-ufw.txt' 2>/dev/null || true"
  run "mount > '${STAGE_DIR}/inventory-mount.txt'"
  run "df -hT > '${STAGE_DIR}/inventory-df.txt'"
  run "cat /etc/os-release > '${STAGE_DIR}/inventory-os-release.txt'"
  run "hostnamectl > '${STAGE_DIR}/inventory-hostnamectl.txt' 2>/dev/null || true"
fi

# ── phase: minio (long; two passes with brief quiescence between) ───────
if [[ "$PHASE" == "all" || "$PHASE" == "minio" ]]; then
  log "→ minio mirror"

  require_cmd mc

  # Pull local MinIO creds from /etc/minio/credentials.
  # shellcheck disable=SC1091
  source /etc/minio/credentials 2>/dev/null || { echo "cannot source /etc/minio/credentials" >&2; exit 1; }
  ROOT_USER="${MINIO_ROOT_USER:-${MINIO_ACCESS_KEY:-}}"
  ROOT_PASS="${MINIO_ROOT_PASSWORD:-${MINIO_SECRET_KEY:-}}"
  [[ -n "$ROOT_USER" && -n "$ROOT_PASS" ]] || { echo "MinIO root creds not found in /etc/minio/credentials" >&2; exit 1; }

  run "mc alias set --api s3v4 va http://127.0.0.1:9000 '${ROOT_USER}' '${ROOT_PASS}' >/dev/null"

  # GCS mirror endpoint via mc — uses HMAC creds on the service account.
  # If GCS_HMAC_KEY / GCS_HMAC_SECRET aren't set, fall back to gsutil rsync
  # (slower per-object, no --newer-than second pass, but always works).
  if [[ -n "${GCS_HMAC_KEY:-}" && -n "${GCS_HMAC_SECRET:-}" ]]; then
    run "mc alias set --api s3v4 gcs https://storage.googleapis.com '${GCS_HMAC_KEY}' '${GCS_HMAC_SECRET}' >/dev/null"
    MIRROR_TOOL=mc
  else
    log "  GCS_HMAC_KEY not set → using gsutil rsync (slower, but no second-pass delta)"
    MIRROR_TOOL=gsutil
  fi

  for bucket in e2b-templates oci-registry hive-userdata; do
    if ! mc ls "va/${bucket}" >/dev/null 2>&1; then
      log "  bucket ${bucket} not present on VA MinIO; skipping"
      continue
    fi
    if [[ "$MIRROR_TOOL" == mc ]]; then
      log "  pass 1: mc mirror va/${bucket} → gcs/${GCS_PREFIX#gs://}/minio/${bucket}/"
      run "mc mirror --preserve --overwrite va/${bucket} gcs/${GCS_PREFIX#gs://}/minio/${bucket}/"
    else
      log "  gsutil -m rsync -r /srv/minio/${bucket}/ → ${GCS_PREFIX}/minio/${bucket}/"
      run "gsutil -m rsync -r '/srv/minio/${bucket}/' '${GCS_PREFIX}/minio/${bucket}/'"
    fi
  done

  # Two-pass ONLY makes sense for e2b-templates (the write-heavy bucket).
  # oci-registry is written only during template rolls; hive-userdata is
  # already GCS-mirrored elsewhere.
  if [[ "$MIRROR_TOOL" == mc ]]; then
    log "  brief quiescence (5 min): stop hive-api hive-replicator, second-pass, restart"
    if (( DRY_RUN == 0 )); then
      systemctl stop hive-api hive-replicator || true
      trap 'systemctl start hive-api hive-replicator || true' EXIT
      mc mirror --preserve --overwrite --newer-than 4h va/e2b-templates "gcs/${GCS_PREFIX#gs://}/minio/e2b-templates/"
      systemctl start hive-api hive-replicator || true
      trap - EXIT
    else
      echo "  DRY-RUN: (would stop hive-api hive-replicator, mc mirror --newer-than 4h, restart)"
    fi
  fi
fi

# ── manifest + sha256 + upload ──────────────────────────────────────────
if [[ "$PHASE" == "all" || "$PHASE" == "upload" ]]; then
  log "→ manifest + upload"

  # Sha256 everything in stage dir (non-recursive — MinIO mirror already lives
  # in GCS, not here).
  log "  sha256sum every artifact"
  ( cd "${STAGE_DIR}" && sha256sum ./*.pgcustom ./*.sql ./*.snap ./*.rdb ./*.tar.zst ./*.tar.zst.age ./inventory-*.txt 2>/dev/null > SHA256SUMS ) || true

  # Build the manifest.
  log "  compose manifest.json"
  INFRA_REV="$(cd /home/ubuntu/infra 2>/dev/null && git rev-parse HEAD 2>/dev/null || echo unknown)"

  # Emit the artifacts array to a temp file first (jq --slurpfile is safer than
  # --argfile with process substitution — process subs can silently truncate
  # under some bash + jq combos, and --argfile is deprecated).
  ART_JSON="$(mktemp)"
  (
    cd "${STAGE_DIR}"
    printf '['
    first=1
    while IFS= read -r -d '' f; do
      rel="${f#./}"
      # Skip the manifest itself + SHA256SUMS in the artifact list.
      [[ "$rel" == "manifest.json" || "$rel" == "SHA256SUMS" ]] && continue
      size=$(stat -c '%s' "$f")
      sha=$(awk -v k="./${rel}" '$2 == k {print $1}' SHA256SUMS 2>/dev/null || echo "")
      kind=tar_zst
      case "$rel" in
        *.pgcustom)              kind=pg_dump ;;
        globals.sql)             kind=pg_globals ;;
        consul.snap)             kind=consul_snapshot ;;
        nomad.snap)              kind=nomad_snapshot ;;
        redis-dump.rdb)          kind=redis_rdb ;;
        *.tar.zst.age)           kind=tar_zst_age ;;
        inventory-*.txt)         kind=inventory_text ;;
      esac
      enc=false
      [[ "$rel" == *.age ]] && enc=true
      [[ $first -eq 0 ]] && printf ','
      printf '{"path":"%s","size_bytes":%d,"sha256":"%s","kind":"%s","encrypted":%s}' \
        "$rel" "$size" "$sha" "$kind" "$enc"
      first=0
    done < <(find . -maxdepth 1 -type f -print0)
    printf ']'
  ) > "$ART_JSON"

  jq -n \
    --arg version "1" \
    --arg source_hostname "${SOURCE_HOSTNAME}" \
    --arg source_public_ipv4 "${SOURCE_IPV4}" \
    --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg infra_git_rev "${INFRA_REV}" \
    --slurpfile artifacts "$ART_JSON" \
    '{
       version:$version,
       source_hostname:$source_hostname,
       source_public_ipv4:$source_public_ipv4,
       created_at:$created_at,
       infra_git_rev:$infra_git_rev,
       artifacts:$artifacts[0],
       restore_order:[
         "etc-ovh-e2b.tar.zst.age",
         "etc-minio.tar.zst.age",
         "etc-hive.tar.zst.age",
         "etc-letsencrypt.tar.zst.age",
         "etc-default-hive-ops-agent.tar.zst.age",
         "etc-default-hive-ops-caddy.tar.zst.age",
         "etc-ssh.tar.zst.age",
         "etc.tar.zst",
         "opt-hive-browser-farm.tar.zst",
         "opt-consul.tar.zst",
         "e2b.pgcustom",
         "consul.snap",
         "redis-dump.rdb",
         "fc-kernels.tar.zst",
         "fc-versions.tar.zst",
         "fc-envd.tar.zst",
         "orchestrator.tar.zst",
         "var-lib-hive-profiles.tar.zst"
       ]
     }' > "${STAGE_DIR}/manifest.json"
  rm -f "$ART_JSON"

  # gcloud auth
  if [[ -f "${GCS_KEY_FILE}" ]]; then
    run "gcloud auth activate-service-account --key-file='${GCS_KEY_FILE}' >/dev/null"
  else
    log "  ${GCS_KEY_FILE} not present — assuming gcloud is already authenticated"
  fi

  log "  gsutil -m cp -r → ${GCS_PREFIX}/"
  # Do NOT re-upload the minio/ mirror (mc mirror handled that in-place).
  run "gsutil -m -o 'GSUtil:parallel_composite_upload_threshold=150M' cp -r '${STAGE_DIR}'/*.pgcustom '${STAGE_DIR}'/*.sql '${STAGE_DIR}'/*.snap '${STAGE_DIR}'/*.rdb '${STAGE_DIR}'/*.tar.zst '${STAGE_DIR}'/*.tar.zst.age '${STAGE_DIR}'/inventory-*.txt '${STAGE_DIR}'/SHA256SUMS '${STAGE_DIR}'/manifest.json '${GCS_PREFIX}/'"

  log "✓ done. Verify: gsutil ls -lh '${GCS_PREFIX}/' && gsutil cat '${GCS_PREFIX}/manifest.json' | jq"
fi
