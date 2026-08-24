import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_VERSION, isWriteAction, parseAction } from "./contract.ts";

test("a version mismatch is refused, not interpreted", () => {
  // Acting on a misunderstood instruction with someone's real account is worse
  // than failing the call.
  assert.throws(
    () => parseAction({ type: "list_threads" }, CONTRACT_VERSION + 1),
    /contract mismatch/,
  );
});

test("outward-effecting actions are distinguishable from reads by type", () => {
  // The executor gates on this. If it were a naming convention rather than a
  // discriminated type, an added action would default to being treated as safe.
  assert.equal(isWriteAction(parseAction({ type: "list_threads" }, CONTRACT_VERSION)), false);
  assert.equal(isWriteAction(parseAction({ type: "read_thread", correspondent: "Ada L" }, CONTRACT_VERSION)), false);
  assert.equal(isWriteAction(parseAction({ type: "send_message", correspondent: "Ada L", text: "hi" }, CONTRACT_VERSION)), true);
  assert.equal(isWriteAction(parseAction({ type: "accept_invitation", invitationId: "i1" }, CONTRACT_VERSION)), true);
});

test("a malformed action is rejected before it reaches a browser", () => {
  assert.throws(() => parseAction({ type: "send_message", correspondent: "Ada L" }, CONTRACT_VERSION));
  assert.throws(() => parseAction({ type: "send_message", correspondent: "Ada L", text: "" }, CONTRACT_VERSION));
  assert.throws(() => parseAction({ type: "nonsense" }, CONTRACT_VERSION));
});

test("list limits are bounded so one call cannot become a scrape", () => {
  assert.throws(() => parseAction({ type: "list_threads", limit: 5000 }, CONTRACT_VERSION));
  const parsed = parseAction({ type: "list_threads" }, CONTRACT_VERSION);
  assert.equal(parsed.type === "list_threads" && parsed.limit, 20);
});

test("send_message requires exactly one addressing mode", () => {
  // Both would be ambiguous about which conversation is meant; neither leaves
  // the handler with no way to find a recipient.
  const ok = (raw: object) => parseAction({ type: "send_message", text: "hi", ...raw }, CONTRACT_VERSION);
  assert.doesNotThrow(() => ok({ correspondent: "Ada L" }));
  assert.doesNotThrow(() => ok({ profileUrl: "https://www.linkedin.com/in/someone/" }));
  assert.throws(() => ok({}), /exactly one/);
  assert.throws(() => ok({ correspondent: "Ada L", profileUrl: "https://www.linkedin.com/in/someone/" }), /exactly one/);
});

test("check_profile is a read, so connection status can be checked freely", () => {
  // Knowing whether an account can message a profile must not itself require
  // opening the write gate — otherwise the only way to find out is to try.
  const a = parseAction({ type: "check_profile", profileUrl: "https://www.linkedin.com/in/x/" }, CONTRACT_VERSION);
  assert.equal(isWriteAction(a), false);
});
