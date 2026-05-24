# Runbook: Stage 3b manual smoke + Stage 4 promotion + Stage 5 rollback

Stages 0–3a are complete. Candidate VM template is built and parity-passes
against the local runtime at `release/2026-05-22-rc1`.

| Artifact | Value |
|---|---|
| Git tag | `release/2026-05-22-rc1` (= commit `07d1bb350`) |
| VM image | `127.0.0.1:5000/hive-novnc:colonies-v17` |
| Candidate alias | `hivev3-rc` |
| Candidate build_id | `941970b6-10e8-48f7-b366-ce2e20358f73` |
| Prior `hivev3` build_id (rollback target) | `ef1d1672-9388-41ea-9642-c0d6461f8349` |
| Matched AppImage | `~/aden/hive-desktop/release/OpenHive-0.2.18-rc1.AppImage` |
| Parity report | `/tmp/parity-1779478768-1322688/report.json` (13/13 ✓) |

Both VM (`hive-src/.hive-source-rev`) and AppImage
(`linux-unpacked/resources/hive/.hive-source-rev`) point at the same SHA.

## Stage 3b — manual integration smoke (tester required)

The candidate alias `hivev3-rc` is live in postgres but `hivev3` is
untouched, so live users are unaffected. Tester points their desktop at
the candidate via env var.

```bash
HIVE_E2B_TEMPLATE=hivev3-rc /home/timothy/aden/hive-desktop/release/OpenHive-0.2.18-rc1.AppImage
```

Hard-gate matrix (each row is pass/fail, no partial credit):

| Path | Acceptance |
|---|---|
| Sign in + open queen DM | First message <5s, no DevTools 404s |
| Push a colony from `~/.hive/colonies/<name>` | `[pushColony] OK …` with `by_root` counts; queen has full context |
| Chat against pushed colony | Tool call lands |
| Click Stop / Pause / "Run on workspace" | No 404s; embed re-attaches |
| Toggle a skill on the colony (Tool Library) | `PATCH /api/colony/<id>/tools` 200 |
| Memories / attachments / OAuth-status panels | Load without 404 |

If any 404 surfaces: the renderer is calling a removed endpoint. **File a
renderer follow-up; do not promote.** The 9 removed endpoints from the
plan are the primary suspects.

### 3c soak (30 min)

After the matrix passes, leave the desktop running 30 min with LLM activity
against the pushed colony. Then on the orchestrator:

```bash
ssh ubuntu@135.148.52.236 \
  'curl -s http://127.0.0.1:5007/events/history 2>/dev/null \
   | python3 -c "import json,sys; [print(e) for e in json.load(sys.stdin) if e.get(\"type\")==\"error\"]" \
   | head'
```

Expect: empty. Any output = stop, investigate before Stage 4.

## Stage 4 — atomic alias flip (release manager)

**Read prior build_id first** (also stashed at `/tmp/hivev3-prior-build-id.txt`):

```bash
PRIOR=ef1d1672-9388-41ea-9642-c0d6461f8349
NEW=941970b6-10e8-48f7-b366-ce2e20358f73

ssh ubuntu@135.148.52.236 <<EOF
PASS=\$(sudo cat /proc/\$(pgrep -f 'bin/api' | head -1)/environ 2>/dev/null \
  | tr '\0' '\n' | grep '^POSTGRES_CONNECTION_STRING=' \
  | sed 's|.*//e2b:||;s|@.*||')
PGPASSWORD=\$PASS psql -h 127.0.0.1 -U e2b -d e2b <<SQL
INSERT INTO env_build_assignments (env_id, build_id, tag, source)
SELECT
  (SELECT env_id FROM env_aliases WHERE alias='hivev3'),
  '$NEW',
  'default', 'app';
SQL
EOF
```

### 4 verify

```bash
curl -sS https://api.vm.open-hive.com/templates -H "X-API-Key: \$E2B_KEY" \
  | python3 -c "import json,sys; t=[x for x in json.load(sys.stdin) if x['aliases']==['hivev3']][0]; print(t['buildID'])"
# expect: 941970b6-10e8-48f7-b366-ce2e20358f73
```

Then spawn a fresh sandbox to confirm it picks up the new build_id and
serves `/api/config/llm` with `has_api_key: true`.

Existing running sandboxes keep their in-memory snapshot. Only **new**
sandbox spawns use the new build.

### Distribute the AppImage

After Stage 4 verifies green, ship `OpenHive-0.2.18-rc1.AppImage` to
internal users. Auto-update is NOT enabled for this build (rc tag).

## Stage 5 — rollback (≤30s; only if 4 regresses)

Add a new assignment row pointing back at the prior build_id. Most-recent
row wins by `created_at`, so this flips the alias atomically.

```bash
ssh ubuntu@135.148.52.236 <<'EOF'
PASS=$(sudo cat /proc/$(pgrep -f 'bin/api' | head -1)/environ 2>/dev/null \
  | tr '\0' '\n' | grep '^POSTGRES_CONNECTION_STRING=' \
  | sed 's|.*//e2b:||;s|@.*||')
PGPASSWORD=$PASS psql -h 127.0.0.1 -U e2b -d e2b -c \
  "INSERT INTO env_build_assignments (env_id, build_id, tag, source)
   VALUES ((SELECT env_id FROM env_aliases WHERE alias='hivev3'),
           'ef1d1672-9388-41ea-9642-c0d6461f8349', 'default', 'app');"
EOF
```

Re-distribute the prior AppImage. Sandboxes paused under the new build
still resume — MinIO retains all snapshots regardless of alias state.

## Open follow-ups (post-bake)

- Build-cache GC: prune MinIO snapshots older than the last two
  hivev3 assignments after 7d of bake.
- Renderer compatibility audit: the 9-endpoint list in the plan was a
  grep. A static-analysis pass over `core/frontend/src/api/` should
  catch any silent 404 path Stage 3b missed.
- `colony_name` → `colony_id` response-body audit: rename also affects
  response shape in some endpoints. Renderer reads `r.colony_name` in
  some places.
