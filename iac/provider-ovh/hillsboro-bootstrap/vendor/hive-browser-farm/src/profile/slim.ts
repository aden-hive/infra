import type { Page } from "puppeteer-core";
import type { Cookie, ProfileBlob } from "./schema.ts";

/**
 * Moving account state in and out of an ephemeral browser context.
 *
 * Scope note, deliberately narrow: this handles cookies and localStorage only.
 * IndexedDB is *not* captured yet — whether LinkedIn sessions survive without
 * it is a question the Phase 0 spike answers empirically, and building an
 * IndexedDB exporter before knowing that would be speculative work on the
 * hardest part of the blob. `spike/migrate.ts` reports the answer.
 */

/** Origins whose localStorage we carry. Keep tight; every key costs blob size. */
export const CAPTURED_ORIGINS = ["https://www.linkedin.com"] as const;

export async function extractCookies(page: Page): Promise<Cookie[]> {
  const cdp = await page.createCDPSession();
  try {
    const { cookies } = await cdp.send("Network.getAllCookies");
    return cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      ...(c.sameSite ? { sameSite: c.sameSite as Cookie["sameSite"] } : {}),
    }));
  } finally {
    await cdp.detach().catch(() => {});
  }
}

export async function injectCookies(page: Page, cookies: Cookie[]): Promise<void> {
  if (cookies.length === 0) return;
  const cdp = await page.createCDPSession();
  try {
    await cdp.send("Network.setCookies", { cookies });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Read localStorage for whichever origin the page is currently on. */
export async function extractLocalStorage(
  page: Page,
): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null) continue;
      const value = localStorage.getItem(key);
      if (value !== null) out[key] = value;
    }
    return out;
  });
}

/**
 * Seed localStorage before any page script runs.
 *
 * Done as a pre-navigation hook rather than by navigating first and writing
 * after, because LinkedIn's bootstrap reads storage during its own startup —
 * writing afterwards would mean the first page load of every lease ran against
 * empty state and then disagreed with the second.
 */
export async function seedLocalStorage(
  page: Page,
  byOrigin: Record<string, Record<string, string>>,
): Promise<void> {
  await page.evaluateOnNewDocument((data: Record<string, Record<string, string>>) => {
    const entries = data[location.origin];
    if (!entries) return;
    for (const [key, value] of Object.entries(entries)) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // Storage disabled or full — a partial seed beats aborting navigation.
      }
    }
  }, byOrigin);
}

/** Full hydration for a fresh context, in the order the browser requires. */
export async function hydrate(page: Page, blob: ProfileBlob): Promise<void> {
  await injectCookies(page, blob.cookies);
  await seedLocalStorage(page, blob.localStorage);
}

/** Approximate on-disk size of a blob, for the size budget in §5. */
export function blobSizeBytes(blob: ProfileBlob): number {
  return Buffer.byteLength(JSON.stringify(blob), "utf8");
}
