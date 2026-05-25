# Hypervisor operations — runbook

Everything an operator needs to know to do hypervisor work against our
OVH-hosted e2b cluster. This doc is the source of truth for what runs
where, what each script does, and how to recover when something fails.

Anything that automates these operations (admin API, CI workflows,
self-service portal) should map 1:1 to the steps here. If the doc and
the automation drift, the doc wins — fix the automation.

## Audience

You have:

- SSH access to `ubuntu@135.148.52.236` (the single OVH host running e2b)
- `kubectl` configured for the `staging` namespace (hive-backend lives there)
- `gcloud` auth for project `tool-for-analyst` (hive-secrets in GCP Secret Manager)
- A clone of `aden-hive/infra` (this repo) at `~/aden/infra`
- A clone of `aden/hive-desktop-runtime` (the runtime fork) at
  `~/aden/hive-desktop-runtime`

If you don't have one of those, you can't do most of what's in this
doc — ask Timothy to provision.

## Mental model

Four storage layers, all on the OVH host:

| Layer                   | Where                                                 | What it holds                                                                              |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **e2b postgres**        | `127.0.0.1:5432` db=`e2b` user=`e2b`                  | `envs`, `env_aliases`, `env_builds`, `env_build_assignments`, `snapshots`, `team_api_keys` |
| **Docker registry**     | `127.0.0.1:5000`                                      | OCI images that VM templates build from (`hive-novnc:colonies-vN`)                         |
| **MinIO snapshots**     | `/srv/minio/e2b-templates/<build_id>/`                | The 6 Firecracker snapshot files per build (memfile, rootfs.ext4, snapfile, …)             |
| **Firecracker runtime** | `/orchestrator/sandboxes/<sbx_id>/`, `/tmp/fc-*.sock` | Live microVM state per running sandbox                                                     |

The hive-backend layer (separate, in GCP k8s `staging` namespace) holds:

| Table                        | What                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `account_vm`                 | one row per team — state machine `running ⇄ paused → terminated`, points at one e2b sandbox |
| `account_vm_event`           | append-only audit of every state change                                                     |
| `account_vm_pushed_colonies` | persistent "this colony routes to this team's VM" pin                                       |

## Roles of the key entities

- **template (env)** — `envs.id` — the abstract "VM kind." We have one
  in use: `hivev3` (UUID-aliased).
- **alias** — `env_aliases.alias` — a stable name (`hivev3`) that maps
  to an env. The desktop only ever names aliases, never UUIDs.
- **build** — `env_builds.id` (UUID) — a specific snapshotted version
  of a template. Each build has its own 6 files in MinIO.
- **assignment** — `env_build_assignments` — the alias→build pointer.
  Most recent row per `(env_id, tag='default')` wins. Promotion = INSERT.
- **sandbox** — a live or paused microVM. ID starts with `i` and is
  20 hex-ish chars. Held in `snapshots` when paused.
- **snapshot** — the 6-file blob in MinIO that a `pauseSandbox` writes.
  Resume rehydrates a Firecracker from these files.

---

# 1. Routine operations

## 1.1 Roll a new template build

**What it does:** sync the runtime tree into the docker build context,
build a docker image, snapshot a Firecracker from it via the e2b
orchestrator's `create-build` binary, verify the 6 snapshot files
landed in MinIO, then write a `env_builds` + `env_build_assignments`
row so the alias points at the new build.

**Command:**

```bash
cd ~/aden/infra/sandbox-images/hive-novnc

# Roll into the candidate alias (preferred — atomic via separate alias)
./roll-template.sh -a hivev3-rc

# Or roll into a specific tag (skips the auto-bump of colonies-vN)
./roll-template.sh -a hivev3-rc -t colonies-v18
```

**Stages (~10-15 min total):**

1. `sync-hive-src.sh` — rsync `~/aden/hive-desktop-runtime/` into
   `sandbox-images/hive-novnc/hive-src/`. Stamps `.hive-source-rev`.
2. docker build + push to `127.0.0.1:5000/hive-novnc:colonies-vN`.
3. Snapshot orchestrator env from `/proc/<pid>/environ` (so the build
   sees the same `STORAGE_PROVIDER`, MinIO creds, registry creds).
4. `sudo systemctl stop nomad` — orchestrator releases `:5007`.
5. `create-build -to-build <new_uuid> -template <alias>
-fromImage 127.0.0.1:5000/hive-novnc:colonies-vN`. This is the
   actual snapshot capture; runs ~5-10 min.
6. **Hard-fail verification:** check
   `/srv/minio/e2b-templates/<new_uuid>/` has all 6 files
   (memfile, memfile.header, metadata.json, rootfs.ext4,
   rootfs.ext4.header, snapfile). If anything is missing, abort —
   alias stays pointed at the previous build.
7. `sudo systemctl start nomad` — orchestrator returns.
8. Postgres `INSERT INTO env_builds (...)` + `INSERT INTO
env_build_assignments (env_id, build_id, tag, source)`.
9. (Best-effort) verify via the e2b API at
   `https://api.vm.open-hive.com/templates`.

**Sanity check** — re-run any time:

```bash
./roll-template.sh check -a hivev3-rc
# → ✅ snapshot files present  (or which ones are missing)
```

**When things fail mid-roll:**

- Snapshot files missing → script aborts cleanly, alias is untouched.
  Inspect with `check`; rerun with `roll-template.sh -a hivev3-rc -t
<previous-tag>` if you want to retry against the same image.
- Nomad won't restart → `sudo journalctl -u nomad -f` and check
  `/etc/nomad/orchestrator.hcl`. The orchestrator alloc id is in the
  `nomad alloc status` output.

## 1.2 Promote a build (atomic alias-flip)

**What it does:** repoint an alias (`hivev3`) at a new build_id. Most
recent assignment row wins. **New sandbox spawns** pick up the new
build; **existing running sandboxes** keep their original snapshot in
memory and only see the new build after pause+resume — which is what
the staleness gate in [hive-backend cors-vm.service](../../hive-backend/src/services/sandbox/account-vm.service.ts) auto-handles.

**Command — SSH into OVH and run psql:**

```bash
ssh ubuntu@135.148.52.236 <<'EOF'
PASS=$(sudo cat /proc/$(pgrep -f 'bin/api' | head -1)/environ 2>/dev/null \
  | tr '\0' '\n' | grep '^POSTGRES_CONNECTION_STRING=' \
  | sed 's|.*//e2b:||;s|@.*||')

# Replace with the build_id you want active:
NEW_BUILD_ID=941970b6-10e8-48f7-b366-ce2e20358f73
ALIAS=hivev3

PGPASSWORD=$PASS psql -h 127.0.0.1 -U e2b -d e2b -c \
  "INSERT INTO env_build_assignments (env_id, build_id, tag, source)
   VALUES ((SELECT env_id FROM env_aliases WHERE alias='$ALIAS'),
           '$NEW_BUILD_ID', 'default', 'app');"
EOF
```

**Verify the alias now points at the new build:**

```bash
ssh ubuntu@135.148.52.236 \
  "PASS=\$(sudo cat /proc/\$(pgrep -f 'bin/api' | head -1)/environ \
     | tr '\0' '\n' | grep '^POSTGRES_CONNECTION_STRING=' \
     | sed 's|.*//e2b:||;s|@.*||'); \
   PGPASSWORD=\$PASS psql -h 127.0.0.1 -U e2b -d e2b -tAc \
     \"SELECT build_id FROM env_build_assignments \
       WHERE env_id=(SELECT env_id FROM env_aliases WHERE alias='hivev3') \
       ORDER BY created_at DESC LIMIT 1\""
```

**Rollback** = same INSERT with the **prior** build_id. The whole
promotion mechanic is just "another row wins now." No cascading state.

## 1.3 Parity test (validate a candidate before promotion)

**What it does:** spawns a local hive runtime + a remote sandbox from
the candidate alias, pushes the same colony tar to both, then compares
13 dimensions (queen id, queen phase, LLM provider, skills list,
credentials, first tool call, no auth errors, …). Acceptance gate is
13/13 PASS.

**Setup:**

```bash
# Stream token = per-user JWT for hive-llm. Minted from k8s hive-secrets.
export HIVE_STREAM_TOKEN=$(~/aden/infra/scripts/mint-stream-token.sh)

# Pin the candidate alias for the test
export HIVE_E2B_TEMPLATE=hivev3-rc
```

**Run:**

```bash
cd ~/aden/infra/sandbox-images/hive-novnc

# Default — uses bundled test-fixtures/parity_smoke colony
./parity-test.sh

# Or pass a real colony from disk
./parity-test.sh --colony ~/.hive/colonies/twitter_engagement_2
```

**Output:**

- Live progress in stdout (push events, session creation, polling)
- Final table: 13 rows of `dimension | local | remote | pass`
- JSON report at `/tmp/parity-<ts>-<pid>/report.json`
- Staged colony tar at `/tmp/parity-<ts>-<pid>/stage/`

**What 13/13 actually means:** the runtime baked into the candidate
template behaves equivalently to your local checkout when given the
same colony. Any divergence is real and worth investigating before
promotion. Common diffs:

- skills_count mismatch → the candidate is missing a skill module
- llm_provider mismatch → in-template `/api/config/llm` didn't apply
- no_llm_auth_error=false → the in-template hive-llm bearer isn't
  being passed through (most often: stale streamToken handling)

## 1.4 Mint a stream token

**What it does:** signs a per-user JWT with HS256 against the
`JWT_SECRET` in k8s `hive-secrets`. The token authenticates VM-side
queens to the Rust `hive-llm` proxy as that user.

**Command:**

```bash
~/aden/infra/scripts/mint-stream-token.sh
# 24h TTL, default sub/team

~/aden/infra/scripts/mint-stream-token.sh \
  --sub teammate@adenhq.com --team 14034
# Different user/team

HIVE_JWT_SECRET=... ~/aden/infra/scripts/mint-stream-token.sh
# Override the secret directly (skip kubectl roundtrip)
```

**When you need it:**

- Running `parity-test.sh` (export as `HIVE_STREAM_TOKEN`)
- Manual debugging of a VM-side queen via curl

## 1.5 Sync hive-src/ ahead of a roll

`roll-template.sh` calls this for you. Standalone helper for the case
where you want to inspect what will be baked without rolling yet:

```bash
cd ~/aden/infra/sandbox-images/hive-novnc
bash sync-hive-src.sh
# rsyncs ~/aden/hive-desktop-runtime/ → hive-src/, exclusions per
# vendor/sync-hive.sh in hive-desktop, stamps .hive-source-rev

# Override source dir
HIVE_SRC=/path/to/runtime bash sync-hive-src.sh
```

---

# 2. Inspecting cluster state

## 2.1 Active sandboxes

```bash
# Live firecracker processes
ssh ubuntu@135.148.52.236 \
  'ps -ef | grep firecracker | grep -v grep \
     | grep -oP "fc-\K[a-z0-9]+" | sort -u'

# Map sandbox → team via the snapshots table
ssh ubuntu@135.148.52.236 "
  PASS=\$(sudo cat /proc/\$(pgrep -f 'bin/api' | head -1)/environ \
    | tr '\0' '\n' | grep '^POSTGRES_CONNECTION_STRING=' \
    | sed 's|.*//e2b:||;s|@.*||')
  PGPASSWORD=\$PASS psql -h 127.0.0.1 -U e2b -d e2b -c \
    \"SELECT s.sandbox_id, s.env_id, s.team_id, s.sandbox_started_at
        FROM snapshots s
        ORDER BY s.sandbox_started_at DESC LIMIT 20\""
```

## 2.2 Template aliases + their current build

```bash
ssh ubuntu@135.148.52.236 "
  PASS=\$(sudo cat /proc/\$(pgrep -f 'bin/api' | head -1)/environ \
    | tr '\0' '\n' | grep '^POSTGRES_CONNECTION_STRING=' \
    | sed 's|.*//e2b:||;s|@.*||')
  PGPASSWORD=\$PASS psql -h 127.0.0.1 -U e2b -d e2b -c \
    \"SELECT ea.alias, eba.build_id, eba.created_at, eb.reason
        FROM env_aliases ea
        JOIN LATERAL (
          SELECT build_id, created_at
          FROM env_build_assignments
          WHERE env_id = ea.env_id
          ORDER BY created_at DESC LIMIT 1
        ) eba ON TRUE
        LEFT JOIN env_builds eb ON eb.id = eba.build_id
        ORDER BY ea.alias\""
```

The `eb.reason` JSONB has `source_rev`, `source_branch`, `image_tag`,
`rolled_at` if the build was created via `roll-template.sh`.

## 2.3 MinIO snapshot files for a build

```bash
BUILD_ID=941970b6-10e8-48f7-b366-ce2e20358f73
ssh ubuntu@135.148.52.236 "sudo ls -la /srv/minio/e2b-templates/$BUILD_ID/"

# Expect exactly 6 entries:
#   memfile/  memfile.header/  metadata.json/
#   rootfs.ext4/  rootfs.ext4.header/  snapfile/
```

## 2.4 A team's workspace state (hive-backend side)

```bash
TEAM_ID=14034

# account_vm row
kubectl -n staging exec deploy/staging-hive-app -- node -e "
  const {Pool} = require('pg');
  const p = new Pool();
  p.query('SELECT * FROM account_vm WHERE team_id=\$1', [$TEAM_ID])
    .then(r => { console.log(JSON.stringify(r.rows[0], null, 2)); p.end(); });
"

# Recent events
kubectl -n staging exec deploy/staging-hive-app -- node -e "
  const {Pool} = require('pg');
  const p = new Pool();
  p.query(\`SELECT event_type, detail, occurred_at FROM account_vm_event
           WHERE team_id=\$1 ORDER BY occurred_at DESC LIMIT 20\`, [$TEAM_ID])
    .then(r => { r.rows.forEach(e => console.log(e.occurred_at, e.event_type, JSON.stringify(e.detail))); p.end(); });
"

# Pinned colonies
kubectl -n staging exec deploy/staging-hive-app -- node -e "
  const {Pool} = require('pg');
  const p = new Pool();
  p.query('SELECT * FROM account_vm_pushed_colonies WHERE team_id=\$1', [$TEAM_ID])
    .then(r => { console.log(r.rows); p.end(); });
"
```

The hive-vm-portal dashboard surfaces the same data via
`/v1/workspace` — prefer the UI when you have a JWT in hand.

---

# 3. Destructive operations

These wipe state. **Confirm with the user-team first** if they're not
yours.

## 3.1 Kill a specific sandbox

A running sandbox is a Firecracker process + a row in `snapshots`. The
clean way is via the e2b API (which the orchestrator brokers):

```bash
# Get a service-team api key from the e2b postgres
ssh ubuntu@135.148.52.236 "
  PASS=\$(sudo cat /proc/\$(pgrep -f 'bin/api' | head -1)/environ \
    | tr '\0' '\n' | grep '^POSTGRES_CONNECTION_STRING=' \
    | sed 's|.*//e2b:||;s|@.*||')
  PGPASSWORD=\$PASS psql -h 127.0.0.1 -U e2b -d e2b -tAc \
    \"SELECT api_key_hash, team_id FROM team_api_keys LIMIT 5\""
# (api_key is hashed in the DB; use a known team's key from k8s
# hive-secrets E2B_API_KEY in practice)

SANDBOX_ID=ikq8ik4shanr9uqz74quy
curl -X DELETE "https://api.vm.open-hive.com/sandboxes/$SANDBOX_ID" \
  -H "X-API-Key: $E2B_API_KEY"
```

This terminates the Firecracker and frees the network slot. The
`snapshots` row stays for audit; new spawns are independent.

## 3.2 Force-respawn a team's workspace

Use this when a team is wedged on an old runtime build and the
staleness gate hasn't caught them (or you want to flush eagerly).

```bash
TEAM_ID=14034
kubectl -n staging exec deploy/staging-hive-app -- node -e "
  const {Pool} = require('pg');
  const p = new Pool();
  p.query(\`UPDATE account_vm SET state='terminated', terminated_at=NOW(),
           end_reason='admin_force_respawn' WHERE team_id=\$1\`, [$TEAM_ID])
    .then(r => { console.log('rows:', r.rowCount); p.end(); });
"
```

Next `/v1/workspace/start` from the team sees `state='terminated'` →
`spawnFresh` against the current `hivev3` build. The team's pinned
colonies are preserved (those live in `account_vm_pushed_colonies` and
are NOT cleared by mere termination — only `destroy()` clears them).

## 3.3 Wipe ALL pinned colonies (fleet-wide flush)

Don't. Each team's pins are their own. If you ever do need to:

```bash
kubectl -n staging exec deploy/staging-hive-app -- node -e "
  const {Pool} = require('pg');
  const p = new Pool();
  p.query('DELETE FROM account_vm_pushed_colonies', [])
    .then(r => { console.log('deleted:', r.rowCount); p.end(); });
"
```

---

# 4. Failure modes & recovery

## 4.1 Roll fails partway

**Symptom:** `roll-template.sh` exits non-zero somewhere between
stages 4-6. Nomad is stopped, MinIO has partial files.

**Recovery:**

1. `./roll-template.sh check -a <alias>` — does the new build_id
   have all 6 files in MinIO?
2. If no → restart nomad manually (`ssh ubuntu@... 'sudo systemctl
start nomad'`), then re-run the roll with the same image tag
   (`./roll-template.sh -a <alias> -t <existing-tag>`).
3. If yes but no postgres row → the script aborted between
   verification and INSERT. Manually `INSERT INTO env_builds` +
   `env_build_assignments` (see 1.2).

The alias is the authoritative pointer; missing rows are recoverable
because the snapshot files are immutable in MinIO.

## 4.2 A specific sandbox is stuck "Sandbox Not Found"

**Symptom:** Desktop shows the noVNC frame as 502/404. hive-backend
`account_vm` says `state='running'`, but the sandbox doesn't respond.

**Diagnosis:** The orchestrator and hive-backend disagree about state
— e2b paused or killed it, but hive-backend's row didn't get the
update.

**Recovery:** the [reconciler](../../hive-backend/src/services/sandbox/account-vm.service.ts) handles this on its tick, OR force
it from the desktop's perspective — destroy + start:

```bash
TEAM_ID=14034
# Force terminate
kubectl -n staging exec deploy/staging-hive-app -- node -e "
  const {Pool} = require('pg'); const p = new Pool();
  p.query(\`UPDATE account_vm SET state='terminated', terminated_at=NOW(),
           end_reason='admin_drift_recovery' WHERE team_id=\$1\`, [$TEAM_ID])
    .then(() => p.end());
"
```

Team's next `/v1/workspace/start` spawns fresh.

## 4.3 Promoted to wrong build, need to roll back

```bash
# What was the previous good build_id?
ssh ubuntu@135.148.52.236 "
  PASS=...;  # see 1.2
  PGPASSWORD=\$PASS psql -h 127.0.0.1 -U e2b -d e2b -c \
    \"SELECT build_id, created_at FROM env_build_assignments
       WHERE env_id=(SELECT env_id FROM env_aliases WHERE alias='hivev3')
       ORDER BY created_at DESC LIMIT 5\""

# INSERT the prior build_id as a new row — most-recent wins
PRIOR=ef1d1672-9388-41ea-9642-c0d6461f8349
# (then run the same INSERT from 1.2 with NEW_BUILD_ID=$PRIOR)
```

Already-running sandboxes spawned during the bad-build window keep
their snapshots in memory and continue working. Only **new spawns** —
and resumes from snapshots originally cut against the bad build —
swing back to the old runtime. The staleness gate in account-vm.service
takes care of the latter automatically.

---

# 5. Reference

## 5.1 Scripts

| Script                                                                                                                            | Purpose                                                                    | Lives at                                             |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| [`roll-template.sh`](../sandbox-images/hive-novnc/roll-template.sh)                                                               | End-to-end VM template build + register                                    | `infra/sandbox-images/hive-novnc/`                   |
| [`sync-hive-src.sh`](../sandbox-images/hive-novnc/sync-hive-src.sh)                                                               | rsync runtime → image build context                                        | same                                                 |
| [`parity-test.sh`](../sandbox-images/hive-novnc/parity-test.sh) + [`parity-test.py`](../sandbox-images/hive-novnc/parity-test.py) | 13-dimension local↔remote runtime parity test                              | same                                                 |
| [`pack-and-policy.sh`](../sandbox-images/hive-novnc/pack-and-policy.sh)                                                           | In-image: pack the Chrome extension as `.crx` + write force-install policy | same (runs INSIDE the docker build, not on the host) |
| [`mint-stream-token.sh`](../scripts/mint-stream-token.sh)                                                                         | Sign a hive-llm stream JWT from k8s hive-secrets                           | `infra/scripts/`                                     |

## 5.2 Postgres tables

**e2b (on OVH host, db=`e2b`)**

- `envs` — abstract templates
- `env_aliases (alias, env_id)` — stable name → env
- `env_builds (id, env_id, status, reason::jsonb, ...)` — snapshotted versions of each env
- `env_build_assignments (env_id, build_id, tag, source, created_at)` — alias pointer; most-recent row per `(env_id, tag)` wins
- `snapshots (sandbox_id, env_id, team_id, sandbox_started_at, ...)` — sandbox lifecycle records
- `team_api_keys` — service-team API keys (hashed)

**hive-backend (in GCP k8s `staging` ns, db=Cloud SQL postgres)**

- `account_vm (team_id PK, state, e2b_sandbox_id, e2b_paused_snapshot_id, e2b_template_id, spawn_metadata::jsonb, ...)` — one row per team
- `account_vm_event (id, team_id, user_id, event_type, detail::jsonb, occurred_at)` — append-only audit log
- `account_vm_pushed_colonies (team_id, colony_name, pushed_at, pushed_by_user_id)` — persistent colony→VM pins

## 5.3 Filesystem layout on the OVH host

```
/home/ubuntu/infra/                     ← this repo, checked out
  sandbox-images/hive-novnc/            ← VM template build context
    hive-src/                            ← synced from hive-desktop-runtime
    hive-extension/                      ← DELETED — extension comes from hive-src now
    Dockerfile, *.sh, *.py

/orchestrator/                          ← e2b orchestrator state
  build-templates/                       ← in-flight build scratch dirs
  sandboxes/                             ← live sandbox state
  sandbox/sandbox-ctl                    ← cli that hive-llm + envd use

/srv/minio/e2b-templates/<build_id>/    ← snapshot files (the actual artifacts)
  memfile, memfile.header, metadata.json,
  rootfs.ext4, rootfs.ext4.header, snapfile

/etc/systemd/system/nomad.service       ← supervises the orchestrator
/etc/nomad/                              ← orchestrator config

/opt/hive-ext-crx/  (INSIDE the VM, not on host)
  hive.crx           ← packed Chrome extension
  hive.pem           ← signing key (regenerated per build — extension ID is stable from key)
  ext_id             ← extension ID derived from key
  ext_version        ← extension version read from manifest.json
  update.xml         ← Chrome force-install update manifest
```

## 5.4 Existing runbooks (referenced from here)

- [`ROLLOUT-0.2.18.md`](../sandbox-images/hive-novnc/ROLLOUT-0.2.18.md) — full 5-stage rollout plan for a desktop+VM tag-pinned release
- [`RUNBOOK-3b-4-promotion.md`](../sandbox-images/hive-novnc/RUNBOOK-3b-4-promotion.md) — manual smoke matrix + atomic alias-flip + rollback SQL for that rollout
- [`TEMPLATE-UPDATE.md`](../sandbox-images/hive-novnc/TEMPLATE-UPDATE.md) — high-level "how a VM template update reaches end-users" with the 9-step delivery flow

---

# 6. Quick reference: "I need to..."

| Goal                                             | Steps                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Ship a new runtime to all teams                  | Roll into `hivev3-rc` (§1.1) → parity test (§1.3) → promote `hivev3` (§1.2)                     |
| Verify a deployed template still works           | `./parity-test.sh` against the active alias (§1.3)                                              |
| See what runtime version a team is on            | Query `account_vm.spawn_metadata->>'e2b_build_id'` (§2.4)                                       |
| Free up a stale paused snapshot                  | Force-respawn the team's workspace (§3.2)                                                       |
| Find out why a sandbox died                      | Recent `account_vm_event` rows for the team (§2.4) + `journalctl -u nomad` on OVH               |
| Roll back a bad promotion                        | INSERT the prior build_id as a new env_build_assignments row (§4.3)                             |
| Update which colonies count as remote for a team | UPSERT/DELETE in `account_vm_pushed_colonies` (§2.4 query for inspection, §3.3 for full delete) |
| Mint a JWT for manual e2b API calls              | Use a team's `E2B_API_KEY` from k8s hive-secrets, not the stream token                          |
| Mint a stream token for a VM-side queen          | `mint-stream-token.sh` (§1.4)                                                                   |

---

# 7. What this doc is NOT (yet)

- **Not automated.** Everything here assumes a human at a terminal.
  Future work: the hive-vm-portal exposes a subset via HTTP (see
  [the api-portal](../docs/api-portal/) and the pending hypervisor-api
  design). Until that ships, this doc is the only operator path.
- **Not multi-cluster.** We have one OVH host. If we ever add a
  second, the SSH/postgres/minio paths all become per-cluster.
- **Not exhaustive on the in-VM side.** The VM internals (supervisord,
  Xvfb, Chrome managed policies, hive runtime supervised processes)
  are covered in
  [`sandbox-images/hive-novnc/supervisord.conf`](../sandbox-images/hive-novnc/supervisord.conf)
  - the in-VM `/var/log/supervisor/*.log` files. Add a section here
    the next time someone has to debug an in-VM issue from scratch.
