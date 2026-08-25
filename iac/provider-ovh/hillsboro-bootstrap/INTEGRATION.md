# Hive browser-farm — integration guide

Everything a caller needs to talk to a running Hive browser-farm box.
Applies equally to Virginia (`api.vm.open-hive.com`) and Hillsboro
(`api.vm-west.open-hive.com`); the two boxes speak the same wire
contract with independent egress IPs.

Written for `hive-backend` engineers and operators. Consumer of this
doc **should not need to SSH into the box** — everything documented
here is reachable through the public HTTPS API.

## 1. Endpoints

Public HTTPS front door per box, terminated by Caddy on port 443:

| Region | Base URL |
|---|---|
| Virginia (`ns1008198`, 135.148.52.236) | `https://api.vm.open-hive.com` |
| Hillsboro (`ns1030854`, 40.160.130.116) | `https://api.vm-west.open-hive.com` |

Under each base:

| Prefix | Backing service | Bearer gate |
|---|---|---|
| `/farm/*` | `hive-api` on 127.0.0.1:8088 (Node `apid.ts`) — the browser-farm action API | `API_TOKEN` (inside `hive-api`) |
| `/console/*` | Same `hive-api` (embedded noVNC proxy) | own token, checked inside |
| `/ops/*` | `hive-ops-agent` on 127.0.0.1:5099 — read-only JSON observability | `OPS_TOKEN` (checked at Caddy) |
| everything else on `api.*` | 404 | — |

`vm.open-hive.com` + `*.vm.open-hive.com` (non-`api.`) block on both boxes
502s intentionally — that block was for the E2B client-proxy which is
not deployed on the browser-farm role. Callers should always use the
`api.` hostname.

## 2. Authentication

Two independent bearer tokens per box:

- **`API_TOKEN`** — proves you're allowed to hit `/farm/*` and
  `/console/*`. Lives on the box at `/etc/hive/api.env` (mode 0600,
  read by `hive-api.service` via `EnvironmentFile=`). Both regions
  currently share the same token (restored from VA into Hillsboro's
  archive replay). If a token rotation is required, do both boxes in
  the same commit or add a config flag on the caller side to try both.

- **`OPS_TOKEN`** — proves you're allowed to hit `/ops/*`. Lives at
  `/etc/default/hive-ops-caddy`, read by the Caddy systemd unit's
  `EnvironmentFile=` and referenced in the Caddyfile as `{env.OPS_TOKEN}`.
  Bearer check happens inside Caddy before the request ever reaches
  the ops-agent daemon.

Header format (both):
```
Authorization: Bearer <TOKEN>
```

**Missing / wrong token → HTTP 401** with either the ops-agent's plain
`"unauthorized"` (from Caddy's own gate) or `hive-api`'s in-band 401.

**CORS**: `/ops/*` sends `Access-Control-Allow-Origin: *` +
`Access-Control-Allow-Headers: Authorization, Content-Type` so
browser-based operator dashboards work. `/farm/*` does not — it's a
server-to-server surface.

## 3. `/farm/*` route reference

Contract version: `1` (compare against `contractVersion` in the
`/health` response — mismatch is a hard error, don't be lenient).

| Method | Path | Purpose |
|---|---|---|
| GET | `/farm/health` | Liveness + contract version. Returns `{ok:true, contractVersion:1}`. **Always use this** in health checks — do not use `/farm/v1/accounts` or anything that touches the account store. |
| GET | `/farm/v1/accounts` | List onboarded accounts. Returns `{accounts: [{accountId, health, egressIp}]}`. |
| POST | `/farm/v1/actions` | Execute a single action against one account. See §4. |
| POST | `/farm/v1/fanout` | Execute the same action against many accounts, spaced out humanly. See §5. |
| GET | `/farm/v1/admin/accounts` | Full account records including internal state. Admin-only surface. |
| GET | `/farm/v1/admin/threads?accountId=<id>` | Recent thread activity for one account. |
| GET | `/farm/v1/admin/attention` | Attention-needing items (e.g. login walls, verification prompts). |
| POST | `/farm/v1/admin/actions` | Bypass rate-limiting / breaker for one-off action runs. |
| GET | `/farm/v1/admin/audit` | Audit log of actions taken. |
| POST | `/farm/v1/admin/reverify` | Re-check a specific account's login state. |
| GET | `/farm/v1/admin/egress` | Egress IP pool + per-IP account counts. |
| POST | `/farm/v1/admin/onboard` | Onboard a NEW account (opens a login window). |
| POST | `/farm/v1/admin/onboard/adopt` | Adopt an already-logged-in browser profile. |
| WS | `/farm/v1/admin/console` | WebSocket to the onboarding console (uses `/console/*` under the hood). |

## 4. Executing an action — `POST /farm/v1/actions`

Body:
```json
{
  "contractVersion": 1,
  "accountId": "spike-2",
  "action": {
    "type": "linkedin.readInbox",
    "limit": 50
  }
}
```

`action` is a discriminated union — see `src/actions/contract.ts` in the
`hive-browser-farm` source for the full `ReadActionSchema` +
`WriteActionSchema`. Every action type has a `type: "provider.verb"` +
type-specific fields.

Response is `ActionResult` — a discriminated union too. Success payloads
carry the extracted data; failure payloads carry a machine-readable error
tag (`login_required`, `rate_limited`, `content_moderated`, etc.) plus a
free-text `message`.

**Writes are gated globally.** The `hive-api.service` sets
`ALLOW_WRITES=0` by default; any `WriteAction` (message, connect, react)
returns HTTP 403 unless the operator has explicitly opted-in on the box.
This is a deliberate protection against blast-radius bugs — a bug in a
caller can't accidentally spam LinkedIn from other people's accounts
until an operator makes writes the deliberate choice for that box.
Callers should treat `ALLOW_WRITES=0` errors as **operational
configuration**, not as programmer errors, and surface them plainly.

## 5. Fanout — `POST /farm/v1/fanout`

Same body shape as `/actions` but with `accountIds: [...]` in place of
`accountId`. The action is personalised per account via `{{account}}`
placeholder substitution in string fields (see `personalise()` in
`fanout.ts`), then executed with human-spaced gaps between accounts.

Response: `{entries: [{accountId, result, gapBeforeMs}]}`. Each entry
carries an `ActionResult` (same shape as `/actions`) plus the delay
before its execution began.

**Personalisation caveat:** identical *reactions* from many accounts
read as coordinated in a way that identical *reads* do not, so
`fanout()` swaps `{{account}}` inside strings — but real variation
(paraphrased message bodies, different reaction choices per account)
is the caller's job. Don't fanout a verbatim WriteAction across 100
accounts and expect it to look organic.

## 6. `/ops/*` observability routes

Read-only JSON. Bearer-gated by `OPS_TOKEN` at the Caddy layer, so the
daemon on 127.0.0.1:5099 is never internet-reachable directly.

Confirmed live routes (as of 2026-08-25):

| Method | Path | Returns |
|---|---|---|
| GET | `/ops/system` | CPU + memory + disk snapshot |
| GET | `/ops/nomad` | Nomad cluster status (empty on Hillsboro — Nomad not deployed) |
| GET | `/ops/firecracker` | Firecracker sandbox inventory (empty — orchestrator not deployed) |

Paths that 404 today but may be added later: `/ops/storage`, `/ops/e2b`,
`/ops/health`, `/ops/status`, `/ops/version`.

For hive-backend's health-monitoring, use `GET /farm/health` (not
`/ops/*`) — it's the contract-versioned liveness probe.

## 7. Region selection + egress semantics

Each box has one public IPv4 and one egress-tagged tinyproxy per
public IP it owns. Browser sessions bind their outgoing sockets to the
egress IP of the box they run on, so from an external observer's
perspective, an account is pinned to whichever region onboarded it.

| Region | Public IPv4 | Egress IP visible to remote services |
|---|---|---|
| Virginia | 135.148.52.236 | 135.148.52.236 |
| Hillsboro | 40.160.130.116 | 40.160.130.116 |

**Existing accounts stay pinned.** Every account currently onboarded is
tagged with the egress IP that saw it during onboarding — moving an
already-logged-in account to a different egress often breaks the session
(Meta / LinkedIn / X read this as impossible-fast-travel and quarantine
the account). `GET /farm/v1/accounts` returns `egressIp` per account; a
caller that wants to hit a specific account MUST route to the region
whose base URL matches that `egressIp`.

**New accounts pick a region.** `POST /farm/v1/admin/onboard` on
Hillsboro will result in an account with `egressIp=40.160.130.116`.
This is the intended way to diversify egress: onboard new accounts on
the new region until the balance is right.

**Suggested `hive-backend` shape**:
```typescript
const REGIONS = {
  va:   { base: "https://api.vm.open-hive.com",      egressIp: "135.148.52.236" },
  west: { base: "https://api.vm-west.open-hive.com", egressIp: "40.160.130.116" },
};

// When routing a request for a specific account:
async function routeForAccount(accountId: string) {
  const accounts = await listAccountsFromAllRegions();
  const acct = accounts.find(a => a.accountId === accountId);
  if (!acct) throw new Error(`account ${accountId} not found in any region`);
  const region = Object.values(REGIONS).find(r => r.egressIp === acct.egressIp);
  if (!region) throw new Error(`no known region owns egress ${acct.egressIp}`);
  return region.base;
}

// When onboarding a new account:
async function pickOnboardRegion() {
  // Hash the caller identity, sample a policy, or read a config flag.
  // Simplest: 50/50 random with existing counts. Or use /farm/v1/admin/egress
  // to see how loaded each IP is and pick the lighter one.
}
```

## 8. Firewall + IP allowlisting

The boxes accept public traffic **only on 22 (SSH), 80/443 (Caddy)**.
Everything else — MinIO :9000 in particular — is IP-allowlisted at the
UFW layer.

Current MinIO allowlist on each box:

- Timothy's laptop (`136.24.157.169`)
- GKE hive-backend NAT (`35.188.101.104`)
- The peer box (each region allows the other's public IP)

**If `hive-backend`'s outbound IP changes**, MinIO reads will start
timing out. Update UFW on both boxes:
```
sudo ufw allow from <NEW_NAT_IP> to any port 9000 proto tcp comment 'deployed_backend_nat'
sudo ufw delete allow from <OLD_NAT_IP> to any port 9000 proto tcp
```

`hive-backend` itself doesn't touch MinIO directly today (only the box's
own `hive-replicator` writes to GCS + local MinIO). The allowlist exists
because the design anticipates hive-backend reading userdata blobs from
the per-team hive-userdata bucket in the future.

## 9. Chrome CDP is internal-only

`hive-chrome.service` runs headless Chrome with
`--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222`.
Not exposed via Caddy, not in UFW's allowlist. Callers **must not**
poke at Chrome directly — the `hive-api` layer wraps CDP with
rate-limiting, breaker, audit, and per-account context isolation.

If a caller thinks it needs direct CDP: the answer is a new action type
in `WriteActionSchema` / `ReadActionSchema`, not tunnelling around the API.

## 10. Onboarding console (`/console/*`)

Human-in-the-loop UI for solving login walls. When
`/farm/v1/admin/onboard` returns a `consoleUrl`, opening it in a browser
gets the operator a noVNC session into a real Chrome window running as
the account, so they can complete SSO / OTP / captchas that the
automation can't. The console proxy authenticates with a short-lived
token embedded in the URL — don't share console URLs.

## 11. TLS + DNS

TLS is a Let's Encrypt wildcard per region, auto-renewed by certbot's
daily timer via the `/usr/local/bin/le-{auth,cleanup}.sh` GoDaddy
DNS-01 hooks. Renewal fires when `< 30 days` from expiry. If a caller
sees a cert-expired error, the hook is broken — check `journalctl -u
certbot.service` on the box.

DNS records live in GoDaddy under `open-hive.com`. Both `vm.` and
`vm-west.` variants exist plus their `api.` and wildcard forms. TTL is
600s (GoDaddy's floor); DNS-flip rollbacks propagate within 10 min.

## 12. Common failure modes

| Symptom | Likely cause | Where to look |
|---|---|---|
| `HTTP 401 unauthorized` on `/ops/*` | wrong `OPS_TOKEN` header | `/etc/default/hive-ops-caddy` on the box |
| `HTTP 401` on `/farm/*` (no body) | wrong `API_TOKEN` | `/etc/hive/api.env` on the box |
| `HTTP 502` on `api.<region>.open-hive.com` root path | hitting `vm.` block which points at un-deployed client-proxy | expected; use `api.` subdomain |
| `HTTP 200 {"ok":true}` from `/farm/health` but writes fail with 403 | `ALLOW_WRITES=0` | operator must set `Environment=ALLOW_WRITES=1` in a systemd drop-in and reload |
| Cert-expired browser error | certbot daily timer failed, or hook script broken | `sudo certbot renew --dry-run` on the box |
| `curl` from GKE to `:9000` (MinIO) times out | UFW allowlist doesn't include GKE NAT IP | `sudo ufw status` on the box |
| Existing account suddenly rate-limited / logged-out after routing change | account moved to a different region → different egress → platform quarantined | never route an account to a region whose `egressIp` doesn't match `GET /farm/v1/accounts[].egressIp` |

## 13. Observability minimum for `hive-backend`

Alerting the caller should have wired up per region:

1. `GET /farm/health` every 30 s — page on 3 consecutive non-200s.
2. TLS cert expiry — page 14 days before `notAfter`.
3. `GET /ops/system` every 5 min — record CPU / mem / disk for
   dashboards; page on disk > 90 % (browser profiles + Chrome caches
   can grow unbounded).
4. Egress balance — `GET /farm/v1/admin/egress` every hour; alert if
   the difference between region counts exceeds ± 20 % of total.

## 14. Rollback / degraded operation

If Hillsboro breaks, `hive-backend`'s `REGIONS` config gets rolled
back to `[va]` — no DNS change needed. Accounts pinned to Hillsboro
become temporarily unavailable (they can't move without re-onboarding),
but Virginia-onboarded accounts keep serving. This is the whole point
of the additive migration design.

If Virginia breaks, same drill in reverse. Virginia-onboarded accounts
become temporarily unavailable; Hillsboro-onboarded ones keep serving.

For a full-box loss (hardware failure), the cold GCS archive at
`gs://hive-vm-migration-2026-08/ns1008198/2026-08-24T16-39Z/` +
`iac/provider-ovh/hillsboro-bootstrap/{bootstrap,restore}.sh` will
reconstitute a box within ~2 hours on a fresh OVH order.

## 15. Contact

- Runbook + provisioning scripts: [`iac/provider-ovh/hillsboro-bootstrap/`](.)
- Migration plan: `/home/timothy/.claude/plans/you-need-to-make-snuggly-pudding.md`
- browser-farm source (private): `/opt/hive-browser-farm/` on the box, vendored copy at `vendor/hive-browser-farm/`
- Operator: `dev@acho.io`
