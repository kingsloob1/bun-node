import type { BackoffOptions, BackoffType } from "@kingsleyweb/bun-common";
import type { JobRecord } from "../drivers/index";
import { computeBackoff } from "@kingsleyweb/bun-common";
import { DEFAULT_JOB_BACKOFF } from "../shared/constants";
import { ConfigError } from "../shared/errors";

/**
 * How long a job waits before its next attempt.
 *
 * Six strategies are built in and computed by `computeBackoff`. Anything else
 * is a *name*: a job says `backoff: { type: "slowRamp" }`, and the worker that
 * runs it looks the name up among the strategies it was given.
 *
 * A name rather than a function, because a job's options are stored — in a
 * row, a hash, a document — and read back by whichever process claims it, on
 * whichever machine. A function cannot make that trip; the name of one can,
 * and each worker resolves it locally.
 */

/** The strategies `computeBackoff` implements, which a custom one may not shadow. */
export const BUILT_IN_BACKOFFS: readonly BackoffType[] = [
  "fixed",
  "exponential",
  "linear",
  "fibonacci",
  "full-jitter",
  "decorrelated-jitter",
];

/** A job's backoff: a built-in strategy, or the name of a registered one. */
export type JobBackoffOptions = Omit<BackoffOptions, "type"> & {
  /**
   * A built-in strategy, or the name of one registered on the worker.
   * Defaults to `"fixed"`.
   */
  type?: BackoffType | (string & {});
};

/** What a custom strategy is told about the attempt that just failed. */
export interface BackoffContext {
  /** How many attempts have been made, counting the one that just failed. */
  attempt: number;
  /** The job, as it was when the attempt failed. */
  job: JobRecord;
  /** Why the attempt failed. */
  error: Error;
  /** The job's backoff options, so `delay`, `max` and the rest are at hand. */
  options: JobBackoffOptions;
}

/**
 * A custom backoff: milliseconds to wait before the next attempt, or `false`
 * to stop retrying and let the job die now, attempts left or not.
 *
 * The result is capped at `options.max` when the job sets one.
 */
export type BackoffStrategy = (context: BackoffContext) => number | false;

/** Named backoff strategies, as a worker resolves them. */
export class BackoffStrategies {
  /** The strategies, by name. */
  readonly #strategies = new Map<string, BackoffStrategy>();

  /** Registers a strategy under a name. Registering a name again replaces it. */
  define(name: string, strategy: BackoffStrategy): this {
    if (typeof name !== "string" || name.length === 0) {
      throw new ConfigError("A backoff strategy needs a name", { name });
    }

    if ((BUILT_IN_BACKOFFS as readonly string[]).includes(name)) {
      throw new ConfigError(
        `"${name}" is a built-in backoff strategy; choose another name`,
        { name, builtIn: BUILT_IN_BACKOFFS },
      );
    }

    if (typeof strategy !== "function") {
      throw new ConfigError(
        `The backoff strategy "${name}" is not a function`,
        {
          name,
        },
      );
    }

    this.#strategies.set(name, strategy);
    return this;
  }

  /** The strategy registered under a name, if any. */
  get(name: string): BackoffStrategy | undefined {
    return this.#strategies.get(name);
  }

  /** Whether a name is registered. */
  has(name: string): boolean {
    return this.#strategies.has(name);
  }

  /** Every registered name. */
  names(): string[] {
    return [...this.#strategies.keys()];
  }

  /** A registry from what a worker option accepts: one already built, or a plain object. */
  static from(
    input?: BackoffStrategies | Record<string, BackoffStrategy>,
  ): BackoffStrategies {
    if (input instanceof BackoffStrategies) {
      return input;
    }

    const strategies = new BackoffStrategies();

    for (const [name, strategy] of Object.entries(input ?? {})) {
      strategies.define(name, strategy);
    }

    return strategies;
  }
}

/** Where {@link nextBackoff} reports a strategy it could not use. */
export type BackoffWarning = (
  message: string,
  fields: Record<string, unknown>,
) => void;

/**
 * How long to wait before retrying a job whose attempt just failed, or `false`
 * when its strategy says to stop.
 *
 * A strategy that cannot be used — a name this worker was not given, one that
 * throws, one that answers with something other than a non-negative number or
 * `false` — falls back to the default backoff and is reported through `warn`.
 * It is not allowed to fail the failure: the job still has attempts left, and
 * losing them to a typo in a strategy name would be the worse outcome.
 */
export function nextBackoff(
  attempt: number,
  job: JobRecord,
  error: Error,
  strategies: BackoffStrategies,
  warn: BackoffWarning,
): number | false {
  const backoff = job.opts.backoff;
  const fallback = () => computeBackoff(attempt, DEFAULT_JOB_BACKOFF);

  if (
    typeof backoff === "number" ||
    backoff.type === undefined ||
    (BUILT_IN_BACKOFFS as readonly string[]).includes(backoff.type)
  ) {
    return computeBackoff(attempt, backoff as BackoffOptions | number);
  }

  const name = backoff.type;
  const strategy = strategies.get(name);

  if (!strategy) {
    warn(
      `Job ${job.id} names the backoff strategy "${name}", which this worker was not given; using the default`,
      { jobId: job.id, strategy: name, known: strategies.names() },
    );
    return fallback();
  }

  let result: number | false;

  try {
    result = strategy({ attempt, job, error, options: backoff });
  } catch (thrown) {
    warn(
      `The backoff strategy "${name}" threw for job ${job.id}; using the default`,
      { jobId: job.id, strategy: name, error: thrown },
    );
    return fallback();
  }

  if (result === false) {
    return false;
  }

  if (typeof result !== "number" || !Number.isFinite(result) || result < 0) {
    warn(
      `The backoff strategy "${name}" returned ${String(result)} for job ${job.id}, not a delay; using the default`,
      { jobId: job.id, strategy: name, result },
    );
    return fallback();
  }

  return Math.min(result, backoff.max ?? Number.POSITIVE_INFINITY);
}
