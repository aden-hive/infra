/**
 * Boot ramp.
 *
 * After a restart the queue is full of accounts that are due, most of them
 * overdue. Dispatching them as fast as slots free up would put hundreds of
 * LinkedIn sessions back on the wire within a minute or two, all from the same
 * small set of addresses — turning a clean recovery into a fleet-wide risk
 * event.
 *
 * Being overdue is not a reason to hurry. Detection latency of another half
 * hour costs nothing; looking like a botnet coming back online costs accounts.
 * §9: a stall must never turn into a scramble.
 *
 * The spread is deterministic by index rather than purely random, so coverage
 * is even instead of merely random-uniform — 400 independent draws leave
 * clumps, and clumps are the thing being avoided.
 */
export const DEFAULT_RAMP_MS = 30 * 60_000;

export function rampedFirstCheck(
  now: number,
  index: number,
  total: number,
  rampMs: number = DEFAULT_RAMP_MS,
  rand: () => number = Math.random,
): number {
  if (total <= 1) return now;
  const slotWidth = rampMs / total;
  const base = index * slotWidth;
  // Jitter inside the account's own slot: keeps the spread even while stopping
  // the schedule from being a perfectly regular tick.
  const jitter = (rand() - 0.5) * slotWidth;
  return now + Math.max(0, Math.round(base + jitter));
}

/** Ramped schedule for a whole fleet, in the order given. */
export function rampFleet(
  now: number,
  accountIds: readonly string[],
  rampMs: number = DEFAULT_RAMP_MS,
  rand: () => number = Math.random,
): Array<{ accountId: string; at: number }> {
  return accountIds.map((accountId, i) => ({
    accountId,
    at: rampedFirstCheck(now, i, accountIds.length, rampMs, rand),
  }));
}
