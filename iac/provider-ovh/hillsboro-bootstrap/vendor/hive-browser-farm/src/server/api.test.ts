import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "./api.ts";
import { LocalProfileStore } from "../store/local-store.ts";
import { CONTRACT_VERSION, type ActionResult } from "../actions/contract.ts";

const TOKEN = "s3cret-token-value";
const react = {
  type: "react_to_post",
  postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
};

async function harness(execute: (id: string, a: unknown) => Promise<ActionResult>) {
  const store = new LocalProfileStore(await mkdtemp(join(tmpdir(), "bf-api-")));
  await store.init();
  return new Api({ store, execute, token: TOKEN, allowWrites: true });
}

const okResult = (): ActionResult => ({ status: "ok", action: "react_to_post", data: { applied: true } });

test("a mismatched contract version is refused, not interpreted", async () => {
  // Acting on a misunderstood instruction with someone's real account is worse
  // than failing the call.
  const api = await harness(async () => okResult());
  const r = await api.action({ accountId: "dan", contractVersion: CONTRACT_VERSION + 1, action: react });
  assert.equal(r.status, 400);
});

test("an unknown action shape never reaches a browser", async () => {
  let called = false;
  const api = await harness(async () => { called = true; return okResult(); });
  const r = await api.action({ accountId: "dan", contractVersion: CONTRACT_VERSION, action: { type: "rm_rf" } });
  assert.equal(r.status, 400);
  assert.equal(called, false);
});

test("a retried request does not act twice", async () => {
  // This is a WAN call: a client that times out cannot distinguish a lost
  // request from a lost response. Without idempotency, its retry sends a
  // second message to a real person.
  let calls = 0;
  const api = await harness(async () => { calls++; return okResult(); });
  const body = { accountId: "dan", contractVersion: CONTRACT_VERSION, action: react, idempotencyKey: "abc" };
  const first = await api.action(body);
  const second = await api.action(body);
  assert.equal(calls, 1, "executed twice for one idempotency key");
  assert.equal(first.status, 200);
  assert.equal((second.body as { replayed?: boolean }).replayed, true);
});

test("concurrent retries of one key collapse to a single execution", async () => {
  // A timeout-and-retry usually overlaps the original rather than following it.
  let calls = 0;
  const api = await harness(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
    return okResult();
  });
  const body = { accountId: "dan", contractVersion: CONTRACT_VERSION, action: react, idempotencyKey: "same" };
  await Promise.all([api.action(body), api.action(body), api.action(body)]);
  assert.equal(calls, 1, "overlapping retries each reached the browser");
});

test("failures are not cached, so a transient fault stays retryable", async () => {
  // Caching a failure would pin it for the idempotency window and make a
  // momentary network blip look permanent.
  let calls = 0;
  const api = await harness(async () => {
    calls++;
    return calls === 1
      ? { status: "failed", action: "react_to_post", reason: "network blip" }
      : okResult();
  });
  const body = { accountId: "dan", contractVersion: CONTRACT_VERSION, action: react, idempotencyKey: "k" };
  assert.equal((await api.action(body)).status, 502);
  assert.equal((await api.action(body)).status, 200);
  assert.equal(calls, 2);
});

test("a refusal is 409, distinct from an execution failure", async () => {
  // The status code carries the retry policy: 409 will refuse again, 502 may
  // not. Collapsing them invites retrying a refusal in a loop.
  const api = await harness(async () => ({ status: "refused", action: "react_to_post", reason: "quarantined" }));
  assert.equal((await api.action({ accountId: "dan", contractVersion: CONTRACT_VERSION, action: react })).status, 409);
});

test("accountId is required", async () => {
  const api = await harness(async () => okResult());
  assert.equal((await api.action({ contractVersion: CONTRACT_VERSION, action: react })).status, 400);
});

test("fan-out defaults to active accounts and reports per account", async () => {
  const api = await harness(async (id) =>
    id === "broken"
      ? { status: "failed", action: "react_to_post", reason: "nope" }
      : okResult());
  const r = await api.fanout({
    contractVersion: CONTRACT_VERSION, action: react,
    accountIds: ["a", "broken"], minGapMs: 0, maxGapMs: 0,
  });
  assert.equal(r.status, 200);
  const results = (r.body as { results: Array<{ result: ActionResult }> }).results;
  assert.deepEqual(results.map((x) => x.result.status), ["ok", "failed"]);
});

test("admin routes are absent unless the admin surface is enabled", async () => {
  // The console spawns privileged processes. A deployment that does not want
  // that should not merely hide the button.
  const api = await harness(async () => okResult());
  assert.equal((await api.console("GET", {})).status, 404);
});

test("a console cannot be opened for an account that does not exist", async () => {
  const store = new LocalProfileStore(await mkdtemp(join(tmpdir(), "bf-api2-")));
  await store.init();
  const api = new Api({
    store, execute: async () => okResult(), token: TOKEN, allowWrites: false,
    consoles: { active: () => null, start: async () => { throw new Error("should not start"); },
                stop: async () => {}, validate: () => null } as never,
  });
  assert.equal((await api.console("POST", { accountId: "ghost" })).status, 404);
});

test("reverify reactivates only when LinkedIn is satisfied", async () => {
  // The operator saying "done" is not evidence. Reactivating a still-challenged
  // account is how a soft challenge becomes a permanent restriction.
  const store = new LocalProfileStore(await mkdtemp(join(tmpdir(), "bf-rv-")));
  await store.init();
  let outcome = "CHALLENGED";
  const api = new Api({
    store, execute: async () => okResult(), token: TOKEN, allowWrites: false,
    reverify: async () => outcome === "OK"
      ? { activated: true, outcome }
      : { activated: false, outcome, reason: `session still ${outcome}` },
  });
  const stillBroken = await api.handleReverify("dan");
  assert.equal(stillBroken.status, 409, "reactivated a still-challenged account");
  outcome = "OK";
  assert.equal((await api.handleReverify("dan")).status, 200);
});

async function adminHarness(execute: (id: string, a: unknown) => Promise<ActionResult>) {
  const store = new LocalProfileStore(await mkdtemp(join(tmpdir(), "bf-adm-")));
  await store.init();
  const recorded: unknown[] = [];
  const api = new Api({
    store, execute, token: TOKEN, allowWrites: true,
    audit: { record: async (e: unknown) => { recorded.push(e) }, recent: async () => [] } as never,
  });
  return { api, recorded };
}

test("an operator action must say who is acting", async () => {
  // An unattributed send is exactly what the audit log exists to prevent.
  const { api } = await adminHarness(async () => okResult());
  const r = await api.adminAction(
    { accountId: "dan", contractVersion: CONTRACT_VERSION, action: react }, undefined);
  assert.equal(r.status, 400);
});

test("every operator action is attributed and recorded", async () => {
  const { api, recorded } = await adminHarness(async () => okResult());
  await api.adminAction(
    { accountId: "dan", contractVersion: CONTRACT_VERSION, action: react }, "staff@open-hive.com");
  assert.equal((recorded[0] as { actor: string }).actor, "staff@open-hive.com");
  assert.equal((recorded[0] as { accountId: string }).accountId, "dan");
  assert.equal((recorded[0] as { target: string }).target, react.postUrl);
});

test("a refusal is recorded too, with its reason", async () => {
  // "Nothing happened" and "someone tried and was stopped" are different facts.
  const { api, recorded } = await adminHarness(async () =>
    ({ status: "refused", action: "react_to_post", reason: "quarantined" }));
  const r = await api.adminAction(
    { accountId: "dan", contractVersion: CONTRACT_VERSION, action: react }, "staff@open-hive.com");
  assert.equal(r.status, 409);
  assert.equal((recorded[0] as { outcome: string }).outcome, "refused");
  assert.equal((recorded[0] as { reason: string }).reason, "quarantined");
});

test("actions with no button are refused even though the contract allows them", async () => {
  // Invitations carry weekly caps and campaign-stop semantics. A one-off admin
  // click is the wrong shape for spending a scarce account-wide budget.
  let reached = false;
  const { api } = await adminHarness(async () => { reached = true; return okResult() });
  const r = await api.adminAction({
    accountId: "dan", contractVersion: CONTRACT_VERSION,
    action: { type: "send_connection_request", profileUrl: "https://www.linkedin.com/in/x/" },
  }, "staff@open-hive.com");
  assert.equal(r.status, 403);
  assert.equal(reached, false);
});

async function onboardHarness(over: Record<string, unknown> = {}) {
  const store = new LocalProfileStore(await mkdtemp(join(tmpdir(), "bf-onb-api-")));
  await store.init();
  const opened: Array<{ accountId: string; egressIp: string }> = [];
  const api = new Api({
    store,
    execute: async () => okResult(),
    token: TOKEN,
    allowWrites: true,
    egressPool: () => ["135.148.52.236", "51.222.10.4"],
    beginOnboarding: async (accountId: string, egressIp: string) => {
      opened.push({ accountId, egressIp });
      return { accountId, url: "https://console/vnc.html" };
    },
    adoptConsoleSession: async () => ({ activated: true, outcome: "OK", cookies: 491 }),
    ...over,
  });
  return { api, opened };
}

test("onboarding refuses to pick an egress address for you", async () => {
  // The binding is permanent for the life of the account. Defaulting it is how
  // ten accounts silently end up sharing one datacenter address — the property
  // §6 calls the most detectable thing about the fleet.
  const { api, opened } = await onboardHarness();
  const r = await api.beginOnboard({ accountId: "dan" });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(r.body), /egressIp is required/);
  assert.equal(opened.length, 0, "no console may open without a chosen address");
});

test("the chosen egress is the one the console is opened behind", async () => {
  const { api, opened } = await onboardHarness();
  const r = await api.beginOnboard({ accountId: "dan", egressIp: "51.222.10.4" });
  assert.equal(r.status, 200);
  assert.deepEqual(opened, [{ accountId: "dan", egressIp: "51.222.10.4" }]);
});

test("an account id that could confuse a path or a store key is refused", async () => {
  const { api } = await onboardHarness();
  for (const bad of ["../etc", "a b", "dan/../root", ""]) {
    const r = await api.beginOnboard({ accountId: bad, egressIp: "135.148.52.236" });
    assert.equal(r.status, 400, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test("a duplicate account is refused rather than reopened", async () => {
  const { api } = await onboardHarness({
    beginOnboarding: async () => { throw new Error("dan already exists"); },
  });
  const r = await api.beginOnboard({ accountId: "dan", egressIp: "135.148.52.236" });
  assert.equal(r.status, 409);
});

test("egress listing carries how many accounts each address already holds", async () => {
  // The count is the decision. Showing the address without it asks an operator
  // to make a permanent choice with the relevant number offscreen.
  const { api } = await onboardHarness();
  const r = await api.egress();
  assert.equal(r.status, 200);
  const body = r.body as { addresses: Array<{ ip: string; accounts: number }> };
  assert.deepEqual(body.addresses.map((a) => a.ip), ["135.148.52.236", "51.222.10.4"]);
  assert.equal(body.addresses.every((a) => typeof a.accounts === "number"), true);
});

test("a still-challenged session is reported, not raised as an error", async () => {
  // The operator needs the outcome. A 500 here reads as "the tool broke" when
  // the truth is "LinkedIn is still showing a checkpoint".
  const { api } = await onboardHarness({
    adoptConsoleSession: async () => ({ activated: false, outcome: "CHALLENGED", reason: "still CHALLENGED" }),
  });
  const r = await api.adoptOnboard({ accountId: "dan" });
  assert.equal(r.status, 200);
  assert.equal((r.body as { activated: boolean }).activated, false);
});
