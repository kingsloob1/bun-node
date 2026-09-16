import type { BunQueue } from "../queue/BunQueue";
import type { BunRunner } from "../runner/BunRunner";
import type { ResolvedJobsApiConfig } from "./config";
import { RemoteRunner } from "../runner/RemoteRunner";
import { ConfigError } from "../shared/errors";
import { assertSegment } from "../shared/keys";
import { ApiError } from "./errors";

/**
 * Where the API finds the queues and runners a request names.
 *
 * The check comes before the lookup for a reason: `jobs.queue(name)` caches an
 * instance per name for good, so calling it with every name a client sends
 * would grow that cache without bound. A name is therefore validated as a key
 * segment, then checked against the known set, and only then resolved.
 */

/** Which kind of name a segment is. */
export type SegmentKind = "queue" | "runner";

/**
 * Validates a path segment as a queue name or runner id, with exactly the rule
 * the drivers use for keys (`assertSegment`). A bad one is a 400
 * `INVALID_NAME`, raised before any backend is touched.
 */
export function parseSegment(value: unknown, kind: SegmentKind): string {
  try {
    return assertSegment(
      value as string,
      kind === "queue" ? "queue name" : "runner id",
    );
  } catch (error) {
    if (error instanceof ConfigError) {
      // The message states the rule; the offending value is not echoed back.
      throw new ApiError("INVALID_NAME", 400, error.message, {
        context: { kind },
      });
    }
    throw error;
  }
}

/** A set of names read from the backend, remembered for a while. */
class TtlSet {
  /** The last set read, and when. */
  #cached: { names: ReadonlySet<string>; at: number } | undefined;
  /** The read in flight, shared by concurrent callers. */
  #inflight: Promise<ReadonlySet<string>> | undefined;
  /**
   * Bumped by {@link clear}. A read started before a clear finishes into a
   * different generation and is not cached — otherwise an invalidation that
   * arrived mid-read would be undone by the stale answer landing after it.
   */
  #generation = 0;

  constructor(
    /** Reads the current names. */
    private readonly load: () => Promise<readonly string[]>,
    /** How long a read is reused, in ms. */
    private readonly ttlMs: number,
    /** The clock. */
    private readonly now: () => number,
  ) {}

  /** The names, from cache when fresh. */
  async get(): Promise<ReadonlySet<string>> {
    const cached = this.#cached;
    if (cached && this.ttlMs > 0 && this.now() - cached.at < this.ttlMs) {
      return cached.names;
    }
    if (!this.#inflight) {
      const generation = this.#generation;
      const load = this.load().then((names) => {
        const set = new Set(names);
        if (generation === this.#generation) {
          this.#cached = { names: set, at: this.now() };
        }
        return set;
      });
      this.#inflight = load;
      const settle = () => {
        if (this.#inflight === load) {
          this.#inflight = undefined;
        }
      };
      load.then(settle, settle);
    }
    return await this.#inflight;
  }

  /**
   * Forgets the cached read, and any read in flight: the next {@link get}
   * reads the backend afresh, and an older read still in flight is not cached.
   */
  clear(): void {
    this.#generation++;
    this.#cached = undefined;
    this.#inflight = undefined;
  }
}

/** Options for the sources. */
export interface SourceOptions {
  /** The clock used for cache expiry. Defaults to `Date.now`. */
  now?: () => number;
}

/** The queues a configuration can reach. */
export class QueueSource {
  /** The resolved configuration. */
  readonly #config: Pick<ResolvedJobsApiConfig, "jobs" | "queues" | "limits">;
  /** Known names, when they come from the backend. */
  readonly #known: TtlSet | undefined;

  constructor(
    config: Pick<ResolvedJobsApiConfig, "jobs" | "queues" | "limits">,
    options?: SourceOptions,
  ) {
    this.#config = config;
    const jobs = config.jobs;
    this.#known =
      config.queues === "all" && jobs
        ? new TtlSet(
            () => jobs.listQueues(),
            config.limits.queueCacheMs,
            options?.now ?? Date.now,
          )
        : undefined;
  }

  /** Every reachable queue name, sorted. */
  async names(): Promise<string[]> {
    const names = this.#known
      ? await this.#known.get()
      : (this.#config.queues as ReadonlyMap<string, unknown>).keys();
    return [...names].sort();
  }

  /** Whether a (valid) name is reachable. */
  async has(name: string): Promise<boolean> {
    if (this.#known) {
      return (await this.#known.get()).has(name);
    }
    return (this.#config.queues as ReadonlyMap<string, unknown>).has(name);
  }

  /**
   * The queue a request names: validated (400 `INVALID_NAME`), checked for
   * membership (404 `QUEUE_NOT_FOUND`), and only then resolved.
   */
  async get(value: unknown): Promise<BunQueue<any, any, any>> {
    const name = parseSegment(value, "queue");
    if (!(await this.has(name))) {
      throw new ApiError(
        "QUEUE_NOT_FOUND",
        404,
        `Queue "${name}" was not found`,
        { context: { queue: name } },
      );
    }
    const configured =
      this.#config.queues === "all" ? undefined : this.#config.queues.get(name);
    if (configured) {
      return configured;
    }
    const jobs = this.#config.jobs;
    if (!jobs) {
      // resolveConfig refuses names without `jobs`; reaching here is a bug.
      throw new ConfigError(
        `Queue "${name}" has no instance and there is no \`jobs\` to build one`,
      );
    }
    return jobs.queue(name);
  }

  /** Forgets the cached queue list, so the next check reads the backend. */
  invalidate(): void {
    this.#known?.clear();
  }
}

/**
 * A runner a request names, with a controller that works wherever the runner
 * is registered: this process (the controller delegates to it) or another one
 * sharing the driver and namespace (the controller goes through the backend).
 */
export type ResolvedRunner =
  | {
      /** Registered in this process. */
      local: true;
      /** The runner's id. */
      id: string;
      /** Controls it; delegates to {@link runner}. */
      controller: RemoteRunner<any, any>;
      /** The runner itself, for what only its own process can do (kill, reset stats). */
      runner: BunRunner<any, any>;
    }
  | {
      /** Registered in another process only. */
      local: false;
      /** The runner's id. */
      id: string;
      /** Controls it through the backend. There is no remote kill. */
      controller: RemoteRunner<any, any>;
    };

/** Why a runner operation needs the runner in this process, for the 409 detail. */
export type LocalOnlyOperation = "kill" | "resetStats";

/** The runners a configuration can reach. */
export class RunnerSource {
  /** The resolved configuration. */
  readonly #config: Pick<ResolvedJobsApiConfig, "runners" | "limits">;
  /** Ids the backend knows, when a manager can discover them. */
  readonly #discovered: TtlSet | undefined;

  constructor(
    config: Pick<ResolvedJobsApiConfig, "runners" | "limits">,
    options?: SourceOptions,
  ) {
    this.#config = config;
    const manager = this.#manager();
    this.#discovered = manager
      ? new TtlSet(
          () => manager.discover(),
          config.limits.queueCacheMs,
          options?.now ?? Date.now,
        )
      : undefined;
  }

  /** The configured manager, when runners come from one rather than a fixed list. */
  #manager() {
    const runners = this.#config.runners;
    return runners === false || Array.isArray(runners)
      ? undefined
      : (runners as Exclude<typeof runners, false | readonly unknown[]>);
  }

  /** Runners registered in this process. */
  local(): BunRunner<any, any>[] {
    const runners = this.#config.runners;
    if (runners === false) {
      return [];
    }
    return Array.isArray(runners) ? [...runners] : this.#manager()!.list();
  }

  /**
   * Every reachable runner: the local ones, and the ids only the backend knows
   * (runners registered by other processes). A fixed list of runners
   * discovers nothing beyond itself.
   */
  async list(): Promise<{ local: BunRunner<any, any>[]; remote: string[] }> {
    const local = this.local();
    if (!this.#discovered) {
      return { local, remote: [] };
    }
    const localIds = new Set(local.map((runner) => runner.id));
    const remote = [...(await this.#discovered.get())]
      .filter((id) => !localIds.has(id))
      .sort();
    return { local, remote };
  }

  /**
   * The runner a request names, with a controller: validated (400
   * `INVALID_NAME`), then found here or in the backend, or 404
   * `RUNNER_NOT_FOUND`. With a fixed list of runners, only those are found.
   *
   * A runner in another process is looked up in the same cached discovery
   * {@link list} uses (`limits.queueCacheMs`), not with a backend read per
   * request. `RemoteRunner` still checks the runner exists on each call it
   * makes; that check is the runner package's, not this cache's.
   */
  async resolve(value: unknown): Promise<ResolvedRunner> {
    const id = parseSegment(value, "runner");
    const manager = this.#manager();

    if (manager) {
      const runner = manager.get(id);
      if (runner) {
        return {
          local: true,
          id,
          runner,
          controller: new RemoteRunner({
            id,
            namespace: manager.namespace,
            local: runner,
          }),
        };
      }
      if (!manager.driver || !(await this.#discovered!.get()).has(id)) {
        throw notFound(id);
      }
      return {
        local: false,
        id,
        controller: new RemoteRunner({
          id,
          namespace: manager.namespace,
          driver: manager.driver,
        }),
      };
    }

    const runner = this.local().find((candidate) => candidate.id === id);
    if (!runner) {
      throw notFound(id);
    }
    const controller = new RemoteRunner({
      id,
      namespace: runner.namespace,
      local: runner,
    });
    return { local: true, id, controller, runner };
  }

  /**
   * The runner a request names, for the operations only its own process can
   * perform — killing a run, resetting stats. A runner registered only in
   * another process is 409 `RUNNER_NOT_LOCAL`.
   */
  async requireLocal(
    value: unknown,
    operation: LocalOnlyOperation,
  ): Promise<BunRunner<any, any>> {
    const resolved = await this.resolve(value);
    if (!resolved.local) {
      throw new ApiError(
        "RUNNER_NOT_LOCAL",
        409,
        `Runner "${resolved.id}" is registered in another process; only that process can ${operation === "kill" ? "kill its runs" : "reset its stats"}`,
        { context: { runner: resolved.id, operation } },
      );
    }
    return resolved.runner;
  }

  /** Forgets the cached discovery, so the next list reads the backend. */
  invalidate(): void {
    this.#discovered?.clear();
  }
}

/** The 404 for a runner id nothing knows. */
function notFound(id: string): ApiError {
  return new ApiError("RUNNER_NOT_FOUND", 404, `Runner "${id}" was not found`, {
    context: { runner: id },
  });
}
