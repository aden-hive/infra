/**
 * Detection sweep daemon.
 *
 * Rebuilds its schedule from the profile store at boot rather than persisting a
 * queue. Cadence is a pure function of each account's last event, so the queue
 * is derived state — which removes a whole class of "queue disagrees with
 * reality after a crash" bugs, and means there is nothing to migrate when the
 * action path later moves coordination into Redis.
 *
 *   PROFILE_ROOT   local store root      (default /var/lib/hive-profiles)
 *   PROXY_POOL     ip=proxyUrl,...       e.g. 135.148.52.236=http://127.0.0.1:3128
 *   BROWSER_URL    Chrome CDP endpoint   (default http://127.0.0.1:9222)
 *   CONCURRENCY    detection slots       (default 12)
 *   RAMP_MS        boot ramp window      (default 1800000)
 *   INGEST_URL     control-plane event ingest (optional)
 *   INGEST_TOKEN   bearer token for it
 *   BACKFILL_PER_SWEEP  conversations to fetch messages for per check (default 5)
 */
import puppeteer from "puppeteer-core";
import { LocalProfileStore } from "../store/local-store.ts";
import { MemoryDueQueue, MemoryProfileLock } from "../scheduler/queue.ts";
import { CircuitBreaker } from "../scheduler/breaker.ts";
import { DetectionLoop } from "../scheduler/loop.ts";
import { rampFleet } from "../scheduler/ramp.ts";
import { parsePool } from "../browser/egress.ts";
import { createBrowserCheck } from "../browser/check.ts";
import { Outbox, createHttpSink } from "../server/outbox.ts";
import { HeartbeatStore } from "../store/heartbeat.ts";
import { ThreadCache } from "../store/thread-cache.ts";
import { ThreadSyncStore } from "../store/thread-sync.ts";

const root = process.env.PROFILE_ROOT ?? "/var/lib/hive-profiles";
const poolSpec = process.env.PROXY_POOL;
const browserURL = process.env.BROWSER_URL ?? "http://127.0.0.1:9222";
const concurrency = Number.parseInt(process.env.CONCURRENCY ?? "12", 10);
const rampMs = Number.parseInt(process.env.RAMP_MS ?? "1800000", 10);

if (!poolSpec) {
  console.error("PROXY_POOL is required, e.g. 135.148.52.236=http://127.0.0.1:3128");
  process.exit(2);
}

const store = new LocalProfileStore(root);
await store.init();
const egress = parsePool(poolSpec);
const browser = await puppeteer.connect({ browserURL, defaultViewport: null });

// Events queue on disk whether or not the control plane is reachable. §8: a
// partition stalls the product surface, never the sweep.
const outbox = process.env.INGEST_URL && process.env.INGEST_TOKEN
  ? new Outbox({
      root,
      sink: createHttpSink({ url: process.env.INGEST_URL, token: process.env.INGEST_TOKEN }),
    })
  : null;
await outbox?.init();

const queue = new MemoryDueQueue();
const lock = new MemoryProfileLock();
const breaker = new CircuitBreaker();
const loop = new DetectionLoop({
  queue, lock, breaker, store,
  check: createBrowserCheck({
    browser, egress,
    threadSync: new ThreadSyncStore(root),
    backfillPerSweep: Number.parseInt(process.env.BACKFILL_PER_SWEEP ?? "5", 10),
  }),
  ...(outbox ? { emitEvent: (event) => outbox.enqueue(event) } : {}),
  heartbeats: new HeartbeatStore(root),
  threadCache: new ThreadCache(root),
  config: { concurrency, lockTtlMs: 120_000, errorBackoffMs: 60_000 },
});

// Only accounts that are actually runnable enter the sweep. Quarantined ones
// wait for a human in the remediation console; putting them back would re-check
// a challenged account, which is how a soft challenge becomes a restriction.
const accounts: string[] = [];
for (const id of await store.accounts()) {
  const stored = await store.get(id);
  if (stored && stored.blob.meta.health === "active") accounts.push(id);
}

// Spread the restart. Hundreds of sessions reconnecting inside a minute from a
// handful of addresses turns a clean recovery into a fleet-wide risk event.
for (const { accountId, at } of rampFleet(Date.now(), accounts, rampMs)) {
  await queue.schedule(accountId, at);
}

console.log(JSON.stringify({
  svc: "sweeper", event: "started",
  accounts: accounts.length, concurrency,
  egress: egress.list().map((b) => b.ip),
  rampMinutes: Math.round(rampMs / 60_000),
}));

outbox?.start(15_000, (r) => {
  if (r.failed > 0) {
    console.error(JSON.stringify({ svc: "outbox", ...r, at: new Date().toISOString() }));
  } else if (r.delivered > 0) {
    console.log(JSON.stringify({ svc: "outbox", ...r }));
  }
});

loop.start(1000, (r) => {
  if (r.halted) {
    const snap = breaker.snapshot();
    console.error(JSON.stringify({ svc: "sweeper", event: "HALTED", reason: snap.reason }));
    return;
  }
  if (r.dispatched > 0 || r.quarantined > 0) {
    console.log(JSON.stringify({ svc: "sweeper", ...r, at: new Date().toISOString() }));
  }
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    loop.stop();
    outbox?.stop();
    browser.disconnect();
    console.log(JSON.stringify({ svc: "sweeper", event: "stopped", signal }));
    process.exit(0);
  });
}
