import type { Retention } from "../drivers/driver";
import type { Job } from "./Job";
import type {
  JobBuilder,
  JobBuilderOptions,
  RepeatEveryOptions,
} from "./JobBuilder";
import type { JobOptions } from "./types";
import { ConfigError } from "../shared/errors";
import { parseDuration } from "../shared/humanTime";

export type { RepeatEveryOptions } from "./JobBuilder";

/**
 * A job described in Agenda's shape — made, set up, then saved.
 *
 * ```ts
 * const job = jobs.create("sendEmail", { to: "ops@example.com" });
 * job.priority(1).schedule("in 10 minutes").attempts(5);
 * await job.save();
 * ```
 *
 * Nothing is written until `save()`. The setters are the `JobOptions`
 * vocabulary, read exactly as the rest of the package reads it: a duration, a
 * phrase or a cron expression goes through the same parsing `schedule()`'s
 * builder uses, and a malformed duration or interval fails at the setter. A
 * date phrase is read at save, as the builder reads it at `start()`, so
 * "tomorrow" means tomorrow from the save. The definition's options sit under
 * whatever is set here, as they do for `now()` and `schedule()`; whatever is
 * said last wins, as it would for two calls to the same setter.
 *
 * Where Agenda differs, this follows the package rather than Agenda:
 * `priority` is lower-runs-first and numeric only, `unique` takes an id rather
 * than a query, and `repeatEvery` does not run at once unless told to
 * (`immediately: true`), as `repeat` never does anywhere else here.
 *
 * **Saving twice.** A draft describes one job, so it is saved once:
 *
 * - `save()` again with nothing changed answers with the job the first save
 *   returned, and writes nothing — including while that first save is still
 *   in flight, so two callers racing to save one draft add one job;
 * - `save()` after a setter has changed the draft throws a `ConfigError`,
 *   because the stored job would silently not match it. Change the stored job
 *   through its own methods (`setPriority`, `updateData`, `reschedule`), or
 *   `create()` another;
 * - a save that threw was not saved: the draft can be corrected and saved
 *   again. A failure after the backend accepted the write can still have
 *   added the job, so give `unique(id)` where a retried save must not add a
 *   second one.
 */
export class JobDraft<TData = unknown, TResult = unknown> {
  /** The defined name the job is saved under. */
  readonly name: string;

  /** Holds the description, and adds it on save. */
  readonly #builder: JobBuilder<TData, TResult>;
  /** The job the first successful save returned. */
  #saved: Job<TData, TResult> | undefined;
  /** The save in flight, which a concurrent `save()` joins. */
  #saving: Promise<Job<TData, TResult>> | undefined;
  /** Whether a setter was called after a save began. */
  #changed = false;

  constructor(
    /** The builder that holds the description, with the definition's defaults under it. */
    builder: JobBuilder<TData, TResult>,
    /** The defined name the job is saved under. */
    name: string,
  ) {
    this.#builder = builder;
    this.name = name;
  }

  /** Whether a save has succeeded. */
  get isSaved(): boolean {
    return this.#saved !== undefined;
  }

  /** The job the successful save returned, or `undefined` before one. */
  get job(): Job<TData, TResult> | undefined {
    return this.#saved;
  }

  /** Sets what the job carries, replacing what `create()` was given. */
  withData(data: TData): this {
    return this.#edit((builder) => builder.withData(data));
  }

  /**
   * Gives the job an id of your choosing, which is also its idempotency key:
   * saving a draft with an id that is already stored adds nothing and answers
   * with the stored job (`wasAdded: false`). On a repeating job it names the
   * series instead.
   */
  unique(id: string): this {
    return this.#edit((builder) => builder.unique(id));
  }

  /** {@link JobDraft.unique}, under the raw `JobOptions` name. */
  jobId(id: string): this {
    return this.unique(id);
  }

  /** Lower runs first; ties break FIFO. */
  priority(value: number): this {
    return this.#edit((builder) => builder.priority(value));
  }

  /**
   * When the job runs — a `Date`, epoch milliseconds, or words such as
   * `"in 10 minutes"` or `"2nd december 2026"`. On a repeating job, when the
   * series begins. Wins over `delay()`, as `runAt` wins over `delay`.
   */
  schedule(when: Date | number | string): this {
    return this.#edit((builder) => builder.on(when));
  }

  /** Runs the job after a delay — milliseconds, or `"5 minutes"`. */
  delay(delay: number | string): this {
    if (typeof delay === "string") {
      const ms = parseDuration(delay.replace(/^in\s+/i, ""));

      if (ms === null) {
        throw new ConfigError(
          `delay() could not read "${delay}" as a duration`,
          { delay },
        );
      }

      return this.#edit((builder) => builder.in(ms));
    }

    return this.#edit((builder) => builder.in(delay));
  }

  /** Total attempts, including the first. */
  attempts(count: number): this {
    return this.#edit((builder) => builder.attempts(count));
  }

  /** How long to wait between attempts: milliseconds, or a strategy. */
  backoff(strategy: JobOptions["backoff"]): this {
    return this.#edit((builder) => builder.backoff(strategy));
  }

  /** How long one attempt may take — milliseconds, or `"30 seconds"`. */
  timeout(limit: number | string): this {
    return this.#edit((builder) => builder.timeout(limit));
  }

  /**
   * Repeats the job: milliseconds, a duration (`"2 days"`), a phrase or a cron
   * expression, read as `schedule(name).every()` reads it. Calling it again
   * replaces the schedule; options given again replace the ones given before.
   */
  repeatEvery(interval: number | string, options?: RepeatEveryOptions): this {
    return this.#edit((builder) => builder.repeatEvery(interval, options));
  }

  /** How long the job is kept once it completes; see `JobOptions.removeOnComplete`. */
  removeOnComplete(retention: Retention): this {
    return this.#edit((builder) =>
      builder.withOptions({ removeOnComplete: retention }),
    );
  }

  /** How long the job is kept once it is dead; see `JobOptions.removeOnFail`. */
  removeOnFail(retention: Retention): this {
    return this.#edit((builder) =>
      builder.withOptions({ removeOnFail: retention }),
    );
  }

  /** How many failed attempts' stack traces the job keeps. */
  keepStacktraces(count: number): this {
    return this.#edit((builder) =>
      builder.withOptions({ keepStacktraces: count }),
    );
  }

  /** How many log lines the job keeps, newest last. `0` keeps every line. */
  keepLogs(lines: number): this {
    return this.#edit((builder) => builder.keepLogs(lines));
  }

  /** A queue, in the same namespace, that receives a copy of the job if it dies. */
  deadLetter(queue: string): this {
    return this.#edit((builder) => builder.deadLetter(queue));
  }

  /** Keeps one pending job per `id`; see `JobOptions.debounce`. Not with `repeatEvery` or `unique`. */
  debounce(id: string, ttl: number | string): this {
    return this.#edit((builder) => builder.debounce(id, ttl));
  }

  /** At most one job per `id` per `ttl`; see `JobOptions.throttle`. Not with `repeatEvery` or `unique`. */
  throttle(id: string, ttl: number | string): this {
    return this.#edit((builder) => builder.throttle(id, ttl));
  }

  /** Sets several things at once, under the builder's names or the raw ones. */
  withOptions(options: JobBuilderOptions<TData>): this {
    return this.#edit((builder) => builder.withOptions(options));
  }

  /**
   * Adds the job to the queue its definition routes to, and answers with it.
   *
   * A combination the queue refuses — `repeatEvery` with `debounce`,
   * `debounce` with `throttle`, `unique` with either — is refused here, as a
   * `ConfigError`, and nothing is written. See the class for saving twice.
   */
  async save(): Promise<Job<TData, TResult>> {
    if (this.#changed) {
      // Joining the save in flight, or answering with the saved job, would
      // hand back a job that does not match the draft as it now stands.
      throw this.#saved
        ? new ConfigError(
            `This "${this.name}" draft was already saved as job ${this.#saved.id} and a setter was called since; change the stored job through its methods, or create() another`,
            { name: this.name, id: this.#saved.id },
          )
        : new ConfigError(
            `A setter was called on this "${this.name}" draft while it was being saved; await that save, then change the stored job through its methods or create() another`,
            { name: this.name },
          );
    }

    if (this.#saved) {
      return this.#saved;
    }

    if (this.#saving) {
      return await this.#saving;
    }

    const saving = this.#builder.start();
    this.#saving = saving;

    try {
      const job = await saving;
      this.#saved = job;
      return job;
    } catch (error) {
      // Nothing was saved, so an edit made while it was in flight is simply
      // part of the next attempt.
      this.#changed = false;
      throw error;
    } finally {
      this.#saving = undefined;
    }
  }

  /** Applies a setter, noting it when a save has already begun. */
  #edit(apply: (builder: JobBuilder<TData, TResult>) => void): this {
    apply(this.#builder);

    if (this.#saved || this.#saving) {
      this.#changed = true;
    }

    return this;
  }
}
