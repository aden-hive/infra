import { test } from "node:test";
import assert from "node:assert/strict";
import { fanout, personalise, DEFAULT_FANOUT } from "./fanout.ts";
import { CONTRACT_VERSION, parseAction, type Action, type ActionResult } from "./contract.ts";

const react = parseAction(
  { type: "react_to_post", postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1/" },
  CONTRACT_VERSION,
);
const ok = (): ActionResult => ({ status: "ok", action: "react_to_post", data: {} });

function harness(behaviour: (id: string) => Promise<ActionResult>) {
  const slept: number[] = [];
  return {
    slept,
    run: (ids: string[], action: Action = react) =>
      fanout(async (id) => behaviour(id), ids, action, {
        ...DEFAULT_FANOUT, rand: () => 0.5,
        sleep: async (ms) => { slept.push(ms); },
      }),
  };
}

test("accounts are staggered, not fired in lockstep", async () => {
  // Three accounts reacting to one post in the same second from one egress is
  // not three users agreeing — it is a fleet announcing itself.
  const h = harness(async () => ok());
  await h.run(["a", "b", "c"]);
  assert.equal(h.slept.length, 2, "expected a gap between each pair, and none before the first");
  for (const gap of h.slept) {
    assert.ok(gap >= DEFAULT_FANOUT.minGapMs, `gap too small: ${gap}`);
    assert.ok(gap <= DEFAULT_FANOUT.maxGapMs, `gap too large: ${gap}`);
  }
});

test("the first account is not made to wait", async () => {
  // The gap separates accounts; it is not a delay on the operation.
  const h = harness(async () => ok());
  const results = await h.run(["only"]);
  assert.equal(h.slept.length, 0);
  assert.equal(results[0]?.gapBeforeMs, 0);
});

test("one account failing does not stop the others", async () => {
  // A partial result is useful. Aborting would force a re-run that re-fires
  // the accounts that already succeeded.
  const h = harness(async (id) =>
    id === "broken" ? { status: "failed", action: "react_to_post", reason: "nope" } : ok());
  const results = await h.run(["a", "broken", "c"]);
  assert.deepEqual(results.map((r) => r.result.status), ["ok", "failed", "ok"]);
});

test("a thrown executor is contained to its own account", async () => {
  const h = harness(async (id) => {
    if (id === "explodes") throw new Error("session died");
    return ok();
  });
  const results = await h.run(["a", "explodes", "c"]);
  assert.equal(results[1]?.result.status, "failed");
  assert.match(results[1]?.result.status === "failed" ? results[1].result.reason : "", /session died/);
  assert.equal(results[2]?.result.status, "ok");
});

test("each account's own id can vary the message text", async () => {
  // Identical text from several accounts to one person reads as coordinated in
  // a way identical reactions do not.
  const action = parseAction(
    { type: "send_message", profileUrl: "https://www.linkedin.com/in/x/", text: "hi from {{account}}" },
    CONTRACT_VERSION,
  );
  const seen: string[] = [];
  await fanout(async (_id, a) => {
    seen.push(a.type === "send_message" ? a.text : "");
    return { status: "ok", action: "send_message", data: {} };
  }, ["dan", "devin"], action, { ...DEFAULT_FANOUT, rand: () => 0.5, sleep: async () => {} });
  assert.deepEqual(seen, ["hi from dan", "hi from devin"]);
});

test("personalise leaves actions without templates untouched", () => {
  assert.deepEqual(personalise(react, "dan"), react);
});
