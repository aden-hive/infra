import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Durable outbox for events destined for the control plane.
 *
 * §8's partition table says inbox updates queue on OVH and flush on reconnect,
 * and that only works if the queue survives the process. Events are files, so a
 * crash or a GCP outage leaves them discoverable — the alternative loses
 * exactly the notifications that were in flight when something broke, which is
 * when they matter most.
 *
 * Ordering is by filename, which is timestamp-first, so a flush after an outage
 * replays in the order things actually happened rather than in whatever order
 * the filesystem returns.
 */
/**
 * Which network an event came from.
 *
 * Required, not optional, and not defaulted here: the farm is LinkedIn-only
 * today, and the point of the field is that the type system asks the question
 * of whoever adds the second platform. The control plane still accepts events
 * without it — that is what lets this deploy independently of the farm — but
 * nothing new should rely on that path.
 */
export type Platform = "linkedin";

/** The only platform the farm drives today. */
export const LINKEDIN: Platform = "linkedin";

export type FarmEvent =
  | { kind: "unread_changed"; platform: Platform; accountId: string; unread: number; previousUnread: number | null; at: number }
  /**
   * The conversation list as seen by a sweep.
   *
   * Free to collect — the sweep already loads `/messaging/` to read the unread
   * count, and was throwing the list away. Carrying it inward is what lets the
   * panel show an inbox without re-driving a browser per view.
   */
  | {
      kind: "conversations_synced"; platform: Platform; accountId: string; at: number;
      conversations: Array<{ correspondent: string; preview: string; position: number; threadId: string | null }>;
    }
  /**
   * A thread's messages, emitted only when one is actually opened — because
   * opening is what fetches them, and is also what sends a read receipt.
   */
  | {
      kind: "thread_read"; platform: Platform; accountId: string; at: number;
      correspondent: string; threadId: string | null;
      messages: Array<{ from: string; text: string; sentAtLabel: string; fromSelf: boolean }>;
    }
  | { kind: "account_quarantined"; platform: Platform; accountId: string; outcome: string; at: number }
  | { kind: "account_recovered"; platform: Platform; accountId: string; at: number };

export interface EventSink {
  /** Resolves on durable acceptance; throws to keep the event queued. */
  deliver(events: FarmEvent[]): Promise<void>;
}

export interface FlushResult {
  delivered: number;
  failed: number;
  /** Age of the oldest undelivered event — the live lag on the inbox. */
  lagMs: number;
  /** Why the last attempt failed. Without it a stuck queue gives no clue. */
  reason?: string;
}

export class Outbox {
  private readonly dir: string;
  private readonly sink: EventSink;
  private readonly now: () => number;
  private readonly batchSize: number;
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: { root: string; sink: EventSink; now?: () => number; batchSize?: number }) {
    this.dir = join(deps.root, "outbox");
    this.sink = deps.sink;
    this.now = deps.now ?? Date.now;
    this.batchSize = deps.batchSize ?? 50;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async enqueue(event: FarmEvent): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Timestamp first so lexical order is chronological; a counter breaks ties
    // between events written inside the same millisecond.
    const name = `${String(event.at).padStart(13, "0")}-${String(this.seq++).padStart(5, "0")}.json`;
    const path = join(this.dir, name);
    await writeFile(`${path}.tmp`, JSON.stringify(event), "utf8");
    // Rename is atomic, so a reader never sees a half-written event.
    const { rename } = await import("node:fs/promises");
    await rename(`${path}.tmp`, path);
  }

  async pending(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return [];
    }
  }

  async flush(): Promise<FlushResult> {
    const names = (await this.pending()).slice(0, this.batchSize);
    if (names.length === 0) return { delivered: 0, failed: 0, lagMs: 0 };

    const events: FarmEvent[] = [];
    for (const name of names) {
      try {
        events.push(JSON.parse(await readFile(join(this.dir, name), "utf8")) as FarmEvent);
      } catch {
        // A corrupt event must not wedge the queue behind it forever.
        await unlink(join(this.dir, name)).catch(() => {});
      }
    }
    if (events.length === 0) return { delivered: 0, failed: 0, lagMs: 0 };

    try {
      await this.sink.deliver(events);
    } catch (err) {
      const oldest = Number.parseInt(names[0]?.slice(0, 13) ?? "0", 10);
      return {
        delivered: 0, failed: events.length,
        lagMs: Number.isFinite(oldest) && oldest > 0 ? Math.max(0, this.now() - oldest) : 0,
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    // Deleted only after the sink confirms. At-least-once delivery is the right
    // trade here: a duplicated inbox notification is noise, a dropped one is a
    // customer message nobody sees.
    for (const name of names) await unlink(join(this.dir, name)).catch(() => {});
    return { delivered: events.length, failed: 0, lagMs: 0 };
  }

  start(intervalMs = 15_000, onResult?: (r: FlushResult) => void): void {
    if (this.timer) return;
    const tick = async (): Promise<void> => {
      try { onResult?.(await this.flush()); } catch { /* never kill the loop */ }
    };
    this.timer = setInterval(() => void tick(), intervalMs);
    this.timer.unref?.();
    void tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** POSTs events to the control plane's ingest endpoint. */
export function createHttpSink(opts: { url: string; token: string }): EventSink {
  return {
    async deliver(events: FarmEvent[]): Promise<void> {
      const res = await fetch(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`ingest returned ${res.status}`);
    },
  };
}
