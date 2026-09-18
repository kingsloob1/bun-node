import type { DriverConfig, JobsDriver, WorkerInfo } from "./drivers/index";
import type { JobsNotifierOptions } from "./notifier";
import type { BackoffStrategy } from "./queue/backoff";
import type { JobDefinition, JobDefinitionOptions } from "./queue/definitions";
import type {
  BunQueueOptions,
  BunQueueWorkerOptions,
  Job,
  JobOptions,
  JobProcessor,
  QueueSummary,
} from "./queue/index";
import type { BunRunner, BunRunnerOptions } from "./runner/index";
import type { DateParser } from "./shared/humanTime";
import type { Logger, LoggerLike } from "./shared/logger";
import {
  countQueues,
  listWorkerRecords,
  resolveDriver,
  supportsWorkers,
} from "./drivers/index";
import { JobsNotifier } from "./notifier";
import { BackoffStrategies } from "./queue/backoff";
import { MAX_TIMER_MS } from "./queue/BunQueueWorker";
import { JobDefinitions } from "./queue/definitions";
import { BunQueue, BunQueueWorker } from "./queue/index";
import { JobBuilder } from "./queue/JobBuilder";
import { JobDraft } from "./queue/JobDraft";
import { BunRunnerManager } from "./runner/index";
import { ConfigError, NotSupportedError } from "./shared/errors";
import { assertDateParser, parseDuration } from "./shared/humanTime";
import { assertNamespace } from "./shared/keys";
import { createJobsLogger } from "./shared/logger";

/** Options for a {@link BunJobs} context. */
export interface BunJobsOptions {
  /**
   * The namespace everything derived from this context belongs to. One per
   * service: it is what keeps two services sharing a backend from colliding
   * when their runner ids or queue names happen to match.
   */
  namespace: string;
  /**
   * Where everything is stored. A config is built here and closed with the
   * context; an instance is shared and never closed by it.
   */
  driver?: JobsDriver | DriverConfig;
  /** Logger, or anything `resolveLogger` accepts. */
  logger?: LoggerLike;
  /** Defaults merged under every job added through a queue from here. */
  defaultJobOptions?: JobOptions;
  /** Options merged under every runner created here. */
  runnerDefaults?: Partial<Omit<BunRunnerOptions, "id" | "namespace" | "file">>;
  /**
   * The queue `define`/`now`/`schedule`/`every` use. Defaults to `"jobs"`.
   *
   * One queue for every defined name, dispatched by name — so a consumer runs
   * one worker rather than one per kind of job. Name it if something else in
   * the namespace already owns `jobs`.
   */
  registryQueue?: string;
  /**
   * Reads the dates in phrases for every queue created here, unless a queue is
   * given its own. Defaults to `chrono-node`. See `DateParser` for the shape.
   */
  dateParser?: DateParser;
  /**
   * Whether every queue, worker and runner created here publishes its events
   * for other processes — what a `JobsNotifier`, and a dashboard behind one,
   * listens to. Defaults to `false`, since publishing costs a write per event
   * on backends that store events. A `publish` option given to one of them
   * still wins.
   */
  publishEvents?: boolean;
  /**
   * How often the registry worker looks for due work: milliseconds, or a
   * duration such as `"5 seconds"`. Exactly `jobs.processEvery()` called
   * before `start()`, with the same validation — so it is refused here, at
   * construction, if it is not a positive interval or is longer than a timer
   * can wait. Explicit `pollInterval`/`maxBlock` given to `start()` still win,
   * and a later `processEvery()` call wins over both. Unset by default, which
   * leaves the worker's own defaults.
   */
  processEvery?: number | string;
}

/**
 * One service's jobs: a namespace and a backend, set once.
 *
 * Every runner, queue and worker needs both, and repeating them at each
 * construction site is where cross-service collisions come from — the
 * implementation this replaces had three services sharing a Redis, colliding
 * on job names, until a per-service prefix was bolted on by hand. Here the
 * namespace is structural: derive everything from one context and it cannot
 * be forgotten.
 *
 * ```ts
 * export const jobs = new BunJobs({
 *   namespace: "account",
 *   driver: { type: "redis", url: process.env.REDIS_URL! },
 * });
 *
 * const mail = jobs.queue("mail");
 * const cleanup = jobs.runner({ id: "cleanup", file: "./jobs/cleanup.ts" });
 * ```
 */
export class BunJobs {
  /** The namespace everything here belongs to. */
  readonly namespace: string;
  /** The backend everything here shares. */
  readonly driver: JobsDriver;
  /** Runners created here, registered so they can be started and stopped together. */
  readonly runners: BunRunnerManager;

  /** Whether this context built the driver and must close it. */
  readonly #ownsDriver: boolean;
  /** Logger passed to everything created here. */
  readonly #logger: Logger;
  /** The logger option as given, so derived objects adapt it themselves. */
  readonly #loggerOption?: LoggerLike;
  /** Defaults merged under every job. */
  readonly #defaultJobOptions?: JobOptions;
  /** Options merged under every runner. */
  readonly #runnerDefaults?: BunJobsOptions["runnerDefaults"];
  /** The driver as a config, when one was given, for handing to children. */
  readonly #childDriver?: DriverConfig;
  /** Queues created here, by name, so `close()` can close them. */
  readonly #queues = new Map<string, BunQueue<any, any, any>>();
  /** Workers created here. */
  readonly #workers = new Set<BunQueueWorker<any, any>>();
  /** Jobs defined by name, and how to run them. */
  readonly #definitions = new JobDefinitions();
  /**
   * Backoff strategies registered with `defineBackoff`.
   *
   * Handed to every worker created here by reference, so a strategy defined
   * after a worker was built still reaches it.
   */
  readonly #backoffs = new BackoffStrategies();
  /** The queue the defined jobs are added to and consumed from. */
  readonly #registryQueue: string;
  /** Reads dates in phrases for queues created here, when one was given. */
  readonly #dateParser: DateParser | undefined;
  /** Whether what is created here publishes its events. */
  readonly #publishEvents: boolean;
  /** Notifiers opened here, closed with the context. */
  readonly #notifiers = new Set<JobsNotifier>();
  /** The worker running defined jobs, once `start()` has been called. */
  #registryWorker: BunQueueWorker<any, any> | undefined;
  /**
   * How often the registry looks for due work, in milliseconds, once
   * `processEvery()` has been called. Unset, the worker keeps its own defaults.
   */
  #processEvery: number | undefined;

  constructor(options: BunJobsOptions) {
    this.namespace = assertNamespace(options.namespace);

    const { driver, owned } = resolveDriver(options.driver);
    this.driver = driver;
    this.#ownsDriver = owned;
    this.#loggerOption = options.logger;
    this.#childDriver =
      options.driver && "type" in options.driver
        ? (options.driver as DriverConfig)
        : undefined;
    this.#defaultJobOptions = options.defaultJobOptions;
    this.#registryQueue = options.registryQueue ?? "jobs";
    this.#publishEvents = options.publishEvents ?? false;
    this.#processEvery =
      options.processEvery === undefined
        ? undefined
        : readProcessEvery(options.processEvery);
    this.#dateParser =
      options.dateParser === undefined
        ? undefined
        : assertDateParser(options.dateParser);
    this.#runnerDefaults = options.runnerDefaults;
    this.#logger = createJobsLogger(
      options.logger,
      { namespace: this.namespace },
      `jobs:${this.namespace}`,
    );

    this.runners = new BunRunnerManager({
      namespace: this.namespace,
      driver,
      logger: options.logger,
    });
  }

  /** The context's logger. */
  get logger(): Logger {
    return this.#logger;
  }

  /**
   * The driver config a child process needs to reach this backend, when the
   * context was built from one. A driver *instance* cannot cross a process
   * boundary, so a runner in `spawn` or `worker` mode can only pass this on.
   */
  get driverConfig(): DriverConfig | undefined {
    return this.#childDriver;
  }

  /**
   * Creates a runner in this namespace, registered with {@link runners} so
   * `startAll()`/`stopAll()` reach it.
   */
  runner<TArgs = unknown, TResult = unknown>(
    options: Omit<BunRunnerOptions<TArgs>, "namespace" | "driver">,
  ): BunRunner<TArgs, TResult> {
    this.#followInNotifiers("runner", options.id);
    return this.runners.add<TArgs, TResult>({
      ...this.#runnerDefaults,
      ...(this.#publishEvents ? { publish: true } : {}),
      publishGate: this.#publishGate,
      // Children get the config, since an instance cannot be serialised.
      ...(this.#childDriver ? { childDriver: this.#childDriver } : {}),
      ...options,
      logger: options.logger ?? this.#loggerOption,
    } as Omit<BunRunnerOptions<TArgs>, "namespace"> & { namespace?: string });
  }

  /**
   * The queue by that name in this namespace. Calling it twice returns the
   * same instance, so listeners attached to it are not silently orphaned.
   */
  queue<TData = unknown, TResult = unknown, TName extends string = string>(
    name: string,
    options?: Omit<BunQueueOptions, "namespace" | "driver">,
  ): BunQueue<TData, TResult, TName> {
    const existing = this.#queues.get(name);
    if (existing) {
      return existing as BunQueue<TData, TResult, TName>;
    }

    const queue = new BunQueue<TData, TResult, TName>(name, {
      ...(this.#publishEvents ? { publish: true } : {}),
      publishGate: this.#publishGate,
      ...options,
      namespace: this.namespace,
      driver: this.driver,
      logger: options?.logger ?? this.#loggerOption,
      defaultJobOptions: options?.defaultJobOptions ?? this.#defaultJobOptions,
      dateParser: options?.dateParser ?? this.#dateParser,
    });

    this.#queues.set(name, queue);
    this.#followInNotifiers("queue", name);
    return queue;
  }

  /** Creates a worker consuming a queue in this namespace. */
  worker<TData = unknown, TResult = unknown>(
    name: string,
    processor: JobProcessor<TData, TResult> | string | URL,
    options?: Omit<BunQueueWorkerOptions, "namespace" | "driver">,
  ): BunQueueWorker<TData, TResult> {
    const worker = new BunQueueWorker<TData, TResult>(name, processor, {
      ...(this.#publishEvents ? { publish: true } : {}),
      publishGate: this.#publishGate,
      ...options,
      namespace: this.namespace,
      driver: this.driver,
      logger: options?.logger ?? this.#loggerOption,
      backoffStrategies: options?.backoffStrategies ?? this.#backoffs,
    });

    this.#workers.add(worker);
    this.#followInNotifiers("queue", name);
    return worker;
  }

  /* --- defined jobs ------------------------------------------------- */

  /**
   * Records how to run jobs of one name, and what they carry by default.
   *
   * ```ts
   * jobs.define("sendEmail", async (job) => send(job.data), { attempts: 5 });
   * await jobs.now("sendEmail", { to: "ops@example.com" });
   * await jobs.start();
   * ```
   *
   * The options are merged under every job added by that name, wherever it is
   * added from. That is the point of declaring them here: `attempts: 5`
   * belongs to what the job *is* rather than to each place that enqueues one,
   * and spread across call sites is how two of them come to disagree.
   *
   * Defining a name twice replaces the first — what a caller reloading a
   * module expects, and not silent, because they called `define` again.
   */
  define<TData = unknown, TResult = unknown>(
    name: string,
    handler: JobProcessor<TData, TResult>,
    options: JobDefinitionOptions = {},
  ): this {
    if (typeof name !== "string" || name.length === 0) {
      throw new ConfigError("A job definition needs a name", { name });
    }

    if (
      options.concurrency !== undefined &&
      (!Number.isInteger(options.concurrency) || options.concurrency < 1)
    ) {
      throw new ConfigError(
        `The concurrency for "${name}" must be a whole number of at least 1`,
        { name, concurrency: options.concurrency },
      );
    }

    this.#definitions.set<TData, TResult>({ name, handler, options });
    return this;
  }

  /**
   * Registers a backoff strategy that jobs can name.
   *
   * ```ts
   * jobs.defineBackoff("slowRamp", ({ attempt }) => attempt * 30_000);
   * await jobs.now("sync", data, { attempts: 5, backoff: { type: "slowRamp" } });
   * ```
   *
   * The job stores the name; the worker that runs it calls the function. So
   * every process that consumes such jobs has to define the strategy too — one
   * that does not falls back to the default backoff and logs a warning.
   * Return `false` to stop retrying.
   */
  defineBackoff(name: string, strategy: BackoffStrategy): this {
    this.#backoffs.define(name, strategy);
    return this;
  }

  /** Every job name defined here, with how to run it. */
  definitions(): JobDefinition<never, never>[] {
    return this.#definitions.all();
  }

  /**
   * Describes a job to add, and answers with a builder.
   *
   * ```ts
   * await jobs.schedule("sendMails").every("2 days").withData(list).start();
   * await jobs.run("sendMail").in("5 minutes").withData(mail).start();
   * await jobs.process("report").on("2nd december 2026").start();
   * ```
   *
   * `schedule`, `run` and `process` are the same method under three names,
   * because which one reads better depends on the sentence and none of them
   * is worth making the caller remember. Nothing is added until `start()`.
   *
   * This replaced a positional form — `schedule(when, name, data, options)` —
   * that put the least interesting argument first and gave every variation of
   * "when" its own method with the same four parameters in a different order.
   */
  schedule<TData = unknown, TResult = unknown>(
    name: string,
    data?: TData,
  ): JobBuilder<TData, TResult> {
    const definition = this.#definitions.get(name);

    if (!definition) {
      throw new ConfigError(
        `No job is defined for "${name}"; call define() first`,
        { name, defined: this.#definitions.names() },
      );
    }

    // The definition's options sit under whatever the builder is told, so a
    // caller changing one thing does not lose the rest.
    const { concurrency: _concurrency, ...defaults } = definition.options;

    return new JobBuilder<TData, TResult>(
      this.queue<TData, TResult>(this.#registryQueue),
      name,
      data,
      defaults,
    );
  }

  /** {@link BunJobs.schedule}, for a sentence that reads better as "run". */
  run<TData = unknown, TResult = unknown>(
    name: string,
    data?: TData,
  ): JobBuilder<TData, TResult> {
    return this.schedule<TData, TResult>(name, data);
  }

  /** {@link BunJobs.schedule}, for a sentence that reads better as "process". */
  process<TData = unknown, TResult = unknown>(
    name: string,
    data?: TData,
  ): JobBuilder<TData, TResult> {
    return this.schedule<TData, TResult>(name, data);
  }

  /**
   * Adds a job to run as soon as something claims it.
   *
   * The one case short enough not to need a sentence:
   * `jobs.run(name, data).start()` says the same thing in more words.
   */
  async now<TData = unknown>(
    name: string,
    data?: TData,
    options?: JobOptions,
  ): Promise<Job<TData>> {
    const builder = this.schedule<TData>(name, data);
    return await (options ? builder.withOptions(options) : builder).start();
  }

  /**
   * Makes a job to set up and save explicitly, in Agenda's shape.
   *
   * ```ts
   * const job = jobs.create("sendEmail", { to: "ops@example.com" });
   * job.unique("welcome-7").priority(1).schedule("in 10 minutes");
   * await job.save();
   * ```
   *
   * Nothing is written until `save()`, which adds it to the registry's queue
   * with the definition's options under whatever the draft set — the same
   * precedence as `now()` and `schedule()`. A name with no definition is a
   * `ConfigError` here, as it is for them. See `JobDraft` for what saving the
   * same draft twice does.
   */
  create<TData = unknown, TResult = unknown>(
    name: string,
    data?: TData,
  ): JobDraft<TData, TResult> {
    return new JobDraft<TData, TResult>(
      this.schedule<TData, TResult>(name, data),
      name,
    );
  }

  /**
   * How often the registry looks for due work: milliseconds, or a duration
   * such as `"5 seconds"` (a leading "every" is allowed).
   *
   * ```ts
   * jobs.processEvery("30 seconds");
   * ```
   *
   * Agenda's knob, mapped onto what a worker here has. It sets the registry
   * worker's `pollInterval` — how long an idle worker waits before it looks
   * again, which also sets the delayed-job promotion sweep to the same
   * cadence up to its once-a-second cap — and, on a driver whose
   * `capabilities.blockingWait` is true (Redis, and memory, which wakes its
   * waiters directly), its `maxBlock`, since that is what bounds an idle
   * wait there. It applies to the worker `start()` already
   * started, straight away, and to every later `start()`. Unset, the worker
   * keeps its defaults.
   *
   * What it does not do, and why:
   *
   * - It does not delay a *new* job, on any driver. SQL, MongoDB and file
   *   notice one with a short poll of their own (the driver's `pollInterval`),
   *   and there the worker's current wait is cut short so the new value
   *   applies at once. Redis and memory wake the worker directly — a blocking
   *   pop, a local waiter — and there the current wait is left to finish, the
   *   new value applying from the next one: a blocking pop cannot be called
   *   off, and one abandoned mid-wait would swallow the wake a new job sends.
   *   What the value bounds is how long work that nothing announces waits: a
   *   delayed job coming due, or one another process's sweep promoted. On
   *   Redis and memory, lowering it takes effect for that work once the wait
   *   in progress ends — at most the previous value.
   * - On Redis, a single block is also capped by the driver's
   *   `maxBlockSeconds` (5 by default), so a value above that makes the
   *   worker re-check at that cap, not less often.
   * - It is at most 2,147,483,647ms (about 24.8 days), the longest a timer
   *   can wait; a longer one is a `ConfigError`.
   * - It leaves the stalled-job sweep (`stalledInterval`) and the once-a-minute
   *   housekeeping alone: those recover and prune rather than find due work,
   *   and running them at a polling cadence would multiply scans for nothing.
   *
   * Explicit `pollInterval` or `maxBlock` passed to `start()` win over an
   * earlier `processEvery()`; a later call wins over both.
   */
  processEvery(interval: number | string): this {
    const ms = readProcessEvery(interval);
    this.#processEvery = ms;

    if (this.#registryWorker) {
      this.#registryWorker.pollInterval = ms;
      if (this.driver.capabilities.blockingWait) {
        this.#registryWorker.maxBlock = ms;
      }
    }

    return this;
  }

  /**
   * Starts consuming the defined jobs.
   *
   * One worker for every name, dispatching on `job.name` — which is why the
   * definitions live in one place. Calling it twice is a no-op rather than a
   * second consumer.
   */
  async start(
    options?: Omit<
      BunQueueWorkerOptions,
      "namespace" | "driver" | "concurrency"
    > & { concurrency?: number },
  ): Promise<BunQueueWorker<unknown, unknown>> {
    if (this.#registryWorker) {
      return this.#registryWorker;
    }

    if (this.#definitions.size === 0) {
      throw new ConfigError("start() has nothing to run: define a job first", {
        namespace: this.namespace,
      });
    }

    await this.#storeDefinitionLimits();

    const worker = this.worker<unknown, unknown>(
      this.#registryQueue,
      async (job, context) => {
        const definition = this.#definitions.get(job.name);

        if (!definition) {
          // A name this process does not know. Failing is right: another
          // deployment may define it, and the job should be left for a worker
          // that does rather than quietly dropped.
          throw new ConfigError(`No job is defined for "${job.name}"`, {
            name: job.name,
            defined: this.#definitions.names(),
          });
        }

        return await definition.handler(job as never, context);
      },
      {
        // Beneath the call's own options, which were said later.
        ...(this.#processEvery === undefined
          ? {}
          : {
              pollInterval: this.#processEvery,
              ...(this.driver.capabilities.blockingWait
                ? { maxBlock: this.#processEvery }
                : {}),
            }),
        ...options,
      },
    );

    this.#registryWorker = worker;
    void worker.run();
    return worker;
  }

  /**
   * Stores each definition's `concurrency` as a per-name limit on the
   * registry's queue, so every process consuming it enforces the same cap.
   *
   * Merged into what is already stored rather than replacing it: the queue's
   * rate, its overall concurrency and every name without a definition here
   * stay exactly as they were. Nothing is written when nothing would change,
   * so a fleet of processes starting together does not rewrite the limits
   * once each.
   */
  async #storeDefinitionLimits(): Promise<void> {
    const capped = this.#definitions
      .all()
      .filter((definition) => definition.options.concurrency !== undefined);

    if (capped.length === 0) {
      return;
    }

    const queue = this.queue(this.#registryQueue);
    const current = await queue.getLimits();
    const names = { ...current?.names };
    let changed = false;

    for (const { name, options } of capped) {
      if (names[name]?.concurrency !== options.concurrency) {
        names[name] = { ...names[name], concurrency: options.concurrency };
        changed = true;
      }
    }

    if (changed) {
      await queue.setLimits({ ...current, names });
    }
  }

  /** Stops consuming defined jobs, leaving what is in flight to finish. */
  async stop(options?: { force?: boolean; timeout?: number }): Promise<void> {
    const worker = this.#registryWorker;
    this.#registryWorker = undefined;

    await worker?.close(options);
  }

  /** Removes every pending job from the registry's queue. */
  async drain(options?: { delayed?: boolean }): Promise<number> {
    return await this.queue(this.#registryQueue).drain(options);
  }

  /** Adds a job under a defined name, with that definition's defaults. */
  async #addDefined<TData>(
    name: string,
    data: TData | undefined,
    options?: JobOptions,
  ): Promise<Job<TData>> {
    const definition = this.#definitions.get(name);

    if (!definition) {
      throw new ConfigError(
        `No job is defined for "${name}"; call define() first`,
        { name, defined: this.#definitions.names() },
      );
    }

    // The definition's options underneath, the call's on top: a caller asking
    // for a delay on one job should not lose the retry policy the definition
    // gave every job of that name.
    const { concurrency: _concurrency, ...defaults } = definition.options;

    return await this.queue<TData>(this.#registryQueue).add(
      name,
      data as TData,
      {
        ...defaults,
        ...options,
      },
    );
  }

  /** Runner ids the backend knows about in this namespace. */
  async listRunners(): Promise<string[]> {
    await this.driver.connect();
    return await this.driver.listRunners(this.namespace);
  }

  /** Queue names the backend knows about in this namespace. */
  async listQueues(): Promise<string[]> {
    await this.driver.connect();
    return await this.driver.listQueues(this.namespace);
  }

  /**
   * Every queue in this namespace with its counts per state, its total and
   * whether it is paused, ordered by name — the overview a dashboard opens on.
   *
   * Here rather than on `BunQueue` because it is a question about the
   * namespace, which this context owns: a queue knows only itself. Counting
   * is one grouped query on the SQL and MongoDB drivers, and one count per
   * queue elsewhere; each queue's pause flag is one read.
   */
  async getQueueSummaries(): Promise<QueueSummary[]> {
    await this.driver.connect();
    const counts = await countQueues(this.driver, this.namespace);

    return await Promise.all(
      [...counts].map(async ([name, byState]) => ({
        name,
        counts: byState,
        total: Object.values(byState).reduce((sum, count) => sum + count, 0),
        paused: await this.driver.isQueuePaused({
          ns: this.namespace,
          queue: name,
        }),
      })),
    );
  }

  /**
   * The workers consuming any queue in this namespace, from any process,
   * ordered by queue and then as `queue.listWorkers()` orders them. Throws
   * {@link NotSupportedError} on a driver that keeps neither worker records
   * nor queue state, as `queue.listWorkers()` does.
   */
  async listWorkers(): Promise<WorkerInfo[]> {
    await this.driver.connect();

    if (!supportsWorkers(this.driver)) {
      throw new NotSupportedError(this.driver.name, "listWorkers", {
        needs: "listWorkers()",
      });
    }

    const now = Date.now();
    const queues = [...(await this.driver.listQueues(this.namespace))].sort();
    const workers: WorkerInfo[] = [];

    for (const queue of queues) {
      workers.push(
        ...(await listWorkerRecords(
          this.driver,
          { ns: this.namespace, queue },
          now,
        )),
      );
    }

    return workers;
  }

  /** Deletes everything in this namespace, and nothing outside it. */
  async purge(): Promise<void> {
    await this.driver.connect();
    await this.driver.purge(this.namespace);
  }

  /**
   * Stops the runners and workers created here and closes the queues, then
   * the driver if this context built it. A driver passed in is left open —
   * whoever created it may still be using it.
   */
  async close(options?: { timeout?: number }): Promise<void> {
    // Held until everything below has settled: the workers each hold the
    // process while they close, but the queues and the driver close after
    // them, and a caller awaiting this from a signal handler must not be cut
    // off before the driver has let go of its connection or its file.
    const hold = setInterval(() => {}, 2_147_483_647);

    try {
      await this.#close(options);
    } finally {
      clearInterval(hold);
    }
  }

  /**
   * One typed stream of every queue, worker and runner event in this
   * namespace — or the queues and runners named — including ones created after
   * it started.
   *
   * ```ts
   * const notifier = await jobs.notifier();
   * for await (const event of notifier) {
   *   if (event.kind === "queue" && event.type === "completed") {
   *     console.log(event.target, event.payload.id);
   *   }
   * }
   * ```
   *
   * Hears only what is published: set `publishEvents` here, or `publish` on
   * the queues, workers and runners concerned, in whichever processes produce
   * the events. Closed with the context.
   */
  async notifier(options?: JobsNotifierOptions): Promise<JobsNotifier> {
    const notifier = new JobsNotifier(this.driver, this.namespace, options);
    await notifier.start();
    this.#notifiers.add(notifier);

    // What this context already created, followed now rather than on the next
    // discovery pass, within whatever the notifier was asked to follow.
    const queues = new Set([
      ...this.#queues.keys(),
      ...[...this.#workers].map((worker) => worker.queueName),
    ]);
    for (const name of queues) {
      if (notifier.wants("queue", name)) {
        await notifier.follow("queue", name);
      }
    }
    for (const runner of this.runners.list()) {
      if (notifier.wants("runner", runner.id)) {
        await notifier.follow("runner", runner.id);
      }
    }

    return notifier;
  }

  /**
   * Has every notifier opened here follow a queue or runner this context just
   * created, straight away rather than on its next discovery pass — which is
   * what lets a job added the moment its queue is created still be heard.
   */
  #followInNotifiers(kind: "queue" | "runner", target: string): void {
    for (const notifier of this.#notifiers) {
      // A notifier given a list keeps exactly that list.
      if (notifier.wants(kind, target)) {
        const following = notifier
          .follow(kind, target)
          .catch(() => undefined)
          .finally(() => this.#pendingFollows.delete(following));
        this.#pendingFollows.add(following);
      }
    }
  }

  /**
   * Subscriptions {@link #followInNotifiers} has started and not finished.
   * `queue()`, `worker()` and `runner()` cannot await them — they return
   * synchronously — so what they create awaits them instead, through
   * {@link #publishGate}, before its first publish.
   */
  readonly #pendingFollows = new Set<Promise<void>>();

  /**
   * Resolves once no follow is pending. Free when none is: it returns without
   * touching the event loop, so a context with no notifier pays nothing.
   */
  readonly #publishGate = async (): Promise<void> => {
    while (this.#pendingFollows.size > 0) {
      await Promise.all(this.#pendingFollows);
    }
  };

  /** The body of {@link BunJobs.close}, under its hold on the process. */
  async #close(options?: { timeout?: number }): Promise<void> {
    await Promise.allSettled(
      [...this.#notifiers].map((notifier) => notifier.close()),
    );
    this.#notifiers.clear();

    await Promise.allSettled([
      this.runners.stopAll(options),
      ...[...this.#workers].map((worker) => worker.close(options)),
    ]);

    await Promise.allSettled(
      [...this.#queues.values()].map((queue) => queue.close()),
    );

    this.#queues.clear();
    this.#workers.clear();

    if (this.#ownsDriver) {
      await this.driver.close();
    }
  }
}

/**
 * Builds a context from what a handler was given, so a runner's handler can
 * reach the same namespace and backend in any execution mode.
 *
 * ```ts
 * export default defineHandler(async (ctx) => {
 *   await jobsFromContext(ctx).queue("mail").add("welcome", { userId: 7 });
 * });
 * ```
 *
 * In-process runs get the runner's own driver instance; spawned and worker
 * runs get the config it was configured with. A runner with neither cannot
 * hand its handler a backend, and that is a {@link ConfigError} rather than a
 * silent, private memory driver.
 */
export function jobsFromContext(
  context: {
    /** The namespace the run belongs to. */
    namespace: string;
    /** The config a child can build a driver from. */
    driverConfig?: DriverConfig;
    /** The runner's own driver, in `in-process` mode. */
    driver?: JobsDriver;
  },
  options?: Omit<BunJobsOptions, "namespace" | "driver">,
): BunJobs {
  const driver = context.driver ?? context.driverConfig;

  if (!driver) {
    throw new ConfigError(
      "This run has no backend: set `driver` (in-process) or `childDriver` on the runner so its handler can reach one",
      { namespace: context.namespace },
    );
  }

  return new BunJobs({ ...options, namespace: context.namespace, driver });
}

/**
 * Reads `processEvery()`'s argument as milliseconds: a positive number, or a
 * duration, optionally led by "every" as Agenda's examples write it.
 */
function readProcessEvery(interval: number | string): number {
  const ms =
    typeof interval === "number"
      ? interval
      : parseDuration(interval.replace(/^(?:every|each)\s+/i, ""));

  if (ms === null || !Number.isFinite(ms) || ms <= 0) {
    throw new ConfigError(
      `processEvery() could not read ${JSON.stringify(interval)} as a positive interval: give milliseconds or a duration such as "5 seconds"`,
      { interval },
    );
  }

  // A timer longer than this fires at once, so the worker would spin rather
  // than wait. Refused rather than clamped: nobody writing "30 days" means
  // "about 24.8 days".
  if (ms > MAX_TIMER_MS) {
    throw new ConfigError(
      `processEvery() cannot wait longer than ${MAX_TIMER_MS}ms (about 24.8 days), the longest a timer can be set for; got ${JSON.stringify(interval)}`,
      { interval, max: MAX_TIMER_MS },
    );
  }

  return ms;
}
