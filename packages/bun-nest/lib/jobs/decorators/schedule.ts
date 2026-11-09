import type { JobOptions, RepeatOptions } from "@kingsleyweb/bun-jobs";
import type { OnDenied, OnInvalid } from "../pipeline";
import { SCHEDULE_METADATA } from "../metadata";

/** What {@link Cron} and {@link Every} share. */
export interface ScheduleOptions
  extends
    Pick<JobOptions, "attempts" | "backoff" | "timeout" | "deadLetter">,
    Pick<
      RepeatOptions,
      "tz" | "limit" | "startAt" | "endAt" | "immediately" | "catchUp"
    > {
  /**
   * The series' key, and the job's name: what keeps a restart updating the series
   * rather than adding one. Defaults to `<Class>.<method>`, so renaming either
   * leaves the old series behind unless this is given.
   */
  name?: string;
  /** The queue the series lives on. Defaults to the module's `scheduleQueue`. */
  queue?: string;
  /**
   * Declares the series without adding it. It does not stop a series already
   * stored: `queue.disableRepeatable(key)` does, and that survives a deploy.
   */
  disabled?: boolean;
  /** The context's `name`; the default context when left out. */
  context?: string;
  /** See `ProcessorOptions.enhancers`. */
  enhancers?: boolean;
  /** See `ProcessorOptions.onDenied`. */
  onDenied?: OnDenied;
  /** See `ProcessorOptions.onInvalid`. */
  onInvalid?: OnInvalid;
}

/** What {@link Cron} takes. */
export type CronOptions = ScheduleOptions;

/** What {@link Every} takes. */
export type EveryOptions = ScheduleOptions;

/** What {@link Cron} or {@link Every} recorded on a method. */
export interface ScheduleMetadata {
  /** The cron expression, for `@Cron`. */
  readonly cron?: string;
  /** The interval, for `@Every`. */
  readonly every?: number | string;
  /** The options as given. */
  readonly options: ScheduleOptions;
}

/** Adds one series to what a method's decorators recorded. */
function recordSchedule(
  schedule: ScheduleMetadata,
): (
  target: object,
  key: string | symbol,
  descriptor?: PropertyDescriptor,
) => void {
  return (target, _key, descriptor) => {
    const method = (descriptor?.value ?? target) as object;
    const existing = (Reflect.getOwnMetadata(SCHEDULE_METADATA, method) ??
      []) as ScheduleMetadata[];
    Reflect.defineMetadata(SCHEDULE_METADATA, [...existing, schedule], method);
  };
}

/** What `@Cron` and `@Every` recorded on a method. */
export function schedulesOf(method: object): readonly ScheduleMetadata[] {
  return (Reflect.getMetadata(SCHEDULE_METADATA, method) ??
    []) as ScheduleMetadata[];
}

/**
 * Runs a method on a cron schedule, as a bun-jobs repeat series: **once per
 * occurrence across every replica**, where `@nestjs/schedule` runs a timer in each.
 * An occurrence is a job, so it retries, survives a restart, and shows in the
 * management API. The series is added at bootstrap, on the module's `scheduleQueue`,
 * and a worker there runs each occurrence through the Nest pipeline.
 *
 * ```ts
 * @Cron("0 3 * * *", { tz: "Europe/London", name: "nightly-cleanup" })
 * async nightly(@JobSignal() signal: AbortSignal) { … }
 * ```
 *
 * An expression or a zone it cannot read is a `ConfigError` at boot. An operator's
 * `queue.disableRepeatable(key)` survives a deploy: adding the series again at the
 * next boot does not re-enable it.
 *
 * @param expression Five fields, or six with seconds first.
 * @param options See {@link ScheduleOptions}.
 */
export function Cron(
  expression: string,
  options: CronOptions = {},
): MethodDecorator {
  return recordSchedule({ cron: expression, options });
}

/**
 * Runs a method every so often, as a bun-jobs repeat series, once per occurrence
 * across every replica: see {@link Cron}. Occurrences fall on one grid every replica
 * agrees on, multiples of the interval from the epoch unless `startAt` says otherwise,
 * so the first comes within one interval of the boot rather than exactly one after it.
 * A one-shot is `{ limit: 1 }`.
 *
 * @param interval Milliseconds, or what bun-jobs' `every` reads: a duration such as
 * `"5 minutes"`, a cron expression, or words such as `"every monday"`.
 * @param options See {@link ScheduleOptions}.
 */
export function Every(
  interval: number | string,
  options: EveryOptions = {},
): MethodDecorator {
  return recordSchedule({ every: interval, options });
}
