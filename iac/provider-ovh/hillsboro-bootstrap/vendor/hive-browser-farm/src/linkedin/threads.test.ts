import { test } from "node:test";
import assert from "node:assert/strict";
import { threadIdFromUrl } from "./threads.ts";

test("the canonical thread id comes out of an open thread's URL", () => {
  // Measured: the list DOM carries no durable identifier, so this URL is the
  // only place a stable id exists.
  assert.equal(
    threadIdFromUrl("https://www.linkedin.com/messaging/thread/2-ZmJkNzU1MzYtMjRm==/"),
    "2-ZmJkNzU1MzYtMjRm==",
  );
});

test("a plain messaging URL yields no id rather than a bogus one", () => {
  // list_threads runs on /messaging/ with nothing open. Returning a fabricated
  // id there would give callers something that looks addressable and is not.
  assert.equal(threadIdFromUrl("https://www.linkedin.com/messaging/"), null);
  assert.equal(threadIdFromUrl("https://www.linkedin.com/feed/"), null);
});

test("screen-reader affordances are not mistaken for the message preview", () => {
  // Rows carry a11y strings alongside the text, and they are often the longest
  // line — so "longest wins" showed "Open the options list in your conversation
  // with …" where the actual message should be.
  const AFFORDANCE = /^(\.|Open the options list|Press return|Active conversation|Select conversation)/i;
  const DATE_ONLY = /^(\w{3} \d{1,2}|\d{1,2}:\d{2}\s?(AM|PM)?|Yesterday|Today)$/i;
  const pick = (raw: string, who: string): string =>
    raw.split("\n").map((l) => l.trim())
      .filter((l) => l && !AFFORDANCE.test(l) && !DATE_ONLY.test(l) && l !== who)
      .sort((a, b) => b.length - a.length)[0] ?? "";

  const row = [
    "Ada Lovelace", "Aug 20", "Aug 20",
    "Ada: short note",
    "Open the options list in your conversation with Ada Lovelace and Someone Else",
    ". Active conversation",
  ].join("\n");
  assert.equal(pick(row, "Ada Lovelace"), "Ada: short note");
});
