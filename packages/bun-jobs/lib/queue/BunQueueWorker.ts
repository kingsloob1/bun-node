import type { SerializedError } from "@kingsleyweb/bun-common";
import type {
  ChildOutcome,
  ChildRecordResult,
  JobRecord,
  JobRef,
  JobsDriver,
  QueueRef,
} from "../drivers/index";
import type { QueueEventName, QueueEventPayloads } from "../shared/events";
import type { Logger } from "../shared/logger";
import type { JobEvent } from "./Job";
import type { Reservation } from "./limits";
import type {
  BunQueueWorkerEvents,
  BunQueueWorkerOptions,
  DeadLetter,
  JobMap,
  JobMapOf,
  JobProcessor,
  ProcessorContext,
  WorkerEventsOf,
} from "./types";
import process from "node:process";
import {
  createDeferred,
  deserializeError,
  jsonClone,
  serializeError,
  sleep,
  withTimeout,
} from "@kingsleyweb/bun-common";
import { awaitsDelivery, flowKey } from "../drivers/flow";
import {
  claimJobBatch,
  CompletionBatcher,
  registerWorkerRecord,
  removeWorkerRecord,
  resolveDriver,
  supportsWorkers,
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
  ChildFailedError,
  ConfigError,
  JobTimeoutError,
  LockLostError,
  UnrecoverableJobError,
} from "../shared/errors";
import { queueEvent } from "../shared/events";
import { HOST, newId, newToken } from "../shared/ids";
import { assertNamespace, assertSegment } from "../shared/keys";
import { createJobsLogger } from "../shared/logger";
import { waitForAny } from "../shared/wait";
import { BackoffStrategies, nextBackoff } from "./backoff";
import { BunQueue } from "./BunQueue";
import { addDeadLetter, selfLetterError } from "./deadLetter";
import { IsolatedProcessor } from "./isolation";
import { Job } from "./Job";
import { QueueLimiter } from "./limits";
import { displayRepeatKey, shortenJobId } from "./options";
import { nextOccurrence, repeatJobId } from "./repeat";
import {
  isRepeatDisabled,
  occurrenceRecord,
  removePendingOccurrence,
} from "./repeatControl";
import { supportsWindowSweep, sweepWindows } from "./windows";

/** How many jobs one maintenance sweep touches. */
const MAINTENANCE_BATCH = 100;

/**
 * How long a parent may list a child that does not exist before the child is
 * treated as failed. Long enough for a flow still being added to finish; a
 * child still missing after it was never added, or was removed by hand.
 */
const FLOW_MISSING_GRACE_MS = 60_000;

/**
 * How many times an unfinished flow delivery is retried on its own short timer
 * before it is left to the maintenance passes. A flow is added children first,
 * so a quick child can finish before its parent exists; these retries are what
 * deliver it promptly once the parent does, rather than a `stalledInterval`
 * later.
 */
const FAST_REDELIVERY_ATTEMPTS = 8;

/** The first fast retry's delay; each one after waits twice as long, to 5s. */
const FAST_REDELIVERY_BASE_MS = 50;

/**
 * How many children one maintenance pass reads while checking the parents
 * waiting on them. Bounds the pass however wide a flow is; the next pass
 * resumes at the child this one stopped on.
 */
const FLOW_HEAL_LOOKUPS = 100;

/** How a finished child ended, before it is shaped for its parent. */
type SettledOutcome =
  | {
      /** It completed. */
      completed: true;
      /** What its processor returned, as stored. */
      value: unknown;
    }
  | {
      /** It failed for good. */
      completed: false;
      /** Its own reason, not yet wrapped for the parent. */
      error: SerializedError;
    };

/** How a stored `completed` or `dead` job ended. */
function settledOutcome(record: JobRecord): SettledOutcome {
  return record.state === "completed"
    ? { completed: true, value: record.returnValue }
    : {
        completed: false,
        error:
          record.failedReason ?? serializeError(new Error("the child failed")),
      };
}

/** The longest a worker held back by a concurrency limit waits before asking again. */
const LIMITED_RECHECK_MS = 100;

/** How long a paused check is cached before the driver is asked again. */
const PAUSE_CACHE_MS = 1000;

/**
 * How often the delayed-job promotion sweep runs for a poll interval: as often
 * as the worker polls, and at least once a second, so a busy worker that is
 * never idle still promotes retries whose backoff has elapsed.
 */
function promotionCadence(pollInterval: number): number {
  return Math.min(pollInterval, 1000);
}

/**
 * The longest a timer can be set for. A longer delay does not wait longer: it
 * overflows and fires at once, which turns an idle worker's wait into a spin.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Checks a runtime-set interval is a positive number of milliseconds a timer
 * can actually wait.
 */
function assertPositiveMs(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${what} must be a positive number of milliseconds`, {
      [what]: value,
    });
  }

  if (value > MAX_TIMER_MS) {
    throw new ConfigError(
      `${what} cannot be longer than ${MAX_TIMER_MS}ms (about 24.8 days), the longest a timer can be set for`,
      { [what]: value, max: MAX_TIMER_MS },
    );
  }

  return value;
}

/** How often a worker writes its heartbeat record, unless told otherwise. */
const DEFAULT_REPORT_INTERVAL = 10_000;

/** How many report intervals a heartbeat record outlives its last write by. */
const REPORT_LIFETIMES = 3;

/** A publish that does nothing: already settled, and shared, so it costs nothing. */
const SETTLED: Promise<void> = Promise.resolve();

/**
 * A processor's result as it is stored: what `jsonClone` makes of it, without
 * paying for the round trip where it would change nothing. `null`, strings,
 * booleans and finite numbers come back from JSON exactly as they went in;
 * `NaN` and the infinities become `null`, as JSON makes them; anything else is
 * cloned, so a result mutated after it was returned is stored as it was.
 */
function storedResult(result: unknown): unknown {
  if (result === undefined || result === null) {
    return null;
  }

  switch (typeof result) {
    case "string":
    case "boolean":
      return result;
    case "number":
      return Number.isFinite(result) ? result : null;
    default:
      return jsonClone(result);
  }
}

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
 *
 * @typeParam TData What the jobs it runs carry.
 * @typeParam TResult What its processor answers with.
 * @typeParam TJobs A declared job map, for the registry worker `jobs.start()`
 * returns: its listeners are then handed a `TypedJob`, discriminated by name,
 * and each declared name's scoped events carry that name's own types. The
 * default, `JobMap`, means none — the events are exactly as before.
 */
/**
 * How long a worker trusts a series' disabled flag as last read before
 * reading it again.
 */
const REPEAT_FLAG_CACHE_MS = 1_000;

export class BunQueueWorker<
  TData = unknown,
  TResult = unknown,
  TJobs extends JobMapOf<TJobs> = JobMap,
> extends TypedEmitterBase<
  WorkerEventsOf<TData, TResult, TJobs>,
  BunQueueWorkerEvents<TData, TResult>
> {
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
   * Where the next pass over parents waiting on children resumes: a page
   * offset into them, and the child of that page's first parent to start at.
   * Wraps to the start after the last page.
   */
  #parentsCursor = { offset: 0, child: 0 };
  /**
   * Where the next pass over finished jobs looking for unrecorded children
   * resumes: the state, `completed` then `dead`, and an offset into it.
   */
  #childrenCursor: { state: "completed" | "dead"; offset: number } = {
    state: "completed",
    offset: 0,
  };

  /**
   * Flow deliveries this worker started and could not finish — a write that
   * failed, or a parent not there yet — by `queue:id`, with how many tries
   * they have had and the fast retry timer, if one is set. Tried again before
   * any maintenance scan.
   */
  readonly #redeliveries = new Map<
    string,
    {
      /** The child's queue. */
      queue: string;
      /** The child's id. */
      id: string;
      /** Tries so far. */
      attempts: number;
      /** The pending fast retry, if any. */
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * How long to wait before claiming again after a pass the limits held back,
   * or `undefined` when the last pass was not limited.
   */
  #limitedFor: number | undefined;
  /** The dead-letter queue for jobs that do not name their own. */
  readonly #deadLetterQueue: string | undefined;
  /** When each series was last read as enabled; see `#repeatDisabled`. */
  readonly #enabledRepeats = new Map<string, number>();
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
  /** How often the heartbeat record is written, in milliseconds; `0` for never. */
  readonly #reportInterval: number;
  /** When `run()` last started consuming, for the heartbeat record. */
  #startedAt = 0;
  /** The timer writing the heartbeat record, while the worker runs. */
  #reportTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * The heartbeat write in flight, so writes never overlap and `close()` can
   * wait for one before removing the record — otherwise a write landing after
   * the removal would list a closed worker until its record lapsed.
   */
  #reporting: Promise<void> | undefined;
  /**
   * Whether a heartbeat write was ever attempted. Closing removes the record
   * only then: a worker that never ran, or never got as far as connecting,
   * has nothing to remove, and asking a driver to remove it would connect —
   * and on an unreachable backend, wait — for nothing.
   */
  #reported = false;

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

    const reportInterval = options.reportInterval ?? DEFAULT_REPORT_INTERVAL;
    if (!Number.isFinite(reportInterval) || reportInterval < 0) {
      throw new ConfigError(
        "reportInterval must be a number of milliseconds, or 0 to turn reporting off",
        { reportInterval },
      );
    }
    this.#reportInterval = reportInterval;

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
    void this.#report();
  }

  /**
   * How long an idle worker waits before looking for work again, on a driver
   * that polls; also the cadence of the delayed-job promotion sweep, capped at
   * once a second.
   */
  get pollInterval(): number {
    return this.#options.pollInterval;
  }

  /**
   * Changes the poll interval at runtime, and re-arms a running worker's
   * promotion sweep when its cadence changes. At most 2,147,483,647ms, the
   * longest a timer can wait.
   *
   * On a polling driver the wait in progress is cut short, so the new
   * interval applies at once. On a blocking one (`capabilities.blockingWait`)
   * it is left to finish and the new value applies from the next wait: a
   * blocking read cannot be called off, and one abandoned mid-wait still
   * consumes the wake a new job sends, which would leave that job waiting out
   * the whole of the next wait.
   */
  set pollInterval(value: number) {
    const ms = assertPositiveMs(value, "pollInterval");
    const before = promotionCadence(this.#options.pollInterval);

    this.#options.pollInterval = ms;

    if (promotionCadence(ms) !== before) {
      this.#armPromotion();
    }

    this.#wakeForNewInterval();
  }

  /** Longest an idle worker blocks waiting for work, on a blocking driver. */
  get maxBlock(): number {
    return this.#options.maxBlock;
  }

  /**
   * Changes `maxBlock` at runtime, at most 2,147,483,647ms. As with
   * `pollInterval`, a wait in progress is cut short only on a polling driver;
   * on a blocking one the new value applies from the next wait.
   */
  set maxBlock(value: number) {
    this.#options.maxBlock = assertPositiveMs(value, "maxBlock");
    this.#wakeForNewInterval();
  }

  /**
   * Ends the current wait so a changed interval applies at once — only where
   * that is safe. See {@link BunQueueWorker.pollInterval}'s setter for why a
   * blocking driver's wait is left alone.
   */
  #wakeForNewInterval(): void {
    if (!this.driver.capabilities.blockingWait) {
      this.#wake.abort();
    }
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

    try {
      await this.driver.connect();
      await this.driver.ensureQueue(this.ref);
    } catch (error) {
      // Never started, so nothing will ever stop: without this, `#running`
      // stayed true and `#stopped` never resolved, and a later `close()` —
      // which waits for the loop to stop — hung for good. A `run()` called
      // again tries to connect again rather than joining a dead start.
      this.#running = false;
      this.#stopped.resolve();
      throw error;
    }

    this.#armMaintenance();
    this.#startedAt = Date.now();
    // The first heartbeat, deliberately not awaited. Holding `run()` on a
    // write moves when the claim loop starts relative to whatever the caller
    // does next, and a job added straight after `run()` is then claimed along
    // a different path — which changed when a timed-out attempt's abort was
    // seen. A worker is listed moments after `ready`, not necessarily by it.
    void this.#report();
    this.#armReports();
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
    void this.#report();

    if (options?.waitActive) {
      await Promise.allSettled([...this.#active.values()]);
    }
  }

  /** Resumes claiming. */
  resume(): void {
    this.#paused = false;
    this.#wake.abort();
    this.safeEmit("resumed");
    void this.#report();
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

    if (this.#reportTimer) {
      clearInterval(this.#reportTimer);
      this.#reportTimer = undefined;
    }

    if (options?.force) {
      this.#abandonActive();

      // Deliberately no wait. A processor that ignores its signal must not
      // hold shutdown hostage; its lock lapses and the stalled sweep returns
      // the job to the queue, so the work is delayed rather than lost.
      await this.#unregister();
      await this.#flushThroughput();
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

    await this.#unregister();
    await this.#flushThroughput();
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
    target: string = this.queueName,
  ): Promise<void> {
    // Nothing to track, and nothing to allocate, for a worker that does not
    // publish — which is most of them, on every job.
    if (!this.#publishes) {
      return SETTLED;
    }

    const publishing = this.#doPublish(type, payload, target).finally(() => {
      this.#publishing.delete(publishing);
    });
    this.#publishing.add(publishing);
    return publishing;
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
   *
   * `target` is the queue the event is about: this worker's own, or — for a
   * flow parent a child here released or buried — the parent's.
   */
  async #doPublish<Name extends QueueEventName>(
    type: Name,
    payload: QueueEventPayloads[Name],
    target: string,
  ): Promise<void> {
    await this.#publishGate?.();

    try {
      await this.driver.publish(
        queueEvent(
          {
            ns: this.namespace,
            target,
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
    const reservation = this.#limiter?.knownUnlimited(now)
      ? null
      : await this.#reserve(slots, now);

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
    /** The reason the processor gave `job.fail()`, which settles the attempt. */
    let failedWith: UnrecoverableJobError | undefined;
    /** Whether the processor has returned or thrown, so `fail()` is too late. */
    let attemptOver = false;

    // The progress hook is how `updateProgress` reaches an emitter: `Job` has
    // none of its own, and the worker is the only thing that sees the call.
    // `onFail` is what makes this view the job's owner.
    const job = new Job<TData, TResult>(this.driver, this.ref, record, true, {
      onProgress: (progress) => {
        this.safeEmitScoped("progress", record.name, job, progress);
        void this.#publish("progress", { id: record.id, progress });
      },
      onFail: (error) => {
        if (attemptOver) {
          return false;
        }

        // The first reason stands: failing is final, and a second call is
        // not a change of mind.
        failedWith ??= error;
        return true;
      },
      onEvent: async (event) => await this.#onJobEvent(event),
    });
    const controller = new AbortController();
    this.#aborts.set(record.id, controller);

    const heartbeat = setInterval(() => {
      void this.#heartbeat(record, controller);
    }, this.#options.heartbeatInterval);
    heartbeat.unref?.();
    this.#heartbeats.set(record.id, heartbeat);

    // Built on first use: most processors never log, and a child logger is an
    // object and a copy of its bindings for every job.
    const parentLogger = this.#logger;
    let jobLogger: Logger | undefined;

    const context: ProcessorContext = {
      signal: controller.signal,
      get logger(): Logger {
        jobLogger ??= parentLogger.child({
          jobId: record.id,
          jobName: record.name,
        });
        return jobLogger;
      },
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
      const running = this.#isolated
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
        : Promise.resolve(this.#processor!(job, context));
      // No timeout, no wrapper around it.
      const result =
        record.opts.timeout > 0
          ? await withTimeout(running, record.opts.timeout, {
              message: `Job ${record.id} exceeded its ${record.opts.timeout}ms timeout`,
              onTimeout: () => controller.abort(),
            })
          : await running;
      attemptOver = true;

      // `job.fail()` was called: the attempt ends that way however the
      // processor returned.
      if (failedWith) {
        await this.#recordFailure(job, record, failedWith);
        return;
      }

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
      attemptOver = true;
      // A reason given to `job.fail()` wins over whatever was thrown after it
      // — very often the processor's own way of stopping once it had failed.
      await this.#recordFailure(job, record, failedWith ?? error);
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
    const stored = storedResult(result);
    const retention = record.opts.removeOnComplete;
    // A child's record stays until its parent has its result, so a crash
    // between the two can still deliver it; its retention applies after.
    const completionRetention = record.flow?.parent ? false : retention;

    /** Reports the outcome once the write has answered. */
    const settled = (kept: boolean) => {
      if (kept) {
        this.safeEmitScoped("completed", record.name, job, result);
        void this.#publish("completed", {
          id: record.id,
          returnValue: result ?? null,
        });

        if (record.flow?.parent) {
          this.#track(
            this.#deliverSafely(this.queueName, record, {
              completed: true,
              value: stored,
            }),
          );
        }
      } else {
        this.safeEmit("lockLost", job);
      }
    };

    this.#completions.add({
      id: record.id,
      result: stored,
      retention: completionRetention,
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
              completionRetention,
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

  /** Keeps `close()` waiting for work started off the critical path. */
  #track(work: Promise<unknown>): void {
    const tracked = work
      .then(() => undefined)
      .finally(() => {
        this.#settling.delete(tracked);
      });
    this.#settling.add(tracked);
  }

  /* --- flows ---------------------------------------------------------------- */

  /**
   * {@link #deliver}, reporting rather than throwing. A delivery that fails is
   * remembered and tried again soon, and on every maintenance pass after that,
   * so a transient error does not wait for a scan to find it.
   */
  async #deliverSafely(
    queue: string,
    record: JobRecord,
    outcome: SettledOutcome,
  ): Promise<ChildRecordResult | undefined> {
    try {
      return await this.#deliver(queue, record, outcome);
    } catch (error) {
      this.#rememberDelivery(queue, record.id);
      this.#emitError(error, "flow");
      return undefined;
    }
  }

  /**
   * Tells a finished child's parent how it ended, then lets the child's own
   * retention apply, then follows through on what that did to the parent: a
   * released parent is announced, a buried one gets the events, dead-lettering
   * and retention a normal bury has, and its failure travels on up the flow.
   *
   * Every step is repeat-safe, so a crash anywhere in here is healed by doing
   * the whole thing again; the parent's record of the outcome is what counts.
   *
   * The child is marked recorded — letting its retention remove it — only once
   * the parent needs nothing more from it. Not while there is no parent yet
   * (a flow is added children first, so a quick child can finish before it),
   * and not when a buried parent refuses a failure: that failed child stays, so
   * a retry of the parent waits on it and it can be retried in turn.
   */
  async #deliver(
    queue: string,
    record: JobRecord,
    outcome: SettledOutcome,
  ): Promise<ChildRecordResult | undefined> {
    const parent = record.flow?.parent;
    if (!parent || !this.driver.recordChild || !this.driver.markChildRecorded) {
      return undefined;
    }

    const child: JobRef = { queue, id: record.id };
    const childRef: QueueRef = { ns: this.namespace, queue };
    const parentRef: QueueRef = { ns: this.namespace, queue: parent.queue };
    const ignored = record.opts.ignoreFailure === true;
    const delivered: ChildOutcome = outcome.completed
      ? outcome
      : {
          completed: false,
          ignored,
          error: ignored
            ? outcome.error
            : serializeError(new ChildFailedError(child, outcome.error)),
        };
    const retention = outcome.completed
      ? record.opts.removeOnComplete
      : record.opts.removeOnFail;

    const result = await this.#persist(
      async () =>
        await this.driver.recordChild!(
          parentRef,
          parent.id,
          child,
          delivered,
          Date.now(),
        ),
    );

    // A repeat of the delivery that buried the parent — its first attempt died
    // before the mark — reads as a refusal, and is told apart by the reason.
    const repeatOfBury =
      result === "parent-dead" &&
      (await this.#wasBuriedBy(parentRef, parent.id, child));

    if (result === "missing") {
      const finishedAt = record.finishedOn ?? Date.now();
      if (Date.now() - finishedAt <= FLOW_MISSING_GRACE_MS) {
        // Most likely a flow still being added: its parent arrives last.
        this.#rememberDelivery(queue, record.id);
        return result;
      }
      // Past the grace period the parent is not coming: an orphan, whose own
      // retention may now apply.
    } else if (result === "parent-dead" && !repeatOfBury) {
      this.#forgetDelivery(queue, record.id);
      return result;
    }

    await this.#persist(
      async () =>
        await this.driver.markChildRecorded!(
          childRef,
          record.id,
          retention,
          Date.now(),
        ),
    );
    this.#forgetDelivery(queue, record.id);

    if (result === "released") {
      await this.#announceReleased(parentRef, parent.id);
    } else if (result === "buried" || repeatOfBury) {
      const error = delivered.completed ? undefined : delivered.error;
      await this.#afterBury(parentRef, parent.id, error, {
        announce: result === "buried",
      });
    }

    return result;
  }

  /**
   * Announces what a job this worker handed out did to itself: `remove()`,
   * `promote()` and `retry()` are published as the queue's own methods
   * publish them — a worker has no local event for any of the three — and a
   * job buried by `fail()` from outside its processor gets the `failed` and
   * `dead` events a job that died here gets.
   */
  async #onJobEvent(event: JobEvent): Promise<void> {
    switch (event.type) {
      case "removed":
      case "promoted":
        await this.#publish(event.type, { id: event.id });
        return;

      case "retried":
        await this.#publish("retried", { ids: [event.id] });
        return;

      case "buried": {
        const { record, error } = event;
        const job = new Job<TData, TResult>(this.driver, this.ref, record);
        const failure = deserializeError(error);
        this.safeEmitScoped("failed", record.name, job, failure);
        this.safeEmitScoped("dead", record.name, job, failure);
        await this.#publish("failed", { id: record.id, error });
        await this.#publish("dead", { id: record.id, error });
      }
    }
  }

  /** Whether a buried parent's reason names `child` as what buried it. */
  async #wasBuriedBy(
    ref: QueueRef,
    id: string,
    child: JobRef,
  ): Promise<boolean> {
    const parent = await this.driver.getJob(ref, id);
    return (
      parent?.state === "dead" &&
      parent.failedReason?.name === ChildFailedError.name &&
      parent.failedReason.data?.child === flowKey(child)
    );
  }

  /** Publishes the state a parent was released to, on the parent's queue. */
  async #announceReleased(ref: QueueRef, id: string): Promise<void> {
    const parent = await this.driver.getJob(ref, id);

    if (parent?.state === "waiting") {
      await this.#publish("waiting", { id }, ref.queue);
    } else if (parent?.state === "delayed") {
      await this.#publish("delayed", { id, runAt: parent.runAt }, ref.queue);
    }
  }

  /**
   * Does for a parent a child buried what failing does for any job that dies:
   * `failed` and `dead` events, a dead letter when one is configured, and
   * retention. A nested parent's retention waits for its own parent to record
   * it, like any child's; its failure is delivered there, which carries it on
   * up the flow. A top-level parent applies its `removeOnFail` now.
   */
  async #afterBury(
    ref: QueueRef,
    id: string,
    reason: SerializedError | undefined,
    options: {
      /** Whether to emit and publish `failed` and `dead`; not on a repeat. */
      announce: boolean;
    },
  ): Promise<void> {
    const record = await this.driver.getJob(ref, id);
    if (!record || record.state !== "dead") {
      return;
    }

    const error =
      record.failedReason ??
      reason ??
      serializeError(new Error("buried by a child"));
    // Local listeners hear about jobs in this worker's own queue only; other
    // queues' listeners hear through the published events.
    const own = ref.queue === this.queueName;
    const job = own
      ? new Job<TData, TResult>(this.driver, ref, record)
      : undefined;

    if (options.announce) {
      if (job) {
        const failure = deserializeError(error);
        this.safeEmitScoped("failed", record.name, job, failure);
        this.safeEmitScoped("dead", record.name, job, failure);
      }
      await this.#publish("failed", { id, error }, ref.queue);
      await this.#publish("dead", { id, error }, ref.queue);
    }

    const deadLetter =
      record.opts.deadLetter ?? (own ? this.#deadLetterQueue : undefined);
    if (deadLetter !== undefined) {
      await this.#fileDeadLetter(
        deadLetter,
        ref.queue,
        job,
        record,
        error,
        Date.now(),
      );
    }

    if (record.flow?.parent) {
      await this.#deliver(ref.queue, record, { completed: false, error });
      return;
    }

    await this.#persist(
      async () =>
        await this.driver.markChildRecorded!(
          ref,
          id,
          record.opts.removeOnFail,
          Date.now(),
        ),
    );
  }

  /**
   * Keeps a delivery that did not finish for another try: soon, on a short
   * doubling delay for its first few attempts, and on every maintenance pass
   * until it goes through or the child is gone.
   */
  #rememberDelivery(queue: string, id: string): void {
    const key = flowKey({ queue, id });
    const entry = this.#redeliveries.get(key) ?? { queue, id, attempts: 0 };
    entry.attempts++;
    this.#redeliveries.set(key, entry);

    if (
      this.#closing ||
      entry.timer !== undefined ||
      entry.attempts > FAST_REDELIVERY_ATTEMPTS
    ) {
      return;
    }

    const timer = setTimeout(
      () => {
        this.#timers.delete(timer);
        entry.timer = undefined;
        if (!this.#closing) {
          this.#track(this.#redeliver(key));
        }
      },
      Math.min(FAST_REDELIVERY_BASE_MS * 2 ** (entry.attempts - 1), 5_000),
    );
    timer.unref?.();
    entry.timer = timer;
    this.#timers.add(timer);
  }

  /** Drops a remembered delivery that went through, or no longer applies. */
  #forgetDelivery(queue: string, id: string): void {
    const key = flowKey({ queue, id });
    const entry = this.#redeliveries.get(key);
    if (entry?.timer !== undefined) {
      clearTimeout(entry.timer);
      this.#timers.delete(entry.timer);
    }
    this.#redeliveries.delete(key);
  }

  /** Tries a remembered delivery again, from the child as it is stored now. */
  async #redeliver(key: string): Promise<void> {
    const entry = this.#redeliveries.get(key);
    if (!entry) {
      return;
    }

    const record = await this.driver
      .getJob({ ns: this.namespace, queue: entry.queue }, entry.id)
      .catch(() => undefined);

    if (record === undefined) {
      // The read failed: keep it for the next pass.
      return;
    }

    if (
      !record ||
      !awaitsDelivery(record) ||
      (record.state !== "completed" && record.state !== "dead")
    ) {
      this.#forgetDelivery(entry.queue, entry.id);
      return;
    }

    await this.#deliverSafely(entry.queue, record, settledOutcome(record));
  }

  /**
   * Finishes what a crash, a failed write or an early finish left half done
   * in this queue's flows. Three steps, each bounded and resumed across passes:
   *
   * 1. Deliveries this worker remembers as unfinished, first.
   * 2. Parents here waiting on children: a child that settled without the
   *    parent knowing is delivered again; one that does not exist, once the
   *    parent is older than the grace period, counts as failed.
   * 3. Children here that finished and were never recorded on their parent:
   *    delivered again, or released to their retention once their parent has
   *    been missing past the grace period.
   *
   * Per pass that is at most one page of {@link MAINTENANCE_BATCH} parents,
   * {@link FLOW_HEAL_LOOKUPS} child reads, and one page of finished jobs, plus
   * a delivery for each thing found in need of one.
   */
  async #healFlows(): Promise<void> {
    if (!this.driver.recordChild || !this.driver.markChildRecorded) {
      return;
    }

    for (const key of [...this.#redeliveries.keys()]) {
      if (this.#closing) {
        return;
      }
      await this.#redeliver(key);
    }

    await this.#healParents();
    await this.#healChildren();
  }

  /** Step 2 of {@link #healFlows}: parents waiting on children. */
  async #healParents(): Promise<void> {
    const cursor = this.#parentsCursor;
    const parents = await this.driver.listJobs(this.ref, ["waiting-children"], {
      offset: cursor.offset,
      limit: MAINTENANCE_BATCH,
      order: "asc",
    });

    // Past the end: the next pass starts again from the first parent.
    this.#parentsCursor =
      parents.length < MAINTENANCE_BATCH
        ? { offset: 0, child: 0 }
        : { offset: cursor.offset + parents.length, child: 0 };

    let lookups = FLOW_HEAL_LOOKUPS;

    for (const [index, parent] of parents.entries()) {
      const flow = parent.flow;
      if (!flow) {
        continue;
      }

      const from = index === 0 ? cursor.child : 0;

      for (let at = from; at < flow.children.length; at++) {
        if (this.#closing) {
          return;
        }

        const child = flow.children[at]!;
        const key = flowKey(child);
        if (
          Object.hasOwn(flow.values, key) ||
          Object.hasOwn(flow.failures, key)
        ) {
          continue;
        }

        if (lookups-- <= 0) {
          // Out of reads for this pass: resume at this very child next time.
          this.#parentsCursor = { offset: cursor.offset + index, child: at };
          return;
        }

        const buried = await this.#healChild(parent, child);
        if (buried) {
          break;
        }
      }
    }
  }

  /**
   * Looks at one unsettled child of a waiting parent, and delivers what it
   * finds. Answers whether the parent is now buried.
   */
  async #healChild(parent: JobRecord, child: JobRef): Promise<boolean> {
    const stored = await this.driver.getJob(
      { ns: this.namespace, queue: child.queue },
      child.id,
    );
    const ours =
      stored?.flow?.parent?.queue === this.queueName &&
      stored.flow.parent.id === parent.id;

    if (stored && ours) {
      if (stored.state === "completed") {
        return (
          (await this.#deliverSafely(
            child.queue,
            stored,
            settledOutcome(stored),
          )) === "buried"
        );
      }

      if (stored.state !== "dead") {
        return false;
      }

      // A failure already delivered once buried this parent, which has been
      // retried since: it waits for the child to be retried too, rather than
      // being buried again by the failure it was retried past.
      if (stored.opts.ignoreFailure !== true && stored.flow?.recorded) {
        return false;
      }

      return (
        (await this.#deliverSafely(
          child.queue,
          stored,
          settledOutcome(stored),
        )) === "buried"
      );
    }

    // Absent, or a job of the same id that is not this parent's child.
    if (Date.now() - parent.createdAt <= FLOW_MISSING_GRACE_MS) {
      return false;
    }

    const error = serializeError(
      new ChildFailedError(
        child,
        serializeError(
          new Error(
            "the child does not exist: it was never added, or was removed",
          ),
        ),
      ),
    );
    const result = await this.driver.recordChild!(
      this.ref,
      parent.id,
      child,
      { completed: false, error, ignored: false },
      Date.now(),
    );

    if (result !== "buried") {
      return false;
    }

    await this.#afterBury(this.ref, parent.id, error, { announce: true });
    return true;
  }

  /** Step 3 of {@link #healFlows}: finished children never recorded. */
  async #healChildren(): Promise<void> {
    const cursor = this.#childrenCursor;
    const page = await this.driver.listJobs(this.ref, [cursor.state], {
      offset: cursor.offset,
      limit: MAINTENANCE_BATCH,
      order: "asc",
    });

    this.#childrenCursor =
      page.length < MAINTENANCE_BATCH
        ? {
            state: cursor.state === "completed" ? "dead" : "completed",
            offset: 0,
          }
        : { state: cursor.state, offset: cursor.offset + page.length };

    for (const record of page) {
      if (this.#closing) {
        return;
      }

      if (awaitsDelivery(record)) {
        await this.#deliverSafely(
          this.queueName,
          record,
          settledOutcome(record),
        );
      }
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
            {
              retry: false,
              retention: record.flow?.parent ? false : record.opts.removeOnFail,
            },
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

    if (record.flow?.parent) {
      await this.#deliverSafely(this.queueName, record, {
        completed: false,
        error: serialized,
      });
    }

    const deadLetter = record.opts.deadLetter ?? this.#deadLetterQueue;

    if (deadLetter !== undefined) {
      await this.#fileDeadLetter(
        deadLetter,
        this.queueName,
        job,
        record,
        serialized,
        now,
      );
    }
  }

  /**
   * Adds a copy of a dead job to its dead-letter queue, through the shared
   * {@link addDeadLetter}, reporting rather than throwing.
   *
   * `source` is the queue the dead job is in: this worker's, or another's for
   * a flow parent a child here buried. `job` is the view local listeners get,
   * and is left out for a job in another queue, which they do not hear about.
   */
  async #fileDeadLetter(
    queueName: string,
    source: string,
    job: Job<TData, TResult> | undefined,
    record: JobRecord,
    error: SerializedError,
    now: number,
  ): Promise<void> {
    const refused = selfLetterError(queueName, source, record);
    if (refused) {
      this.#emitError(refused, "deadLetter");
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

      const letter = await addDeadLetter(queue, source, record, error, now);

      if (job) {
        this.safeEmitScoped(
          "deadLettered",
          record.name,
          job,
          letter as Job<DeadLetter<TData>, unknown>,
        );
      }
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

      // Disabled: this occurrence runs — it was claimed before anyone could
      // stop it — but it schedules nothing after it.
      if (await this.#repeatDisabled(definition.key)) {
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

      const jobId = shortenJobId(
        repeatJobId(displayRepeatKey(definition.key), next),
      );
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
        // A new occurrence, in no flow, whatever the finished one belonged to.
        flow: null,
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

  /**
   * Whether the series stored as `key` is disabled.
   *
   * Every claimed occurrence asks, and a busy series should not cost a read
   * per job to answer a question whose answer changes by hand, so an
   * enabled* answer is trusted for {@link REPEAT_FLAG_CACHE_MS}. A series
   * disabled in that window gets at most one more occurrence, which the next
   * maintenance pass removes.
   *
   * A *disabled* answer is never cached. Trusting it would outlive an
   * `enable()`: the occurrence `enable()` scheduled would then schedule
   * nothing after it, and the series would stop for good.
   */
  async #repeatDisabled(key: string): Promise<boolean> {
    const now = Date.now();
    const enabledAt = this.#enabledRepeats.get(key);

    if (enabledAt !== undefined && now - enabledAt < REPEAT_FLAG_CACHE_MS) {
      return false;
    }

    const disabled = await isRepeatDisabled(this.driver, this.ref, key);

    if (disabled) {
      this.#enabledRepeats.delete(key);
    } else {
      // Bounded: a queue with many series forgets the lot rather than growing.
      if (this.#enabledRepeats.size >= 1_000) {
        this.#enabledRepeats.clear();
      }
      this.#enabledRepeats.set(key, now);
    }

    return disabled;
  }

  /* --- worker inventory ------------------------------------------------------- */

  /** Writes the heartbeat record on the report interval, while the worker runs. */
  #armReports(): void {
    if (this.#reportInterval === 0 || this.#reportTimer) {
      return;
    }

    this.#reportTimer = setInterval(() => {
      void this.#report();
    }, this.#reportInterval);
    this.#reportTimer.unref?.();
  }

  /**
   * Writes this worker's heartbeat record: who it is, how busy, and until when
   * the record stands. Never throws — a failed write is reported as an error
   * and the next interval writes again.
   *
   * Writes are chained rather than overlapping, and nothing is written once
   * the worker has begun closing.
   */
  async #report(): Promise<void> {
    if (
      !this.#running ||
      this.#closing ||
      this.#reportInterval === 0 ||
      !supportsWorkers(this.driver)
    ) {
      return;
    }

    this.#reported = true;
    const previous = this.#reporting;
    const write = (async () => {
      await previous;

      if (this.#closing) {
        return;
      }

      const now = Date.now();

      try {
        await registerWorkerRecord(this.driver, this.ref, {
          id: this.id,
          queue: this.queueName,
          host: HOST,
          pid: process.pid,
          concurrency: this.#concurrency,
          active: this.#active.size,
          paused: this.#paused,
          startedAt: this.#startedAt,
          heartbeatAt: now,
          expiresAt: now + this.#reportInterval * REPORT_LIFETIMES,
        });
      } catch (error) {
        this.#emitError(error, "report");
      }
    })();

    this.#reporting = write;
    await write;

    if (this.#reporting === write) {
      this.#reporting = undefined;
    }
  }

  /**
   * Removes the heartbeat record once the worker is closing, after any write
   * still in flight, so a closed worker stops being listed straight away.
   */
  async #unregister(): Promise<void> {
    if (
      !this.#reported ||
      this.#reportInterval === 0 ||
      !supportsWorkers(this.driver)
    ) {
      return;
    }

    await this.#reporting;

    try {
      await removeWorkerRecord(this.driver, this.ref, this.id);
    } catch (error) {
      this.#emitError(error, "report");
    }
  }

  /**
   * Writes the throughput counts the driver has gathered in memory, when it
   * gathers any. Awaited on close whether or not this worker owns the driver:
   * a process sharing one driver across its workers may exit without closing
   * it, and the last second of counts would go with the process.
   */
  async #flushThroughput(): Promise<void> {
    try {
      await this.driver.flushThroughput?.();
    } catch (error) {
      this.#emitError(error, "throughput");
    }
  }

  /* --- maintenance ------------------------------------------------------------ */

  /** Arms the background sweeps this worker contributes to. */
  #armMaintenance(): void {
    if (!this.#options.maintenance) {
      return;
    }

    this.#maintenanceArmed = true;

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

      await this.#healFlows();
    });

    this.#armPromotion();

    this.#every(60_000, async () => {
      await this.driver.pruneExpired(this.ref, Date.now(), MAINTENANCE_BATCH);
      await this.#healRepeats();
      await this.#sweepWindows();
    });
  }

  /**
   * Arms — or re-arms, replacing the timer it armed before — the sweep that
   * promotes delayed jobs, at the cadence the poll interval implies.
   *
   * Only once `run()` has armed maintenance, and not while closing. `#running`
   * alone is not enough: it is set before `run()` connects, so a setter called
   * during a connect that then fails would leave a timer calling the driver
   * for a worker that never started. And a closing worker must not gain a
   * timer `close()` has already cleared.
   */
  #armPromotion(): void {
    if (!this.#maintenanceArmed || !this.#running || this.#closing) {
      return;
    }

    if (this.#promotionTimer) {
      clearInterval(this.#promotionTimer);
      this.#timers.delete(this.#promotionTimer);
    }

    this.#promotionTimer = this.#every(
      promotionCadence(this.#options.pollInterval),
      async () => {
        const promoted = await this.driver.promoteDelayed(
          this.ref,
          Date.now(),
          MAINTENANCE_BATCH,
        );
        if (promoted > 0) {
          this.#wake.abort();
        }
      },
    );
  }

  /** The promotion sweep's timer, so a changed poll interval can replace it. */
  #promotionTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Whether `run()` has armed maintenance — set only after it connected — so
   * a changed poll interval re-arms the promotion sweep only on a worker that
   * actually got that far.
   */
  #maintenanceArmed = false;

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
  #every(
    ms: number,
    work: () => Promise<void>,
  ): ReturnType<typeof setInterval> {
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

    return timer;
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

      // Read fresh, never cached: this is the pass that repairs what a stale
      // answer let through. A disabled series keeps no pending occurrence —
      // one a worker scheduled just as it was disabled is removed here — and
      // gets no replacement for one that has gone.
      if (await isRepeatDisabled(this.driver, this.ref, definition.key)) {
        await removePendingOccurrence(this.driver, this.ref, definition);
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

      const record = occurrenceRecord(definition, next, now);
      await this.driver.addJob(this.ref, record);

      await this.driver.upsertRepeat(this.ref, {
        ...definition,
        nextRunAt: next,
        nextJobId: record.id,
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
