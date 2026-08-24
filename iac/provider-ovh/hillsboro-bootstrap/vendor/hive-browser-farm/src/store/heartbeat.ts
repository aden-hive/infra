import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * When each account was last actually checked.
 *
 * This exists because the obvious signal is wrong. `meta.updatedAt` only moves
 * when a profile is *written*, and the sweep deliberately skips writes when
 * nothing changed — so a healthy account checked every ten minutes can carry an
 * `updatedAt` from hours ago. An operations panel reading that would report
 * staleness that isn't real, and worse, would look reassuring for an account
 * whose last write happened to be recent while the sweep quietly stopped
 * touching it.
 *
 * Kept out of the profile blob on purpose: heartbeats change on every check and
 * profiles are replicated to object storage, so folding one into the other
 * would undo the write-skip it exists to compensate for.
 */
export interface Heartbeat {
  lastCheckedAt: number;
  lastOutcome: string;
  /** Consecutive non-OK checks; distinguishes a blip from a stuck account. */
  consecutiveFailures: number;
}

export class HeartbeatStore {
  private readonly path: string;
  private cache: Record<string, Heartbeat> | null = null;
  private cachedMtimeMs = -1;

  constructor(root: string) {
    this.path = join(root, "heartbeats.json");
  }

  /**
   * Reload when the file has changed on disk.
   *
   * The writer is the sweeper and the reader is the API — two processes, one
   * file. An unconditional in-memory cache meant the API answered from whatever
   * it read at startup, so every account showed "never checked" no matter how
   * many sweeps ran. That is the worst possible failure for a liveness signal:
   * a permanent false alarm, which teaches operators to ignore the one column
   * that tells them the sweep has stopped.
   */
  private async load(): Promise<Record<string, Heartbeat>> {
    let mtimeMs = -1;
    try {
      mtimeMs = (await stat(this.path)).mtimeMs;
    } catch {
      // Missing file: nothing has been recorded yet.
      this.cache = {};
      this.cachedMtimeMs = -1;
      return this.cache;
    }
    if (this.cache && mtimeMs === this.cachedMtimeMs) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.path, "utf8")) as Record<string, Heartbeat>;
      this.cachedMtimeMs = mtimeMs;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  async record(accountId: string, outcome: string, at: number): Promise<void> {
    const all = await this.load();
    const previous = all[accountId];
    all[accountId] = {
      lastCheckedAt: at,
      lastOutcome: outcome,
      consecutiveFailures: outcome === "OK" ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
    };
    await mkdir(dirname(this.path), { recursive: true });
    // Atomic replace: a torn heartbeat file would make the whole fleet look
    // unchecked, which is the one alarm that must not cry wolf.
    await writeFile(`${this.path}.tmp`, JSON.stringify(all), "utf8");
    await rename(`${this.path}.tmp`, this.path);
    // Our own write is the newest state; adopt its mtime so the next read does
    // not bounce back to a stale parse.
    try {
      this.cachedMtimeMs = (await stat(this.path)).mtimeMs;
    } catch {
      this.cachedMtimeMs = -1;
    }
  }

  async get(accountId: string): Promise<Heartbeat | null> {
    return (await this.load())[accountId] ?? null;
  }

  async all(): Promise<Record<string, Heartbeat>> {
    return { ...(await this.load()) };
  }
}

/**
 * How overdue a check is, relative to the slowest cadence the scheduler uses.
 *
 * The regular tier is 600s. Anything past a few multiples of that is not
 * "recently checked" under any decay state, so it means the sweep has stopped
 * reaching this account rather than that the account is merely quiet.
 */
export const STALE_AFTER_MS = 45 * 60_000;

export function isStale(heartbeat: Heartbeat | null, now: number): boolean {
  if (!heartbeat) return true;
  return now - heartbeat.lastCheckedAt > STALE_AFTER_MS;
}
