import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProfileStore } from "./local-store.ts";
import { SCHEMA_VERSION, type ProfileBlob } from "../profile/schema.ts";

function blobAt(updatedAt: number, cookieValue = "v"): ProfileBlob {
  return {
    meta: {
      accountId: "acct-1", schemaVersion: SCHEMA_VERSION, egressIp: "135.148.52.236",
      health: "active", lastEventAt: null, lastUnread: null, lastOutcome: null, updatedAt,
    },
    fingerprint: {
      userAgent: "UA", viewport: { width: 1280, height: 800 },
      timezone: "America/Los_Angeles", locale: "en-US", hardwareClass: "hc-1",
    },
    cookies: [{
      name: "li_at", value: cookieValue, domain: ".linkedin.com", path: "/",
      expires: 1, httpOnly: true, secure: true,
    }],
    localStorage: {},
  };
}

async function freshStore() {
  const root = await mkdtemp(join(tmpdir(), "bf-store-"));
  const store = new LocalProfileStore(root);
  await store.init();
  return { store, root };
}

test("a stored profile round-trips byte-for-byte", async () => {
  // The blob is an account's only credential. Anything lost between put and
  // get is a login that has to be redone by a human.
  const { store } = await freshStore();
  const original = blobAt(1_700_000_000_000, "session-token");
  await store.put(original);
  const loaded = await store.get("acct-1");
  assert.deepEqual(loaded?.blob, original);
});

test("get returns the newest version, not an arbitrary one", async () => {
  // Ordering is carried entirely by the key name. If lexical order ever stops
  // matching chronological order, hydration silently serves a stale session.
  const { store } = await freshStore();
  await store.put(blobAt(1_700_000_000_000, "old"));
  await store.put(blobAt(1_700_000_900_000, "new"));
  const loaded = await store.get("acct-1");
  assert.equal(loaded?.blob.cookies[0]?.value, "new");
  assert.equal((await store.versions("acct-1")).length, 2);
});

test("every write leaves a durable replication marker", async () => {
  // An in-memory queue would drop pending work on restart, and the dropped
  // items are exactly the versions that exist nowhere but this disk.
  const { store } = await freshStore();
  const key = await store.put(blobAt(1_700_000_000_000));
  assert.deepEqual(await store.pending(), [{ accountId: "acct-1", key }]);
  await store.clearPending("acct-1", key);
  assert.deepEqual(await store.pending(), []);
});

test("trim never deletes a version that has not reached GCS", async () => {
  // The whole point of the local store is that it is a cache. A version still
  // pending replication is not a cache entry — it is the only copy anywhere.
  const { store } = await freshStore();
  for (let i = 0; i < 5; i++) await store.put(blobAt(1_700_000_000_000 + i * 1000, `v${i}`));
  const removed = await store.trim("acct-1", 1);
  assert.equal(removed, 0, "trimmed an unreplicated version");
  assert.equal((await store.versions("acct-1")).length, 5);
});

test("trim keeps the newest N once replication has caught up", async () => {
  const { store } = await freshStore();
  for (let i = 0; i < 5; i++) await store.put(blobAt(1_700_000_000_000 + i * 1000, `v${i}`));
  for (const p of await store.pending()) await store.clearPending(p.accountId, p.key);
  await store.trim("acct-1", 2);
  const left = await store.versions("acct-1");
  assert.equal(left.length, 2);
  assert.equal((await store.get("acct-1"))?.blob.cookies[0]?.value, "v4");
});

test("a half-written file is never served as a profile", async () => {
  // Writes land under .tmp and are renamed into place. A crash mid-write must
  // leave the previous version intact rather than a truncated cookie jar.
  const { store, root } = await freshStore();
  await store.put(blobAt(1_700_000_000_000, "good"));
  await writeFile(join(root, "profiles", "acct-1", "9999999999999-deadbeef.json.tmp"), "{trunc");
  const loaded = await store.get("acct-1");
  assert.equal(loaded?.blob.cookies[0]?.value, "good");
  assert.ok((await readdir(join(root, "profiles", "acct-1"))).some((f) => f.endsWith(".tmp")));
});

test("accounts with no stored profile read as null, not as an error", async () => {
  // A newly registered account has no blob yet. The scheduler must treat that
  // as "needs onboarding", not as a store failure worth alerting on.
  const { store } = await freshStore();
  assert.equal(await store.get("never-seen"), null);
  assert.deepEqual(await store.versions("never-seen"), []);
});
