import type { Browser } from "puppeteer-core";
import type { LocalProfileStore } from "../store/local-store.ts";
import type { ProfileLock } from "../scheduler/queue.ts";
import type { CircuitBreaker } from "../scheduler/breaker.ts";
import type { RateLimiter } from "./ratelimit.ts";
import type { EgressPool } from "../browser/egress.ts";
import type { Action, ActionResult } from "./contract.ts";
import { isWriteAction } from "./contract.ts";
import { acquireLease } from "../browser/context.ts";
import { hydrate } from "../profile/slim.ts";
import { captureProfile } from "../profile/capture.ts";
import { classify, unreadFromTitle, waitForMessagingTitle } from "../linkedin/classify.ts";
import { MESSAGING_URL } from "../browser/check.ts";

/**
 * Runs one action against one account.
 *
 * Shares the profile lock with the detection sweep. Two browsers driving one
 * LinkedIn session concurrently corrupts stored state and is plainly non-human,
 * so the lock is the invariant — the action path simply holds it longer.
 *
 * Unlike a detection lease, an action lease is not preemptible: abandoning an
 * agent midway through composing a reply leaves a half-written message in a
 * real conversation.
 */
export interface ActionHandlers {
  [key: string]: (ctx: ActionContext) => Promise<unknown>;
}

export interface ActionContext {
  page: import("puppeteer-core").Page;
  action: Action;
  /** Whose session this is — handlers need it to attribute what they learn. */
  accountId: string;
}

export interface ExecutorConfig {
  /** Longer than a detection lease; an agent turn is 30–90s. */
  lockTtlMs: number;
  leaseTimeoutMs: number;
  /**
   * Whether outward-effecting actions may run.
   *
   * Off by default. Reads are recoverable; a sent message is not, and the
   * blast radius of an agent bug is other people's inboxes.
   */
  allowWrites: boolean;
}

export const DEFAULT_EXECUTOR: ExecutorConfig = {
  lockTtlMs: 180_000,
  leaseTimeoutMs: 150_000,
  allowWrites: false,
};

export class ActionExecutor {
  private readonly store: LocalProfileStore;
  private readonly lock: ProfileLock;
  private readonly egress: EgressPool;
  /**
   * Resolved per lease rather than captured once.
   *
   * Chrome restarts for ordinary reasons and puppeteer's handle dies with it;
   * a executor holding the boot-time connection answers "Connection closed."
   * forever after. Wrapping the handle in a Proxy does not work either —
   * puppeteer uses `#private` fields, which a Proxy cannot forward.
   */
  private readonly getBrowser: () => Browser;
  private readonly handlers: ActionHandlers;
  private readonly breaker: CircuitBreaker | undefined;
  private readonly limiter: RateLimiter | undefined;
  private readonly now: () => number;
  private readonly config: ExecutorConfig;

  constructor(deps: {
    store: LocalProfileStore;
    lock: ProfileLock;
    egress: EgressPool;
    browser: Browser | (() => Browser);
    handlers: ActionHandlers;
    breaker?: CircuitBreaker;
    limiter?: RateLimiter;
    now?: () => number;
    config?: Partial<ExecutorConfig>;
  }) {
    this.store = deps.store;
    this.lock = deps.lock;
    this.egress = deps.egress;
    this.getBrowser = typeof deps.browser === "function" ? deps.browser : () => deps.browser as Browser;
    this.handlers = deps.handlers;
    this.breaker = deps.breaker;
    this.limiter = deps.limiter;
    this.now = deps.now ?? Date.now;
    this.config = { ...DEFAULT_EXECUTOR, ...deps.config };
  }

  async execute(accountId: string, action: Action): Promise<ActionResult> {
    const refuse = (reason: string): ActionResult =>
      ({ status: "refused", action: action.type, reason });

    if (isWriteAction(action) && !this.config.allowWrites) {
      return refuse("writes are disabled on this executor");
    }

    // The breaker governs the whole fleet, not just the sweep. If challenges
    // are spiking, driving accounts harder is the worst available response.
    if (this.breaker && !this.breaker.allows()) {
      return refuse("circuit breaker is tripped");
    }

    const stored = await this.store.get(accountId);
    if (!stored) return refuse(`no profile for ${accountId}`);
    if (stored.blob.meta.health !== "active") {
      return refuse(`account is ${stored.blob.meta.health}`);
    }

    const handler = this.handlers[action.type];
    if (!handler) return refuse(`no handler for ${action.type}`);

    // Checked before the browser is touched. Enforcing caps ourselves rather
    // than waiting for LinkedIn to refuse is the whole point — by the time it
    // says no, the account has already been noticed.
    if (this.limiter) {
      const decision = await this.limiter.check(accountId, action.type);
      if (!decision.allowed) {
        return refuse(
          `${decision.reason}${decision.haltCampaign ? " [HALT CAMPAIGN]" : ""}`,
        );
      }
    }

    let proxyServer: string;
    try {
      proxyServer = this.egress.resolve(stored.blob.meta.egressIp);
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err));
    }

    if (!(await this.lock.acquire(accountId, this.config.lockTtlMs))) {
      // The sweep or another agent has it. Contention is normal; the caller
      // retries rather than us stealing a lease mid-conversation.
      return refuse("profile is busy");
    }

    try {
      const browser = this.getBrowser();
      const lease = await acquireLease(browser, {
        fingerprint: stored.blob.fingerprint,
        proxyServer,
        timeoutMs: this.config.leaseTimeoutMs,
      });
      try {
        await hydrate(lease.page, stored.blob);
        await lease.page.goto(MESSAGING_URL, {
          waitUntil: "domcontentloaded", timeout: 60_000,
        });
        const titled = await waitForMessagingTitle(lease.page);
        const state = await classify(lease.page);
        this.breaker?.record(state.outcome);

        // Never act on a session we have not just verified. Sending a message
        // through a challenge interstitial is at best a no-op and at worst
        // hands the platform another interaction to score.
        if (state.outcome !== "OK") {
          await this.store.put({
            ...stored.blob,
            meta: {
              ...stored.blob.meta, health: "quarantined",
              lastOutcome: state.outcome, updatedAt: this.now(),
            },
          });
          return refuse(`session is ${state.outcome}`);
        }

        const data = await handler({ page: lease.page, action, accountId });

        const unread = titled.settled ? (unreadFromTitle(titled.title) ?? 0) : null;
        const captured = await captureProfile(browser, lease.page, {
          accountId,
          egressIp: stored.blob.meta.egressIp,
          hardwareClass: stored.blob.fingerprint.hardwareClass,
          lastEventAt: stored.blob.meta.lastEventAt,
          lastUnread: unread ?? stored.blob.meta.lastUnread,
        });

        // An outbound action is itself an event: the moment right after we
        // send is when a reply is most likely, so the account goes warm.
        const warmed = isWriteAction(action) ? this.now() : captured.meta.lastEventAt;
        await this.store.put({
          ...captured,
          meta: {
            ...captured.meta, health: "active", lastOutcome: "OK",
            lastEventAt: warmed, updatedAt: this.now(),
          },
        });

        // Recorded only on success: a refused or failed attempt did not spend
        // the account's quota, and counting it would shrink the real budget.
        await this.limiter?.record(accountId, action.type);
        return { status: "ok", action: action.type, data, unread };
      } finally {
        await lease.release();
      }
    } catch (err) {
      return {
        status: "failed", action: action.type,
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await this.lock.release(accountId);
    }
  }
}
