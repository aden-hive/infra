import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeartbeatStore, isStale, STALE_AFTER_MS } from "./heartbeat.ts";

const T0 = 1_700_000_000_000;

async function fresh() {
  return new HeartbeatStore(await mkdtemp(join(tmpdir(), "bf-hb-")));
}

test("a check is recorded even when the profile is not rewritten", async () => {
  // The whole point: the sweep skips writes when nothing changed, so
  // meta.updatedAt cannot be used to tell whether an account is being checked.
  const hb = await fresh();
  await hb.record("dan", "OK", T0);
  assert.equal((await hb.get("dan"))?.lastCheckedAt, T0);
});

test("an account never checked reads as stale, not as fresh", async () => {
  // Absence of a heartbeat is the strongest staleness signal there is; treating
  // missing data as healthy would hide exactly the accounts that fell out.
  const hb = await fresh();
  assert.equal(isStale(await hb.get("never-seen"), T0), true);
});

test("staleness is measured against the slowest polling tier", async () => {
  const hb = await fresh();
  await hb.record("dan", "OK", T0);
  const h = await hb.get("dan");
  assert.equal(isStale(h, T0 + STALE_AFTER_MS - 1000), false);
  assert.equal(isStale(h, T0 + STALE_AFTER_MS + 1000), true);
});

test("consecutive failures distinguish a blip from a stuck account", async () => {
  const hb = await fresh();
  await hb.record("dan", "ERROR", T0);
  await hb.record("dan", "ERROR", T0 + 1000);
  assert.equal((await hb.get("dan"))?.consecutiveFailures, 2);
  await hb.record("dan", "OK", T0 + 2000);
  assert.equal((await hb.get("dan"))?.consecutiveFailures, 0);
});

test("heartbeats survive a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "bf-hb-"));
  await new HeartbeatStore(root).record("dan", "OK", T0);
  assert.equal((await new HeartbeatStore(root).get("dan"))?.lastCheckedAt, T0);
});

test("a heartbeat written by another process becomes visible", async () => {
  // The sweeper writes and the API reads — two processes, one file. Caching on
  // first load made the API answer "never checked" forever, a permanent false
  // alarm that teaches operators to ignore the column that matters.
  const root = await mkdtemp(join(tmpdir(), "bf-hb-"));
  const reader = new HeartbeatStore(root);
  assert.equal(await reader.get("dan"), null);

  const writer = new HeartbeatStore(root);
  await writer.record("dan", "OK", T0);

  const seen = await reader.get("dan");
  assert.equal(seen?.lastCheckedAt, T0, "reader never saw the other process's write");
});
