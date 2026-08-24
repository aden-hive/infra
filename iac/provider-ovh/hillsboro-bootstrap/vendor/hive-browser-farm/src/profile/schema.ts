import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The profile blob is the unit of account identity. It is deliberately
 * self-describing: cookies, fingerprint, egress binding and health travel
 * together, so a browser host holding these files can run every account it
 * owns with no connectivity to the control plane. Nothing here requires a
 * lookup elsewhere to be actionable.
 *
 * Target size is 5-20 MB. Anything re-derivable on next page load (HTTP cache,
 * code caches, GPU shader cache) is excluded on purpose — hydration sits in the
 * inner loop of every check, so blob size is a direct multiplier on how many
 * accounts one machine can carry.
 */

export const SCHEMA_VERSION = 1;

export const CookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
});
export type Cookie = z.infer<typeof CookieSchema>;

/**
 * Identity presented to the site. This lives with the *account*, never with the
 * machine: a profile that appeared as a 16-core Linux box on Monday must not
 * appear as something else on Tuesday just because it landed on another host.
 *
 * `hardwareClass` names a Chrome instance configuration rather than carrying
 * the values, because hardwareConcurrency / deviceMemory / WebGL strings are
 * process-wide in Chrome and cannot be set per context. The scheduler uses it
 * to restrict which instances a profile is eligible to run on.
 */
export const FingerprintSchema = z.object({
  userAgent: z.string(),
  viewport: z.object({ width: z.number().int(), height: z.number().int() }),
  timezone: z.string(),
  locale: z.string(),
  hardwareClass: z.string(),
});
export type Fingerprint = z.infer<typeof FingerprintSchema>;

/** Outcome of a lease. Drives account health, so every lease returns one. */
export const LeaseOutcomeSchema = z.enum([
  "OK",
  "CHALLENGED",
  "LOGGED_OUT",
  "RESTRICTED",
  "ERROR",
]);
export type LeaseOutcome = z.infer<typeof LeaseOutcomeSchema>;

export const HealthSchema = z.enum([
  "onboarding",
  "active",
  "quarantined",
  "retired",
]);
export type Health = z.infer<typeof HealthSchema>;

export const ProfileMetaSchema = z.object({
  accountId: z.string().min(1),
  schemaVersion: z.literal(SCHEMA_VERSION),
  /**
   * Egress binding, stored as the **public IP** rather than a proxy endpoint.
   *
   * The public address is the account's durable network identity — it is what
   * LinkedIn sees and what must never change for the life of the profile. How
   * we reach it locally (which loopback port fronts which source address) is a
   * deployment detail that may be renumbered, and binding a profile to a port
   * would make a routine config change look like an account moving addresses.
   *
   * Assigned at profile *creation*, before the first login: an account that
   * logs in from one address and then runs from another manufactures exactly
   * the anomaly the affinity design exists to prevent.
   */
  egressIp: z.string().min(1),
  health: HealthSchema,
  /** Inbound reply or outbound send. Drives the polling cadence; null = never. */
  lastEventAt: z.number().nullable(),
  /**
   * Unread count at the last successful check.
   *
   * An event is a *new* message, not the presence of unread ones. Without this
   * baseline, an account carrying messages nobody clears would read as
   * eventful on every check and sit on the tightest cadence forever — ten times
   * the load, permanently, for an inbox that never changes.
   *
   * Defaulted rather than required, so blobs written before this field existed
   * still load. Adding a *required* field to this schema bricks every stored
   * profile at once — and a profile that will not parse is an account that
   * needs a human to log in again. New optional state goes in this way.
   */
  lastUnread: z.number().nullable().default(null),
  lastOutcome: LeaseOutcomeSchema.nullable(),
  updatedAt: z.number(),
});
export type ProfileMeta = z.infer<typeof ProfileMetaSchema>;

export const ProfileBlobSchema = z.object({
  meta: ProfileMetaSchema,
  fingerprint: FingerprintSchema,
  cookies: z.array(CookieSchema),
  /** origin -> (key -> value) */
  localStorage: z.record(z.string(), z.record(z.string(), z.string())),
});
export type ProfileBlob = z.infer<typeof ProfileBlobSchema>;

export function parseProfileBlob(raw: unknown): ProfileBlob {
  return ProfileBlobSchema.parse(raw);
}

/**
 * Stable hash of the parts that actually matter for persistence.
 *
 * Most detection leases change nothing meaningful, but LinkedIn rotates
 * session cookies on almost every request. Without this comparison we would
 * write a blob roughly twice a second forever; with it we write only on real
 * change. Deliberately excludes `meta.updatedAt`, which always differs.
 */
export function stateHash(blob: ProfileBlob): string {
  const cookies = [...blob.cookies]
    .map((c) => `${c.domain}|${c.path}|${c.name}=${c.value}`)
    .sort()
    .join("\n");
  const storage = Object.entries(blob.localStorage)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([origin, kv]) =>
      `${origin}::` +
      Object.entries(kv)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(";"),
    )
    .join("\n");
  return createHash("sha256").update(`${cookies}\n--\n${storage}`).digest("hex");
}
