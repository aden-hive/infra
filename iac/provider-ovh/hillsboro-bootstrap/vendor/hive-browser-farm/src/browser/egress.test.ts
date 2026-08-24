import { test } from "node:test";
import assert from "node:assert/strict";
import { EgressPool, UnknownEgressError, parsePool } from "./egress.ts";

const BARE_METAL = "135.148.52.236";

test("the box's own address is an ordinary pool member", () => {
  // Starting with only the bare-metal IP must not need a "direct" special
  // case. If it did, adding failover IPs later would be a code change instead
  // of config — and every account onboarded before it would be on a path that
  // no longer exists.
  const pool = new EgressPool([{ ip: BARE_METAL, proxyUrl: "http://127.0.0.1:3128" }]);
  assert.equal(pool.resolve(BARE_METAL), "http://127.0.0.1:3128");
  assert.equal(pool.list().length, 1);
});

test("an unknown egress throws instead of falling back to another address", () => {
  // The dangerous failure is silent success: running an account from an IP it
  // never logged in from looks fine right up until it is challenged.
  const pool = new EgressPool([{ ip: BARE_METAL, proxyUrl: "http://127.0.0.1:3128" }]);
  assert.throws(() => pool.resolve("203.0.113.9"), UnknownEgressError);
});

test("renumbering local ports does not change an account's identity", () => {
  // Profiles bind to the public IP, not the loopback endpoint. Moving a proxy
  // to a different port is a deployment detail; if profiles stored the port it
  // would read as the account changing addresses.
  const before = new EgressPool([{ ip: BARE_METAL, proxyUrl: "http://127.0.0.1:3128" }]);
  const after = new EgressPool([{ ip: BARE_METAL, proxyUrl: "http://127.0.0.1:9999" }]);
  assert.notEqual(before.resolve(BARE_METAL), after.resolve(BARE_METAL));
  assert.ok(before.has(BARE_METAL) && after.has(BARE_METAL));
});

test("new profiles land on the least-loaded address", () => {
  // Assignment spreads fan-out. Only ever for a NEW profile — an existing one
  // moving addresses is the thing we are preventing.
  const pool = new EgressPool([
    { ip: BARE_METAL, proxyUrl: "http://127.0.0.1:3128", assigned: 18 },
    { ip: "203.0.113.10", proxyUrl: "http://127.0.0.1:3129", assigned: 4 },
  ]);
  assert.equal(pool.leastLoaded()?.ip, "203.0.113.10");
});

test("pool config parses from a single env var", () => {
  const pool = parsePool(`${BARE_METAL}=http://127.0.0.1:3128, 203.0.113.10=http://127.0.0.1:3129`);
  assert.equal(pool.list().length, 2);
  assert.equal(pool.resolve("203.0.113.10"), "http://127.0.0.1:3129");
});
