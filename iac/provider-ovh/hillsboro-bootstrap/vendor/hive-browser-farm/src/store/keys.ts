import type { ProfileBlob } from "../profile/schema.ts";
import { stateHash } from "../profile/schema.ts";

/**
 * Object keys are immutable and unique per write:
 *
 *   profiles/<accountId>/<updatedAt>-<hash8>.json
 *
 * Nothing is ever overwritten, which is what lets the replicator run with a
 * service account that has create and read but no delete. Verified against the
 * real bucket: a delete attempt returns "does not have storage.objects.delete"
 * and the object survives. A corrupted local write can therefore add a bad
 * version, but can never destroy a good one.
 *
 * Ordering by name is ordering by time, so "latest" is a lexical max over the
 * prefix — no pointer object to keep consistent, and no read-modify-write.
 */
export function versionKey(blob: ProfileBlob): string {
  const stamp = String(blob.meta.updatedAt).padStart(13, "0");
  return `${stamp}-${stateHash(blob).slice(0, 8)}.json`;
}

export function objectPath(accountId: string, key: string): string {
  return `profiles/${accountId}/${key}`;
}

export function accountPrefix(accountId: string): string {
  return `profiles/${accountId}/`;
}

/** Latest of a set of version keys. Lexical max is chronological max by design. */
export function latestKey(keys: readonly string[]): string | null {
  let best: string | null = null;
  for (const k of keys) {
    if (!k.endsWith(".json")) continue;
    if (best === null || k > best) best = k;
  }
  return best;
}
