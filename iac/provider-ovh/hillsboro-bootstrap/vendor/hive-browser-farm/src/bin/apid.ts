/**
 * Action API daemon — the compute plane's boundary to hive-backend on GKE.
 *
 * Binds to loopback only. Caddy already terminates TLS on this host and
 * reverse-proxies; nothing here should be directly reachable, and the token is
 * a second layer rather than the only one.
 *
 *   PROFILE_ROOT   local store root
 *   PROXY_POOL     ip=proxyUrl,...
 *   BROWSER_URL    Chrome CDP endpoint
 *   API_TOKEN      shared secret (required)
 *   API_PORT       default 8088
 *   ALLOW_WRITES   "1" to permit outward-effecting actions
 *   INGEST_URL     control-plane inbox ingest (optional)
 *   INGEST_TOKEN   bearer token for it
 */
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
import { LocalProfileStore } from "../store/local-store.ts";
import { MemoryProfileLock } from "../scheduler/queue.ts";
import { CircuitBreaker } from "../scheduler/breaker.ts";
import { parsePool } from "../browser/egress.ts";
import { ActionExecutor } from "../actions/executor.ts";
import { createHandlers } from "../actions/handlers.ts";
import { RateLimiter } from "../actions/ratelimit.ts";
import { Api } from "../server/api.ts";
import { ConsoleControl } from "../server/console-control.ts";
import { ConsoleProxy } from "../server/console-proxy.ts";
import { OnboardingService } from "../onboard/lifecycle.ts";
import { HeartbeatStore } from "../store/heartbeat.ts";
import { ThreadCache } from "../store/thread-cache.ts";
import { AuditLog } from "../server/audit.ts";
import { Outbox, createHttpSink } from "../server/outbox.ts";
import { captureProfile } from "../profile/capture.ts";
import { classify, waitForMessagingTitle } from "../linkedin/classify.ts";
import { MESSAGING_URL } from "../browser/check.ts";
import type { Action } from "../actions/contract.ts";

const token = process.env.API_TOKEN;
if (!token || token.length < 16) {
  console.error("API_TOKEN is required and must be at least 16 characters");
  process.exit(2);
}
const root = process.env.PROFILE_ROOT ?? "/var/lib/hive-profiles";
const port = Number.parseInt(process.env.API_PORT ?? "8088", 10);
const allowWrites = process.env.ALLOW_WRITES === "1";

const store = new LocalProfileStore(root);
await store.init();

// Same durable outbox the sweeper uses: what an expensive read learns must
// survive a control-plane outage rather than being lost with the response.
const outbox = process.env.INGEST_URL && process.env.INGEST_TOKEN
  ? new Outbox({
      root,
      sink: createHttpSink({ url: process.env.INGEST_URL, token: process.env.INGEST_TOKEN }),
    })
  : null;
await outbox?.init();
// Logged, not silent. The sweeper reports its outbox results and this did not,
// so a delivery that failed every tick looked identical to one that never ran.
outbox?.start(15_000, (r) => {
  if (r.failed > 0) console.error(JSON.stringify({ svc: "apid", outbox: r, at: new Date().toISOString() }));
  else if (r.delivered > 0) console.log(JSON.stringify({ svc: "apid", outbox: r }));
});

const browserURL = process.env.BROWSER_URL ?? "http://127.0.0.1:9222";

/**
 * A live handle to Chrome that survives Chrome restarting.
 *
 * Puppeteer's connection dies permanently when the browser goes away, and a
 * long-running API that captured one at boot answers "Connection closed." for
 * every request thereafter — with no error in its own log, because nothing
 * threw on its side. Chrome restarts for ordinary reasons (a crash, a recycle,
 * an operator opening a repair console), so reconnecting is table stakes rather
 * than a nicety.
 */
let browser = await puppeteer.connect({ browserURL, defaultViewport: null });

async function liveBrowser(): Promise<typeof browser> {
  if (browser.connected) return browser;
  console.error(JSON.stringify({ svc: "apid", event: "browser_reconnecting", browserURL }));
  browser = await puppeteer.connect({ browserURL, defaultViewport: null });
  console.log(JSON.stringify({ svc: "apid", event: "browser_reconnected" }));
  return browser;
}

// One breaker and one lock for the whole process: the breaker governs the
// fleet, and the lock is what stops an action and the sweep driving one
// session at once.
const executor = new ActionExecutor({
  store,
  lock: new MemoryProfileLock(),
  egress: parsePool(process.env.PROXY_POOL!),
  // A getter, not a captured handle: every lease resolves the current
  // connection rather than the one that existed at boot.
  browser: () => browser,
  breaker: new CircuitBreaker(),
  limiter: new RateLimiter(root),
  handlers: createHandlers(outbox ? { emitEvent: (e) => outbox.enqueue(e as never) } : {}),
  config: { lockTtlMs: 180_000, leaseTimeoutMs: 180_000, allowWrites },
});

const egress = parsePool(process.env.PROXY_POOL!);

// The admin surface spawns privileged processes (Xvfb, a window manager,
// Chrome), so it is opt-in rather than always-on.
const adminEnabled = process.env.ADMIN_SURFACE === "1";
const consoles = adminEnabled
  ? new ConsoleControl({
      scriptPath: process.env.CONSOLE_SCRIPT ?? "./deploy/onboard-console.sh",
      profileDirFor: (accountId) => `/tmp/onboard-${accountId}`,
      // The operator's browser connects here directly; see ConsoleSession.url.
      publicBase: process.env.FARM_PUBLIC_BASE ?? "",
      // Repair happens at the account's own egress; anything else is the
      // anomaly §10 exists to prevent, committed while LinkedIn is watching.
      resolveProxy: async (accountId, egressIp) => {
        // Onboarding: no profile exists yet, so the address is a deliberate
        // choice the caller had to make. Validate it against the pool now
        // rather than at the first sweep — an account bound to an unreachable
        // egress can be onboarded and then never checked again.
        if (egressIp) return egress.resolve(egressIp);
        const stored = await store.get(accountId);
        if (!stored) throw new Error(`no profile for ${accountId}`);
        return egress.resolve(stored.blob.meta.egressIp);
      },
    })
  : undefined;

const onboarding = adminEnabled ? new OnboardingService({ store, egress }) : undefined;

/**
 * Re-check an account against the console session an operator just repaired.
 *
 * Captures from the console browser rather than the stored profile, because
 * the whole point is that the stored cookies were the broken ones — the good
 * session is the one sitting in front of the operator. Activation still depends
 * on what LinkedIn actually serves, never on the operator asserting they are
 * done: reactivating a still-challenged account is how a soft challenge becomes
 * a permanent restriction.
 */
async function reverify(accountId: string): Promise<{ activated: boolean; outcome: string; reason?: string }> {
  const stored = await store.get(accountId);
  if (!stored) return { activated: false, outcome: "ERROR", reason: `no profile for ${accountId}` };

  const live = await liveBrowser();
  const pages = await live.pages();
  const page = pages.find((p) => p.url().includes("linkedin.com")) ?? pages[0];
  if (!page) return { activated: false, outcome: "ERROR", reason: "console browser has no page" };

  await page.goto(MESSAGING_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForMessagingTitle(page);
  const state = await classify(page);

  const captured = await captureProfile(live, page, {
    accountId,
    egressIp: stored.blob.meta.egressIp,
    hardwareClass: stored.blob.fingerprint.hardwareClass,
    lastUnread: stored.blob.meta.lastUnread,
  });
  const result = await onboarding!.completeSession(accountId, captured, state.outcome);
  return {
    activated: result.activated,
    outcome: state.outcome,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

/**
 * Adopt the session a human just signed into, as a brand-new account.
 *
 * Mirrors `onboard adopt` in the CLI rather than reimplementing it: the live
 * console browser holds the good session, and the profile is captured from it.
 *
 * The egress binding is NOT taken from the request. It is the one the console
 * was actually launched behind, remembered at start — otherwise an operator
 * could sign in at one address and pin the account to another, which reads as
 * a device change to LinkedIn at the single worst moment for one.
 */
async function adoptConsoleSession(
  accountId: string,
  hardwareClass: string
): Promise<{ activated: boolean; outcome: string; reason?: string; cookies?: number }> {
  if (await store.get(accountId)) {
    return { activated: false, outcome: "ERROR", reason: `${accountId} already exists` };
  }
  const session = consoles?.active();
  if (!session || session.accountId !== accountId) {
    return { activated: false, outcome: "ERROR", reason: `no open console for ${accountId}` };
  }
  const egressIp = pendingEgress.get(accountId);
  if (!egressIp) {
    return { activated: false, outcome: "ERROR", reason: `no egress recorded for ${accountId}` };
  }

  // The console runs its own headful Chrome with CDP on CONSOLE_CDP_URL
  // (9223 by default) — a different browser from the headless fleet on
  // BROWSER_URL. Capturing the fleet would store a session the human never
  // touched, so connect to the console explicitly.
  const consoleBrowser = await puppeteer.connect({
    browserURL: process.env.CONSOLE_CDP_URL ?? "http://127.0.0.1:9223",
    defaultViewport: null,
  });
  try {
    const pages = await consoleBrowser.pages();
    const page = pages.find((p) => p.url().includes("linkedin.com")) ?? pages[0];
    if (!page) return { activated: false, outcome: "ERROR", reason: "console browser has no page" };

    await page.goto(MESSAGING_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForMessagingTitle(page);
    const state = await classify(page);
    if (state.outcome !== "OK") {
      return { activated: false, outcome: state.outcome, reason: `console session is ${state.outcome}` };
    }
    const captured = await captureProfile(consoleBrowser, page, { accountId, egressIp, hardwareClass });
    await store.put({
      ...captured,
      meta: { ...captured.meta, health: "active", lastOutcome: "OK" },
    });
    pendingEgress.delete(accountId);
    return { activated: true, outcome: "OK", cookies: captured.cookies.length };
  } finally {
    // Disconnect the client; do NOT close the browser — the operator's console
    // stays up until they close it, and closing it here would kill the very
    // session just captured.
    consoleBrowser.disconnect();
  }
}

/**
 * Egress chosen for an account whose profile does not exist yet.
 *
 * In memory on purpose: it is only meaningful between opening a console and
 * adopting the session, which is one operator sitting at one screen. A restart
 * loses it and the operator starts the flow again — better than a half-created
 * profile pinned to an address nobody chose.
 */
const pendingEgress = new Map<string, string>();

const api = new Api({
  store, token, allowWrites,
  execute: async (accountId, action) => {
    await liveBrowser();
    return executor.execute(accountId, action as Action);
  },
  heartbeats: new HeartbeatStore(root),
  threadCache: new ThreadCache(root),
  ...(consoles ? { consoles } : {}),
  ...(onboarding ? { onboarding, reverify } : {}),
  ...(adminEnabled
    ? {
        egressPool: () => egress.list().map((b) => b.ip),
        beginOnboarding: async (accountId: string, egressIp: string) => {
          if (await store.get(accountId)) throw new Error(`${accountId} already exists`);
          const session = await consoles!.start(accountId, egressIp);
          pendingEgress.set(accountId, egressIp);
          return session;
        },
        adoptConsoleSession,
      }
    : {}),
  ...(adminEnabled ? { audit: new AuditLog(root) } : {}),
});

const consoleProxy = consoles ? new ConsoleProxy({ consoles }) : null;

const server = createServer((req, res) => {
  // Console traffic is checked before anything else and never falls through to
  // the API's bearer auth — it carries its own single-use session token, and
  // an unauthorised request must not be distinguishable from a missing route.
  if (consoleProxy && (req.url ?? "").startsWith("/console/")) {
    const parsed = consoleProxy.authorise(req.url ?? "");
    if (!parsed) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    consoleProxy.handleHttp(req, res, parsed);
    return;
  }
  void api.handle(req, res).catch(() => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal" }));
  });
});

// noVNC streams RFB over a WebSocket. An upgrade that skipped the token check
// would be the only door that mattered.
server.on("upgrade", (req, socket, head) => {
  const parsed = consoleProxy?.authorise(req.url ?? "");
  if (!parsed) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  consoleProxy!.handleUpgrade(req, socket, head, parsed);
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({
    svc: "apid", event: "listening", port, allowWrites,
    adminSurface: adminEnabled, bind: "127.0.0.1",
  }));
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close();
    browser.disconnect();
    console.log(JSON.stringify({ svc: "apid", event: "stopped", signal }));
    process.exit(0);
  });
}
