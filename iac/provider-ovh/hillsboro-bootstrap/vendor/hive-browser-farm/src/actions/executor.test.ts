import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "puppeteer-core";
import { ActionExecutor } from "./executor.ts";
import { CONTRACT_VERSION, parseAction } from "./contract.ts";
import { LocalProfileStore } from "../store/local-store.ts";
import { MemoryProfileLock } from "../scheduler/queue.ts";
import { CircuitBreaker } from "../scheduler/breaker.ts";
import { EgressPool } from "../browser/egress.ts";
import { SCHEMA_VERSION, type Health, type ProfileBlob } from "../profile/schema.ts";

const NOW = 1_700_000_000_000;
const IP = "135.148.52.236";

function blob(accountId: string, health: Health = "active", egressIp = IP): ProfileBlob {
  return {
    meta: { accountId, schemaVersion: SCHEMA_VERSION, egressIp, health,
            lastEventAt: null, lastUnread: null, lastOutcome: null, updatedAt: NOW },
    fingerprint: { userAgent: "UA", viewport: { width: 1280, height: 800 },
                   timezone: "America/Los_Angeles", locale: "en-US", hardwareClass: "hc-1" },
    cookies: [{ name: "li_at", value: "tok", domain: ".linkedin.com", path: "/",
                expires: 1, httpOnly: true, secure: true }],
    localStorage: {},
  };
}

// The guards below all resolve before a browser is touched; a stub proves the
// refusal happened for the stated reason and not because a browser was missing.
const noBrowser = {} as Browser;

async function harness(opts: { health?: Health; allowWrites?: boolean; breaker?: CircuitBreaker } = {}) {
  const store = new LocalProfileStore(await mkdtemp(join(tmpdir(), "bf-act-")));
  await store.init();
  await store.put(blob("acct-1", opts.health ?? "active"));
  const lock = new MemoryProfileLock(() => NOW);
  const exec = new ActionExecutor({
    store, lock,
    egress: new EgressPool([{ ip: IP, proxyUrl: "http://127.0.0.1:3128" }]),
    browser: noBrowser,
    handlers: { list_threads: async () => [] },
    ...(opts.breaker ? { breaker: opts.breaker } : {}),
    now: () => NOW,
    config: { lockTtlMs: 180_000, leaseTimeoutMs: 150_000, allowWrites: opts.allowWrites ?? false },
  });
  return { exec, lock, store };
}

const read = parseAction({ type: "list_threads" }, CONTRACT_VERSION);
const write = parseAction({ type: "send_message", correspondent: "Ada L", text: "hi" }, CONTRACT_VERSION);

test("writes are refused unless explicitly enabled", async () => {
  // A sent message is not recoverable and the blast radius of an agent bug is
  // other people's inboxes. Off by default, on by deliberate configuration.
  const { exec } = await harness();
  const r = await exec.execute("acct-1", write);
  assert.equal(r.status, "refused");
  assert.match(r.status === "refused" ? r.reason : "", /writes are disabled/);
});

test("a tripped breaker stops actions, not just the sweep", async () => {
  // If challenges are spiking, driving accounts harder is the worst available
  // response — and the action path is the harder driving.
  const breaker = new CircuitBreaker({ minSamples: 1, threshold: 0.5 }, () => NOW);
  breaker.record("CHALLENGED");
  const { exec } = await harness({ breaker });
  const r = await exec.execute("acct-1", read);
  assert.equal(r.status, "refused");
  assert.match(r.status === "refused" ? r.reason : "", /circuit breaker/);
});

test("a quarantined account is never acted on", async () => {
  const { exec } = await harness({ health: "quarantined" });
  const r = await exec.execute("acct-1", read);
  assert.equal(r.status, "refused");
  assert.match(r.status === "refused" ? r.reason : "", /quarantined/);
});

test("an account the sweep is holding is left alone, not stolen", async () => {
  // Same lock as detection. Stealing it would put two browsers on one session.
  const { exec, lock } = await harness();
  await lock.acquire("acct-1", 60_000);
  const r = await exec.execute("acct-1", read);
  assert.equal(r.status, "refused");
  assert.match(r.status === "refused" ? r.reason : "", /busy/);
});

test("an unknown account is refused rather than silently no-oped", async () => {
  const { exec } = await harness();
  const r = await exec.execute("ghost", read);
  assert.equal(r.status, "refused");
  assert.match(r.status === "refused" ? r.reason : "", /no profile/);
});

test("an account whose egress has no proxy is refused", async () => {
  // Acting from a different address than the account logged in on is the
  // anomaly the whole design avoids.
  const store = new LocalProfileStore(await mkdtemp(join(tmpdir(), "bf-act2-")));
  await store.init();
  await store.put(blob("acct-1", "active", "203.0.113.99"));
  const exec = new ActionExecutor({
    store, lock: new MemoryProfileLock(() => NOW),
    egress: new EgressPool([{ ip: IP, proxyUrl: "http://127.0.0.1:3128" }]),
    browser: noBrowser, handlers: { list_threads: async () => [] }, now: () => NOW,
  });
  const r = await exec.execute("acct-1", read);
  assert.equal(r.status, "refused");
  assert.match(r.status === "refused" ? r.reason : "", /no local proxy/);
});

test("a refusal leaves the profile unlocked for the sweep", async () => {
  // A refusal that stranded the lock would take the account out of detection
  // for the whole TTL, silently.
  const { exec, lock } = await harness({ health: "quarantined" });
  await exec.execute("acct-1", read);
  assert.equal(await lock.held("acct-1"), false);
});

test("a browser failure is 'failed', not 'refused', and releases the lock", async () => {
  // The distinction is the caller's retry policy: a refusal will refuse again,
  // a failure may be transient. Collapsing them invites retrying a refusal in
  // a loop against an unhealthy account.
  const { exec, lock } = await harness();
  const r = await exec.execute("acct-1", read);
  assert.equal(r.status, "failed");
  assert.equal(await lock.held("acct-1"), false);
});
