import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUrl, unreadFromTitle } from "./classify.ts";

test("a checkpoint redirect is CHALLENGED, never ERROR", () => {
  // The single most important distinction in the system. ERROR means the
  // scheduler retries; retrying a challenged account escalates a soft
  // challenge into a permanent restriction across the fleet.
  const c = classifyUrl("https://www.linkedin.com/checkpoint/challenge/xyz", "Security Verification");
  assert.equal(c.outcome, "CHALLENGED");
});

test("a login redirect is LOGGED_OUT so the account routes to re-auth", () => {
  // LOGGED_OUT sends the account to the remediation queue for a human.
  // Misreading it as OK would leave a dead account silently in rotation.
  assert.equal(classifyUrl("https://www.linkedin.com/login", "Sign In").outcome, "LOGGED_OUT");
});

test("a normal messaging page is OK", () => {
  assert.equal(
    classifyUrl("https://www.linkedin.com/messaging/", "(3) Messaging | LinkedIn").outcome,
    "OK",
  );
});

test("restriction outranks challenge when both patterns could match", () => {
  // A restricted account must not be handed back to the retry path that a
  // plain challenge would allow.
  const c = classifyUrl("https://www.linkedin.com/checkpoint/lg/login-submit", "Restricted");
  assert.equal(c.outcome, "RESTRICTED");
});

test("unread count comes from the title", () => {
  assert.equal(unreadFromTitle("(3) Messaging | LinkedIn"), 3);
  assert.equal(unreadFromTitle("(12) LinkedIn"), 12);
});

test("no count in the title means zero unread, not a parse failure", () => {
  // These are different states: null here means "read the page, nothing new".
  // Treating it as an error would alert on the most common outcome.
  assert.equal(unreadFromTitle("Messaging | LinkedIn"), null);
  assert.equal(unreadFromTitle(""), null);
});
