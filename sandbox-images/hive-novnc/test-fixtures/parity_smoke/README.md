# `parity_smoke` — minimal fixture colony for the local↔remote parity test

This is the smallest colony tree that satisfies `pushColonyToWorkspace`'s
multi-root layout (colony + agents/worker + agents/queens/sessions). Used
by [`parity-test.sh`](../../parity-test.sh) when the user doesn't pass an
explicit `--colony <name>`.

## Layout

```
colonies/parity_smoke/
  metadata.json      colony_name, queen_session_id, queen_name
  worker.json        no-tool worker that just calls set_output('pong')

agents/parity_smoke/worker/
  .keep              fresh worker, no prior conversation history

agents/queens/queen_smoke/sessions/session_smoke/
  meta.json          stub queen session referenced from metadata.json
```

## Why this shape

- `metadata.json:queen_session_id` is what
  [`pushColonyToWorkspace`](../../../../../hive-desktop/src/main/cloud.ts)
  looks up to find the queen session subtree to ship. Without
  `agents/queens/queen_smoke/sessions/session_smoke/`, the push silently
  drops the queen tree and the receiving VM's queen has no context.
- The worker's goal forces a no-tool response so the parity check
  doesn't have to grapple with LLM stochasticity. Both sides should
  return `'pong'` and call `set_output` in 1–2 LLM turns. If either
  side errors out (auth, missing colony, agent_path validation), the
  parity test catches it.
- `loop_config.max_iterations = 5` caps the run if something goes
  wrong, so a stuck queen doesn't hold the test open for minutes.

## How `parity-test.sh` uses it

```
tar -C test-fixtures/parity_smoke -czf push.tar.gz colonies agents
# → POST /api/colonies/import on local + remote
```

That's the same payload shape `pushColonyToWorkspace` builds at runtime —
[hive-desktop/src/main/cloud.ts:945-1027](../../../../../hive-desktop/src/main/cloud.ts).
