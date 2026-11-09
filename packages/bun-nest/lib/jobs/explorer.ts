import type {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  Job,
  JobProcessor,
  JobsNotifier,
  JobsNotifierOptions,
  NameLimits,
  ProcessorContext,
} from "@kingsleyweb/bun-jobs";
import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import type {
  DiscoveryService,
  ExternalContextCreator,
  ModuleRef,
} from "@nestjs/core";
import type { ScheduleMetadata } from "./decorators/schedule";
import type {
  BunJobsWorkerOptions,
  DefineJobMetadata,
  ProcessMetadata,
  ProcessorMetadata,
} from "./decorators/consumer";
import type { EventListenerMetadata } from "./decorators/events";
import type { JobsHostBinding } from "./JobsHost";
import type { StartableWorkers } from "./lifecycle";
import type { FailurePolicy } from "./pipeline";
import type { BunJobsRegistry } from "./registry";
import { ConfigError } from "@kingsleyweb/bun-common";
import { UnrecoverableJobError, validateCron } from "@kingsleyweb/bun-jobs";
import { normalizeLimits } from "@kingsleyweb/bun-jobs/lib/queue/limits";
import { resolveRepeat } from "@kingsleyweb/bun-jobs/lib/queue/repeat";
import { Logger } from "@nestjs/common";
import { ContextIdFactory, MetadataScanner } from "@nestjs/core";
import { CACHE_WRAPPED_METADATA } from "../cache/tokens";
import { processorOf } from "./decorators/consumer";
import { listenersOf } from "./decorators/events";
import { schedulesOf } from "./decorators/schedule";
import { recordHandlerName } from "./executionContext";
import { JOBS_HOST_BINDING, JobsHost } from "./JobsHost";
import {
  DEFINE_JOB_METADATA,
  NEST_ENHANCER_METADATA,
  NEST_ROUTE_ARGS_METADATA,
  PROCESS_METADATA,
} from "./metadata";
import {
  buildPipeline,
  decoratedParams,
  mapPipelineFailure,
  undecoratedParams,
} from "./pipeline";
import {
  assertNoProblems,
  bareSchemaProblem,
  differingOptions,
} from "./registry";

/** The parts of Nest's `InstanceWrapper` the explorer reads. */
interface Wrapper {
  /** The provider's token. */
  readonly token: unknown;
  /** The class, or a factory; `null` for a value. */
  readonly metatype?: unknown;
  /** A factory's dependencies; unset for a class. */
  readonly inject?: unknown;
  /** The instance, for a static tree. */
  readonly instance?: unknown;
  /** Whether the provider is transient. */
  readonly isTransient: boolean;
  /** Whether nothing in its tree is request-scoped. */
  isDependencyTreeStatic: () => boolean;
  /** The module holding it. */
  readonly host?: {
    /** The enhancer classes Nest found on its providers while scanning. */
    readonly injectables: { has: (token: unknown) => boolean };
  };
}

/** The parts of Nest's (internal) `NestContainer` the module reads. */
interface ContainerView {
  readonly applicationConfig?: {
    getGlobalGuards?: () => readonly object[];
    getGlobalRequestGuards?: () => readonly object[];
    getGlobalRequestInterceptors?: () => readonly object[];
    getGlobalRequestPipes?: () => readonly object[];
    getGlobalRequestFilters?: () => readonly object[];
  };
}

/** Whether a wrapper is a plain class provider, the only kind Nest scans for enhancers. */
function isClassProvider(wrapper: Wrapper): boolean {
  return (
    typeof wrapper.metatype === "function" &&
    (wrapper.inject === undefined || wrapper.inject === null)
  );
}

/**
 * The enhancer classes on a handler that Nest will silently not ask. Nest finds
 * a class given to `@UseGuards` and its kind by scanning `providers: [Class]`,
 * and builds it beside the provider. For a provider made by `useFactory` or
 * `useValue` it scans nothing, on Nest 11 and 12, and the job runs **without the
 * guard** (measured); a `useClass` provider likewise before 12.2. An instance given to
 * the decorator is used as it is, so it works everywhere.
 */
function droppedEnhancers(
  wrapper: Wrapper,
  target: { prototype: object },
  method: string,
): string[] {
  const handler = (target.prototype as Record<string, object>)[method]!;
  const paramPipes = Object.values(
    (Reflect.getMetadata(NEST_ROUTE_ARGS_METADATA, target, method) ??
      {}) as Record<string, { pipes?: unknown[] }>,
  ).flatMap(({ pipes }) => pipes ?? []);
  const classes = [
    ...NEST_ENHANCER_METADATA.flatMap((key) => [
      ...((Reflect.getMetadata(key, target) ?? []) as unknown[]),
      ...((Reflect.getMetadata(key, handler) ?? []) as unknown[]),
    ]),
    ...paramPipes,
  ].filter((enhancer) => typeof enhancer === "function");
  const scanned =
    isClassProvider(wrapper) && wrapper.token === wrapper.metatype;
  return classes
    .filter(
      (enhancer) =>
        !scanned || wrapper.host?.injectables.has(enhancer) !== true,
    )
    .map((enhancer) => (enhancer as { name: string }).name);
}

/** What a module's `shutdown` option gives each worker's close. */
export interface BunJobsShutdownOptions {
  /**
   * How long a worker waits for jobs in flight on `app.close()`, in
   * milliseconds, before aborting their signals and leaving their locks to
   * lapse for the stalled sweep. Defaults to `30_000`.
   */
  timeout?: number;
  /** Aborts jobs in flight at once rather than draining them. */
  force?: boolean;
}

/** What the explorer takes from the module's options. */
export interface ExplorerOptions {
  /** Whether workers start at bootstrap. Defaults to `true`. */
  readonly autoStart?: boolean;
  /** How workers drain on `app.close()`. */
  readonly shutdown?: BunJobsShutdownOptions;
  /** What the registry's worker is started with, for `@DefineJob`. */
  readonly registryWorker?: Parameters<BunJobs["start"]>[0];
  /** Whether handlers run through the Nest pipeline. Defaults to `true`. */
  readonly enhancers?: boolean;
  /** Whether this process publishes its events, for `@OnJobsEvent`'s reminder. */
  readonly publishEvents?: boolean;
  /** A borrowed context, whose `publishEvents` the module cannot read. */
  readonly jobs?: unknown;
  /** The queue `@Cron` and `@Every` use unless they name one. */
  readonly scheduleQueue?: string;
  /** Whether undeclared series are removed at boot rather than warned about. */
  readonly pruneSchedules?: boolean;
}

/** The default queue for `@Cron` and `@Every`. */
const DEFAULT_SCHEDULE_QUEUE = "nest-schedule";

/** The default wait for jobs in flight on `app.close()`. */
const DEFAULT_SHUTDOWN_TIMEOUT = 30_000;

/** What `BunJobsModule.registerWorker` provides, found by the explorer. */
export class RegisteredWorker {
  constructor(
    /** The queue. */
    readonly queue: string,
    /** The context's `name`; `undefined` for the default context. */
    readonly context: string | undefined,
    /** The processor file. */
    readonly processor: string | URL,
    /** The worker's options. */
    readonly options: BunJobsWorkerOptions | undefined,
  ) {}
}

/** The key under which a queue's catch-all handler is held. */
const CATCH_ALL = Symbol("catch-all");

/** One method that handles jobs. */
interface HandlerEntry {
  /** `Class.method`, for messages. */
  readonly label: string;
  /** Calls it. */
  readonly invoke: JobProcessor<any, any, any>;
}

/** Every class on one queue. */
interface QueueGroup {
  /** The queue. */
  readonly queue: string;
  /** Handlers by job name, or {@link CATCH_ALL}. */
  readonly handlers: Map<string | symbol, HandlerEntry>;
  /** The worker options of each class that gave some. */
  readonly options: { label: string; options: BunJobsWorkerOptions }[];
  /** Per-name limits, from `@Process(name, limits)`. */
  readonly limits: Record<string, NameLimits>;
  /** The singletons whose `onModuleDestroy` drains the worker. */
  readonly instances: Set<object>;
  /** The series `@Cron` and `@Every` declare here, by key. */
  readonly series: Map<string, SeriesEntry>;
}

/** One series a `@Cron` or `@Every` declares. */
interface SeriesEntry {
  /** `Class.method`, for messages. */
  readonly label: string;
  /** What was declared. */
  readonly schedule: ScheduleMetadata;
}

/** One method listening to events, on a singleton. */
interface ListenerEntry {
  /** `Class.method`, for messages. */
  readonly label: string;
  /** What it listens to. */
  readonly listener: EventListenerMetadata;
  /** The class's queue, for `@OnWorkerEvent`. */
  readonly ownQueue: string | undefined;
  /** Calls it; what it throws or rejects with is logged. */
  readonly call: (...args: unknown[]) => void;
}

/** One running worker the explorer owns. */
interface ManagedWorker {
  /** The worker. */
  readonly worker: BunQueueWorker<any, any, any>;
  /** Whether `run()` has been called. */
  ran: boolean;
}

/** The class a provider stands for: bullmq's ternary, so factories and values count. */
function classOf(wrapper: Wrapper): unknown {
  const made = wrapper.metatype === undefined || wrapper.metatype === null;
  const factory = wrapper.inject !== undefined && wrapper.inject !== null;
  return made || factory
    ? (wrapper.instance as object | null | undefined)?.constructor
    : wrapper.metatype;
}

/** The worker options that reach bun-jobs, without what is Nest's. */
function workerOptionsOf(metadata: ProcessorMetadata): BunJobsWorkerOptions {
  const {
    scope: _scope,
    context: _context,
    enhancers: _enhancers,
    onDenied: _onDenied,
    onInvalid: _onInvalid,
    ...options
  } = metadata.options;
  return options;
}

/**
 * What a notifier follows for `@OnJobsEvent`: the union of what the decorators name,
 * or `"all"` when one leaves its target out. Worker events only when asked for by
 * kind, since they cost a second subscription per queue.
 */
function notifierOptionsFor(entries: ListenerEntry[]): JobsNotifierOptions {
  const targetsOf = (
    wanted: (kind: string | undefined) => boolean,
  ): "all" | string[] => {
    const targets = new Set<string>();
    for (const { listener } of entries) {
      if (listener.source === "jobs" && wanted(listener.options.kind)) {
        const { target } = listener.options;
        if (target === undefined) {
          return "all";
        }
        targets.add(target);
      }
    }
    return [...targets];
  };
  return {
    queues: targetsOf((kind) => kind === undefined || kind === "queue"),
    runners: targetsOf((kind) => kind === undefined || kind === "runner"),
    workers: targetsOf((kind) => kind === "worker"),
  };
}

/** What is wrong with a declared schedule, before anything is written. */
function checkSchedule(
  schedule: ScheduleMetadata,
  label: string,
): string | undefined {
  const { cron, every, options } = schedule;
  if (cron !== undefined && !validateCron(cron, { tz: options.tz })) {
    return `${label}: @Cron cannot read "${cron}"${options.tz === undefined ? "" : ` in zone "${options.tz}"`}`;
  }
  try {
    const resolved = resolveRepeat(
      definedOnly({ cron, every, tz: options.tz }),
      Date.now(),
      label,
    );
    if (every !== undefined && !resolved.every && !resolved.cron) {
      return `${label}: @Every cannot read ${JSON.stringify(every)}`;
    }
  } catch (error) {
    return `${label}: ${(error as Error).message}`;
  }
  return undefined;
}

/**
 * The start that puts an `@Every` on one grid for every replica: the epoch. Without
 * one, bun-jobs anchors a series on when it was created, by whoever's clock, so two
 * replicas creating it at the same moment each schedule their own first occurrence.
 * A phrase naming its own start keeps it, as does a cron schedule, which has no grid.
 */
function gridStart(schedule: ScheduleMetadata): number | undefined {
  if (schedule.every === undefined) {
    return undefined;
  }
  const resolved = resolveRepeat({ every: schedule.every }, Date.now());
  return resolved.every !== undefined && resolved.startAt === undefined
    ? 0
    : undefined;
}

/** The fields of an object with a value. */
function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
}

/** Whether a worker target can run a DI-built method. */
function isInProcess(target: unknown): boolean {
  return (
    target === undefined ||
    target === "in-process" ||
    (typeof target === "object" &&
      target !== null &&
      (target as { kind?: unknown }).kind === "in-process")
  );
}

/**
 * Finds the application's processors at `onApplicationBootstrap`, builds one
 * worker per queue, starts them, and drains them on `app.close()`.
 *
 * Bootstrap, not `onModuleInit`: a worker started earlier could claim a job
 * before another module's `onModuleInit` has opened what its handler uses.
 *
 * Each singleton's worker drains **in that instance's own `onModuleDestroy`**,
 * which is the one point measured to let a job in flight finish before a
 * service it uses is destroyed: a processor's dependencies live in modules it
 * imports, or in global ones, and both are destroyed after it. This class's own
 * `onModuleDestroy` is the fallback, for whatever has no instance hook.
 */
export class BunJobsExplorer
  implements OnApplicationBootstrap, OnModuleDestroy, StartableWorkers
{
  /** Where the explorer reports what it cannot report by failing. */
  readonly #logger = new Logger("BunJobsModule");
  /** Every worker this context's explorer built. */
  readonly #workers: ManagedWorker[] = [];
  /** The registry's worker, once `jobs.start()` has run. */
  #registryWorker: BunQueueWorker<any, any, any> | undefined;
  /** Whether any `@DefineJob` was found. */
  #hasDefinitions = false;
  /** The notifiers this explorer opened, closed in the fallback drain. */
  readonly #notifiers: JobsNotifier[] = [];
  /** `@OnJobsEvent` listeners, for the notifier opened at bootstrap. */
  #jobsListeners: ListenerEntry[] = [];
  /** Queues with `@OnQueueEvent` listeners, connected at bootstrap. */
  readonly #listenedQueues = new Set<string>();
  /** Per-name limits to store, by queue, before the first start. */
  #limits: { queue: string; limits: Record<string, NameLimits> }[] = [];
  /** The series to add before the first start, by queue. */
  readonly #seriesByQueue = new Map<string, Map<string, SeriesEntry>>();
  /** Whether the series have been added. */
  #seriesAdded = false;
  /** Whether bootstrap has built the workers. */
  #built = false;
  /** Whether the application has begun closing. */
  #closing = false;
  /** The hooks to install on each singleton, and the worker each closes. */
  readonly #drainsByInstance = new Map<object, (() => Promise<void>)[]>();

  constructor(
    /** The context's `name`; `undefined` for the default context. */
    readonly context: string | undefined,
    /** The context. */
    private readonly jobs: BunJobs<any, any>,
    /** The module's options for workers. */
    private readonly options: ExplorerOptions,
    /** The application's registry. */
    private readonly registry: BunJobsRegistry,
    /** Finds the providers. */
    private readonly discovery: DiscoveryService,
    /** Resolves a request-scoped processor per job. */
    private readonly moduleRef: ModuleRef,
    /** Builds each handler's pipeline. */
    private readonly ecc: ExternalContextCreator,
  ) {}

  /** Finds, checks and builds everything, then starts unless told otherwise. */
  async onApplicationBootstrap(): Promise<void> {
    this.#build();
    this.#built = true;
    await this.#openListeners();
    if (this.options.autoStart !== false) {
      await this.start();
    }
  }

  /** Starts every worker not running; see {@link BunJobsLifecycle.start}. */
  async start(): Promise<void> {
    if (!this.#built) {
      throw new ConfigError(
        "BunJobsLifecycle.start(): the workers are built at onApplicationBootstrap, so call it after app.init()",
      );
    }
    if (this.#closing) {
      return;
    }
    await this.#storeLimits();
    await this.#addSeries();
    await Promise.all(
      this.registry.runnersOf(this.context).map((runner) => runner.start()),
    );
    if (this.#hasDefinitions) {
      if (this.#registryWorker === undefined) {
        this.#registryWorker = (await this.jobs.start(
          this.options.registryWorker,
        )) as unknown as BunQueueWorker<any, any, any>;
      } else {
        this.#registryWorker.start();
      }
    }
    for (const managed of this.#workers) {
      if (managed.ran) {
        managed.worker.start();
        continue;
      }
      managed.ran = true;
      void managed.worker.run().catch((error: unknown) => {
        this.#logger.error(
          `Worker on queue "${managed.worker.queueName}" stopped: ${(error as Error).message}`,
          (error as Error).stack,
        );
      });
    }
  }

  /** Parks every running worker; see {@link BunJobsLifecycle.stop}. */
  async stop(): Promise<void> {
    const timeout = this.options.shutdown?.timeout ?? DEFAULT_SHUTDOWN_TIMEOUT;
    await Promise.all([
      ...this.#workers
        .filter((managed) => managed.ran)
        .map((managed) => managed.worker.stop({ timeout })),
      ...(this.#registryWorker === undefined
        ? []
        : [this.#registryWorker.stop({ timeout })]),
      ...this.registry
        .runnersOf(this.context)
        .map((runner) => runner.stop({ timeout })),
    ]);
  }

  /** The fallback drain: every worker no instance hook has closed, then the notifiers. */
  async onModuleDestroy(): Promise<void> {
    this.#closing = true;
    await Promise.all([
      ...this.#workers.map((managed) => this.#close(managed.worker)),
      ...(this.#registryWorker === undefined
        ? []
        : [this.#close(this.#registryWorker)]),
      ...this.registry.runnersOf(this.context).map((runner) =>
        runner
          .stop({
            timeout: this.options.shutdown?.timeout ?? DEFAULT_SHUTDOWN_TIMEOUT,
          })
          .catch((error: unknown) => {
            this.#logger.error(
              `Could not stop runner "${runner.id}": ${(error as Error).message}`,
              (error as Error).stack,
            );
          }),
      ),
    ]);
    await Promise.all(this.#notifiers.map((notifier) => notifier.close()));
  }

  /** The notifier `@InjectJobsNotifier()` injects, opened on `jobs.notifier()`. */
  async openInjectedNotifier(): Promise<JobsNotifier> {
    const notifier = await this.jobs.notifier();
    this.#notifiers.push(notifier);
    return notifier;
  }

  /** Closes a worker within the module's budget. A failure is logged: the close goes on. */
  async #close(worker: BunQueueWorker<any, any, any>): Promise<void> {
    const { timeout = DEFAULT_SHUTDOWN_TIMEOUT, force } =
      this.options.shutdown ?? {};
    try {
      await worker.close({
        timeout,
        ...(force === undefined ? {} : { force }),
      });
    } catch (error) {
      this.#logger.error(
        `Could not close the worker on queue "${worker.queueName}": ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  /** Discovery, the checks and the workers. */
  #build(): void {
    const problems: string[] = [];
    const groups = new Map<string, QueueGroup>();
    const files: RegisteredWorker[] = [];
    const definitions = new Map<
      string,
      {
        label: string;
        metadata: DefineJobMetadata;
        invoke: HandlerEntry["invoke"];
      }
    >();
    const seen = new Set<object>();
    const scanner = new MetadataScanner();

    const methodsOf = (target: { prototype: object }) =>
      scanner.getAllMethodNames(target.prototype).flatMap((method) => {
        const handler = (target.prototype as Record<string, unknown>)[method];
        if (typeof handler !== "function") {
          return [];
        }
        const process = Reflect.getMetadata(PROCESS_METADATA, handler) as
          ProcessMetadata | undefined;
        const define = Reflect.getMetadata(DEFINE_JOB_METADATA, handler) as
          DefineJobMetadata | undefined;
        const listeners = listenersOf(handler);
        const schedules = schedulesOf(handler);
        return process === undefined &&
          define === undefined &&
          listeners.length === 0 &&
          schedules.length === 0
          ? []
          : [{ method, process, define, listeners, schedules }];
      });
    const listenerEntries: ListenerEntry[] = [];
    const groupFor = (queue: string): QueueGroup => {
      const group: QueueGroup = groups.get(queue) ?? {
        queue,
        handlers: new Map(),
        options: [],
        limits: {},
        instances: new Set(),
        series: new Map(),
      };
      groups.set(queue, group);
      return group;
    };

    for (const wrapper of this.discovery.getControllers() as unknown as Wrapper[]) {
      const target = classOf(wrapper);
      if (
        typeof target === "function" &&
        (processorOf(target) !== undefined ||
          methodsOf(target as { prototype: object }).length > 0)
      ) {
        problems.push(
          `${target.name}: a controller cannot consume jobs or listen to their events. Nest builds a job's pipeline for providers only, so make it a provider`,
        );
      }
    }

    // Plain classes first, so an alias of one is seen as that one.
    const providers = (
      this.discovery.getProviders() as unknown as Wrapper[]
    ).toSorted(
      (a, b) => Number(isClassProvider(b)) - Number(isClassProvider(a)),
    );
    const scopedGlobals = this.#scopedGlobals();
    for (const wrapper of providers) {
      if (wrapper.instance instanceof RegisteredWorker) {
        if (wrapper.instance.context === this.context) {
          files.push(wrapper.instance);
        }
        continue;
      }
      const target = classOf(wrapper);
      if (typeof target !== "function" || target.prototype === undefined) {
        continue;
      }
      const prototype = target.prototype as object;
      const metadata = processorOf(target);
      const methods = methodsOf(target as { prototype: object });
      const isHost = prototype instanceof JobsHost;
      if (metadata === undefined && methods.length === 0 && !isHost) {
        continue;
      }
      const perJob = wrapper.isTransient || !wrapper.isDependencyTreeStatic();
      const instance = wrapper.instance as object;
      if (!perJob) {
        if (seen.has(instance)) {
          continue;
        }
        seen.add(instance);
      }
      const label = target.name;
      if (!perJob && !isClassProvider(wrapper) && scopedGlobals.length > 0) {
        problems.push(
          `${label}: request-scoped global enhancers (${scopedGlobals.join(", ")}) are not asked around a provider made by useFactory or useValue, since Nest does not scan one. Make it a class provider`,
        );
      }

      if (metadata === undefined) {
        const stray = methods.filter(({ process }) => process !== undefined);
        if (stray.length > 0 || isHost) {
          problems.push(
            `${label}: ${isHost ? "a JobsHost" : `@Process on ${stray[0]!.method}()`} needs @Processor(queue) on the class`,
          );
          continue;
        }
      } else if (!this.registry.hasContext(metadata.context)) {
        problems.push(
          `${label}: @Processor names context "${String(metadata.context)}", which no forRoot() provides`,
        );
        continue;
      }

      if (metadata !== undefined && metadata.context === this.context) {
        const group = groupFor(metadata.queue);
        this.#addProcessor(group, label, metadata, problems);
        const named = methods.filter(({ process }) => process !== undefined);
        if (isHost && !named.some(({ method }) => method === "process")) {
          named.push({
            method: "process",
            process: { name: undefined, options: undefined },
            define: undefined,
            listeners: [],
            schedules: [],
          });
        }
        if (named.length === 0) {
          problems.push(
            `${label}: @Processor("${metadata.queue}") has no @Process method, so nothing would handle its jobs`,
          );
        }
        for (const { method, process, define } of named) {
          if (define !== undefined) {
            problems.push(
              `${label}.${method}: @Process and @DefineJob on one method would run it from two queues`,
            );
          }
          const key = process?.name ?? CATCH_ALL;
          const existing = group.handlers.get(key);
          const entryLabel = `${label}.${method}`;
          if (existing !== undefined) {
            problems.push(
              `queue "${metadata.queue}": ${key === CATCH_ALL ? "two catch-all @Process() methods" : `two handlers for job "${String(key)}"`}, ${existing.label} and ${entryLabel}`,
            );
            continue;
          }
          group.handlers.set(key, {
            label: entryLabel,
            invoke: this.#invoker(wrapper, method, perJob, {
              label: entryLabel,
              handlerName: process?.name ?? "*",
              enhancers: this.#enhancersFor(metadata.options.enhancers),
              onDenied: metadata.options.onDenied,
              onInvalid: metadata.options.onInvalid,
            }),
          });
          this.#checkMethod(
            wrapper,
            target as { prototype: object },
            method,
            entryLabel,
            this.#enhancersFor(metadata.options.enhancers),
            problems,
          );
          if (process?.token !== undefined) {
            if (
              process.token.queue !== metadata.queue ||
              process.token.context !== metadata.context
            ) {
              problems.push(
                `${entryLabel}: @Process names queue "${process.token.queue}", but the class's @Processor is on "${metadata.queue}"`,
              );
            }
          }
          if (process?.options !== undefined) {
            if (process.name === undefined) {
              problems.push(
                `${entryLabel}: a catch-all @Process() has no name to put limits on`,
              );
            } else {
              group.limits[process.name] = process.options;
            }
          }
        }
        if (!perJob) {
          group.instances.add(instance);
        }
      }

      for (const { method, define } of methods) {
        if (
          define === undefined ||
          (define.options?.context ?? undefined) !== this.context
        ) {
          continue;
        }
        const entryLabel = `${label}.${method}`;
        const bare = bareSchemaProblem(define.options?.schema, entryLabel);
        if (bare !== undefined) {
          problems.push(bare);
        }
        const existing = definitions.get(define.name);
        if (existing !== undefined) {
          problems.push(
            `job "${define.name}" is defined twice, by ${existing.label} and ${entryLabel}`,
          );
          continue;
        }
        definitions.set(define.name, {
          label: entryLabel,
          metadata: define,
          invoke: this.#invoker(wrapper, method, perJob, {
            label: entryLabel,
            handlerName: define.name,
            enhancers: this.#enhancersFor(define.options?.enhancers),
            onDenied: define.options?.onDenied,
            onInvalid: define.options?.onInvalid,
          }),
        });
        this.#checkMethod(
          wrapper,
          target as { prototype: object },
          method,
          entryLabel,
          this.#enhancersFor(define.options?.enhancers),
          problems,
        );
        if (!perJob) {
          this.#addDrain(instance, async () => {
            if (this.#registryWorker !== undefined) {
              await this.#close(this.#registryWorker);
            }
          });
        }
      }

      for (const { method, process, define, schedules } of methods) {
        for (const schedule of schedules) {
          const entryLabel = `${label}.${method}`;
          const { context, enhancers, onDenied, onInvalid } = schedule.options;
          if (!this.registry.hasContext(context)) {
            problems.push(
              `${entryLabel}: its schedule names context "${String(context)}", which no forRoot() provides`,
            );
            continue;
          }
          if (context !== this.context) {
            continue;
          }
          if (process !== undefined || define !== undefined) {
            problems.push(
              `${entryLabel}: a schedule and @Process or @DefineJob on one method would run it from two places`,
            );
            continue;
          }
          const key = schedule.options.name ?? `${label}.${method}`;
          const scheduleProblem = checkSchedule(schedule, entryLabel);
          if (scheduleProblem !== undefined) {
            problems.push(scheduleProblem);
            continue;
          }
          const group = groupFor(
            schedule.options.queue ??
              this.options.scheduleQueue ??
              DEFAULT_SCHEDULE_QUEUE,
          );
          const existing = group.series.get(key) ?? group.handlers.get(key);
          if (existing !== undefined) {
            problems.push(
              `queue "${group.queue}": two handlers for series "${key}", ${existing.label} and ${entryLabel}. Give one a name`,
            );
            continue;
          }
          group.series.set(key, { label: entryLabel, schedule });
          group.handlers.set(key, {
            label: entryLabel,
            invoke: this.#invoker(wrapper, method, perJob, {
              label: entryLabel,
              handlerName: key,
              enhancers: this.#enhancersFor(enhancers),
              onDenied,
              onInvalid,
            }),
          });
          this.#checkMethod(
            wrapper,
            target as { prototype: object },
            method,
            entryLabel,
            this.#enhancersFor(enhancers),
            problems,
          );
          if (!perJob) {
            group.instances.add(instance);
          }
        }
      }

      for (const { method, listeners } of methods) {
        for (const listener of listeners) {
          const entryLabel = `${label}.${method}`;
          const context =
            listener.source === "worker"
              ? metadata?.context
              : listener.source === "jobs"
                ? (listener.options.context as string | undefined)
                : listener.context;
          if (listener.source === "worker" && metadata === undefined) {
            problems.push(
              `${entryLabel}: @OnWorkerEvent listens to a @Processor class's own worker, and ${label} has no @Processor. @OnQueueEvent or @OnJobsEvent work from any provider`,
            );
            continue;
          }
          if (!this.registry.hasContext(context)) {
            problems.push(
              `${entryLabel}: its event decorator names context "${String(context)}", which no forRoot() provides`,
            );
            continue;
          }
          if (context !== this.context) {
            continue;
          }
          if (perJob) {
            problems.push(
              `${entryLabel}: an event listener needs one instance to call, and ${label} is built per job. Put listeners on a singleton`,
            );
            continue;
          }
          listenerEntries.push({
            label: entryLabel,
            listener,
            ownQueue: metadata?.queue,
            call: this.#listenerCall(instance, method, entryLabel),
          });
        }
      }
    }

    for (const file of files) {
      const bare = bareSchemaProblem(
        file.options?.schema,
        `registerWorker on queue "${file.queue}"`,
      );
      if (bare !== undefined) {
        problems.push(bare);
      }
      if (groups.has(file.queue)) {
        problems.push(
          `queue "${file.queue}": registerWorker and a @Processor would each claim the other's jobs. A bun-jobs worker claims any job on its queue`,
        );
      }
    }
    const fileQueues = files.map((file) => file.queue);
    for (const queue of new Set(fileQueues)) {
      if (fileQueues.indexOf(queue) !== fileQueues.lastIndexOf(queue)) {
        problems.push(
          `queue "${queue}": two registerWorker() calls would each claim the other's jobs`,
        );
      }
    }

    assertNoProblems(problems);
    this.#buildWorkers(groups, files, definitions, problems);
    this.#wireListeners(listenerEntries, problems);
    assertNoProblems(problems);
    this.#reportGlobals();
  }

  /**
   * Calls a listener, catching what it throws or rejects with: bun-jobs swallows a
   * synchronous throw in silence, and an `async` listener's rejection would be
   * unhandled, so each is logged here and affects nothing.
   */
  #listenerCall(
    instance: object,
    method: string,
    label: string,
  ): (...args: unknown[]) => void {
    const failed = (error: unknown) => {
      this.#logger.error(
        `${label}: an event listener failed: ${(error as Error)?.message ?? String(error)}`,
        (error as Error)?.stack,
      );
    };
    return (...args) => {
      try {
        const result = (
          instance as Record<string, (...a: unknown[]) => unknown>
        )[method]!(...args);
        if (result instanceof Promise) {
          result.catch(failed);
        }
      } catch (error) {
        failed(error);
      }
    };
  }

  /** Attaches every listener the emitters of this process serve. */
  #wireListeners(entries: ListenerEntry[], problems: string[]): void {
    for (const entry of entries) {
      const { listener, label, ownQueue, call } = entry;
      switch (listener.source) {
        case "worker": {
          const worker = this.registry.workerRef(this.context, ownQueue!);
          (worker.worker as unknown as NodeJS.EventEmitter).on(
            listener.event,
            call,
          );
          break;
        }
        case "queue": {
          const queue = this.jobs.queue<unknown, unknown>(listener.queue);
          (queue as unknown as NodeJS.EventEmitter).on(listener.event, call);
          this.#listenedQueues.add(listener.queue);
          break;
        }
        case "runner": {
          const runner = this.jobs.runners.get(listener.id);
          if (runner === undefined) {
            problems.push(
              `${label}: @OnRunnerEvent names runner "${listener.id}", which does not exist by bootstrap`,
            );
            break;
          }
          (runner as unknown as NodeJS.EventEmitter).on(listener.event, call);
          break;
        }
        default:
          this.#jobsListeners.push(entry);
      }
    }
  }

  /**
   * Connects the queues with listeners, so a subscribing one hears other processes,
   * and opens one notifier for `@OnJobsEvent`, following only what the decorators
   * name. Before any worker starts, so nothing they do goes unheard.
   */
  async #openListeners(): Promise<void> {
    await Promise.all(
      [...this.#listenedQueues].map((queue) =>
        this.jobs.queue<unknown, unknown>(queue).connect(),
      ),
    );
    const entries = this.#jobsListeners;
    if (entries.length === 0) {
      return;
    }
    if (
      this.options.jobs === undefined &&
      this.options.publishEvents !== true
    ) {
      this.#logger.warn(
        "@OnJobsEvent hears only what is published, and publishEvents is off in this process, so its own queues, workers and runners publish nothing unless they set `publish`. Other processes need it too",
      );
    }
    const notifier = await this.jobs.notifier(notifierOptionsFor(entries));
    this.#notifiers.push(notifier);
    notifier.on("event", (event) => {
      for (const { listener, call } of entries) {
        if (listener.source === "jobs") {
          const { kind, type, target } = listener.options;
          if (
            (kind === undefined || kind === event.kind) &&
            (type === undefined || type === event.type) &&
            (target === undefined || target === event.target)
          ) {
            call(event);
          }
        }
      }
    });
  }

  /** Records one class on a queue's group, checking its options against the others'. */
  #addProcessor(
    group: QueueGroup,
    label: string,
    metadata: ProcessorMetadata,
    problems: string[],
  ): void {
    if (!isInProcess(metadata.options.target)) {
      problems.push(
        `${label}: a @Process method runs in-process, so target ${JSON.stringify(metadata.options.target)} cannot apply. A function cannot be sent to another thread or process; BunJobsModule.registerWorker takes a processor file`,
      );
    }
    const options = workerOptionsOf(metadata);
    const bare = bareSchemaProblem(options.schema, label);
    if (bare !== undefined) {
      problems.push(bare);
    }
    if (!Object.values(options).some((value) => value !== undefined)) {
      return;
    }
    const first = group.options[0];
    if (first !== undefined) {
      const differing = differingOptions(first.options, options);
      if (differing.length > 0) {
        problems.push(
          `queue "${group.queue}": ${first.label} and ${label} share one worker, but set different worker options (${differing.join(", ")})`,
        );
      }
    }
    group.options.push({ label, options });
  }

  /** The application's request-scoped global enhancers, by name. */
  #scopedGlobals(): string[] {
    const config = this.#container()?.applicationConfig;
    return [
      ...(config?.getGlobalRequestGuards?.() ?? []),
      ...(config?.getGlobalRequestInterceptors?.() ?? []),
      ...(config?.getGlobalRequestPipes?.() ?? []),
      ...(config?.getGlobalRequestFilters?.() ?? []),
    ].map((wrapper) => {
      const { name, metatype } = wrapper as {
        name?: unknown;
        metatype?: { name?: string };
      };
      return metatype?.name ?? String(name);
    });
  }

  /** Nest's container, through the module's `ModuleRef`, as the throttler's boot check reads it. */
  #container(): ContainerView | undefined {
    return Reflect.get(this.moduleRef, "container") as
      ContainerView | undefined;
  }

  /** One debug line naming the global guards a job will meet (risk R6). */
  #reportGlobals(): void {
    const config = this.#container()?.applicationConfig;
    const guards = [
      ...(config?.getGlobalGuards?.() ?? []).map(
        (guard) => guard.constructor.name,
      ),
      ...(config?.getGlobalRequestGuards?.() ?? []).map((wrapper) =>
        String((wrapper as { name?: unknown }).name),
      ),
    ];
    if (guards.length > 0 && this.#workers.length > 0) {
      this.#logger.debug(
        `These global guards also apply to jobs, unless they pass a "bun-jobs" context through: ${guards.join(", ")}`,
      );
    }
  }

  /** Whether a handler runs through the pipeline: its own word, else the module's. */
  #enhancersFor(own: boolean | undefined): boolean {
    return own ?? this.options.enhancers ?? true;
  }

  /** The checks on one handler's method. */
  #checkMethod(
    wrapper: Wrapper,
    target: { prototype: object },
    method: string,
    label: string,
    enhancers: boolean,
    problems: string[],
  ): void {
    const handler = (target.prototype as Record<string, object>)[method]!;
    const cached = Reflect.getMetadata(CACHE_WRAPPED_METADATA, handler) as
      string | undefined;
    if (cached !== undefined && cached !== "CacheEvict") {
      problems.push(
        `${label}: @${cached} on a job handler would cache across jobs, so a later job would complete with an earlier one's result without running. Cache inside the method instead`,
      );
    }
    if (!enhancers) {
      if (decoratedParams(target, method).size > 0) {
        problems.push(
          `${label}: enhancers: false calls the method as (job, ctx), so its parameter decorators would never be read`,
        );
      }
      return;
    }
    const dropped = droppedEnhancers(wrapper, target, method);
    if (dropped.length > 0) {
      problems.push(
        `${label}: Nest would silently not run ${dropped.join(", ")}, since it finds an enhancer class only on a plain class provider. Register it as providers: [${target.prototype.constructor.name}], or give the decorator an instance`,
      );
    }
    const missing = undecoratedParams(target, method);
    if (missing.length > 0) {
      problems.push(
        `${label}: parameter ${missing.join(", ")} has no decorator. Once one parameter is decorated every one must be, or the rest arrive as null: use @CurrentJob(), @JobContext(), or none at all for (job, ctx)`,
      );
    }
  }

  /** How one method is called: through the pipeline, unless told otherwise. */
  #invoker(
    wrapper: Wrapper,
    method: string,
    perJob: boolean,
    settings: FailurePolicy & {
      /** The `@Process` or `@DefineJob` name, or `"*"`. */
      readonly handlerName: string;
      /** Whether the pipeline runs. */
      readonly enhancers: boolean;
    },
  ): HandlerEntry["invoke"] {
    type Instance = Record<string, (...args: unknown[]) => unknown>;
    type Run = (job: Job<any, any, any>, ctx: ProcessorContext) => unknown;
    const { enhancers, handlerName } = settings;
    const runOf = (
      instance: Instance,
      contextId?: Parameters<ExternalContextCreator["create"]>[5],
    ): Run =>
      enhancers
        ? buildPipeline(this.ecc, instance, method, contextId)
        : (job, ctx) => instance[method]!(job, ctx);
    const settle = async (
      run: Run,
      job: Job<any, any, any>,
      ctx: ProcessorContext,
    ): Promise<unknown> => {
      recordHandlerName(ctx, handlerName);
      try {
        return await run(job, ctx);
      } catch (error) {
        throw enhancers ? mapPipelineFailure(error, job, settings) : error;
      }
    };
    if (!perJob) {
      const run = runOf(wrapper.instance as Instance);
      return (job, ctx) => settle(run, job, ctx);
    }
    return async (job, ctx) => {
      // Consults a ContextIdStrategy, so a durable tree (a tenant per job) can
      // attach; it writes nothing on the job. Public API only, as @nestjs/cqrs.
      const contextId = ContextIdFactory.getByRequest(job);
      this.moduleRef.registerRequestByContextId(job, contextId);
      const instance = await this.moduleRef.resolve<unknown, Instance>(
        wrapper.token as never,
        contextId,
        { strict: false },
      );
      this.#bindHost(instance);
      return settle(runOf(instance, contextId), job, ctx);
    };
  }

  /** Gives a {@link JobsHost} instance its worker and drain. */
  #bindHost(instance: object): void {
    if (!(instance instanceof JobsHost)) {
      return;
    }
    const queue = processorOf(instance.constructor)!.queue;
    const binding: JobsHostBinding = {
      worker: () => this.registry.workerRef(this.context, queue).worker,
      drain: () =>
        this.#close(this.registry.workerRef(this.context, queue).worker),
    };
    Object.defineProperty(instance, JOBS_HOST_BINDING, {
      value: binding,
      configurable: true,
    });
  }

  /** Builds the workers and the definitions; a bun-jobs refusal is one more problem. */
  #buildWorkers(
    groups: Map<string, QueueGroup>,
    files: RegisteredWorker[],
    definitions: Map<
      string,
      {
        label: string;
        metadata: DefineJobMetadata;
        invoke: HandlerEntry["invoke"];
      }
    >,
    problems: string[],
  ): void {
    for (const group of groups.values()) {
      const { handlers, queue } = group;
      try {
        const worker = this.jobs.worker<any, any>(
          queue,
          (job, ctx) => {
            const handler = handlers.get(job.name) ?? handlers.get(CATCH_ALL);
            if (handler === undefined) {
              // Q15: a @Processor queue belongs to this service, so no retry
              // here will find a handler.
              throw new UnrecoverableJobError(
                group.series.size > 0
                  ? `No @Process, @Cron or @Every handler for job or series "${job.name}" on queue "${queue}" in this process`
                  : `No @Process handler for job "${job.name}" on queue "${queue}" in this process`,
                {
                  queue,
                  name: job.name,
                  handled: [...handlers.keys()].map(String),
                },
              );
            }
            return handler.invoke(job, ctx);
          },
          group.options[0]?.options,
        );
        this.#workers.push({ worker, ran: false });
        this.registry.bindWorker(this.context, queue, worker);
        if (Object.keys(group.limits).length > 0) {
          normalizeLimits({ names: group.limits });
          this.#limits.push({ queue, limits: group.limits });
        }
        if (group.series.size > 0) {
          this.#seriesByQueue.set(queue, group.series);
        }
        for (const instance of group.instances) {
          this.#bindHost(instance);
          if (!(instance instanceof JobsHost)) {
            this.#addDrain(instance, () => this.#close(worker));
          }
        }
      } catch (error) {
        problems.push(`queue "${queue}": ${(error as Error).message}`);
      }
    }
    for (const file of files) {
      try {
        const worker = this.jobs.worker(
          file.queue,
          file.processor,
          file.options,
        );
        this.#workers.push({ worker, ran: false });
        this.registry.bindWorker(this.context, file.queue, worker);
      } catch (error) {
        problems.push(
          `registerWorker on queue "${file.queue}": ${(error as Error).message}`,
        );
      }
    }
    for (const [name, { label, metadata, invoke }] of definitions) {
      const {
        context: _context,
        enhancers: _enhancers,
        onDenied: _onDenied,
        onInvalid: _onInvalid,
        ...options
      } = metadata.options ?? {};
      try {
        (this.jobs.define as (...args: unknown[]) => unknown).call(
          this.jobs,
          name,
          invoke,
          options,
        );
        this.#hasDefinitions = true;
      } catch (error) {
        problems.push(`${label}: ${(error as Error).message}`);
      }
    }
    this.#installDrains();
  }

  /** Adds one drain to run in an instance's `onModuleDestroy`. */
  #addDrain(instance: object, drain: () => Promise<void>): void {
    const drains = this.#drainsByInstance.get(instance) ?? [];
    drains.push(drain);
    this.#drainsByInstance.set(instance, drains);
  }

  /**
   * Installs each instance's drain as an own `onModuleDestroy`, chained to the
   * class's own, which runs once, after its jobs have finished. The one piece
   * of "magic" in the design: `JobsHost` is the form that shows it.
   */
  #installDrains(): void {
    for (const [instance, drains] of this.#drainsByInstance) {
      const target = instance as { onModuleDestroy?: () => unknown };
      const own = target.onModuleDestroy?.bind(instance);
      Object.defineProperty(instance, "onModuleDestroy", {
        configurable: true,
        writable: true,
        enumerable: false,
        value: async () => {
          await Promise.all(drains.map((drain) => drain()));
          await own?.();
        },
      });
    }
  }

  /**
   * Adds every declared series, once per process, and deals with what is stored and
   * no longer declared. Adding is idempotent across replicas: an occurrence's id comes
   * from the series and its due time. Only a queue this process schedules on is read,
   * or the module's own with `pruneSchedules`, so a service that schedules nothing never
   * touches another's series.
   */
  async #addSeries(): Promise<void> {
    if (this.#seriesAdded) {
      return;
    }
    this.#seriesAdded = true;
    const queues = new Map(this.#seriesByQueue);
    if (this.options.pruneSchedules === true) {
      const own = this.options.scheduleQueue ?? DEFAULT_SCHEDULE_QUEUE;
      queues.set(own, queues.get(own) ?? new Map());
    }
    for (const [name, series] of queues) {
      const queue = this.jobs.queue<unknown, unknown>(name);
      const stored = await queue.listRepeatables();
      for (const [key, { schedule, label }] of series) {
        if (schedule.options.disabled === true) {
          continue;
        }
        await this.#addOneSeries(
          queue,
          key,
          schedule,
          label,
          stored.some((existing) => existing.key === key),
        );
      }
      const undeclared = stored
        .filter(
          (existing) =>
            existing.name === existing.key && !series.has(existing.key),
        )
        .map((existing) => existing.key);
      if (undeclared.length === 0) {
        continue;
      }
      if (this.options.pruneSchedules === true) {
        await Promise.all(undeclared.map((key) => queue.removeRepeatable(key)));
        this.#logger.log(
          `Removed series no @Cron or @Every declares on queue "${name}": ${undeclared.join(", ")}`,
        );
      } else {
        this.#logger.warn(
          `No @Cron or @Every in this process declares these series on queue "${name}", and their next occurrences will fail here: ${undeclared.join(", ")}. A rolling deploy's old version may still declare them; otherwise remove them, or set pruneSchedules: true`,
        );
      }
    }
  }

  /** Adds one series, with the job options it declares. */
  async #addOneSeries(
    queue: BunQueue<unknown, unknown>,
    key: string,
    schedule: ScheduleMetadata,
    label: string,
    exists: boolean,
  ): Promise<void> {
    const {
      attempts,
      backoff,
      timeout,
      deadLetter,
      tz,
      limit,
      startAt,
      endAt,
      immediately,
      catchUp,
    } = schedule.options;
    try {
      await queue.add(
        key,
        {},
        definedOnly({
          attempts,
          backoff,
          timeout,
          deadLetter,
          repeat: definedOnly({
            key,
            cron: schedule.cron,
            every: schedule.every,
            tz,
            limit,
            endAt,
            catchUp,
            startAt: startAt ?? gridStart(schedule),
            // "Once as soon as the series is created": a restart adds it again,
            // and would otherwise run it again.
            immediately: exists ? undefined : immediately,
          }),
        }),
      );
    } catch (error) {
      // A `limit` reached, or an `endAt` passed: a finished series is not a failed boot.
      if (!String((error as Error).message).includes("no occurrences left")) {
        throw new ConfigError(`${label}: ${(error as Error).message}`, {
          key,
        });
      }
      this.#logger.debug(`${label}: series "${key}" has no occurrences left`);
    }
  }

  /**
   * Stores each `@Process(name, limits)` on its queue, merged into what is
   * stored: the queue's rate, its overall concurrency and every other name stay
   * as they were, and nothing is written when nothing would change, so a fleet
   * starting together does not rewrite them once each.
   */
  async #storeLimits(): Promise<void> {
    const pending = this.#limits;
    this.#limits = [];
    for (const { queue, limits } of pending) {
      const target = this.jobs.queue<unknown, unknown>(queue);
      const current = await target.getLimits();
      const wanted = normalizeLimits({ names: limits }).names ?? {};
      const names = { ...current?.names };
      let changed = false;
      for (const [name, limit] of Object.entries(wanted)) {
        if (!Bun.deepEquals(names[name], limit)) {
          names[name] = limit;
          changed = true;
        }
      }
      if (changed) {
        await target.setLimits({ ...current, names });
      }
    }
  }
}
