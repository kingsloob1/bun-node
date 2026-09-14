import type { SerializedError } from "@kingsleyweb/bun-common";
import type { JobRecord, JobsDriver, QueueRef } from "../drivers/index";
import type { QueueEventName, QueueEventPayloads } from "../shared/events";
import type { Logger } from "../shared/logger";
import type { Reservation } from "./limits";
import type {
  BunQueueWorkerEvents,
  BunQueueWorkerOptions,
  DeadLetter,
  JobProcessor,
  ProcessorContext,
} from "./types";
import {
  createDeferred,
  deserializeError,
  jsonClone,
  serializeError,
  sleep,
  withTimeout,
} from "@kingsleyweb/bun-common";
import {
  claimJobBatch,
  CompletionBatcher,
  resolveDriver,
} from "../drivers/index";
import {
  DEFAULT_LOCK_DURATION,
  DEFAULT_MAX_BLOCK,
  DEFAULT_MAX_STALLED,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_STALLED_INTERVAL,
} from "../shared/constants";
import { TypedEmitterBase } from "../shared/emitter";
import {
  ConfigError,
  JobTimeoutError,
  LockLostError,
  UnrecoverableJobError,
} from "../shared/errors";
import { queueEvent } from "../shared/events";
import { newId, newToken } from "../shared/ids";
import { assertNamespace, assertSegment } from "../shared/keys";
import { createJobsLogger } from "../shared/logger";
import { waitForAny } from "../shared/wait";
import { BackoffStrategies, nextBackoff } from "./backoff";
import { BunQueue } from "./BunQueue";
import { IsolatedProcessor } from "./isolation";
import { Job } from "./Job";
import { QueueLimiter } from "./limits";
import { nextOccurrence, repeatJobId } from "./repeat";
import { supportsWindowSweep, sweepWindows } from "./windows";

/** How many jobs one maintenance sweep touches. */
const MAINTENANCE_BATCH = 100;

/** The longest a worker held back by a concurrency limit waits before asking again. */
const LIMITED_RECHECK_MS = 100;

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
  readonly #processor: JobProcessor<TData, TResult> | undefined;
  /** The processor file and where it runs, when the processor is a file. */
  readonly #isolated: IsolatedProcessor | undefined;
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
  /** Named backoff strategies, for jobs that name one. */
  readonly #backoffs: BackoffStrategies;
  /**
   * This worker's side of the queue's stored limits, when the driver can hold
   * them. It costs one cached read a second on a queue with none.
   */
  readonly #limiter: QueueLimiter | undefined;
  /** Where the next sweep of debounce and throttle pointers resumes. */
  #windowCursor: string | undefined;
  /**
   * How long to wait before claiming again after a pass the limits held back,
   * or `undefined` when the last pass was not limited.
   */
  #limitedFor: number | undefined;
  /** The dead-letter queue for jobs that do not name their own. */
  readonly #deadLetterQueue: string | undefined;
  /** Dead-letter queues opened so far, by name, closed with the worker. */
  readonly #deadLetters = new Map<
    string,
    BunQueue<DeadLetter, unknown, string>
  >();

  /** Whether this worker announces its job events to other processes. */
  readonly #publishes: boolean;
  /** Awaited before each publish; see `BunQueueWorkerOptions.publishGate`. */
  readonly #publishGate: (() => Promise<void>) | undefined;
  /** When the queue was first seen empty, for `drainDelay`. */
  #emptySince: number | undefined;
  /** Whether `drained` has been emitted for the current quiet spell. */
  #drainedAnnounced = false;
  /** Jobs in flight, by id. */
  readonly #active = new Map<string, Promise<void>>();
  /** Controllers for the jobs in flight, so they can be aborted. */
  readonly #aborts = new Map<string, AbortController>();
  /** Completion writes still in flight, so `close()` does not abandon one. */
  readonly #settling = new Set<Promise<void>>();
  /** Publishes still in flight, which `close()` waits for. */
  readonly #publishing = new Set<Promise<void>>();
  /** Batches finished jobs, so a burst settles in one round trip. */
  readonly #completions: CompletionBatcher;

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
  /** Whether a running worker holds the process open. */
  readonly #waitToExit: boolean;
  /** The handle holding the process open while the loop runs, if any. */
  #keepAlive: ReturnType<typeof setInterval> | undefined;
  /** Aborted to wake the loop out of a wait. */
  #wake = new AbortController();
  /** Each running job's lock-renewal timer, by job id. */
  readonly #heartbeats = new Map<string, ReturnType<typeof setInterval>>();
  /** Maintenance timers, cleared on close. */
  readonly #timers = new Set<ReturnType<typeof setInterval>>();
  /** Cached queue-paused flag and when it was read. */
  #pauseCache: { paused: boolean; at: number } = { paused: false, at: 0 };

  constructor(
    queueName: string,
    /**
     * What runs each job: a function, or the path (or URL) of a file that
     * default-exports one — which `isolation` can then run in a child process
     * or a `Worker`.
     */
    processor: JobProcessor<TData, TResult> | string | URL,
    options: BunQueueWorkerOptions,
  ) {
    super();

    this.queueName = assertSegment(queueName, "queue name");
    this.namespace = assertNamespace(options.namespace);
    if (typeof processor === "function") {
      if (
        options.isolation !== undefined &&
        options.isolation !== "in-process"
      ) {
        throw new ConfigError(
          `isolation "${options.isolation}" needs a processor file: a function cannot be sent to another process or Worker`,
          { isolation: options.isolation },
        );
      }

      this.#processor = processor;
      this.#isolated = undefined;
    } else {
      this.#processor = undefined;
      this.#isolated = new IsolatedProcessor(
        processor,
        options.isolation ?? "in-process",
        options.isolationOptions,
      );
    }
    this.id = options.id ?? newId();
    this.#token = newToken(this.id);

    const { driver, owned } = resolveDriver(options.driver);
    this.driver = driver;
    this.#ownsDriver = owned;
    this.#completions = new CompletionBatcher(driver, this.ref, this.#token);

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

    this.#publishes = options.publish ?? false;
    this.#publishGate = options.publishGate;
    this.#waitToExit = options.waitToExit ?? true;
    this.#backoffs = BackoffStrategies.from(options.backoffStrategies);
    this.#limiter = QueueLimiter.supports(driver)
      ? new QueueLimiter(
          driver,
          this.ref,
          this.id,
          lockDuration,
          options.limitsRefreshInterval,
        )
      : undefined;
    this.#deadLetterQueue =
      options.deadLetterQueue === undefined
        ? undefined
        : assertSegment(options.deadLetterQueue, "deadLetterQueue");

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

    // Held only once the worker is actually running: a `run()` that failed to
    // connect must not leave the process unable to exit.
    this.#holdProcess();
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
    // Held for as long as closing takes, whatever `waitToExit` says. A caller
    // awaiting this in a signal handler has nothing else keeping the process
    // alive — every wait the worker makes is unref'd — so without it Bun could
    // exit halfway through draining in-flight work, completions and the
    // driver, and the handler would never reach its next line.
    const hold = setInterval(() => {}, 2_147_483_647);

    try {
      await this.#close(options);
    } finally {
      clearInterval(hold);
    }
  }

  /** The body of {@link BunQueueWorker.close}, under its hold on the process. */
  async #close(options?: { force?: boolean; timeout?: number }): Promise<void> {
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
      this.#abandonActive();

      // Deliberately no wait. A processor that ignores its signal must not
      // hold shutdown hostage; its lock lapses and the stalled sweep returns
      // the job to the queue, so the work is delayed rather than lost.
      await this.#closeDeadLetters();
      await this.#limiter
        ?.close()
        .catch((error: unknown) => this.#emitError(error, "limits"));
      await Promise.allSettled([...this.#publishing]);

      if (this.#ownsDriver) {
        await this.driver.close();
      }

      this.#running = false;
      this.#releaseProcess();
      this.safeEmit("closed");
      return;
    }

    let abandoned = false;

    if (this.#active.size > 0) {
      const timeout = options?.timeout ?? this.#options.lockDuration;
      const finished = Promise.allSettled([...this.#active.values()]);
      const raced = await Promise.race([
        finished.then(() => "done" as const),
        sleep(timeout, { unref: true }).then(() => "timeout" as const),
      ]);

      if (raced === "timeout") {
        // Out of patience: from here this is a forced close for whatever is
        // still running. Waiting on those jobs again would hang on exactly the
        // processor the timeout exists for — one that ignores its signal.
        this.#abandonActive();
        abandoned = true;
      }
    }

    if (!abandoned) {
      await Promise.allSettled([...this.#active.values()]);
    }
    // Jobs finish before their completions are written, so drain those too.
    await this.#completions.idle();
    await Promise.allSettled([...this.#settling]);
    // Events published on the way here — `completed` among them — before the
    // driver they are written through can be closed.
    await Promise.allSettled([...this.#publishing]);

    if (this.#running) {
      await this.#stopped.promise;
    }

    await this.#closeDeadLetters();
    await this.#limiter
      ?.close()
      .catch((error: unknown) => this.#emitError(error, "limits"));

    if (this.#ownsDriver) {
      await this.driver.close();
    }

    this.#running = false;
    this.#releaseProcess();
    this.safeEmit("closed");
  }

  /**
   * Gives up on every job still running: aborts its signal and stops renewing
   * its lock.
   *
   * Stopping the renewal is the half that matters for a processor ignoring
   * its signal. Its heartbeat would otherwise go on extending the lock for as
   * long as the process lives, so the lock never lapses and the stalled sweep
   * — in this process or any other — never returns the job to the queue.
   */
  #abandonActive(): void {
    for (const controller of this.#aborts.values()) {
      controller.abort();
    }

    for (const heartbeat of this.#heartbeats.values()) {
      clearInterval(heartbeat);
    }
    this.#heartbeats.clear();
  }

  /**
   * Keeps the process alive while the claim loop runs, when the worker was
   * asked to — the default.
   *
   * A timer that never fires, whose only purpose is to count as pending work
   * to the event loop. The alternative, ref'ing the loop's own waits, would
   * make the rule depend on whichever wait happens to be in progress; one
   * handle held for exactly the life of `run()` is a rule that can be read.
   */
  #holdProcess(): void {
    if (!this.#waitToExit || this.#keepAlive) {
      return;
    }

    this.#keepAlive = setInterval(() => {}, 2_147_483_647);
  }

  /** Lets the process exit on the worker's account. */
  #releaseProcess(): void {
    if (this.#keepAlive) {
      clearInterval(this.#keepAlive);
      this.#keepAlive = undefined;
    }
  }

  /** Closes the dead-letter queues this worker opened. They share its driver. */
  async #closeDeadLetters(): Promise<void> {
    const queues = [...this.#deadLetters.values()];
    this.#deadLetters.clear();
    await Promise.allSettled(queues.map((queue) => queue.close()));
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
      this.#releaseProcess();
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

    if (claimed > 0) {
      // Work arrived, so the quiet spell is over and the next one is its own
      // event rather than a continuation of this one. Reset here rather than
      // further down: at a concurrency of one the branch below returns first,
      // so a worker that is never idle for long would never reset at all.
      this.#emptySince = undefined;
      this.#drainedAnnounced = false;
    }

    if (this.#active.size >= this.#concurrency && this.#active.size > 0) {
      // Full: wait for a slot rather than spinning on a claim that cannot
      // succeed — or for a wake, so `close()` is not left waiting on a loop
      // that is itself waiting on a job that may never finish.
      await this.#sleepUntilWake(this.#options.lockDuration, [
        ...this.#active.values(),
      ]);
      return;
    }

    if (claimed > 0) {
      return;
    }

    if (this.#limitedFor !== undefined) {
      // Held back by the queue's limits, not short of work: wait for the
      // window to end or for one of this worker's own jobs to finish, and do
      // not announce a drain that did not happen.
      const wait = this.#limitedFor;
      this.#limitedFor = undefined;
      await this.#sleepUntilWake(wait, [...this.#active.values()]);
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

    this.#announceDrained();
    await this.#idle(await this.#waitBudget());
  }

  /**
   * Announces an event to other processes, when asked to.
   *
   * The worker is the only thing that knows a job became active, reported
   * progress, completed, failed or stalled — it is the process running it. So
   * without this, a producer or a dashboard elsewhere can observe only what it
   * did itself, which is why `BunQueue` declared those events and never saw
   * one.
   *
   * `type` selects the payload's shape, so a mismatched pair is a compile
   * error here rather than a surprise in a subscriber somewhere else. A
   * failure to publish is logged and swallowed: an observer missing an event
   * must never fail the job that produced it.
   */
  /**
   * Publishes an event, tracked so `close()` can wait for it.
   *
   * Callers fire it and move on, and a caller may close straight after — from
   * the very listener the event was emitted to. Untracked, the close shut the
   * driver under the write: a `completed` event from a process that closed on
   * completion was lost, and on MongoDB, whose publish takes two round trips,
   * reliably.
   */
  #publish<Name extends QueueEventName>(
    type: Name,
    payload: QueueEventPayloads[Name],
  ): Promise<void> {
    const publishing = this.#doPublish(type, payload).finally(() => {
      this.#publishing.delete(publishing);
    });
    this.#publishing.add(publishing);
    return publishing;
  }

  /** The body of {@link #publish}. */
  async #doPublish<Name extends QueueEventName>(
    type: Name,
    payload: QueueEventPayloads[Name],
  ): Promise<void> {
    if (!this.#publishes) {
      return;
    }

    await this.#publishGate?.();

    try {
      await this.driver.publish(
        queueEvent(
          {
            ns: this.namespace,
            target: this.queueName,
            type,
            origin: this.#token,
          },
          payload,
        ),
      );
    } catch (error) {
      this.#logger.warn("Could not publish a worker event", { error, type });
    }
  }

  /**
   * Emits `drained` once the queue has been quiet for `drainDelay`.
   *
   * The option was resolved and never read, so `drained` fired on every empty
   * pass — which on an idle worker is once per poll, forever. That is not an
   * event, it is a heartbeat, and a listener that logs or alerts on it has to
   * debounce what should have arrived debounced.
   *
   * Quiet means *continuously* empty: the timer starts at the first empty pass
   * and is reset by the next claim, so a queue that hands out one job a second
   * with a one-second delay never drains. Emitted once per quiet spell rather
   * than once per pass, which is what makes it an event.
   */
  #announceDrained(): void {
    const delay = this.#options.drainDelay;

    if (delay <= 0) {
      this.safeEmit("drained");
      return;
    }

    this.#emptySince ??= Date.now();

    if (this.#drainedAnnounced || Date.now() - this.#emptySince < delay) {
      return;
    }

    this.#drainedAnnounced = true;
    this.safeEmit("drained");
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

    const now = Date.now();
    const reservation = await this.#reserve(slots, now);

    // Reading the limits is an await, and `pause()` or `close()` may have
    // landed during it. The check at the top of the pass has already been
    // made, so it is made again here, before anything is claimed — and any
    // capacity reserved in the meantime goes straight back.
    if (this.#paused || this.#closing) {
      if (reservation && reservation.grant > 0) {
        await this.#limiter!.commit(reservation, [], Date.now()).catch(
          (error: unknown) => this.#emitError(error, "limits"),
        );
      }

      return 0;
    }

    if (reservation && reservation.grant === 0) {
      this.#limitedFor = this.#limitedWait(reservation.retryAfter);
      return 0;
    }

    let records: JobRecord[];

    try {
      records = await claimJobBatch(
        this.driver,
        this.ref,
        {
          workerId: this.id,
          token: this.#token,
          lockMs: this.#options.lockDuration,
          now,
          ...(reservation && reservation.excludeNames.length > 0
            ? { excludeNames: reservation.excludeNames }
            : {}),
        },
        reservation?.grant ?? slots,
      );
    } catch (error) {
      // The reservation already charged every open limited name for the whole
      // grant. Without the `commit` below nothing gives that back: the charge
      // sits on this worker's own lease, which it keeps renewing, so the name
      // reads as full until the worker closes. A claim that throws — InnoDB
      // picking it as a deadlock victim, a dropped connection — claimed
      // nothing, so all of it goes back before the error is reported.
      if (reservation && reservation.grant > 0) {
        await this.#limiter!.commit(reservation, [], Date.now()).catch(
          (commitError: unknown) => this.#emitError(commitError, "limits"),
        );
      }

      throw error;
    }

    if (reservation) {
      await this.#limiter!.commit(
        reservation,
        records.map((record) => record.name),
        Date.now(),
      ).catch((error: unknown) => this.#emitError(error, "limits"));

      // Nothing came back while names were being skipped: there may well be
      // work, all of it capped. Waiting for work would return at once and
      // spin, so wait out the limit instead — and never call that drained.
      if (records.length === 0 && reservation.excludeNames.length > 0) {
        this.#limitedFor = this.#limitedWait(undefined);
      }
    }

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

  /** Reserves capacity under the queue's limits, or `null` when it has none. */
  async #reserve(slots: number, now: number): Promise<Reservation | null> {
    if (!this.#limiter) {
      return null;
    }

    try {
      return await this.#limiter.reserve(slots, now);
    } catch (error) {
      // Limits that cannot be read are not a reason to stop consuming: the
      // cost of running unlimited for a moment is less than a stalled queue.
      this.#emitError(error, "limits");
      return null;
    }
  }

  /** How long a limited pass waits: until its window ends, within bounds. */
  #limitedWait(retryAfter: number | undefined): number {
    const recheck = Math.min(this.#options.pollInterval, LIMITED_RECHECK_MS);
    return retryAfter === undefined
      ? recheck
      : Math.max(1, Math.min(retryAfter, this.#options.maxBlock));
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
    // The progress hook is how `updateProgress` reaches an emitter: `Job` has
    // none of its own, and the worker is the only thing that sees the call.
    const job = new Job<TData, TResult>(
      this.driver,
      this.ref,
      record,
      true,
      (progress) => {
        this.safeEmitScoped("progress", record.name, job, progress);
        void this.#publish("progress", { id: record.id, progress });
      },
    );
    const controller = new AbortController();
    this.#aborts.set(record.id, controller);

    const heartbeat = setInterval(() => {
      void this.#heartbeat(record, controller);
    }, this.#options.heartbeatInterval);
    heartbeat.unref?.();
    this.#heartbeats.set(record.id, heartbeat);

    const context: ProcessorContext = {
      signal: controller.signal,
      logger: this.#logger.child({ jobId: record.id, jobName: record.name }),
      workerId: this.id,
      attempt: record.attemptsMade,
      heartbeat: async () => {
        await this.#heartbeat(record, controller);
      },
      log: async (line) => await job.log(line),
    };

    this.safeEmitScoped("active", record.name, job);
    void this.#publish("active", { id: record.id });

    try {
      const result = await withTimeout(
        this.#isolated
          ? this.#isolated.run(
              job as Job<unknown, unknown>,
              record,
              context,
              controller,
              {
                namespace: this.namespace,
                queue: this.queueName,
                workerId: this.id,
              },
            )
          : Promise.resolve(this.#processor!(job, context)),
        record.opts.timeout,
        {
          message: `Job ${record.id} exceeded its ${record.opts.timeout}ms timeout`,
          onTimeout: () => controller.abort(),
        },
      );

      // Not awaited, deliberately.
      //
      // The job has run; recording that is bookkeeping, and holding the worker
      // on it makes every job cost two serial round trips instead of one. Let
      // go here and the next claim goes out on another pooled connection while
      // this write is still in flight — measured, that is most of the distance
      // to graphile-worker, which does exactly this.
      //
      // `close()` still waits for these through `#settling`, so a clean
      // shutdown never abandons one.
      this.#settle(job, record, result as TResult);
    } catch (error) {
      await this.#recordFailure(job, record, error);
    } finally {
      clearInterval(heartbeat);
      this.#heartbeats.delete(record.id);
      this.#limiter?.release(record.name);
    }
  }

  /**
   * Runs a write that records how a job ended, retrying it while it throws.
   *
   * The job has already run, so a write that fails strands it: `active`, under
   * a lock nobody renews, until the stalled sweep takes it back `lockDuration`
   * plus up to `stalledInterval` later — a minute by default — and runs it a
   * second time. Most such failures are the database saying "busy, try again"
   * (a deadlock victim, a lock wait timeout), which a short wait cures.
   *
   * Every write retried here is conditional on this worker's lock token, so a
   * repeat of one that did land, its reply lost, changes nothing and answers
   * `false`. The retries stop at a quarter of the lock duration, so they can
   * never outlive the lock they depend on.
   */
  async #persist<T>(write: () => Promise<T>): Promise<T> {
    /** Attempts in all, the first included. */
    const attempts = 5;
    const giveUpAt = Date.now() + this.#options.lockDuration / 4;

    for (let attempt = 1; ; attempt++) {
      try {
        return await write();
      } catch (error) {
        // Jittered and doubling — up to 50, 100, 200, 400ms — so two workers
        // that lost the same deadlock do not collide again in step.
        const wait = Math.random() * 25 * 2 ** attempt;

        if (attempt >= attempts || Date.now() + wait > giveUpAt) {
          throw error;
        }

        await sleep(wait, { unref: true }).catch(() => {});
      }
    }
  }

  /**
   * Makes a job this worker could not record claimable again as soon as the
   * stalled sweep next runs, rather than a whole lock duration later.
   *
   * Only reached once {@link #persist} has given up, so the database is
   * failing persistently and this may well fail too; that is fine, the lock
   * then lapses on its own. Conditional on the token, like the write it stands
   * in for, so a job whose outcome did land is left alone.
   */
  async #expireLock(record: JobRecord): Promise<void> {
    await this.driver
      .extendJobLock(this.ref, record.id, this.#token, 0, Date.now())
      .catch(() => false);
  }

  /**
   * Records a finished job, off the critical path.
   *
   * The write is tracked so `close()` can wait for it. A failure here is not
   * the job failing — it already ran — so it is retried, not turned into a
   * failed attempt; losing the lock means someone else owns the outcome. When
   * the retries run out the error is reported and the job's lock expired, so
   * the next stalled sweep returns it instead of one a lock duration later.
   */
  #settle(job: Job<TData, TResult>, record: JobRecord, result: TResult): void {
    const written = createDeferred<void>();
    const stored = jsonClone(result ?? null);
    const retention = record.opts.removeOnComplete;

    /** Reports the outcome once the write has answered. */
    const settled = (kept: boolean) => {
      if (kept) {
        this.safeEmitScoped("completed", record.name, job, result);
        void this.#publish("completed", {
          id: record.id,
          returnValue: result ?? null,
        });
      } else {
        this.safeEmit("lockLost", job);
      }
    };

    this.#completions.add({
      id: record.id,
      result: stored,
      retention,
      settle: (kept) => {
        settled(kept);
        written.resolve();
      },
      // The batched attempt failed. This one job is retried alone: the batch
      // it shared may have failed for a reason that was never its own.
      fail: () => {
        void this.#persist(
          async () =>
            await this.driver.completeJob(
              this.ref,
              record.id,
              this.#token,
              stored,
              retention,
              Date.now(),
            ),
        )
          .then(settled)
          .catch(async (error: unknown) => {
            this.#emitError(error, "complete");
            await this.#expireLock(record);
          })
          .finally(() => written.resolve());
      },
    });

    const tracked = written.promise.finally(() => {
      this.#settling.delete(tracked);
    });

    this.#settling.add(tracked);
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
      attempt < record.maxAttempts &&
      // By name too: an error from an isolated processor is rebuilt from its
      // serialized form, and is no longer an instance of the class.
      !(
        error instanceof UnrecoverableJobError ||
        (error instanceof Error && error.name === "UnrecoverableJobError")
      );
    // `false` when the job's own strategy says to stop, attempts left or not.
    const delay = retryable
      ? nextBackoff(
          attempt,
          record,
          failure,
          this.#backoffs,
          (message, fields) => this.#logger.warn(message, fields),
        )
      : false;

    const now = Date.now();

    // Retried like a completion, for the same reason: see `#persist`. The
    // write checks the lock token and the job's state itself, so a repeat of
    // one that landed changes nothing.
    try {
      if (delay !== false) {
        const runAt = now + delay;
        await this.#persist(
          async () =>
            await this.driver.failJob(
              this.ref,
              record.id,
              this.#token,
              serialized,
              { retry: true, runAt },
              now,
              record.opts.keepStacktraces,
            ),
        );

        this.safeEmitScoped("failed", record.name, job, failure);
        this.safeEmitScoped("retrying", record.name, job, failure, runAt);
        void this.#publish("failed", { id: record.id, error: serialized });
        void this.#publish("retrying", {
          id: record.id,
          error: serialized,
          runAt,
        });
        return;
      }

      await this.#persist(
        async () =>
          await this.driver.failJob(
            this.ref,
            record.id,
            this.#token,
            serialized,
            { retry: false, retention: record.opts.removeOnFail },
            now,
            record.opts.keepStacktraces,
          ),
      );

      this.safeEmitScoped("failed", record.name, job, failure);
      this.safeEmitScoped("dead", record.name, job, failure);
      void this.#publish("failed", { id: record.id, error: serialized });
      void this.#publish("dead", { id: record.id, error: serialized });
    } catch (writeError) {
      this.#emitError(writeError, "failJob");
      await this.#expireLock(record);
      return;
    }

    const deadLetter = record.opts.deadLetter ?? this.#deadLetterQueue;

    if (deadLetter !== undefined) {
      await this.#fileDeadLetter(deadLetter, job, record, serialized, now);
    }
  }

  /**
   * Adds a copy of a dead job to its dead-letter queue.
   *
   * After the job is marked dead, never before: a worker that crashes between
   * the two leaves a dead job with no letter, which is visible and re-drivable,
   * rather than a letter for a job that is about to be retried. The letter's id
   * is derived from the job's, so a death noticed twice files one letter — and
   * from its creation time too, so a later job reusing the id files its own.
   */
  async #fileDeadLetter(
    queueName: string,
    job: Job<TData, TResult>,
    record: JobRecord,
    error: SerializedError,
    now: number,
  ): Promise<void> {
    if (queueName === this.queueName) {
      // A letter to itself would be claimed, fail, and file another.
      this.#emitError(
        new ConfigError(
          `Job ${record.id} names its own queue "${queueName}" as its dead-letter queue`,
          { jobId: record.id, queue: queueName },
        ),
        "deadLetter",
      );
      return;
    }

    try {
      let queue = this.#deadLetters.get(queueName);

      if (!queue) {
        queue = new BunQueue<DeadLetter, unknown, string>(queueName, {
          namespace: this.namespace,
          driver: this.driver,
          logger: this.#logger,
        });
        this.#deadLetters.set(queueName, queue);
      }

      const letter = await queue.add(
        record.name,
        {
          queue: this.queueName,
          id: record.id,
          name: record.name,
          data: record.data,
          failedReason: error,
          attemptsMade: record.attemptsMade,
          diedAt: now,
        },
        { jobId: `${this.queueName}:${record.id}:${record.createdAt}` },
      );

      this.safeEmitScoped(
        "deadLettered",
        record.name,
        job,
        letter as Job<DeadLetter<TData>, unknown>,
      );
    } catch (letterError) {
      this.#emitError(letterError, "deadLetter");
    }
  }

  /** Renews a job's lock; losing it aborts the attempt. */
  async #heartbeat(
    record: JobRecord,
    controller: AbortController,
  ): Promise<void> {
    // An aborted job has been given up on — timed out, or its worker closed.
    // Renewing its lock would keep it from ever being recovered.
    if (controller.signal.aborted) {
      return;
    }

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

      // A series that fell behind while nothing was consuming has a choice,
      // and `catchUp` is it. Off — the default — it skips to the next real
      // occurrence: an hourly job that was down for a day should run once when
      // it comes back, not twenty-four times at once, and for most series the
      // missed runs have been overtaken by events anyway.
      //
      // On, the occurrence it just computed stands even though it is already
      // due, so the backlog is replayed one occurrence per completion until
      // the series catches up with the clock. That is what a caller wants when
      // each run does a bounded piece of work that still needs doing — billing
      // a period, rolling a report — rather than reporting a current state.
      if (next !== null && next <= now && !scheduled.catchUp) {
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
        void this.#publish("stalled", { ids: recovered });
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
      await this.#sweepWindows();
    });
  }

  /**
   * Removes a page of stale debounce and throttle pointers, resuming where
   * the last pass stopped, so a queue with many ids is covered over several
   * passes rather than by one unbounded one.
   */
  async #sweepWindows(): Promise<void> {
    if (!supportsWindowSweep(this.driver)) {
      return;
    }

    const sweep = await sweepWindows(this.driver, this.ref, {
      now: Date.now(),
      limit: MAINTENANCE_BATCH,
      ...(this.#windowCursor !== undefined
        ? { after: this.#windowCursor }
        : {}),
    });

    this.#windowCursor = sweep.next;
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

  /**
   * Sleeps until `ms` pass, `resume()` or `close()` wakes the worker, or any of
   * `alsoWhen` settles — whichever comes first — and leaves nothing behind on
   * the wake signal, which lives as long as the worker. See `waitForAny`.
   */
  async #sleepUntilWake(
    ms: number,
    alsoWhen: Promise<unknown>[] = [],
  ): Promise<void> {
    if (this.#closing) {
      return;
    }

    if (this.#wake.signal.aborted) {
      this.#wake = new AbortController();
      return;
    }

    const wake = this.#wake;
    await waitForAny(ms, { signal: wake.signal, others: alsoWhen });

    if (wake.signal.aborted) {
      this.#wake = new AbortController();
    }
  }

  /** Reports a failure outside a job, logging it when nobody is listening. */
  #emitError(error: unknown, context: string): void {
    const failure =
      error instanceof Error ? error : deserializeError(serializeError(error));

    // Asked of `error` itself: a listener for any other event makes `emit`
    // throw on an unheard `error`, which `safeEmit` swallows as "heard".
    if (this.listenerCount("error") === 0) {
      this.#logger.error(failure, { context });
      return;
    }

    this.safeEmit("error", failure, context);
  }
}
