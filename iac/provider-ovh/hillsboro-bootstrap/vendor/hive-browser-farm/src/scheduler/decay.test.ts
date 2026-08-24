import { test } from "node:test";
import assert from "node:assert/strict";
import {
  intervalForAge,
  jittered,
  nextCheckAt,
  checksPerDay,
  REGULAR_INTERVAL_MS,
  JITTER,
} from "./decay.ts";

const MIN = 60_000;

test("a live exchange is polled every minute", () => {
  // Someone replied 2 minutes ago. A human waiting on an answer notices
  // multi-minute lag, so this window is the one place we pay for speed.
  assert.equal(intervalForAge(2 * MIN), 60_000);
});

test("cadence decays as the conversation goes cold", () => {
  // Real exchanges are bursty then trail off. Paying 1-minute polling for the
  // 55th minute of a conversation that ended at minute 6 is the waste the
  // ladder exists to remove.
  assert.equal(intervalForAge(10 * MIN), 120_000);
  assert.equal(intervalForAge(30 * MIN), 300_000);
  assert.equal(intervalForAge(90 * MIN), REGULAR_INTERVAL_MS);
});

test("intervals never decrease as an account goes quieter", () => {
  // Capacity planning assumes load falls monotonically with staleness. A
  // non-monotonic ladder would make the sizing model in §7 wrong.
  let previous = 0;
  for (let age = 0; age <= 120 * MIN; age += MIN) {
    const current = intervalForAge(age);
    assert.ok(current >= previous, `interval dropped at age ${age / MIN}min`);
    previous = current;
  }
});

test("an account with no event history uses the regular cadence", () => {
  // A freshly onboarded account must not be treated as maximally urgent —
  // otherwise every new account joins at 60s polling.
  assert.equal(intervalForAge(Number.POSITIVE_INFINITY), REGULAR_INTERVAL_MS);
  assert.equal(nextCheckAt(1_000_000, null, () => 0.5), 1_000_000 + REGULAR_INTERVAL_MS);
});

test("jitter spreads accounts that would otherwise fire together", () => {
  // 400 accounts sharing a nominal interval will stampede without this, and
  // exactly-periodic requests are themselves a bot signature.
  const base = REGULAR_INTERVAL_MS;
  assert.equal(jittered(base, () => 0), base * (1 - JITTER));
  assert.equal(jittered(base, () => 1), base * (1 + JITTER));
  assert.equal(jittered(base, () => 0.5), base);
});

test("jitter stays bounded so latency guarantees hold", () => {
  // Callers size pools from the nominal interval; unbounded jitter would let
  // an account silently drift far outside its tier.
  for (let i = 0; i < 200; i++) {
    const value = jittered(60_000);
    assert.ok(value >= 60_000 * (1 - JITTER) - 1, `too small: ${value}`);
    assert.ok(value <= 60_000 * (1 + JITTER) + 1, `too large: ${value}`);
  }
});

test("decay is ~3x cheaper than a flat one-minute warm hour", () => {
  // The reason we chose decay over a flat warm window. If a ladder change
  // erodes this, the capacity numbers in §7 need revisiting.
  const flatWarmHourChecks = 60;
  const decayedWarmHourChecks = checksPerDay(1) - checksPerDay(0) + 60 / 10;
  assert.ok(
    decayedWarmHourChecks < flatWarmHourChecks / 2.5,
    `decay saving eroded: ${decayedWarmHourChecks} checks/warm-hour`,
  );
});

test("load model matches the sizing assumption of ~183 checks/day at R=3", () => {
  // plan/browser-farm.md §7 sizes the detection pool from this number. Keeping
  // it asserted means the doc and the scheduler cannot drift apart silently.
  assert.equal(Math.round(checksPerDay(0)), 144);
  assert.ok(Math.abs(checksPerDay(3) - 183) < 5, `got ${checksPerDay(3)}`);
});
