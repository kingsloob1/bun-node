/**
 * Keeping a summon budget test inside the window it spends in.
 *
 * A summon budget (a queue's, or a group's) counts attempts per UTC hour and
 * per UTC day, in clock windows: at HH:00:00 the hour's count starts over. A
 * test that spends a budget and then counts what it allowed — five calls of
 * a limit of five, a `budget` refusal, the hour's count — sees a correct
 * controller look broken when an hour turns between the two: the new hour
 * allows the limit again (a race round of a limit of 5 once made 8 calls on
 * MongoDB, straddling 12:00 UTC). So before such a span it calls
 * {@link withinOneHour}. The same guard as the examples'
 * `examples/bun-jobs/shared/budget-window.ts`, copied: a package's tests import
 * nothing from `examples/`.
 */

/** One UTC hour, in ms: the budget's hourly window. */
export const HOUR_MS = 3_600_000;

/** The clock and the wait {@link withinOneHour} uses: injectable, so a test can put it near an hour's end. */
export interface WindowClock {
  /** The time now, epoch ms. Defaults to `Date.now`. */
  now?: () => number;
  /** Waits `ms`. Defaults to `Bun.sleep`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Milliseconds left in the UTC hour `now` falls in. */
export function hourLeft(now: number): number {
  return Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS - now;
}

/**
 * Waits for the next UTC hour when less than `neededMs` of this one is left,
 * so the steps after it spend and count a summon budget inside one hourly
 * window — and one daily window, since midnight is an hour boundary too.
 * Returns at once otherwise: a test waits at most `neededMs`, and only when it
 * gets here in an hour's last `neededMs`. Answers how long it waited.
 *
 * `neededMs` should be well above how long the guarded steps take on a loaded
 * machine; each caller says what it allows.
 */
export async function withinOneHour(
  /** How much of the current hour the guarded steps need, in ms. */
  neededMs: number,
  /** The clock and the wait, for a test of this guard. */
  clock: WindowClock = {},
): Promise<number> {
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? (async (ms: number) => await Bun.sleep(ms));
  let waited = 0;
  let left = hourLeft(now());
  while (left < neededMs) {
    // 50 ms past the turn, so the clock is surely in the next hour.
    await sleep(left + 50);
    waited += left + 50;
    left = hourLeft(now());
  }
  return waited;
}
