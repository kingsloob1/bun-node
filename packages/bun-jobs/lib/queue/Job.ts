import type {
  JobRecord,
  JobRef,
  JobsDriver,
  JobState,
  QueueRef,
  ResolvedJobOptions,
} from "../drivers/index";
import { deserializeError } from "@kingsleyweb/bun-common";
import { DEFAULT_KEEP_LOGS, DEFAULT_LOCK_DURATION } from "../shared/constants";
import { ConfigError, NotSupportedError } from "../shared/errors";
import { parseWhen } from "../shared/humanTime";
import { assertJsonSafe } from "../shared/json";
import { displayRepeatKey } from "./options";
import { retryJob } from "./retry";

/**
 * One job, as a producer or a processor sees it.
 *
 * A thin, immutable view over the stored record plus the handful of actions
 * that make sense on it. Mutating methods go to the driver and return what it
 * decided rather than assuming: `remove()` on an active job is refused, and
 * `extendLock()` fails once the lock is someone else's. `refresh()` is how a
 * caller re-reads state another process changed.
 */
export class Job<TData = unknown, TResult = unknown> {
  /** Identifies the job, and is its idempotency key. */
  readonly id: string;
  /** The name the producer gave it. */
  readonly name: string;
  /** The producer's payload. */
  readonly data: TData;
  /** Options after defaults were applied. */
  readonly opts: ResolvedJobOptions;
  /** Where the job is. */
  readonly state: JobState;
  /** Lower runs first. */
  readonly priority: number;
  /** When the job becomes claimable. */
  readonly runAt: number;
  /** When it was added. */
  readonly createdAt: number;
  /** When the current or last attempt started. */
  readonly processedOn: number | null;
  /** When it completed or died. */
  readonly finishedOn: number | null;
  /** When retention removes it. */
  readonly expiresAt: number | null;
  /** How many attempts have been made. */
  readonly attemptsMade: number;
  /** How many attempts are allowed. */
  readonly maxAttempts: number;
  /** How many times it stalled and was recovered. */
  readonly stalledCount: number;
  /** The latest progress value. */
  readonly progress: unknown;
  /** The processor's return value, once complete. */
  readonly returnValue: TResult | null;
  /** The most recent failure, rehydrated as an `Error`. */
  readonly failedReason: Error | null;
  /** Recent failures, newest first. */
  readonly stacktrace: Error[];
  /** The worker holding it, while active. */
  readonly workerId: string | null;
  /** The repeat series that produced it, when it is an occurrence of one. */
  readonly repeatKey: string | null;
  /** Whether `add()` created this job rather than finding an existing one. */
  readonly wasAdded: boolean;
  /** The job this one is a child of, in a flow, or `null`. */
  readonly parent: JobRef | null;

  /** The stored record this view was built from. */
  readonly #record: JobRecord;
  /** Where the job lives. */
  readonly #driver: JobsDriver;
  /**
   * Told when progress is recorded, so whoever owns this job can announce it.
   *
   * Only the worker running the job sees `updateProgress` called, and `Job`
   * has no emitter of its own — which is why the `progress` event was declared
   * on both `BunQueue` and `BunQueueWorker` and fired on neither.
   */
  readonly #onProgress?: (value: unknown) => void;
  /** Which queue it belongs to. */
  readonly #ref: QueueRef;

  constructor(
    driver: JobsDriver,
    ref: QueueRef,
    record: JobRecord,
    wasAdded = true,
    onProgress?: (value: unknown) => void,
  ) {
    this.#driver = driver;
    this.#ref = ref;
    this.#record = record;
    this.wasAdded = wasAdded;
    this.#onProgress = onProgress;

    this.id = record.id;
    this.name = record.name;
    this.data = record.data as TData;
    this.opts = record.opts;
    this.state = record.state;
    this.priority = record.priority;
    this.runAt = record.runAt;
    this.createdAt = record.createdAt;
    this.processedOn = record.processedOn;
    this.finishedOn = record.finishedOn;
    this.expiresAt = record.expiresAt;
    this.attemptsMade = record.attemptsMade;
    this.maxAttempts = record.maxAttempts;
    this.stalledCount = record.stalledCount;
    this.progress = record.progress;
    this.returnValue = (record.returnValue ?? null) as TResult | null;
    this.failedReason = record.failedReason
      ? deserializeError(record.failedReason)
      : null;
    this.stacktrace = record.stacktrace.map((entry) => deserializeError(entry));
    this.workerId = record.workerId;
    // Shown as the caller named it: a series key is stored namespaced so one
    // job cannot hijack another's series, and the prefix is hidden again here.
    // The record keeps the stored spelling, which is what the worker looks the
    // series up by.
    this.repeatKey =
      record.repeatKey === null ? null : displayRepeatKey(record.repeatKey);
    this.parent = record.flow?.parent ?? null;
  }

  /** The namespace and queue this job belongs to. */
  get queue(): QueueRef {
    return { ...this.#ref };
  }

  /** Whether this job came from a repeat series. */
  get isRepeat(): boolean {
    return this.repeatKey !== null;
  }

  /** The lock token held by the worker processing it, if any. */
  get lockToken(): string | null {
    return this.#record.lockToken;
  }

  /** Records a progress value for observers to read. */
  async updateProgress(value: number | Record<string, unknown>): Promise<void> {
    await this.#driver.updateProgress(this.#ref, this.id, value);
    // Told after the write, not before: an observer should not be shown
    // progress that failed to persist.
    this.#onProgress?.(value);
  }

  /**
   * Extends this job's lock. Throws nothing on failure — it returns `false`,
   * which means the lock is no longer ours and the work should stop.
   */
  async extendLock(ms?: number): Promise<boolean> {
    if (!this.#record.lockToken) {
      return false;
    }

    return await this.#driver.extendJobLock(
      this.#ref,
      this.id,
      this.#record.lockToken,
      ms ?? DEFAULT_LOCK_DURATION,
      Date.now(),
    );
  }

  /** Removes the job. Refused while it is active. */
  async remove(): Promise<boolean> {
    return await this.#driver.removeJob(this.#ref, this.id);
  }

  /**
   * Returns a finished job to the queue, resetting its attempts. A flow parent
   * that a child's failure buried goes back to waiting on its unsettled
   * children, exactly as `BunQueue.retry` does.
   */
  async retry(options?: { resetAttempts?: boolean }): Promise<boolean> {
    return await retryJob(
      this.#driver,
      this.#ref,
      this.id,
      options?.resetAttempts ?? true,
      Date.now(),
    );
  }

  /** Makes a delayed or retry-pending job claimable now. */
  async promote(): Promise<boolean> {
    return await this.#driver.promoteJob(this.#ref, this.id, Date.now());
  }

  /**
   * Replaces the job's data, and answers with the job as it now is — or
   * `null` when it is gone.
   *
   * Allowed in any state, including while it runs: the running attempt keeps
   * the data it started with, and a later attempt reads the new data.
   */
  async updateData(data: TData): Promise<Job<TData, TResult> | null> {
    return await this.#update(
      { data: assertJsonSafe(data, "job data") },
      "updateData()",
    );
  }

  /** Changes the job's priority; a waiting job moves in claim order. */
  async setPriority(priority: number): Promise<Job<TData, TResult> | null> {
    if (!Number.isFinite(priority)) {
      throw new ConfigError("priority must be a number", { priority });
    }

    return await this.#update({ priority }, "setPriority()");
  }

  /**
   * Moves a waiting or delayed job to a new run time — a `Date`, epoch
   * milliseconds, or words such as `"in 10 minutes"`. A job that is running
   * or finished is left alone and answers `null`.
   */
  async reschedule(
    when: Date | number | string,
  ): Promise<Job<TData, TResult> | null> {
    const now = Date.now();
    const runAt = parseWhen(when, "reschedule()", now);
    return await this.#update({ runAt }, "reschedule()", now);
  }

  /** Extends the lock, as {@link Job.extendLock} does; the name Agenda uses. */
  async touch(ms?: number): Promise<boolean> {
    return await this.extendLock(ms);
  }

  /**
   * Appends a line to the job's log and answers with how many lines it keeps,
   * or `0` when the job is gone. The log is capped at `opts.keepLogs`.
   */
  async log(line: string): Promise<number> {
    const driver = this.#require("addJobLog", "log()");

    return await driver.addJobLog!(
      this.#ref,
      this.id,
      String(line),
      this.opts.keepLogs ?? DEFAULT_KEEP_LOGS,
    );
  }

  /** A page of the job's log, oldest first unless asked otherwise. */
  async getLogs(options?: {
    /** Lines to skip. Defaults to `0`. */
    offset?: number;
    /** Lines to return. Defaults to `100`. */
    limit?: number;
    /** `asc` is oldest first, the default. */
    order?: "asc" | "desc";
  }): Promise<{ logs: string[]; count: number }> {
    const driver = this.#require("getJobLogs", "getLogs()");

    return await driver.getJobLogs!(this.#ref, this.id, {
      offset: options?.offset ?? 0,
      limit: options?.limit ?? 100,
      order: options?.order ?? "asc",
    });
  }

  /** Applies a patch through the driver and answers with a fresh view. */
  async #update(
    patch: { data?: unknown; priority?: number; runAt?: number },
    what: string,
    now = Date.now(),
  ): Promise<Job<TData, TResult> | null> {
    const driver = this.#require("updateJob", what);
    const record = await driver.updateJob!(this.#ref, this.id, patch, now);

    return record
      ? new Job<TData, TResult>(this.#driver, this.#ref, record, false)
      : null;
  }

  /** The driver, checked to implement an optional method a caller needs. */
  #require(
    method: "updateJob" | "addJobLog" | "getJobLogs",
    what: string,
  ): JobsDriver {
    if (typeof this.#driver[method] !== "function") {
      // A `ConfigError` still — `NotSupportedError` extends it and keeps the
      // `CONFIG` code — but one a caller can branch on by type, with the
      // feature that wanted the method recorded beside it.
      throw new NotSupportedError(this.#driver.name, method, { needs: what });
    }

    return this.#driver;
  }

  /** Re-reads the job, returning a fresh view or `null` when it is gone. */
  async refresh(): Promise<Job<TData, TResult> | null> {
    const record = await this.#driver.getJob(this.#ref, this.id);
    return record
      ? new Job<TData, TResult>(this.#driver, this.#ref, record)
      : null;
  }

  /**
   * The results of this job's children that completed, keyed `queue:id`, read
   * fresh from the driver. Empty for a job with no children.
   */
  async getChildrenValues(): Promise<Record<string, unknown>> {
    const record = await this.#driver.getJob(this.#ref, this.id);
    return { ...record?.flow?.values };
  }

  /**
   * The failures of children marked `ignoreFailure`, keyed `queue:id`, read
   * fresh from the driver. A child that failed without it failed this job.
   */
  async getChildrenFailures(): Promise<Record<string, Error>> {
    const record = await this.#driver.getJob(this.#ref, this.id);
    return Object.fromEntries(
      Object.entries(record?.flow?.failures ?? {}).map(([key, error]) => [
        key,
        deserializeError(error),
      ]),
    );
  }

  /** The stored record, for logging or transport. */
  toJSON(): JobRecord {
    return { ...this.#record };
  }
}
