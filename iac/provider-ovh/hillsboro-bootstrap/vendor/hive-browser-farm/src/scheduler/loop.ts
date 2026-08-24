import type { LeaseOutcome, ProfileBlob } from "../profile/schema.ts";
import type { LocalProfileStore } from "../store/local-store.ts";
import type { CircuitBreaker } from "./breaker.ts";
import type { DueQueue, ProfileLock } from "./queue.ts";
import { nextCheckAt } from "./decay.ts";
import { stateHash } from "../profile/schema.ts";
import type { FarmEvent } from "../server/outbox.ts";
import { LINKEDIN } from "../server/outbox.ts";
import type { HeartbeatStore } from "../store/heartbeat.ts";
import type { ThreadCache } from "../store/thread-cache.ts";
import type { ThreadSummary } from "../actions/contract.ts";

/**
 * The detection sweep.
 *
 * Pops due profiles, runs one check each, records what happened, and
 * reschedules. The browser work is injected so the loop's behaviour — locking,
 * quarantine, cadence, halting — is testable without a browser, since that
 * behaviour is where the failure modes live.
 */
export interface CheckResult {
  outcome: LeaseOutcome;
  /** Unread count read from the page, or null if the signal was unavailable. */
  unread: number | null;
  /** Conversation list from the same page load; feeds the stored inbox. */
  conversations?: Array<{ correspondent: string; preview: string; position: number; threadId: string | null }>;
  /** Message bodies backfilled during this check. */
  threads?: Array<{
    correspondent: string; threadId: string | null;
    messages: Array<{ from: string; text: string; sentAtLabel: string; fromSelf: boolean }>;
  }>;
  /** State as it stood after the check. Only meaningful when outcome is OK. */
  blob?: ProfileBlob;
}

export type CheckFn = (blob: ProfileBlob) => Promise<CheckResult>;

export interface TickResult {
  halted: boolean;
  dispatched: number;
  skippedLocked: number;
  quarantined: number;
  errors: number;
  events: number;
}

export interface LoopConfig {
  /** Concurrent checks — the detection slot count. */
  concurrency: number;
  /** Lock TTL. Must exceed the longest possible lease or a dead holder double-drives. */
  lockTtlMs: number;
  /** Retry delay after an infrastructure error. */
  errorBackoffMs: number;
}

export const DEFAULT_LOOP: LoopConfig = {
  concurrency: 12,
  lockTtlMs: 120_000,
  errorBackoffMs: 60_000,
};

export class DetectionLoop {
  private readonly queue: DueQueue;
  private readonly lock: ProfileLock;
  private readonly breaker: CircuitBreaker;
  private readonly store: LocalProfileStore;
  private readonly check: CheckFn;
  private readonly emitEvent: ((event: FarmEvent) => Promise<void>) | undefined;
  private readonly heartbeats: HeartbeatStore | undefined;
  private readonly threadCache: ThreadCache | undefined;
  private readonly now: () => number;
  private readonly rand: () => number;
  private readonly config: LoopConfig;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: {
    queue: DueQueue;
    lock: ProfileLock;
    breaker: CircuitBreaker;
    store: LocalProfileStore;
    check: CheckFn;
    /**
     * Where inbox-relevant events go. Optional so the loop stays runnable
     * without a control plane — a partition must not stop detection.
     */
    emitEvent?: (event: FarmEvent) => Promise<void>;
    /**
     * Records that a check happened at all.
     *
     * Separate from the profile because the sweep skips writes when nothing
     * changed, which makes `meta.updatedAt` useless as a liveness signal.
     */
    heartbeats?: HeartbeatStore;
    /** Where the free conversation list from each check is kept. */
    threadCache?: ThreadCache;
    now?: () => number;
    rand?: () => number;
    config?: Partial<LoopConfig>;
  }) {
    this.queue = deps.queue;
    this.lock = deps.lock;
    this.breaker = deps.breaker;
    this.store = deps.store;
    this.check = deps.check;
    this.emitEvent = deps.emitEvent;
    this.heartbeats = deps.heartbeats;
    this.threadCache = deps.threadCache;
    this.now = deps.now ?? Date.now;
    this.rand = deps.rand ?? Math.random;
    this.config = { ...DEFAULT_LOOP, ...deps.config };
  }

  async tick(): Promise<TickResult> {
    const empty: TickResult = {
      halted: false, dispatched: 0, skippedLocked: 0,
      quarantined: 0, errors: 0, events: 0,
    };

    // Checked before anything is dispatched, not after. Once tripped, the
    // cheapest correct behaviour is to do nothing at all.
    if (!this.breaker.allows()) return { ...empty, halted: true };

    const due = await this.queue.due(this.now(), this.config.concurrency);
    if (due.length === 0) return empty;

    const results = await Promise.all(due.map((id) => this.runOne(id)));
    return results.reduce<TickResult>((acc, r) => ({
      halted: false,
      dispatched: acc.dispatched + (r.dispatched ? 1 : 0),
      skippedLocked: acc.skippedLocked + (r.skippedLocked ? 1 : 0),
      quarantined: acc.quarantined + (r.quarantined ? 1 : 0),
      errors: acc.errors + (r.error ? 1 : 0),
      events: acc.events + (r.event ? 1 : 0),
    }), empty);
  }

  private async runOne(accountId: string): Promise<{
    dispatched?: boolean; skippedLocked?: boolean;
    quarantined?: boolean; error?: boolean; event?: boolean;
  }> {
    // The action path holds the same lock. Losing the race is normal, not an
    // error — the account simply gets checked on its next turn.
    if (!(await this.lock.acquire(accountId, this.config.lockTtlMs))) {
      return { skippedLocked: true };
    }

    try {
      const stored = await this.store.get(accountId);
      if (stored === null) {
        // No blob means the account has never been onboarded. Leaving it in the
        // queue would spin on it forever, so it drops out until a human
        // onboards it through the console.
        await this.queue.remove(accountId);
        return {};
      }

      let result: CheckResult;
      try {
        result = await this.check(stored.blob);
      } catch {
        // Infrastructure failure, not an account signal. Retry later without
        // touching health, and deliberately without telling the breaker.
        await this.queue.schedule(accountId, this.now() + this.config.errorBackoffMs);
        return { dispatched: true, error: true };
      }

      this.breaker.record(result.outcome);
      // Recorded before branching, so a quarantining check still counts as
      // "this account was reached" rather than reading as an unswept account.
      await this.heartbeats?.record(accountId, result.outcome, this.now()).catch?.(() => {});

      if (result.outcome !== "OK") {
        await this.quarantine(stored.blob, result.outcome);
        // Emitting is best-effort and never blocks the sweep: the outbox is
        // durable, and a control plane that is down must not stop detection.
        await this.emit({
          kind: "account_quarantined", platform: LINKEDIN, accountId,
          outcome: result.outcome, at: this.now(),
        });
        // Removed from the sweep entirely. Re-checking a challenged account is
        // how a soft challenge becomes a permanent restriction; it re-enters
        // only via the remediation console.
        await this.queue.remove(accountId);
        return { dispatched: true, quarantined: true };
      }

      // The conversation list came free with this page render — no extra visit,
      // no read receipt. Cached locally so the admin panel opens instantly
      // instead of paying a live browser round trip per view. The durable copy
      // still goes to the control plane via the outbox below.
      if (result.conversations?.length) {
        await this.threadCache?.put(accountId, result.conversations, this.now()).catch?.(() => {});
      }

      // A *new* message is the event, not the existence of unread ones.
      const unread = result.unread;
      const event = unread !== null && unread > (stored.blob.meta.lastUnread ?? 0);
      const updated = this.applyOutcome(result.blob ?? stored.blob, result.outcome, event, unread);

      // Most checks find nothing and change nothing. Writing anyway would cost
      // ~73k versions a day at 400 accounts, every one of them replicated, to
      // record that the world is the same as last time.
      //
      // `updatedAt` alone is not a reason to write — but lastEventAt, health
      // and lastOutcome are real state, so a version that only differs by a
      // timestamp is skipped while a newly warm account is still persisted.
      const unchanged =
        stateHash(updated) === stateHash(stored.blob) &&
        updated.meta.lastEventAt === stored.blob.meta.lastEventAt &&
        updated.meta.lastUnread === stored.blob.meta.lastUnread &&
        updated.meta.health === stored.blob.meta.health &&
        updated.meta.lastOutcome === stored.blob.meta.lastOutcome;
      if (!unchanged) await this.store.put(updated);
      if (result.conversations?.length) {
        await this.emit({
          kind: "conversations_synced", platform: LINKEDIN, accountId,
          conversations: result.conversations, at: this.now(),
        });
      }
      for (const t of result.threads ?? []) {
        // `readMessages` returns [] rather than throwing when its selectors
        // miss — a markup change, a slow render, a logged-out page. Shipping
        // that inward reads as "this thread is now empty", and the control
        // plane would have to distinguish a failed read from an emptied thread
        // with no way to tell. It refuses them; don't send them.
        if (t.messages.length === 0) continue;
        await this.emit({
          kind: "thread_read", platform: LINKEDIN, accountId,
          correspondent: t.correspondent, threadId: t.threadId,
          messages: t.messages, at: this.now(),
        });
      }
      if (event) {
        await this.emit({
          kind: "unread_changed", platform: LINKEDIN, accountId,
          unread: unread ?? 0, previousUnread: stored.blob.meta.lastUnread,
          at: this.now(),
        });
      }
      await this.queue.schedule(
        accountId,
        nextCheckAt(this.now(), updated.meta.lastEventAt, this.rand),
      );
      return { dispatched: true, event };
    } finally {
      await this.lock.release(accountId);
    }
  }

  private async emit(event: FarmEvent): Promise<void> {
    try {
      await this.emitEvent?.(event);
    } catch {
      // Losing an event must never cost a check. The outbox is the durable
      // path; this call only hands it over.
    }
  }

  /** A newly arrived message is the event that makes an account warm. */
  private applyOutcome(
    blob: ProfileBlob, outcome: LeaseOutcome, event: boolean, unread: number | null,
  ): ProfileBlob {
    const now = this.now();
    return {
      ...blob,
      meta: {
        ...blob.meta,
        health: "active",
        lastOutcome: outcome,
        lastEventAt: event ? now : blob.meta.lastEventAt,
        // Only record a count we actually read. An unreadable signal must not
        // reset the baseline, or the next check would read every existing
        // message as newly arrived.
        lastUnread: unread ?? blob.meta.lastUnread,
        updatedAt: now,
      },
    };
  }

  /**
   * Park an account for human attention.
   *
   * Keeps the existing cookies rather than capturing whatever the challenge
   * page left behind — the operator needs the session as it was, and the
   * challenge page's state is not a session.
   */
  private async quarantine(blob: ProfileBlob, outcome: LeaseOutcome): Promise<void> {
    await this.store.put({
      ...blob,
      meta: { ...blob.meta, health: "quarantined", lastOutcome: outcome, updatedAt: this.now() },
    });
  }

  start(intervalMs = 1000, onTick?: (r: TickResult) => void): void {
    if (this.timer) return;
    const run = async (): Promise<void> => {
      try {
        onTick?.(await this.tick());
      } catch {
        // A tick failure must never stop the sweep; state is all durable.
      }
    };
    this.timer = setInterval(() => void run(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
