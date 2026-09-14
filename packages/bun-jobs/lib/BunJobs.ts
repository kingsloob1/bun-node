import type { DriverConfig, JobsDriver } from "./drivers/index";
import type { BackoffStrategy } from "./queue/backoff";
import type { JobDefinition, JobDefinitionOptions } from "./queue/definitions";
import type {
  BunQueueOptions,
  BunQueueWorkerOptions,
  Job,
  JobOptions,
  JobProcessor,
} from "./queue/index";
import type { BunRunner, BunRunnerOptions } from "./runner/index";
import type { DateParser } from "./shared/humanTime";
import type { Logger, LoggerLike } from "./shared/logger";
import { resolveDriver } from "./drivers/index";
import { BackoffStrategies } from "./queue/backoff";
import { JobDefinitions } from "./queue/definitions";
import { BunQueue, BunQueueWorker } from "./queue/index";
import { JobBuilder } from "./queue/JobBuilder";
import { BunRunnerManager } from "./runner/index";
import { ConfigError } from "./shared/errors";
import { assertDateParser } from "./shared/humanTime";
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
  /** The worker running defined jobs, once `start()` has been called. */
  #registryWorker: BunQueueWorker<any, any> | undefined;

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
    return this.runners.add<TArgs, TResult>({
      ...this.#runnerDefaults,
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
      ...options,
      namespace: this.namespace,
      driver: this.driver,
      logger: options?.logger ?? this.#loggerOption,
      defaultJobOptions: options?.defaultJobOptions ?? this.#defaultJobOptions,
      dateParser: options?.dateParser ?? this.#dateParser,
    });

    this.#queues.set(name, queue);
    return queue;
  }

  /** Creates a worker consuming a queue in this namespace. */
  worker<TData = unknown, TResult = unknown>(
    name: string,
    processor: JobProcessor<TData, TResult>,
    options?: Omit<BunQueueWorkerOptions, "namespace" | "driver">,
  ): BunQueueWorker<TData, TResult> {
    const worker = new BunQueueWorker<TData, TResult>(name, processor, {
      ...options,
      namespace: this.namespace,
      driver: this.driver,
      logger: options?.logger ?? this.#loggerOption,
      backoffStrategies: options?.backoffStrategies ?? this.#backoffs,
    });

    this.#workers.add(worker);
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

  /** The body of {@link BunJobs.close}, under its hold on the process. */
  async #close(options?: { timeout?: number }): Promise<void> {
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
