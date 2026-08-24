import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * What the farm has already read, so it never reads it twice.
 *
 * Old conversations do not change, so re-opening one to fetch messages the
 * store already holds is pure cost — ~10s of browser work, and a fresh read
 * receipt to the correspondent every time.
 *
 * The preview line is the change signal. LinkedIn shows the latest message in
 * the list, so a preview that differs from the one recorded means new content;
 * an identical preview means the thread is exactly as last read. That lets a
 * sweep backfill a conversation **once** and then leave it alone until it
 * genuinely changes — which is also the only moment a re-read would tell the
 * correspondent anything they have not already been told.
 */
export interface ThreadRecord {
  /** Preview at the time messages were last read. */
  preview: string;
  readAt: number;
}

export class ThreadSyncStore {
  private readonly path: string;
  private cache: Record<string, ThreadRecord> | null = null;

  constructor(root: string) {
    this.path = join(root, "thread-sync.json");
  }

  private key(accountId: string, correspondent: string): string {
    return `${accountId}::${correspondent}`;
  }

  private async load(): Promise<Record<string, ThreadRecord>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.path, "utf8")) as Record<string, ThreadRecord>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  /**
   * Conversations worth opening: never read, or changed since.
   *
   * Capped by the caller. A sweep that opened every stale thread would turn a
   * cheap check into minutes of browser work and a burst of read receipts.
   */
  async needsRead(
    accountId: string,
    threads: ReadonlyArray<{ correspondent: string; preview: string }>,
    limit: number,
  ): Promise<Array<{ correspondent: string; preview: string }>> {
    const all = await this.load();
    const out: Array<{ correspondent: string; preview: string }> = [];
    for (const t of threads) {
      if (out.length >= limit) break;
      const seen = all[this.key(accountId, t.correspondent)];
      if (!seen || seen.preview !== t.preview) out.push(t);
    }
    return out;
  }

  async record(accountId: string, correspondent: string, preview: string, at: number): Promise<void> {
    const all = await this.load();
    all[this.key(accountId, correspondent)] = { preview, readAt: at };
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(`${this.path}.tmp`, JSON.stringify(all), "utf8");
    await rename(`${this.path}.tmp`, this.path);
  }
}
