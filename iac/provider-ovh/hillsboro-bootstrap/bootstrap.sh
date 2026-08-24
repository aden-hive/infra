#!/usr/bin/env bash
# bootstrap.sh — Phase 2 of the OVH VM migration.
#
# Turns a bare Ubuntu 24.04 OVH bare-metal into a Hive-browser-farm host
# whose shape matches Virginia's. Idempotent: safe to re-run to reconcile
# drift. Does NOT touch stateful data (no pg_restore, no MinIO mirror,
# no secret writes) — that's restore.sh's job. Bootstrap leaves every
# hive-* systemd unit MASKED; restore.sh unmasks + starts them once state
# is populated.
#
# What this script owns:
#   - apt packages
#   - HashiCorp APT repo → consul only (NOT nomad; VA's is broken)
#   - MinIO server binary + mc client + system user + /srv/minio dir
#   - Postgres 16 + Redis + Docker + Caddy + tinyproxy (Ubuntu packages)
#   - hive-ops-agent binary drop (from vendor/)
#   - /opt/hive-browser-farm (from vendor/) + npm ci
#   - systemd units templated from templates/systemd/ into /etc/systemd/system/
#     (all hive-* MASKED, ready for restore.sh to unmask)
#   - Consul config templated from templates/etc/consul.d/consul.hcl
#   - Caddyfile templated from templates/etc/caddy/Caddyfile
#   - Redis conf edits: bind, requirepass
#   - UFW rules (22, 80, 443 open; MinIO :9000 allowlisted; deny else)
#   - Directory scaffolding for /var/lib/hive-{profiles,chrome}, /etc/hive
#
# What this script does NOT own (handled by restore.sh):
#   - Any secret file contents
#   - Postgres data
#   - MinIO bucket contents
#   - Consul state (KV, ACL bootstrap)
#   - Let's Encrypt cert issuance (belongs to Caddy runtime)
#   - Chrome profiles / hive-profiles state
#
# Usage:
#   sudo ./bootstrap.sh \
#     --public-ip $(curl -s ifconfig.me) \
#     --hostname vm-west \
#     --node-name ovh-hilo-1 \
#     --datacenter ovh-hilo \
#     --acme-email dev@acho.io \
#     --primary-fqdn vm-west.open-hive.com \
#     --api-fqdn     api.vm-west.open-hive.com \
#     [--laptop-ip 136.24.157.169] \
#     [--gke-nat-ip 35.188.101.104] \
#     [--peer-public-ip 135.148.52.236]     # VA's IP; adds to MinIO allowlist
#
# All flags required unless a default exists in the block below.

set -euo pipefail

PUBLIC_IP=""; HOSTNAME_ARG=""; NODE_NAME=""; DATACENTER=""; ACME_EMAIL=""
PRIMARY_FQDN=""; API_FQDN=""
LAPTOP_IP="136.24.157.169"
GKE_NAT_IP="35.188.101.104"
PEER_PUBLIC_IP=""   # optional; the OTHER box's IP for cross-region MinIO
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-ip)     PUBLIC_IP="$2"; shift 2 ;;
    --hostname)      HOSTNAME_ARG="$2"; shift 2 ;;
    --node-name)     NODE_NAME="$2"; shift 2 ;;
    --datacenter)    DATACENTER="$2"; shift 2 ;;
    --acme-email)    ACME_EMAIL="$2"; shift 2 ;;
    --primary-fqdn)  PRIMARY_FQDN="$2"; shift 2 ;;
    --api-fqdn)      API_FQDN="$2"; shift 2 ;;
    --laptop-ip)     LAPTOP_IP="$2"; shift 2 ;;
    --gke-nat-ip)    GKE_NAT_IP="$2"; shift 2 ;;
    --peer-public-ip) PEER_PUBLIC_IP="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)       sed -n '1,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

for var in PUBLIC_IP HOSTNAME_ARG NODE_NAME DATACENTER ACME_EMAIL PRIMARY_FQDN API_FQDN; do
  [[ -n "${!var}" ]] || { echo "missing required flag: --${var,,}" >&2; exit 2; }
done
[ "$(id -u)" -eq 0 ] || { echo "must run as root (or via sudo)" >&2; exit 1; }

log() { echo "[bootstrap $(date -u +%FT%TZ)] $*"; }
run() { if (( DRY_RUN )); then echo "  DRY-RUN: $*"; else eval "$@"; fi; }

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
TEMPLATES="${REPO_ROOT}/templates"
VENDOR="${REPO_ROOT}/vendor"

log "public_ip=${PUBLIC_IP} hostname=${HOSTNAME_ARG} node=${NODE_NAME} dc=${DATACENTER}"
log "primary=${PRIMARY_FQDN} api=${API_FQDN} acme_email=${ACME_EMAIL}"
log "templates=${TEMPLATES} vendor=${VENDOR}"

# ── 1. Hostname ─────────────────────────────────────────────────────────
log "→ hostname"
if [[ "$(hostname -s)" != "$HOSTNAME_ARG" ]]; then
  run "hostnamectl set-hostname '${HOSTNAME_ARG}'"
  run "sed -i.bak -E 's/^127\\.0\\.1\\.1.*/127.0.1.1\\t${HOSTNAME_ARG}/' /etc/hosts || echo '127.0.1.1\\t${HOSTNAME_ARG}' >> /etc/hosts"
fi

# ── 2. apt packages (idempotent — apt-get install is a no-op on installed) ─
log "→ apt packages"
export DEBIAN_FRONTEND=noninteractive
run "apt-get update -qq"
run "apt-get install -y -qq \
  redis-server postgresql-16 postgresql-client-16 \
  caddy \
  containerd docker.io \
  tinyproxy xvfb x11vnc openbox novnc websockify \
  jq age gnupg curl rsync ufw \
  build-essential python3 \
  ca-certificates lsb-release"

# ── 3. HashiCorp APT repo → consul ──────────────────────────────────────
log "→ consul"
if ! command -v consul >/dev/null 2>&1; then
  run "install -m 0755 -d /etc/apt/keyrings"
  run "curl -fsSL https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /etc/apt/keyrings/hashicorp.gpg"
  run "echo 'deb [signed-by=/etc/apt/keyrings/hashicorp.gpg] https://apt.releases.hashicorp.com noble main' > /etc/apt/sources.list.d/hashicorp.list"
  run "apt-get update -qq"
  run "apt-get install -y -qq consul"
else
  log "  consul already installed ($(consul version | head -1))"
fi

# ── 4. Node.js 22 (NodeSource) ──────────────────────────────────────────
log "→ node.js 22"
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -qE '^v22\.'; then
  run "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -"
  run "apt-get install -y -qq nodejs"
else
  log "  node.js already installed ($(node --version))"
fi

# ── 5. Google Chrome stable ─────────────────────────────────────────────
log "→ google-chrome-stable"
if ! command -v google-chrome-stable >/dev/null 2>&1; then
  run "curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb"
  run "apt-get install -y -qq /tmp/chrome.deb"
  run "rm -f /tmp/chrome.deb"
else
  log "  chrome already installed"
fi

# ── 6. MinIO server + mc client ─────────────────────────────────────────
log "→ minio server + mc"
if ! command -v minio >/dev/null 2>&1; then
  run "curl -fsSL https://dl.min.io/server/minio/release/linux-amd64/minio -o /usr/local/bin/minio"
  run "chmod +x /usr/local/bin/minio"
fi
if ! command -v mc >/dev/null 2>&1; then
  run "curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc"
  run "chmod +x /usr/local/bin/mc"
fi
if ! id minio-user >/dev/null 2>&1; then
  run "useradd -r -M -s /sbin/nologin minio-user"
fi
run "install -d -o minio-user -g minio-user -m 0750 /srv/minio /etc/minio"

# ── 7. Directory scaffolding ────────────────────────────────────────────
log "→ directory scaffolding"
run "install -d -o ubuntu -g ubuntu -m 0755 /var/lib/hive-profiles /var/lib/hive-chrome"
run "install -d -m 0700 /etc/hive /etc/hive/egress"
run "install -d -m 0700 /etc/vm-migration"
run "install -d /var/log/hive"

# ── 8. Vendor drop: hive-browser-farm + hive-ops-agent binary ───────────
log "→ /opt/hive-browser-farm (vendor)"
if [[ -d "${VENDOR}/hive-browser-farm" ]]; then
  run "install -d -o ubuntu -g ubuntu /opt/hive-browser-farm"
  run "rsync -a --delete --exclude=node_modules --exclude=deploy/hive-egress-*.service '${VENDOR}/hive-browser-farm/' /opt/hive-browser-farm/"
  run "chown -R ubuntu:ubuntu /opt/hive-browser-farm"
  if [[ -f /opt/hive-browser-farm/package-lock.json ]]; then
    log "  npm ci --omit=dev in /opt/hive-browser-farm"
    run "cd /opt/hive-browser-farm && sudo -u ubuntu npm ci --omit=dev"
  fi
else
  log "  WARNING: ${VENDOR}/hive-browser-farm not present; farm services will fail to start until restored"
fi

log "→ /usr/local/bin/hive-ops-agent"
if [[ -f "${VENDOR}/hive-ops-agent" ]]; then
  run "install -m 0755 '${VENDOR}/hive-ops-agent' /usr/local/bin/hive-ops-agent"
else
  log "  WARNING: ${VENDOR}/hive-ops-agent not present; build with 'cd packages/ops-agent && go build -o hive-ops-agent .' and drop into vendor/"
fi

# ── 9. Templated config: Caddyfile ──────────────────────────────────────
log "→ /etc/caddy/Caddyfile"
run "install -d /etc/caddy"
CERT_FULLCHAIN="/etc/letsencrypt/live/${PRIMARY_FQDN}/fullchain.pem"
CERT_PRIVKEY="/etc/letsencrypt/live/${PRIMARY_FQDN}/privkey.pem"
WILDCARD_HOST="*.$(echo "${PRIMARY_FQDN}" | cut -d. -f2-)"
run "sed -e 's|__PRIMARY_HOSTNAME__|${PRIMARY_FQDN}|g' \
         -e 's|__API_HOSTNAME__|${API_FQDN}|g' \
         -e 's|__WILDCARD_HOST__|${WILDCARD_HOST}|g' \
         -e 's|__CERT_FULLCHAIN__|${CERT_FULLCHAIN}|g' \
         -e 's|__CERT_PRIVKEY__|${CERT_PRIVKEY}|g' \
         -e 's|__ACME_EMAIL__|${ACME_EMAIL}|g' \
         '${TEMPLATES}/etc/caddy/Caddyfile' > /etc/caddy/Caddyfile"

# ── 10. Templated config: Consul ────────────────────────────────────────
log "→ /etc/consul.d/consul.hcl"
run "install -d -o consul -g consul /etc/consul.d /opt/consul"
GOSSIP_KEY="$(consul keygen 2>/dev/null || openssl rand -base64 32)"
run "sed -e 's|__NODE_NAME__|${NODE_NAME}|g' \
         -e 's|__DATACENTER__|${DATACENTER}|g' \
         -e 's|__PUBLIC_IPV4__|${PUBLIC_IP}|g' \
         -e 's|__GOSSIP_KEY__|${GOSSIP_KEY}|g' \
         '${TEMPLATES}/etc/consul.d/consul.hcl' > /etc/consul.d/consul.hcl"
run "chown consul:consul /etc/consul.d/consul.hcl /opt/consul"
run "chmod 0640 /etc/consul.d/consul.hcl"
run "touch /etc/consul.d/consul.env && chown consul:consul /etc/consul.d/consul.env"

# ── 11. Redis conf edits (bind + requirepass) ────────────────────────────
log "→ /etc/redis/redis.conf edits"
if [[ ! -f /etc/redis/redis.conf.bootstrap-orig ]]; then
  run "cp -a /etc/redis/redis.conf /etc/redis/redis.conf.bootstrap-orig"
fi
# Restore from orig each run to keep the edits idempotent (avoids compound diff).
run "cp -a /etc/redis/redis.conf.bootstrap-orig /etc/redis/redis.conf"
# Bind + protected-mode always yes.
run "sed -i -E 's|^\\s*bind\\s.*|bind 127.0.0.1 ${PUBLIC_IP}|' /etc/redis/redis.conf"
run "sed -i -E 's|^\\s*protected-mode\\s.*|protected-mode yes|' /etc/redis/redis.conf"
# requirepass is set by restore.sh (from age-encrypted secrets); leave a marker.
if ! grep -qE '^\s*requirepass\s' /etc/redis/redis.conf; then
  run "echo '# requirepass will be set by restore.sh' >> /etc/redis/redis.conf"
fi

# ── 12. Systemd units — drop, mask (restore.sh unmasks after state is in) ──
log "→ /etc/systemd/system/hive-*.service (masked)"
for unit in minio hive-api hive-chrome hive-xvfb hive-replicator hive-ops-agent; do
  src="${TEMPLATES}/systemd/${unit}.service"
  [[ -f "$src" ]] || { log "  ${src} missing; skipping"; continue; }
  run "install -m 0644 '${src}' /etc/systemd/system/${unit}.service"
done
run "systemctl daemon-reload"
# Mask hive-* so nothing starts before restore.sh finishes.
for unit in hive-api hive-chrome hive-xvfb hive-replicator hive-ops-agent; do
  run "systemctl mask ${unit}.service 2>/dev/null || true"
done
# minio, redis, consul, postgres, caddy CAN start now — they have inert defaults
# without secrets. hive-* need /etc/hive/api.env and /etc/hive/replicator-key.json
# to be present (from restore.sh) before they'll do anything useful.

# ── 13. Egress tinyproxy for THIS box's public IP ───────────────────────
log "→ tinyproxy egress for ${PUBLIC_IP}"
if [[ -x "${VENDOR}/hive-browser-farm/deploy/gen-egress.sh" ]]; then
  run "${VENDOR}/hive-browser-farm/deploy/gen-egress.sh '${PUBLIC_IP}'"
else
  log "  WARNING: vendor gen-egress.sh missing; egress unit not created"
fi

# ── 14. Docker + oci-registry container ─────────────────────────────────
log "→ docker + oci-registry"
run "systemctl enable --now docker"
if ! docker ps --format '{{.Names}}' | grep -qw oci-registry; then
  # The registry uses S3 backend to local MinIO — restore.sh writes the
  # env file (/etc/hive/oci-registry.env) with MinIO creds. Bootstrap
  # only creates a stopped-on-error container definition.
  if [[ -f /etc/hive/oci-registry.env ]]; then
    run "docker run -d --restart=always --name oci-registry \
      --network host \
      --env-file /etc/hive/oci-registry.env \
      registry:2"
  else
    log "  /etc/hive/oci-registry.env not present yet — restore.sh will start the container"
  fi
fi

# ── 15. UFW rules ───────────────────────────────────────────────────────
log "→ ufw rules"
# Default deny incoming; allow SSH + HTTPS + HTTP unconditionally.
run "ufw --force reset >/dev/null"
run "ufw default deny incoming"
run "ufw default allow outgoing"
run "ufw allow 22/tcp"
run "ufw allow 80/tcp"
run "ufw allow 443/tcp"
run "ufw allow 443/udp"
# MinIO :9000 — allowlist only.
run "ufw allow from ${LAPTOP_IP} to any port 9000 proto tcp comment 'timothy_laptop_minio'"
run "ufw allow from ${GKE_NAT_IP} to any port 9000 proto tcp comment 'deployed_backend_nat'"
if [[ -n "$PEER_PUBLIC_IP" ]]; then
  run "ufw allow from ${PEER_PUBLIC_IP} to any port 9000 proto tcp comment 'peer_ovh_box_minio'"
fi
run "ufw --force enable"

# ── 16. SSH host keys — never reuse VA's ────────────────────────────────
log "→ SSH host keys (fresh; do NOT restore VA's)"
# Ubuntu generates on first boot; nothing to do unless keys are missing.
if [[ ! -f /etc/ssh/ssh_host_ed25519_key ]]; then
  run "ssh-keygen -A"
fi
# Record fingerprints for the manifest.
for k in /etc/ssh/ssh_host_*_key.pub; do
  ssh-keygen -lf "$k" 2>/dev/null | head -1
done > /tmp/hillsboro-ssh-hostkeys.txt || true

# ── 17. Enable services that can safely run without state ───────────────
log "→ enable inert services (minio/redis/postgres/caddy/consul — hive-* stay masked)"
# NOTE: minio + redis won't do anything useful until restore.sh writes their
# secrets, but running them exercises systemd wiring + surfaces install bugs.
run "systemctl enable --now postgresql"
run "systemctl enable --now consul"

echo
log "✓ bootstrap complete."
log "  next: run restore.sh --from gs://... --age-key /root/migration.age.key"
log "  ssh host key fingerprints (record these in the manifest):"
cat /tmp/hillsboro-ssh-hostkeys.txt 2>/dev/null || true
