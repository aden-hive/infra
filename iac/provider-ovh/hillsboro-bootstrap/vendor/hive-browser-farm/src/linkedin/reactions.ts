import type { Page } from "puppeteer-core";
import type { Reaction } from "../actions/contract.ts";

/**
 * Reacting to a post.
 *
 * The post DOM is markedly friendlier than messaging: controls are
 * ARIA-labelled and each post carries a durable `data-urn` of the form
 * `urn:li:activity:<id>`. Measured on a live activity page 2026-08-21:
 *
 *   button[aria-label="React Like"]          aria-pressed reflects current state
 *   button[aria-label="Open reactions menu"] hidden until the Like button is hovered
 *   div[data-urn="urn:li:activity:…"]        the post container to scope to
 *
 * `aria-pressed` is the useful part: it makes the action idempotent (we can see
 * we have already reacted) and verifiable (we can confirm the reaction took,
 * rather than trusting a click).
 */
export const POST_CONTAINER = "[data-urn^='urn:li:activity:']";

/**
 * Confirm the page we ended up on is really LinkedIn.
 *
 * `postUrl` may be an `lnkd.in` shortlink, and a shortener resolves wherever it
 * likes. Checking the landing host before clicking anything means a redirected
 * link cannot make the account interact with a page we never vetted.
 */
export function assertOnLinkedIn(finalUrl: string): void {
  const host = new URL(finalUrl).hostname;
  if (!/(^|\.)linkedin\.com$/.test(host)) {
    throw new Error(`refusing to act: link resolved to ${host}, not linkedin.com`);
  }
}
/**
 * LinkedIn ships two renderings of the reaction control, both live today:
 *
 *   activity feed  button[aria-label="React Like"]                  state in aria-pressed
 *   post permalink button[aria-label="Reaction button state: …"]    state in the label
 *
 * The second has no `aria-pressed` at all and hashed class names, so neither
 * the selector nor the state check from the first variant works there. Both are
 * matched, and current state is read from whichever signal that variant offers.
 */
export const LIKE_BUTTON =
  "button[aria-label^='React '], button[aria-label^='Reaction button state']";
export const REACTIONS_MENU_TRIGGER = "button[aria-label='Open reactions menu']";

export interface ReactionOutcome {
  activityUrn: string | null;
  reaction: Reaction;
  /** False when the post already carried a reaction from this account. */
  applied: boolean;
  alreadyReacted: boolean;
}

/**
 * Apply a reaction to the post on the current page.
 *
 * On a permalink there is one post; on a feed or activity list there are many,
 * so the first post container is used and its URN returned — the caller should
 * navigate to a permalink when it cares which post is hit.
 */
export async function reactToPost(page: Page, reaction: Reaction): Promise<ReactionOutcome> {
  const MARK = "data-hive-react";

  const located = await page.evaluate(
    (attr: string, postSel: string, likeSel: string) => {
      document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr));
      const post = document.querySelector(postSel);
      // Scope to the post that owns the button, never a bare document-wide
      // query: an activity page renders many posts and the first matching
      // control may belong to a different one entirely.
      const scope: ParentNode = post ?? document;
      const candidates = Array.from(scope.querySelectorAll(likeSel)).filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const like = candidates[0];
      if (!like) return { ok: false as const, reason: "no reaction button found" };
      like.setAttribute(attr, "1");
      (like as HTMLElement).scrollIntoView({ block: "center" });
      const label = like.getAttribute("aria-label") ?? "";
      return {
        ok: true as const,
        urn: post?.getAttribute("data-urn") ?? null,
        label,
        // Variant one exposes aria-pressed; variant two says so in the label.
        pressed: like.getAttribute("aria-pressed") === "true"
          || (/^Reaction button state/i.test(label) && !/no reaction/i.test(label)),
      };
    },
    MARK, POST_CONTAINER, LIKE_BUTTON,
  );
  if (!located.ok) throw new Error(`cannot react: ${located.reason}`);

  // Already reacted — do not toggle it off. A second call must not silently
  // undo the first, which is what clicking again would do.
  if (located.pressed) {
    return { activityUrn: located.urn, reaction, applied: false, alreadyReacted: true };
  }

  await new Promise((r) => setTimeout(r, 400));

  if (reaction === "like") {
    // Plain click applies Like; the picker is not involved.
    await page.click(`[${MARK}]`);
  } else {
    // The other five need the picker, which only renders on hover.
    await page.hover(`[${MARK}]`);
    await new Promise((r) => setTimeout(r, 1200));
    const picked = await page.evaluate(
      (attr: string, want: string) => {
        const target = Array.from(document.querySelectorAll("button, [role=button]"))
          .find((b) => {
            const label = (b.getAttribute("aria-label") ?? "").toLowerCase();
            const r = (b as HTMLElement).getBoundingClientRect();
            return label.includes(want) && label.includes("react") && r.width > 0 && r.height > 0;
          });
        if (!target) return false;
        target.setAttribute(attr + "-pick", "1");
        return true;
      },
      MARK, reaction,
    );
    if (!picked) {
      throw new Error(
        `reaction "${reaction}" not offered — the picker did not open, or its ` +
        `aria-labels differ from "React <Name>"`,
      );
    }
    await page.click(`[${MARK}-pick]`);
  }

  // Verify rather than trust the click, the same way a send is verified by
  // reading the thread back.
  await new Promise((r) => setTimeout(r, 2500));
  const confirmed = await page.evaluate(
    (attr: string) => {
      const like = document.querySelector(`[${attr}]`);
      const label = like?.getAttribute("aria-label") ?? "";
      return {
        pressed: like?.getAttribute("aria-pressed") === "true"
          || (/^Reaction button state/i.test(label) && !/no reaction/i.test(label)),
        label,
      };
    },
    MARK,
  );

  await page.evaluate((attr: string) => {
    document.querySelectorAll(`[${attr}], [${attr}-pick]`).forEach((e) => {
      e.removeAttribute(attr);
      e.removeAttribute(attr + "-pick");
    });
  }, MARK);

  if (!confirmed.pressed) {
    throw new Error(`reaction did not register (button still unpressed, label="${confirmed.label}")`);
  }
  return { activityUrn: located.urn, reaction, applied: true, alreadyReacted: false };
}

/** `urn:li:activity:7444448933759778835` → `7444448933759778835` */
export function activityIdFromUrn(urn: string | null): string | null {
  return urn ? (/urn:li:activity:(\d+)/.exec(urn)?.[1] ?? null) : null;
}
