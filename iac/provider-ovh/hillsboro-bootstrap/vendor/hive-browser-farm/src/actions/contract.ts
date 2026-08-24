import { z } from "zod";

/**
 * The action contract — the boundary between the two clusters.
 *
 * An agent turn spans both: reasoning on GCP, browser on OVH. If this interface
 * were fine-grained CDP (`click`, `type`, `waitForSelector`), every turn would
 * be 10–30 WAN round trips and every LinkedIn DOM change would break a remote
 * call mid-flight. Coarse-grained, each action is one or two round trips and
 * DOM churn stays on the OVH side where the browser is.
 *
 * So this is an RPC contract, not a convenience layer over browser control.
 * **Do not add an escape hatch that proxies raw CDP across the WAN** — it would
 * become the default path, and the split stops being viable.
 *
 * Actions are versioned as a set. A caller pins `CONTRACT_VERSION` and a
 * mismatch is refused rather than best-effort interpreted: acting on a
 * misunderstood instruction with someone's real account is worse than failing.
 */
export const CONTRACT_VERSION = 1;

/**
 * Actions that do not send anything.
 *
 * "Read" is not the same as "no effect": opening a conversation marks it read
 * and emits a **read receipt** to the other party, and LinkedIn offers no way
 * to see a thread's contents without opening it. An agent that reads every
 * unread thread is visibly "seen"-ing all of them, which is a product decision
 * as much as a technical one.
 */
export const ReadActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("list_threads"),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.object({
    type: z.literal("read_thread"),
    /**
     * Threads are addressed by correspondent, not by id.
     *
     * Measured, not assumed: the conversation list carries no durable
     * identifier. The only ids present are ember-generated (`...ember50`) and
     * change on every render, and thread links are absent from the list
     * entirely. A canonical id exists only in the URL once a thread is open,
     * so it is something an action *returns*, never something a caller can
     * know in advance.
     */
    correspondent: z.string().min(1),
  }),
  z.object({
    type: z.literal("check_profile"),
    profileUrl: z.string().url(),
  }),
  /** Relationship state only — the gate for whether an invite is even possible. */
  z.object({
    type: z.literal("check_connection"),
    profileUrl: z.string().url(),
  }),
  z.object({
    type: z.literal("list_invitations"),
    limit: z.number().int().min(1).max(50).default(20),
  }),
]);

/**
 * Actions with outward effects — they reach real people from a real account.
 *
 * Separated from reads in the type system, not merely by convention, so the
 * executor can require an explicit allow for them and so an agent bug cannot
 * turn a read loop into an outreach campaign.
 */
/**
 * LinkedIn's six reactions. `like` is the default because it is the one the
 * button applies on a plain click; the other five require opening the picker,
 * which is a different and more fragile interaction.
 */
export const REACTIONS = ["like", "celebrate", "support", "love", "insightful", "funny"] as const;
export type Reaction = (typeof REACTIONS)[number];

export const WriteActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("react_to_post"),
    /**
     * Must be an http(s) LinkedIn URL, not merely a parseable URI.
     *
     * `z.string().url()` alone accepts `activity:123` and `javascript:…` —
     * `new URL()` treats any scheme as valid. This value is navigated to, so
     * the scheme and host are checked here rather than at the browser.
     */
    postUrl: z.string().url().refine(
      (u) => {
        try {
          const parsed = new URL(u);
          // lnkd.in is LinkedIn's own shortener and is accepted, but a
          // shortener can in principle point anywhere — so the *landing* host
          // is re-checked after navigation, before anything is clicked.
          return /^https?:$/.test(parsed.protocol)
            && (/(^|\.)linkedin\.com$/.test(parsed.hostname)
              || parsed.hostname === "lnkd.in");
        } catch {
          return false;
        }
      },
      { message: "postUrl must be an http(s) linkedin.com or lnkd.in URL" },
    ),
    /**
     * Reacting is public: it surfaces to the author and, for a like, into the
     * networks of the reacting account's connections. It is a write for the
     * same reason a message is, even though it sends no text.
     */
    reaction: z.enum(REACTIONS).default("like"),
  }),
  /**
   * Addressed either by existing conversation or by profile.
   *
   * Both are needed and neither is sufficient. A correspondent name only finds
   * someone already in the conversation list — measured: the list renders about
   * ten rows before virtualising, so most contacts are simply not addressable
   * that way. A profile URL opens a composer whether or not a thread exists,
   * which is the only route to a first message.
   */
  z.object({
    type: z.literal("send_message"),
    correspondent: z.string().min(1).optional(),
    profileUrl: z.string().url().optional(),
    text: z.string().min(1).max(8000),
  }),
  /**
   * Connection invitation.
   *
   * Ported from the `hive.linkedin-connect` skill, including its status
   * taxonomy: several outcomes here are not failures to retry but campaign-level
   * stops. `weekly_limit_hit` and `account_restricted` in particular must halt
   * everything — continuing past a restriction is how a temporary one becomes
   * permanent.
   */
  z.object({
    type: z.literal("send_connection_request"),
    profileUrl: z.string().url().refine(
      (u) => {
        try {
          const p = new URL(u);
          return /^https?:$/.test(p.protocol) && /(^|\.)linkedin\.com$/.test(p.hostname);
        } catch { return false; }
      },
      { message: "profileUrl must be an http(s) linkedin.com URL" },
    ),
    /** Free-tier cap is 200 chars, and the monthly note quota is ~5. */
    note: z.string().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal("accept_invitation"),
    invitationId: z.string().min(1),
  }),
]);

export const ActionSchema = z.union([ReadActionSchema, WriteActionSchema]);
export type ReadAction = z.infer<typeof ReadActionSchema>;
export type WriteAction = z.infer<typeof WriteActionSchema>;
export type Action = z.infer<typeof ActionSchema>;

export function isWriteAction(action: Action): action is WriteAction {
  return action.type === "send_message"
    || action.type === "accept_invitation"
    || action.type === "react_to_post"
    || action.type === "send_connection_request";
}

export const ThreadSummarySchema = z.object({
  correspondent: z.string(),
  preview: z.string(),
  /** Position in the list at read time. Ordering shifts, so it is a hint. */
  position: z.number().int(),
  /**
   * Canonical thread id from the URL, present only for a thread that was open.
   * Null in a plain listing — see the note on `read_thread`.
   */
  threadId: z.string().nullable(),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

export const MessageSchema = z.object({
  from: z.string(),
  text: z.string(),
  /** Verbatim as LinkedIn rendered it; relative stamps are not resolved here. */
  sentAtLabel: z.string(),
  fromSelf: z.boolean(),
});
export type Message = z.infer<typeof MessageSchema>;

export const InvitationSchema = z.object({
  invitationId: z.string(),
  from: z.string(),
  headline: z.string(),
  note: z.string().nullable(),
});
export type Invitation = z.infer<typeof InvitationSchema>;

/**
 * Every action resolves to one of these. `refused` is deliberately distinct
 * from `failed`: a refusal means we declined to act (unhealthy session, write
 * not permitted, contract mismatch) and retrying unchanged will refuse again,
 * whereas a failure may be transient. Collapsing them would invite a caller to
 * retry a refusal in a loop against a challenged account.
 */
export type ActionResult =
  | { status: "ok"; action: Action["type"]; data: unknown; unread?: number | null }
  | { status: "refused"; action: Action["type"]; reason: string }
  | { status: "failed"; action: Action["type"]; reason: string };

export function parseAction(raw: unknown, version: number): Action {
  if (version !== CONTRACT_VERSION) {
    throw new Error(
      `action contract mismatch: caller v${version}, executor v${CONTRACT_VERSION}`,
    );
  }
  const action = ActionSchema.parse(raw);
  // Checked here rather than as a schema refinement: `discriminatedUnion`
  // cannot hold a refined object, and losing the discriminated union would
  // cost the exhaustiveness that lets handlers narrow on `action.type`.
  if (action.type === "send_message" && !action.correspondent === !action.profileUrl) {
    throw new Error("send_message needs exactly one of correspondent or profileUrl");
  }
  return action;
}
