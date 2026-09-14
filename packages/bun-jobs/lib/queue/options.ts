import type { ResolvedJobOptions, Retention } from "../drivers/index";
import type { JobOptions } from "./types";
import {
  DEFAULT_JOB_BACKOFF,
  DEFAULT_KEEP_STACKTRACES,
  DEFAULT_RESULT_TTL,
} from "../shared/constants";
import { ConfigError } from "../shared/errors";
import { assertSegment } from "../shared/keys";

/** Widest priority the drivers can order on; keeps marker names sortable. */
const PRIORITY_LIMIT = 1_048_576;

/** Defaults every job gets unless the queue or the call overrides them. */
export const DEFAULT_JOB_OPTIONS: ResolvedJobOptions = {
  priority: 0,
  attempts: 1,
  backoff: DEFAULT_JOB_BACKOFF,
  timeout: 0,
  removeOnComplete: { ttl: DEFAULT_RESULT_TTL },
  removeOnFail: false,
  keepStacktraces: DEFAULT_KEEP_STACKTRACES,
};

/** Applies queue defaults and this call's options over the built-in ones. */
export function resolveJobOptions(
  queueDefaults: JobOptions | undefined,
  options: JobOptions | undefined,
): ResolvedJobOptions {
  const merged: JobOptions = { ...queueDefaults, ...options };

  const attempts = merged.attempts ?? DEFAULT_JOB_OPTIONS.attempts;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new ConfigError("attempts must be a whole number of at least 1", {
      attempts,
    });
  }

  const priority = merged.priority ?? DEFAULT_JOB_OPTIONS.priority;
  if (!Number.isFinite(priority)) {
    throw new ConfigError("priority must be a number", { priority });
  }

  return {
    // Clamped rather than rejected: a caller reaching for "highest possible"
    // means it, and the drivers order on a bounded range.
    priority: Math.max(-PRIORITY_LIMIT, Math.min(PRIORITY_LIMIT, priority)),
    attempts,
    backoff: merged.backoff ?? DEFAULT_JOB_OPTIONS.backoff,
    timeout: merged.timeout ?? DEFAULT_JOB_OPTIONS.timeout,
    removeOnComplete:
      merged.removeOnComplete ?? DEFAULT_JOB_OPTIONS.removeOnComplete,
    removeOnFail: merged.removeOnFail ?? DEFAULT_JOB_OPTIONS.removeOnFail,
    keepStacktraces:
      merged.keepStacktraces ?? DEFAULT_JOB_OPTIONS.keepStacktraces,
    // Only present when named, so the stored options of every other job are
    // exactly what they were.
    ...(merged.deadLetter === undefined
      ? {}
      : {
          deadLetter: assertSegment(merged.deadLetter, "deadLetter queue name"),
        }),
  };
}

/** When a job becomes claimable: `runAt` if given, else `delay` from now. */
export function resolveRunAt(
  options: JobOptions | undefined,
  now: number,
): number {
  if (options?.runAt !== undefined) {
    const runAt =
      options.runAt instanceof Date ? options.runAt.getTime() : options.runAt;

    if (!Number.isFinite(runAt)) {
      throw new ConfigError("runAt must be a valid date or timestamp", {
        runAt: options.runAt,
      });
    }

    return runAt;
  }

  const delay = options?.delay ?? 0;
  if (!Number.isFinite(delay) || delay < 0) {
    throw new ConfigError("delay must be a non-negative number of ms", {
      delay,
    });
  }

  return now + delay;
}

/** When a finished job expires, given its retention. */
export function retentionExpiry(
  retention: Retention,
  now: number,
): number | null {
  if (typeof retention !== "object" || retention === null) {
    return null;
  }

  return retention.ttl && retention.ttl > 0 ? now + retention.ttl : null;
}
