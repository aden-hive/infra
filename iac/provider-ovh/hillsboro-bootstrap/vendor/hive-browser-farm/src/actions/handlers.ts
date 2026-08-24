import type { Page } from "puppeteer-core";
import type { ActionHandlers, ActionContext } from "./executor.ts";
import { MESSAGING_URL } from "../browser/check.ts";
import { LINKEDIN } from "../server/outbox.ts";
import {
  listThreads, openThread, readMessages, sendMessage,
  openComposerFromProfile, threadIdFromUrl,
} from "../linkedin/threads.ts";
import { reactToPost, activityIdFromUrn, assertOnLinkedIn } from "../linkedin/reactions.ts";
import { readProfileStatus } from "../linkedin/threads.ts";
import { detectRelationship, sendInvite } from "../linkedin/connect.ts";

/**
 * The one place real action handlers are defined.
 *
 * Previously these lived inline in one-off scripts, which meant every caller
 * re-declared them and — worse — the scripts that actually sent a message and
 * applied a reaction called the DOM helpers directly, bypassing the executor's
 * breaker check, health check and write gate. A safety layer nothing routes
 * through is decoration.
 *
 * Handlers deliberately contain no locking, session verification or
 * persistence. The executor owns all of that; a handler receives a page whose
 * session has just been verified and does one job on it.
 */

async function ensureOnMessaging(page: Page): Promise<void> {
  if (!page.url().includes("/messaging/")) {
    await page.goto(MESSAGING_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 4000));
  }
}

/**
 * Optional hook for pushing what an action learned into the store.
 *
 * Reading a thread is expensive and sends a read receipt, so the result should
 * never be discarded after rendering once — the next viewer would pay the same
 * cost and emit a second receipt.
 */
export interface HandlerDeps {
  emitEvent?: (event: unknown) => Promise<void>;
}

export function createHandlers(deps: HandlerDeps = {}): ActionHandlers {
  return {
    list_threads: async ({ page, action }: ActionContext) => {
      if (action.type !== "list_threads") throw new Error("handler mismatch");
      await ensureOnMessaging(page);
      return listThreads(page, action.limit);
    },

    read_thread: async ({ page, action, accountId }: ActionContext) => {
      if (action.type !== "read_thread") throw new Error("handler mismatch");
      await ensureOnMessaging(page);
      const threadId = await openThread(page, action.correspondent);
      if (threadId === null && !threadIdFromUrl(page.url())) {
        throw new Error(`no conversation with "${action.correspondent}" in the visible list`);
      }
      const resolvedThreadId = threadId ?? threadIdFromUrl(page.url());
      const messages = await readMessages(page);
      // Persist what this read cost us, so nobody pays for it twice — but an
      // empty read is a failed read, not an emptied thread (see loop.ts).
      if (messages.length > 0) await deps.emitEvent?.({
        kind: "thread_read", platform: LINKEDIN, accountId,
        correspondent: action.correspondent, threadId: resolvedThreadId,
        messages, at: Date.now(),
      }).catch?.(() => undefined);
      return { threadId: resolvedThreadId, messages };
    },

    check_profile: async ({ page, action }: ActionContext) => {
      if (action.type !== "check_profile") throw new Error("handler mismatch");
      await page.goto(action.profileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await new Promise((r) => setTimeout(r, 5000));
      assertOnLinkedIn(page.url());
      return readProfileStatus(page);
    },

    send_message: async ({ page, action }: ActionContext) => {
      if (action.type !== "send_message") throw new Error("handler mismatch");
      if (action.profileUrl) {
        await page.goto(action.profileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await new Promise((r) => setTimeout(r, 5000));
        assertOnLinkedIn(page.url());

        // Check reachability before opening anything. LinkedIn will not offer a
        // Send button to a non-connection without InMail, and discovering that
        // as "no-send-button" three steps later tells the caller nothing about
        // why — or that sending a connection request is the actual next step.
        const status = await readProfileStatus(page);
        // Degree, not the Message button: the button is shown to non-connections
        // too and leads to an InMail wall. `null` degree means we could not read
        // it, so we try rather than block on a failed parse.
        if (status.degree !== null && status.degree !== "1st") {
          throw new Error(
            `cannot message this profile as this account: degree=${status.degree}. ` +
            `LinkedIn only offers a real composer to 1st-degree connections; ` +
            `anything else gets an InMail upsell. Connect first, or send from an ` +
            `account that is already connected. Available actions: [${status.actions.join(", ")}]`,
          );
        }
        if (!(await openComposerFromProfile(page))) {
          throw new Error("could not open composer from profile");
        }
      } else {
        await ensureOnMessaging(page);
        const opened = await openThread(page, action.correspondent!);
        if (opened === null && !threadIdFromUrl(page.url())) {
          throw new Error(`no conversation with "${action.correspondent}" in the visible list`);
        }
      }
      await sendMessage(page, action.text);
      await new Promise((r) => setTimeout(r, 4000));

      // Verify by reading the thread back. A send that silently no-ops looks
      // identical to success from the caller's side.
      const messages = await readMessages(page);
      const needle = action.text.slice(0, 30);
      const landed = messages.some((m) => m.fromSelf && m.text.includes(needle));
      if (!landed) throw new Error("message not visible in the thread after sending");
      return { threadId: threadIdFromUrl(page.url()), messageCount: messages.length, verified: true };
    },

    send_connection_request: async ({ page, action }: ActionContext) => {
      if (action.type !== "send_connection_request") throw new Error("handler mismatch");
      await page.goto(action.profileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await new Promise((r) => setTimeout(r, 5000));
      assertOnLinkedIn(page.url());
      const result = await sendInvite(page, action.note);
      // Campaign-level stops are raised rather than returned: a caller looping
      // over targets must not read "restricted" as this-profile-failed and
      // carry on to the next one.
      if (result.haltCampaign) {
        throw new Error(`[HALT CAMPAIGN] ${result.status}${result.detail ? `: ${result.detail}` : ""}`);
      }
      return result;
    },

    check_connection: async ({ page, action }: ActionContext) => {
      if (action.type !== "check_connection") throw new Error("handler mismatch");
      await page.goto(action.profileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await new Promise((r) => setTimeout(r, 5000));
      assertOnLinkedIn(page.url());
      return detectRelationship(page);
    },

    react_to_post: async ({ page, action }: ActionContext) => {
      if (action.type !== "react_to_post") throw new Error("handler mismatch");
      await page.goto(action.postUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await new Promise((r) => setTimeout(r, 6000));
      // postUrl may be an lnkd.in shortlink, and a shortener resolves wherever
      // it likes — check where we landed before clicking anything.
      assertOnLinkedIn(page.url());
      const result = await reactToPost(page, action.reaction);
      return { ...result, activityId: activityIdFromUrn(result.activityUrn) };
    },
  };
}
