import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker } from "./breaker.ts";

function at(t: { v: number }) {
  return () => t.v;
}

test("a healthy sweep never halts", () => {
  const t = { v: 0 };
  const b = new CircuitBreaker({}, at(t));
  for (let i = 0; i < 200; i++) b.record("OK");
  assert.ok(b.allows());
});

test("a challenge spike halts the whole sweep", () => {
  // The event this exists for: something changed at LinkedIn or in our
  // fingerprinting, and every further check compounds it across 400 accounts.
  const t = { v: 0 };
  const b = new CircuitBreaker({ minSamples: 20, threshold: 0.1 }, at(t));
  for (let i = 0; i < 18; i++) b.record("OK");
  b.record("CHALLENGED");
  assert.ok(b.allows(), "should not trip below the minimum sample size");
  b.record("CHALLENGED");
  assert.equal(b.allows(), false);
  assert.match(b.snapshot().reason ?? "", /2\/20 leases adverse/);
});

test("one bad lease out of two does not halt anything", () => {
  // Without a sample-size floor, a single early challenge on a quiet fleet
  // would stop all detection — the breaker would be worse than not having one.
  const t = { v: 0 };
  const b = new CircuitBreaker({ minSamples: 20, threshold: 0.1 }, at(t));
  b.record("OK");
  b.record("CHALLENGED");
  assert.ok(b.allows());
});

test("infrastructure errors do not trip it", () => {
  // Folding ERROR in would trip the breaker during an ordinary network outage
  // and train everyone to ignore the one alert that must never be ignored.
  const t = { v: 0 };
  const b = new CircuitBreaker({ minSamples: 5, threshold: 0.1 }, at(t));
  for (let i = 0; i < 50; i++) b.record("ERROR");
  assert.ok(b.allows());
  assert.equal(b.snapshot().samples, 0);
});

test("routine session expiry does not trip it", () => {
  // Accounts log out at some baseline rate. If LOGGED_OUT counted, the
  // threshold would have to be raised until real challenge spikes slipped
  // under it. Tracked for the remediation queue, not for halting.
  const t = { v: 0 };
  const b = new CircuitBreaker({ minSamples: 5, threshold: 0.1 }, at(t));
  for (let i = 0; i < 30; i++) b.record("LOGGED_OUT");
  assert.ok(b.allows());
  assert.equal(b.snapshot().loggedOut, 30);
});

test("a restriction counts as adverse, not merely as an error", () => {
  const t = { v: 0 };
  const b = new CircuitBreaker({ minSamples: 4, threshold: 0.25 }, at(t));
  b.record("OK"); b.record("OK"); b.record("OK");
  assert.ok(b.allows());
  b.record("RESTRICTED");
  assert.equal(b.allows(), false);
});

test("old observations age out of the window", () => {
  // A challenge an hour ago says nothing about now; without pruning the
  // breaker would eventually trip on ancient history and never recover.
  const t = { v: 0 };
  const b = new CircuitBreaker({ windowMs: 60_000, minSamples: 4, threshold: 0.25 }, at(t));
  b.record("CHALLENGED");
  t.v += 120_000;
  for (let i = 0; i < 10; i++) b.record("OK");
  assert.ok(b.allows());
  assert.equal(b.snapshot().adverse, 0);
});

test("it stays tripped until a human resets it", () => {
  // No half-open state on purpose. An automatic retry resumes exactly the
  // traffic that was burning accounts, at the moment we least understand why.
  const t = { v: 0 };
  const b = new CircuitBreaker({ windowMs: 60_000, minSamples: 4, threshold: 0.25 }, at(t));
  b.record("OK"); b.record("OK"); b.record("OK"); b.record("CHALLENGED");
  assert.equal(b.allows(), false);
  t.v += 3_600_000;
  for (let i = 0; i < 100; i++) b.record("OK");
  assert.equal(b.allows(), false, "breaker self-healed — it must not");
  b.reset();
  assert.ok(b.allows());
});
