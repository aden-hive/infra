import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LocalProfileStore } from "../store/local-store.ts";
import type { ActionResult } from "../actions/contract.ts";
import { CONTRACT_VERSION, parseAction } from "../actions/contract.ts";
import { fanout, DEFAULT_FANOUT } from "../actions/fanout.ts";
import type { ConsoleControl } from "./console-control.ts";
import type { OnboardingService } from "../onboard/lifecycle.ts";
import { isStale, type HeartbeatStore } from "../store/heartbeat.ts";
import type { ThreadCache } from "../store/thread-cache.ts";
import type { AuditLog } from "./audit.ts";
import { isWriteAction } from "../actions/contract.ts";

/**
 * The compute plane's HTTP surface — §8's cluster boundary made real.
 *
 * Deliberately coarse: every endpoint here takes a whole intent and returns a
 * whole outcome. There is **no endpoint that proxies CDP**, and adding one
 * would end the two-cluster design — it would immediately become the default
 * path, putting 10-30 WAN round trips inside every agent turn and re-coupling
 * GKE to LinkedIn's DOM.
 *
 * Binds to loopback; Caddy terminates TLS in front of it, matching the existing
 * deployment. Nothing here should ever be reachable directly.
 */
export interface ApiDeps {
  store: LocalProfileStore;
  execute: (accountId: string, action: unknown) => Promise<ActionResult>;
  /** Shared secret. hive-backend already uses this pattern for the e2b API. */
  token: string;
  /** Server-side write gate, independent of what a caller asks for. */
  allowWrites: boolean;
  /** Optional admin surface: omit and the /v1/admin/* routes 404. */
  consoles?: ConsoleControl;
  onboarding?: OnboardingService;
  /** Addresses an account may be pinned to. Admin surface only. */
  egressPool?: () => string[];
  beginOnboarding?: (accountId: string, egressIp: string) => Promise<unknown>;
  adoptConsoleSession?: (
    accountId: string,
    hardwareClass: string
  ) => Promise<{ activated: boolean; outcome: string; reason?: string; cookies?: number }>;
  heartbeats?: HeartbeatStore;
  threadCache?: ThreadCache;
  audit?: AuditLog;
  /**
   * Re-check an account against the live console session and reactivate it if
   * LinkedIn is satisfied. Closes the remediation loop inside the panel rather
   * than leaving an operator to finish from a shell.
   */
  reverify?: (accountId: string) => Promise<{ activated: boolean; outcome: string; reason?: string }>;
  now?: () => number;
}

interface CachedResponse { status: number; body: unknown; at: number; }

/** Replays are answered from here rather than re-executed. */
const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

export class Api {
  private readonly deps: ApiDeps;
  private readonly seen = new Map<string, CachedResponse>();
  private readonly inFlight = new Map<string, Promise<CachedResponse>>();

  constructor(deps: ApiDeps) {
    this.deps = deps;
  }

  private authorised(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expected = this.deps.token;
    // Compare in constant time and only after length-padding, so neither the
    // token's length nor its prefix leaks through response timing.
    const a = Buffer.from(presented.padEnd(expected.length, "\0").slice(0, expected.length));
    const b = Buffer.from(expected);
    return presented.length === expected.length && timingSafeEqual(a, b);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/health") return send(200, { ok: true, contractVersion: CONTRACT_VERSION });
    if (!this.authorised(req)) return send(401, { error: "unauthorized" });

    try {
      if (req.method === "GET" && url.pathname === "/v1/accounts") {
        return send(200, { accounts: await this.accounts() });
      }
      if (req.method === "POST" && url.pathname === "/v1/actions") {
        const { status, body } = await this.action(await readJson(req));
        return send(status, body);
      }
      if (req.method === "POST" && url.pathname === "/v1/fanout") {
        const { status, body } = await this.fanout(await readJson(req));
        return send(status, body);
      }
      if (req.method === "GET" && url.pathname === "/v1/admin/accounts") {
        return send(200, { accounts: await this.adminAccounts() });
      }
      if (req.method === "GET" && url.pathname === "/v1/admin/threads") {
        const accountId = url.searchParams.get("accountId") ?? "";
        if (!accountId) return send(400, { error: "accountId is required" });
        const hit = (await this.deps.threadCache?.get(accountId)) ?? null;
        // null capturedAt means never swept — distinct from an empty list,
        // which means we looked and there was nothing.
        return send(200, {
          threads: hit?.threads ?? [],
          capturedAt: hit?.capturedAt ?? null,
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/admin/attention") {
        if (!this.deps.onboarding) return send(404, { error: "admin surface not enabled" });
        return send(200, { items: await this.deps.onboarding.needsAttention() });
      }
      if (req.method === "POST" && url.pathname === "/v1/admin/actions") {
        const { status, body } = await this.adminAction(
          await readJson(req),
          req.headers["x-actor"] as string | undefined,
        );
        return send(status, body);
      }
      if (req.method === "GET" && url.pathname === "/v1/admin/audit") {
        if (!this.deps.audit) return send(404, { error: "admin surface not enabled" });
        return send(200, { entries: await this.deps.audit.recent(50) });
      }
      if (req.method === "POST" && url.pathname === "/v1/admin/reverify") {
        const payload = await readJson(req);
        const accountId = typeof payload.accountId === "string" ? payload.accountId : "";
        if (!accountId) return send(400, { error: "accountId is required" });
        const reverified = await this.handleReverify(accountId);
        return send(reverified.status, reverified.body);
      }
      // The addresses an account may be pinned to, with how many are already
      // on each. §6: the threshold is a count, not a date, and the binding is
      // permanent — so the count belongs in front of whoever is choosing.
      if (req.method === "GET" && url.pathname === "/v1/admin/egress") {
        const { status, body } = await this.egress();
        return send(status, body);
      }

      if (req.method === "POST" && url.pathname === "/v1/admin/onboard") {
        const { status, body } = await this.beginOnboard(await readJson(req));
        return send(status, body);
      }
      if (req.method === "POST" && url.pathname === "/v1/admin/onboard/adopt") {
        const { status, body } = await this.adoptOnboard(await readJson(req));
        return send(status, body);
      }
      if (url.pathname === "/v1/admin/console") {
        const { status, body } = await this.console(req.method ?? "GET", await readJson(req));
        return send(status, body);
      }
      return send(404, { error: "not found" });
    } catch (err) {
      return send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * The addresses an account may be pinned to, with how many already sit on
   * each. §6: the binding is permanent and the threshold is a count, not a
   * date — so the count belongs in front of whoever is choosing, at the moment
   * they choose.
   */
  async egress(): Promise<{ status: number; body: unknown }> {
    if (!this.deps.egressPool) return { status: 404, body: { error: "admin surface not enabled" } };
    const used = new Map<string, number>();
    for (const a of await this.accounts()) used.set(a.egressIp, (used.get(a.egressIp) ?? 0) + 1);
    return {
      status: 200,
      body: { addresses: this.deps.egressPool().map((ip) => ({ ip, accounts: used.get(ip) ?? 0 })) },
    };
  }

  /**
   * Open a console for an account that does not exist yet.
   *
   * Creates no profile: one appears only once a real session has been captured
   * and verified, so an abandoned attempt leaves nothing half-made behind.
   */
  async beginOnboard(payload: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    if (!this.deps.beginOnboarding) {
      return { status: 404, body: { error: "admin surface not enabled" } };
    }
    const accountId = typeof payload.accountId === "string" ? payload.accountId.trim() : "";
    const egressIp = typeof payload.egressIp === "string" ? payload.egressIp.trim() : "";
    if (!accountId) return { status: 400, body: { error: "accountId is required" } };
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(accountId)) {
      return {
        status: 400,
        body: { error: "accountId may contain letters, digits, dot, dash and underscore" },
      };
    }
    // Never defaulted. The address is permanent for the life of the account,
    // and choosing one silently is exactly how ten accounts end up sharing one.
    if (!egressIp) return { status: 400, body: { error: "egressIp is required" } };
    try {
      const session = await this.deps.beginOnboarding(accountId, egressIp);
      return { status: 200, body: { accountId, egressIp, console: session } };
    } catch (err) {
      return { status: 409, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  /** Capture the signed-in console session as a new, active account. */
  async adoptOnboard(payload: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    if (!this.deps.adoptConsoleSession) {
      return { status: 404, body: { error: "admin surface not enabled" } };
    }
    const accountId = typeof payload.accountId === "string" ? payload.accountId.trim() : "";
    if (!accountId) return { status: 400, body: { error: "accountId is required" } };
    const hardwareClass =
      typeof payload.hardwareClass === "string" && payload.hardwareClass ? payload.hardwareClass : "hc-1";
    // 200 with activated:false is deliberate: "LinkedIn still shows a
    // challenge" is a real answer to a well-formed request, and the operator
    // needs that outcome rather than an error page.
    return { status: 200, body: await this.deps.adoptConsoleSession(accountId, hardwareClass) };
  }

  async accounts(): Promise<Array<{ accountId: string; health: string; egressIp: string }>> {
    const out = [];
    for (const accountId of await this.deps.store.accounts()) {
      const p = await this.deps.store.get(accountId);
      if (!p) continue;
      out.push({
        accountId, health: p.blob.meta.health, egressIp: p.blob.meta.egressIp,
      });
    }
    return out;
  }

  /**
   * Execute one action.
   *
   * `idempotencyKey` matters more here than it looks. This is a WAN call, so a
   * client that times out cannot tell a lost request from a lost response — and
   * a naive retry of `send_message` sends the message twice, to a real person.
   * A repeated key returns the first outcome instead of acting again.
   */
  async action(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    if (!accountId) return { status: 400, body: { error: "accountId is required" } };
    const version = typeof body.contractVersion === "number" ? body.contractVersion : -1;

    let action;
    try {
      action = parseAction(body.action, version);
    } catch (err) {
      return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
    }

    const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
    if (key) {
      const cached = this.replay(key);
      if (cached) return { status: cached.status, body: { ...(cached.body as object), replayed: true } };
      // Collapse concurrent duplicates too: two in-flight retries of the same
      // key must not both reach the browser.
      const running = this.inFlight.get(key);
      if (running) {
        const settled = await running;
        return { status: settled.status, body: { ...(settled.body as object), replayed: true } };
      }
    }

    const work = (async (): Promise<CachedResponse> => {
      const result = await this.deps.execute(accountId, action);
      const status = result.status === "ok" ? 200 : result.status === "refused" ? 409 : 502;
      return { status, body: result, at: this.deps.now?.() ?? Date.now() };
    })();

    if (key) this.inFlight.set(key, work);
    try {
      const settled = await work;
      // Only successes are cached. A refusal or failure should be retryable —
      // caching them would pin a transient fault for a day.
      if (key && settled.status === 200) this.seen.set(key, settled);
      return { status: settled.status, body: settled.body };
    } finally {
      if (key) this.inFlight.delete(key);
    }
  }

  async fanout(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const version = typeof body.contractVersion === "number" ? body.contractVersion : -1;
    let action;
    try {
      action = parseAction(body.action, version);
    } catch (err) {
      return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
    }
    const requested = Array.isArray(body.accountIds) ? body.accountIds.filter((a): a is string => typeof a === "string") : null;
    const accountIds = requested ?? (await this.accounts())
      .filter((a) => a.health === "active").map((a) => a.accountId);
    if (accountIds.length === 0) return { status: 400, body: { error: "no active accounts" } };

    const results = await fanout(
      (accountId, a) => this.deps.execute(accountId, a),
      accountIds, action,
      {
        minGapMs: numberOr(body.minGapMs, DEFAULT_FANOUT.minGapMs),
        maxGapMs: numberOr(body.maxGapMs, DEFAULT_FANOUT.maxGapMs),
      },
    );
    return { status: 200, body: { results } };
  }

  /**
   * Everything an operator needs to triage an account at a glance.
   *
   * Deliberately includes `versions`: a profile that has stopped accumulating
   * versions is one the sweep is no longer touching, which is the quiet
   * failure that a health field alone does not surface.
   */
  async adminAccounts(): Promise<unknown[]> {
    const out = [];
    for (const accountId of await this.deps.store.accounts()) {
      const p = await this.deps.store.get(accountId);
      if (!p) continue;
      const { meta } = p.blob;
      const heartbeat = (await this.deps.heartbeats?.get(accountId)) ?? null;
      const now = this.deps.now?.() ?? Date.now();
      out.push({
        accountId,
        health: meta.health,
        // The honest liveness signal. `updatedAt` below is when the profile was
        // last *written*, which is not the same thing and must not be read as one.
        lastCheckedAt: heartbeat?.lastCheckedAt ?? null,
        consecutiveFailures: heartbeat?.consecutiveFailures ?? 0,
        stale: meta.health === "active" && isStale(heartbeat, now),
        egressIp: meta.egressIp,
        hardwareClass: p.blob.fingerprint.hardwareClass,
        lastOutcome: meta.lastOutcome,
        lastEventAt: meta.lastEventAt,
        lastUnread: meta.lastUnread,
        updatedAt: meta.updatedAt,
        cookies: p.blob.cookies.length,
        versions: (await this.deps.store.versions(accountId)).length,
      });
    }
    return out;
  }

  /** Start, inspect, or stop the single noVNC repair console. */
  async console(method: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const consoles = this.deps.consoles;
    if (!consoles) return { status: 404, body: { error: "admin surface not enabled" } };

    if (method === "GET") return { status: 200, body: { session: consoles.active() } };
    if (method === "DELETE") {
      await consoles.stop();
      return { status: 200, body: { stopped: true } };
    }
    if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };

    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    if (!accountId) return { status: 400, body: { error: "accountId is required" } };
    if (!(await this.deps.store.get(accountId))) {
      return { status: 404, body: { error: `no profile for ${accountId}` } };
    }
    try {
      return { status: 200, body: { session: await consoles.start(accountId) } };
    } catch (err) {
      // A console already open for someone else is a conflict the operator must
      // resolve, not an error to retry.
      return { status: 409, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  /**
   * Run one action on behalf of a named operator.
   *
   * Separate from `/v1/actions` rather than a passthrough. The agent path and a
   * human clicking a button in a browser are different trust contexts, and this
   * one attributes every send to a person and records it. Actions are also
   * allow-listed here: an operator UI has no business reaching action types
   * nobody put a button on.
   */
  async adminAction(
    body: Record<string, unknown>,
    actorHeader?: string,
  ): Promise<{ status: number; body: unknown }> {
    if (!this.deps.audit) return { status: 404, body: { error: "admin surface not enabled" } };
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    if (!accountId) return { status: 400, body: { error: "accountId is required" } };

    let action;
    try {
      action = parseAction(body.action, typeof body.contractVersion === "number" ? body.contractVersion : -1);
    } catch (err) {
      return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
    }
    if (!ADMIN_ALLOWED_ACTIONS.has(action.type)) {
      return { status: 403, body: { error: `${action.type} is not available from the admin surface` } };
    }

    // An unattributed send is the thing the audit log exists to prevent, so a
    // caller that cannot say who it is does not get to act.
    const actor = (actorHeader ?? "").trim();
    if (!actor) return { status: 400, body: { error: "x-actor header is required" } };

    const result = await this.deps.execute(accountId, action);
    await this.deps.audit.record({
      at: this.deps.now?.() ?? Date.now(),
      actor, accountId, action: action.type,
      outcome: result.status === "ok" ? "ok" : result.status,
      ...(targetOf(action) ? { target: targetOf(action)! } : {}),
      ...(result.status !== "ok" ? { reason: result.reason } : {}),
    });
    const status = result.status === "ok" ? 200 : result.status === "refused" ? 409 : 502;
    return { status, body: result };
  }

  /** 409 when LinkedIn is still unsatisfied: more for the operator to do, not a failed call. */
  async handleReverify(accountId: string): Promise<{ status: number; body: unknown }> {
    if (!this.deps.reverify) return { status: 404, body: { error: "admin surface not enabled" } };
    const result = await this.deps.reverify(accountId);
    return { status: result.activated ? 200 : 409, body: result };
  }

  private replay(key: string): CachedResponse | null {
    const hit = this.seen.get(key);
    if (!hit) return null;
    const now = this.deps.now?.() ?? Date.now();
    if (now - hit.at > IDEMPOTENCY_TTL_MS) {
      this.seen.delete(key);
      return null;
    }
    return hit;
  }
}

/**
 * What an operator may trigger from the panel.
 *
 * Deliberately narrower than the contract. `send_connection_request` is absent:
 * invitations carry weekly caps and campaign-level stop semantics, and a button
 * that quietly consumes a scarce, account-wide budget is the wrong shape for a
 * one-off admin click.
 */
const ADMIN_ALLOWED_ACTIONS = new Set([
  "list_threads", "read_thread", "check_profile", "check_connection",
  "react_to_post", "send_message",
]);

/** The thing acted upon, for the audit trail. */
function targetOf(action: { type: string } & Record<string, unknown>): string | null {
  if (typeof action.postUrl === "string") return action.postUrl;
  if (typeof action.profileUrl === "string") return action.profileUrl;
  if (typeof action.correspondent === "string") return action.correspondent;
  return null;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A body cap so a malformed or hostile caller cannot exhaust memory.
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
