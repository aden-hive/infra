# hive-browser-farm

Hosted LinkedIn profile/browser fleet. Profiles are persistent, browsers are
disposable, machines are an implementation detail.

Design: [`aden-hive/infra` → `plan/browser-farm.md`](../infra/plan/browser-farm.md).
Section references below point there.

## Status

**Phase 0 passed 2026-08-19.** A live LinkedIn session survived 5/5 ephemeral
context round trips, cookies alone (no IndexedDB). Measured: `T` 6.7s, Chrome
CPU 8.3s/check, blob ~102 KB. **Phase 1 durability done**, verified against the
real bucket. **Phase 2 detection loop RUN against a live LinkedIn account**
2026-08-21 — 4 real checks, correct cadence, correct event semantics. 76 tests.
The OVH teardown has not started.

Running it live found three bugs that unit tests could not have:

1. **A static unread count kept an account warm forever.** `event = unread > 0`
   meant an inbox nobody clears read as eventful on every check, pinning the
   account to the 60s tier permanently — ten times the load, indefinitely. An
   event is now a *new* message, measured against `meta.lastUnread`.
2. **Adding a required schema field bricked every stored profile.** The sweeper
   refused to start because existing blobs predated `lastUnread`. New optional
   state is now added with `.default(null)`; a profile that will not parse is an
   account that needs a human to log in again.
3. **`gen-egress.sh` produced silently broken proxies.** tinyproxy starts happily
   with a `Bind` address the host does not own, then fails every connection —
   healthy in `systemctl`, working for nothing. It now preflights the address.

| Built | Verified |
|---|---|
| `src/scheduler/decay.ts` — polling cadence (§3) | 8 unit tests |
| `src/profile/schema.ts` — profile blob + state hash (§5) | typecheck |
| `src/profile/slim.ts` — cookie/localStorage extract + hydrate (§5) | smoke |
| `src/browser/context.ts` — CDP lease, per-context proxy, verified disposal (§4) | smoke |
| `src/linkedin/classify.ts` — lease outcome + unread signal (§4) | 6 unit tests |
| `src/profile/capture.ts` — read account state out of a live page (§4 step 7) | typecheck |
| `spike/console.sh` — noVNC onboarding console (§10 `onboard` lease) | running on GCE |
| `spike/migrate.ts` — Phase 0 harness: `capture` / `restore` / `cycle` | passed 5/5 |
| `src/store/local-store.ts` — atomic, immutable-key profile store (§5) | 7 unit tests |
| `src/store/replicator.ts` — durable backlog → object storage (§9) | 6 unit tests + live GCS |
| `src/store/gcs-uploader.ts` — GCS binding, create-only | live GCS |
| `src/bin/replicator.ts` + `deploy/hive-replicator.service` | smoke |
| `src/scheduler/breaker.ts` — challenge-rate circuit breaker (§9) | 8 unit tests |
| `src/scheduler/ramp.ts` — boot ramp (§9) | 4 unit tests |
| `src/scheduler/queue.ts` — due queue + profile lock (§3) | 6 unit tests |
| `src/scheduler/loop.ts` — the detection sweep (§4) | 10 unit tests |
| `src/browser/egress.ts` — IP→proxy pool (§6) | 5 unit tests |
| `src/browser/check.ts` — one lease, start to finish | typecheck |
| `src/bin/sweeper.ts` — sweep daemon | smoke |
| `src/onboard/lifecycle.ts` — onboarding + remediation (§10) | 9 unit tests |
| `src/bin/onboard.ts` + `deploy/onboard-console.sh` | smoke |
| `src/actions/contract.ts` — versioned action contract (§8) | 4 unit tests |
| `src/actions/executor.ts` — action lease, shared lock, write gate | 8 unit tests |
| `src/actions/handlers.ts` — the one real handler registry | live |
| `src/actions/ratelimit.ts` — per-account caps, persisted | 7 unit tests |
| `src/linkedin/connect.ts` — invitations, ported from `hive.linkedin-connect` | 5 unit tests |
| `src/server/api.ts` — the cluster boundary (§8) | 10 unit tests + live |
| `src/server/console-control.ts` — single-slot noVNC repair console | 6 unit tests |
| `src/server/console-proxy.ts` — token-gated noVNC reverse proxy | 6 unit tests + live |
| `src/server/outbox.ts` — durable event queue to the control plane | 7 unit tests |
| `src/bin/apid.ts` + `deploy/hive-api.service` | live |
| `src/linkedin/threads.ts` — list, open, read, send | 2 unit tests + live |
| `src/linkedin/reactions.ts` — react to a post, six types | 7 unit tests |

`list_threads` and `read_thread` are verified against a live account.
`send_message` is implemented but **has never been fired** — see below.

## The cluster boundary

```bash
API_TOKEN=… ALLOW_WRITES=0 ADMIN_SURFACE=1 npm run apid
```

Binds to loopback; Caddy terminates TLS in front. Endpoints are coarse by
construction — **there is no route that proxies CDP**, and adding one ends the
two-cluster design: it becomes the default path, puts 10-30 WAN round trips
inside every agent turn, and re-couples GKE to LinkedIn's DOM.

`POST /v1/actions` takes an `idempotencyKey`. Over a WAN a client that times out
cannot tell a lost request from a lost response, and a naive retry of
`send_message` sends it twice, to a real person. A repeated key replays the
first outcome; concurrent retries collapse to one execution. Only successes are
cached — caching a failure would pin a network blip for the whole window.

Status codes carry the retry policy: `409` refused (will refuse again), `502`
failed (may not), `400` malformed.

## Admin surface

`ADMIN_SURFACE=1` adds `/v1/admin/accounts`, `/attention` and `/console`, plus a
token-gated noVNC proxy at `/console/<token>/`. The dashboard reaches these
through hive-backend's `/v1/admin/browser-farm/*`, which injects the farm token
server-side — mirroring the existing `/v1/admin/vm-ops` proxy. It is an explicit
allow-list: the same upstream can send messages as a real account, and that must
never be reachable from a dashboard session.

Only one console runs at a time. The script binds fixed ports, so starting a
second silently kills the first, discarding a verification an operator may be
halfway through — a conflict is a 409 naming the holder, not a silent swap.
Sessions expire, so a link left in a chat log dies on its own.

## Events

The sweep emits `unread_changed` / `account_quarantined` into a **durable
outbox** — files on disk, ordered by timestamp. §8's partition table says inbox
updates queue on OVH and flush on reconnect, and that only works if the queue
survives the process. Delivery is at-least-once: a duplicated notification is
noise, a dropped one is a customer message nobody sees. A failing sink can never
cost a check.

Not built: the control-plane ingest endpoint that receives these, and the inbox
store behind it. Note `services/inbox` in hive-backend already means the *agent*
inbox (`blocker`/`heartbeat`/`progress`), so this needs a different name. The OVH teardown (§13) is not started — it needs
the sandbox-hosting decision first.

## Actions

```bash
ACTION='{"type":"list_threads","limit":5}' npm run action
ALLOW_WRITES=1 ACTION='{"type":"react_to_post","postUrl":"…"}' npm run action
```

**Everything routes through `ActionExecutor`.** `src/actions/handlers.ts` is the
single definition of what each action does; handlers contain no locking, session
verification or persistence, because the executor owns all of it and a handler
receives a page whose session has just been verified.

This was not true at first, and the gap is worth recording: handlers lived
inline in one-off scripts, and the scripts that actually sent a message and
applied a reaction called the DOM helpers directly — skipping the breaker, the
health check and the write gate. A safety layer nothing routes through is
decoration. Verified since: a read succeeds, `send_message` and `react_to_post`
are both refused with the gate closed, and a gated-open reaction reports
`alreadyReacted` rather than toggling off.

The contract is the boundary between the two clusters, so it is coarse-grained
by construction: one action is one or two WAN round trips, and LinkedIn DOM
churn stays on the browser side. **Do not add an escape hatch that proxies raw
CDP across the WAN** — it becomes the default path and the split stops working.

**Writes are off by default.** Reads and writes are separate types, not a naming
convention, so a new action cannot default to being treated as safe. A sent
message is not recoverable and the blast radius of an agent bug is other
people's inboxes. Verified live: a `send_message` against a read-only executor
is refused.

**`send_message` takes exactly one of `correspondent` or `profileUrl`.** Both
are needed and neither suffices: a correspondent name only finds someone already
in the conversation list, which renders about ten rows before virtualising, so
most contacts are not addressable that way. A profile URL opens a composer
whether or not a thread exists — the only route to a first message.

**Actions share the detection lock.** The action path just holds it longer, and
is not preemptible — abandoning an agent mid-reply leaves half a message in a
real conversation.

**`refused` and `failed` are distinct.** A refusal will refuse again; a failure
may be transient. Collapsing them would invite retrying a refusal in a loop
against an unhealthy account.

### Reading is not free of effect

Opening a conversation marks it read and sends a **read receipt** to the other
party, and LinkedIn has no preview-without-opening. So `read_thread` is not
purely observational: an agent that reads every unread thread is visibly
"seen"-ing all of them. That is a product decision, not just a technical one.

### `send_message` — sent and verified 2026-08-21

One message delivered end to end and confirmed by reading the thread back:
`fromSelf=true`, new thread created. That also settles `fromSelf` detection in
the positive case, which the read-only verification could not reach.

Getting there took three fixes, all the same underlying mistake — **assuming a
selector matches one element when the page renders several**:

1. **The profile "Message" control is a link, not a button.** It is
   `<a href="/messaging/compose/?profileUrn=urn:li:…">`. Navigate to the href;
   do not click. Six copies exist on a profile — one zero-sized, one behind the
   top nav.
2. **Synthetic `element.click()` does nothing.** LinkedIn's handlers want
   genuine pointer input. A synthetic click that silently no-ops is
   indistinguishable from a real failure, which is the worst way to break.
3. **Two composers share `[aria-label="Write a message…"]`** — the main form and
   the persistent bottom-right overlay widget. Typing into the wrong one leaves
   text visibly on screen while the real form's Send button stays disabled,
   which reads as "LinkedIn rejected our input" when we simply filled in a
   different box. The composer is now located *from its own Send button*, so
   the pair is guaranteed to belong to the same form.

The general lesson for every handler here: **scope by relationship, not by
selector.** Find the control that owns the thing you want, then search within
it.

### Reactions

Six types — `like` (default), `celebrate`, `support`, `love`, `insightful`,
`funny`. Gated as a write: it sends no text, but it is public, surfacing to the
author and into the reacting account's network.

The post DOM is far friendlier than messaging. Measured on a live activity page:

```
div[data-urn="urn:li:activity:…"]         durable post identity
button[aria-label="React Like"]           aria-pressed reflects current state
button[aria-label="Open reactions menu"]  hidden until the Like button is hovered
```

`aria-pressed` does real work: the action is **idempotent** (an already-reacted
post is left alone rather than toggled off by a second call) and **verified**
(we confirm the button became pressed instead of trusting the click).

`like` is the default because a plain click applies it. The other five require
hovering to open the picker — implemented, but **not yet exercised** against a
live post.

**Verified live 2026-08-21:** a Like was applied to a real post and confirmed;
a second identical call reported `alreadyReacted: true` and left it alone rather
than toggling it off.

**LinkedIn ships two reaction UIs, both live.** The activity feed uses
`aria-label="React Like"` with `aria-pressed`; a post permalink uses
`aria-label="Reaction button state: no reaction"` with hashed class names, no
`aria-pressed` at all, and no `data-urn` container. Neither the selector nor the
state check from one variant works on the other, so both are matched and state
is read from whichever signal that variant offers. `activityUrn` is null on the
permalink variant — there is nothing to read it from.

`postUrl` is validated as an http(s) `linkedin.com` or `lnkd.in` URL, not merely
a parseable URI: `z.string().url()` alone accepts `activity:123` and
`javascript:…`, and this value gets navigated to. `lnkd.in` shortlinks are
accepted, and because a shortener resolves wherever it likes, the **landing
host is re-checked after navigation** before anything is clicked.

### Selectors are measured, not guessed

Anchored on ARIA — `ul[aria-label="Conversation List"]`,
`label[aria-label="Select conversation with <Name>"]`,
`[aria-label="Write a message…"]` — because accessibility text changes far less
often than the obfuscated class names LinkedIn rotates each deploy.

Measured on the live page 2026-08-21, and worth recording so nobody retries them:

- `a[href*="/messaging/thread/"]` matches **nothing**; the list has no links.
- Element ids are ember-generated (`...ember50`) and change every render.
- 7 of 18 list rows are empty spacers, so rows are filtered by content.
- The message pane has **no** usable ARIA landmark, so it falls back to
  LinkedIn's `msg-s-*` classes. Those are BEM-style semantic names rather than
  build hashes, which is why they survive deploys — but they are the most
  brittle part of the codebase. If a handler starts returning empty, look here.

Consequence for the contract: **there is no durable thread id in the list.**
Threads are addressed by correspondent, and the canonical id exists only in the
URL of an open thread — something an action returns, never something a caller
can know in advance.

## Onboarding and remediation

One tool for both, because they are the same operation and the second runs
forever: the sweep quarantines a challenged account, and this is how it gets
back.

```bash
npm run onboard list                  # what needs a human
npm run onboard start   <accountId>   # launches the console, prints the tunnel
npm run onboard finish  <accountId>   # verifies the live page, then activates
```

Three rules it enforces rather than documents:

**Re-auth happens on the account's existing egress.** `start` resolves the proxy
from the profile, not from the caller. Logging back in from a different address
is the anomaly §10 exists to prevent, committed at the moment LinkedIn is
watching hardest — and it refuses outright if that address has no local proxy.

**Activation requires the live page to verify.** `finish` navigates and
classifies; the operator asserting they are done is not the evidence. Trusting
it would put a still-challenged account back into rotation.

**Identity survives re-auth.** Egress IP and hardware class are carried from the
stored profile, never from the session capture — a new address or hardware class
is a different device to the platform. Warmth is cleared, so a recovered account
rejoins at the regular cadence instead of going straight to 60s polling on the
least-trusted session in the fleet.

## The sweep

```bash
PROFILE_ROOT=/var/lib/hive-profiles \
PROXY_POOL=135.148.52.236=http://127.0.0.1:3128 \
BROWSER_URL=http://127.0.0.1:9222 \
npm run sweeper
```

Three behaviours worth knowing before running it against real accounts:

**It halts rather than degrades.** A challenge rate at or above 10% over 15
minutes (minimum 20 samples) stops the entire sweep and does not auto-reset.
Recovery needs a human who has established why. `ERROR` never counts —
otherwise an ordinary network outage trips the one alert that must never be
ignored. Routine `LOGGED_OUT` does not count either; it feeds remediation.

**Quarantine is terminal until a human intervenes.** A challenged account leaves
the sweep entirely and is not retried. Retrying is how a soft challenge becomes
a permanent restriction.

**It rebuilds its schedule from the store at boot, then ramps over 30 minutes.**
Cadence is a pure function of each account's last event, so the queue is derived
state — there is no persisted queue to disagree with reality after a crash.
Being overdue earns no priority: hundreds of sessions reconnecting at once from
a handful of addresses is the risk the ramp exists to prevent.

## Durability

The property everything else rests on, verified against `gs://aden-hive-browser-profiles`:

**Object keys are immutable.** `profiles/<accountId>/<updatedAt>-<hash8>.json` —
never overwritten, so the replicator runs with a service account holding
`objectCreator` + `objectViewer` and nothing else. A delete attempt is refused
(`does not have storage.objects.delete`) and the object survives. A corrupted
local write can add a bad version; it cannot destroy a good one.

**The backlog lives on disk.** Replication markers are files, so a crash leaves
the work discoverable. The versions that would be dropped by an in-memory queue
are exactly the ones existing only on the machine that just died.

**Latest is a lexical max**, so a write is one atomic rename with no pointer
file a crash could leave inconsistent.

Bucket: `us-east4` (near the OVH host), versioning on, lifecycle keeps 10
noncurrent versions / 30 days. Lifecycle runs as the service, so cleanup works
even though the replicator cannot delete.

Deploying to a host needs a service-account key at the path in the unit file —
mint it at deploy time; none currently exists.

## Egress

Profiles bind to a **public IP**, not a proxy endpoint. The IP is the account's
durable network identity; which loopback port fronts it is a deployment detail
that may be renumbered without that looking like an account changing addresses.

Chrome picks egress per context with `proxyServer`, not with a socket option, so
each egress IP gets a local forward proxy that binds its *outgoing* connections
to that source address (`deploy/gen-egress.sh`).

**The box's own primary IP is pool member #1 and gets no special case.** Starting
with only that address costs nothing and needs no purchase:

```bash
sudo apt-get install -y tinyproxy
sudo ./deploy/gen-egress.sh 135.148.52.236
# later, after buying OVH failover IPs:
sudo ./deploy/gen-egress.sh 135.148.52.236 1.2.3.4 1.2.3.5
```

Adding addresses assigns **new** accounts to them. Existing accounts never move —
§10's sequencing rule means an account that logs in on one address and later
runs from another manufactures exactly the anomaly the design avoids, so
migration at scale is the riskiest operation available and this avoids needing it.

Metered residential proxies are ruled out on cost, not preference: every check
is a cold cache, so 400 accounts at 183 checks/day is roughly 6.6-13 TB/month.
At $1-10/GB that is $2.2k-33k/month. OVH failover IPs are ~$2-3/IP/month
unmetered.

## The Phase 0 spike

There are two questions, and the obvious one is the less important one.

**`cycle` — the daily loop. Run this first.** Can a session survive being pulled
out of one ephemeral BrowserContext and pushed into a fresh one? This happens
~183 times a day per account. If it fails, the fleet does not work regardless of
how portable blobs are between hosts.

**`capture` + `restore` — the rebuild case.** Can a session survive moving to a
different machine behind a different egress IP? This happens on a rebuild, so it
gates the disaster-recovery story rather than daily operation.

Both are run against a real logged-in account, using the onboarding console so
the login happens at the address the profile will run from — the §10 sequencing
rule.

### 1. Bring up the console and log in

```bash
# on the VM
~/hive-browser-farm/spike/console.sh start

# from your machine — nothing is publicly exposed, tunnel only
gcloud compute ssh browser-farm-spike --project=aden-487803 \
  --zone=us-west2-a -- -L 6080:localhost:6080
```

Open <http://localhost:6080/vnc.html>, connect, and log in.

### 2. Run the daily-loop test

```bash
node spike/migrate.ts cycle --iterations 5 --account-id spike-1
```

Reports per iteration: outcome, unread count, hydrate/nav timing, `T`, renderer
CPU, and whether stored state changed. Then medians for `T` and CPU — the two
constants §7 currently assumes — against the plan's assumed values.

`cycle` refuses to run unless the console browser is genuinely logged in, so a
stale session produces a clear error rather than a misleading pass.

### 3. Optionally, the rebuild case

The two halves run on **different machines**. Do not run this on the OVH box —
it cannot provide a second IP by definition.

```bash
# --- source machine: Chrome logged into the test account ---
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=/tmp/spike-src
# log into LinkedIn in that window, then:
node spike/migrate.ts capture --out ./profile.json --account-id spike-1

# --- target machine, different IP (or via --proxy) ---
node spike/migrate.ts restore --in ./profile.json \
  --proxy http://user:pass@proxy-host:port
```

`restore` exits non-zero if the session did not survive, and prints:

- **OUTCOME** — the go/no-go, plus the URL and title it landed on
- **egress IP** — observed externally, confirming the proxy actually applied
- **T** — full lease cycle time, the missing constant in the §7 capacity model
- **renderer CPU** — the other missing constant, which decides how much room is
  left for agent sandboxes on the same box
- **blob size** — against the 5–20 MB budget in §5

### Two things to check on the first run

1. **The URL patterns in `src/linkedin/classify.ts` are unverified guesses.**
   They are the best reading of LinkedIn's public behaviour, not something
   observed. `restore` prints the landed URL and title on every run precisely so
   they can be corrected before anything depends on them. A `NO-GO` result may
   be a misclassification rather than a real failure — check the URL first.

2. **IndexedDB is deliberately not captured.** If `OUTCOME` is `OK`, cookies plus
   localStorage are sufficient and we never need to build an IndexedDB exporter.
   If the session fails while the URL looks like a normal logged-out redirect,
   IndexedDB is the first suspect. Finding this out is cheaper than assuming it.

## Development

```bash
npm test          # unit tests, no browser needed
npm run typecheck
npm run spike:smoke   # integration check of the CDP layer, see below
```

`spike:smoke` verifies the lease/hydrate/dispose path against a real Chrome. It
needs two things running first:

```bash
python3 -m http.server 8899 --directory /tmp &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --remote-debugging-port=9333 --user-data-dir=/tmp/smoke-chrome &
```

It asserts that fingerprint overrides apply, that localStorage is seeded before
page scripts run, that cookies round-trip, and that `release()` actually removes
the context from the browser rather than leaking a live cookie jar into the next
lease on that slot.
