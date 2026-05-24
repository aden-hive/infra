# Rollout plan: hive-desktop-runtime 0.2.18-rc → VM template + AppImage

**Target rev**: `hive-desktop-runtime` branch `feature/0-2-18-release-candidate`,
HEAD `07d1bb350` (Richard Tang, 2026-05-22).

**Currently in production**:

| Surface | Rev | Notes |
|---|---|---|
| VM template `hivev3` | `9c2bfd5` (build `ef1d1672-…`) | Rolled 2026-05-06 after the storage-provider outage |
| Desktop AppImage | `f2879e0` | Last `npm run package` ~Apr 28 |
| Desktop renderer JS bundle | `f2879e0` (bundled w/ AppImage) | Already calls some endpoints (`live_tools`, `upload-attachment`, `memories`, `oauth-status`) that don't exist on the current VM — silent 404s today |

The desktop and VM have **been out of sync for ~2 weeks**. This rollout
re-couples them to one tagged commit.

---

## Why this is a multi-stage rollout, not a single roll

3,550 commits between `9c2bfd5` and `07d1bb3`. ~10,700 LOC added /
~7,500 removed in `core/framework/server/` alone. Surface-level
inventory:

| Change class | Count |
|---|---|
| HTTP routes **added** | 16 |
| HTTP routes **removed** | 17 |
| HTTP routes **renamed** (`colony_name` → `colony_id` and others) | ~6 |
| litellm pin | `1.83.4` → `1.81.5` (intentional, commit `ccaa0563d`) |
| Files we patched in our May-1-6 work, also changed substantially upstream | 8 of 8 |

The renames are the biggest near-term hazard. The desktop renderer
(currently shipping `f2879e0`) calls **at least 9 endpoints that the
new VM no longer has**:

| Desktop callsite | New VM behavior |
|---|---|
| `POST /api/sessions/{id}/stop`     | 404 |
| `POST /api/sessions/{id}/pause`    | 404 |
| `POST /api/sessions/{id}/trigger`  | 404 |
| `POST /api/sessions/{id}/inject`   | 404 |
| `POST /api/sessions/{id}/replay`   | 404 |
| `POST /api/sessions/{id}/colony-spawn` | 404 |
| `GET  /api/sessions/{id}/goal-progress`  | 404 |
| `GET  /api/sessions/{id}/entry-points` | 404 |
| `GET  /api/sessions/{id}/task_list_id` | 404 |

We can't flip `hivev3` to a HEAD-built template until the AppImage
is on the same rev. **Rolling the template alone breaks the desktop.**

---

## Stage 0 — pin the target rev (≤30 min, no production change)

1. In `hive-desktop-runtime`, cut an annotated git tag at the chosen
   commit:

   ```bash
   git -C ~/aden/hive-desktop-runtime checkout feature/0-2-18-release-candidate
   git -C ~/aden/hive-desktop-runtime tag -a release/2026-05-22-rc1 \
     -m "Rollout: 0.2.18 release candidate. See ROLLOUT-0.2.18.md."
   git -C ~/aden/hive-desktop-runtime push origin release/2026-05-22-rc1
   ```

2. Confirm: `git show release/2026-05-22-rc1` resolves to commit
   `07d1bb350` (or whichever commit is current at execution time).

The tag is the **single source of truth** for Stages 1–4. Both the
AppImage build and the VM roll reference it, not a moving branch.

---

## Stage 1 — build a candidate VM template under a new alias (≤30 min)

Use the existing `roll-template.sh` with the `-a` flag so the candidate
lands on a **separate alias** (`hivev3-rc`) without touching live `hivev3`.

**Prerequisite (one-time)** — register `hivev3-rc` as an env in
postgres, since `env_aliases` doesn't have it yet:

```sql
-- generate a new env_id (e2b convention: 20-char lowercase alphanumeric)
WITH new_env AS (
  INSERT INTO envs (id, created_at, updated_at, team_id, source, build_count, spawn_count)
  VALUES (
    'hivev3rc' || substr(md5(random()::text), 1, 12),
    NOW(), NOW(),
    (SELECT team_id FROM envs WHERE id=(SELECT env_id FROM env_aliases WHERE alias='hivev3')),
    'template', 0, 0
  )
  RETURNING id
)
INSERT INTO env_aliases (alias, env_id, namespace, is_renamable)
SELECT 'hivev3-rc', id, 'hive-service', true FROM new_env;
```

Run from the OVH orchestrator host. Save the resulting `env_id` for
later use in Stage 4.

**Roll the candidate**:

```bash
cd ~/aden/hive-desktop-runtime && git checkout release/2026-05-22-rc1
cd ~/aden/infra/sandbox-images/hive-novnc
./roll-template.sh -a hivev3-rc
```

`roll-template.sh` (post-2026-05-06 rewrite) handles everything:

- syncs `hive-src/` from the just-checked-out tag,
- snapshots the orchestrator's storage/registry env vars,
- builds `colonies-v<N+1>`, pushes, runs `create-build`,
- **probes MinIO** for the six expected snapshot files before flipping,
- INSERTs into postgres with source-rev stamped into `env_builds.reason`.

**Acceptance gate (Stage 1)**:

```bash
./roll-template.sh check -a hivev3-rc          # → ✅ snapshot files present
```

`./roll-template.sh check` confirms MinIO has the rootfs+memfile+
headers+metadata+snapfile. If anything's missing, `hivev3-rc` stays
broken but `hivev3` is unaffected.

---

## Stage 2 — build a matched AppImage from the same tag (≤10 min)

```bash
cd ~/aden/hive-desktop-runtime && git checkout release/2026-05-22-rc1
cd ~/aden/hive-desktop
bash vendor/sync-hive.sh        # picks up release/2026-05-22-rc1
npm run package                 # produces release/OpenHive-<ver>.AppImage
```

The AppImage's bundled `.hive-source-rev` will match the VM template's
`.hive-source-rev` exactly. Confirm:

```bash
diff <(cat ~/aden/hive-desktop/release/OpenHive-*-linux-x64/resources/hive/.hive-source-rev) \
     <(ssh ubuntu@135.148.52.236 cat /home/ubuntu/infra/sandbox-images/hive-novnc/hive-src/.hive-source-rev)
# → identical
```

Tag the AppImage build as `OpenHive-0.2.18-rc1` (filename + electron-builder
`build.version`) so it's distinguishable from a production release.

**Do not auto-update existing installs** — internal testers download
this RC manually.

---

## Stage 3 — parity test + manual smoke against the candidate (≤30 min)

### 3a. Automated parity test

```bash
HIVE_E2B_TEMPLATE=hivev3-rc \
HIVE_STREAM_TOKEN=$(./scripts/mint-stream-token.sh) \
./sandbox-images/hive-novnc/parity-test.sh --colony parity_smoke
```

(`scripts/mint-stream-token.sh` is shorthand for the
`JWT_SECRET`+HS256 mint we wrote inline for the May 6 run — should be
codified before Stage 3. Today it's an ad-hoc python snippet.)

**Acceptance**: 13/13 dimensions PASS. The fixture exercises:
- multi-root colony import on both sides,
- `/api/credentials` store with the per-user JWT,
- `/api/config/llm` resolves provider=hive, model=glm-5.1, has_api_key=true,
- queen makes ≥1 LLM call without `litellm.AuthenticationError`,
- skills catalog matches exactly between local and remote.

### 3b. Manual integration

Launch the Stage-2 AppImage with the VM override:

```bash
HIVE_E2B_TEMPLATE=hivev3-rc /tmp/OpenHive-0.2.18-rc1/openhive
```

Click through:

| Path | Acceptance |
|---|---|
| Sign in, open chat with the default queen | First message in <5s, no console errors |
| Push a colony from `~/.hive/colonies/<name>` | `[pushColony] OK …` log with `by_root` showing colonies + agents counts; queen on VM has full colony context |
| Send "list the colonies dir" to the pushed colony | Queen calls `list_directory`, returns the listing |
| Click Stop on the running execution | UI shows stopped; no 404 in DevTools |
| Click Pause | UI shows paused |
| Click "Run on workspace" again (resume) | New sandbox spawns or paused one resumes; embed re-attaches |
| Open the Tool Library, toggle a skill on the colony | `PATCH /api/colony/<id>/tools` returns 200 |
| Memories, attachments, OAuth-status panels | All load without 404s |

Any 404 in DevTools = the desktop renderer is calling a removed/renamed
endpoint. **Fix the renderer side before promoting** — file
follow-ups, don't ship broken UI.

### 3c. Acceptance gates for Stage 3

- Parity test PASS.
- Manual smoke: all rows above ✓.
- 30 min of LLM activity against the pushed colony without an
  `error` event in `/events/history`.

If any gate fails, stop here. `hivev3` is untouched.

---

## Stage 4 — promote the candidate to `hivev3` (≤2 min)

Atomic alias flip via postgres. Record the prior good build_id first
in case of rollback:

```bash
ssh ubuntu@135.148.52.236 <<'EOF'
PASS=$(sudo cat /proc/$(pgrep -f 'bin/api' | head -1)/environ 2>/dev/null \
  | tr '\0' '\n' | grep '^POSTGRES_CONNECTION_STRING=' \
  | sed 's|.*//e2b:||;s|@.*||')

# Record the about-to-be-replaced build_id for rollback.
PGPASSWORD=$PASS psql -h 127.0.0.1 -U e2b -d e2b -tAc \
  "SELECT build_id FROM env_build_assignments
   WHERE env_id=(SELECT env_id FROM env_aliases WHERE alias='hivev3')
   ORDER BY created_at DESC LIMIT 1" \
  > /tmp/hivev3-prior-build-id.txt
echo "Prior build_id: $(cat /tmp/hivev3-prior-build-id.txt)"

# Flip: take the candidate's build_id and insert it for hivev3's env_id.
PGPASSWORD=$PASS psql -h 127.0.0.1 -U e2b -d e2b <<SQL
INSERT INTO env_build_assignments (env_id, build_id, tag, source)
SELECT
  (SELECT env_id FROM env_aliases WHERE alias='hivev3'),
  (SELECT build_id FROM env_build_assignments
   WHERE env_id=(SELECT env_id FROM env_aliases WHERE alias='hivev3-rc')
   ORDER BY created_at DESC LIMIT 1),
  'default',
  'app';
SQL
EOF
```

**Verify**:

```bash
curl -sS https://api.vm.open-hive.com/templates -H "X-API-Key: $E2B_KEY" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps([t for t in d if 'hivev3' in t.get('aliases',[])], indent=2))"
# → buildID matches the candidate's
```

Existing running sandboxes are untouched (firecracker holds the
snapshot in memory). **New** sandboxes spawn from the new build.

Ship the Stage-2 AppImage to internal users.

---

## Stage 5 — rollback (≤30s; only if Stage 4 regresses)

```bash
PRIOR=$(cat /tmp/hivev3-prior-build-id.txt)
ssh ubuntu@135.148.52.236 "
  PASS=\$(sudo cat /proc/\$(pgrep -f 'bin/api' | head -1)/environ 2>/dev/null \
    | tr '\0' '\n' | grep '^POSTGRES_CONNECTION_STRING=' \
    | sed 's|.*//e2b:||;s|@.*||')
  PGPASSWORD=\$PASS psql -h 127.0.0.1 -U e2b -d e2b -c \
    \"INSERT INTO env_build_assignments (env_id, build_id, tag, source)
      VALUES ((SELECT env_id FROM env_aliases WHERE alias='hivev3'),
              '$PRIOR', 'default', 'app');\"
"
```

Then revert the AppImage by re-distributing the prior build, or have
internal users downgrade by re-installing the previous tarball.

Sandboxes paused under the new build can still resume — MinIO keeps
all snapshots regardless of which alias is current. The bake period
(Stage 4 → "stable") is when this risk is highest; tag the rollback
window in the team channel.

---

## Bake plan + ownership

| Phase | Calendar | Owner | Acceptance |
|---|---|---|---|
| Stage 0 | Day 0, 10 min | release manager | tag pushed, repo on tag |
| Stage 1 | Day 0, +30 min | release manager | `check -a hivev3-rc` ✅ |
| Stage 2 | Day 0, +10 min | release manager | AppImage built; `.hive-source-rev` matches |
| Stage 3 | Day 0, +30 min | release manager + 1 manual tester | parity 13/13 + manual smoke all green |
| Stage 4 (promote) | Day 0, +2 min | release manager | API verifies new buildID active |
| Bake | Days 0-2 | watch staging team's sessions | no `error` rate spike in workspace activity log |
| Optional rollback | any time during bake | release manager | `Stage 5` script |

Total active execution: **~2 hours**. Calendar time to "considered
stable": **2-3 days** of live traffic.

---

## What this rollout explicitly does *not* cover

- **No `main`-branch rolls.** Always tag a release candidate first.
- **No new endpoint development to bridge gaps.** If the renderer
  calls a removed endpoint and the contract has just changed, the fix
  is in the renderer — not a backwards-compat shim. The reason: shims
  pile up forever.
- **No DB migration changes** to `envs` / `env_builds` / `env_aliases`
  / `env_build_assignments`. We don't own that schema.
- **No build-cache GC.** Old `9c2bfd5`-era build dirs in MinIO are
  our rollback runway. Cleanup is a follow-up after the bake.
- **No backport of post-`9c2bfd5` patches to the live VM.** If a
  hotfix is needed before Stage 4, cut a new RC tag on top of
  `release/2026-05-22-rc1` and re-do Stages 1–3.

---

## Pre-rollout checklist

Concrete items to verify before Stage 0:

- [ ] `feature/0-2-18-release-candidate` builds cleanly: `cd ~/aden/hive-desktop-runtime/core && uv sync --frozen && uv run pytest core/framework/server/tests/ -q` passes.
- [ ] `parity-test.sh` against the **current** `hivev3` still PASSes 13/13 (sanity baseline).
- [ ] `mint-stream-token.sh` or equivalent is documented for Stage 3 — do not block on ad-hoc python.
- [ ] OVH disk usage `/orchestrator` and `/srv/minio` < 70% (template snapshots are ~1 GB each; we'll add 2 in this rollout).
- [ ] `hive-desktop-runtime` has no uncommitted local changes on the dev laptop.
- [ ] AppImage release is registered with the team's distribution channel — testers know where to download.

---

## Open questions, surfaceable before Stage 0

1. **Renderer compatibility audit.** The list of "9 endpoints the
   renderer calls that the new VM removes" was a grep, not exhaustive.
   Before Stage 4, a renderer-side grep should confirm there are no
   blind calls to removed endpoints. Stage 3's manual smoke catches
   the surfaced ones; static analysis would catch the rest.
2. **`colony_name` → `colony_id` in response bodies.** Some endpoints
   that used to return `colony_name` may now return `colony_id`. The
   renderer's session-detail consumer reads `r.colony_name`. Audit
   needed.
3. **GLM-5.1 + new litellm pin behaviour.** `1.81.5` is a downgrade
   from `1.83.4`. Confirm hive-llm proxy + Anthropic OAuth still
   work — should be covered by parity test but worth a manual
   conversation turn during Stage 3b.
4. **What if Stage 3 fails on something neither test nor manual
   catches?** Stage 4 promotion is the cliff. Worth a 24h bake on
   `hivev3-rc` (have one internal tester point their desktop at it
   via env var) **before** Stage 4.
