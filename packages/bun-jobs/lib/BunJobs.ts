import type {
  DriverConfig,
  JobsDriver,
  MetricsOptions,
  WorkerInfo,
} from "./drivers/index";
import type { JobsNotifierOptions } from "./notifier";
import type { BackoffStrategy } from "./queue/backoff";
import type { JobDefinition, JobDefinitionOptions } from "./queue/definitions";
import type {
  BunQueueOptions,
  BunQueueWorkerOptions,
  Job,
  JobAddArgs,
  JobDataOf,
  JobMap,
  JobMapData,
  JobMapOf,
  JobMapResult,
  JobName,
  JobOptions,
  JobProcessor,
  JobResultOf,
  QueueSummary,
  RegistryQueue,
  TypedJob,
  TypedJobName,
  TypedJobProcessor,
  UntypedJobName,
  WhenDeclared,
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
import { addDefinedJob, splitDefinitionDefaults } from "./queue/BunQueue";
import { MAX_TIMER_MS } from "./queue/BunQueueWorker";
import { JobDefinitions } from "./queue/definitions";
import { BunQueue, BunQueueWorker, RemoteWorkerManager } from "./queue/index";
import { JobBuilder } from "./queue/JobBuilder";
import { JobDraft } from "./queue/JobDraft";
import { BunRunnerManager } from "./runner/index";
import { mapConcurrent } from "./shared/bounded";
import { ConfigError, NotSupportedError } from "./shared/errors";
import { assertDateParser, parseDuration } from "./shared/humanTime";
import { assertNamespace, assertSegment } from "./shared/keys";
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
  /**
   * What this service is called, in the worker inventory and in every
   * worker's stable key (`[service.]queue[.name|.ordinal]`).
   *
   * Worth setting whenever more than one service shares a backend and a
   * namespace, because an override written against `mail` would otherwise
   * apply to whichever of them consumes a queue of that name. Unset by
   * default, which drops the prefix.
   */
  service?: string;
  /**
   * Whether the workers this context creates obey instructions written by
   * another process — pause, resume, stop, start and configuration
   * overrides.
   *
   * `true` by default here, unlike a `BunQueueWorker` built directly: a
   * context's workers are the ones a management API lists, and a worker that
   * could be listed but not controlled is the more surprising default. It
   * costs one subscription per worker where the driver pushes events, and
   * where it does not (poll mode), two reads per worker every
   * `remoteControl.interval` — 2 s by default, and never longer than the
   * worker's `reportInterval`. Either way each heartbeat re-reads them too.
   */
  workerRemoteControl?: boolean;
  /**
   * What is recorded into the analytics buckets — per-second and per-minute
   * series of every queue's jobs, each runner's runs and durations, and each
   * worker's jobs and busyness. Everything is on by default, at per-second
   * resolution with five minutes of per-second retention (`secondRetentionMs`,
   * at most fifteen).
   *
   * Handed to the driver this context builds from a config (a config naming
   * its own `metrics` wins) and merged under every runner and worker created
   * here, whose own `metrics` wins. `workers`, `runners` and `durations` also
   * govern those runners and workers on a driver instance passed in;
   * `resolution` and `secondRetentionMs` belong to whoever built the instance.
   *
   * **`{ workers: false }` is the first lever for a large fleet**: per-worker
   * series are the term that grows with the number of workers.
   */
  metrics?: MetricsOptions;
}

/**
 * The `registryQueue` option, tied to the queue name a typed context
 * declared as its second type argument.
 *
 * - No map declared: any string, as it has always been.
 * - A map declared, with the default name: optional, and only `"jobs"`.
 * - A map declared with another name — `BunJobs<Jobs, "work">` — required,
 *   and exactly that name. The type says which queue carries the registry,
 *   and a runtime default of `"jobs"` under a type claiming `"work"` would
 *   make every `jobs.queue("work")` a lie.
 *
 * @typeParam TJobs The declared job map, or the default `JobMap` for none.
 * @typeParam TRegistryQueue The registry queue's name, as declared.
 */
export type RegistryQueueOption<
  TJobs,
  TRegistryQueue extends string,
> = string extends keyof TJobs
  ? {
      /** See {@link BunJobsOptions.registryQueue}. */
      registryQueue?: string;
    }
  : [TRegistryQueue] extends ["jobs"]
    ? {
        /**
         * See {@link BunJobsOptions.registryQueue}. Only `"jobs"`, the
         * default: to name another, declare it — `BunJobs<Jobs, "work">`.
         */
        registryQueue?: "jobs";
      }
    : {
        /**
         * See {@link BunJobsOptions.registryQueue}. Required, and exactly the
         * name the context declared as its second type argument.
         */
        registryQueue: TRegistryQueue;
      };

/**
 * What a {@link BunJobs} constructor takes: {@link BunJobsOptions}, with
 * `registryQueue` tied to the declared name (see {@link RegistryQueueOption}).
 *
 * @typeParam TJobs The declared job map, or the default `JobMap` for none.
 * @typeParam TRegistryQueue The registry queue's name, as declared.
 */
export type BunJobsConfig<TJobs, TRegistryQueue extends string> = Omit<
  BunJobsOptions,
  "registryQueue"
> &
  RegistryQueueOption<TJobs, TRegistryQueue>;

/**
 * A job definition as a typed context reports it: discriminated by name, with
 * the handler typed for that name.
 *
 * @typeParam TJobs The declared job map.
 */
export type TypedJobDefinition<TJobs> = {
  [TName in JobName<TJobs>]: {
    /** The declared name jobs of this kind are added under. */
    name: TName;
    /** What runs when one of them is claimed. */
    handler: TypedJobProcessor<TJobs, TName>;
    /** Merged under every job added by this name. */
    options: JobDefinitionOptions;
  };
}[JobName<TJobs>];

/**
 * What `definitions()` answers with: `JobDefinition<never, never>` with no
 * declared map, exactly as before, and a {@link TypedJobDefinition} with one.
 *
 * @typeParam TJobs The declared job map, or the default `JobMap` for none.
 */
export type JobDefinitionOf<TJobs> = string extends keyof TJobs
  ? JobDefinition<never, never>
  : TypedJobDefinition<TJobs>;

/**
 * The worker `start()` returns: typed over the declared map — its listeners
 * hear `TypedJob`s — or `BunQueueWorker<unknown, unknown>` with no map.
 *
 * @typeParam TJobs The declared job map, or the default `JobMap` for none.
 */
export type RegistryWorker<TJobs extends JobMapOf<TJobs>> = BunQueueWorker<
  JobMapData<TJobs>,
  JobMapResult<TJobs>,
  TJobs
>;

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
 *
 * **Typed jobs.** Declare the service's job names and payloads as a
 * {@link JobMap} and the registry verbs check them at compile time:
 *
 * ```ts
 * interface Jobs {
 *   "send-report": { data: { month: string }; result: string };
 *   "reindex": { data: void };
 * }
 *
 * const jobs = new BunJobs<Jobs>({ namespace: "reports", driver });
 *
 * jobs.define("send-report", async (job) => render(job.data.month)); // job.data is typed
 * await jobs.now("send-report", { month: "2026-08" });               // and so is this
 * ```
 *
 * Without the type argument nothing changes: every name is accepted, and
 * `TData` still comes from an explicit type argument or from the payload
 * passed in. Runtime behaviour is identical either way — an undefined name is
 * a `ConfigError` whether or not the map would also have caught it.
 *
 * @typeParam TJobs The service's job map; the default, `JobMap`, declares
 * none and leaves every signature as it was.
 * @typeParam TRegistryQueue The name of the queue the defined jobs go on,
 * `"jobs"` by default. Only a queue by this name is typed by the map, and the
 * `registryQueue` option must say the same name — declare it here and pass it
 * there: `new BunJobs<Jobs, "work">({ registryQueue: "work", ... })`.
 */
export class BunJobs<
  TJobs extends JobMapOf<TJobs> = JobMap,
  TRegistryQueue extends string = "jobs",
> {
  /** The namespace everything here belongs to. */
  readonly namespace: string;
  /** What this service is called, when it was named. */
  readonly service: string | undefined;
  /** The backend everything here shares. */
  readonly driver: JobsDriver;
  /** Runners created here, registered so they can be started and stopped together. */
  readonly runners: BunRunnerManager;
  /**
   * The workers of this namespace, and the controller for each queue's —
   * `jobs.workers.remote("mail")` pauses, stops, starts and reconfigures
   * workers wherever they run.
   */
  readonly workers: RemoteWorkerManager;

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
  /** The `metrics` option, merged under every runner's and worker's own. */
  readonly #metrics: MetricsOptions | undefined;
  /** Whether workers created here obey instructions from other processes. */
  readonly #workerRemoteControl: boolean;
  /**
   * How many workers have been created here for each queue, so the second one
   * on a queue gets an ordinal in its stable key and the first keeps the
   * plain `[service.]queue`.
   */
  readonly #workerOrdinals = new Map<string, number>();
  /** Notifiers opened here, closed with the context. */
  readonly #notifiers = new Set<JobsNotifier>();
  /** The worker running defined jobs, once `start()` has been called. */
  #registryWorker: RegistryWorker<TJobs> | undefined;
  /**
   * How often the registry looks for due work, in milliseconds, once
   * `processEvery()` has been called. Unset, the worker keeps its own defaults.
   */
  #processEvery: number | undefined;

  // `NoInfer`: the type arguments are what the caller declared, never guessed
  // from the options — or an untyped context's type would change with the
  // queue name it was given, and a typed one could have its name inferred
  // past the check below.
  constructor(options: BunJobsConfig<NoInfer<TJobs>, NoInfer<TRegistryQueue>>) {
    this.namespace = assertNamespace(options.namespace);

    const { driver, owned } = resolveDriver(options.driver, options.metrics);
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
    this.#metrics = options.metrics;
    this.service =
      options.service === undefined
        ? undefined
        : assertSegment(options.service, "service");
    this.#workerRemoteControl = options.workerRemoteControl ?? true;
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

    this.workers = new RemoteWorkerManager({
      namespace: this.namespace,
      driver: this.driver,
      locals: () => this.#workers,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });

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
   * How often the registry worker looks for due work, in milliseconds —
   * `undefined` when it was never set, which leaves the worker its own
   * defaults.
   *
   * Readable before `start()`: the `processEvery` option and the
   * `processEvery()` method both normalise a duration to milliseconds the
   * moment they are given one, so this is what the worker will be started
   * with. It reports what was *asked for*, not what a running worker
   * currently uses — `start()`'s own `pollInterval`/`maxBlock` options win
   * over it, and a later `processEvery()` wins over those.
   */
  get processEveryMs(): number | undefined {
    return this.#processEvery;
  }

  /**
   * Whether the queues, workers and runners created here publish their events
   * for other processes: the resolved `publishEvents` option, so `false` when
   * it was not given. A `publish` option passed to one of them still wins for
   * that one, and is not reflected here.
   *
   * What the management API reports as `publishing` on `GET /meta`, and what
   * decides whether it warns that its live events will be empty.
   */
  get publishesEvents(): boolean {
    return this.#publishEvents;
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
      ...this.#mergeMetrics(this.#runnerDefaults?.metrics, options.metrics),
      logger: options.logger ?? this.#loggerOption,
    } as Omit<BunRunnerOptions<TArgs>, "namespace"> & { namespace?: string });
  }

  /**
   * The queue by that name in this namespace. Calling it twice returns the
   * same instance, so listeners attached to it are not silently orphaned.
   *
   * On a context that declared a {@link JobMap}, the registry queue — the
   * one named by `TRegistryQueue`, `"jobs"` unless declared otherwise —
   * answers with the registry's queue type: `add` takes a declared name and
   * that name's payload, and reads are discriminated by name. That is the
   * queue every defined job is added to, so that vocabulary is what it
   * carries.
   *
   * Every other name answers with a plain queue, as on a context with no map:
   * `jobs.queue<Payload>("mail")` names its types. A name only known at
   * runtime, a plain `string`, is not the registry's either — it could be
   * anything.
   */
  queue(
    name: WhenDeclared<TJobs, TRegistryQueue>,
    options?: Omit<BunQueueOptions, "namespace" | "driver">,
  ): RegistryQueue<TJobs>;
  /**
   * A queue whose contents this context's registry does not describe, or any
   * queue at all when no {@link JobMap} was declared.
   *
   * Given explicit type arguments this is also the signature the registry
   * queue's own name reaches — `jobs.queue<unknown>("jobs")` is the untyped
   * view of the same instance, for code that reads what the map does not
   * describe.
   */
  queue<TData = unknown, TResult = unknown, TName extends string = string>(
    name: string,
    options?: Omit<BunQueueOptions, "namespace" | "driver">,
  ): BunQueue<TData, TResult, TName>;
  // `any` is the implementation-signature widening the two overloads above
  // hide; `#queues` has held queues of mixed types all along.
  queue(
    name: string,
    options?: Omit<BunQueueOptions, "namespace" | "driver">,
  ): BunQueue<any, any, any, any> {
    const existing = this.#queues.get(name);
    if (existing) {
      return existing;
    }

    const queue = new BunQueue(name, {
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

  /**
   * The context's `metrics` option with the more specific ones over it, field
   * by field — so a context's `{ workers: false }` is not undone by a worker
   * that only asked for `resolution: "minute"`. Empty when nobody set any, so
   * the option is left out rather than passed as `undefined`.
   */
  #mergeMetrics(...specific: (MetricsOptions | undefined)[]): {
    metrics?: MetricsOptions;
  } {
    const layers = [this.#metrics, ...specific].filter(
      (layer): layer is MetricsOptions => layer !== undefined,
    );

    if (layers.length === 0) {
      return {};
    }

    // A field given as `undefined` is not an answer, so it does not hide the
    // layer below it.
    const merged: Record<string, unknown> = {};
    for (const layer of layers) {
      for (const [field, value] of Object.entries(layer)) {
        if (value !== undefined) {
          merged[field] = value;
        }
      }
    }

    return { metrics: merged as MetricsOptions };
  }

  /** Creates a worker consuming a queue in this namespace. */
  worker<TData = unknown, TResult = unknown>(
    name: string,
    processor: JobProcessor<TData, TResult> | string | URL,
    options?: Omit<BunQueueWorkerOptions, "namespace" | "driver">,
  ): BunQueueWorker<TData, TResult> {
    const ordinal = (this.#workerOrdinals.get(name) ?? 0) + 1;
    this.#workerOrdinals.set(name, ordinal);

    const worker = new BunQueueWorker<TData, TResult>(name, processor, {
      ...(this.#publishEvents ? { publish: true } : {}),
      publishGate: this.#publishGate,
      ...(this.service === undefined ? {} : { service: this.service }),
      keyOrdinal: ordinal,
      remoteControl: this.#workerRemoteControl,
      ...options,
      ...this.#mergeMetrics(options?.metrics),
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
  define<TName extends TypedJobName<TJobs>>(
    name: TName,
    handler: TypedJobProcessor<TJobs, TName>,
    options?: JobDefinitionOptions,
  ): this;
  /**
   * Defines a job on a context with no declared {@link JobMap} — the signature
   * this method has always had, with `TData`/`TResult` from explicit type
   * arguments or inferred from the handler.
   */
  define<TData = unknown, TResult = unknown>(
    name: UntypedJobName<TJobs>,
    handler: JobProcessor<TData, TResult>,
    options?: JobDefinitionOptions,
  ): this;
  // Implementation-signature widening; callers only ever see the two above.
  define(
    name: string,
    handler: JobProcessor<any, any>,
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

    this.#definitions.set({ name, handler, options });
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

  /**
   * Every job name defined here, with how to run it. On a typed context each
   * one is discriminated by name, so checking `name` types its handler.
   */
  definitions(): JobDefinitionOf<TJobs>[] {
    // The same objects `define` stored; only the declared map can say which
    // handler type goes with which name, and it is the map that is asked.
    return this.#definitions.all() as JobDefinitionOf<TJobs>[];
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
  schedule<TName extends TypedJobName<TJobs>>(
    name: TName,
    data?: JobDataOf<TJobs, TName>,
  ): JobBuilder<
    JobDataOf<TJobs, TName>,
    JobResultOf<TJobs, TName>,
    TypedJob<TJobs, TName>
  >;
  /**
   * Describes a job on a context with no declared {@link JobMap} — the
   * signature this method has always had.
   */
  schedule<TData = unknown, TResult = unknown>(
    name: UntypedJobName<TJobs>,
    data?: TData,
  ): JobBuilder<TData, TResult>;
  // Implementation-signature widening; callers only ever see the two above.
  schedule(name: string, data?: unknown): JobBuilder<any, any> {
    return this.#schedule(name, data);
  }

  /**
   * The body behind `schedule`, `run` and `process`.
   *
   * Separate because those three are overloaded, and an overloaded method
   * cannot be called from inside the class with a plain `string`: neither
   * overload's name parameter is resolved while `TJobs` is still a type
   * parameter. Every internal caller goes through here instead.
   */
  #schedule(name: string, data?: unknown): JobBuilder<unknown, unknown> {
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

    return new JobBuilder<unknown, unknown>(
      this.queue<unknown, unknown>(this.#registryQueue),
      name,
      data,
      defaults,
    );
  }

  /** {@link BunJobs.schedule}, for a sentence that reads better as "run". */
  run<TName extends TypedJobName<TJobs>>(
    name: TName,
    data?: JobDataOf<TJobs, TName>,
  ): JobBuilder<
    JobDataOf<TJobs, TName>,
    JobResultOf<TJobs, TName>,
    TypedJob<TJobs, TName>
  >;
  /** {@link BunJobs.schedule}, on a context with no declared {@link JobMap}. */
  run<TData = unknown, TResult = unknown>(
    name: UntypedJobName<TJobs>,
    data?: TData,
  ): JobBuilder<TData, TResult>;
  // Implementation-signature widening; callers only ever see the two above.
  run(name: string, data?: unknown): JobBuilder<any, any> {
    return this.#schedule(name, data);
  }

  /** {@link BunJobs.schedule}, for a sentence that reads better as "process". */
  process<TName extends TypedJobName<TJobs>>(
    name: TName,
    data?: JobDataOf<TJobs, TName>,
  ): JobBuilder<
    JobDataOf<TJobs, TName>,
    JobResultOf<TJobs, TName>,
    TypedJob<TJobs, TName>
  >;
  /** {@link BunJobs.schedule}, on a context with no declared {@link JobMap}. */
  process<TData = unknown, TResult = unknown>(
    name: UntypedJobName<TJobs>,
    data?: TData,
  ): JobBuilder<TData, TResult>;
  // Implementation-signature widening; callers only ever see the two above.
  process(name: string, data?: unknown): JobBuilder<any, any> {
    return this.#schedule(name, data);
  }

  /**
   * Adds a job to run as soon as something claims it.
   *
   * The one case short enough not to need a sentence:
   * `jobs.run(name, data).start()` says the same thing in more words.
   */
  now<TName extends TypedJobName<TJobs>>(
    name: TName,
    ...args: JobAddArgs<JobDataOf<TJobs, TName>>
  ): Promise<TypedJob<TJobs, TName>>;
  /**
   * Adds a job on a context with no declared {@link JobMap} — the signature
   * this method has always had.
   */
  now<TData = unknown>(
    name: UntypedJobName<TJobs>,
    data?: TData,
    options?: JobOptions,
  ): Promise<Job<TData>>;
  // Implementation-signature widening; callers only ever see the two above.
  // A plain rest, because the checked overload's arguments are a tuple
  // TypeScript cannot relate to fixed parameters while it is generic.
  async now(name: string, ...args: unknown[]): Promise<Job<any, any>> {
    const [data, options] = args as [unknown, JobOptions | undefined];
    const builder = this.#schedule(name, data);
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
  create<TName extends TypedJobName<TJobs>>(
    name: TName,
    data?: JobDataOf<TJobs, TName>,
  ): JobDraft<
    JobDataOf<TJobs, TName>,
    JobResultOf<TJobs, TName>,
    TypedJob<TJobs, TName>
  >;
  /**
   * Makes a draft on a context with no declared {@link JobMap} — the signature
   * this method has always had.
   */
  create<TData = unknown, TResult = unknown>(
    name: UntypedJobName<TJobs>,
    data?: TData,
  ): JobDraft<TData, TResult>;
  // Implementation-signature widening; callers only ever see the two above.
  create(name: string, data?: unknown): JobDraft<any, any> {
    return new JobDraft(this.#schedule(name, data), name);
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
  ): Promise<RegistryWorker<TJobs>> {
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

    // The worker's listeners hear the map's types; the processor above, which
    // dispatches every name, is the untyped side of the same object.
    const registryWorker = worker as unknown as RegistryWorker<TJobs>;
    this.#registryWorker = registryWorker;
    void worker.run();
    return registryWorker;
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

    const queue = this.queue<unknown, unknown>(this.#registryQueue);
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
    return await this.queue<unknown, unknown>(this.#registryQueue).drain(
      options,
    );
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
    // Its editable options go as their own layer, under the queue's stored
    // job defaults, so they are not recorded as explicit (see `addDefinedJob`).
    const { concurrency: _concurrency, ...defaults } = definition.options;
    const { definition: layer, rest } = splitDefinitionDefaults(defaults);

    return await addDefinedJob(
      this.queue<TData>(this.#registryQueue),
      name,
      data as TData,
      { ...rest, ...options },
      layer,
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
   * queue elsewhere; each queue's pause flag is one read, at most
   * `FAN_OUT_LIMIT` at a time — not one per queue all at once, on the pool
   * the workers claim through.
   */
  async getQueueSummaries(): Promise<QueueSummary[]> {
    await this.driver.connect();
    const counts = await countQueues(this.driver, this.namespace);

    return await mapConcurrent([...counts], async ([name, byState]) => ({
      name,
      counts: byState,
      total: Object.values(byState).reduce((sum, count) => sum + count, 0),
      paused: await this.driver.isQueuePaused({
        ns: this.namespace,
        queue: name,
      }),
    }));
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
    // Concurrently but bounded: one read per queue in series made a
    // dashboard's worker list cost the sum of every queue's round trip.
    const perQueue = await mapConcurrent(queues, async (queue) => {
      const ref = { ns: this.namespace, queue };
      return await listWorkerRecords(this.driver, ref, now);
    });

    return perQueue.flat();
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
export function jobsFromContext<
  TJobs extends JobMapOf<TJobs> = JobMap,
  TRegistryQueue extends string = "jobs",
>(
  context: {
    /** The namespace the run belongs to. */
    namespace: string;
    /** The config a child can build a driver from. */
    driverConfig?: DriverConfig;
    /** The runner's own driver, in `in-process` mode. */
    driver?: JobsDriver;
  },
  ...args: ContextOptionsArgs<TJobs, TRegistryQueue>
): BunJobs<TJobs, TRegistryQueue> {
  const [options] = args;
  const driver = context.driver ?? context.driverConfig;

  if (!driver) {
    throw new ConfigError(
      "This run has no backend: set `driver` (in-process) or `childDriver` on the runner so its handler can reach one",
      { namespace: context.namespace },
    );
  }

  // The options were checked against the declared name at the call; the
  // conditional that did it cannot be resolved here, while it is generic.
  return new BunJobs<TJobs, TRegistryQueue>({
    ...options,
    namespace: context.namespace,
    driver,
  } as BunJobsConfig<TJobs, TRegistryQueue>);
}

/**
 * The options argument of {@link jobsFromContext}: optional, unless the
 * context declared a registry queue other than `"jobs"`, whose name the
 * options then have to carry — see {@link RegistryQueueOption}.
 *
 * @typeParam TJobs The declared job map, or the default `JobMap` for none.
 * @typeParam TRegistryQueue The registry queue's name, as declared.
 */
type ContextOptionsArgs<
  TJobs,
  TRegistryQueue extends string,
> = string extends keyof TJobs
  ? [
      options?: Omit<
        BunJobsConfig<TJobs, TRegistryQueue>,
        "namespace" | "driver"
      >,
    ]
  : [TRegistryQueue] extends ["jobs"]
    ? [
        options?: Omit<
          BunJobsConfig<TJobs, TRegistryQueue>,
          "namespace" | "driver"
        >,
      ]
    : [
        options: Omit<
          BunJobsConfig<TJobs, TRegistryQueue>,
          "namespace" | "driver"
        >,
      ];

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
