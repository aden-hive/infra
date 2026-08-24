import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DetectionLoop, type CheckResult } from "./loop.ts";
import { MemoryDueQueue, MemoryProfileLock } from "./queue.ts";
import { CircuitBreaker } from "./breaker.ts";
import { LocalProfileStore } from "../store/local-store.ts";
import { SCHEMA_VERSION, type ProfileBlob } from "../profile/schema.ts";

const NOW = 1_700_000_000_000;

function blob(accountId: string, lastEventAt: number | null = null): ProfileBlob {
  return {
    meta: { accountId, schemaVersion: SCHEMA_VERSION, egressIp: "135.148.52.236",
            health: "active", lastEventAt, lastUnread: null, lastOutcome: null, updatedAt: NOW - 1000 },
    fingerprint: { userAgent: "UA", viewport: { width: 1280, height: 800 },
                   timezone: "America/Los_Angeles", locale: "en-US", hardwareClass: "hc" },
    cookies: [{ name: "li_at", value: "tok", domain: ".linkedin.com", path: "/",
                expires: 1, httpOnly: true, secure: true }],
    localStorage: {},
  };
}

async function harness(check: (b: ProfileBlob) => Promise<CheckResult>, opts: {
  breaker?: CircuitBreaker; accounts?: string[];
} = {}) {
  const t = { v: NOW };
  const now = () => t.v;
  const store = new LocalProfileStore(await mkdtemp(join(tmpdir(), "bf-loop-")));
  await store.init();
  const queue = new MemoryDueQueue();
  const lock = new MemoryProfileLock(now);
  const breaker = opts.breaker ?? new CircuitBreaker({}, now);
  for (const id of opts.accounts ?? ["a"]) {
    await store.put(blob(id));
    await queue.schedule(id, NOW - 1);
  }
  const loop = new DetectionLoop({
    queue, lock, breaker, store, check, now, rand: () => 0.5,
    config: { concurrency: 4, lockTtlMs: 60_000, errorBackoffMs: 60_000 },
  });
  return { loop, queue, lock, store, breaker, t };
}

const ok = (unread = 0): CheckResult => ({ outcome: "OK", unread });

test("a healthy check reschedules at the regular cadence", async () => {
  const { loop, queue } = await harness(async () => ok(0));
  const r = await loop.tick();
  assert.equal(r.dispatched, 1);
  assert.deepEqual(await queue.due(NOW + 500_000, 10), [], "rescheduled too soon");
  assert.deepEqual(await queue.due(NOW + 700_000, 10), ["a"]);
});

test("finding unread messages makes the account warm", async () => {
  // Discovering a message IS the event that tightens cadence. Without this the
  // decay ladder never engages from inbound activity and every reply waits a
  // full regular interval.
  const { loop, queue, store } = await harness(async () => ok(3));
  await loop.tick();
  assert.equal((await store.get("a"))?.blob.meta.lastEventAt, NOW);
  assert.deepEqual(await queue.due(NOW + 80_000, 10), ["a"], "did not switch to the 60s tier");
});

test("a challenged account leaves the sweep and is not retried", async () => {
  // The single most important behaviour here. Re-checking a challenged account
  // is how a soft challenge becomes a permanent restriction.
  const { loop, queue, store } = await harness(async () => ({ outcome: "CHALLENGED", unread: null }));
  const r = await loop.tick();
  assert.equal(r.quarantined, 1);
  assert.equal(await queue.size(), 0, "challenged account was left in the sweep");
  assert.equal((await store.get("a"))?.blob.meta.health, "quarantined");
});

test("quarantine preserves the session rather than the challenge page", async () => {
  // The operator needs the session as it was to fix it. Whatever state the
  // challenge page left behind is not a session.
  const { loop, store } = await harness(async () => ({ outcome: "CHALLENGED", unread: null }));
  await loop.tick();
  assert.equal((await store.get("a"))?.blob.cookies[0]?.value, "tok");
});

test("an infrastructure error retries without touching account health", async () => {
  // Network failures say nothing about the account. Quarantining on them would
  // drain the fleet into the remediation queue during an ordinary outage.
  const { loop, queue, store } = await harness(async () => { throw new Error("ECONNRESET"); });
  const r = await loop.tick();
  assert.equal(r.errors, 1);
  assert.equal(r.quarantined, 0);
  assert.equal((await store.get("a"))?.blob.meta.health, "active");
  assert.deepEqual(await queue.due(NOW + 61_000, 10), ["a"]);
});

test("a tripped breaker stops all dispatch", async () => {
  const t = { v: NOW };
  const breaker = new CircuitBreaker({ minSamples: 1, threshold: 0.5 }, () => t.v);
  breaker.record("CHALLENGED");
  assert.equal(breaker.allows(), false);
  let called = 0;
  const { loop } = await harness(async () => { called++; return ok(); }, { breaker });
  const r = await loop.tick();
  assert.equal(r.halted, true);
  assert.equal(called, 0, "dispatched work while halted");
});

test("a profile held by the action path is skipped, not stolen", async () => {
  // Two browsers driving one session corrupts state and is plainly non-human.
  const { loop, lock } = await harness(async () => ok());
  await lock.acquire("a", 60_000);
  const r = await loop.tick();
  assert.equal(r.skippedLocked, 1);
  assert.equal(r.dispatched, 0);
});

test("the lock is released even when the check throws", async () => {
  // A leaked lock strands the account until its TTL expires — silently, and
  // for exactly the accounts that are already failing.
  const { loop, lock } = await harness(async () => { throw new Error("boom"); });
  await loop.tick();
  assert.equal(await lock.held("a"), false);
});

test("an account with no stored profile drops out instead of spinning", async () => {
  const { loop, queue, store } = await harness(async () => ok());
  await queue.schedule("never-onboarded", NOW - 1);
  await loop.tick();
  assert.equal(await store.get("never-onboarded"), null);
  assert.deepEqual(await queue.due(NOW + 10_000_000, 10), ["a"]);
});

test("concurrency bounds how many accounts are checked per tick", async () => {
  // Slots are the scarce resource. Dispatching the whole due backlog at once
  // is the stampede the ramp exists to prevent, arriving by another route.
  let inFlight = 0, peak = 0;
  const { loop } = await harness(async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--; return ok();
  }, { accounts: Array.from({ length: 20 }, (_, i) => `a${i}`) });
  const r = await loop.tick();
  assert.equal(r.dispatched, 4);
  assert.ok(peak <= 4, `exceeded concurrency: ${peak}`);
});

test("an uneventful check does not write a new version in steady state", async () => {
  // At 400 accounts this is ~73k versions a day, each replicated, recording
  // only that nothing happened. A bare updatedAt change is not state.
  //
  // The first check legitimately writes — lastOutcome moves from null to OK.
  // What must not accumulate is every check after that.
  const { loop, store, t } = await harness(async () => ok(0));
  await loop.tick();
  const afterFirst = (await store.versions("a")).length;
  t.v += 700_000;
  await loop.tick();
  t.v += 700_000;
  await loop.tick();
  assert.equal((await store.versions("a")).length, afterFirst, "wrote no-op versions");
});

test("but a newly warm account is persisted", async () => {
  // The skip must not swallow lastEventAt. Losing it would drop the account
  // back to the regular cadence with a reply sitting unanswered.
  const { loop, store } = await harness(async () => ok(2));
  const before = (await store.versions("a")).length;
  await loop.tick();
  assert.equal((await store.versions("a")).length, before + 1);
  assert.equal((await store.get("a"))?.blob.meta.lastEventAt, NOW);
});

test("a static unread count does not keep an account warm forever", async () => {
  // Found by running this against a live account. With `event = unread > 0`,
  // an inbox nobody clears reads as eventful on every check and pins the
  // account to the tightest cadence permanently — ten times the load, forever.
  const { loop, store, t } = await harness(async () => ok(15));
  await loop.tick();
  assert.equal((await store.get("a"))?.blob.meta.lastEventAt, NOW, "first sighting is an event");

  t.v += 80_000;
  await loop.tick();
  const settled = await store.get("a");
  assert.equal(settled?.blob.meta.lastEventAt, NOW, "same 15 messages counted as a new event");
  assert.equal(settled?.blob.meta.lastUnread, 15);
});

test("a genuinely new message re-warms the account", async () => {
  let unread = 15;
  const { loop, store, t } = await harness(async () => ok(unread));
  await loop.tick();
  t.v += 80_000;
  await loop.tick();
  unread = 16;
  t.v += 80_000;
  await loop.tick();
  assert.equal((await store.get("a"))?.blob.meta.lastEventAt, t.v, "16th message did not re-warm");
});

test("an unreadable signal does not reset the baseline", async () => {
  // If a failed read wrote lastUnread: null, the next check would see every
  // existing message as newly arrived and re-warm on nothing.
  let unread: number | null = 15;
  const { loop, store, t } = await harness(async () => ({ outcome: "OK", unread }));
  await loop.tick();
  assert.equal((await store.get("a"))?.blob.meta.lastUnread, 15);

  unread = null;                       // the title never settled this time
  t.v += 80_000;
  await loop.tick();
  assert.equal((await store.get("a"))?.blob.meta.lastUnread, 15, "baseline was reset by a blind check");

  unread = 15;                         // same inbox as before
  t.v += 80_000;
  const eventAt = (await store.get("a"))?.blob.meta.lastEventAt;
  await loop.tick();
  assert.equal((await store.get("a"))?.blob.meta.lastEventAt, eventAt, "re-warmed on nothing");
});

test("a new message emits an inbox event", async () => {
  // This is the signal the product surface is built on. If the sweep finds a
  // message and says nothing, the inbox is silently a day behind.
  const emitted: Array<{ kind: string; accountId: string }> = [];
  const { store } = await harness(async () => ok(0));
  const t = { v: NOW };
  const queue = new MemoryDueQueue();
  const lock = new MemoryProfileLock(() => t.v);
  await queue.schedule("a", NOW - 1);
  const loop = new DetectionLoop({
    queue, lock, breaker: new CircuitBreaker({}, () => t.v), store,
    check: async () => ok(4),
    emitEvent: async (e) => { emitted.push({ kind: e.kind, accountId: e.accountId }); },
    now: () => t.v, rand: () => 0.5,
    config: { concurrency: 2, lockTtlMs: 60_000, errorBackoffMs: 60_000 },
  });
  await loop.tick();
  assert.deepEqual(emitted, [{ kind: "unread_changed", accountId: "a" }]);
});

test("a failing event sink never costs a check", async () => {
  // The outbox is the durable path; handing over to it must not be able to
  // break detection.
  const { loop: _unused, store } = await harness(async () => ok(0));
  const t = { v: NOW };
  const queue = new MemoryDueQueue();
  await queue.schedule("a", NOW - 1);
  const loop = new DetectionLoop({
    queue, lock: new MemoryProfileLock(() => t.v),
    breaker: new CircuitBreaker({}, () => t.v), store,
    check: async () => ok(4),
    emitEvent: async () => { throw new Error("outbox on fire"); },
    now: () => t.v, rand: () => 0.5,
    config: { concurrency: 2, lockTtlMs: 60_000, errorBackoffMs: 60_000 },
  });
  const r = await loop.tick();
  assert.equal(r.dispatched, 1);
  assert.equal(r.errors, 0);
  assert.equal((await store.get("a"))?.blob.meta.lastUnread, 4);
});
