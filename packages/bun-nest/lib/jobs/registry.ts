import type { BunJobs, BunQueue } from "@kingsleyweb/bun-jobs";
import type { ModulesContainer as Modules } from "@nestjs/core";
import { ConfigError } from "@kingsleyweb/bun-common";
import { Inject, Injectable, Module } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { decoratorConfigProblem } from "./bootCheck";

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
    return jobs.queue<unknown, unknown>(
      declaration.queue,
      state.registrations[0]?.options,
    );
  }

  /** Everything wrong that the application's registrations show, one line each. */
  problems(): string[] {
    this.#scan();
    const problems: string[] = [];
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
