import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUrl } from "./classify.ts";

test("a checkpoint after submitting credentials is verification, not rejection", () => {
  // These need different handling: verification means the password worked and a
  // human must supply a code; rejection means the credentials are wrong.
  // Treating a checkpoint as a bad password would send someone hunting for a
  // typo that does not exist — and retrying would escalate the challenge.
  assert.equal(classifyUrl("https://www.linkedin.com/checkpoint/challenge/AgH", "Verify").outcome, "CHALLENGED");
  assert.equal(classifyUrl("https://www.linkedin.com/login", "Sign In").outcome, "LOGGED_OUT");
});

test("a successful login lands somewhere that is neither", () => {
  assert.equal(classifyUrl("https://www.linkedin.com/feed/", "Feed | LinkedIn").outcome, "OK");
});
