import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RateLimiter, LIMITS } from "./ratelimit.ts";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

async function fresh(clock: { v: number }) {
  return new RateLimiter(await mkdtemp(join(tmpdir(), "bf-rl-")), () => clock.v);
}

test("a fresh account may act", async () => {
  const c = { v: T0 };
  assert.equal((await (await fresh(c)).check("dan", "send_connection_request")).allowed, true);
});

test("consecutive invites must be spaced", async () => {
  // Not about quota — invites arriving exactly back to back is what looks
  // mechanical, and that is what draws attention before any cap is near.
  const c = { v: T0 };
  const rl = await fresh(c);
  await rl.record("dan", "send_connection_request");
  const tooSoon = await rl.check("dan", "send_connection_request");
  assert.equal(tooSoon.allowed, false);
  assert.match(tooSoon.reason ?? "", /min gap/);
  assert.notEqual(tooSoon.haltCampaign, true, "spacing is not a campaign stop");

  c.v += LIMITS.send_connection_request!.minGapMs + 1000;
  assert.equal((await rl.check("dan", "send_connection_request")).allowed, true);
});

test("the daily cap halts the campaign rather than the target", async () => {
  // A cap means stop the run. Treating it as a per-target failure would march
  // straight through the rest of the list hitting the same wall.
  const c = { v: T0 };
  const rl = await fresh(c);
  for (let i = 0; i < LIMITS.send_connection_request!.perDay; i++) {
    await rl.record("dan", "send_connection_request");
    c.v += HOUR;
  }
  const decision = await rl.check("dan", "send_connection_request");
  assert.equal(decision.allowed, false);
  assert.equal(decision.haltCampaign, true);
  assert.match(decision.reason ?? "", /daily cap/);
});

test("yesterday's invites stop counting against today", async () => {
  const c = { v: T0 };
  const rl = await fresh(c);
  for (let i = 0; i < LIMITS.send_connection_request!.perDay; i++) {
    await rl.record("dan", "send_connection_request");
    c.v += 60_000;
  }
  assert.equal((await rl.check("dan", "send_connection_request")).allowed, false);
  c.v += 25 * HOUR;
  assert.equal((await rl.check("dan", "send_connection_request")).allowed, true);
});

test("limits are per account, so one account cannot spend another's quota", async () => {
  const c = { v: T0 };
  const rl = await fresh(c);
  await rl.record("dan", "send_connection_request");
  assert.equal((await rl.check("devin", "send_connection_request")).allowed, true);
});

test("counts survive a restart", async () => {
  // The cap belongs to the account, not the process. A restart that forgot
  // today's invites would let the fleet quietly double its own limit.
  const c = { v: T0 };
  const root = await mkdtemp(join(tmpdir(), "bf-rl-"));
  const first = new RateLimiter(root, () => c.v);
  await first.record("dan", "send_connection_request");
  const second = new RateLimiter(root, () => c.v);
  assert.equal((await second.check("dan", "send_connection_request")).allowed, false);
});

test("an unlimited action type is not blocked", async () => {
  const c = { v: T0 };
  assert.equal((await (await fresh(c)).check("dan", "list_threads")).allowed, true);
});
