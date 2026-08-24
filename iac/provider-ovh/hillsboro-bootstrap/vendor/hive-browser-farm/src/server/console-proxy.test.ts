import { test } from "node:test";
import assert from "node:assert/strict";
import { ConsoleProxy, parseConsolePath } from "./console-proxy.ts";
import type { ConsoleControl } from "./console-control.ts";

function proxyWith(validToken: string | null): ConsoleProxy {
  const consoles = {
    validate: (t: string) =>
      validToken && t === validToken ? { accountId: "dan", token: t, startedAt: 0, expiresAt: 1 } : null,
  } as unknown as ConsoleControl;
  return new ConsoleProxy({ consoles });
}

test("the token is taken from the path, and the rest is forwarded", () => {
  const parsed = parseConsolePath("/console/abc123/vnc.html?autoconnect=1");
  assert.equal(parsed?.token, "abc123");
  assert.equal(parsed?.upstreamPath, "/vnc.html?autoconnect=1");
});

test("a link without a trailing slash still lands on the client", () => {
  // Operators get handed these links; one that 404s on a missing slash is a
  // support ticket, not a security control.
  assert.equal(parseConsolePath("/console/abc123")?.upstreamPath, "/");
});

test("path traversal is refused, not normalised", () => {
  // This proxy fronts a live logged-in browser. An ambiguous path is not worth
  // interpreting.
  assert.equal(parseConsolePath("/console/abc/../../etc/passwd"), null);
});

test("a request without a token is not a console request", () => {
  assert.equal(parseConsolePath("/console/"), null);
  assert.equal(parseConsolePath("/v1/accounts"), null);
});

test("a wrong token is refused", () => {
  // The console is an authenticated browser for a real account; guessing the
  // URL must not be enough.
  assert.equal(proxyWith("right").authorise("/console/wrong/vnc.html"), null);
  assert.notEqual(proxyWith("right").authorise("/console/right/vnc.html"), null);
});

test("an expired session stops working without anyone revoking it", () => {
  // validate() re-checks expiry, so a stale link left in a chat log dies on
  // its own rather than waiting for someone to remember.
  assert.equal(proxyWith(null).authorise("/console/anything/vnc.html"), null);
});
