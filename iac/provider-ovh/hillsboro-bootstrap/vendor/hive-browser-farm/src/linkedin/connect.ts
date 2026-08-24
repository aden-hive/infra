import type { Page } from "puppeteer-core";

/**
 * Connection invitations.
 *
 * Ported from the `hive.linkedin-connect` skill in hive-desktop-runtime rather
 * than rediscovered. Four things in it are not guessable and cost real
 * campaigns to learn:
 *
 *  1. **Relationship state lives in owner-scoped aria-labels.** "Invite <Owner>
 *     to connect", "Pending, click to withdraw…", "Accept <Owner>'s request to
 *     connect", "Message <Owner>". Scoping to the profile owner's name is what
 *     filters out the sidebar's "People also viewed" controls — the same trap
 *     that made a document-wide search return five Message buttons here.
 *
 *  2. **Modals live in an open shadow root at `#interop-outlet`.** A plain
 *     `document.querySelector('[role=dialog]')` finds nothing, which is exactly
 *     why probing the profile Message overlay reported zero editable elements.
 *
 *  3. **`.click()` is ignored inside that shadow root.** Ember's listeners need
 *     `dispatchEvent(new MouseEvent('click', {bubbles, cancelable, composed: true}))`.
 *
 *  4. **The Connect modal is persistent and stateful across profiles.** It has
 *     an Initial sub-state (Add-a-note / Send-without-note) and a Note-mode
 *     sub-state (textarea / Send-invitation), and LinkedIn does *not* reset it
 *     between Connect clicks. Opening it on profile B can land you in the
 *     sub-state profile A left behind, so the sub-state must be re-read after
 *     every open rather than assumed.
 */

/** Free-tier client-side cap; the on-screen counter reads "0/200". */
export const NOTE_MAX_CHARS = 200;

export type Relationship =
  | "not_connected"
  | "connected"
  | "invite_pending"
  | "they_invited_us"
  | "cannot_connect";

export type InviteStatus =
  | "sent"
  | "already_connected"
  | "invite_already_pending"
  | "they_invited_you"
  | "cannot_connect"
  | "requires_email_or_phone"
  | "note_quota_exhausted"
  | "weekly_limit_hit"
  | "account_restricted"
  | "note_too_long";

export interface InviteResult {
  status: InviteStatus;
  relationship?: Relationship;
  noteUsed?: boolean;
  noteQuotaRemaining?: number | null;
  /**
   * Set on `weekly_limit_hit` and `account_restricted`.
   *
   * Both mean stop the whole campaign, not retry this profile. Auto-dismissing
   * a security challenge is how a temporary restriction becomes a permanent
   * ban, so the caller must halt rather than continue with other targets.
   */
  haltCampaign?: boolean;
  detail?: string;
}

/** Owner-scoped state detection. `owner` is the profile's h1 text. */
export async function detectRelationship(page: Page): Promise<{
  relationship: Relationship; owner: string;
}> {
  return page.evaluate((): { relationship: Relationship; owner: string } => {
    type Relationship =
      | "not_connected" | "connected" | "invite_pending"
      | "they_invited_us" | "cannot_connect";

    // Measured: profile pages render **no h1 at all** on the current UI, so the
    // upstream skill's h1-first lookup yields an empty owner and every
    // owner-scoped check then fails closed as `cannot_connect`. The document
    // title is the reliable source. Strip LinkedIn's unread-count prefix —
    // "(2) Ada Lovelace | LinkedIn" — or the count ends up inside the name and
    // the aria-label match never fires.
    const fromTitle = document.title
      .replace(/^\(\d+\)\s*/, "")
      .replace(/\s*\|\s*LinkedIn\s*$/i, "")
      .trim();
    const owner = (document.querySelector("h1")?.textContent ?? "").trim() || fromTitle;
    let hasConnect = false, hasPending = false, hasAccept = false, hasMessage = false;

    for (const el of Array.from(document.querySelectorAll("button, a"))) {
      const aria = el.getAttribute("aria-label") ?? "";
      const text = (el.textContent ?? "").trim();
      if (owner && aria === `Invite ${owner} to connect`) hasConnect = true;
      // LinkedIn renders the possessive with a Unicode right single quote.
      if (owner && /^Accept .+[’'']s request to connect$/i.test(aria) && aria.includes(owner)) {
        hasAccept = true;
      }
      if (text === "Pending" || /^Pending,/i.test(aria)) hasPending = true;
      // Conservative: a bare "Message" appears all over the sidebar too.
      if (text === "Message" && owner && (aria === "" || aria.includes(owner))) hasMessage = true;
    }

    // Order matters: an inbound invite must route to accept, never to a retry.
    const relationship: Relationship =
      hasAccept ? "they_invited_us" :
      hasPending ? "invite_pending" :
      hasConnect ? "not_connected" :
      hasMessage ? "connected" :
      "cannot_connect";
    return { relationship, owner };
  });
}

/**
 * Send an invitation. Assumes the page is already on the target profile and
 * the session has been verified by the executor.
 */
export async function sendInvite(page: Page, note?: string): Promise<InviteResult> {
  if (note && note.length > NOTE_MAX_CHARS) {
    return { status: "note_too_long", detail: `${note.length} > ${NOTE_MAX_CHARS}` };
  }

  const { relationship, owner } = await detectRelationship(page);
  if (relationship === "connected") return { status: "already_connected", relationship };
  if (relationship === "invite_pending") return { status: "invite_already_pending", relationship };
  if (relationship === "they_invited_us") return { status: "they_invited_you", relationship };
  if (relationship === "cannot_connect") return { status: "cannot_connect", relationship };

  const clicked = await page.evaluate((ownerName: string) => {
    const el = document.querySelector(
      `a[aria-label="Invite ${ownerName} to connect"], button[aria-label="Invite ${ownerName} to connect"]`,
    );
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
    return true;
  }, owner);
  if (!clicked) return { status: "cannot_connect", relationship, detail: "connect control vanished" };

  await new Promise((r) => setTimeout(r, 2000));

  const outcome = await page.evaluate(async (wanted: string | null) => {
    const outlet = document.querySelector("#interop-outlet");
    const root = (outlet as unknown as { shadowRoot?: ShadowRoot } | null)?.shadowRoot;
    if (!root) return { kind: "no_modal" as const };

    const q = (sel: string): Element | null => root.querySelector(sel);
    const fire = (el: Element): void => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const bodyText = (root.textContent ?? "");
    if (/email address to verify|we don.t know/i.test(bodyText)) {
      return { kind: "requires_email" as const };
    }

    // Re-read the sub-state rather than assume it: the modal persists across
    // profiles and may already be in Note-mode from a previous invite.
    const inNoteMode = !!q("textarea") || !!q('button[aria-label="Send invitation"]');

    if (wanted === null) {
      if (inNoteMode) {
        const cancel = q('button[aria-label="Cancel adding a note"]');
        if (cancel) { fire(cancel); await sleep(900); }
      }
      const send = q('button[aria-label="Send without a note"]')
        ?? q('button[aria-label="Send invitation"]');
      if (!send) return { kind: "no_send_button" as const, text: bodyText.slice(0, 120) };
      fire(send);
      return { kind: "sent" as const, noteUsed: false, quota: null as number | null };
    }

    if (!inNoteMode) {
      const addNote = q('button[aria-label="Add a note"]');
      if (!addNote) return { kind: "no_send_button" as const, text: bodyText.slice(0, 120) };
      fire(addNote);
      await sleep(1200);
    }
    const textarea = root.querySelector("textarea") as HTMLTextAreaElement | null;
    // LinkedIn refuses to render the textarea once the free-tier monthly note
    // quota is spent — that absence *is* the quota signal.
    if (!textarea) return { kind: "note_quota_exhausted" as const };

    const quotaText = /(\d+)\s+personalized invitation/i.exec(root.textContent ?? "");
    textarea.focus();
    textarea.value = wanted;
    textarea.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await sleep(500);
    const send = q('button[aria-label="Send invitation"]');
    if (!send) return { kind: "no_send_button" as const, text: "send-invitation missing after note" };
    fire(send);
    return {
      kind: "sent" as const, noteUsed: true,
      quota: quotaText?.[1] ? Number.parseInt(quotaText[1], 10) : null,
    };
  }, note ?? null);

  await new Promise((r) => setTimeout(r, 2500));

  // Post-send checks outrank the click's own report: a restriction redirect or
  // a weekly-cap notice can appear after the modal accepted the click.
  const url = page.url();
  if (/\/checkpoint\//i.test(url)) {
    return { status: "account_restricted", relationship, haltCampaign: true, detail: url };
  }
  const capped = await page.evaluate(() =>
    /you.ve reached the weekly invitation limit|weekly invitation limit/i.test(document.body.innerText));
  if (capped) return { status: "weekly_limit_hit", relationship, haltCampaign: true };

  switch (outcome.kind) {
    case "requires_email": return { status: "requires_email_or_phone", relationship };
    case "note_quota_exhausted": return { status: "note_quota_exhausted", relationship };
    case "sent":
      return {
        status: "sent", relationship,
        noteUsed: outcome.noteUsed, noteQuotaRemaining: outcome.quota,
      };
    default:
      return { status: "cannot_connect", relationship, detail: `modal: ${outcome.kind}` };
  }
}
