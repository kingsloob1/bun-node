import type { CronOptions } from "./cron";
import { nextCronDate, parseCron } from "./cron";
import { ConfigError } from "./errors";

/**
 * When a runner (or a repeatable job) should fire.
 *
 * Three shapes cover every case: a cron expression (five- or six-field — see
 * `./cron`), a fixed interval, or a single absolute instant. `null` means
 * "manual only": nothing fires until something calls `trigger()`.
 */

/** The longest delay `setTimeout` can hold; longer waits are chunked. */
const MAX_TIMEOUT = 2_147_483_647;

/** Milliseconds in a minute — the grid a five-field cron fires on. */
const MINUTE_MS = 60_000;

/** A normalised schedule. Absolute times are epoch milliseconds, so it is JSON. */
export type RunnerSchedule =
  | { cron: string; tz?: string }
  | { every: number; anchor?: number }
  | { at: number }
  | null;

/** What a caller may pass as a schedule. */
export type ScheduleInput =
  | string
  | number
  | Date
  | { cron: string; tz?: string }
  | { every: number; anchor?: Date | number }
  | { at: Date | number }
  | null
  | undefined;

/** Epoch milliseconds from a `Date` or a number. */
function toMs(value: Date | number, what: string): number {
  const ms = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(ms)) {
    throw new ConfigError(`${what} must be a valid date or timestamp`, {
      value,
    });
  }
  return ms;
}

/**
 * Normalises any accepted schedule shape, validating it eagerly so a bad
 * expression fails at construction rather than at the first missed tick.
 *
 * A bare string is a cron expression, a bare number is an interval in
 * milliseconds, and a bare `Date` is a one-shot.
 */
export function normalizeSchedule(input: ScheduleInput): RunnerSchedule {
  if (input === undefined || input === null) {
    return null;
  }

  if (typeof input === "string") {
    return { cron: parseCron(input).expression };
  }

  if (typeof input === "number") {
    return normalizeSchedule({ every: input });
  }

  if (input instanceof Date) {
    return { at: toMs(input, "schedule.at") };
  }

  if ("cron" in input) {
    const options: CronOptions | undefined = input.tz
      ? { tz: input.tz }
      : undefined;
    const parsed = parseCron(input.cron, options);
    return {
      cron: parsed.expression,
      ...(parsed.tz ? { tz: parsed.tz } : {}),
    };
  }

  if ("every" in input) {
    if (!Number.isFinite(input.every) || input.every <= 0) {
      throw new ConfigError("schedule.every must be a positive number of ms", {
        every: input.every,
      });
    }
    return {
      every: Math.floor(input.every),
      ...(input.anchor === undefined
        ? {}
        : { anchor: toMs(input.anchor, "schedule.anchor") }),
    };
  }

  if ("at" in input) {
    return { at: toMs(input.at, "schedule.at") };
  }

  throw new ConfigError("Unrecognised schedule", {
    schedule: input as unknown,
  });
}

/**
 * The next fire time strictly after `from` (default: now), or `null` when the
 * schedule has none left — a past one-shot, an impossible cron expression, or
 * a manual-only schedule.
 *
 * An `every` schedule without an `anchor` is measured from `from`, so it
 * fires one interval later; with an anchor it stays on the anchor's grid,
 * which is what keeps a long-running ticker drift-free.
 */
export function nextFireDate(
  schedule: RunnerSchedule,
  from?: Date,
): Date | null {
  if (!schedule) {
    return null;
  }

  const start = from ?? new Date();

  if ("cron" in schedule) {
    return nextCronDate(
      schedule.cron,
      start,
      schedule.tz ? { tz: schedule.tz } : undefined,
    );
  }

  if ("every" in schedule) {
    const fromMs = start.getTime();
    if (schedule.anchor === undefined) {
      return new Date(fromMs + schedule.every);
    }

    const elapsed = fromMs - schedule.anchor;
    const steps = Math.floor(elapsed / schedule.every) + 1;
    return new Date(schedule.anchor + steps * schedule.every);
  }

  return schedule.at > start.getTime() ? new Date(schedule.at) : null;
}

/** A running ticker. */
export interface Ticker {
  /** Stops the ticker. Idempotent. */
  stop: () => void;
  /** The next fire time, or `null` when nothing more will fire. */
  next: () => Date | null;
}

/** Options for {@link createTicker}. */
export interface TickerOptions {
  /**
   * When `false` the ticker's timers are `unref`'d, so a process with nothing
   * else to do exits instead of waiting for the next tick.
   */
  keepAlive: boolean;
}

/**
 * Fires `onTick` on `schedule` until stopped.
 *
 * `onTick` must return synchronously — it is a notification, not the work.
 * A five-field cron uses `Bun.cron` directly (which computes its next fire
 * only after the handler's promise settles, so an async handler there would
 * silently suppress the cadence); everything else arms one timer at a time
 * from the *scheduled* time, which keeps a long-running interval drift-free.
 *
 * A tick that arrives late (a suspended machine, a blocked loop) fires once
 * and then re-arms from the present: missed occurrences are skipped rather
 * than replayed in a burst, matching `Bun.cron`'s own behaviour.
 */
export function createTicker(
  schedule: RunnerSchedule,
  onTick: (scheduledAt: Date) => void,
  options: TickerOptions,
): Ticker {
  if (!schedule) {
    return { stop: () => {}, next: () => null };
  }

  // A five-field cron is exactly what Bun.cron handles natively.
  if ("cron" in schedule) {
    const parsed = parseCron(
      schedule.cron,
      schedule.tz ? { tz: schedule.tz } : undefined,
    );

    if (parsed.seconds === null) {
      const job = Bun.cron(
        parsed.minuteExpression,
        () => {
          // The in-process handler takes no controller, so recover the
          // scheduled instant by rounding: a five-field cron always fires on
          // a minute boundary, and ticks are a minute or more apart.
          const now = Date.now();
          onTick(new Date(Math.round(now / MINUTE_MS) * MINUTE_MS));
        },
        schedule.tz ? { tz: schedule.tz } : undefined,
      );

      if (!options.keepAlive) {
        job.unref();
      }

      return {
        stop: () => job.stop(),
        next: () => nextFireDate(schedule),
      };
    }
  }

  return createTimeoutTicker(schedule, onTick, options);
}

/**
 * The general ticker: one timer at a time, re-armed after each fire. Used for
 * intervals, one-shots and sub-minute cron, none of which `Bun.cron` covers.
 */
function createTimeoutTicker(
  schedule: RunnerSchedule,
  onTick: (scheduledAt: Date) => void,
  options: TickerOptions,
): Ticker {
  // Anchor an un-anchored interval at creation, so every later fire is
  // computed from the same grid instead of accumulating each timer's lateness.
  const anchored: RunnerSchedule =
    schedule && "every" in schedule && schedule.anchor === undefined
      ? { ...schedule, anchor: Date.now() }
      : schedule;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let target: Date | null = null;
  let stopped = false;

  /**
   * Arms one timer for `fireAt`, then re-arms itself for the next occurrence.
   * A delay beyond `setTimeout`'s range is chunked by re-arming for the
   * remainder rather than firing early.
   */
  const armFor = (fireAt: Date): void => {
    const delay = Math.max(0, fireAt.getTime() - Date.now());

    timer = setTimeout(
      () => {
        if (stopped) {
          return;
        }

        if (Date.now() < fireAt.getTime()) {
          armFor(fireAt);
          return;
        }

        onTick(fireAt);

        // Re-arm from the later of the scheduled time and now, so a tick that
        // ran late skips the backlog instead of replaying it in a burst.
        const from = new Date(Math.max(fireAt.getTime(), Date.now()));
        target = nextFireDate(anchored, from);
        if (target && !stopped) {
          armFor(target);
        }
      },
      Math.min(delay, MAX_TIMEOUT),
    );

    if (!options.keepAlive) {
      timer.unref?.();
    }
  };

  target = nextFireDate(anchored, new Date());
  if (target) {
    armFor(target);
  }

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    next: () => (stopped ? null : target),
  };
}
