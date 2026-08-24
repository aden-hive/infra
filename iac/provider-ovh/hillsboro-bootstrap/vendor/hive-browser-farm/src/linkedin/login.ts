import type { Page } from "puppeteer-core";
import { classify, type Classification } from "./classify.ts";

/**
 * Credential login, for accounts we own.
 *
 * §10 recommends the human-driven console over programmatic credential login,
 * and that guidance stands for *customer* accounts — the objection there is
 * password custody and consent, neither of which applies to an account we own.
 * What does still apply: a fresh login from an address with no history is the
 * single most scrutinised moment in an account's life, so this frequently ends
 * at a verification step rather than a session.
 *
 * The password is never stored, logged, or written to disk. It is typed into
 * the real login form in the same browser, at the same egress, with the same
 * fingerprint the account will run under — after this, the profile holds
 * cookies and the password is not needed again.
 */
export const LOGIN_URL = "https://www.linkedin.com/login";

export type LoginOutcome =
  | { status: "ok"; classification: Classification }
  | { status: "verification_required"; url: string; hint: string }
  | { status: "rejected"; url: string; hint: string };

export async function loginWithPassword(
  page: Page,
  email: string,
  password: string,
): Promise<LoginOutcome> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("input[type=password]", { timeout: 30_000 }).catch(() => undefined);

  const MARK = "data-hive-login";
  // Measured: the form's input ids are React-generated (`«r3»`, `«r4»`), so
  // `#username` matches nothing. Input `type` is the stable signal. LinkedIn
  // also renders the form twice — a responsive variant — so visibility decides
  // which copy is the live one, and "Sign in with Apple" must not be mistaken
  // for the submit button.
  const located = await page.evaluate((attr: string) => {
    document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr));
    const vis = (e: Element): boolean => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (e as HTMLElement).offsetParent !== null;
    };
    const email = Array.from(document.querySelectorAll("input[type=email], input[type=text]")).find(vis);
    const password = Array.from(document.querySelectorAll("input[type=password]")).find(vis);
    const submit = Array.from(document.querySelectorAll("button"))
      .find((b) => vis(b) && b.innerText.trim() === "Sign in");
    if (!email || !password || !submit) {
      return { ok: false as const, missing: [!email && "email", !password && "password", !submit && "submit"].filter(Boolean).join(",") };
    }
    email.setAttribute(attr, "email");
    password.setAttribute(attr, "password");
    submit.setAttribute(attr, "submit");
    return { ok: true as const };
  }, MARK);

  if (!located.ok) {
    const c = await classify(page);
    if (c.outcome === "OK") return { status: "ok", classification: c };
    return { status: "rejected", url: page.url(), hint: `login form incomplete (${located.missing}); page is ${c.outcome}` };
  }

  // Typed, not assigned: the form's own handlers gate the submit button, and a
  // directly-set value leaves a filled field that cannot be submitted.
  await page.click(`[${MARK}=email]`);
  await page.keyboard.type(email, { delay: 30 });
  await page.click(`[${MARK}=password]`);
  await page.keyboard.type(password, { delay: 30 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined),
    page.click(`[${MARK}=submit]`),
  ]);
  await new Promise((r) => setTimeout(r, 6000));

  const url = page.url();
  // A checkpoint here is the expected outcome for a new address, not a failure
  // of the login itself — the password was accepted and a second factor is
  // being demanded. Distinguishing the two decides whether a human is needed
  // or the credentials are simply wrong.
  if (/\/checkpoint\//i.test(url)) {
    const hint = await page.evaluate(() =>
      (document.querySelector("h1")?.textContent ?? document.title).trim().slice(0, 120));
    return { status: "verification_required", url, hint };
  }
  if (/\/login|\/uas\/login/i.test(url)) {
    const hint = await page.evaluate(() =>
      (document.querySelector("[role=alert], .form__label--error")?.textContent ?? "no error text")
        .trim().slice(0, 120));
    return { status: "rejected", url, hint };
  }

  const classification = await classify(page);
  if (classification.outcome === "OK") return { status: "ok", classification };
  return { status: "rejected", url, hint: `landed ${classification.outcome}` };
}
