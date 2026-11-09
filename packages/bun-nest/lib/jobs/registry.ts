import type {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  BunRunner,
  SummonController,
  SummonedArgs,
  SummonPolicy,
} from "@kingsleyweb/bun-jobs";
import type { ModulesContainer as Modules } from "@nestjs/core";
import type { StartableWorkers } from "./lifecycle";
import { ConfigError } from "@kingsleyweb/bun-common";
import { Inject, Injectable, Module } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { decoratorConfigProblem } from "./bootCheck";
import {
  NEST_PROPERTY_DEPS_METADATA,
  NEST_SELF_DECLARED_DEPS_METADATA,
} from "./metadata";
import { BunJobsLifecycle, WorkerRef } from "./lifecycle";

/**
 * The options a queue is created with: `jobs.queue()`'s, which are the queue's
 * own without what the context sets. Includes `schema` and `dataValidation`.
 *
 * @typeParam TData What `add` takes.
 * @typeParam TResult What a job's `returnValue` is.
 */
export type BunJobsQueueOptions<TData = unknown, TResult = unknown> = Omit<
  ConstructorParameters<typeof BunQueue<TData, TResult>>[1],
  "namespace" | "driver"
>;

/** One entry of `registerQueue()` or `registerQueueAsync()`. */
export interface QueueDeclaration {
  /** The queue's name. */
  readonly queue: string;
  /** The context's `name`; `undefined` for the default context. */
  readonly context: string | undefined;
  /**
   * The options, for an entry of `registerQueue()`. An entry of
   * `registerQueueAsync()` only knows them once its factory has run.
   */
  readonly options?: BunJobsQueueOptions;
  /** Whether this entry came from `registerQueueAsync()`. */
  readonly async: boolean;
}

/**
 * Which factory stands for which entry, so one scan of the modules finds every
 * `registerQueue()` entry before the first queue is created, whichever order
 * Nest builds their providers in.
 */
const DECLARATIONS = new WeakMap<object, QueueDeclaration>();

/** Records the entry a queue provider's factory stands for. */
export function declareQueueFactory<T extends object>(
  /** The provider's factory. */
  factory: T,
  /** Its entry. */
  declaration: QueueDeclaration,
): T {
  DECLARATIONS.set(factory, declaration);
  return factory;
}

/** Options a registration carries: an entry with none says nothing about them. */
function carried(
  options: BunJobsQueueOptions | undefined,
): BunJobsQueueOptions | undefined {
  return options !== undefined &&
    Object.values(options).some((value) => value !== undefined)
    ? options
    : undefined;
}

/**
 * Options that carry behaviour rather than data, compared by identity as
 * bun-jobs' own check does: comparing a logger's insides could walk a large
 * object graph.
 */
const IDENTITY_OPTIONS: ReadonlySet<string> = new Set([
  "logger",
  "dateParser",
  "publishGate",
  "schema",
]);

/** The keys on which two sets of queue options differ, sorted. */
export function differingOptions(
  /** One set. */
  left: BunJobsQueueOptions,
  /** The other. */
  right: BunJobsQueueOptions,
): string[] {
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) =>
      IDENTITY_OPTIONS.has(key)
        ? a[key] !== b[key]
        : !Bun.deepEquals(a[key], b[key]),
    )
    .sort();
}

/**
 * The problem with a `schema` that is a bare Standard Schema rather than
 * `{ data, result }`. The types refuse one, but anything typed `any` gets past them.
 * bun-jobs refuses it too, with its own error class and without the module's list.
 *
 * @returns The problem, or `undefined` when there is none.
 */
export function bareSchemaProblem(
  /** The `schema` option. */
  schema: unknown,
  /** Who was given it, for the message. */
  where: string,
): string | undefined {
  return typeof schema === "object" && schema !== null && "~standard" in schema
    ? `${where}: schema is { data, result }, and this is a bare schema, which would validate nothing. Write schema: { data: YourSchema }`
    : undefined;
}

/** One set of options a queue was registered with, and who by. */
interface Registration {
  /** The options. */
  readonly options: BunJobsQueueOptions;
  /** The modules that imported the registration. */
  readonly modules: readonly string[];
}

/** What is known of one queue in one context. */
interface QueueState {
  /** The queue's name. */
  readonly queue: string;
  /** The context's `name`; `undefined` for the default context. */
  readonly context: string | undefined;
  /** Registrations that carry options, in the order they became known. */
  readonly registrations: Registration[];
  /** The modules that imported a registration carrying none. */
  readonly bare: string[];
  /** Whether the queue has been created. */
  created: boolean;
}

/** How a context reads in a message. */
function contextLabel(context: string | undefined): string {
  return context === undefined ? "default context" : `context "${context}"`;
}

/**
 * What every `BunJobsModule` of one application shares: which contexts exist,
 * which queues are registered and with what, and so what is wrong with them.
 * One per application, through {@link BunJobsRegistryModule}.
 */
export class BunJobsRegistry {
  /** The workers built so far, by context and queue. */
  readonly #workers = new Map<string, BunQueueWorker<any, any, any>>();
  /** The controllers `registerQueue()` built, by context. */
  readonly #controllers = new Map<string | undefined, Set<SummonController>>();
  /** The summon policies `registerQueue()` was given, by context and queue. */
  readonly #summons = new Map<string, SummonPolicy>();
  /** What was wrong with them. */
  readonly #summonProblems: string[] = [];
  /** The runners `registerRunner()` built, by context. */
  readonly #runners = new Map<string | undefined, Set<BunRunner<any, any>>>();
  /** Each context's workers, for {@link lifecycle}. */
  readonly #startable = new Set<StartableWorkers>();
  /** Starts and stops every context's workers by hand. */
  readonly lifecycle = new BunJobsLifecycle(() => this.#startable);
  /** Every queue known, by context and name. */
  readonly #queues = new Map<string, QueueState>();
  /** How many times each context was declared. */
  readonly #contexts = new Map<string | undefined, number>();
  /** The modules that imported each entry, from the scan. */
  readonly #sites = new Map<QueueDeclaration, readonly string[]>();
  /** Whether the modules have been scanned. */
  #scanned = false;

  constructor(
    /** The application's modules. */
    private readonly modules: Modules,
  ) {}

  /** Records that a `forRoot()` or `forRootAsync()` provides a context. */
  declareContext(
    /** The context's `name`; `undefined` for the default context. */
    context: string | undefined,
  ): void {
    this.#contexts.set(context, (this.#contexts.get(context) ?? 0) + 1);
  }

  /**
   * Whether any class or factory in the application asks for a token, from what its
   * `@Inject()`s wrote: every module is scanned by the time a provider is built.
   */
  isRequested(
    /** The token. */
    token: unknown,
  ): boolean {
    for (const module of this.modules.values()) {
      for (const { metatype, inject } of [
        ...module.providers.values(),
        ...module.controllers.values(),
        ...module.injectables.values(),
      ]) {
        const asked = (inject ?? []) as unknown[];
        if (asked.includes(token)) {
          return true;
        }
        if (typeof metatype !== "function") {
          continue;
        }
        const params = (Reflect.getMetadata(
          NEST_SELF_DECLARED_DEPS_METADATA,
          metatype,
        ) ?? []) as { param: unknown }[];
        const properties = (Reflect.getMetadata(
          NEST_PROPERTY_DEPS_METADATA,
          metatype,
        ) ?? []) as { type: unknown }[];
        if (
          params.some(({ param }) => param === token) ||
          properties.some(({ type }) => type === token)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /** Whether a `forRoot()` or `forRootAsync()` provides this context. */
  hasContext(
    /** The context's `name`; `undefined` for the default context. */
    context: string | undefined,
  ): boolean {
    return this.#contexts.has(context);
  }

  /** Records a runner `registerRunner()` built, for its context's explorer to start. */
  addRunner(
    /** The context's `name`; `undefined` for the default context. */
    context: string | undefined,
    /** The runner. */
    runner: BunRunner<any, any>,
  ): void {
    const runners = this.#runners.get(context) ?? new Set();
    runners.add(runner);
    this.#runners.set(context, runners);
  }

  /** The runners `registerRunner()` built for a context. */
  runnersOf(
    /** The context's `name`; `undefined` for the default context. */
    context: string | undefined,
  ): readonly BunRunner<any, any>[] {
    return [...(this.#runners.get(context) ?? [])];
  }

  /**
   * A queue's summon controller, for `registerQueue`: built from a policy given there,
   * or the one the context's `summon` option built, and `undefined` when there is neither
   * and nothing asked for it. One queue has one controller, so a second policy for it is
   * a problem at boot, as bun-jobs' own "named twice" rule is for its option.
   *
   * @throws ConfigError when a class asks for a controller and no policy exists.
   */
  summonController(
    /** The context's `name`; `undefined` for the default context. */
    context: string | undefined,
    /** The queue. */
    queue: string,
    /** The policy `registerQueue` was given. */
    policy: SummonPolicy | undefined,
    /** The context. */
    jobs: BunJobs<any, any>,
    /** Whether a class asks for it. */
    requested: boolean,
  ): SummonController | undefined {
    if (policy === undefined) {
      return requested ? jobs.summonController(queue) : undefined;
    }
    const key = `${context ?? ""}\0${queue}`;
    const known = this.#summons.get(key);
    if (known !== undefined) {
      if (known !== policy) {
        this.#summonProblems.push(
          `queue "${queue}" is given two summon policies by registerQueue. One queue has one controller, so give one`,
        );
      }
      return jobs.summonController(queue);
    }
    let existing: SummonController | undefined;
    try {
      existing = jobs.summonController(queue);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "NO_SUMMON_POLICY") {
        throw error;
      }
    }
    if (existing !== undefined) {
      this.#summonProblems.push(
        `queue "${queue}" is named by the context's summon option and by registerQueue. One queue has one controller, so give one`,
      );
      return existing;
    }
    this.#summons.set(key, policy);
    const controller = jobs.summonController(queue, policy);
    const built = this.#controllers.get(context) ?? new Set();
    built.add(controller);
    this.#controllers.set(context, built);
    return controller;
  }

  /** The summon controllers `registerQueue` built for a context. */
  controllersOf(
    /** The context's `name`; `undefined` for the default context. */
    context: string | undefined,
  ): readonly SummonController[] {
    return [...(this.#controllers.get(context) ?? [])];
  }

  /**
   * The workers a summoned process runs: one per queue its summon names, built with the
   * summon on them.
   *
   * @throws ConfigError when a queue it names has no worker here, naming them.
   */
  summonedWorkers(
    /** This process's summon. */
    summon: SummonedArgs,
  ): BunQueueWorker<any, any, any>[] {
    const contexts = [...this.#startable]
      .filter(
        ({ namespace }) =>
          summon.namespace === undefined || summon.namespace === namespace,
      )
      .map(({ context }) => context);
    const queues = summon.queues ?? [];
    const found = queues.flatMap((queue) =>
      contexts.flatMap((context) => {
        const worker = this.#workers.get(`${context ?? ""}\0${queue}`);
        return worker === undefined ? [] : [{ queue, worker }];
      }),
    );
    const missing = queues.filter(
      (queue) => !found.some((entry) => entry.queue === queue),
    );
    if (missing.length > 0) {
      throw new ConfigError(
        `runSummonedApplication: the summon names ${missing.map((queue) => `queue "${queue}"`).join(", ")}${summon.namespace === undefined ? "" : ` in namespace "${summon.namespace}"`}, and no @Processor or registerWorker in this module consumes it. A BunJobsModule.forRoot on that namespace, with a processor on it, is what runs it`,
        { missing },
      );
    }
    return found.map(({ worker }) => worker);
  }

  /** Records a context's workers, for {@link lifecycle}. */
  addWorkers(
    /** Starts and stops them. */
    workers: StartableWorkers,
  ): void {
    this.#startable.add(workers);
  }

  /** Records the worker serving a queue. */
  bindWorker(
    /** The context's `name`; `undefined` for the default context. */
    context: string | undefined,
    /** The queue. */
    queue: string,
    /** The worker. */
    worker: BunQueueWorker<any, any, any>,
  ): void {
    this.#workers.set(`${context ?? ""}\0${queue}`, worker);
  }

  /** The handle on the worker serving a queue, which it finds when asked. */
  workerRef(
    /** The context's `name`; `undefined` for the default context. */
    context: string | undefined,
    /** The queue. */
    queue: string,
  ): WorkerRef {
    return new WorkerRef(queue, () =>
      this.#workers.get(`${context ?? ""}\0${queue}`),
    );
  }

  /**
   * The queue for one registration, created with the options the application
   * registered for it, whichever registration Nest happens to build first.
   */
  queue(
    /** The entry. */
    declaration: QueueDeclaration,
    /** The context to take it from. */
    jobs: BunJobs<any, any>,
    /** An async entry's options, from its factory. */
    resolved?: BunJobsQueueOptions,
  ): BunQueue<any, any, any, any> {
    this.#scan();
    const state = this.#state(declaration.queue, declaration.context);
    if (declaration.async) {
      this.#record(
        state,
        carried(resolved),
        this.#sites.get(declaration) ?? [],
      );
    }
    if (state.created) {
      return jobs.queue<unknown, unknown>(declaration.queue);
    }
    state.created = true;
    const options = state.registrations[0]?.options;
    // bun-jobs refuses this too, with its own error class: say it in ours,
    // since providers are built before the boot check collects its problems.
    const bare = bareSchemaProblem(
      (options as { schema?: unknown } | undefined)?.schema,
      `queue "${declaration.queue}"`,
    );
    if (bare !== undefined) {
      throw new ConfigError(bare);
    }
    return jobs.queue<unknown, unknown>(declaration.queue, options);
  }

  /** Everything wrong that the application's registrations show, one line each. */
  problems(): string[] {
    this.#scan();
    const problems: string[] = [...this.#summonProblems];
    const decorators = decoratorConfigProblem(this.modules);
    if (decorators !== undefined) {
      problems.push(decorators);
    }
    for (const [context, count] of this.#contexts) {
      if (count > 1) {
        problems.push(
          `${contextLabel(context)} is provided by ${count} forRoot()/forRootAsync() calls: one context takes one, so give the others a name`,
        );
      }
    }
    for (const state of this.#queues.values()) {
      for (const { options } of state.registrations) {
        const bare = bareSchemaProblem(
          (options as { schema?: unknown }).schema,
          `queue "${state.queue}"`,
        );
        if (bare !== undefined) {
          problems.push(bare);
        }
      }
      const [first, ...others] = state.registrations;
      if (first === undefined) {
        continue;
      }
      const differing = new Set(
        others.flatMap(({ options }) =>
          differingOptions(first.options, options),
        ),
      );
      if (differing.size > 0) {
        const modules = [
          ...new Set(state.registrations.flatMap(({ modules }) => modules)),
        ];
        problems.push(
          `queue "${state.queue}" in the ${contextLabel(state.context)} is registered with different options (${[...differing].sort().join(", ")}) by ${modules.join(" and ")}. A queue's options apply only when it is created, so give it one set, in one registration or the same in each`,
        );
      }
    }
    return problems;
  }

  /** The state of one queue. */
  #state(queue: string, context: string | undefined): QueueState {
    const key = `${context ?? ""}\0${queue}`;
    let state = this.#queues.get(key);
    if (state === undefined) {
      state = { queue, context, registrations: [], bare: [], created: false };
      this.#queues.set(key, state);
    }
    return state;
  }

  /**
   * Records one registration. An async entry may arrive after a bare one
   * created the queue with nothing: its options then differ from what the
   * queue has, and {@link problems} says so rather than losing them.
   */
  #record(
    state: QueueState,
    options: BunJobsQueueOptions | undefined,
    modules: readonly string[],
  ): void {
    if (options === undefined) {
      state.bare.push(...modules);
      return;
    }
    if (state.created && state.registrations.length === 0) {
      state.registrations.push({ options: {}, modules: state.bare });
    }
    state.registrations.push({ options, modules });
  }

  /** Finds every entry, and who imported it, once the application is scanned. */
  #scan(): void {
    if (this.#scanned) {
      return;
    }
    this.#scanned = true;
    for (const module of this.modules.values()) {
      for (const { metatype } of module.providers.values()) {
        const declaration =
          typeof metatype === "function"
            ? DECLARATIONS.get(metatype)
            : undefined;
        if (declaration === undefined) {
          continue;
        }
        const importers = [...this.modules.values()]
          .filter((candidate) => candidate.imports.has(module))
          .map((candidate) => candidate.metatype.name);
        this.#sites.set(declaration, importers);
        const state = this.#state(declaration.queue, declaration.context);
        if (!declaration.async) {
          this.#record(state, carried(declaration.options), importers);
        }
      }
    }
  }
}

// `@Injectable()` and `@Inject(...)` by call: Bun reads the decorator options
// from the working directory's tsconfig (oven-sh/bun#28605), and the call
// behaves the same under either decorator semantics.
Injectable()(BunJobsRegistry);
Inject(ModulesContainer)(BunJobsRegistry, undefined, 0);

/**
 * Provides the one {@link BunJobsRegistry} of an application. A static module,
 * so however many `BunJobsModule`s import it, Nest builds it once.
 */
export class BunJobsRegistryModule {}
Module({
  providers: [BunJobsRegistry],
  exports: [BunJobsRegistry],
})(BunJobsRegistryModule);

/**
 * Throws everything wrong with the application's registrations as one
 * `ConfigError`, every problem listed rather than the first alone.
 *
 * @throws ConfigError when there is any problem.
 */
export function assertNoProblems(
  /** The problems found. */
  problems: readonly string[],
): void {
  if (problems.length === 0) {
    return;
  }
  throw new ConfigError(
    `BunJobsModule: ${problems.length} problem${problems.length === 1 ? "" : "s"} at boot:\n- ${problems.join("\n- ")}`,
    { problems: [...problems] },
  );
}
