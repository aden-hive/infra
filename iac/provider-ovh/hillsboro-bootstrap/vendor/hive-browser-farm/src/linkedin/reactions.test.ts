import { test } from "node:test";
import assert from "node:assert/strict";
import { activityIdFromUrn, assertOnLinkedIn } from "./reactions.ts";
import { REACTIONS, parseAction, CONTRACT_VERSION, isWriteAction } from "../actions/contract.ts";

test("all six LinkedIn reactions are accepted", () => {
  assert.deepEqual([...REACTIONS], ["like", "celebrate", "support", "love", "insightful", "funny"]);
  for (const r of REACTIONS) {
    const a = parseAction({ type: "react_to_post", postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1/", reaction: r }, CONTRACT_VERSION);
    assert.equal(a.type === "react_to_post" && a.reaction, r);
  }
});

test("reaction defaults to like when unspecified", () => {
  // Like is the default because a plain click applies it; every other reaction
  // needs the hover picker, which is a more fragile interaction.
  const a = parseAction({ type: "react_to_post", postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1/" }, CONTRACT_VERSION);
  assert.equal(a.type === "react_to_post" && a.reaction, "like");
});

test("reacting is gated as a write", () => {
  // It sends no text but is public: it surfaces to the author and into the
  // reacting account's network. Same gate as a message.
  const a = parseAction({ type: "react_to_post", postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1/" }, CONTRACT_VERSION);
  assert.equal(isWriteAction(a), true);
});

test("an invented reaction is rejected", () => {
  assert.throws(() => parseAction(
    { type: "react_to_post", postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1/", reaction: "angry" },
    CONTRACT_VERSION));
});

test("a non-URL post reference is rejected before a browser is involved", () => {
  assert.throws(() => parseAction({ type: "react_to_post", postUrl: "activity:123" }, CONTRACT_VERSION));
});

test("the activity id is extracted from the post URN", () => {
  assert.equal(activityIdFromUrn("urn:li:activity:7444448933759778835"), "7444448933759778835");
  assert.equal(activityIdFromUrn(null), null);
  assert.equal(activityIdFromUrn("urn:li:share:123"), null);
});

test("a non-LinkedIn or non-http post URL is rejected", () => {
  // This value gets navigated to, so the scheme and host are validated rather
  // than trusted. `z.string().url()` alone accepts both of these.
  const bad = (postUrl: string): void => {
    assert.throws(() => parseAction({ type: "react_to_post", postUrl }, CONTRACT_VERSION), `accepted ${postUrl}`);
  };
  bad("activity:123");
  bad("javascript:alert(1)");
  bad("https://example.com/feed/update/urn:li:activity:1/");
  bad("file:///etc/passwd");
});

test("lnkd.in shortlinks are accepted as input", () => {
  const a = parseAction({ type: "react_to_post", postUrl: "https://lnkd.in/p/geemFJFx" }, CONTRACT_VERSION);
  assert.equal(a.type === "react_to_post" && a.reaction, "like");
});

test("but a shortlink that lands off LinkedIn is refused before any click", () => {
  // A shortener resolves wherever it likes. Accepting lnkd.in at the contract
  // boundary is only safe because the landing host is re-checked.
  assert.throws(() => assertOnLinkedIn("https://evil.example.com/post"), /refusing to act/);
  assert.doesNotThrow(() => assertOnLinkedIn("https://www.linkedin.com/feed/update/urn:li:activity:1/"));
});
