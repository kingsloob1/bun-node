/**
 * Retry timing (typed-client plan §6.1): the backoff between attempts and
 * the `Retry-After` header.
 *
 * The backoff is bun-common's `computeBackoff` (`bun-common/lib/utils/native.ts`)
 * with `type: "exponential"`, `factor: 2`, copied rather than imported so the
 * client never pulls bun-common into a frontend (D17).
 * `__tests__/backoff.test.ts` runs both over one vector
 * (`__tests__/fixtures/backoff-vector.json`), so the copies cannot drift.
 */

/** The backoff's knobs, in the client's words ({@link RetryConfig}'s). */
export interface BackoffSchedule {
  /** First delay, ms (`computeBackoff`'s `delay`). */
  baseMs: number;
  /** Largest delay before jitter, ms (`computeBackoff`'s `max`). */
  maxMs: number;
  /** Jitter fraction, 0 to 1: the delay moves by up to ± this share of itself. */
  jitter: number;
}

/**
 * The delay before attempt `attempt + 1`, given that `attempt` (1-based) just
 * failed: `baseMs × 2^(attempt − 1)`, capped at `maxMs`, then moved by up to
 * ± `jitter` of itself (so a jittered delay may sit slightly above `maxMs`,
 * never below zero), exactly as `computeBackoff` does.
 *
 * @param random A uniform number in [0, 1); `Math.random` by default, a
 *   fixed value in the shared vector.
 */
export function backoffDelay(
  attempt: number,
  schedule: BackoffSchedule,
  random: () => number = Math.random,
): number {
  const step = Math.max(1, Math.floor(attempt));
  const capped = Math.min(schedule.baseMs * 2 ** (step - 1), schedule.maxMs);
  if (!schedule.jitter) return Math.max(0, capped);
  const spread = capped * schedule.jitter;
  return Math.max(0, capped + (random() * 2 - 1) * spread);
}

/**
 * A `Retry-After` header as milliseconds from `now`: delay-seconds (`120`) or
 * an HTTP date (RFC 9110 §10.2.3). `undefined` when absent or unreadable; a
 * date in the past is `0`.
 */
export function retryAfterMs(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  // Every HTTP-date form names its month; `Date.parse` alone takes "-5" as a year.
  if (!/[a-z]{3}/i.test(value)) return undefined;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
