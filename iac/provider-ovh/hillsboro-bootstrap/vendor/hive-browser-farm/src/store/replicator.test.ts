import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProfileStore } from "./local-store.ts";
import { Replicator, type ObjectUploader } from "./replicator.ts";
import { SCHEMA_VERSION, type ProfileBlob } from "../profile/schema.ts";

function blobAt(updatedAt: number, v = "v"): ProfileBlob {
  return {
    meta: { accountId: "acct-1", schemaVersion: SCHEMA_VERSION, egressIp: "135.148.52.236",
            health: "active", lastEventAt: null, lastUnread: null, lastOutcome: null, updatedAt },
    fingerprint: { userAgent: "UA", viewport: { width: 1, height: 1 },
                   timezone: "UTC", locale: "en", hardwareClass: "hc" },
    cookies: [{ name: "li_at", value: v, domain: ".linkedin.com", path: "/",
                expires: 1, httpOnly: true, secure: true }],
    localStorage: {},
  };
}

async function harness(uploader: ObjectUploader, now?: () => number) {
  const store = new LocalProfileStore(await mkdtemp(join(tmpdir(), "bf-rep-")));
  await store.init();
  return { store, rep: new Replicator({ store, uploader, ...(now ? { now } : {}) }) };
}

test("pending versions reach storage and stop being pending", async () => {
  const seen: string[] = [];
  const { store, rep } = await harness({
    async upload(path) { seen.push(path); return "uploaded"; },
  });
  await store.put(blobAt(1_700_000_000_000));
  const result = await rep.replicateOnce();
  assert.equal(result.uploaded, 1);
  assert.match(seen[0]!, /^profiles\/acct-1\/1700000000000-[0-9a-f]{8}\.json$/);
  assert.deepEqual(await store.pending(), []);
});

test("a failed upload keeps the marker so the work is not lost", async () => {
  // This is the entire reason the backlog lives on disk. A version that failed
  // to replicate exists only on one machine; forgetting it is unrecoverable.
  const { store, rep } = await harness({
    async upload() { throw new Error("network down"); },
  });
  await store.put(blobAt(1_700_000_000_000));
  const result = await rep.replicateOnce();
  assert.equal(result.failed, 1);
  assert.equal((await store.pending()).length, 1, "marker was dropped after a failure");
});

test("a retry after an outage drains the backlog", async () => {
  let up = false;
  const { store, rep } = await harness({
    async upload() { if (!up) throw new Error("down"); return "uploaded"; },
  });
  await store.put(blobAt(1_700_000_000_000));
  await store.put(blobAt(1_700_000_001_000, "b"));
  await rep.replicateOnce();
  assert.equal((await store.pending()).length, 2);
  up = true;
  const result = await rep.replicateOnce();
  assert.equal(result.uploaded, 2);
  assert.deepEqual(await store.pending(), []);
});

test("an object that already exists counts as done, not as a conflict", async () => {
  // Keys are content-derived, so a key present remotely holds identical bytes.
  // Treating that as an error would stall the backlog behind it forever.
  const { store, rep } = await harness({
    async upload() { return "already-exists"; },
  });
  await store.put(blobAt(1_700_000_000_000));
  const result = await rep.replicateOnce();
  assert.equal(result.alreadyPresent, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(await store.pending(), []);
});

test("lag reports the age of the oldest un-replicated version", async () => {
  // This is the live RPO. §9 targets under a minute, and it can only be
  // alerted on if the number reflects the oldest stuck item, not the newest.
  const now = 1_700_000_120_000;
  const { store, rep } = await harness(
    { async upload() { throw new Error("down"); } },
    () => now,
  );
  await store.put(blobAt(1_700_000_000_000));
  await store.put(blobAt(1_700_000_060_000, "b"));
  const result = await rep.replicateOnce();
  assert.equal(result.lagMs, 120_000, "lag should track the oldest, not the newest");
});

test("a clean backlog reports zero lag", async () => {
  const { rep } = await harness({ async upload() { return "uploaded"; } });
  assert.deepEqual(await rep.replicateOnce(),
    { uploaded: 0, alreadyPresent: 0, failed: 0, lagMs: 0 });
});

test("the poll timer keeps the daemon alive", async () => {
  // The replicator daemon has no server and no socket: this timer is the only
  // handle on its event loop. Unref'd, the process exits 0 immediately after
  // start() and systemd restarts it forever, logging "started" and replicating
  // nothing — which is how the profile bucket stayed empty while the service
  // looked healthy. A liveness bug that reads as a working service.
  const store = new (class {
    async pending() { return []; }
    async read() { return Buffer.alloc(0); }
    async clearPending() {}
  })() as never;
  const uploader = { async upload() { return "uploaded" as const; } };
  const replicator = new Replicator({ store, uploader });
  replicator.start(60_000);
  const timer = (replicator as unknown as { timer: NodeJS.Timeout }).timer;
  assert.equal(typeof timer.hasRef, "function");
  assert.equal(timer.hasRef(), true, "timer must hold the event loop open");
  replicator.stop();
});
