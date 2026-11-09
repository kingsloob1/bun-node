import type { BunQueueWorker } from "@kingsleyweb/bun-jobs";
import { ConfigError } from "@kingsleyweb/bun-common";

/** What {@link BunJobsLifecycle} starts and stops: one context's workers. */
export interface StartableWorkers {
  /** The context's `name`; `undefined` for the default context. */
  readonly context: string | undefined;
  /** The context's namespace. */
  readonly namespace: string;
  /** Starts every worker not running; see {@link BunJobsLifecycle.start}. */
  start: () => Promise<void>;
  /** Parks every running worker; see {@link BunJobsLifecycle.stop}. */
  stop: () => Promise<void>;
  /**
   * Starts only the workers on these queues, or every worker when none are named. Series
   * and runners stay as they are. What `./jobs/testing` runs a queue with.
   */
  startWorkers: (queues?: readonly string[]) => Promise<StartedWorkers>;
  /**
   * How each worker stands, for `./jobs/terminus`. Nothing, once the application is closing,
   * when a worker on its way down is what should be happening.
   */
  workerStates: () => WorkerStanding[];
}

/** How one worker stands: what {@link StartableWorkers.workerStates} answers. */
export interface WorkerStanding {
  /** The queue it serves. */
  queue: string;
  /**
   * `running` covers paused, and one never started. `parked` is `worker.stop()`, from
   * `BunJobsLifecycle` or remote control: on purpose, and it can start again. `ended` is a
   * `run()` that has finished while the application has not: its connection failed, say, or
   * something closed it. Nothing brings that worker back.
   */
  standing: "running" | "parked" | "ended";
}

/** What {@link StartableWorkers.startWorkers} found. */
export interface StartedWorkers {
  /** The queues a worker here serves, of those asked for. */
  started: string[];
  /** The queues asked for that no worker here serves. */
  missing: string[];
}

/**
 * What `@InjectWorker()` injects: a handle on the worker serving a queue. The
 * worker is built at bootstrap, after injection, so this is what a constructor
 * can hold.
 *
 * @typeParam TData The worker's `job.data`.
 * @typeParam TResult What its jobs answer with.
 */
export class WorkerRef<TData = unknown, TResult = unknown> {
  constructor(
    /** The queue it serves. */
    readonly queue: string,
    /** Finds the worker. Not for callers: Nest provides this class. */
    private readonly find: () => BunQueueWorker<any, any, any> | undefined,
  ) {}

  /**
   * The `BunQueueWorker` serving the queue, for `pause()`, `concurrency` and
   * the rest of its surface.
   *
   * @throws ConfigError before `onApplicationBootstrap`, when no worker exists
   * yet, and when no processor in this process consumes the queue.
   */
  get worker(): BunQueueWorker<TData, TResult> {
    const worker = this.find();
    if (worker === undefined) {
      throw new ConfigError(
        `No worker serves queue "${this.queue}" yet: workers are built at onApplicationBootstrap, by a @Processor or registerWorker in this application`,
        { queue: this.queue },
      );
    }
    return worker as BunQueueWorker<TData, TResult>;
  }
}

/**
 * Starts and stops the application's workers by hand, for
 * `BunJobsModule.forRoot({ autoStart: false })`. One per application; it acts
 * on every context, or on the one named.
 */
export class BunJobsLifecycle {
  constructor(
    /** Each context's workers. Not for callers: Nest provides this class. */
    private readonly contexts: () => Iterable<StartableWorkers>,
  ) {}

  /**
   * Starts the workers, or resumes the ones {@link stop} parked. Does nothing
   * for one already running, or once the application has closed.
   *
   * @param context The context's `name`; every context when left out.
   * @throws ConfigError before `onApplicationBootstrap`.
   */
  async start(context?: string): Promise<void> {
    await Promise.all(this.#pick(context).map((workers) => workers.start()));
  }

  /**
   * Parks the workers: they stop claiming, jobs in flight finish, and they stay
   * registered, so {@link start} can bring them back. `app.close()` is what
   * closes them for good.
   *
   * @param context The context's `name`; every context when left out.
   */
  async stop(context?: string): Promise<void> {
    await Promise.all(this.#pick(context).map((workers) => workers.stop()));
  }

  /** The contexts asked for. */
  #pick(context: string | undefined): StartableWorkers[] {
    const all = [...this.contexts()];
    return context === undefined
      ? all
      : all.filter((workers) => workers.context === context);
  }
}
