import type { SerializedError } from "@kingsleyweb/bun-common";
import type {
  ClearJobLogsResult,
  JobPatch,
  JobRecord,
  JobRef,
  JobsDriver,
  JobState,
  JobWorkerRef,
  QueueRef,
  ResolvedJobOptions,
} from "../drivers/index";
import type { RunProgress } from "../shared/progress";
import type { AttemptWrites } from "./attemptWrites";
import { deserializeError, serializeError } from "@kingsleyweb/bun-common";
import { DEFAULT_KEEP_LOGS, DEFAULT_LOCK_DURATION } from "../shared/constants";
import {
  ConfigError,
  NotSupportedError,
  UnrecoverableJobError,
} from "../shared/errors";
import { parseWhen } from "../shared/humanTime";
import { assertJsonSafe } from "../shared/json";
import { fileBuriedLetter } from "./deadLetter";
import { noteScheduled } from "./delayedHints";
import { displayRepeatKey } from "./options";
import { disableRepeatSeries, enableRepeatSeries } from "./repeatControl";
import { retryJob } from "./retry";

/**
 * Something a {@link Job} did that whoever made it may want to announce: its
 * queue's or worker's listeners, and other processes through a published
 * event.
 */
export type JobEvent =
  | {
      /** `remove()` removed it. */
      type: "removed";
      /** The job's id. */
      id: string;
    }
  | {
      /** `promote()` made it claimable now. */
      type: "promoted";
      /** The job's id. */
      id: string;
    }
  | {
      /** `retry()` returned it to the queue. */
      type: "retried";
      /** The job's id. */
      id: string;
    }
  | {
      /** `fail()` buried it from outside its processor. */
      type: "buried";
      /** The job as it now is, `dead`. */
      record: JobRecord;
      /** Why, as stored. */
      error: SerializedError;
    };

/**
 * What the queue or worker that built a {@link Job} is told about it.
 *
 * Carried over to every view derived from the job — `refresh()`, and what
 * `update()` and its kin answer — so a refreshed view inside a processor is
 * still the processor's own.
 */
export interface JobHooks {
  /**
   * Told when progress is recorded, so whoever owns this job can announce it.
   *
   * Only the worker running the job sees `updateProgress` called, and `Job`
   * has no emitter of its own — which is why the `progress` event was declared
   * on both `BunQueue` and `BunQueueWorker` and fired on neither.
   */
  onProgress?: (value: RunProgress) => void;
  /**
   * Present only on the view a worker hands its processor, and what makes that
   * view the job's *owner*: `fail()` then records the reason for the worker to
   * settle the attempt with, rather than burying the job underneath it, and
   * `extendLock()` may renew the lock. Answers `false` once the attempt has
   * settled, when `fail()` falls back to burying the job like anyone else.
   */
  onFail?: (error: UnrecoverableJobError) => boolean;
  /**
   * Told after `remove()`, `promote()`, `retry()` or an outside `fail()` took
   * effect, so the queue or worker that made this view emits and publishes
   * what its own method of the same name would.
   */
  onEvent?: (event: JobEvent) => Promise<void>;
  /**
   * The writes this job's attempt has in flight, which the worker settles
   * before it records how the job ended. Present only on the view a worker
   * hands its processor: `updateProgress` and `log` join it there, so what a
   * processor reported is in the store before the completion or failure
   * record, whether it ran in the worker's own thread, in a `Worker` or in a
   * child process. Every other view writes straight through — there is no
   * attempt to order those against.
   */
  writes?: AttemptWrites;
}

/** What {@link Job.update} changes. Anything left out stays as it is. */
export interface JobUpdate<TData> {
  /** The new payload. */
  data?: TData;
  /** The new priority. Lower runs first. */
  priority?: number;
  /**
   * When it may run: a `Date`, epoch milliseconds, or words such as
   * `"in 10 minutes"`. Moves only a waiting or delayed job.
   */
  runAt?: Date | number | string;
  /** Change it only while it is in one of these states. */
  onlyIn?: JobState[];
}

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
  /** The latest progress value, or `null` before any was reported. */
  readonly progress: RunProgress | null;
  /** The processor's return value, once complete. */
  readonly returnValue: TResult | null;
  /** The most recent failure, rehydrated as an `Error`. */
  readonly failedReason: Error | null;
  /** Recent failures, newest first. */
  readonly stacktrace: Error[];
  /** The worker holding it, while active. For who ran a finished job, read `processedBy`. */
  readonly workerId: string | null;
  /**
   * The worker that claimed the current or last attempt — id, stable key,
   * host and pid — kept after the job settles. **Last attempt only**: a job
   * retried on another worker names that one. `null` for a job never claimed,
   * or on a driver that does not record attribution.
   */
  readonly processedBy: JobWorkerRef | null;
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
  /** What whoever built this view is told; see {@link JobHooks}. */
  readonly #hooks: JobHooks;
  /** Which queue it belongs to. */
  readonly #ref: QueueRef;

  constructor(
    /** Where the job lives. */
    driver: JobsDriver,
    /** Which queue it belongs to. */
    ref: QueueRef,
    /** The stored record to build the view from. */
    record: JobRecord,
    /** Whether `add()` created the job rather than finding it. Defaults to `true`. */
    wasAdded = true,
    /** What the queue or worker building the view is told. Defaults to nothing. */
    hooks: JobHooks = {},
  ) {
    this.#driver = driver;
    this.#ref = ref;
    this.#record = record;
    this.wasAdded = wasAdded;
    this.#hooks = hooks;

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
    // Stored as the processor reported it, and a record read back from an
    // older store may hold anything; only the two shapes `updateProgress`
    // accepts are shown.
    this.progress = asProgress(record.progress);
    this.returnValue = (record.returnValue ?? null) as TResult | null;
    this.failedReason = record.failedReason
      ? deserializeError(record.failedReason)
      : null;
    this.stacktrace = record.stacktrace.map((entry) => deserializeError(entry));
    this.workerId = record.workerId;
    this.processedBy = record.processedBy ?? null;
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

  /**
   * The lock token of the claim holding it, if any — what that attempt's
   * heartbeat, `extendLock()`, completion and failure writes must match.
   * Drawn fresh for every claim, not derived from the worker: the same worker
   * re-claiming a job holds a different token than its earlier claim did.
   * Shaped `host:pid:<uuid>:<worker id>`; the worker id there only says who
   * holds it. `null` while unclaimed.
   */
  get lockToken(): string | null {
    return this.#record.lockToken;
  }

  /**
   * Whether this is the view a worker handed the job's processor — the one
   * that holds the job's lock — rather than one read by anyone else.
   */
  get #owned(): boolean {
    return this.#hooks.onFail !== undefined;
  }

  /**
   * Records a progress value for observers to read.
   *
   * On a processor's own view of its job the write is ordered against the
   * others that attempt made and against the record of how the job ended, and
   * a value reported once the attempt is over does nothing — see
   * {@link AttemptWrites}.
   */
  async updateProgress(value: RunProgress): Promise<void> {
    const write = async (): Promise<void> => {
      await this.#driver.updateProgress(this.#ref, this.id, value);
      // Told after the write, not before: an observer should not be shown
      // progress that failed to persist.
      this.#hooks.onProgress?.(value);
    };

    // Inside a processor's attempt this joins the attempt's ordered lane: a
    // job has one progress value, so the last one reported must be the one
    // that lands, and the worker waits for the lane before it records how the
    // job ended. A value reported after the attempt is over is dropped — the
    // job's ending is already being written, and this would land on top of it.
    await (this.#hooks.writes?.chain(write) ?? write());
  }

  /**
   * Extends this job's lock. Throws nothing on failure — it returns `false`,
   * which means the lock is no longer ours and the work should stop.
   *
   * Only the processor's own view can: any other view of an active job
   * carries its lock token too, and renewing a lock one does not hold would
   * keep a stalled job from ever being recovered. It answers `false`.
   */
  async extendLock(ms?: number): Promise<boolean> {
    if (!this.#owned || !this.#record.lockToken) {
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
    const removed = await this.#driver.removeJob(this.#ref, this.id);

    if (removed) {
      await this.#hooks.onEvent?.({ type: "removed", id: this.id });
    }

    return removed;
  }

  /**
   * Returns a finished job to the queue, resetting its attempts. A flow parent
   * that a child's failure buried goes back to waiting on its unsettled
   * children, exactly as `BunQueue.retry` does.
   */
  async retry(options?: {
    /** Whether to start its attempts again from zero. Defaults to `true`. */
    resetAttempts?: boolean;
  }): Promise<boolean> {
    const retried = await retryJob(
      this.#driver,
      this.#ref,
      this.id,
      options?.resetAttempts ?? true,
      Date.now(),
    );

    if (retried) {
      await this.#hooks.onEvent?.({ type: "retried", id: this.id });
    }

    return retried;
  }

  /** Makes a delayed or retry-pending job claimable now. */
  async promote(): Promise<boolean> {
    const promoted = await this.#driver.promoteJob(
      this.#ref,
      this.id,
      Date.now(),
    );

    if (promoted) {
      await this.#hooks.onEvent?.({ type: "promoted", id: this.id });
    }

    return promoted;
  }

  /**
   * Fails the job for good: it goes to `dead`, with `reason` as its failure,
   * whatever attempts it has left. To have it retried, throw from the
   * processor instead.
   *
   * - **Inside its processor**, on the job the processor was handed, the
   *   attempt ends that way once the processor returns or throws — and the
   *   reason given here wins over anything thrown after it. Answers `true`.
   * - **Anywhere else**, the job is buried now: a waiting, delayed,
   *   retry-pending or `waiting-children` job, or an active one still under
   *   the lock this view saw — its worker then loses the lock, and whatever
   *   the attempt returns is discarded. It gets the `failed` and `dead`
   *   events, and a copy in its own `deadLetter` queue when it names one (a
   *   worker's `deadLetterQueue` is not involved); a letter that cannot be
   *   filed throws, with the job dead regardless. A flow child's failure
   *   reaches its parent through the next maintenance pass. Answers `false`
   *   for a job that is gone, already finished, or active under another lock.
   */
  async fail(reason: string | Error): Promise<boolean> {
    const message = reason instanceof Error ? reason.message : String(reason);
    const error = new UnrecoverableJobError(
      message,
      { jobId: this.id },
      reason instanceof Error ? { cause: reason } : undefined,
    );

    if (this.#hooks.onFail?.(error)) {
      return true;
    }

    const driver = this.#require("buryJob", "fail()");
    const serialized = serializeError(error);
    const record = await driver.buryJob!(
      this.#ref,
      this.id,
      serialized,
      {
        // A child's record stays until its parent has its outcome, which
        // maintenance delivers; its retention applies then.
        retention: this.#record.flow?.parent ? false : this.opts.removeOnFail,
        keepStacktraces: this.opts.keepStacktraces,
        ...(this.#record.lockToken ? { token: this.#record.lockToken } : {}),
      },
      Date.now(),
    );

    if (!record) {
      return false;
    }

    const stored = record.failedReason ?? serialized;
    await this.#hooks.onEvent?.({ type: "buried", record, error: stored });
    // The job's own dead-letter queue only: a worker's `deadLetterQueue` is
    // that worker's, and no worker is involved. The job is dead either way;
    // a letter that cannot be filed is what this throws for.
    await fileBuriedLetter(
      this.#driver,
      this.#ref.ns,
      this.#ref.queue,
      record,
      stored,
      record.finishedOn ?? Date.now(),
    );
    return true;
  }

  /**
   * Replaces the job's data, and answers with the job as it now is — or
   * `null` when it is gone.
   *
   * Allowed in any state, including while it runs: the running attempt keeps
   * the data it started with, and a later attempt reads the new data.
   */
  async updateData(data: TData): Promise<this | null> {
    return await this.#update(
      { data: assertJsonSafe(data, "job data") },
      "updateData()",
    );
  }

  /** Changes the job's priority; a waiting job moves in claim order. */
  async setPriority(priority: number): Promise<this | null> {
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
  async reschedule(when: Date | number | string): Promise<this | null> {
    const now = Date.now();
    const runAt = parseWhen(when, "reschedule()", now);
    return await this.#update({ runAt }, "reschedule()", now);
  }

  /** Moves a waiting or delayed job to a new run time; {@link Job.reschedule}. */
  async schedule(when: Date | number | string): Promise<this | null> {
    const now = Date.now();
    const runAt = parseWhen(when, "schedule()", now);
    return await this.#update({ runAt }, "schedule()", now);
  }

  /**
   * Changes the job's data, priority or run time in one step, and answers
   * with the job as it now is — or `null` when it is gone, or in a state the
   * patch cannot apply to. The same rules as `BunQueue.update`: `runAt` moves
   * only a waiting or delayed job, and `onlyIn` makes the whole change
   * conditional on the job's state, checked in the same step as the write.
   */
  async update(patch: JobUpdate<TData>): Promise<this | null> {
    const now = Date.now();

    if (patch.priority !== undefined && !Number.isFinite(patch.priority)) {
      throw new ConfigError("priority must be a number", {
        priority: patch.priority,
      });
    }

    return await this.#update(
      {
        ...(patch.data !== undefined
          ? { data: assertJsonSafe(patch.data, "job data") }
          : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.runAt !== undefined
          ? { runAt: parseWhen(patch.runAt, "update()", now) }
          : {}),
        ...(patch.onlyIn ? { onlyIn: patch.onlyIn } : {}),
      },
      "update()",
      now,
    );
  }

  /**
   * Stops the repeat series this job is an occurrence of: no further
   * occurrence is scheduled, and the pending one is removed. The series
   * stays, listed as `disabled`, until {@link Job.enable}.
   *
   * Throws a `ConfigError` on a job that is not an occurrence of a series.
   * Answers whether this call disabled it — `false` when it already was, or
   * the series is gone. An occurrence already running when it is disabled
   * finishes.
   */
  async disable(): Promise<boolean> {
    return await disableRepeatSeries(
      this.#driver,
      this.#ref,
      this.#seriesKey("disable()"),
      Date.now(),
      "disable()",
    );
  }

  /**
   * Restarts the repeat series {@link Job.disable} stopped, scheduling its
   * next occurrence from now: occurrences it missed while disabled are not
   * run. Throws a `ConfigError` on a job that is not an occurrence of a
   * series; answers whether this call enabled it.
   */
  async enable(): Promise<boolean> {
    return await enableRepeatSeries(
      this.#driver,
      this.#ref,
      this.#seriesKey("enable()"),
      Date.now(),
      "enable()",
    );
  }

  /** The stored key of this job's series, or a `ConfigError` saying why not. */
  #seriesKey(what: string): string {
    if (this.#record.repeatKey === null) {
      throw new ConfigError(
        `${what} applies to an occurrence of a repeat series, and job ${this.id} is not one`,
        { jobId: this.id },
      );
    }

    return this.#record.repeatKey;
  }

  /**
   * Extends the lock, as {@link Job.extendLock} does, and only from the
   * processor's own view; the name Agenda uses.
   */
  async touch(ms?: number): Promise<boolean> {
    return await this.extendLock(ms);
  }

  /**
   * Appends a line to the job's log and answers with how many lines it keeps,
   * or `0` when the job is gone. The log is capped at `opts.keepLogs`.
   */
  async log(line: string): Promise<number> {
    const driver = this.#require("addJobLog", "log()");
    const write = async (): Promise<number> =>
      await driver.addJobLog!(
        this.#ref,
        this.id,
        String(line),
        this.opts.keepLogs ?? DEFAULT_KEEP_LOGS,
      );

    // Counted by the attempt, not chained behind its other writes: a line is
    // appended with its own sequence, so nothing is lost by writing several at
    // once, and chaining would cost a chatty processor one driver round trip
    // per line. The worker still waits for all of them before the job's ending.
    return await (this.#hooks.writes?.track(write) ?? write());
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

  /**
   * Empties the job's log, answering how many lines went. Refused while the
   * job is `active` — `{ status: "active" }`, nothing removed — because its
   * worker is still writing the log; `{ status: "missing" }` when the job is
   * gone. The refusal is checked by the driver in the same step as the
   * removal, so a job claimed after this view was read is refused too.
   *
   * A line logged afterwards is the first of a fresh log, and `keepLogs`
   * counts from it. Nothing else about the job changes.
   */
  async clearLogs(): Promise<ClearJobLogsResult> {
    const driver = this.#require("clearJobLogs", "clearLogs()");
    return await driver.clearJobLogs!(this.#ref, this.id);
  }

  /** Applies a patch through the driver and answers with a fresh view. */
  async #update(
    patch: JobPatch,
    what: string,
    now = Date.now(),
  ): Promise<this | null> {
    const driver = this.#require("updateJob", what);
    const record = await driver.updateJob!(this.#ref, this.id, patch, now);
    if (record?.state === "delayed") {
      // Its due time may now be earlier than a local worker expects.
      noteScheduled(driver, this.#ref);
    }

    return record ? this.#view(record, false) : null;
  }

  /**
   * A new view of this job, built from `record` and carrying this one's
   * hooks. Typed as `this`, so a registry-narrowed job stays narrowed: the
   * name and payload are the stored job's, which is what narrowed it.
   */
  #view(record: JobRecord, wasAdded?: boolean): this {
    return new Job<TData, TResult>(
      this.#driver,
      this.#ref,
      record,
      wasAdded,
      this.#hooks,
    ) as this;
  }

  /** The driver, checked to implement an optional method a caller needs. */
  #require(
    method:
      | "updateJob"
      | "addJobLog"
      | "getJobLogs"
      | "clearJobLogs"
      | "buryJob",
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
  async refresh(): Promise<this | null> {
    const record = await this.#driver.getJob(this.#ref, this.id);
    return record ? this.#view(record) : null;
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

/** A stored progress value as a {@link RunProgress}, or `null`. */
function asProgress(value: unknown): RunProgress | null {
  if (typeof value === "number") {
    return value;
  }

  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
