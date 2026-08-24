import type { Page } from "puppeteer-core";
import type { LeaseOutcome } from "../profile/schema.ts";

/**
 * Every lease returns an outcome. This is not error handling — it is the
 * signal that drives account health, and the difference between CHALLENGED and
 * ERROR decides whether we retry (safe) or quarantine (mandatory).
 *
 * Retrying a challenged LinkedIn account in a loop is the most reliable way to
 * turn a soft challenge into a permanent restriction, so anything we are not
 * confident is a transient failure must classify as CHALLENGED, never ERROR.
 *
 * !! The URL patterns below are UNVERIFIED. They are the best guess from
 * LinkedIn's public behaviour and are exactly what Phase 0 exists to confirm.
 * `spike/migrate.ts` prints the landed URL and title on every run so these can
 * be corrected against reality before anything depends on them.
 */

const LOGGED_OUT_PATTERNS = [/\/login/i, /\/uas\/login/i, /\/signup/i];
const CHALLENGE_PATTERNS = [/\/checkpoint\//i, /\/challenge/i];
const RESTRICTED_PATTERNS = [/\/checkpoint\/lg\/login-submit/i, /restricted/i];

export interface Classification {
  outcome: LeaseOutcome;
  url: string;
  title: string;
  /** Why we landed on this outcome — logged so misclassifications are debuggable. */
  reason: string;
}

export function classifyUrl(url: string, title: string): Classification {
  const base = { url, title };
  for (const re of RESTRICTED_PATTERNS) {
    if (re.test(url)) {
      return { ...base, outcome: "RESTRICTED", reason: `url matched ${re}` };
    }
  }
  for (const re of CHALLENGE_PATTERNS) {
    if (re.test(url)) {
      return { ...base, outcome: "CHALLENGED", reason: `url matched ${re}` };
    }
  }
  for (const re of LOGGED_OUT_PATTERNS) {
    if (re.test(url)) {
      return { ...base, outcome: "LOGGED_OUT", reason: `url matched ${re}` };
    }
  }
  return { ...base, outcome: "OK", reason: "no challenge or login redirect" };
}

export async function classify(page: Page): Promise<Classification> {
  return classifyUrl(page.url(), await page.title());
}

/**
 * Unread count from the document title, e.g. "(3) Messaging | LinkedIn".
 *
 * Chosen over reading the DOM badge because LinkedIn's class names are
 * obfuscated and rotate, while the title format is user-visible and has been
 * stable for years. Returns null when the title carries no count, which is the
 * normal "nothing unread" case and must not be confused with a parse failure.
 */
export function unreadFromTitle(title: string): number | null {
  const match = /^\((\d+)\)/.exec(title.trim());
  if (!match?.[1]) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Wait for the messaging SPA to publish its real document title.
 *
 * Found the hard way in the Phase 0 run: at `domcontentloaded` the title has
 * not been set yet, so reading the unread count there returns nothing — for
 * every account, whether or not it has unread messages. Detection built on that
 * would have been silently blind rather than obviously broken, which is the
 * worst failure mode available to us.
 *
 * We wait for the title to mention Messaging rather than for a `(n)` prefix,
 * because an account with nothing unread never gets a count and waiting for one
 * would time out on exactly the common case.
 */
export interface TitleWait {
  title: string;
  elapsedMs: number;
  /** Distinct titles observed while waiting — how we learned the real lifecycle. */
  observed: string[];
  settled: boolean;
}

export async function waitForMessagingTitle(
  page: Page,
  timeoutMs = 15_000,
  pollMs = 200,
): Promise<TitleWait> {
  const started = Date.now();
  const observed: string[] = [];
  let title = "";
  while (Date.now() - started < timeoutMs) {
    title = await page.title();
    if (observed[observed.length - 1] !== title) observed.push(title);
    if (/messaging/i.test(title)) {
      return { title, elapsedMs: Date.now() - started, observed, settled: true };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { title, elapsedMs: Date.now() - started, observed, settled: false };
}
