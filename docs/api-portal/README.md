# Hive VM control API portal

Interactive documentation and operations dashboard for the
`/v1/workspace/*` API surface that hive-backend exposes to the hive
desktop. Lets a teammate explore the API, fire requests against staging
with one click, and run common operational scripts from a single place.

## What's in here

| File | Purpose |
|---|---|
| `index.html` | Landing — architecture overview, glossary, "where things live" table |
| `dashboard.html` | Live VM dashboard. Paste a JWT, see your team's VM status, start/pause/destroy + pin/unpin colonies |
| `api.html` | Interactive API reference (Scalar) — "Try it" panel hits staging directly |
| `cli.html` | CLI cheatsheet — roll-template, parity-test, mint-stream-token, postgres pokes, runbooks |
| `openapi.yaml` | OpenAPI 3.1 source of truth — also drives `api.html` |
| `assets/styles.css` | Shared styles. Dark theme; emerald/amber/destructive matches the desktop |
| `assets/dashboard.js` | Vanilla JS for `dashboard.html`. No build, no deps |

## Open it locally

```bash
./serve.sh
```

That's it. `serve.sh` runs a static HTTP server (python3 by default, npx
serve as fallback) on `http://localhost:8765/` and auto-opens it in your
browser. Override the port with `./serve.sh 9000` or `PORT=9000 ./serve.sh`,
skip the browser launch with `--no-open`.

If you want to skip the script and just point at the files:

```bash
xdg-open /home/timothy/aden/infra/docs/api-portal/index.html
```

The dashboard's `fetch()` calls to staging work either way — hive-backend's
`CORS_ALLOWED_ORIGINS` covers both `file://` and `http://localhost:*`.

## CORS — point the backend at the portal

The dashboard's `fetch()` calls are blocked by CORS preflight unless
hive-backend's `CORS_ALLOWED_ORIGINS` includes the portal's origin.

**Local hive-backend (npm run dev):** edit `hive-backend/.env`:
```
CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3333,http://localhost:8765,http://127.0.0.1:8765
```
…and restart `npm run dev` so dotenv picks up the change. (I've already
added the portal entries; reuse them.)

**Staging hive-backend (k8s):** update the same key in
`hive-secrets` and rollout-restart the deployment:
```bash
kubectl -n staging edit secret hive-secrets
# add :8765 to CORS_ALLOWED_ORIGINS (it's a comma-separated list)
kubectl -n staging rollout restart deploy/hive-app
```

If you change `serve.sh`'s default port, mirror the change in both
places. The error you'll see in DevTools network tab if you forget:
`No 'Access-Control-Allow-Origin' header is present on the requested
resource.` — that's the only failure mode here; auth issues surface as
401, not CORS.

## Get a JWT

The portal's dashboard + the API reference's "Try it" panel both need a
user session JWT. Two ways:

1. **From the desktop app** — sign in, open DevTools (`Ctrl+Shift+I`),
   Application → Local Storage → look for `hive_jwt`.
2. **Via the API** —
   ```bash
   curl -sX POST https://app-staging.open-hive.com/v1/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"you@team","password":"..."}' | jq -r .token
   ```

Paste it into the JWT field on `dashboard.html` (saved to
`localStorage`, click **Forget** to wipe) or into the
`bearerAuth` field in Scalar's auth panel on `api.html`.

## Share with a teammate

Two options depending on how locked-down the portal needs to be:

- **Copy the dir to a static host.** The portal is fully static — drop
  it into S3 / GCS / GitHub Pages and share the URL. Token + base URL
  are entered in-browser; nothing is baked into the files.
- **Run a quick HTTP server** as above and tunnel it
  (`cloudflared tunnel`, `ngrok`, `tailscale serve`) so the teammate
  hits your local instance.

The OpenAPI YAML is editable — if the API surface grows, update
`openapi.yaml` and `api.html` reflects it on next page load (no
rebuild).

## Keep it in sync

The OpenAPI spec is intentionally hand-written and concise — it
documents *the API as the desktop uses it*, not every error path the
controller can emit. When you add/change an endpoint, update:

1. `openapi.yaml` — paths + schemas
2. `cli.html` — only if a new script lands
3. `assets/dashboard.js` — only if a new endpoint deserves a button on
   the dashboard

The hand-written CLI page intentionally mirrors what's actually in
`infra/scripts/` and `infra/sandbox-images/hive-novnc/`. If you add a
new operational script, add a card to `cli.html`.
