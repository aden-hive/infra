import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadCache } from "./thread-cache.ts";
import type { ThreadSummary } from "../actions/contract.ts";

const T0 = 1_700_000_000_000;
const threads = (n: number): ThreadSummary[] =>
  Array.from({ length: n }, (_, i) => ({
    correspondent: `Person ${i}`, preview: `msg ${i}`, position: i, threadId: null,
  }));

test("a list captured by the sweep is readable with its age", async () => {
  const c = new ThreadCache(await mkdtemp(join(tmpdir(), "bf-tc-")));
  await c.put("dan", threads(3), T0);
  const hit = await c.get("dan");
  assert.equal(hit?.threads.length, 3);
  assert.equal(hit?.capturedAt, T0);
});

test("an account never swept has no cached list rather than an empty one", async () => {
  // Empty and unknown are different: empty means "we looked, there is nothing",
  // unknown means "we have never looked" — and the UI should say so.
  const c = new ThreadCache(await mkdtemp(join(tmpdir(), "bf-tc-")));
  assert.equal(await c.get("never-swept"), null);
});

test("a later capture replaces the earlier one", async () => {
  const c = new ThreadCache(await mkdtemp(join(tmpdir(), "bf-tc-")));
  await c.put("dan", threads(2), T0);
  await c.put("dan", threads(5), T0 + 60_000);
  const hit = await c.get("dan");
  assert.equal(hit?.threads.length, 5);
  assert.equal(hit?.capturedAt, T0 + 60_000);
});

test("a list written by the sweeper becomes visible to the API process", async () => {
  // Separate processes, one file. Caching on first load would leave the API
  // serving a list from startup forever.
  const root = await mkdtemp(join(tmpdir(), "bf-tc-"));
  const reader = new ThreadCache(root);
  assert.equal(await reader.get("dan"), null);
  await new ThreadCache(root).put("dan", threads(4), T0);
  assert.equal((await reader.get("dan"))?.threads.length, 4);
});
