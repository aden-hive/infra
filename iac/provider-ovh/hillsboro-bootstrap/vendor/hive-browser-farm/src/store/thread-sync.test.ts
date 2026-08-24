import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadSyncStore } from "./thread-sync.ts";

const T0 = 1_700_000_000_000;
const fresh = async () => new ThreadSyncStore(await mkdtemp(join(tmpdir(), "bf-ts-")));

test("an unseen conversation is worth reading", async () => {
  const s = await fresh();
  const need = await s.needsRead("dan", [{ correspondent: "Ada", preview: "hi" }], 5);
  assert.deepEqual(need.map((t) => t.correspondent), ["Ada"]);
});

test("an unchanged conversation is never re-read", async () => {
  // The whole point: old messages do not change, so re-opening costs ~10s and
  // sends the correspondent another read receipt for nothing.
  const s = await fresh();
  await s.record("dan", "Ada", "hi", T0);
  assert.deepEqual(await s.needsRead("dan", [{ correspondent: "Ada", preview: "hi" }], 5), []);
});

test("a changed preview means new content, so it is read again", async () => {
  // A preview that differs is the one moment a re-read tells the correspondent
  // something they were not already told.
  const s = await fresh();
  await s.record("dan", "Ada", "hi", T0);
  const need = await s.needsRead("dan", [{ correspondent: "Ada", preview: "hi again" }], 5);
  assert.equal(need.length, 1);
});

test("backfill is capped so a sweep cannot become a burst", async () => {
  const s = await fresh();
  const threads = Array.from({ length: 10 }, (_, i) => ({ correspondent: `p${i}`, preview: "x" }));
  assert.equal((await s.needsRead("dan", threads, 3)).length, 3);
});

test("records are per account", async () => {
  const s = await fresh();
  await s.record("dan", "Ada", "hi", T0);
  assert.equal((await s.needsRead("devin", [{ correspondent: "Ada", preview: "hi" }], 5)).length, 1);
});

test("records survive a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "bf-ts-"));
  await new ThreadSyncStore(root).record("dan", "Ada", "hi", T0);
  assert.deepEqual(await new ThreadSyncStore(root).needsRead("dan", [{ correspondent: "Ada", preview: "hi" }], 5), []);
});
