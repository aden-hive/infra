import { test } from "node:test";
import assert from "node:assert/strict";
import { rampFleet, rampedFirstCheck } from "./ramp.ts";

test("a fleet restart spreads across the whole ramp window", () => {
  // 400 sessions reconnecting inside a minute from a handful of addresses is a
  // fleet-wide risk event. Recovery has to look gradual.
  const now = 1_000_000;
  const ids = Array.from({ length: 400 }, (_, i) => `acct-${i}`);
  const scheduled = rampFleet(now, ids, 30 * 60_000, () => 0.5);
  const offsets = scheduled.map((s) => s.at - now);
  assert.ok(Math.min(...offsets) < 60_000, "nothing scheduled near the start");
  assert.ok(Math.max(...offsets) > 29 * 60_000, "ramp does not reach the end");
});

test("no minute of the ramp carries a disproportionate share", () => {
  // Deterministic spread rather than 400 independent draws: random-uniform
  // leaves clumps, and a clump is the stampede in miniature.
  const now = 0;
  const ids = Array.from({ length: 400 }, (_, i) => `a${i}`);
  const scheduled = rampFleet(now, ids, 30 * 60_000, Math.random);
  const perMinute = new Array(30).fill(0);
  for (const s of scheduled) {
    const m = Math.min(29, Math.floor(s.at / 60_000));
    perMinute[m]++;
  }
  const expected = 400 / 30;
  assert.ok(Math.max(...perMinute) < expected * 2, `clumped: ${perMinute.join(",")}`);
});

test("being badly overdue does not earn an account priority", () => {
  // The opposite instinct is natural and wrong. Detection latency is cheap;
  // hundreds of overdue accounts rushing back on together is not.
  const now = 5_000_000;
  const scheduled = rampFleet(now, ["stale-a", "stale-b", "stale-c"], 600_000, () => 0.5);
  assert.ok(scheduled.every((s) => s.at >= now));
  assert.notEqual(scheduled[2]!.at, now);
});

test("a single account does not wait for a ramp", () => {
  // Ramping is about fleet correlation. One account restarting is just an
  // account restarting.
  assert.equal(rampedFirstCheck(1000, 0, 1, 600_000, () => 0.5), 1000);
});
