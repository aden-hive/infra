import type { Page } from "puppeteer-core";
import type { ThreadSummary } from "../actions/contract.ts";

/**
 * Reading the conversation list.
 *
 * Anchored on ARIA, not class names. Measured on the live page 2026-08-21:
 * LinkedIn ships `ul[aria-label="Conversation List"]` and, per row,
 * `label[aria-label="Select conversation with <Name>"]`. Both are user-facing
 * accessibility text, which changes far less often than the obfuscated class
 * names that rotate on every deploy.
 *
 * Two things the same measurement ruled out, so nobody re-tries them:
 *   - `a[href*="/messaging/thread/"]` — zero matches; the list has no links.
 *   - element ids — ember-generated (`...ember50`) and per-render.
 *
 * The list also contains empty spacer rows (7 of 18 when measured), so rows
 * are filtered by content rather than taken positionally.
 */
export const CONVERSATION_LIST = 'ul[aria-label="Conversation List"]';
export const SELECT_LABEL = 'label[aria-label^="Select conversation with"]';
export const COMPOSER = '[aria-label="Write a message…"]';

export async function listThreads(page: Page, limit: number): Promise<ThreadSummary[]> {
  return page.evaluate(
    (listSel: string, labelSel: string, max: number) => {
      const ul = document.querySelector(listSel);
      if (!ul) return [];
      const rows = Array.from(ul.children).filter((r) => ((r as HTMLElement).innerText ?? "").trim().length > 0);
      const out: Array<{ correspondent: string; preview: string; position: number; threadId: string | null }> = [];
      rows.slice(0, max).forEach((row, i) => {
        const label = row.querySelector(labelSel);
        const aria = label?.getAttribute("aria-label") ?? "";
        const correspondent = aria.replace(/^Select conversation with\s*/i, "").trim();
        if (!correspondent) return;
        // Row text is name / date / date / preview / trailing a11y hints. Take
        // the longest line as the preview rather than a fixed index, since the
        // number of leading date lines varies by row.
        // Rows carry screen-reader affordances alongside the message text, and
        // they are often the longest line — so "longest wins" reliably picked
        // "Open the options list in your conversation with …" instead of the
        // actual preview. Drop the known affordances first.
        const AFFORDANCE = /^(\.|Open the options list|Press return|Active conversation|Select conversation)/i;
        const DATE_ONLY = /^(\w{3} \d{1,2}|\d{1,2}:\d{2}\s?(AM|PM)?|Yesterday|Today)$/i;
        const lines = ((row as HTMLElement).innerText ?? "")
          .split("\n").map((l) => l.trim())
          .filter((l) => l && !AFFORDANCE.test(l) && !DATE_ONLY.test(l) && l !== correspondent);
        const preview = lines.sort((a, b) => b.length - a.length)[0] ?? "";
        out.push({ correspondent, preview: preview.slice(0, 400), position: i, threadId: null });
      });
      return out;
    },
    CONVERSATION_LIST,
    SELECT_LABEL,
    limit,
  );
}

/** Canonical thread id, available only from the URL of an open thread. */
export function threadIdFromUrl(url: string): string | null {
  return /\/messaging\/thread\/([^/?#]+)/.exec(url)?.[1] ?? null;
}

/**
 * Thread pane selectors. Confirmed present on the live page 2026-08-21.
 *
 * These are class-based, unlike the list, because the message pane exposes no
 * usable ARIA landmark — the only labelled lists on the page belong to the
 * conversation list and site navigation. LinkedIn's `msg-s-*` names are
 * BEM-style semantic classes rather than build hashes, which is why they are
 * survivable, but they are still the most brittle part of this file. If a
 * handler starts returning empty, check here first.
 */
export const MESSAGE_EVENT = ".msg-s-message-list__event";
export const MESSAGE_NAME = ".msg-s-message-group__name";
export const MESSAGE_BODY = ".msg-s-event-listitem__body";
export const MESSAGE_TIME = ".msg-s-message-group__timestamp";
/** Present on the correspondent's messages; its absence marks our own. */
export const FROM_OTHER = "msg-s-event-listitem--other";

export const SEND_BUTTON_TEXT = "Send";

/**
 * Open a conversation by correspondent name.
 *
 * !! Side effect: opening an unread conversation marks it read and emits a
 * read receipt to the other party. There is no way to read a thread's contents
 * without this — LinkedIn has no preview-without-opening. So `read_thread` is
 * not purely observational, and an agent that reads every unread thread is
 * visibly "seen"-ing them all.
 */
export async function openThread(page: Page, correspondent: string): Promise<string | null> {
  const opened = await page.evaluate(
    (listSel: string, name: string) => {
      const ul = document.querySelector(listSel);
      if (!ul) return false;
      for (const row of Array.from(ul.children)) {
        const label = row.querySelector('label[aria-label^="Select conversation with"]');
        const aria = label?.getAttribute("aria-label") ?? "";
        if (aria.replace(/^Select conversation with\s*/i, "").trim() !== name) continue;
        // Click the row's own clickable surface, not the selection checkbox —
        // the checkbox is for bulk actions and does not open the thread.
        const target = row.querySelector<HTMLElement>(".msg-conversation-listitem__link")
          ?? (row as HTMLElement);
        target.click();
        return true;
      }
      return false;
    },
    CONVERSATION_LIST,
    correspondent,
  );
  if (!opened) return null;

  // Wait for the pane to actually swap. Reading immediately after the click
  // returns the previous thread's messages, which is worse than an error
  // because it looks like a successful read of the wrong conversation.
  await page.waitForFunction(
    (sel: string) => document.querySelectorAll(sel).length > 0,
    { timeout: 15_000 },
    MESSAGE_EVENT,
  ).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1200));
  return threadIdFromUrl(page.url());
}

export async function readMessages(page: Page): Promise<Array<{
  from: string; text: string; sentAtLabel: string; fromSelf: boolean;
}>> {
  return page.evaluate(
    (eventSel: string, nameSel: string, bodySel: string, timeSel: string, otherCls: string) => {
      const out: Array<{ from: string; text: string; sentAtLabel: string; fromSelf: boolean }> = [];
      let lastName = "";
      for (const ev of Array.from(document.querySelectorAll(eventSel))) {
        // Consecutive messages from one sender are grouped, so only the first
        // carries a name. Carry it forward rather than emitting blanks.
        const name = ev.querySelector(nameSel)?.textContent?.trim();
        if (name) lastName = name;
        const text = ev.querySelector(bodySel)?.textContent?.trim() ?? "";
        if (!text) continue;
        out.push({
          from: lastName,
          text,
          sentAtLabel: ev.querySelector(timeSel)?.textContent?.trim() ?? "",
          fromSelf: !ev.querySelector(`.${otherCls}`) && !ev.classList.contains(otherCls),
        });
      }
      return out;
    },
    MESSAGE_EVENT, MESSAGE_NAME, MESSAGE_BODY, MESSAGE_TIME, FROM_OTHER,
  );
}

/**
 * Type into the composer and send.
 *
 * Reaches a real person from a real account. Only ever called through an
 * executor with writes explicitly enabled.
 *
 * The composer is located *from its own Send button*, not by selector alone.
 * A messaging page carries more than one `[aria-label="Write a message…"]` —
 * the main form plus the persistent bottom-right overlay widget — and typing
 * into the wrong one leaves text visibly on screen while the Send button of
 * the real form stays disabled. That reads as "LinkedIn rejected our input"
 * when in fact we filled in a different box.
 *
 * Text is typed rather than assigned: the Send button stays disabled until the
 * editor's own input handlers run, so setting textContent gives a filled box
 * that cannot be sent.
 */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const MARK = "data-hive-compose";
  const paired = await page.evaluate((attr: string) => {
    document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr));
    const sendBtn = Array.from(document.querySelectorAll("button"))
      .find((b) => /msg-form__send-button/.test(b.className.toString()))
      ?? Array.from(document.querySelectorAll("button")).find((b) => b.innerText.trim() === "Send");
    if (!sendBtn) return "no-send-button";
    // The form that owns this button owns the editable we must fill.
    const form = sendBtn.closest("form") ?? sendBtn.closest("[class*='msg-form']") ?? document.body;
    const editable = form.querySelector('[contenteditable="true"]')
      ?? document.querySelector('[contenteditable="true"]');
    if (!editable) return "no-editable";
    editable.setAttribute(attr, "1");
    sendBtn.setAttribute(attr + "-send", "1");
    (editable as HTMLElement).scrollIntoView({ block: "center" });
    return "ok";
  }, MARK);
  if (paired !== "ok") {
    // "no-send-button" on its own says nothing useful. The usual cause is that
    // the recipient is not a connection, so LinkedIn offers an InMail upsell
    // instead of a composer — the profile's Message button is shown regardless,
    // which is why profile state cannot predict this. Report what the page is
    // actually offering so the caller knows connecting is the next step.
    const context = await page.evaluate(() => {
      const body = document.body.innerText;
      const wall = /inmail|upgrade|premium|try premium/i.exec(body)?.[0] ?? null;
      return {
        wall,
        heading: (document.querySelector("h1, h2")?.textContent ?? "").trim().slice(0, 80),
      };
    });
    throw new Error(
      context.wall
        ? `no composer: LinkedIn is offering "${context.wall}" instead — this account ` +
          `is likely not connected to the recipient. Connect first, or send from an ` +
          `account that is already connected.`
        : `composer not located: ${paired}${context.heading ? ` (page: "${context.heading}")` : ""}`,
    );
  }

  await page.click(`[${MARK}]`);
  await page.keyboard.type(text, { delay: 25 });
  await new Promise((r) => setTimeout(r, 800));

  const ready = await page.evaluate((attr: string) => {
    const b = document.querySelector(`[${attr}-send]`) as HTMLButtonElement | null;
    return b ? !b.disabled : false;
  }, MARK);
  if (!ready) {
    const diag = await page.evaluate((attr: string) => ({
      typed: (document.querySelector(`[${attr}]`)?.textContent ?? "").slice(0, 50),
    }), MARK);
    throw new Error(`send button still disabled after typing ${JSON.stringify(diag)}`);
  }

  await page.click(`[${MARK}-send]`);
  await page.evaluate((attr: string) => {
    document.querySelectorAll(`[${attr}], [${attr}-send]`)
      .forEach((e) => { e.removeAttribute(attr); e.removeAttribute(attr + "-send"); });
  }, MARK);
}


/**
 * Profile page inspection.
 *
 * Note this is not effect-free either: LinkedIn shows profile owners who
 * viewed them, so visiting is itself a signal to the other party.
 *
 * Degree and the available primary action together decide what is possible —
 * a 1st-degree connection can be messaged directly, anyone else generally
 * needs a connection request first.
 */
export interface ProfileStatus {
  name: string;
  headline: string;
  /** "1st" | "2nd" | "3rd+" | null when not shown. */
  degree: string | null;
  /** Visible primary buttons, e.g. Connect / Message / Pending / Follow. */
  actions: string[];
  /**
   * A Message button is present — which is **not** the same as being able to
   * send. Measured: LinkedIn shows it to 2nd-degree contacts too, and the
   * composer it opens is an InMail upsell with no Send button. Treat this as
   * "worth trying", not as permission; `degree === "1st"` is the reliable
   * predictor.
   */
  canMessageDirectly: boolean;
  connectionPending: boolean;
}

export async function readProfileStatus(page: Page): Promise<ProfileStatus> {
  return page.evaluate(() => {
    const text = (sel: string): string =>
      document.querySelector(sel)?.textContent?.trim().replace(/\s+/g, " ") ?? "";

    // Scan anchors too, not just buttons. The profile "Message" control is a
    // plain <a> — scanning only buttons reported a 1st-degree connection as
    // unmessageable, which is a false negative that would have sent an
    // unnecessary connection request to an existing contact.
    const buttons = Array.from(document.querySelectorAll("button, a"))
      .map((b) => (b.textContent?.trim() || b.getAttribute("aria-label") || "").replace(/\s+/g, " "))
      .filter((t) => t.length > 0 && t.length < 60);

    const has = (re: RegExp): boolean => buttons.some((b) => re.test(b));
    const topCard = document.querySelector("h1")?.closest("section") ?? document.body;
    const degreeMatch = /·\s*(1st|2nd|3rd\+?)/.exec((topCard as HTMLElement).innerText ?? "");

    return {
      // Same as connect.ts: there is no h1 on a profile page, so the title is
      // the only place the name reliably appears.
      name: text("h1") || document.title
        .replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*LinkedIn\s*$/i, "").trim(),
      headline: text(".text-body-medium"),
      degree: degreeMatch?.[1] ?? null,
      actions: Array.from(new Set(buttons.filter((b) =>
        /^(Connect|Message|Pending|Follow|More|Accept|Withdraw)\b/i.test(b)))).slice(0, 8),
      canMessageDirectly: has(/^Message\b/i),
      connectionPending: has(/^Pending\b/i),
    };
  });
}

/**
 * Open the message composer from a profile page.
 *
 * Works whether or not a conversation already exists, unlike addressing a
 * thread by correspondent from the messaging list. The control is a plain
 * anchor, not a button — scanning only `button` elements reports a messageable
 * 1st-degree connection as unmessageable, which would send an unnecessary
 * connection request to an existing contact.
 */
/**
 * Open the message composer for the person whose profile is loaded.
 *
 * Measured: the profile "Message" control is a plain
 * `<a href="/messaging/compose/?profileUrn=urn:li:…">`, not a button that opens
 * an overlay. So we read the href and navigate — no click, no coordinates, no
 * overlay timing.
 *
 * Two dead ends worth recording so nobody repeats them. A synthetic
 * `element.click()` does nothing (LinkedIn wants genuine pointer input), and a
 * real mouse click is fragile because the page renders the same control several
 * times — six here, one of them zero-sized and one behind the top nav. Reading
 * the href sidesteps all of it, and works whether or not a conversation exists.
 */
export async function openComposerFromProfile(page: Page): Promise<boolean> {
  const href = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href*='/messaging/compose/']"))
      .map((a) => a.getAttribute("href"))
      .find((h) => !!h && h.includes("profileUrn")) ?? null,
  );
  if (!href) return false;

  await page.goto(new URL(href, "https://www.linkedin.com").toString(), {
    waitUntil: "domcontentloaded", timeout: 60_000,
  });
  await page.waitForSelector(COMPOSER, { timeout: 25_000 }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 2000));
  return !!(await page.$(COMPOSER));
}
