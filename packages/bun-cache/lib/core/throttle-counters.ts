/**
 * The throttle's counters, counted in one round trip by the backend itself:
 * a Lua script on Redis, one statement on Postgres, one multi-statement
 * query on MySQL and MariaDB, one transaction on SQLite. Internal: nothing
 * here is exported from the package; `cacheThrottleStore`
 * (`lib/throttle/index.ts`) uses it when the cache's driver offers it.
 *
 * Each step reads the time from the backend (Redis `TIME`, Postgres
 * `clock_timestamp()`, MySQL and MariaDB `UTC_TIMESTAMP(6)`, SQLite
 * `julianday('now')`) unless it is given one, so every process sharing the
 * backend places a request in the same window whatever its own clock says,
 * and a GCRA bucket (the throttle's `"gcra"`) is one value read, judged and
 * written atomically, which a cache counter cannot do.
 *
 * **Keys.** A window's counter is `<base>:<index>`, the index computed on the
 * backend, in the counter layout the driver already uses (Redis's
 * `<p>:{<ns>}:n:<key>` hash, the SQL drivers' entry row with `v` null), so
 * the cache's `delete` and `clear` reach it. A GCRA bucket is the counter at
 * its key, its value the theoretical arrival time in **microseconds**
 * (integers, so a fractional emission interval loses nothing that matters).
 * The caller keeps `base` within {@link THROTTLE_BASE_MAX} bytes, so the
 * counter's name fits the SQL drivers' 255-character key column.
 */

/** The symbol a built-in driver offers its {@link ThrottleCounters} under. */
export const THROTTLE_COUNTERS: unique symbol = Symbol(
  "bun-cache:throttle-counters",
);

/** The longest `base` a window step takes, bytes: a window's index and its `:` must still fit a 255-character key. */
export const THROTTLE_BASE_MAX = 200;

/** One window step, as {@link ThrottleCounters.window} takes it. */
export interface WindowStep {
  /** The window, ms. */
  window: number;
  /** Units to add; `0` reads only (nothing is created); negative gives back to a live counter (nothing is created). A safe integer. */
  cost: number;
  /** Whether the previous window's count is wanted (sliding window), which also makes the counter live one window longer. */
  previous: boolean;
  /** The time to place the request by, epoch ms; `undefined` for the backend's own clock. */
  now: number | undefined;
  /** Milliseconds added to the counter's lifetime. */
  margin: number;
}

/** What a window step found. */
export interface WindowStepResult {
  /** The current window's count, the cost included. */
  current: number;
  /** The previous window's count (`0` when none, or not asked for). */
  previous: number;
  /** The time the step was placed by, epoch ms. */
  now: number;
}

/** One GCRA step, as {@link ThrottleCounters.gcra} takes it. */
export interface GcraStep {
  /** The emission interval times the cost, µs, rounded up: how far the arrival time moves. `0` reads only; negative gives back to an existing bucket (none is created). */
  step: number;
  /** The bucket's depth, µs: the window. A step fits while the new arrival time is at most this far ahead. */
  capacity: number;
  /** The time, epoch µs; `undefined` for the backend's own clock. */
  now: number | undefined;
  /** Milliseconds added to the bucket's lifetime past its arrival time. */
  margin: number;
}

/** What a GCRA step found. */
export interface GcraStepResult {
  /** Whether the step fitted (and, for a non-zero step, was taken). */
  allowed: boolean;
  /** The theoretical arrival time after the step (allowed) or as it stands (refused), µs, never before {@link now}. */
  tat: number;
  /** The time the step was judged by, epoch µs. */
  now: number;
}

/** A driver's throttle counters: see the module header. */
export interface ThrottleCounters {
  /** One window step on `<base>:<index>` in namespace `ns`. */
  window: (
    ns: string,
    base: string,
    step: WindowStep,
  ) => Promise<WindowStepResult>;
  /** Deletes the current and previous windows' counters under `base`, as placed by `now` or the backend's clock. */
  deleteWindow: (
    ns: string,
    base: string,
    window: number,
    now: number | undefined,
  ) => Promise<void>;
  /** One GCRA step on the bucket at `key`. */
  gcra: (ns: string, key: string, step: GcraStep) => Promise<GcraStepResult>;
}

/** A driver that offers {@link ThrottleCounters}. */
export interface HasThrottleCounters {
  /** The counters. */
  readonly [THROTTLE_COUNTERS]: ThrottleCounters;
}

/** The driver's throttle counters, when it offers them. */
export function throttleCountersOf(
  driver: object,
): ThrottleCounters | undefined {
  return (driver as Partial<HasThrottleCounters>)[THROTTLE_COUNTERS];
}

/** A number the backend answered (a string, a bigint, a number), as a number; `0` for none. */
export function counterNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  return Number(value);
}
