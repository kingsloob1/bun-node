import type { BunJobsOptions, BunQueue } from "@kingsleyweb/bun-jobs";
import type { LoggerLike } from "@kingsleyweb/bun-common";
import type {
  DynamicModule,
  FactoryProvider,
  InjectionToken,
  ModuleMetadata,
  OnApplicationShutdown,
  OnModuleInit,
  OptionalFactoryDependency,
  Provider,
  Type,
} from "@nestjs/common";
import type { BunJobsWorkerOptions } from "./decorators/consumer";
import type { BunJobsShutdownOptions } from "./explorer";
import type { QueueTokenClass } from "./queueToken";
import type { BunJobsQueueOptions } from "./registry";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { ConfigError, noopLogger } from "@kingsleyweb/bun-common";
import { Logger, Module } from "@nestjs/common";
import { DiscoveryModule, DiscoveryService, ModuleRef } from "@nestjs/core";
import { BunJobsExplorer, RegisteredWorker } from "./explorer";
import { BunJobsLifecycle } from "./lifecycle";
import { requireQueueToken } from "./queueToken";
import {
  assertNoProblems,
  BunJobsRegistry,
  BunJobsRegistryModule,
  declareQueueFactory,
} from "./registry";
import {
  getBunJobsOptionsToken,
  getBunJobsToken,
  getQueueToken,
  getWorkerToken,
} from "./tokens";

/** What every form of the module takes beside the context's own options. */
export interface BunJobsModuleContextOptions {
  /**
   * Registers the module globally, so `registerQueue()` in a feature module
   * needs nothing but itself. Defaults to `true`. With `false`, reach the
   * context by importing this same module; `registerQueueAsync({ imports })`
   * is how a queue does.
   */
  isGlobal?: boolean;
  /**
   * The context's name, for an application with several: its tokens are then
   * `getBunJobsToken(name)` and `getQueueToken(queue, name)`, and only the
   * unnamed one is provided under the class `BunJobs`. Letters, digits, `_`,
   * `.` and `-`.
   */
  name?: string;
  /**
   * A named class extending `BunJobs<Jobs>`, provided as well, so a typed
   * registry keeps its compile-time checks where it is injected. It must be
   * named: an anonymous one fails declaration emit (`TS4094`). Nothing is an
   * instance of it.
   */
  token?: abstract new (...args: never[]) => BunJobs<any, any>;
}

/** How the module runs the workers it builds. */
export interface BunJobsRunOptions {
  /**
   * Whether workers start at bootstrap. Defaults to `true`. With `false`,
   * discovery still runs and the handlers are built, but nothing claims a job
   * until `BunJobsLifecycle.start()`: for tests, and for summoned processes.
   */
  autoStart?: boolean;
  /**
   * How workers drain on `app.close()`: `{ timeout, force }`, passed to each
   * `worker.close()`. `timeout` defaults to `30_000` ms. A job still running at
   * the timeout has its signal aborted and its lock left to lapse for the
   * stalled sweep.
   */
  shutdown?: BunJobsShutdownOptions;
  /** What `jobs.start()` is given for `@DefineJob`: the registry worker's options. */
  registryWorker?: Parameters<BunJobs["start"]>[0];
}

/** The context's options when the module builds it. */
export interface BunJobsBuildOptions
  extends Omit<BunJobsOptions, "logger">, BunJobsRunOptions {
  /** Not given: the module builds the context, and closes it. */
  jobs?: undefined;
  /**
   * Where bun-jobs logs: anything `resolveLogger` accepts. Defaults to
   * `new Logger("BunJobs")` from `@nestjs/common`, so its records reach
   * `app.useLogger()`. `false` drops them.
   */
  logger?: LoggerLike | false;
}

/**
 * The context's options when the module borrows one. The workers the module
 * builds on it are the module's, and it closes them; the context stays open.
 */
export interface BunJobsBorrowOptions extends BunJobsRunOptions {
  /**
   * An existing context to use instead of building one. The application owns
   * it, so the module never closes it.
   */
  jobs: BunJobs<any, any>;
}

/** What `forRootAsync()`'s factory or options class answers with. */
export type BunJobsContextOptions = BunJobsBuildOptions | BunJobsBorrowOptions;

/** What {@link BunJobsModule.forRoot} accepts. */
export type BunJobsModuleOptions = BunJobsContextOptions &
  BunJobsModuleContextOptions;

/** A class that builds the context's options, for `forRootAsync({ useClass })`. */
export interface BunJobsOptionsFactory {
  /** Builds the options. */
  createBunJobsOptions: () =>
    BunJobsContextOptions | Promise<BunJobsContextOptions>;
}

/**
 * What {@link BunJobsModule.forRootAsync} accepts. `isGlobal`, `name` and
 * `token` are given here rather than by the factory, since Nest needs them
 * before any factory runs.
 */
export interface BunJobsModuleAsyncOptions
  extends BunJobsModuleContextOptions, Pick<ModuleMetadata, "imports"> {
  /** Providers injected into {@link useFactory}. */
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  /** Builds the options, with whatever {@link inject} resolved. */
  useFactory?: (
    ...args: any[]
  ) => BunJobsContextOptions | Promise<BunJobsContextOptions>;
  /** A class the module builds, whose `createBunJobsOptions()` gives the options. */
  useClass?: Type<BunJobsOptionsFactory>;
  /** The same, from a provider `imports` can reach. */
  useExisting?: Type<BunJobsOptionsFactory>;
}

/**
 * One queue to register.
 *
 * @typeParam TData What `add` takes.
 * @typeParam TResult What a job's `returnValue` is.
 */
export interface RegisterQueueOptions<TData = unknown, TResult = unknown> {
  /** The queue's name, or its `@QueueToken()` class. */
  name: string | QueueTokenClass;
  /**
   * The context's `name`; the default context when left out. A token class
   * names its own, and this must not disagree with it.
   */
  context?: string;
  /**
   * The options it is created with, `schema` included. They apply when it is
   * created, so two registrations of one queue must not differ: that is a
   * `ConfigError` at boot. A registration with none asks for nothing.
   */
  options?: BunJobsQueueOptions<TData, TResult>;
}

/** One queue to register with options built while the application boots. */
export interface RegisterQueueAsyncOptions extends Pick<
  ModuleMetadata,
  "imports"
> {
  /** The queue's name, or its `@QueueToken()` class. */
  name: string | QueueTokenClass;
  /**
   * The context's `name`; the default context when left out. A token class
   * names its own, and this must not disagree with it.
   */
  context?: string;
  /** Providers injected into {@link useFactory}. */
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  /** Builds the queue's options, with whatever {@link inject} resolved. */
  useFactory: (
    ...args: any[]
  ) =>
    | Pick<RegisterQueueOptions, "options">
    | Promise<Pick<RegisterQueueOptions, "options">>;
}

/** One processor file to run as a worker the module owns. */
export interface RegisterWorkerOptions {
  /** The queue's name, or its `@QueueToken()` class. */
  queue: string | QueueTokenClass;
  /**
   * The context's `name`; the default context when left out. A token class
   * names its own, and this must not disagree with it.
   */
  context?: string;
  /** The file: its path or URL, as `jobs.worker()` takes it. */
  processor: string | URL;
  /**
   * The worker's options, `target` above all: `"worker-thread"`,
   * `"child-process"`, `{ kind: "container", … }`. A file has no Nest pipeline
   * and no DI of its own.
   */
  options?: BunJobsWorkerOptions;
}

/** A context this module provides. */
interface ContextEntry {
  /** The context. */
  readonly jobs: BunJobs<any, any>;
  /** Whether the module built it, and so closes it. */
  readonly owned: boolean;
}

/** The provider of a module's {@link ContextEntry}. Never leaves its module. */
const CONTEXT_ENTRY = Symbol("BUN_JOBS_CONTEXT_ENTRY");

/**
 * What makes each call of `forRoot()` and `registerQueue()` a module of its
 * own. Nest tells dynamic modules apart by hashing their metadata, and a
 * factory hashes as its source text, so two calls that differ only in what
 * their factories close over would otherwise become one.
 */
const MODULE_CALL = Symbol("BUN_JOBS_MODULE_CALL");

/** The provider of one `registerWorker()`. The explorer finds it by its class. */
const REGISTERED_WORKER = Symbol("BUN_JOBS_REGISTERED_WORKER");

/** Builds or takes the context the options describe. */
function buildEntry(options: BunJobsContextOptions): ContextEntry {
  if (options.jobs !== undefined) {
    return { jobs: options.jobs, owned: false };
  }
  const {
    jobs: _jobs,
    logger,
    autoStart: _autoStart,
    shutdown: _shutdown,
    registryWorker: _registryWorker,
    ...context
  } = options;
  return {
    jobs: new BunJobs({
      ...context,
      logger: logger === false ? noopLogger : (logger ?? new Logger("BunJobs")),
    }),
    owned: true,
  };
}

/**
 * Boots and closes one context. The module class holds nothing, because each
 * `registerQueue()` is a module of that class too.
 */
export class BunJobsContextOwner
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(
    /** The context, and whether it is the module's to close. */
    private readonly entry: ContextEntry,
    /** What the application registered. */
    private readonly registry: BunJobsRegistry,
  ) {}

  /** Runs the boot checks: every provider exists by now, no job has run. */
  onModuleInit(): void {
    assertNoProblems(this.registry.problems());
  }

  /** Closes the context if this module built it, once the HTTP server has drained. */
  async onApplicationShutdown(): Promise<void> {
    if (this.entry.owned) {
      await this.entry.jobs.close();
    }
  }
}

/** Refuses a context name no token can hold. */
function assertContextName(name: string | undefined): void {
  if (name !== undefined && !/^[\w.-]+$/.test(name)) {
    throw new ConfigError(
      `BunJobsModule: a context's name may only contain letters, digits, "_", "." and "-", got "${name}"`,
    );
  }
}

/** The module around a context's options provider(s). */
function moduleOf(
  options: BunJobsModuleContextOptions,
  optionProviders: Provider[],
  imports: DynamicModule["imports"],
): DynamicModule {
  const { name, token, isGlobal = true } = options;
  assertContextName(name);
  const optionsToken = getBunJobsOptionsToken(name);
  const contextToken = getBunJobsToken(name);
  const aliases: InjectionToken[] = [
    ...(name === undefined ? [BunJobs] : []),
    ...(token === undefined ? [] : [token]),
  ];
  return {
    module: BunJobsModule,
    global: isGlobal,
    imports: [DiscoveryModule, BunJobsRegistryModule, ...(imports ?? [])],
    providers: [
      { provide: MODULE_CALL, useValue: crypto.randomUUID() },
      ...optionProviders,
      {
        provide: CONTEXT_ENTRY,
        useFactory: (
          contextOptions: BunJobsContextOptions,
          registry: BunJobsRegistry,
        ) => {
          registry.declareContext(name);
          return buildEntry(contextOptions);
        },
        inject: [optionsToken, BunJobsRegistry],
      },
      {
        provide: contextToken,
        useFactory: (entry: ContextEntry) => entry.jobs,
        inject: [CONTEXT_ENTRY],
      },
      ...aliases.map((alias) => ({
        provide: alias,
        useExisting: contextToken,
      })),
      {
        provide: BunJobsContextOwner,
        useFactory: (entry: ContextEntry, registry: BunJobsRegistry) =>
          new BunJobsContextOwner(entry, registry),
        inject: [CONTEXT_ENTRY, BunJobsRegistry],
      },
      {
        provide: BunJobsExplorer,
        useFactory: (
          entry: ContextEntry,
          contextOptions: BunJobsContextOptions,
          registry: BunJobsRegistry,
          discovery: DiscoveryService,
          moduleRef: ModuleRef,
        ) => {
          const explorer = new BunJobsExplorer(
            name,
            entry.jobs,
            contextOptions,
            registry,
            discovery,
            moduleRef,
          );
          registry.addWorkers(explorer);
          return explorer;
        },
        inject: [
          CONTEXT_ENTRY,
          optionsToken,
          BunJobsRegistry,
          DiscoveryService,
          ModuleRef,
        ],
      },
      {
        provide: BunJobsLifecycle,
        useFactory: (registry: BunJobsRegistry) => registry.lifecycle,
        inject: [BunJobsRegistry],
      },
    ],
    exports: [contextToken, optionsToken, BunJobsLifecycle, ...aliases],
  };
}

/** The tokens one registration provides, and the queue and context it names. */
function targetOf(
  entry: Pick<RegisterQueueOptions, "name" | "context">,
  caller: string,
): {
  queue: string;
  context: string | undefined;
  tokens: readonly [InjectionToken, ...InjectionToken[]];
} {
  if (typeof entry.name === "string") {
    return {
      queue: entry.name,
      context: entry.context,
      tokens: [getQueueToken(entry.name, entry.context)],
    };
  }
  const { queue, context } = requireQueueToken(entry.name, caller);
  if (entry.context !== undefined && entry.context !== context) {
    throw new ConfigError(
      `${caller}: ${entry.name.name} is @QueueToken("${queue}"${context === undefined ? "" : `, "${context}"`}), but its registration says context "${entry.context}"`,
    );
  }
  return {
    queue,
    context,
    tokens: [entry.name, getQueueToken(queue, context)],
  };
}

/** What a queue provider's factory says when there is no context to take it from. */
function missingContext(
  queue: string,
  context: string | undefined,
): ConfigError {
  const forRoot =
    context === undefined
      ? "BunJobsModule.forRoot()"
      : `BunJobsModule.forRoot({ name: "${context}" })`;
  return new ConfigError(
    `BunJobsModule: queue "${queue}" is registered, but this module cannot see ${forRoot}. Import it once in the application; one with isGlobal: false reaches a queue through registerQueueAsync({ imports })`,
    { queue, context },
  );
}

/** Where a queue provider finds its context, or `undefined` for a clear error. */
function contextDependency(context: string | undefined) {
  return { token: getBunJobsToken(context), optional: true };
}

/** The handle `@InjectWorker()` injects for a queue. */
function workerRefProvider(
  queue: string,
  context: string | undefined,
): Provider {
  return {
    provide: getWorkerToken(queue, context),
    useFactory: (registry: BunJobsRegistry) =>
      registry.workerRef(context, queue),
    inject: [BunJobsRegistry],
  };
}

/** The first token an entry provides, and aliases of it for the others. */
function queueProviders(
  tokens: readonly [InjectionToken, ...InjectionToken[]],
  factory: Pick<FactoryProvider, "useFactory" | "inject">,
): Provider[] {
  const [first, ...others] = tokens;
  return [
    { provide: first, ...factory },
    ...others.map((token) => ({ provide: token, useExisting: first })),
  ];
}

/**
 * The bun-jobs context, and its queues, as a NestJS module: one `BunJobs`,
 * built from options or borrowed, with injectable queues.
 *
 * ```ts
 * @Module({
 *   imports: [
 *     BunJobsModule.forRoot({ namespace: "shop", driver: { type: "redis", url } }),
 *     BunJobsModule.registerQueue({ name: "emails" }),
 *   ],
 *   providers: [SignupService],
 * })
 * export class AppModule {}
 *
 * class SignupService {
 *   constructor(@InjectQueue("emails") private readonly emails: BunQueue<Email>) {}
 * }
 * ```
 *
 * A context the module built closes in `onApplicationShutdown`, after the HTTP
 * server has stopped; a borrowed one stays the application's. The checks run
 * in `onModuleInit`, and collect every problem into one bun-common
 * `ConfigError`: two `forRoot()`s for one context, two registrations of one
 * queue with different options, and decorator metadata that is off.
 */
export class BunJobsModule {
  /**
   * The module with its options given now. Takes every `BunJobs` option
   * (`namespace`, `driver`, …), or `jobs` to borrow a context, beside the
   * module's own.
   *
   * @param options See {@link BunJobsModuleOptions}.
   * @throws ConfigError on a `name` no token can hold.
   */
  static forRoot(options: BunJobsModuleOptions): DynamicModule {
    const { isGlobal, name, token, ...context } = options;
    return moduleOf(
      options,
      [
        {
          provide: getBunJobsOptionsToken(name),
          useFactory: () => context,
        },
      ],
      [],
    );
  }

  /**
   * The module with its options built while the application boots: by a
   * factory with injected providers (`useFactory` + `inject`), or by a
   * {@link BunJobsOptionsFactory} class (`useClass`, or an existing provider
   * with `useExisting`).
   *
   * @param options Where the options come from.
   * @throws ConfigError when none of the three is given, or on a `name` no
   * token can hold.
   */
  static forRootAsync(options: BunJobsModuleAsyncOptions): DynamicModule {
    const optionsToken = getBunJobsOptionsToken(options.name);
    const providers: Provider[] = [];
    if (options.useFactory !== undefined) {
      providers.push({
        provide: optionsToken,
        useFactory: options.useFactory,
        inject: [...(options.inject ?? [])],
      });
    } else {
      const factory = options.useExisting ?? options.useClass;
      if (factory === undefined) {
        throw new ConfigError(
          "BunJobsModule.forRootAsync(): give useFactory, useClass or useExisting",
        );
      }
      if (options.useExisting === undefined) {
        providers.push({ provide: factory, useClass: factory });
      }
      providers.push({
        provide: optionsToken,
        useFactory: async (made: BunJobsOptionsFactory) =>
          made.createBunJobsOptions(),
        inject: [factory],
      });
    }
    return moduleOf(options, providers, options.imports);
  }

  /**
   * Makes queues injectable, by name and, for a `@QueueToken()` class, by the
   * class. Each entry is a `{ name, context?, options? }` or a token class.
   * The module exports them, so import this where they are injected.
   *
   * @param queues The queues.
   */
  static registerQueue<TData = unknown, TResult = unknown>(
    ...queues: (RegisterQueueOptions<TData, TResult> | QueueTokenClass)[]
  ): DynamicModule {
    const providers: Provider[] = [
      { provide: MODULE_CALL, useValue: crypto.randomUUID() },
    ];
    const exported: InjectionToken[] = [];
    for (const entry of queues) {
      const registered = (
        typeof entry === "function" ? { name: entry } : entry
      ) as RegisterQueueOptions;
      const { queue, context, tokens } = targetOf(
        registered,
        "BunJobsModule.registerQueue()",
      );
      const declaration = {
        queue,
        context,
        options: registered.options,
        async: false,
      };
      providers.push(
        ...queueProviders(tokens, {
          useFactory: declareQueueFactory(
            (
              jobs: BunJobs<any, any> | undefined,
              registry: BunJobsRegistry,
            ): BunQueue<any, any, any, any> => {
              if (jobs === undefined) {
                throw missingContext(queue, context);
              }
              return registry.queue(declaration, jobs);
            },
            declaration,
          ),
          inject: [contextDependency(context), BunJobsRegistry],
        }),
        workerRefProvider(queue, context),
      );
      exported.push(...tokens, getWorkerToken(queue, context));
    }
    return {
      module: BunJobsModule,
      imports: [BunJobsRegistryModule],
      providers,
      exports: exported,
    };
  }

  /**
   * {@link registerQueue} with each queue's options built by a factory, with
   * injected providers.
   *
   * @param queues The queues.
   */
  static registerQueueAsync(
    ...queues: RegisterQueueAsyncOptions[]
  ): DynamicModule {
    const providers: Provider[] = [
      { provide: MODULE_CALL, useValue: crypto.randomUUID() },
    ];
    const exported: InjectionToken[] = [];
    const imports: DynamicModule["imports"] = [BunJobsRegistryModule];
    for (const entry of queues) {
      const { queue, context, tokens } = targetOf(
        entry,
        "BunJobsModule.registerQueueAsync()",
      );
      const declaration = { queue, context, async: true };
      imports.push(...(entry.imports ?? []));
      providers.push(
        ...queueProviders(tokens, {
          useFactory: declareQueueFactory(
            async (
              jobs: BunJobs<any, any> | undefined,
              registry: BunJobsRegistry,
              ...args: unknown[]
            ): Promise<BunQueue<any, any, any, any>> => {
              if (jobs === undefined) {
                throw missingContext(queue, context);
              }
              const { options } = await entry.useFactory(...args);
              return registry.queue(declaration, jobs, options);
            },
            declaration,
          ),
          inject: [
            contextDependency(context),
            BunJobsRegistry,
            ...(entry.inject ?? []),
          ],
        }),
        workerRefProvider(queue, context),
      );
      exported.push(...tokens, getWorkerToken(queue, context));
    }
    return { module: BunJobsModule, imports, providers, exports: exported };
  }

  /**
   * Runs a processor **file** as a worker the module owns: it starts and drains
   * with the others, in any bun-jobs `target`. This is the off-thread path: a
   * `@Process` method can only run in-process, because a function cannot be sent
   * to another thread or process. A queue takes a file or `@Processor` classes,
   * never both, since either would claim the other's jobs.
   *
   * @param worker The queue, the file and its options.
   */
  static registerWorker(worker: RegisterWorkerOptions): DynamicModule {
    const { queue, context } = targetOf(
      { name: worker.queue, context: worker.context },
      "BunJobsModule.registerWorker()",
    );
    return {
      module: BunJobsModule,
      imports: [BunJobsRegistryModule],
      providers: [
        { provide: MODULE_CALL, useValue: crypto.randomUUID() },
        {
          provide: REGISTERED_WORKER,
          useFactory: () =>
            new RegisteredWorker(
              queue,
              context,
              worker.processor,
              worker.options,
            ),
        },
        workerRefProvider(queue, context),
      ],
      exports: [getWorkerToken(queue, context)],
    };
  }
}

Module({})(BunJobsModule);
