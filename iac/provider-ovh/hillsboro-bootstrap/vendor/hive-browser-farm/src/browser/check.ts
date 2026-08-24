import type { Browser } from "puppeteer-core";
import type { CheckFn, CheckResult } from "../scheduler/loop.ts";
import type { ProfileBlob } from "../profile/schema.ts";
import type { EgressPool } from "./egress.ts";
import { acquireLease } from "./context.ts";
import { hydrate } from "../profile/slim.ts";
import { captureProfile } from "../profile/capture.ts";
import { classify, unreadFromTitle, waitForMessagingTitle } from "../linkedin/classify.ts";
import { listThreads, openThread, readMessages, threadIdFromUrl } from "../linkedin/threads.ts";
import type { ThreadSyncStore } from "../store/thread-sync.ts";

/**
 * One detection lease, start to finish — steps 2 through 8 of §4.
 *
 * Only `/messaging/` carries the unread count. `/feed/` was measured at twice
 * the CPU and its title has no count at all, so there is no cheaper target to
 * fall back to.
 */
export const MESSAGING_URL = "https://www.linkedin.com/messaging/";

export function createBrowserCheck(deps: {
  browser: Browser;
  egress: EgressPool;
  leaseTimeoutMs?: number;
  /**
   * Optional message backfill, so the stored inbox holds conversations rather
   * than just a list of names.
   *
   * Bounded twice over: at most `backfillPerSweep` threads per check, and only
   * threads never read or whose preview changed. A conversation is therefore
   * opened once and then left alone until it genuinely gains a message — which
   * is also the only time re-opening tells the correspondent anything they
   * were not already told.
   */
  threadSync?: ThreadSyncStore;
  backfillPerSweep?: number;
}): CheckFn {
  const leaseTimeoutMs = deps.leaseTimeoutMs ?? 90_000;
  const backfillPerSweep = deps.backfillPerSweep ?? 5;

  return async function check(blob: ProfileBlob): Promise<CheckResult> {
    // Throws if the profile's address has no local proxy. Running it from any
    // other address would mean acting from an IP it never logged in from —
    // which looks fine until the account is challenged.
    const proxyServer = deps.egress.resolve(blob.meta.egressIp);

    const lease = await acquireLease(deps.browser, {
      fingerprint: blob.fingerprint,
      proxyServer,
      timeoutMs: leaseTimeoutMs,
    });

    try {
      await hydrate(lease.page, blob);
      await lease.page.goto(MESSAGING_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      // The title is not populated at domcontentloaded. Reading the count
      // there returns nothing for every account, unread or not — detection
      // would be silently blind rather than obviously broken.
      const titled = await waitForMessagingTitle(lease.page);
      const result = await classify(lease.page);

      if (result.outcome !== "OK") {
        return { outcome: result.outcome, unread: null };
      }

      // The list is on the page we already loaded, so collecting it costs
      // nothing beyond a DOM read — and it is what feeds the stored inbox.
      const conversations = await listThreads(lease.page, 20).catch(() => []);

      // Backfill message bodies for a few conversations while the page is
      // already open and the lease already held. Failures here are non-fatal:
      // the check itself succeeded, and a thread that could not be read will
      // simply be retried on a later sweep.
      const threads: Array<{
        correspondent: string; threadId: string | null;
        messages: Array<{ from: string; text: string; sentAtLabel: string; fromSelf: boolean }>;
      }> = [];
      if (deps.threadSync && backfillPerSweep > 0 && conversations.length > 0) {
        const wanted = await deps.threadSync.needsRead(
          blob.meta.accountId, conversations, backfillPerSweep,
        );
        for (const t of wanted) {
          try {
            const id = await openThread(lease.page, t.correspondent);
            const messages = await readMessages(lease.page);
            threads.push({
              correspondent: t.correspondent,
              threadId: id ?? threadIdFromUrl(lease.page.url()),
              messages,
            });
            await deps.threadSync.record(
              blob.meta.accountId, t.correspondent, t.preview, Date.now(),
            );
          } catch {
            // Leave it unrecorded so a later sweep tries again.
          }
        }
      }

      return {
        outcome: "OK",
        conversations,
        threads,
        // A settled title with no count means zero unread. An unsettled one
        // means we could not read the signal, which is not the same thing and
        // must not be reported as "no messages".
        unread: titled.settled ? (unreadFromTitle(titled.title) ?? 0) : null,
        blob: await captureProfile(deps.browser, lease.page, {
          accountId: blob.meta.accountId,
          egressIp: blob.meta.egressIp,
          hardwareClass: blob.fingerprint.hardwareClass,
          lastEventAt: blob.meta.lastEventAt,
        }),
      };
    } finally {
      await lease.release();
    }
  };
}
