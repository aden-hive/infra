import type { Browser, Page } from "puppeteer-core";
import { extractCookies, extractLocalStorage, CAPTURED_ORIGINS } from "./slim.ts";
import { SCHEMA_VERSION, type Fingerprint, type ProfileBlob } from "./schema.ts";

/**
 * Read an account's state out of a live browser page.
 *
 * This is step 7 of the lease lifecycle, and also what an `onboard` lease does
 * once a human has finished logging in. Same code both times on purpose: if
 * onboarding captured a different shape than detection does, the first
 * detection lease after onboarding would be the one that discovers it.
 */
export interface CaptureOptions {
  accountId: string;
  egressIp: string;
  hardwareClass: string;
  /** Carried through so a re-capture doesn't reset an account's cadence. */
  lastEventAt?: number | null;
  /** Carried through so a re-capture doesn't read old messages as new. */
  lastUnread?: number | null;
}

export async function readFingerprint(
  browser: Browser,
  page: Page,
  hardwareClass: string,
): Promise<Fingerprint> {
  const userAgent = await browser.userAgent();
  const observed = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language,
  }));
  return {
    userAgent,
    viewport: { width: observed.width, height: observed.height },
    timezone: observed.timezone,
    locale: observed.locale,
    hardwareClass,
  };
}

export async function captureProfile(
  browser: Browser,
  page: Page,
  opts: CaptureOptions,
): Promise<ProfileBlob> {
  const localStorage: Record<string, Record<string, string>> = {};
  for (const origin of CAPTURED_ORIGINS) {
    // localStorage is origin-scoped, so it can only be read while the page is
    // actually on that origin. Skipping rather than navigating keeps capture
    // side-effect free — an onboard lease must not move the operator's tab.
    if (!page.url().startsWith(origin)) continue;
    localStorage[origin] = await extractLocalStorage(page);
  }

  return {
    meta: {
      accountId: opts.accountId,
      schemaVersion: SCHEMA_VERSION,
      egressIp: opts.egressIp,
      health: "onboarding",
      lastEventAt: opts.lastEventAt ?? null,
      lastUnread: opts.lastUnread ?? null,
      lastOutcome: null,
      updatedAt: Date.now(),
    },
    fingerprint: await readFingerprint(browser, page, opts.hardwareClass),
    cookies: await extractCookies(page),
    localStorage,
  };
}
