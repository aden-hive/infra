import type { LeaseOutcome } from "../profile/schema.ts";

/**
 * Challenge-rate circuit breaker.
 *
 * Unusual on purpose: most systems should degrade rather than halt, but this
 * one halts. A spike in challenges means either LinkedIn changed something or
 * our fingerprinting broke, and every subsequent check compounds the damage
 * across the whole fleet at once. Stalling costs hours of detection latency,
 * which nobody notices. Continuing can cost the accounts, which is not
 * recoverable.
 *
 * Two consequences of that reasoning:
 *
 *  - **It does not auto-reset.** Recovery requires a human who has looked at
 *    why it tripped. An automatic half-open retry would resume exactly the
 *    traffic that was burning accounts.
 *
 *  - **ERROR does not count.** Network failures and timeouts are
 *    infrastructure problems; folding them in would trip the breaker during an
 *    ordinary outage and teach everyone to ignore it.
 *
 * LOGGED_OUT is tracked but does not trip it either. Sessions expire at some
 * baseline rate, so including it would either trip constantly or force the
 * threshold so high that real challenge spikes slip under. It feeds the
 * remediation queue instead.
 */
export type BreakerState = "closed" | "tripped";

export interface BreakerConfig {
  /** Rolling window over which the rate is computed. */
  windowMs: number;
  /** Minimum observations before the rate is trusted at all. */
  minSamples: number;
  /** Adverse fraction (0-1) at or above which the sweep halts. */
  threshold: number;
}

export const DEFAULT_BREAKER: BreakerConfig = {
  windowMs: 15 * 60_000,
  minSamples: 20,
  threshold: 0.1,
};

/** Outcomes that indicate the platform is reacting to us, not that a box is sad. */
const ADVERSE: ReadonlySet<LeaseOutcome> = new Set<LeaseOutcome>(["CHALLENGED", "RESTRICTED"]);

export interface BreakerSnapshot {
  state: BreakerState;
  samples: number;
  adverse: number;
  rate: number;
  loggedOut: number;
  trippedAt: number | null;
  reason: string | null;
}

export class CircuitBreaker {
  private readonly config: BreakerConfig;
  private readonly now: () => number;
  private events: Array<{ at: number; outcome: LeaseOutcome }> = [];
  private state: BreakerState = "closed";
  private trippedAt: number | null = null;
  private reason: string | null = null;

  constructor(config: Partial<BreakerConfig> = {}, now: () => number = Date.now) {
    this.config = { ...DEFAULT_BREAKER, ...config };
    this.now = now;
  }

  /** Record a lease outcome. Returns true if this observation tripped the breaker. */
  record(outcome: LeaseOutcome): boolean {
    if (outcome === "ERROR") return false;
    const at = this.now();
    this.events.push({ at, outcome });
    this.prune(at);
    if (this.state === "tripped") return false;

    const { samples, adverse, rate } = this.tally();
    if (samples >= this.config.minSamples && rate >= this.config.threshold) {
      this.state = "tripped";
      this.trippedAt = at;
      this.reason =
        `${adverse}/${samples} leases adverse (${(rate * 100).toFixed(1)}%) ` +
        `over ${Math.round(this.config.windowMs / 60_000)}m, ` +
        `threshold ${(this.config.threshold * 100).toFixed(0)}%`;
      return true;
    }
    return false;
  }

  /** Whether the sweep may dispatch work. */
  allows(): boolean {
    return this.state === "closed";
  }

  snapshot(): BreakerSnapshot {
    this.prune(this.now());
    const { samples, adverse, rate } = this.tally();
    return {
      state: this.state,
      samples,
      adverse,
      rate,
      loggedOut: this.events.filter((e) => e.outcome === "LOGGED_OUT").length,
      trippedAt: this.trippedAt,
      reason: this.reason,
    };
  }

  /**
   * Manual reset, after a human has established why it tripped.
   *
   * Deliberately not callable on a timer. If this ever grows an automatic
   * caller, the breaker has stopped being a safety mechanism.
   */
  reset(): void {
    this.state = "closed";
    this.trippedAt = null;
    this.reason = null;
    this.events = [];
  }

  private prune(at: number): void {
    const cutoff = at - this.config.windowMs;
    this.events = this.events.filter((e) => e.at > cutoff);
  }

  private tally(): { samples: number; adverse: number; rate: number } {
    const samples = this.events.length;
    const adverse = this.events.filter((e) => ADVERSE.has(e.outcome)).length;
    return { samples, adverse, rate: samples === 0 ? 0 : adverse / samples };
  }
}
