import { mkdir, readdir, readFile, rename, writeFile, unlink, open } from "node:fs/promises";
import { join } from "node:path";
import { parseProfileBlob, type ProfileBlob } from "../profile/schema.ts";
import { latestKey, versionKey } from "./keys.ts";

/**
 * Hot profile store on local disk.
 *
 * Hydration sits in the inner loop of every check, so this is the read path —
 * GCS is durability, not latency. Layout mirrors the object keys exactly so a
 * rebuild is a straight copy rather than a translation:
 *
 *   <root>/profiles/<accountId>/<updatedAt>-<hash8>.json   immutable versions
 *   <root>/pending/<accountId>__<key>                      replication markers
 *
 * There is deliberately no "current" pointer file. Latest is the lexical max of
 * the directory, so a write is a single atomic rename with no second step that
 * a crash could leave inconsistent.
 */
export interface StoredProfile {
  key: string;
  blob: ProfileBlob;
}

export class LocalProfileStore {
  // Explicit field rather than a constructor parameter property: Node runs
  // these files with type stripping, which rejects parameter properties.
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private dir(accountId: string): string {
    return join(this.root, "profiles", accountId);
  }

  private pendingDir(): string {
    return join(this.root, "pending");
  }

  async init(): Promise<void> {
    await mkdir(join(this.root, "profiles"), { recursive: true });
    await mkdir(this.pendingDir(), { recursive: true });
  }

  /**
   * Write a new immutable version and mark it for replication.
   *
   * Writes to a temp name, fsyncs, then renames. Rename within a directory is
   * atomic, so a reader either sees the complete version or does not see it at
   * all — never a half-written blob, which for a cookie jar means a silently
   * broken account rather than an obvious failure.
   */
  async put(blob: ProfileBlob): Promise<string> {
    const accountId = blob.meta.accountId;
    const dir = this.dir(accountId);
    await mkdir(dir, { recursive: true });

    const key = versionKey(blob);
    const finalPath = join(dir, key);
    const tmpPath = `${finalPath}.tmp`;

    await writeFile(tmpPath, JSON.stringify(blob), "utf8");
    const handle = await open(tmpPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, finalPath);

    // A marker on disk, not a queue in memory: a crash before replication must
    // leave the work discoverable on restart rather than silently dropped.
    await writeFile(join(this.pendingDir(), `${accountId}__${key}`), "", "utf8");
    return key;
  }

  async versions(accountId: string): Promise<string[]> {
    try {
      const names = await readdir(this.dir(accountId));
      return names.filter((n) => n.endsWith(".json")).sort();
    } catch {
      return [];
    }
  }

  async get(accountId: string): Promise<StoredProfile | null> {
    const key = latestKey(await this.versions(accountId));
    if (key === null) return null;
    const raw = await readFile(join(this.dir(accountId), key), "utf8");
    return { key, blob: parseProfileBlob(JSON.parse(raw)) };
  }

  async accounts(): Promise<string[]> {
    try {
      return (await readdir(join(this.root, "profiles"), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  /** Replication backlog, oldest first. */
  async pending(): Promise<Array<{ accountId: string; key: string }>> {
    try {
      const names = await readdir(this.pendingDir());
      return names.sort().flatMap((n) => {
        const idx = n.indexOf("__");
        if (idx < 0) return [];
        return [{ accountId: n.slice(0, idx), key: n.slice(idx + 2) }];
      });
    } catch {
      return [];
    }
  }

  async clearPending(accountId: string, key: string): Promise<void> {
    await unlink(join(this.pendingDir(), `${accountId}__${key}`)).catch(() => {});
  }

  async read(accountId: string, key: string): Promise<Buffer> {
    return readFile(join(this.dir(accountId), key));
  }

  /**
   * Drop old local versions, keeping the newest `keep`.
   *
   * Local disk is a cache; GCS holds history. Trimming here is safe precisely
   * because the replicator cannot delete remotely.
   */
  async trim(accountId: string, keep = 3): Promise<number> {
    const all = await this.versions(accountId);
    const doomed = all.slice(0, Math.max(0, all.length - keep));
    const pending = new Set((await this.pending()).map((p) => `${p.accountId}__${p.key}`));
    let removed = 0;
    for (const key of doomed) {
      // Never trim a version that has not reached GCS yet — that is the one
      // case where local disk holds the only copy in existence.
      if (pending.has(`${accountId}__${key}`)) continue;
      await unlink(join(this.dir(accountId), key)).catch(() => {});
      removed++;
    }
    return removed;
  }
}
