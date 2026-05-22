# Updating the `hive-novnc` Firecracker template

The desktop's "workspace" sandboxes spawn from a Firecracker template that
this directory bakes. This doc covers how that template is rolled and why
the steps in [`roll-template.sh`](roll-template.sh) are non-obvious.

If all you want is to ship a fresh template, run:

```bash
./sandbox-images/hive-novnc/roll-template.sh
```

If you want to understand why that script exists at all, keep reading.

## The pieces

```
                             ┌─────────────────────────────────┐
hive-backend (GKE)           │ OVH bare-metal (135.148.52.236) │
   talks to                  │                                 │
   api.vm.open-hive.com ────►│  caddy :443 → :3000             │
                             │     │                           │
                             │     ▼                           │
                             │  e2b api server (:3000)         │
                             │     │ alias→buildID lookup      │
                             │     ▼                           │
                             │  postgres                       │
                             │   ├─ env_aliases                │
                             │   ├─ env_builds                 │
                             │   └─ env_build_assignments      │
                             │                                 │
                             │  orchestrator (:5007 + :5008)   │
                             │   ┌─ launches Firecracker VMs   │
                             │   └─ proxies sandbox HTTP       │
                             │                                 │
                             │  local docker registry (:5000)  │
                             │   └─ hive-novnc:colonies-vN     │
                             │                                 │
                             │  template snapshots             │
                             │   STORAGE_PROVIDER=AWSBucket    │
                             │     → minio at :9000            │
                             │     /srv/minio/e2b-templates/   │
                             │       <build-id>/               │
                             │   STORAGE_PROVIDER=Local        │
                             │     → /orchestrator/build-cache/│
                             │       templates/<build-id>/     │
                             │     ├─ rootfs.ext4              │
                             │     ├─ memfile                  │
                             │     └─ snapfile                 │
                             │                                 │
                             │  nomad agent (supervises)       │
                             │   ├─ orchestrator alloc         │
                             │   └─ api-server alloc           │
                             └─────────────────────────────────┘
```

The desktop never talks to the orchestrator directly. It calls
`hive-backend`, which calls the e2b API at `api.vm.open-hive.com`, which
calls the orchestrator over gRPC. Template lookups (`alias hivev3 →
buildID 9907b20e-…`) live in the e2b API's postgres, not in the
orchestrator's filesystem.

## What "rolling a template" means

A template roll produces three artefacts that all need to agree:

1. **Docker image** — `127.0.0.1:5000/hive-novnc:colonies-vN`. This is what
   `create-build` boots inside Firecracker to capture the snapshot.
2. **Firecracker snapshot** — `rootfs.ext4` + `memfile` + `snapfile` plus
   their headers + `metadata.json`. The location depends on the
   orchestrator's `STORAGE_PROVIDER`:
   - `AWSBucket` (current OVH staging) → MinIO at
     `/srv/minio/${TEMPLATE_BUCKET_NAME}/<build-id>/`.
   - `Local` (legacy / dev) →
     `${LOCAL_TEMPLATE_STORAGE_BASE_PATH}/<build-id>/`.

   `roll-template.sh` reads `/proc/<orchestrator-pid>/environ` to
   discover whichever provider is live and passes the same env to
   `create-build`. Hardcoding the wrong provider was the 2026-04-29
   outage — the build wrote to the local path but the orchestrator
   only looks at MinIO; every spawn returned `FailedPrecondition:
   sandbox files not found`.
3. **Postgres registration** — rows in `env_builds` and
   `env_build_assignments` that map the alias (`hivev3`) to the new
   `<build-id>`. Without this, the API still resolves the alias to the
   *previous* build and `create-build`'s snapshot sits unused.

A "roll" is atomic only when all three land. `roll-template.sh` verifies
artifact #2 is in the storage backend before performing #3, so a busted
build leaves the previous good build live.

## The nine steps, and what's footgunned about each

### 0. Refresh `hive-src/` from `hive-desktop-runtime`

The desktop AppImage and the VM template MUST run the same hive-runtime
code. The AppImage's bundle is rsynced from `~/aden/hive-desktop-runtime`
at packaging time by [`hive-desktop/vendor/sync-hive.sh`](../../../hive-desktop/vendor/sync-hive.sh).
Until 2026-05-06, the VM's `hive-src/` was an arbitrary local checkout
on whichever developer ran the script — they drifted by ~100 commits in
the wild.

[`sync-hive-src.sh`](sync-hive-src.sh) pulls from the same source as the
AppImage with the same exclusion list, then stamps `.hive-source-rev` +
`.hive-source-branch`. `roll-template.sh` calls it automatically (skip
with `--skip-runtime-sync`). To verify both deployments agree:

```bash
diff <(cat ~/aden/hive-desktop/vendor/hive/.hive-source-rev) \
     <(ssh ubuntu@135.148.52.236 cat /home/ubuntu/infra/sandbox-images/hive-novnc/hive-src/.hive-source-rev)
```

### 1. `rsync sandbox-images/hive-novnc/` → orchestrator host

The orchestrator host has its own checkout of the infra repo at
`/home/ubuntu/infra`. Edits made on a developer machine don't reach
docker build until they're rsynced.

`hive-src/` is `.gitignore`d in this repo (it's a build-time snapshot of
the closed-source desktop-runtime fork), so rsync is the *only* path.
Forgetting this step gives you a docker image with stale Python source.

### 2. `docker build` + push to local registry on `:5000`

Local registry is a `registry:2` container running on the orchestrator at
`127.0.0.1:5000`. There's no auth and no remote — it exists purely so
`create-build` can reference the image by hostname (its OCI loader
doesn't read local docker tags directly).

The `--no-cache` flag in the script is deliberate: a cache-hit on
`COPY hive-src /opt/hive` won't fire if `hive-src/` content changed,
because BuildKit's cache key is based on the directory hash and content
*does* change layer-by-layer reliably; but on `RUN uv sync --frozen`
BuildKit may still hit a cached layer if `pyproject.toml` and
`uv.lock` are byte-identical to a previous build, even though the
underlying `framework/` source it imports is different. `--no-cache`
sidesteps that whole class of bug. ~30s extra; worth it.

### 3. Stop nomad → free port 5007

This is the step that makes naive shell-loops fail.

[`packages/orchestrator/cmd/create-build/main.go:51`](/home/timothy/aden/infra/packages/orchestrator/cmd/create-build/main.go#L51)
hardcodes `proxyPort = 5007`. So does the running orchestrator. They
can't run together.

The orchestrator runs as a nomad job (alloc `1741b4a1-…`). Killing the
orchestrator process triggers nomad's restart policy and a fresh
orchestrator binds `:5007` within ~2 seconds. To keep `:5007` free long
enough for `create-build` to finish you have to stop the nomad agent
itself, then `pkill -KILL` the orphaned executors that nomad's task
driver leaves running by design. Stopping nomad cleanly via the API
needs an ACL token that the local config doesn't have, so the script
goes through `systemctl stop nomad` + force-kill.

The script bails if `:5007` is still bound after the kill so it can't
silently launch a build that's destined to fail.

### 4. `create-build` → Firecracker rootfs+memfile snapshot

`create-build` is the OCI-image-to-Firecracker-snapshot tool. It:

- pulls the OCI image from the registry,
- builds a rootfs ext4 file out of it,
- boots a Firecracker VM from that rootfs,
- waits for the VM's systemd target ("ready"),
- snapshots memory + state.

**Env: read from the running orchestrator process, never hardcoded.**
The orchestrator's nomad job sets ~20 env vars that `create-build`
needs. These vary by deployment (single-node OVH PoC vs production e2b
on GCP), so `roll-template.sh` reads them out of
`/proc/<orch-pid>/environ` and re-exports them into `create-build`'s
shell. Whatever the orchestrator runs with becomes what `create-build`
runs with — drift is impossible.

Keys captured (see [`roll-template.sh:snapshot_orchestrator_env`](roll-template.sh#L60)):

```
STORAGE_PROVIDER  TEMPLATE_BUCKET_NAME  BUILD_CACHE_BUCKET_NAME
AWS_ENDPOINT_URL_S3  AWS_REGION  AWS_S3_USE_PATH_STYLE
AWS_ACCESS_KEY_ID  AWS_SECRET_ACCESS_KEY
ARTIFACTS_REGISTRY_PROVIDER
DOCKERHUB_REMOTE_REPOSITORY_PROVIDER  DOCKERHUB_REMOTE_REPOSITORY_URL
REGISTRY_DOCKER_REPOSITORY_NAME
HOST_BUSYBOX_DIR  HOST_KERNELS_DIR  FIRECRACKER_VERSIONS_DIR  HOST_ENVD_PATH
ENVIRONMENT  USE_LOCAL_NAMESPACE_STORAGE
LOCAL_TEMPLATE_STORAGE_BASE_PATH  LOCAL_BUILD_CACHE_STORAGE_BASE_PATH
NODE_IP
```

Required flags:

```
-template <alias>        e.g. hivev3
-to-build <new-uuid>     fresh UUID
-fromImage <registry>    127.0.0.1:5000/hive-novnc:<tag>
-vcpu 2 -memory 2560 -disk 6144 -hugepages=false
```

(`-storage` is no longer passed — the storage backend comes from the
env vars above.)

The build VM runs through full systemd boot (chrony, ssh, supervisord)
inside Firecracker. Total elapsed: ~30–60s on a warm cache.

### 4b. Verify the snapshot landed where the orchestrator will look

`create-build` writes the snapshot to whatever
`STORAGE_PROVIDER` points at. After the build returns, the script
probes the destination for all six expected files
(`memfile`, `memfile.header`, `metadata.json`, `rootfs.ext4`,
`rootfs.ext4.header`, `snapfile`).

| Provider | Probe |
|---|---|
| `AWSBucket` | `sudo test -e /srv/minio/${TEMPLATE_BUCKET_NAME}/<build-id>/<file>` |
| `Local` | `sudo test -f ${LOCAL_TEMPLATE_STORAGE_BASE_PATH}/<build-id>/<file>` |

Hard fails if any are missing — the postgres INSERT in step 6 is
skipped, the alias stays on the prior good build, and the broken
build's files (if any) stay on disk for forensics. This is the
guard that would have caught the 2026-04-29 outage.

### 5. Restart nomad

`systemctl start nomad`. Nomad re-launches the orchestrator alloc and
the api-server alloc within ~10 seconds. The script polls until BOTH
`:5007` (orchestrator) AND `:3000` (api server) are bound — the prior
version returned as soon as `:5007` came up, even when the api alloc
was still crash-looping (e.g. 2026-05-06 saw `bind: address already in
use` on `:5015` keep the api crashing for ~5 minutes after the
orchestrator was healthy).

Existing sandboxes from before the restart re-attach automatically
(their snapshots are on disk and the sandbox-catalog rows survive in
redis).

### 6. **`INSERT INTO env_builds + env_build_assignments`** ← the load-bearing step

`create-build` does **not** register the build with the e2b API.
This is the single biggest footgun. After step 4, the snapshot is on
disk and the orchestrator can serve it, but nothing tells the e2b API
that the new `<build-id>` exists, let alone that the alias should resolve
to it.

The mapping lives in two postgres tables in the `e2b` database:

```sql
-- env_builds: every build that's ever been registered
INSERT INTO env_builds (
  id, created_at, updated_at, finished_at,
  status, vcpu, ram_mb, free_disk_size_mb, total_disk_size_mb,
  kernel_version, firecracker_version, env_id, envd_version,
  reason, status_group, team_id
) VALUES (
  '<new-build-id>', NOW(), NOW(), NOW(),
  'uploaded', 2, 2560, 4096, 6144,
  'vmlinux-6.1.158', 'v1.12.1_210cbac', '<env-id>', '0.1.0',
  '{"source_rev":"…","source_branch":"…","image_tag":"colonies-vN",
    "rolled_at":"<utc-iso>"}'::jsonb,
  'ready', '<team-id>'
);

-- env_build_assignments: the *active* build for an alias
INSERT INTO env_build_assignments (env_id, build_id, tag, source)
VALUES ('<env-id>', '<new-build-id>', 'default', 'app');
```

`<env-id>` is the e2b template-UUID (e.g. `jiqznoghg92g68fhgtdh` for
`hivev3` — the script auto-discovers it via `env_aliases.alias`).
`<team-id>` comes from `envs.team_id`.

The e2b API returns the `(env_id, tag='default')` row with the latest
`created_at` from `env_build_assignments` as the alias's active build.
Inserting a fresh row flips the alias.

The `reason` column carries forensic metadata so a later "which commit
was that build from?" question is a one-line postgres query:

```sql
SELECT id, reason->>'source_rev', reason->>'image_tag', created_at
FROM env_builds
WHERE env_id='jiqznoghg92g68fhgtdh'
ORDER BY created_at DESC LIMIT 5;
```

Postgres password is auto-discovered from the api-server's process env
(`POSTGRES_CONNECTION_STRING`). The script bails if it can't find it.

### 7. Verify via the e2b API

```
curl -sS https://api.vm.open-hive.com/templates -H "X-API-Key: $E2B_KEY"
```

Returns `[{"aliases":["hivev3"], "buildID":"<new>", ...}]`. If `buildID`
is still the old one, step 6 didn't take — most likely `env_id` lookup
returned empty (alias not registered). Re-run with `-a <real-alias>`.

The `E2B_API_KEY` is in the staging hive-app pod env on GKE; the script
fetches it via `kubectl exec` and silently skips this step if you don't
have GKE access (the postgres state from step 6 is the source of truth
either way).

## Half-rolled states and how to recover

| Symptom | What likely failed | Fix |
|---|---|---|
| `docker push` succeeded, `create-build` 502 | step 3 — `:5007` was still bound. | `./roll-template.sh check -a <alias>` to confirm. Re-run; the script idempotently re-uses the pushed image. |
| Spawn returns `FailedPrecondition: sandbox files for 'X' not found` | snapshot in wrong storage backend (was 2026-04-29 outage). | `./roll-template.sh check` reports the missing files. Was caused by env-var hardcoding before 2026-05-06 — should not recur. To recover: `INSERT env_build_assignments` with the previous `build_id` to roll back, then re-run `./roll-template.sh`. |
| `create-build` finished, but new sandboxes still spawn old code | step 6 was skipped. | `psql … "SELECT build_id FROM env_build_assignments WHERE env_id=… ORDER BY created_at DESC LIMIT 1"` — if it's the old one, run the two INSERTs by hand or rerun the script. |
| api server crash-looping with `bind: address already in use` after roll | step 5 — a stale alloc still holds the port. | Wait for the new poll loop in `start_orchestrator()` (60s); if it times out, `sudo pkill -KILL -f bin/api` and let nomad re-place. |
| New sandbox boots but `hive serve` 500s | image regression. Look at `/api/sessions` against the new sandbox via the orchestrator's host-header trick. | Roll back: `INSERT … env_build_assignments` with the previous `build_id` (any prior row from the same env_id) → fresh sandboxes flip back. The bad build's snapshot stays on disk for forensics. |
| Drift between AppImage and VM template | step 0 was skipped or `$HIVE_SRC` differed. | `diff <(cat ~/aden/hive-desktop/vendor/hive/.hive-source-rev) <(ssh ubuntu@$ORCH cat /home/ubuntu/infra/sandbox-images/hive-novnc/hive-src/.hive-source-rev)` — should be identical. If not, re-run `bash sync-hive-src.sh` + `npm run package` + `roll-template.sh` in coordinated order. |

## Parity testing local ↔ remote

After a roll, the bar isn't "the orchestrator can spawn a sandbox" — it's
"a colony from a desktop user behaves equivalently against the VM
template as it does against the local hive-runtime." [`parity-test.sh`](parity-test.sh)
exercises that directly:

```bash
./parity-test.sh --colony parity_smoke
```

The script (a) starts a fresh local `hive serve`, (b) spawns a fresh e2b
sandbox via the API, (c) pushes the same colony to both via
`POST /api/colonies/import`, (d) sends the same prompt, then (e)
compares `queen_phase`, `queen_id`, `agent_path`, the colony's skills
catalog, the first tool call from `events/history`, and the
`/api/config/llm` shape. Pass means every dimension matches modulo path
prefixes; fail dumps a JSON diff under `/tmp/parity-<run-id>/report.json`.

Use it before and after every roll: catches LLM auth regressions,
HIVE_HOME-aware-but-not-quite path bugs, and storage-backend
inconsistencies that the orchestrator's `/templates` endpoint can't see.

## Direct VM debugging (orchestrator-side, no access_token)

The orchestrator on `:5007` brokers traffic to sandbox VMs by host
header. From the orchestrator host you don't need an embed access_token
— skip the client-proxy on `:5006` and hit the orchestrator directly:

```
curl -sS -H 'Host: 8787-<sandbox-id>.vm.open-hive.com' \
  http://127.0.0.1:5007/api/<...>
```

Useful for inspecting a live sandbox's `/api/config/llm`,
`/api/credentials`, `/api/sessions`, etc. without minting an embed
token.

To find which firecracker process is which sandbox:

```
ssh <orch> "
  PASS=\$(grep -oP '(?<=requirepass )\S+' /etc/redis/redis.conf 2>/dev/null \
    || sudo grep '^REDIS_URL=' /proc/\$(pgrep -f bin/orchestrator | head -1)/environ \
       | tr '\\0' '\\n' | sed 's|.*default:||;s|@.*||')
  redis-cli -a \$PASS keys 'sandbox:storage:*:sandboxes:*'
"
```

Each value contains `templateID`, `buildID`, and the sandbox's `vCpu` /
`ramMB` so you can correlate with `env_builds`.

## What this doc deliberately doesn't cover

- **Multi-node clusters.** Above is for the single-node OVH PoC. A
  multi-node deployment would route through e2b's `template-manager`
  service, which would handle steps 4 + 6 atomically over gRPC. We don't
  run template-manager here; that's why steps 4 and 6 are split.
- **Removing old builds.** Old build dirs accumulate under
  `/orchestrator/build-cache/templates/`. Until disk pressure becomes a
  problem we leave them — they're the only rollback path.
- **Cross-region or cross-team rolls.** This template lives in one
  team (`hive-service`) on one node. If that ever changes, the postgres
  registration step needs a multi-row `INSERT` keyed by `team_id`.
