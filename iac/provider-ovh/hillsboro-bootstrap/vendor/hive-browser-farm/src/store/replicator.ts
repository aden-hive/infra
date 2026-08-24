import type { LocalProfileStore } from "./local-store.ts";
import { objectPath, versionKey } from "./keys.ts";

/**
 * Ships local profile versions to object storage.
 *
 * §9: on a single box, availability can be engineered locally but durability
 * cannot. A machine outage costs hours of latency, which LinkedIn does not
 * notice. Losing the profiles costs 400 re-logins, most of which draw a
 * verification challenge. So this path is the one that has to be right.
 *
 * Two properties do the work:
 *
 *  - **Keys are immutable.** Nothing is ever overwritten, so the credentials
 *    need create and read but not delete. Verified against the real bucket: a
 *    delete attempt is refused and the object survives. A corrupted local write
 *    can add a bad version; it cannot destroy a good one.
 *
 *  - **Backlog lives on disk.** Markers are files, so a crash leaves the work
 *    discoverable rather than dropping exactly the versions that exist only on
 *    the machine that just died.
 */
export interface ObjectUploader {
  /** Resolves `already-exists` when the key is present, which is not an error. */
  upload(path: string, body: Buffer): Promise<"uploaded" | "already-exists">;
}

export interface ReplicationResult {
  uploaded: number;
  alreadyPresent: number;
  failed: number;
  /** Age of the oldest un-replicated version. This is the live RPO. */
  lagMs: number;
}

export class Replicator {
  private readonly store: LocalProfileStore;
  private readonly uploader: ObjectUploader;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: {
    store: LocalProfileStore;
    uploader: ObjectUploader;
    now?: () => number;
  }) {
    this.store = deps.store;
    this.uploader = deps.uploader;
    this.now = deps.now ?? Date.now;
  }

  /** Drain the backlog once. Safe to call concurrently with writes. */
  async replicateOnce(): Promise<ReplicationResult> {
    const pending = await this.store.pending();
    let uploaded = 0;
    let alreadyPresent = 0;
    let failed = 0;
    let oldest = 0;

    for (const { accountId, key } of pending) {
      try {
        const body = await this.store.read(accountId, key);
        const outcome = await this.uploader.upload(objectPath(accountId, key), body);
        // An existing key means a previous run got there before its marker was
        // cleared. Identical content by construction, so this is done, not a
        // conflict — retrying it forever would stall the whole backlog.
        if (outcome === "already-exists") alreadyPresent++;
        else uploaded++;
        await this.store.clearPending(accountId, key);
      } catch {
        // Marker stays. Losing the record of un-replicated work is the one
        // failure this component exists to prevent.
        failed++;
        const stamp = Number.parseInt(key.slice(0, 13), 10);
        if (Number.isFinite(stamp)) oldest = oldest === 0 ? stamp : Math.min(oldest, stamp);
      }
    }

    return {
      uploaded,
      alreadyPresent,
      failed,
      lagMs: oldest === 0 ? 0 : Math.max(0, this.now() - oldest),
    };
  }

  start(intervalMs = 10_000, onResult?: (r: ReplicationResult) => void): void {
    if (this.timer) return;
    const tick = async (): Promise<void> => {
      try {
        onResult?.(await this.replicateOnce());
      } catch {
        // Never let a replication error kill the loop; the backlog persists.
      }
    };
    this.timer = setInterval(() => void tick(), intervalMs);
    // NOT unref'd, deliberately. This timer is the only thing holding the
    // replicator daemon's event loop open: unref'd, Node finds nothing left to
    // do the instant start() returns, exits 0, and systemd restarts it — a
    // clean-looking loop that logs "started" every few seconds and replicates
    // nothing. That is exactly how this process ran while the profile bucket
    // stayed empty, and why losing the box cost every stored session.
    //
    // The other unref'd timers in this codebase (outbox, sweep loop) sit inside
    // processes with an HTTP server or a CDP socket holding the loop open, so
    // there they are correct. Here there is nothing else.
    void tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export { versionKey };
