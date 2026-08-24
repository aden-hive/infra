import type { Action, ActionResult } from "./contract.ts";

/**
 * Run one action across several accounts.
 *
 * The obvious implementation — loop and fire — is the one to avoid. Three
 * accounts reacting to the same post within the same second, from one egress,
 * is not three users agreeing with a post; it is a fleet announcing itself.
 * Correlation is the thing §6 spends real money to avoid, and firing in
 * lockstep hands it over for free.
 *
 * So execution is **sequential with a jittered gap**, and the gap is a feature
 * rather than politeness. Fan-out is also isolated per account: one failure
 * (an account that cannot reach the target, a tripped health check) must not
 * stop the rest, because a partial result is still useful and a caller that
 * has to re-run everything will re-fire the successes too.
 */
export interface FanoutOptions {
  minGapMs: number;
  maxGapMs: number;
  /** Injectable for tests, and so a caller can make gaps deterministic. */
  rand?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (accountId: string, result: ActionResult, index: number) => void;
}

export const DEFAULT_FANOUT: Pick<FanoutOptions, "minGapMs" | "maxGapMs"> = {
  minGapMs: 20_000,
  maxGapMs: 90_000,
};

export interface FanoutEntry {
  accountId: string;
  result: ActionResult;
  gapBeforeMs: number;
}

/**
 * `{{account}}` in any string field is replaced with the acting account id.
 *
 * Identical text sent to one person from several accounts reads as coordinated
 * in a way that identical *reactions* do not — a like is the same gesture from
 * everyone, a verbatim message is not. This is the minimum affordance for
 * varying it; real variation is the caller's job.
 */
export function personalise(action: Action, accountId: string): Action {
  const swap = (v: unknown): unknown =>
    typeof v === "string" ? v.replaceAll("{{account}}", accountId) : v;
  return Object.fromEntries(
    Object.entries(action).map(([k, v]) => [k, swap(v)]),
  ) as Action;
}

export async function fanout(
  execute: (accountId: string, action: Action) => Promise<ActionResult>,
  accountIds: readonly string[],
  action: Action,
  opts: FanoutOptions,
): Promise<FanoutEntry[]> {
  const rand = opts.rand ?? Math.random;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const out: FanoutEntry[] = [];

  for (const [index, accountId] of accountIds.entries()) {
    // No gap before the first account; the gap separates accounts, it is not a
    // delay on the operation itself.
    const gapBeforeMs = index === 0
      ? 0
      : Math.round(opts.minGapMs + rand() * (opts.maxGapMs - opts.minGapMs));
    if (gapBeforeMs > 0) await sleep(gapBeforeMs);

    let result: ActionResult;
    try {
      result = await execute(accountId, personalise(action, accountId));
    } catch (err) {
      // Isolate: a thrown executor is this account's problem, not the run's.
      result = {
        status: "failed", action: action.type,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    out.push({ accountId, result, gapBeforeMs });
    opts.onProgress?.(accountId, result, index);
  }
  return out;
}
