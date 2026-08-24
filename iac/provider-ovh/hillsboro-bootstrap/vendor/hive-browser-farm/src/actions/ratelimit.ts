import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Per-account action rate limits.
 *
 * Ported from `hive.linkedin-core`, which enforces caps *before* acting rather
 * than reacting to LinkedIn's refusal. That ordering is the point: by the time
 * LinkedIn says no, the account has already been noticed. The limits below are
 * its documented table.
 *
 * State is on disk and per account, because the cap is a property of the
 * account rather than of a process — a restart that forgot yesterday's invites
 * would let a fleet quietly double its own limit.
 */
export interface Limit {
  perDay: number;
  perWeek: number;
  minGapMs: number;
}

export const LIMITS: Record<string, Limit> = {
  // 15/day (ceiling 25), 60/week (ceiling 100), 30s between — hive.linkedin-core
  send_connection_request: { perDay: 15, perWeek: 60, minGapMs: 30_000 },
  send_message: { perDay: 30, perWeek: 150, minGapMs: 30_000 },
  react_to_post: { perDay: 60, perWeek: 300, minGapMs: 15_000 },
};

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export interface Decision {
  allowed: boolean;
  reason?: string;
  /** Caps are campaign-level stops, not this-target failures. */
  haltCampaign?: boolean;
  usedToday?: number;
  usedThisWeek?: number;
}

export class RateLimiter {
  private readonly path: string;
  private readonly now: () => number;
  private cache: Record<string, number[]> | null = null;

  constructor(root: string, now: () => number = Date.now) {
    this.path = join(root, "rate-limits.json");
    this.now = now;
  }

  private async load(): Promise<Record<string, number[]>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.path, "utf8")) as Record<string, number[]>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private key(accountId: string, actionType: string): string {
    return `${accountId}::${actionType}`;
  }

  /** Check without recording. Call before acting. */
  async check(accountId: string, actionType: string): Promise<Decision> {
    const limit = LIMITS[actionType];
    if (!limit) return { allowed: true };
    const now = this.now();
    const all = (await this.load())[this.key(accountId, actionType)] ?? [];
    const today = all.filter((t) => now - t < DAY_MS);
    const week = all.filter((t) => now - t < WEEK_MS);
    const last = all.length > 0 ? Math.max(...all) : 0;

    if (last && now - last < limit.minGapMs) {
      // Not a halt: the next attempt a moment later is fine. Spacing is about
      // not looking mechanical, not about a quota.
      return {
        allowed: false,
        reason: `min gap ${limit.minGapMs / 1000}s not elapsed (${Math.round((now - last) / 1000)}s since last)`,
        usedToday: today.length, usedThisWeek: week.length,
      };
    }
    if (today.length >= limit.perDay) {
      return {
        allowed: false, haltCampaign: true,
        reason: `daily cap reached (${today.length}/${limit.perDay}) for ${actionType}`,
        usedToday: today.length, usedThisWeek: week.length,
      };
    }
    if (week.length >= limit.perWeek) {
      return {
        allowed: false, haltCampaign: true,
        reason: `weekly cap reached (${week.length}/${limit.perWeek}) for ${actionType}`,
        usedToday: today.length, usedThisWeek: week.length,
      };
    }
    return { allowed: true, usedToday: today.length, usedThisWeek: week.length };
  }

  /** Record an action that actually happened. Only call on success. */
  async record(accountId: string, actionType: string): Promise<void> {
    if (!LIMITS[actionType]) return;
    const store = await this.load();
    const key = this.key(accountId, actionType);
    const now = this.now();
    // Prune on write; nothing older than a week can affect a decision.
    store[key] = [...(store[key] ?? []).filter((t) => now - t < WEEK_MS), now];
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(store), "utf8");
  }
}
