import type { DriverConfig, JobsDriver } from "./drivers/index";
import type {
  BunQueueOptions,
  BunQueueWorkerOptions,
  JobOptions,
  JobProcessor,
} from "./queue/index";
import type { BunRunner, BunRunnerOptions } from "./runner/index";
import type { Logger, LoggerLike } from "./shared/logger";
import { resolveDriver } from "./drivers/index";
import { BunQueue, BunQueueWorker } from "./queue/index";
import { BunRunnerManager } from "./runner/index";
import { ConfigError } from "./shared/errors";
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
    });

    this.#workers.add(worker);
    return worker;
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
