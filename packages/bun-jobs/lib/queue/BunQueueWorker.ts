import type { JobRecord, JobsDriver, QueueRef } from "../drivers/index";
import type { Logger } from "../shared/logger";
import type {
  BunQueueWorkerEvents,
  BunQueueWorkerOptions,
  JobProcessor,
  ProcessorContext,
} from "./types";
import {
  computeBackoff,
  createDeferred,
  deserializeError,
  jsonClone,
  serializeError,
  sleep,
  withTimeout,
} from "@kingsleyweb/bun-common";
import { claimJobBatch, resolveDriver } from "../drivers/index";
import {
  DEFAULT_LOCK_DURATION,
  DEFAULT_MAX_BLOCK,
  DEFAULT_MAX_STALLED,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_STALLED_INTERVAL,
} from "../shared/constants";
import { TypedEmitterBase } from "../shared/emitter";
import {
  JobTimeoutError,
  LockLostError,
  UnrecoverableJobError,
} from "../shared/errors";
import { newId, newToken } from "../shared/ids";
import { assertNamespace, assertSegment } from "../shared/keys";
import { createJobsLogger } from "../shared/logger";
import { Job } from "./Job";
import { nextOccurrence, repeatJobId } from "./repeat";

/** How many jobs one maintenance sweep touches. */
const MAINTENANCE_BATCH = 100;

/** How long a paused check is cached before the driver is asked again. */
const PAUSE_CACHE_MS = 1000;

/**
 * The consumer side of a queue.
 *
 * Any number of workers, in any number of processes on any number of hosts,
 * may consume the same queue: exclusivity comes from the driver's claim being
 * atomic, not from registration, leases or a coordinator. That is why adding
 * capacity is just starting another process.
 *
 * Each worker also does maintenance by default — promoting delayed jobs,
 * recovering jobs whose worker died, pruning expired results, healing repeat
 * series. Every one of those operations is idempotent, so they need no leader
 * and no single process is load-bearing.
 *
 * ```ts
 * const worker = new BunQueueWorker("mail", async (job) => send(job.data), {
 *   namespace: "account",
 *   driver,
 *   concurrency: 8,
 * });
 * await worker.run();
 * ```
 */
export class BunQueueWorker<
  TData = unknown,
  TResult = unknown,
> extends TypedEmitterBase<BunQueueWorkerEvents<TData, TResult>> {
  /** Identifies this worker in job records and logs. */
  readonly id: string;
  /** The queue it consumes. */
  readonly queueName: string;
  /** The namespace it consumes from. */
  readonly namespace: string;
  /** Where jobs live. */
  readonly driver: JobsDriver;

  /** What to run for each job. */
  readonly #processor: JobProcessor<TData, TResult>;
  /** Options with defaults applied. */
  readonly #options: Required<
    Pick<
      BunQueueWorkerOptions,
      | "concurrency"
      | "lockDuration"
      | "heartbeatInterval"
      | "stalledInterval"
      | "maxStalledCount"
      | "pollInterval"
      | "maxBlock"
      | "maintenance"
      | "drainDelay"
    >
  >;

  /** Whether this worker built the driver and must close it. */
  readonly #ownsDriver: boolean;
  /** Logger bound to this worker. */
  readonly #logger: Logger;
  /** The lock token every claim by this worker carries. */
  readonly #token: string;
  /** Jobs in flight, by id. */
  readonly #active = new Map<string, Promise<void>>();
  /** Controllers for the jobs in flight, so they can be aborted. */
  readonly #aborts = new Map<string, AbortController>();

  /** How many jobs to process at once; settable at runtime. */
  #concurrency: number;
  /** Whether the claim loop is running. */
  #running = false;
  /** Whether `close()` has been called. */
  #closing = false;
  /** Whether this worker is locally paused. */
  #paused = false;
  /** Resolves when the claim loop has stopped. */
  #stopped = createDeferred<void>();
  /** Aborted to wake the loop out of a wait. */
  #wake = new AbortController();
  /** Maintenance timers, cleared on close. */
  readonly #timers = new Set<ReturnType<typeof setInterval>>();
  /** Cached queue-paused flag and when it was read. */
  #pauseCache: { paused: boolean; at: number } = { paused: false, at: 0 };

  constructor(
    queueName: string,
    processor: JobProcessor<TData, TResult>,
    options: BunQueueWorkerOptions,
  ) {
    super();

    this.queueName = assertSegment(queueName, "queue name");
    this.namespace = assertNamespace(options.namespace);
    this.#processor = processor;
    this.id = options.id ?? newId();
    this.#token = newToken(this.id);

    const { driver, owned } = resolveDriver(options.driver);
    this.driver = driver;
    this.#ownsDriver = owned;

    const lockDuration = options.lockDuration ?? DEFAULT_LOCK_DURATION;
    this.#concurrency = Math.max(1, options.concurrency ?? 1);
    this.#options = {
      concurrency: this.#concurrency,
      lockDuration,
      heartbeatInterval:
        options.heartbeatInterval ??
        Math.max(250, Math.floor(lockDuration / 3)),
      stalledInterval: options.stalledInterval ?? DEFAULT_STALLED_INTERVAL,
      maxStalledCount: options.maxStalledCount ?? DEFAULT_MAX_STALLED,
      pollInterval: options.pollInterval ?? DEFAULT_POLL_INTERVAL,
      maxBlock: options.maxBlock ?? DEFAULT_MAX_BLOCK,
      maintenance: options.maintenance ?? true,
      drainDelay: options.drainDelay ?? 0,
    };

    this.#logger = createJobsLogger(
      options.logger,
      { namespace: this.namespace, queue: this.queueName, workerId: this.id },
      `worker:${this.queueName}`,
    );

    if (options.autorun) {
      void this.run().catch((error: unknown) => {
        this.#emitError(error, "autorun");
      });
    }
  }

  /* --- accessors -------------------------------------------------------- */

  /** The queue this worker consumes, as the driver wants it. */
  get ref(): QueueRef {
    return { ns: this.namespace, queue: this.queueName };
  }

  /** How many jobs it processes at once. */
  get concurrency(): number {
    return this.#concurrency;
  }

  /** Changes the concurrency at runtime; takes effect on the next claim. */
  set concurrency(value: number) {
    this.#concurrency = Math.max(1, Math.floor(value));
    this.#wake.abort();
  }

  /** How many jobs are in flight. */
  get activeCount(): number {
    return this.#active.size;
  }

  /** Whether the claim loop is running. */
  get isRunning(): boolean {
    return this.#running;
  }

  /** The worker's logger. */
  get logger(): Logger {
    return this.#logger;
  }

  /* --- lifecycle --------------------------------------------------------- */

  /**
   * Consumes until closed. Resolves when the loop has stopped and every job
   * in flight has settled, so a supervising process can simply await it.
   */
  async run(): Promise<void> {
    if (this.#running) {
      return await this.#stopped.promise;
    }

    this.#running = true;
    this.#stopped = createDeferred<void>();

    await this.driver.connect();
    await this.driver.ensureQueue(this.ref);
    this.#armMaintenance();
    this.safeEmit("ready");

    void this.#loop();
    return await this.#stopped.promise;
  }

  /** Stops claiming. Jobs in flight are left to finish. */
  async pause(options?: { waitActive?: boolean }): Promise<void> {
    this.#paused = true;
    this.#wake.abort();
    this.safeEmit("paused");

    if (options?.waitActive) {
      await Promise.allSettled([...this.#active.values()]);
    }
  }

  /** Resumes claiming. */
  resume(): void {
    this.#paused = false;
    this.#wake.abort();
    this.safeEmit("resumed");
  }

  /** Whether this worker is locally paused. */
  isPaused(): boolean {
    return this.#paused;
  }

  /**
   * Stops claiming, waits for jobs in flight, and releases what it owns.
   *
   * A job still running at `timeout` has its signal aborted; its lock is then
   * left to expire, so another worker recovers it as stalled rather than the
   * job being lost.
   */
  async close(options?: { force?: boolean; timeout?: number }): Promise<void> {
    if (this.#closing) {
      await this.#stopped.promise;
      return;
    }

    this.#closing = true;
    this.safeEmit("closing");
    this.#wake.abort();

    for (const timer of this.#timers) {
      clearInterval(timer);
    }
    this.#timers.clear();

    if (options?.force) {
      for (const controller of this.#aborts.values()) {
        controller.abort();
      }

      // Deliberately no wait. A processor that ignores its signal must not
      // hold shutdown hostage; its lock lapses and the stalled sweep returns
      // the job to the queue, so the work is delayed rather than lost.
      if (this.#ownsDriver) {
        await this.driver.close();
      }

      this.#running = false;
      this.safeEmit("closed");
      return;
    }

    if (this.#active.size > 0) {
      const timeout = options?.timeout ?? this.#options.lockDuration;
      const finished = Promise.allSettled([...this.#active.values()]);
      const raced = await Promise.race([
        finished.then(() => "done" as const),
        sleep(timeout, { unref: true }).then(() => "timeout" as const),
      ]);

      if (raced === "timeout") {
        for (const controller of this.#aborts.values()) {
          controller.abort();
        }
      }
    }

    await Promise.allSettled([...this.#active.values()]);

    if (this.#running) {
      await this.#stopped.promise;
    }

    if (this.#ownsDriver) {
      await this.driver.close();
    }

    this.#running = false;
    this.safeEmit("closed");
  }

  /* --- the claim loop ------------------------------------------------------ */

  /**
   * Claims and processes until closed.
   *
   * A failure inside the loop is reported and the loop carries on. Letting
   * one escape would end consumption for the life of the process: the worker
   * would sit there looking healthy while its queue filled up. Backends do
   * fail transiently — a connection drops, a database is briefly overloaded —
   * and the answer to that is to try again shortly, not to stop.
   */
  async #loop(): Promise<void> {
    try {
      while (!this.#closing) {
        try {
          await this.#iterate();
        } catch (error) {
          this.#emitError(error, "loop");
          // Wait before retrying, so a persistent failure is not a hot loop.
          await sleep(this.#options.pollInterval, { unref: true }).catch(
            () => {},
          );
        }
      }
    } finally {
      this.#running = false;
      this.#stopped.resolve();
    }
  }

  /** One pass of the claim loop. */
  async #iterate(): Promise<void> {
    if (this.#paused || (await this.#queuePaused())) {
      // Waiting *for work* is the wrong question while paused — there may be
      // plenty, and none of it claimable — so this is a plain sleep that
      // `resume()` cuts short.
      await this.#sleepUntilWake(this.#options.pollInterval);
      return;
    }

    const claimed = await this.#claimUpToConcurrency();

    if (this.#active.size >= this.#concurrency && this.#active.size > 0) {
      // Full: wait for a slot rather than spinning on a claim that cannot
      // succeed.
      await Promise.race([...this.#active.values()]).catch(() => {});
      return;
    }

    if (claimed > 0) {
      return;
    }

    // Nothing claimable. This is the moment to promote whatever has come due,
    // because it is the only moment the answer can change and the worker has
    // nothing else to do.
    //
    // Promotion used to run inside every `claimJob`, which charged a write to
    // every claim on a busy queue to serve a case that only arises on an idle
    // one. Moving it here removes that cost without slowing a retry down: a
    // job whose backoff has elapsed is picked up on the next empty pass rather
    // than waiting out the 1Hz maintenance sweep.
    if (this.#options.maintenance && (await this.#promoteDue())) {
      return;
    }

    this.safeEmit("drained");
    await this.#idle(await this.#waitBudget());
  }

  /**
   * Claims up to the free slots and starts every job it gets.
   *
   * Exactly the free slots, and nothing is buffered: a job is only claimed when
   * there is a slot ready to run it. Holding claimed-but-unstarted jobs would
   * be faster on a backlog and would break three things at once — the jobs are
   * `active` with no heartbeat, so this worker's own stalled sweep would take
   * them back and run them twice; `close()` would abandon them; and peers would
   * idle while one worker sat on the queue.
   */
  async #claimUpToConcurrency(): Promise<number> {
    const slots = this.#concurrency - this.#active.size;

    if (slots <= 0 || this.#closing) {
      return 0;
    }

    const records = await claimJobBatch(
      this.driver,
      this.ref,
      {
        workerId: this.id,
        token: this.#token,
        lockMs: this.#options.lockDuration,
        now: Date.now(),
      },
      slots,
    );

    for (const record of records) {
      // Schedule the series' next occurrence *before* running this one, so a
      // crash mid-job cannot end the series.
      if (record.repeatKey) {
        await this.#scheduleNextRepeat(record);
      }

      const running = this.#process(record).finally(() => {
        this.#active.delete(record.id);
        this.#aborts.delete(record.id);
      });

      this.#active.set(record.id, running);
    }

    return records.length;
  }

  /**
   * Promotes whatever has come due, reporting whether anything moved.
   *
   * A `true` sends the loop straight back to claiming instead of idling.
   */
  async #promoteDue(): Promise<boolean> {
    try {
      return (
        (await this.driver.promoteDelayed(
          this.ref,
          Date.now(),
          MAINTENANCE_BATCH,
        )) > 0
      );
    } catch (error) {
      this.#emitError(error, "promote");
      return false;
    }
  }

  /** Runs one job and records how it ended. */
  async #process(record: JobRecord): Promise<void> {
    const job = new Job<TData, TResult>(this.driver, this.ref, record);
    const controller = new AbortController();
    this.#aborts.set(record.id, controller);

    const heartbeat = setInterval(() => {
      void this.#heartbeat(record, controller);
    }, this.#options.heartbeatInterval);
    heartbeat.unref?.();

    const context: ProcessorContext = {
      signal: controller.signal,
      logger: this.#logger.child({ jobId: record.id, jobName: record.name }),
      workerId: this.id,
      attempt: record.attemptsMade,
      heartbeat: async () => {
        await this.#heartbeat(record, controller);
      },
    };

    this.safeEmit("active", job);

    try {
      const result = await withTimeout(
        Promise.resolve(this.#processor(job, context)),
        record.opts.timeout,
        {
          message: `Job ${record.id} exceeded its ${record.opts.timeout}ms timeout`,
          onTimeout: () => controller.abort(),
        },
      );

      const completed = await this.driver.completeJob(
        this.ref,
        record.id,
        this.#token,
        jsonClone(result ?? null),
        record.opts.removeOnComplete,
        Date.now(),
      );

      if (!completed) {
        // The lock was gone, so someone else owns this job's outcome now.
        throw new LockLostError(record.id, { jobId: record.id });
      }

      this.safeEmit("completed", job, result as TResult);
    } catch (error) {
      await this.#recordFailure(job, record, error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Decides whether a failed attempt is retried, and tells the driver. */
  async #recordFailure(
    job: Job<TData, TResult>,
    record: JobRecord,
    error: unknown,
  ): Promise<void> {
    if (error instanceof LockLostError) {
      // Nothing to write: whoever recovered the job owns it now.
      this.safeEmit("lockLost", job);
      return;
    }

    const failure =
      error instanceof Error ? error : deserializeError(serializeError(error));
    const serialized = serializeError(
      failure instanceof Error && failure.name === "TimeoutError"
        ? new JobTimeoutError(record.opts.timeout, { jobId: record.id })
        : failure,
    );

    const attempt = record.attemptsMade;
    const retryable =
      attempt < record.maxAttempts && !(error instanceof UnrecoverableJobError);

    const now = Date.now();

    try {
      if (retryable) {
        const runAt = now + computeBackoff(attempt, record.opts.backoff);
        await this.driver.failJob(
          this.ref,
          record.id,
          this.#token,
          serialized,
          { retry: true, runAt },
          now,
          record.opts.keepStacktraces,
        );

        this.safeEmit("failed", job, failure);
        this.safeEmit("retrying", job, failure, runAt);
        return;
      }

      await this.driver.failJob(
        this.ref,
        record.id,
        this.#token,
        serialized,
        { retry: false, retention: record.opts.removeOnFail },
        now,
        record.opts.keepStacktraces,
      );

      this.safeEmit("failed", job, failure);
      this.safeEmit("dead", job, failure);
    } catch (writeError) {
      this.#emitError(writeError, "failJob");
    }
  }

  /** Renews a job's lock; losing it aborts the attempt. */
  async #heartbeat(
    record: JobRecord,
    controller: AbortController,
  ): Promise<void> {
    try {
      const held = await this.driver.extendJobLock(
        this.ref,
        record.id,
        this.#token,
        this.#options.lockDuration,
        Date.now(),
      );

      if (!held) {
        this.safeEmit(
          "lockLost",
          new Job<TData, TResult>(this.driver, this.ref, record),
        );
        controller.abort();
      }
    } catch (error) {
      this.#emitError(error, "heartbeat");
    }
  }

  /* --- repeats -------------------------------------------------------------- */

  /**
   * Schedules the occurrence after `record`.
   *
   * Deliberately unguarded by any lock: the next occurrence's id is derived
   * from the series and its due time, so several workers doing this at once
   * converge on the same job instead of creating duplicates.
   */
  async #scheduleNextRepeat(record: JobRecord): Promise<void> {
    if (!record.repeatKey) {
      return;
    }

    try {
      const definition = await this.driver.getRepeat(
        this.ref,
        record.repeatKey,
      );
      if (!definition) {
        // The series was removed while this occurrence was queued.
        return;
      }

      const count = definition.count + 1;
      const now = Date.now();
      const scheduled = { ...definition, count };

      let next = nextOccurrence(scheduled, record.runAt);

      // A series that fell behind while nothing was consuming skips to the
      // next real occurrence rather than replaying the backlog.
      if (next !== null && next <= now) {
        next = nextOccurrence(scheduled, now);
      }

      if (next === null) {
        await this.driver.upsertRepeat(this.ref, {
          ...scheduled,
          nextRunAt: null,
          nextJobId: null,
          updatedAt: now,
        });
        return;
      }

      const jobId = repeatJobId(definition.key, next);
      await this.driver.addJob(this.ref, {
        ...record,
        id: jobId,
        state: next > now ? "delayed" : "waiting",
        runAt: next,
        createdAt: now,
        processedOn: null,
        finishedOn: null,
        expiresAt: null,
        attemptsMade: 0,
        stalledCount: 0,
        progress: null,
        returnValue: null,
        failedReason: null,
        stacktrace: [],
        lockToken: null,
        lockExpiresAt: null,
        workerId: null,
      });

      await this.driver.upsertRepeat(this.ref, {
        ...scheduled,
        nextRunAt: next,
        nextJobId: jobId,
        updatedAt: now,
      });
    } catch (error) {
      this.#emitError(error, "scheduleNextRepeat");
    }
  }

  /* --- maintenance ------------------------------------------------------------ */

  /** Arms the background sweeps this worker contributes to. */
  #armMaintenance(): void {
    if (!this.#options.maintenance) {
      return;
    }

    this.#every(this.#options.stalledInterval, async () => {
      const { requeued, dead } = await this.driver.recoverStalled(
        this.ref,
        Date.now(),
        this.#options.maxStalledCount,
        MAINTENANCE_BATCH,
      );

      const recovered = [...requeued, ...dead];
      if (recovered.length > 0) {
        this.safeEmit("stalled", recovered);
        this.#wake.abort();
      }
    });

    this.#every(Math.min(this.#options.pollInterval, 1000), async () => {
      const promoted = await this.driver.promoteDelayed(
        this.ref,
        Date.now(),
        MAINTENANCE_BATCH,
      );
      if (promoted > 0) {
        this.#wake.abort();
      }
    });

    this.#every(60_000, async () => {
      await this.driver.pruneExpired(this.ref, Date.now(), MAINTENANCE_BATCH);
      await this.#healRepeats();
    });
  }

  /**
   * Runs `work` now and then on an interval, reporting failures rather than
   * throwing.
   *
   * The immediate first pass matters: a worker starting up is exactly when
   * there is most likely something to repair — jobs a crashed process was
   * holding, a repeat series whose pending occurrence went with it — and
   * waiting a full interval to look would leave the queue stuck in the
   * meantime.
   */
  #every(ms: number, work: () => Promise<void>): void {
    const run = () => {
      if (this.#closing) {
        return;
      }
      void work().catch((error: unknown) => {
        this.#emitError(error, "maintenance");
      });
    };

    const timer = setInterval(run, ms);
    timer.unref?.();
    this.#timers.add(timer);

    const first = setTimeout(run, 0);
    first.unref?.();
  }

  /**
   * Re-schedules any series whose pending occurrence has vanished — removed
   * by hand, or lost with the backend it was written to.
   */
  async #healRepeats(): Promise<void> {
    for (const definition of await this.driver.listRepeats(this.ref)) {
      if (!definition.nextJobId || definition.nextRunAt === null) {
        continue;
      }

      if (await this.driver.getJob(this.ref, definition.nextJobId)) {
        continue;
      }

      const now = Date.now();
      const next = nextOccurrence(definition, now);
      if (next === null) {
        continue;
      }

      const jobId = repeatJobId(definition.key, next);
      await this.driver.addJob(this.ref, {
        id: jobId,
        name: definition.name,
        data: definition.data,
        opts: definition.opts,
        state: next > now ? "delayed" : "waiting",
        priority: definition.opts.priority,
        runAt: next,
        createdAt: now,
        processedOn: null,
        finishedOn: null,
        expiresAt: null,
        attemptsMade: 0,
        maxAttempts: definition.opts.attempts,
        stalledCount: 0,
        progress: null,
        returnValue: null,
        failedReason: null,
        stacktrace: [],
        lockToken: null,
        lockExpiresAt: null,
        workerId: null,
        repeatKey: definition.key,
      });

      await this.driver.upsertRepeat(this.ref, {
        ...definition,
        nextRunAt: next,
        nextJobId: jobId,
        updatedAt: now,
      });
    }
  }

  /* --- waiting ------------------------------------------------------------------ */

  /** Whether the queue is paused, cached briefly to avoid a read per loop. */
  async #queuePaused(): Promise<boolean> {
    const now = Date.now();
    if (now - this.#pauseCache.at < PAUSE_CACHE_MS) {
      return this.#pauseCache.paused;
    }

    try {
      const paused = await this.driver.isQueuePaused(this.ref);
      this.#pauseCache = { paused, at: now };
      return paused;
    } catch (error) {
      this.#emitError(error, "isQueuePaused");
      return this.#pauseCache.paused;
    }
  }

  /** How long to wait for work: never past the next delayed job's due time. */
  async #waitBudget(): Promise<number> {
    const base = this.driver.capabilities.blockingWait
      ? this.#options.maxBlock
      : this.#options.pollInterval;

    try {
      const next = await this.driver.nextDelayedAt(this.ref);
      if (next === null) {
        return base;
      }

      return Math.max(1, Math.min(base, next - Date.now()));
    } catch {
      return base;
    }
  }

  /**
   * Waits for work, a wake, or the budget — whichever comes first.
   *
   * A driver may legitimately answer at once (there is work, someone else
   * took it), so the wait is floored at a millisecond: without that, a claim
   * that keeps coming back empty turns this loop into a spin that starves the
   * event loop it is running on.
   */
  async #idle(ms: number): Promise<void> {
    if (this.#closing) {
      return;
    }

    if (this.#wake.signal.aborted) {
      this.#wake = new AbortController();
      return;
    }

    const wake = this.#wake;
    const startedAt = Date.now();

    try {
      await this.driver.waitForJob(this.ref, ms, wake.signal);
    } catch {
      // Only an abort rejects, and an abort is exactly what we want.
    }

    if (wake.signal.aborted) {
      this.#wake = new AbortController();
      return;
    }

    if (Date.now() - startedAt < 1) {
      await sleep(1, { unref: true }).catch(() => {});
    }
  }

  /** Sleeps, unless `resume()` or `close()` wakes the worker first. */
  async #sleepUntilWake(ms: number): Promise<void> {
    if (this.#closing) {
      return;
    }

    if (this.#wake.signal.aborted) {
      this.#wake = new AbortController();
      return;
    }

    const wake = this.#wake;

    try {
      await sleep(ms, { signal: wake.signal, unref: true });
    } catch {
      // Aborted: a pause changed, or the worker is closing.
    }

    if (wake.signal.aborted) {
      this.#wake = new AbortController();
    }
  }

  /** Reports a failure outside a job, logging it when nobody is listening. */
  #emitError(error: unknown, context: string): void {
    const failure =
      error instanceof Error ? error : deserializeError(serializeError(error));

    if (!this.safeEmit("error", failure, context)) {
      this.#logger.error(failure, { context });
    }
  }
}
