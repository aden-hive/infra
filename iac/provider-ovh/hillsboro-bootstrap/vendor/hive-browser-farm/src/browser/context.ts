import type { Browser, BrowserContext, Page } from "puppeteer-core";
import type { Fingerprint } from "../profile/schema.ts";

/**
 * A lease is one profile occupying one slot. Everything about a lease is
 * bounded: it has a deadline, and releasing it must actually destroy the
 * context rather than merely dropping the reference.
 *
 * That matters more than it looks. An undisposed BrowserContext keeps its
 * cookie jar alive inside a Chrome process that will serve other accounts, and
 * the failure mode is not a leak but a correctness disaster — account A acting
 * as account B. So `release()` verifies disposal instead of assuming it.
 */
export interface Lease {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Destroy the context and confirm it is gone. Safe to call more than once. */
  release(): Promise<void>;
}

export interface LeaseOptions {
  fingerprint: Fingerprint;
  /**
   * Per-context egress. Chrome applies proxy settings per BrowserContext, which
   * is what lets one browser process serve profiles bound to different IPs —
   * without it we would need one Chrome per account and the density argument
   * collapses.
   */
  proxyServer?: string;
  /** Hard ceiling on how long this profile may hold the slot. */
  timeoutMs?: number;
}

export class LeaseTimeoutError extends Error {
  constructor(ms: number) {
    super(`lease exceeded ${ms}ms and was force-released`);
    this.name = "LeaseTimeoutError";
  }
}

export class DisposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisposalError";
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function acquireLease(
  browser: Browser,
  opts: LeaseOptions,
): Promise<Lease> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const context = await browser.createBrowserContext(
    opts.proxyServer ? { proxyServer: opts.proxyServer } : {},
  );

  let released = false;
  const dispose = async (): Promise<void> => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    try {
      await context.close();
    } catch (err) {
      throw new DisposalError(`context.close() failed: ${String(err)}`);
    }
    // Verify rather than trust. A context still listed here is one that can
    // hand this account's cookies to the next lease on the same slot.
    if (browser.browserContexts().includes(context)) {
      throw new DisposalError("context still attached to browser after close()");
    }
  };

  // Force-release on deadline. Abandoning a hung lease would hold the slot and
  // leave the cookie jar resident, so the timer disposes rather than just
  // rejecting the caller.
  const timer = setTimeout(() => {
    void dispose().catch(() => {});
  }, timeoutMs);
  timer.unref?.();

  try {
    const page = await context.newPage();
    await applyFingerprint(page, opts.fingerprint);
    return { context, page, release: dispose };
  } catch (err) {
    await dispose().catch(() => {});
    throw err;
  }
}

/**
 * Apply the identity that travels with the account.
 *
 * Only covers the surfaces Chrome exposes per context. hardwareConcurrency,
 * deviceMemory and the WebGL vendor/renderer strings are process-wide, so they
 * are handled by pinning the profile to a Chrome instance whose configuration
 * matches `fingerprint.hardwareClass` — not here.
 */
export async function applyFingerprint(page: Page, fp: Fingerprint): Promise<void> {
  await page.setUserAgent(fp.userAgent);
  await page.setViewport(fp.viewport);
  await page.emulateTimezone(fp.timezone);
  await page.setExtraHTTPHeaders({ "Accept-Language": fp.locale });
  const cdp = await page.createCDPSession();
  try {
    await cdp.send("Emulation.setLocaleOverride", { locale: fp.locale });
  } finally {
    await cdp.detach().catch(() => {});
  }
}
