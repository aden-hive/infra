import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ThreadSummary } from "../actions/contract.ts";

/**
 * Conversation lists, captured for free during the detection sweep.
 *
 * Every check already loads `/messaging/` to read the unread count from the
 * title, and that same render contains the whole conversation list. Capturing
 * it costs one extra DOM read on a page that is already open: no additional
 * visit, no additional traffic, and — the part that matters — **no read
 * receipt**, because the list is visible without opening any thread.
 *
 * That is what makes the inbox open instantly instead of costing ~12s of live
 * browser work. It also lowers exposure rather than raising it: an operator who
 * can triage from cached previews opens fewer threads, and every thread opened
 * is a "seen" notification to the other party.
 *
 * Kept out of the profile blob deliberately. That blob replicates to object
 * storage on every change, and a list that churns on every check would bloat
 * replication with data that is cheap to re-derive and not precious.
 */
export interface CachedThreads {
  threads: ThreadSummary[];
  capturedAt: number;
}

export class ThreadCache {
  private readonly path: string;
  private cache: Record<string, CachedThreads> | null = null;
  private cachedMtimeMs = -1;

  constructor(root: string) {
    this.path = join(root, "threads.json");
  }

  /**
   * Reload when the file changed on disk.
   *
   * The sweeper writes and the API reads — separate processes. An unconditional
   * in-memory cache would leave the API serving whatever it read at startup,
   * which for a liveness-adjacent value means permanently wrong.
   */
  private async load(): Promise<Record<string, CachedThreads>> {
    let mtimeMs = -1;
    try {
      mtimeMs = (await stat(this.path)).mtimeMs;
    } catch {
      this.cache = {};
      this.cachedMtimeMs = -1;
      return this.cache;
    }
    if (this.cache && mtimeMs === this.cachedMtimeMs) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.path, "utf8")) as Record<string, CachedThreads>;
      this.cachedMtimeMs = mtimeMs;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  async put(accountId: string, threads: ThreadSummary[], at: number): Promise<void> {
    const all = await this.load();
    all[accountId] = { threads, capturedAt: at };
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(`${this.path}.tmp`, JSON.stringify(all), "utf8");
    await rename(`${this.path}.tmp`, this.path);
    try {
      this.cachedMtimeMs = (await stat(this.path)).mtimeMs;
    } catch {
      this.cachedMtimeMs = -1;
    }
  }

  async get(accountId: string): Promise<CachedThreads | null> {
    return (await this.load())[accountId] ?? null;
  }
}
