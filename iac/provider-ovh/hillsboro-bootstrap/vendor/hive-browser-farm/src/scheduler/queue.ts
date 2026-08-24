/**
 * Due-queue and per-profile lock.
 *
 * Kept behind interfaces because the loop's correctness is what needs testing,
 * not Redis. The production binding is a sorted set plus SET NX; the in-memory
 * versions here back the tests and a single-process dev run.
 */
export interface DueQueue {
  /** Schedule (or reschedule) an account. Idempotent per account. */
  schedule(accountId: string, at: number): Promise<void>;
  /** Accounts due at or before `now`, soonest first, at most `limit`. */
  due(now: number, limit: number): Promise<string[]>;
  remove(accountId: string): Promise<void>;
  size(): Promise<number>;
}

/**
 * Guarantees a profile is being used by at most one lease at a time.
 *
 * Detection and the action path both touch the same profile. Two browsers
 * driving one LinkedIn session concurrently corrupts stored state and is
 * plainly non-human behaviour, so this is an invariant rather than an
 * optimisation.
 *
 * Locks carry a TTL because the holder can die. A lock that outlives its
 * process would strand the account forever; one that expires too early would
 * permit exactly the double-drive it exists to prevent, so the TTL must exceed
 * the maximum lease duration.
 */
export interface ProfileLock {
  acquire(accountId: string, ttlMs: number): Promise<boolean>;
  release(accountId: string): Promise<void>;
  held(accountId: string): Promise<boolean>;
}

export class MemoryDueQueue implements DueQueue {
  private readonly at = new Map<string, number>();

  async schedule(accountId: string, at: number): Promise<void> {
    this.at.set(accountId, at);
  }

  async due(now: number, limit: number): Promise<string[]> {
    return [...this.at.entries()]
      .filter(([, t]) => t <= now)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([id]) => id);
  }

  async remove(accountId: string): Promise<void> {
    this.at.delete(accountId);
  }

  async size(): Promise<number> {
    return this.at.size;
  }
}

export class MemoryProfileLock implements ProfileLock {
  private readonly until = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async acquire(accountId: string, ttlMs: number): Promise<boolean> {
    const expiry = this.until.get(accountId);
    if (expiry !== undefined && expiry > this.now()) return false;
    this.until.set(accountId, this.now() + ttlMs);
    return true;
  }

  async release(accountId: string): Promise<void> {
    this.until.delete(accountId);
  }

  async held(accountId: string): Promise<boolean> {
    const expiry = this.until.get(accountId);
    return expiry !== undefined && expiry > this.now();
  }
}
