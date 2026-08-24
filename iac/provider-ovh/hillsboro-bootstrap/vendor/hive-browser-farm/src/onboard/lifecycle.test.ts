import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OnboardingService } from "./lifecycle.ts";
import { LocalProfileStore } from "../store/local-store.ts";
import { EgressPool } from "../browser/egress.ts";
import { SCHEMA_VERSION, type Health, type LeaseOutcome, type ProfileBlob } from "../profile/schema.ts";

const NOW = 1_700_000_000_000;
const BARE = "135.148.52.236";
const OTHER = "203.0.113.10";

function blob(accountId: string, o: {
  health?: Health; lastOutcome?: LeaseOutcome | null; egressIp?: string;
  lastEventAt?: number | null; hardwareClass?: string; cookie?: string;
} = {}): ProfileBlob {
  return {
    meta: {
      accountId, schemaVersion: SCHEMA_VERSION, egressIp: o.egressIp ?? BARE,
      health: o.health ?? "active", lastEventAt: o.lastEventAt ?? null, lastUnread: null,
      lastOutcome: o.lastOutcome ?? null, updatedAt: NOW - 1000,
    },
    fingerprint: {
      userAgent: "UA", viewport: { width: 1280, height: 800 },
      timezone: "America/Los_Angeles", locale: "en-US",
      hardwareClass: o.hardwareClass ?? "hc-1",
    },
    cookies: [{ name: "li_at", value: o.cookie ?? "tok", domain: ".linkedin.com",
                path: "/", expires: 1, httpOnly: true, secure: true }],
    localStorage: {},
  };
}

async function harness() {
  const store = new LocalProfileStore(await mkdtemp(join(tmpdir(), "bf-onb-")));
  await store.init();
  const egress = new EgressPool([
    { ip: BARE, proxyUrl: "http://127.0.0.1:3128" },
    { ip: OTHER, proxyUrl: "http://127.0.0.1:3129" },
  ]);
  return { store, svc: new OnboardingService({ store, egress, now: () => NOW }) };
}

test("the remediation queue lists exactly what a human must fix", async () => {
  const { store, svc } = await harness();
  await store.put(blob("healthy"));
  await store.put(blob("stuck", { health: "quarantined", lastOutcome: "CHALLENGED" }));
  const items = await svc.needsAttention();
  assert.deepEqual(items.map((i) => i.accountId), ["stuck"]);
  assert.match(items[0]!.reason, /verification challenge/);
});

test("re-auth happens on the account's existing address, never a new one", async () => {
  // The whole sequencing rule in one assertion. Logging back in from a
  // different IP is the anomaly this design exists to avoid, committed at the
  // moment LinkedIn is watching hardest.
  const { store, svc } = await harness();
  await store.put(blob("stuck", { health: "quarantined", egressIp: OTHER }));
  const session = await svc.beginSession("stuck");
  assert.equal(session.proxyUrl, "http://127.0.0.1:3129");
});

test("a session cannot be started on an address with no proxy", async () => {
  // Better to refuse than to silently onboard from whatever is available.
  const { store, svc } = await harness();
  await store.put(blob("orphan", { health: "quarantined", egressIp: "198.51.100.7" }));
  await assert.rejects(() => svc.beginSession("orphan"), /no local proxy/);
});

test("an account is only reactivated when the live page verifies OK", async () => {
  // The operator saying "done" is not evidence. Trusting it would put a
  // still-challenged account back into rotation, which is how a soft challenge
  // becomes a permanent restriction.
  const { store, svc } = await harness();
  await store.put(blob("stuck", { health: "quarantined", lastOutcome: "CHALLENGED" }));
  const result = await svc.completeSession("stuck", blob("stuck", { cookie: "new" }), "CHALLENGED");
  assert.equal(result.activated, false);
  assert.equal((await store.get("stuck"))?.blob.meta.health, "quarantined");
});

test("a verified session returns the account to the sweep", async () => {
  const { store, svc } = await harness();
  await store.put(blob("stuck", { health: "quarantined", lastOutcome: "LOGGED_OUT" }));
  const result = await svc.completeSession("stuck", blob("stuck", { cookie: "fresh" }), "OK");
  assert.equal(result.activated, true);
  const after = await store.get("stuck");
  assert.equal(after?.blob.meta.health, "active");
  assert.equal(after?.blob.meta.lastOutcome, "OK");
  assert.equal(after?.blob.cookies[0]?.value, "fresh");
});

test("re-auth never reassigns egress or hardware class", async () => {
  // A capture taken during onboarding can carry whatever the session browser
  // happened to be. Identity has to survive re-auth untouched — a new address
  // or a new hardware class is a different device to the platform.
  const { store, svc } = await harness();
  await store.put(blob("stuck", { health: "quarantined", egressIp: OTHER, hardwareClass: "hc-7" }));
  const captured = blob("stuck", { egressIp: BARE, hardwareClass: "wrong-class", cookie: "fresh" });
  await svc.completeSession("stuck", captured, "OK");
  const after = await store.get("stuck");
  assert.equal(after?.blob.meta.egressIp, OTHER, "egress was reassigned during re-auth");
  assert.equal(after?.blob.fingerprint.hardwareClass, "hc-7");
});

test("a recovered account rejoins at the regular cadence, not warm", async () => {
  // Inheriting warmth from before it broke would put a just-recovered account
  // straight onto 60s polling — the tightest cadence, on the least trusted
  // session in the fleet.
  const { store, svc } = await harness();
  await store.put(blob("stuck", { health: "quarantined", lastEventAt: NOW - 60_000 }));
  await svc.completeSession("stuck", blob("stuck"), "OK");
  assert.equal((await store.get("stuck"))?.blob.meta.lastEventAt, null);
});

test("an in-progress session is visible so abandoned ones can be found", async () => {
  // Without this an operator who closes the tab leaves the account invisible:
  // out of the sweep, and absent from the queue that would surface it.
  const { store, svc } = await harness();
  await store.put(blob("stuck", { health: "quarantined" }));
  await svc.beginSession("stuck");
  const items = await svc.needsAttention();
  assert.equal(items[0]?.health, "onboarding");
  assert.match(items[0]!.reason, /in progress or abandoned/);
});

test("retiring keeps the account out of both the sweep and the queue's active work", async () => {
  const { store, svc } = await harness();
  await store.put(blob("old"));
  await svc.retire("old");
  const items = await svc.needsAttention();
  assert.equal(items[0]?.reason, "retired");
  assert.equal((await store.get("old"))?.blob.meta.health, "retired");
});
