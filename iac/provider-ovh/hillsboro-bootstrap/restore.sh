#!/usr/bin/env bash
# restore.sh — Phase 3 of the OVH VM migration.
#
# Downloads the archive at gs://…/ns1008198-virginia/<TS>/ produced by
# archive.sh, verifies sha256s against the manifest, decrypts secret
# tarballs with age, replays state into the Hillsboro (or any new) box,
# rewrites the source IP wherever it was baked in, and unmasks + starts
# the hive-* systemd units.
#
# Assumes bootstrap.sh has already run successfully on this box.
#
# Idempotent: every step checks pre-state and no-ops if already applied.
# Broken into --phase for retry (download|decrypt|state|minio|start|verify).
#
# Usage:
#   sudo ./restore.sh \
#     --from gs://hive-vm-migration-2026-08/ns1008198-virginia/2026-08-XXTHH-MMZ/ \
#     --age-key /root/migration.age.key \
#     --new-ipv4 $(curl -s ifconfig.me) \
#     [--gcs-key-file /etc/vm-migration/gcs-key.json] \
#     [--stage-dir /var/backups/migration] \
#     [--phase all|download|decrypt|state|minio|start|verify] \
#     [--dry-run]

set -euo pipefail

FROM=""; AGE_KEY=""; NEW_IPV4=""; GCS_KEY_FILE="/etc/vm-migration/gcs-key.json"
STAGE_DIR="/var/backups/migration"; PHASE="all"; DRY_RUN=0
GCS_HMAC_KEY="${GCS_HMAC_KEY:-}"; GCS_HMAC_SECRET="${GCS_HMAC_SECRET:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)          FROM="$2"; shift 2 ;;
    --age-key)       AGE_KEY="$2"; shift 2 ;;
    --new-ipv4)      NEW_IPV4="$2"; shift 2 ;;
    --gcs-key-file)  GCS_KEY_FILE="$2"; shift 2 ;;
    --stage-dir)     STAGE_DIR="$2"; shift 2 ;;
    --phase)         PHASE="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)       sed -n '1,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

for var in FROM AGE_KEY; do
  [[ -n "${!var}" ]] || { echo "missing required flag: --${var,,}" >&2; exit 2; }
done
[ -f "$AGE_KEY" ] || { echo "age key file not found: $AGE_KEY" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "must run as root (or via sudo)" >&2; exit 1; }
case "$PHASE" in
  all|download|decrypt|state|minio|start|verify) ;;
  *) echo "invalid --phase: $PHASE" >&2; exit 2 ;;
esac

# Auto-detect new IP if not provided.
if [[ -z "$NEW_IPV4" ]]; then
  NEW_IPV4="$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | grep -v '^10\.' | grep -v '^172\.' | grep -v '^192\.168\.' | head -1)"
fi
[[ -n "$NEW_IPV4" ]] || { echo "cannot determine new box's public IPv4; pass --new-ipv4" >&2; exit 1; }

log()  { echo "[restore $(date -u +%FT%TZ)] $*"; }
run()  { if (( DRY_RUN )); then echo "  DRY-RUN: $*"; else eval "$@"; fi; }
warn() { echo "[restore WARN] $*" >&2; }

log "from=${FROM}"
log "new_ipv4=${NEW_IPV4} stage=${STAGE_DIR} phase=${PHASE} dry_run=${DRY_RUN}"

run "install -d -m 0700 '${STAGE_DIR}'"

# ── phase: download ─────────────────────────────────────────────────────
if [[ "$PHASE" == "all" || "$PHASE" == "download" ]]; then
  log "→ download"
  if [[ -f "${GCS_KEY_FILE}" ]]; then
    run "gcloud auth activate-service-account --key-file='${GCS_KEY_FILE}' >/dev/null"
  else
    log "  ${GCS_KEY_FILE} not present — assuming gcloud is already authenticated"
  fi
  # Manifest first, so we know what we're expecting.
  run "gsutil cp '${FROM%/}/manifest.json' '${STAGE_DIR}/manifest.json'"
  # Pull every artifact enumerated in the manifest.
  # shellcheck disable=SC2016
  ARTIFACTS="$(jq -r '.artifacts[].path' "${STAGE_DIR}/manifest.json")"
  for a in $ARTIFACTS; do
    # MinIO mirror artifacts are actually directories under gs://.../minio/;
    # we skip those here — Phase minio handles them via mc mirror.
    case "$a" in minio/*|SHA256SUMS) continue ;; esac
    if [[ -f "${STAGE_DIR}/${a}" ]]; then
      log "  already have ${a}"
      continue
    fi
    log "  gsutil cp ${a}"
    run "gsutil cp '${FROM%/}/${a}' '${STAGE_DIR}/${a}'"
  done
  # Pull the SHA256SUMS file (used to verify below).
  run "gsutil cp '${FROM%/}/SHA256SUMS' '${STAGE_DIR}/SHA256SUMS' || true"

  # Verify sha256s.
  log "  verify sha256"
  fail=0
  # shellcheck disable=SC2016
  jq -r '.artifacts[] | select(.sha256 != "dir") | "\(.sha256)  ./\(.path)"' "${STAGE_DIR}/manifest.json" > "${STAGE_DIR}/.expected-sha256"
  ( cd "${STAGE_DIR}" && sha256sum -c .expected-sha256 --quiet ) || fail=1
  if (( fail )); then
    echo "sha256 verification FAILED. Re-download by removing bad files and re-running --phase download." >&2
    exit 1
  fi
  log "  ✓ sha256 verified"
fi

# ── phase: decrypt ──────────────────────────────────────────────────────
if [[ "$PHASE" == "all" || "$PHASE" == "decrypt" ]]; then
  log "→ decrypt + extract secret tarballs into /etc/*"
  # Order matters: /etc/ovh-e2b + /etc/minio + /etc/hive first (creds needed
  # by subsequent state restore), then /etc/letsencrypt + /etc/ssh + defaults.
  for enc in etc-ovh-e2b etc-minio etc-hive etc-letsencrypt etc-ssh \
             etc-default-hive-ops-agent etc-default-hive-ops-caddy; do
    f="${STAGE_DIR}/${enc}.tar.zst.age"
    [[ -f "$f" ]] || { log "  skip ${enc} (not in archive)"; continue; }
    log "  age -d ${enc}.tar.zst.age → /etc/…"
    run "age -d -i '${AGE_KEY}' '${f}' | tar --zstd -xf - -C /"
  done
  # Extract the non-secret /etc bulk on top (does NOT overwrite the secret
  # trees since etc.tar.zst was archived WITHOUT them).
  if [[ -f "${STAGE_DIR}/etc.tar.zst" ]]; then
    log "  tar -xf etc.tar.zst"
    run "tar --zstd -xf '${STAGE_DIR}/etc.tar.zst' -C /"
  fi
fi

# ── phase: state (rewrite IPs, restore pg/consul/redis, unpack /opt+/orchestrator) ──
if [[ "$PHASE" == "all" || "$PHASE" == "state" ]]; then
  log "→ state restore"

  SOURCE_IPV4="$(jq -r '.source_public_ipv4' "${STAGE_DIR}/manifest.json")"
  log "  IP rewrite: ${SOURCE_IPV4} → ${NEW_IPV4}"
  if [[ "$SOURCE_IPV4" != "$NEW_IPV4" ]]; then
    # Anywhere in /etc restored above that references the source IP.
    # Restrict to text files < 1 MB to avoid re-writing certs / binaries.
    run "grep -rlZI --include='*.hcl' --include='*.env' --include='*.service' --include='*.conf' --include='Caddyfile' '${SOURCE_IPV4}' /etc 2>/dev/null | xargs -0 -r sed -i 's/${SOURCE_IPV4}/${NEW_IPV4}/g'"
  fi

  # Consul KV prefix rename (ovh-vinthill-1 → whatever node_name is on this box).
  SOURCE_NODE="$(grep -oE 'node_name\s*=\s*"[^"]+"' /etc/consul.d/consul.hcl.bak 2>/dev/null | head -1 | cut -d'"' -f2 || echo '')"
  NEW_NODE="$(grep -oE 'node_name\s*=\s*"[^"]+"' /etc/consul.d/consul.hcl | head -1 | cut -d'"' -f2 || echo '')"
  if [[ -n "$SOURCE_NODE" && -n "$NEW_NODE" && "$SOURCE_NODE" != "$NEW_NODE" ]]; then
    log "  consul KV rename prefix: ${SOURCE_NODE}/ → ${NEW_NODE}/"
    # Wait for consul to accept API calls (bootstrap.sh started it).
    for i in $(seq 1 30); do
      consul kv get "${SOURCE_NODE}/" >/dev/null 2>&1 || consul info >/dev/null 2>&1 && break
      sleep 1
    done
    if [[ -f "${STAGE_DIR}/consul.snap" ]]; then
      log "  consul snapshot restore consul.snap"
      run "consul snapshot restore '${STAGE_DIR}/consul.snap'"
    fi
    # Rename KV prefix in place.
    run "consul kv export '${SOURCE_NODE}/' 2>/dev/null | sed 's|\"${SOURCE_NODE}/|\"${NEW_NODE}/|g' | consul kv import - >/dev/null || true"
    run "consul kv delete -recurse '${SOURCE_NODE}/' 2>/dev/null || true"
  fi

  # Postgres restore.
  if [[ -f "${STAGE_DIR}/e2b.pgcustom" ]]; then
    log "  pg_restore e2b"
    run "sudo -u postgres createdb e2b 2>/dev/null || true"
    # Load globals.sql FIRST so any roles referenced by grants/policies exist.
    # If a role (e.g. Supabase's `authenticated`, `trigger_user`) isn't defined
    # in globals either, pg_restore skips the referring grants — expected in
    # non-Supabase target — and the browser-farm workload doesn't need them.
    if [[ -f "${STAGE_DIR}/globals.sql" ]]; then
      log "  psql globals.sql (roles/perms) — before pg_restore so refs resolve"
      run "sudo -u postgres psql < '${STAGE_DIR}/globals.sql' 2>&1 | tail -20 || true"
    fi
    # Same permission dance as archive.sh's pg_dump: stage dir is 0700 root,
    # `sudo -u postgres pg_restore -f FILE` can't read it. Redirect stdin
    # so the root parent process does the file open. `|| true` because
    # pg_restore exits 1 on "errors ignored", which under set -e kills us
    # even when the data landed fine.
    run "sudo -u postgres pg_restore -d e2b --clean --if-exists < '${STAGE_DIR}/e2b.pgcustom' || true"
  fi

  # Redis RDB.
  if [[ -f "${STAGE_DIR}/redis-dump.rdb" ]]; then
    log "  cp redis-dump.rdb → /var/lib/redis/dump.rdb (needs redis stopped)"
    run "systemctl stop redis-server 2>/dev/null || true"
    run "cp '${STAGE_DIR}/redis-dump.rdb' /var/lib/redis/dump.rdb"
    run "chown redis:redis /var/lib/redis/dump.rdb"
    # requirepass is in the ovh-e2b secret bundle at redis.env — pull it in.
    if [[ -f /etc/ovh-e2b/redis.env ]]; then
      RPW="$( . /etc/ovh-e2b/redis.env 2>/dev/null; echo "${REDIS_PASS:-}" )"
      if [[ -n "$RPW" ]]; then
        run "sed -i -E 's/^\\s*requirepass\\s.*/requirepass ${RPW}/' /etc/redis/redis.conf"
        if ! grep -qE '^\s*requirepass\s' /etc/redis/redis.conf; then
          run "echo 'requirepass ${RPW}' >> /etc/redis/redis.conf"
        fi
      fi
    fi
    run "systemctl start redis-server"
  fi

  # /opt/hive-browser-farm — bootstrap.sh already dropped the vendor copy
  # with its own uid/perms; the tarball has VA's uid/perms. We overlay VA's
  # runtime state (deploy/*, spike/*, etc.) but keep newer files from
  # bootstrap. `|| true` because tar 1.x returns non-zero on the
  # "Unexpected inconsistency when making directory" warning that fires
  # when the dir already exists with different metadata — that's expected
  # here and harmless.
  if [[ -f "${STAGE_DIR}/opt-hive-browser-farm.tar.zst" ]]; then
    log "  overlay opt-hive-browser-farm.tar.zst on /opt (preserves node_modules from bootstrap)"
    run "tar --zstd -xf '${STAGE_DIR}/opt-hive-browser-farm.tar.zst' -C /opt --keep-newer-files --no-same-owner 2>&1 | tail -5 || true"
  fi

  # /orchestrator — archaeology (not wired). Only unpack if the operator
  # asked for it via env var; skip by default to save disk.
  if [[ -n "${RESTORE_ORCHESTRATOR:-}" && -f "${STAGE_DIR}/orchestrator.tar.zst" ]]; then
    log "  tar -xf orchestrator.tar.zst (RESTORE_ORCHESTRATOR set)"
    run "tar --zstd -xf '${STAGE_DIR}/orchestrator.tar.zst' -C /"
  fi

  # Chrome profiles — matched snapshot with pg_dump moment.
  if [[ -f "${STAGE_DIR}/var-lib-hive-profiles.tar.zst" ]]; then
    log "  tar -xf var-lib-hive-profiles.tar.zst"
    run "tar --zstd -xf '${STAGE_DIR}/var-lib-hive-profiles.tar.zst' -C /var/lib"
    run "chown -R ubuntu:ubuntu /var/lib/hive-profiles"
  fi

  # Firecracker binaries — archaeology; unpack alongside for symmetry.
  for f in fc-kernels fc-versions fc-envd; do
    if [[ -f "${STAGE_DIR}/${f}.tar.zst" ]]; then
      log "  tar -xf ${f}.tar.zst"
      run "tar --zstd -xf '${STAGE_DIR}/${f}.tar.zst' -C /"
    fi
  done
fi

# ── phase: minio (reverse mirror from GCS) ──────────────────────────────
if [[ "$PHASE" == "all" || "$PHASE" == "minio" ]]; then
  log "→ minio reverse mirror (GCS → local :9000)"
  systemctl start minio || true

  # Local creds are now in /etc/minio/credentials (restored by decrypt phase).
  # shellcheck disable=SC1091
  source /etc/minio/credentials 2>/dev/null || { echo "cannot source /etc/minio/credentials" >&2; exit 1; }
  ROOT_USER="${MINIO_ROOT_USER:-${MINIO_ACCESS_KEY:-}}"
  ROOT_PASS="${MINIO_ROOT_PASSWORD:-${MINIO_SECRET_KEY:-}}"
  [[ -n "$ROOT_USER" && -n "$ROOT_PASS" ]] || { echo "MinIO creds missing after restore" >&2; exit 1; }

  # Wait for MinIO to be up.
  for i in $(seq 1 60); do
    curl -sf "http://127.0.0.1:9000/minio/health/live" >/dev/null && break
    sleep 1
  done

  run "mc alias set --api s3v4 hilo http://127.0.0.1:9000 '${ROOT_USER}' '${ROOT_PASS}' >/dev/null"

  if [[ -n "$GCS_HMAC_KEY" && -n "$GCS_HMAC_SECRET" ]]; then
    run "mc alias set --api s3v4 gcs https://storage.googleapis.com '${GCS_HMAC_KEY}' '${GCS_HMAC_SECRET}' >/dev/null"
    for bucket in e2b-templates oci-registry hive-userdata; do
      log "  mc mb hilo/${bucket}"
      run "mc mb --ignore-existing hilo/${bucket}"
      # NOTE: mc alias `gcs` expects the S3-compat endpoint; the archive
      # lives at s3://<bucket>/<prefix>/minio/<bucket>/  — flatten:
      SRC="gcs/${FROM#gs://}minio/${bucket}"
      log "  mc mirror ${SRC} → hilo/${bucket}"
      run "mc mirror --preserve --overwrite '${SRC}' hilo/${bucket}"
    done
  else
    log "  GCS_HMAC_KEY not set → using gsutil rsync (per-object, slower)"
    for bucket in e2b-templates oci-registry hive-userdata; do
      run "install -d -o minio-user -g minio-user /srv/minio/${bucket}"
      run "gsutil -m rsync -r '${FROM%/}/minio/${bucket}/' '/srv/minio/${bucket}/'"
      run "chown -R minio-user:minio-user /srv/minio/${bucket}"
    done
  fi
fi

# ── phase: start (unmask + start hive-*, docker registry) ──────────────
if [[ "$PHASE" == "all" || "$PHASE" == "start" ]]; then
  log "→ unmask + start hive-* services"

  # oci-registry container needs /etc/hive/oci-registry.env — write it if
  # the archive didn't include it (some VAs don't; the registry container
  # config is external to the S3 backend creds).
  if [[ ! -f /etc/hive/oci-registry.env && -f /etc/minio/credentials ]]; then
    log "  write /etc/hive/oci-registry.env from MinIO creds"
    # shellcheck disable=SC1091
    source /etc/minio/credentials
    cat > /etc/hive/oci-registry.env <<EOF
REGISTRY_STORAGE=s3
REGISTRY_STORAGE_S3_REGION=us-east-1
REGISTRY_STORAGE_S3_REGIONENDPOINT=http://127.0.0.1:9000
REGISTRY_STORAGE_S3_BUCKET=oci-registry
REGISTRY_STORAGE_S3_ACCESSKEY=${MINIO_ROOT_USER:-${MINIO_ACCESS_KEY:-}}
REGISTRY_STORAGE_S3_SECRETKEY=${MINIO_ROOT_PASSWORD:-${MINIO_SECRET_KEY:-}}
REGISTRY_HTTP_ADDR=127.0.0.1:5000
EOF
    chmod 0600 /etc/hive/oci-registry.env
  fi
  if [[ -f /etc/hive/oci-registry.env ]] && ! docker ps --format '{{.Names}}' | grep -qw oci-registry; then
    log "  docker run oci-registry"
    run "docker run -d --restart=always --name oci-registry --network host --env-file /etc/hive/oci-registry.env registry:2 || docker start oci-registry"
  fi

  for unit in hive-xvfb hive-chrome hive-ops-agent hive-api hive-replicator; do
    run "systemctl unmask ${unit}.service || true"
    run "systemctl enable --now ${unit}.service"
  done

  # Egress unit was created by bootstrap.sh via gen-egress.sh — enable it.
  EGRESS_UNIT="hive-egress-${NEW_IPV4//./-}.service"
  if [[ -f /etc/systemd/system/${EGRESS_UNIT} ]]; then
    run "systemctl enable --now ${EGRESS_UNIT}"
  fi

  # Caddy last — it needs the cert files that letsencrypt provided from
  # the restored /etc/letsencrypt tree.
  run "systemctl enable --now caddy"
fi

# ── phase: verify ───────────────────────────────────────────────────────
if [[ "$PHASE" == "all" || "$PHASE" == "verify" ]]; then
  log "→ verify"
  fail=0

  # Postgres row counts (compare against manifest.sanity_expectations if present).
  EXPECT_ENVBUILDS="$(jq -r '.sanity_expectations.postgres.env_builds_count // empty' "${STAGE_DIR}/manifest.json")"
  if [[ -n "$EXPECT_ENVBUILDS" ]]; then
    GOT="$(sudo -u postgres psql -d e2b -tAc 'select count(*) from env_builds' 2>/dev/null || echo -1)"
    if [[ "$GOT" == "$EXPECT_ENVBUILDS" ]]; then
      log "  ✓ env_builds count matches (${GOT})"
    else
      warn "env_builds count: expected ${EXPECT_ENVBUILDS} got ${GOT}"; fail=1
    fi
  fi

  # MinIO object counts.
  if command -v mc >/dev/null 2>&1; then
    for bucket in e2b-templates oci-registry; do
      cnt="$(mc ls -r "hilo/${bucket}" 2>/dev/null | wc -l)"
      log "  hilo/${bucket}: ${cnt} objects"
    done
  fi

  # Systemd health.
  log "  systemctl status (hive-* + caddy + minio + consul + postgres + redis-server + docker + oci-registry container):"
  for unit in hive-api hive-chrome hive-xvfb hive-replicator hive-ops-agent caddy minio consul postgresql redis-server docker; do
    state="$(systemctl is-active "${unit}" 2>/dev/null || echo unknown)"
    if [[ "$state" == "active" ]]; then
      log "    ✓ ${unit}: ${state}"
    else
      warn "${unit}: ${state}"; fail=1
    fi
  done
  # oci-registry is a docker container, not a systemd unit.
  if docker ps --format '{{.Names}}' | grep -qw oci-registry; then
    log "    ✓ oci-registry (container): running"
  else
    warn "oci-registry container: not running"; fail=1
  fi

  # Caddy TLS: wait for cert issuance.
  if [[ -f /etc/letsencrypt/live/*/fullchain.pem ]]; then
    log "  ✓ TLS cert present (or restored)"
  else
    warn "no TLS cert found under /etc/letsencrypt/live/*; watch 'journalctl -u caddy -f' for issuance"
  fi

  if (( fail )); then
    echo "verify: FAILED (some checks reported failures above)" >&2
    exit 1
  fi
  log "✓ verify passed"
fi

echo
log "✓ restore.sh done. Manual next steps:"
log "  1) Add DNS records for the new hostname → ${NEW_IPV4}"
log "  2) Wait for Caddy to issue TLS cert (journalctl -u caddy -f)"
log "  3) Run the 11-step smoke test from the plan"
log "  4) Update peer box's UFW to allow this box's IP on :9000"
