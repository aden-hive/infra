import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ConsoleControl } from "./console-control.ts";

function fakeSpawn(exitCode = 0) {
  const calls: Array<Record<string, string | undefined>> = [];
  const fn = ((_cmd: string, _args: string[], opts: { env?: Record<string, string | undefined> }) => {
    calls.push(opts.env ?? {});
    const em = new EventEmitter();
    queueMicrotask(() => em.emit("exit", exitCode));
    return em;
  }) as never;
  return { fn, calls };
}

function make(clock: { v: number }, exitCode = 0) {
  const spawned = fakeSpawn(exitCode);
  return {
    spawned,
    control: new ConsoleControl({
      scriptPath: "/opt/console.sh",
      profileDirFor: (id) => `/tmp/onboard-${id}`,
      resolveProxy: async () => "http://127.0.0.1:3128",
      now: () => clock.v,
      spawnFn: spawned.fn,
      ttlMs: 60_000,
    }),
  };
}

test("starting a console runs it at the account's own egress", async () => {
  // A repair session that reaches LinkedIn from a different address than the
  // account normally uses is the anomaly §10 exists to prevent.
  const c = { v: 1000 };
  const { control, spawned } = make(c);
  await control.start("dan");
  assert.equal(spawned.calls[0]?.PROXY, "http://127.0.0.1:3128");
  assert.equal(spawned.calls[0]?.PROFILE_DIR, "/tmp/onboard-dan");
});

test("a second console for a different account is refused, not silently swapped", async () => {
  // The script binds fixed ports, so starting another kills the first —
  // discarding a verification an operator may be halfway through.
  const c = { v: 1000 };
  const { control } = make(c);
  await control.start("dan");
  await assert.rejects(() => control.start("devin"), /already open for "dan"/);
});

test("re-requesting the same account returns the running session", async () => {
  // An operator refreshing the panel must not be told their own console is a
  // conflict.
  const c = { v: 1000 };
  const { control } = make(c);
  const first = await control.start("dan");
  const again = await control.start("dan");
  assert.equal(again.token, first.token);
});

test("access requires the session token", async () => {
  // The console is a live authenticated browser for a real account. A URL
  // anyone can reach is not an acceptable control for that.
  const c = { v: 1000 };
  const { control } = make(c);
  const session = await control.start("dan");
  assert.equal(control.validate("wrong")?.accountId, undefined);
  assert.equal(control.validate(session.token)?.accountId, "dan");
});

test("a session expires, freeing the slot", async () => {
  // Without expiry an abandoned console holds the single slot forever and
  // blocks every other account's repair.
  const c = { v: 1000 };
  const { control } = make(c);
  const session = await control.start("dan");
  c.v += 61_000;
  assert.equal(control.active(), null);
  assert.equal(control.validate(session.token), null);
  await assert.doesNotReject(() => control.start("devin"));
});

test("stopping frees the slot immediately", async () => {
  const c = { v: 1000 };
  const { control } = make(c);
  await control.start("dan");
  await control.stop();
  assert.equal(control.active(), null);
  await assert.doesNotReject(() => control.start("devin"));
});

test("the console URL is absolute, on the farm's own host", async () => {
  // VNC is a continuous stream. A relative URL resolves against whatever origin
  // the panel is served from, which would relay a video-rate stream through the
  // site and the control plane — metered egress and a transatlantic hop per
  // keystroke, for bytes that are free on this box.
  const c = { v: 1000 };
  const spawned = fakeSpawn(0);
  const control = new ConsoleControl({
    scriptPath: "/opt/console.sh",
    profileDirFor: (id) => `/tmp/${id}`,
    resolveProxy: async () => "http://127.0.0.1:3128",
    publicBase: "https://vm.open-hive.com/",
    now: () => c.v, spawnFn: spawned.fn,
  });
  const session = await control.start("dan");
  assert.match(session.url, /^https:\/\/vm\.open-hive\.com\/console\/[\w-]+\/vnc\.html\?/);
  // noVNC dials the site root unless told otherwise, which lands outside the
  // token-scoped prefix and fails after the page has already loaded.
  const path = new URL(session.url).searchParams.get("path");
  assert.equal(path, `console/${session.token}/websockify`);
  assert.equal(new URL(session.url).searchParams.get("autoconnect"), "true");
});

test("a session with a live viewer does not time out", async () => {
  // The failure this prevents: an operator halfway through clearing a
  // verification loses the console, and noVNC reports "Failed to connect to
  // server" — which reads as VNC being broken rather than the session ending.
  const c = { v: 1000 };
  const { control } = make(c);
  await control.start("dan");
  control.openConnection();
  c.v += 10 * 60_000;              // well past the 60s idle window
  assert.notEqual(control.active(), null, "expired while someone was watching");
});

test("the idle clock resumes once the viewer disconnects", async () => {
  const c = { v: 1000 };
  const { control } = make(c);
  await control.start("dan");
  control.openConnection();
  c.v += 5 * 60_000;
  control.closeConnection();       // idle window restarts from here
  c.v += 30_000;
  assert.notEqual(control.active(), null, "expired too early after disconnect");
  c.v += 40_000;
  assert.equal(control.active(), null, "never expired after the viewer left");
});

test("using the console pushes the idle deadline out", async () => {
  // Loading assets and reconnecting count as use; a session should not die
  // between two clicks a minute apart.
  const c = { v: 1000 };
  const { control } = make(c);
  const s = await control.start("dan");
  c.v += 50_000;
  assert.notEqual(control.validate(s.token), null);
  c.v += 50_000;                   // 100s total, past the raw 60s TTL
  assert.notEqual(control.active(), null, "idle deadline was not extended by use");
});

test("stopping clears viewers so the slot is genuinely free", async () => {
  const c = { v: 1000 };
  const { control } = make(c);
  await control.start("dan");
  control.openConnection();
  await control.stop();
  assert.equal(control.active(), null);
  assert.equal(control.connectionCount(), 0);
  await assert.doesNotReject(() => control.start("devin"));
});
