/**
 * `fakeClock` (plan §13.1): a controllable clock for `createCache`'s `now`
 * option, so expiry, staleness and the fence are tested without waiting.
 *
 * ```ts
 * const clock = fakeClock();
 * const cache = createCache({ driver: memoryDriver({ now: clock.now }), now: clock.now });
 * clock.advance(61_000); // one minute later, without waiting one minute
 * ```
 */

/** A controllable clock. See the module header. */
export interface FakeClock {
  /** The current time, epoch ms — pass it as `createCache`'s `now` (and the memory driver's). */
  now: () => number;
  /** Moves the clock forward by `ms`; answers the new time. */
  advance: (ms: number) => number;
  /** Sets the clock to `ms`, epoch. */
  set: (ms: number) => void;
}

/** A clock tests control. Starts at `startMs` (the real now by default). */
export function fakeClock(startMs: number = Date.now()): FakeClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => (current += ms),
    set: (ms: number) => {
      current = ms;
    },
  };
}
