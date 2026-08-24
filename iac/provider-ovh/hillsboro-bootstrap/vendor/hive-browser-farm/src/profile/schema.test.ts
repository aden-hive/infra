import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProfileBlob, SCHEMA_VERSION } from "./schema.ts";

/** A blob as written before `lastUnread` existed. */
const legacy = {
  meta: {
    accountId: "acct-1", schemaVersion: SCHEMA_VERSION, egressIp: "135.148.52.236",
    health: "active", lastEventAt: null, lastOutcome: "OK", updatedAt: 1_700_000_000_000,
  },
  fingerprint: {
    userAgent: "UA", viewport: { width: 1280, height: 800 },
    timezone: "America/Los_Angeles", locale: "en-US", hardwareClass: "hc-1",
  },
  cookies: [{ name: "li_at", value: "tok", domain: ".linkedin.com", path: "/",
              expires: 1, httpOnly: true, secure: true }],
  localStorage: {},
};

test("a profile written before a field existed still loads", () => {
  // This broke a live sweep: adding lastUnread as required made every stored
  // profile fail to parse, and a profile that will not parse is an account
  // that needs a human to log in again.
  const blob = parseProfileBlob(legacy);
  assert.equal(blob.meta.lastUnread, null);
  assert.equal(blob.meta.accountId, "acct-1");
  assert.equal(blob.cookies[0]?.value, "tok");
});

test("a corrupt profile is still rejected", () => {
  // Tolerating missing optional fields must not slide into tolerating a
  // damaged cookie jar.
  assert.throws(() => parseProfileBlob({ ...legacy, cookies: "not-an-array" }));
  assert.throws(() => parseProfileBlob({ ...legacy, meta: { ...legacy.meta, egressIp: "" } }));
});
