import type { JobsDriver } from "../drivers/index";
import type { LoggerLike } from "../shared/logger";
import type { BunRunnerOptions, RunnerInfo } from "./types";
import { ConfigError } from "../shared/errors";
import { assertNamespace } from "../shared/keys";
import { BunRunner } from "./BunRunner";

/** Options for a {@link BunRunnerManager}. */
export interface BunRunnerManagerOptions {
  /** The namespace every runner in this manager belongs to. */
  namespace: string;
  /** Driver shared by runners the manager creates. */
  driver?: JobsDriver;
  /** Logger passed to runners the manager creates. */
  logger?: LoggerLike;
}

/**
 * A registry of runners in one namespace.
 *
 * A service typically has several — cleanups, syncs, report generation — and
 * needs to start and stop them together, list them for an admin endpoint, and
 * be sure two of them never share an id. Holding them in a plain `Map` (as
 * the implementation this replaces did) loses the last part: a duplicate id
 * silently overwrote a runner, and both carried on using the same lock.
 *
 * Everything here is namespace-scoped, so a service's admin surface can only
 * reach its own runners.
 */
export class BunRunnerManager {
  /** The namespace every runner here belongs to. */
  readonly namespace: string;
  /** Driver shared by runners this manager creates. */
  readonly driver?: JobsDriver;

  /** Registered runners, by id. */
  readonly #runners = new Map<string, BunRunner<any, any>>();
  /** Logger passed to runners this manager creates. */
  readonly #logger?: LoggerLike;

  constructor(options: BunRunnerManagerOptions) {
    this.namespace = assertNamespace(options.namespace);
    this.driver = options.driver;
    this.#logger = options.logger;
  }

  /** How many runners are registered. */
  get size(): number {
    return this.#runners.size;
  }

  /**
   * Registers a runner, or builds one from options using the manager's
   * namespace and driver. A duplicate id is a {@link ConfigError}, and so is
   * a ready-made runner from another namespace — either would mean two
   * runners quietly sharing (or missing) a lock.
   */
  add<TArgs = unknown, TResult = unknown>(
    runnerOrOptions:
      | BunRunner<TArgs, TResult>
      | (Omit<BunRunnerOptions<TArgs>, "namespace"> & { namespace?: string }),
  ): BunRunner<TArgs, TResult> {
    const runner =
      runnerOrOptions instanceof BunRunner
        ? runnerOrOptions
        : new BunRunner<TArgs, TResult>({
            ...(runnerOrOptions as BunRunnerOptions<TArgs>),
            namespace: this.namespace,
            driver:
              (runnerOrOptions as BunRunnerOptions<TArgs>).driver ??
              this.driver,
            logger:
              (runnerOrOptions as BunRunnerOptions<TArgs>).logger ??
              this.#logger,
          });

    if (runner.namespace !== this.namespace) {
      throw new ConfigError(
        `Runner "${runner.id}" belongs to namespace "${runner.namespace}", not "${this.namespace}"`,
        { id: runner.id, namespace: runner.namespace },
      );
    }

    if (this.#runners.has(runner.id)) {
      throw new ConfigError(
        `A runner with id "${runner.id}" is already registered`,
        {
          id: runner.id,
        },
      );
    }

    this.#runners.set(runner.id, runner);
    return runner;
  }

  /** One runner by id. */
  get<TArgs = unknown, TResult = unknown>(
    id: string,
  ): BunRunner<TArgs, TResult> | undefined {
    return this.#runners.get(id) as BunRunner<TArgs, TResult> | undefined;
  }

  /** Every registered runner. */
  list(): BunRunner<any, any>[] {
    return [...this.#runners.values()];
  }

  /** Unregisters a runner, stopping it first unless told not to. */
  async remove(id: string, options?: { stop?: boolean }): Promise<boolean> {
    const runner = this.#runners.get(id);
    if (!runner) {
      return false;
    }

    if (options?.stop !== false) {
      await runner.stop();
    }

    return this.#runners.delete(id);
  }

  /** Starts every registered runner. */
  async startAll(): Promise<void> {
    await Promise.all(this.list().map((runner) => runner.start()));
  }

  /**
   * Stops every registered runner. Failures are collected rather than thrown
   * one at a time, so one stuck runner cannot leave the rest running.
   */
  async stopAll(options?: {
    timeout?: number;
    force?: boolean;
  }): Promise<void> {
    const results = await Promise.allSettled(
      this.list().map((runner) => runner.stop(options)),
    );

    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason as Error),
        `${failures.length} runner(s) failed to stop`,
      );
    }
  }

  /** A snapshot of every registered runner. */
  async info(): Promise<RunnerInfo[]> {
    return await Promise.all(this.list().map((runner) => runner.info()));
  }

  /** Runner ids the backend knows about, including other processes'. */
  async discover(): Promise<string[]> {
    if (!this.driver) {
      return this.list().map((runner) => runner.id);
    }

    return await this.driver.listRunners(this.namespace);
  }
}
