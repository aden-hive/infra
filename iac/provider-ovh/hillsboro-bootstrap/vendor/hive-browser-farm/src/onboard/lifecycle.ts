import type { LocalProfileStore } from "../store/local-store.ts";
import type { Health, LeaseOutcome, ProfileBlob } from "../profile/schema.ts";
import type { EgressPool } from "../browser/egress.ts";

/**
 * Onboarding and remediation — the same component, deliberately.
 *
 * Getting 400 accounts logged in the first time and getting a challenged
 * account back into rotation are the same operation: a human drives a real
 * browser at the account's own egress address until the session verifies. The
 * second one runs forever, so it is the one worth building well.
 *
 * The sweep quarantines but never un-quarantines. Without this, a challenged
 * account is stuck permanently — which is a hole, not a safety property.
 */
export interface AttentionItem {
  accountId: string;
  health: Health;
  lastOutcome: LeaseOutcome | null;
  /** Egress the account must be re-authed on. Never reassigned. */
  egressIp: string;
  updatedAt: number;
  reason: string;
}

const REASONS: Record<string, string> = {
  CHALLENGED: "verification challenge — needs a human to clear it",
  RESTRICTED: "account restricted — may not be recoverable",
  LOGGED_OUT: "session expired — needs re-login",
};

export class OnboardingService {
  private readonly store: LocalProfileStore;
  private readonly egress: EgressPool;
  private readonly now: () => number;

  constructor(deps: { store: LocalProfileStore; egress: EgressPool; now?: () => number }) {
    this.store = deps.store;
    this.egress = deps.egress;
    this.now = deps.now ?? Date.now;
  }

  /** Everything waiting on a human, most recently affected first. */
  async needsAttention(): Promise<AttentionItem[]> {
    const items: AttentionItem[] = [];
    for (const accountId of await this.store.accounts()) {
      const stored = await this.store.get(accountId);
      if (!stored) continue;
      const { health, lastOutcome, egressIp, updatedAt } = stored.blob.meta;
      if (health === "active") continue;
      items.push({
        accountId, health, lastOutcome, egressIp, updatedAt,
        reason:
          health === "retired" ? "retired" :
          health === "onboarding" ? "onboarding in progress or abandoned" :
          REASONS[lastOutcome ?? ""] ?? "quarantined",
      });
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Prepare an account for a human session.
   *
   * Returns the proxy the browser must be launched behind. Resolving it here
   * rather than letting the caller choose is the point: a re-auth has to happen
   * on the account's *existing* address. Logging back in from somewhere else is
   * precisely the anomaly §10 exists to prevent, and it would be committed at
   * the moment LinkedIn is watching hardest.
   */
  async beginSession(accountId: string): Promise<{ blob: ProfileBlob; proxyUrl: string }> {
    const stored = await this.store.get(accountId);
    if (!stored) throw new Error(`no profile for ${accountId} — register it first`);
    const proxyUrl = this.egress.resolve(stored.blob.meta.egressIp);
    const blob: ProfileBlob = {
      ...stored.blob,
      meta: { ...stored.blob.meta, health: "onboarding", updatedAt: this.now() },
    };
    await this.store.put(blob);
    return { blob, proxyUrl };
  }

  /**
   * Return an account to the sweep after a verified session.
   *
   * `verifiedOutcome` is the classification of the live page at the end of the
   * session, not an assertion by the operator. Flipping health on someone's say
   * so would put a still-challenged account straight back into rotation, which
   * is how a soft challenge becomes a restriction.
   */
  async completeSession(
    accountId: string,
    captured: ProfileBlob,
    verifiedOutcome: LeaseOutcome,
  ): Promise<{ activated: boolean; reason?: string }> {
    if (verifiedOutcome !== "OK") {
      await this.store.put({
        ...captured,
        meta: {
          ...captured.meta, health: "quarantined",
          lastOutcome: verifiedOutcome, updatedAt: this.now(),
        },
      });
      return { activated: false, reason: `session still ${verifiedOutcome}` };
    }

    const existing = await this.store.get(accountId);
    await this.store.put({
      ...captured,
      meta: {
        ...captured.meta,
        // Egress and hardware class are the account's identity and survive
        // re-auth untouched — a new session on a new address or a new hardware
        // class is a different device as far as the platform is concerned.
        egressIp: existing?.blob.meta.egressIp ?? captured.meta.egressIp,
        health: "active",
        lastOutcome: "OK",
        // Cleared so the account rejoins at the regular cadence rather than
        // inheriting warmth from whatever happened before it broke.
        lastEventAt: null,
        updatedAt: this.now(),
      },
      fingerprint: {
        ...captured.fingerprint,
        hardwareClass: existing?.blob.fingerprint.hardwareClass ?? captured.fingerprint.hardwareClass,
      },
    });
    return { activated: true };
  }

  /** Take an account out of service without deleting its history. */
  async retire(accountId: string): Promise<void> {
    const stored = await this.store.get(accountId);
    if (!stored) return;
    await this.store.put({
      ...stored.blob,
      meta: { ...stored.blob.meta, health: "retired", updatedAt: this.now() },
    });
  }
}
