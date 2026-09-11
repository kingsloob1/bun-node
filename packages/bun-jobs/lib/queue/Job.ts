import type {
  JobRecord,
  JobsDriver,
  JobState,
  QueueRef,
  ResolvedJobOptions,
} from "../drivers/index";
import { deserializeError } from "@kingsleyweb/bun-common";
import { DEFAULT_LOCK_DURATION } from "../shared/constants";

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
    this.repeatKey = record.repeatKey;
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

  /** Returns a finished job to the queue, resetting its attempts. */
  async retry(options?: { resetAttempts?: boolean }): Promise<boolean> {
    return await this.#driver.retryJob(
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

  /** Re-reads the job, returning a fresh view or `null` when it is gone. */
  async refresh(): Promise<Job<TData, TResult> | null> {
    const record = await this.#driver.getJob(this.#ref, this.id);
    return record
      ? new Job<TData, TResult>(this.#driver, this.#ref, record)
      : null;
  }

  /** The stored record, for logging or transport. */
  toJSON(): JobRecord {
    return { ...this.#record };
  }
}
