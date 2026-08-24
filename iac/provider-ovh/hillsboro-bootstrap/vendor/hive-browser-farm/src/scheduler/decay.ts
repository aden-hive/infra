/**
 * Polling cadence for a profile, as a pure function of how long ago the
 * account last did something.
 *
 * There is deliberately no warm/cold state machine. An account is "warm"
 * because it recently had an event, not because a flag says so — which means
 * nothing to expire, nothing to get stuck, and a scheduler that is correct
 * immediately after a restart without any recovery step.
 *
 * An "event" is an inbound reply OR an outbound send. Sends count because the
 * moment right after we message someone is when a reply is most likely.
 */

/** Ladder from age-of-last-event to polling interval. Ordered, first match wins. */
const LADDER: ReadonlyArray<{ maxAgeMs: number; intervalMs: number }> = [
  { maxAgeMs: 5 * 60_000, intervalMs: 60_000 },   // live exchange
  { maxAgeMs: 15 * 60_000, intervalMs: 120_000 },  // still trailing off
  { maxAgeMs: 60 * 60_000, intervalMs: 300_000 },  // probably done
];

/** Cadence for an account with no recent event. */
export const REGULAR_INTERVAL_MS = 600_000;

/**
 * Jitter fraction applied to every interval.
 *
 * Serves two purposes, and we need both: it stops hundreds of accounts on the
 * same nominal interval from self-synchronising into stampedes, and it stops
 * any single account from emitting requests at a suspiciously exact period.
 */
export const JITTER = 0.2;

/** Interval for an account whose last event was `ageMs` ago. */
export function intervalForAge(ageMs: number): number {
  if (!Number.isFinite(ageMs)) return REGULAR_INTERVAL_MS;
  const age = Math.max(0, ageMs);
  for (const rung of LADDER) {
    if (age < rung.maxAgeMs) return rung.intervalMs;
  }
  return REGULAR_INTERVAL_MS;
}

/** Apply +/- JITTER to an interval. `rand` returns [0,1); injectable for tests. */
export function jittered(intervalMs: number, rand: () => number = Math.random): number {
  const factor = 1 + (rand() * 2 - 1) * JITTER;
  return Math.round(intervalMs * factor);
}

/**
 * When this profile should next be checked.
 *
 * `lastEventAt` of null means we have never seen an event for this account —
 * treated as maximally stale, i.e. the regular cadence.
 */
export function nextCheckAt(
  now: number,
  lastEventAt: number | null,
  rand: () => number = Math.random,
): number {
  const age = lastEventAt === null ? Number.POSITIVE_INFINITY : now - lastEventAt;
  return now + jittered(intervalForAge(age), rand);
}

/**
 * Checks/day this cadence implies for one account seeing `eventsPerDay` events.
 *
 * This is the capacity model in code — the numbers in plan/browser-farm.md §7
 * come from here, so changing the ladder above changes the sizing and this
 * stays honest about it.
 */
export function checksPerDay(eventsPerDay: number): number {
  const baselinePerDay = 86_400_000 / REGULAR_INTERVAL_MS;
  let checksInEventHour = 0;
  let cursor = 0;
  const HOUR = 60 * 60_000;
  while (cursor < HOUR) {
    checksInEventHour += 1;
    cursor += intervalForAge(cursor);
  }
  const baselineInOneHour = HOUR / REGULAR_INTERVAL_MS;
  const addedPerEvent = checksInEventHour - baselineInOneHour;
  return baselinePerDay + addedPerEvent * eventsPerDay;
}
