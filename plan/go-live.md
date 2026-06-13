# Bringing the Hive workspace VM stack online

Captured ~2026-04-25 while waiting for DNS to propagate. Status: **DNS records pending**, all other prerequisites in place.

## Architecture (two clusters, two domains)

```
                  ┌─────────────────────────────────────────────┐
                  │  GCP / GKE  (deployed by Richard's CD pipe) │
   sign in,       │  ─────────────────────────────────────────  │
   workspace ───▶ │  hive-app  →  app.open-hive.com             │
   lifecycle     │  hive-llm  →  /v1/messages                  │
                  └────────────────────────┬────────────────────┘
                                           │ POST /sandboxes etc.
                                           │ (e2b API key auth)
                                           ▼
                  ┌─────────────────────────────────────────────┐
                  │  OVH bare-metal 135.148.52.236              │
   user's noVNC   │  ─────────────────────────────────────────  │
   webview ──────▶│  Caddy → vm.open-hive.com (this plan)       │
                  │       → api.vm.open-hive.com (e2b API)      │
                  │  Nomad: orchestrator, template-mgr,         │
                  │         client-proxy, MinIO, registry:2     │
                  │  pg, redis (host-local)                     │
                  └─────────────────────────────────────────────┘
```

**hive-backend (the SaaS control plane) lives on GCP, not OVH.** Richard's
[`.github/workflows/cd.yml`](../../hive-backend/.github/workflows/cd.yml) deploys
the JS API and Rust LLM proxy as containers to GKE behind GKE-managed
certs at `app.open-hive.com`. (A `staging` environment also exists at
`app-staging.open-hive.com` — gated behind `workflow_dispatch`. We
target `app.open-hive.com` from the desktop.) **OVH only runs the
Firecracker compute** — orchestrator, template-manager, client-proxy,
MinIO, pg, redis, the e2b OCI registry. The two clusters talk over the
public internet via the hive-service e2b API key.

## Outcome

Hive desktop users sign in to `app.open-hive.com`, click "Workspace",
land in a TLS noVNC view of their persistent Firecracker VM hosted on
OVH. URL shapes the desktop sees:

```
Auth + workspace lifecycle:
  https://app.open-hive.com/user/login-v2
  https://app.open-hive.com/v1/workspace/{start,heartbeat,pause,...}

Embedded compute (returned in /v1/workspace/start response):
  https://6080-<sandboxId>.vm.open-hive.com/vnc.html?...   ← noVNC
  https://8787-<sandboxId>.vm.open-hive.com/               ← Hive API
```

## Step-by-step (each step independently verifiable)

### 1. DNS records — _user, in flight_

At GoDaddy (`open-hive.com` → `domaincontrol.com` nameservers):

```
Type   Name    Value             TTL
A      vm      135.148.52.236    600
A      *.vm    135.148.52.236    600
A      api.vm  135.148.52.236    600
```

(`api.vm.open-hive.com` is for the e2b control-plane HTTP API — separate
hostname so it can be locked down by hive-backend's IP allowlist later
if/when we want to.)

`app.open-hive.com` (and `app-staging.open-hive.com`) are managed by
Richard's GKE deployment — already wired, separate from this plan.

**Verify:** `dig +short A vm.open-hive.com '*.vm.open-hive.com' api.vm.open-hive.com` → all return `135.148.52.236`.

### 2. Cert (one-time, manual DNS-01)

On the OVH host:

```bash
sudo apt-get install -y certbot
sudo certbot certonly --manual --preferred-challenges dns \
  --email ops@acho.io --agree-tos \
  -d 'vm.open-hive.com' -d '*.vm.open-hive.com' -d 'api.vm.open-hive.com'
```

Certbot prints a TXT record value. Add at GoDaddy:

```
TXT  _acme-challenge.vm   <value certbot prints>   600
```

Wait for propagation (`dig TXT _acme-challenge.vm.open-hive.com`), hit Enter in certbot. Cert lands at `/etc/letsencrypt/live/vm.open-hive.com/{fullchain.pem,privkey.pem}`.

**Renewal:** 90-day clock. Manual rerun for now; followups list automation paths.

### 3. Caddy — TLS terminator + reverse proxy on OVH

Two routes: workspace traffic (host-header routed by client-proxy) on
`vm.open-hive.com` and `*.vm.open-hive.com`, and the e2b control-plane
API on `api.vm.open-hive.com`.

```bash
sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddyfile
# Workspace traffic — Caddy terminates TLS, client-proxy does host-header
# routing across orchestrator-proxies (today: only host-1 on :5007).
vm.open-hive.com, *.vm.open-hive.com {
    tls /etc/letsencrypt/live/vm.open-hive.com/fullchain.pem /etc/letsencrypt/live/vm.open-hive.com/privkey.pem
    encode gzip
    reverse_proxy 127.0.0.1:5006 {
        transport http {
            keepalive 60s
        }
    }
}

# e2b control-plane API — the orchestrator's REST surface on :3000.
# hive-backend (on GKE) hits this via the hive-service team API key.
api.vm.open-hive.com {
    tls /etc/letsencrypt/live/vm.open-hive.com/fullchain.pem /etc/letsencrypt/live/vm.open-hive.com/privkey.pem
    encode gzip
    reverse_proxy 127.0.0.1:3000
}

# Plain HTTP → HTTPS for the apex.
:80 {
    redir https://{host}{uri}
}
```

```bash
sudo systemctl enable --now caddy
sudo systemctl reload caddy   # after Caddyfile edits
```

**Verify:**
```bash
curl -sI https://api.vm.open-hive.com/health -m 5
# expect 200 (orchestrator's /health)
curl -sI -H 'X-API-Key: <hive-service-key>' \
  -X POST -H 'Content-Type: application/json' \
  -d '{"templateID":"5d2b2c65-25cc-4179-9057-a49e87a8c521","timeout":60}' \
  https://api.vm.open-hive.com/sandboxes -m 15
# expect 200/201 with sandbox JSON
curl -sI 'https://6080-foo.vm.open-hive.com/' -m 5
# expect 4xx from client-proxy (foo isn't a sandbox) — confirms TLS + routing
```

### 4. UFW lockdown

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'ssh'
sudo ufw allow 80/tcp comment 'caddy http'
sudo ufw allow 443/tcp comment 'caddy https'
# Everything else (Consul/Nomad/MinIO/Redis/Postgres/registry/orchestrator/
# client-proxy plain http) becomes invisible from the public internet.
sudo ufw enable
```

**MUST FOLLOW WITH:** allow per-veth ingress so the embedded NFS proxy
(used by native persistent volumes) actually receives the rewritten
packets. The orchestrator does iptables `PREROUTING REDIRECT` from each
VM's 192.0.2.1:2049 to the host's `:5011` — the redirect leaves the
packet on the `veth+` interface, where it hits the INPUT chain. With
UFW's default DROP policy on INPUT, that packet is silently dropped and
NFS mount inside the VM hangs.

```bash
# Persist in /etc/ufw/before.rules so it survives reboot. Insert
# inside the filter table, after the ufw-before-input chain definition:
sudo sed -i '/^-A ufw-before-input -i lo -j ACCEPT$/a -A ufw-before-input -i veth+ -j ACCEPT  # hive: per-veth ingress for embedded NFS proxy (REDIRECT to :5011)' /etc/ufw/before.rules
# Also apply at runtime so we don't have to `ufw reload`:
sudo iptables -I INPUT 1 -i veth+ -j ACCEPT
```

**AND:** disable reverse-path filtering globally + per-veth. The kernel's
RPF default ("strict" / value `1`) drops the NFS proxy's reply packets
because they leave on a different interface than they arrived on.

```bash
sudo tee /etc/sysctl.d/99-hive-nfsproxy.conf <<'EOF'
# Hive native persistent volumes — embedded NFS proxy reply path lives
# on a different interface than the incoming request, so strict RPF
# drops legitimate traffic. Loose mode (2) is enough, but we use 0 for
# defense-in-depth since the host has no exposed RPF-relevant route.
net.ipv4.conf.all.rp_filter = 0
net.ipv4.conf.default.rp_filter = 0
EOF
sudo sysctl --system
# Existing veths aren't covered by `all` / `default` after they're
# created — sweep them in one go:
for f in /proc/sys/net/ipv4/conf/veth*/rp_filter; do echo 0 | sudo tee "$f" >/dev/null; done
```

**AND:** install a daily sweeper to expire the per-team volume soft-delete
trash. The orchestrator's `DeleteVolume` RPC renames `<root>/team-<uuid>/vol-<uuid>`
into `<root>/.trash/<unix-ts>-vol-<uuid>` instead of `RemoveAll`'ing,
to give us a 30-day recovery window for accidental wipes. Without a
sweeper the trash grows forever.

```bash
sudo tee /etc/cron.daily/hive-volume-trash-sweep <<'EOF'
#!/bin/sh
# Reap volume soft-deletes older than 30 days. The 30-day window
# matches the user-facing language in the desktop app ("your storage
# will be kept"); change both together if you change either.
# Path mirrors PERSISTENT_VOLUME_MOUNTS=hivedata:/srv/hivedata in the
# orchestrator nomad job.
find /srv/hivedata/.trash -mindepth 1 -maxdepth 1 -mtime +30 -exec rm -rf {} +
EOF
sudo chmod +x /etc/cron.daily/hive-volume-trash-sweep
```

**Test from outside:** `nc -vz 135.148.52.236 8500` (Consul), `:9000` (MinIO), `:5432` (Postgres), `:6379` (Redis), `:3000` (orchestrator) — all should be filtered. Only `:80`, `:443`, `:22` open.

**Test from inside a VM** (after these are applied):
```bash
# In a freshly-spawned sandbox netns
findmnt /root/.hive   # must show: nfs from 192.0.2.1:/hivedata
touch /root/.hive/post-cutover-probe
# On orch host: file appears immediately under /srv/hivedata/team-*/vol-*/post-cutover-probe
```

### 5. client-proxy embed-token verification (Go code)

The `?access_token=…` JWT is already minted by hive-backend (HS256, signed with `E2B_EMBED_TOKEN_SECRET`, claims `sub`, `teamId`, `sandboxId`, `kind="hive-workspace-embed"`, `exp`). client-proxy currently routes by host-header without checking it.

**Change:** middleware in `packages/client-proxy/internal/proxy/proxy.go` (or sibling) that runs BEFORE `parseHost`:

1. Read `?access_token=` query param (also `?token=` for the websockify path).
2. `jwt.Parse` with `HS256` and the `EMBED_TOKEN_SECRET` from env.
3. Verify `exp` is in the future, `kind == "hive-workspace-embed"`, `sandboxId` matches the leftmost label of the Host header (`<port>-<sandboxId>...`).
4. On any failure: 401 with a tiny HTML page (so the noVNC webview surfaces something readable).

Wire `EMBED_TOKEN_SECRET` into `iac/provider-ovh/nomad/client-proxy.hcl` as a Nomad variable. Same secret on the hive-backend side — stored in GCP Secret Manager and synced into the `staging` k8s namespace by Richard's `scripts/sync-secrets-to-k8s.sh` (see step 6).

Rebuild + redeploy:

```bash
ssh ubuntu@135.148.52.236 "cd /home/ubuntu/infra/packages/client-proxy && go build -o bin/client-proxy ."
NOMAD_TOKEN=... nomad job restart -on-error reject client-proxy
```

**Verify:** an embed URL with no `access_token` → 401. With a valid token → 200. With an expired token → 401.

### 6. hive-backend env on GCP

hive-backend itself is already deploying to GKE on every push to `main`
via `.github/workflows/cd.yml`. The change here is **secrets and env
vars in GCP Secret Manager** so the running pods talk to the right
e2b backend.

Set these in GCP Secret Manager (or whatever the existing pipeline
expects — confirm with Richard):

| Secret name | Value |
|---|---|
| `E2B_API_BASE_URL` | `https://api.vm.open-hive.com` |
| `E2B_API_KEY` | `e2b_0ac4829dce6392b2502e18209c75d77d6000ec98` (the hive-service team key from `infra/.ovh-secrets/hive-service.env`) |
| `E2B_PROXY_SCHEME` | `https` |
| `E2B_PROXY_HOST_SUFFIX` | `vm.open-hive.com` |
| `E2B_DEFAULT_TEMPLATE_ID` | `5d2b2c65-25cc-4179-9057-a49e87a8c521` |
| `E2B_EMBED_TOKEN_SECRET` | new HS256 secret (generate; **must match** the value wired into client-proxy at step 5) |
| `E2B_EMBED_TOKEN_TTL_SEC` | `600` |
| `E2B_DEFAULT_VCPU` | `2` |
| `E2B_DEFAULT_RAM_MB` | `2560` |
| `E2B_DEFAULT_TIMEOUT_SEC` | `3600` |
| `E2B_IDLE_PAUSE_SEC` | `300` |

Then trigger a deploy. Push to `main` is auto-staging; promote to prod
via `workflow_dispatch`:
```bash
# auto: push to main → deploys to staging
# manual:
gh workflow run cd.yml -f environment=staging
gh workflow run cd.yml -f environment=production
```

**Verify:**
```bash
curl -sI https://app.open-hive.com/health
# expect 200
# log in via the desktop, click Workspace,
# verify embed.novnc.loadUrl starts with https://6080-...vm.open-hive.com
```

### 7. Desktop builds

The desktop now defaults to `https://app.open-hive.com` (set in
[`hive-desktop/src/main/cloud.ts:27`](../../hive-desktop/src/main/cloud.ts)).
For most builds you don't have to do anything; for staging dogfooding,
override at launch with `HIVE_CLOUD_API_BASE=https://app-staging.open-hive.com`.

```bash
cd /home/timothy/aden/hive-desktop
npm run build
npx electron-builder --mac dmg --win nsis --linux AppImage
```

Unsigned for first beta — testers right-click → Open (mac) or "Run anyway" via SmartScreen (Windows). Ship via S3, GitHub release, or attached to a Linear / Slack message.

### 8. Smoke test from a clean machine

1. Install the dmg on a Mac that hasn't been used for dev.
2. Launch — should hit `app.open-hive.com`'s AuthScreen.
3. Sign in with a real Hive account (the hive prod pg behind the GKE deploy already has the row).
4. Click **Workspace**.
5. Expect: 5-10s spinner → noVNC view of Chromium running in OVH.
6. Pause / Resume / Destroy round-trip cleanly.
7. Heartbeat continues every 30s (visible in GKE pod logs); idle-pause kicks in if you walk away for 5 min.

## Followups (not blocking go-live)

| | priority | notes |
|---|---|---|
| Cert auto-renewal | high (90-day clock) | Either delegate `vm.open-hive.com` to Cloudflare/OVH-DNS for free Caddy DNS-01, or pay GoDaddy API tier. Until then, set a calendar reminder for day 75. |
| Sandbox egress policy | high | `ALLOW_SANDBOX_INTERNET=true` today. Strangers can crypto-mine. Add a domain blocklist or an egress proxy with allowlist before opening to public sign-ups. |
| GKE → OVH allowlist | medium | Right now `api.vm.open-hive.com` is reachable from anywhere. Tighten to GKE NAT IPs once the pipeline is stable. |
| Per-team e2b isolation | medium | Currently one shared service team owns every workspace. Add an admin `POST /admin/teams` endpoint to e2b's API for lazy provisioning, then `accountVmService.getOrStart` looks up the per-hive-team key first. |
| Multi-host OVH | medium | Already coded for it. Order a 2nd bare-metal once concurrent users justify it. Adding host-2 is "cloud-init joins Nomad cluster" — no code or HCL changes required. |
| Observability | medium | OTEL_SDK_DISABLED=true on OVH. Stand up Loki/Tempo/Mimir. GKE side has GCP Cloud Logging by default. |
| Backups | medium | MinIO replication, pg dumps from OVH host-local pg, Nomad raft snapshots. |
| Auto-update for desktop | low | electron-updater + a release feed. |
| Code-signed desktop | low | Apple Developer cert + EV Windows cert. The unsigned-with-instructions path works for private beta. |

## Quick refs

- **OVH IP:** `135.148.52.236`
- **OVH domains** (this plan): `vm.open-hive.com` (workspace traffic), `*.vm.open-hive.com` (sandbox subdomain routing), `api.vm.open-hive.com` (e2b API)
- **GKE domains** (Richard's pipeline): `app.open-hive.com` (production, what desktop targets), `app-staging.open-hive.com` (staging, behind workflow_dispatch)
- **e2b service-team API key:** `infra/.ovh-secrets/hive-service.env`
- **Embed-token secret** (must match between hive-backend on GKE and client-proxy on OVH): generate fresh, store in GCP Secret Manager **and** OVH Nomad variable `nomad/jobs/client-proxy`
- **GoDaddy DNS UI:** https://dcc.godaddy.com/domains
- **CD pipeline:** `.github/workflows/cd.yml` in hive-backend (Richard Tang, commits `d696971` + `fe3f98c`)
