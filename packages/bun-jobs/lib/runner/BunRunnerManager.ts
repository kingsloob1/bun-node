import type { JobsDriver } from "../drivers/index";
import type { LoggerLike } from "../shared/logger";
import type { BunRunnerOptions, RunnerInfo } from "./types";
import { ConfigError, RunnerNotFoundError } from "../shared/errors";
import { assertNamespace, assertSegment } from "../shared/keys";
import { BunRunner } from "./BunRunner";
import { RunnerController } from "./RunnerController";

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
 *
 * **Registration here is process-local; the backend's is permanent.** A
 * runner also has a record in the driver, written by every `start()` and read
 * by {@link discover}, {@link controller} and the management API. Nothing ever
 * removes that record — not {@link remove}, not stopping the runner, not the
 * process exiting — because it carries what the cluster has decided about the
 * runner (paused, schedule, configuration overrides), which has to outlive
 * every process that holds it. A runner's *liveness* is its run lock, not its
 * record. Workers are deliberately the opposite: a `WorkerInfo` is a
 * heartbeat, so it expires and a worker leaves `listWorkers()` when it closes.
 * The only thing that erases a runner record is `driver.purge(namespace)`,
 * which erases the whole namespace, jobs and all.
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
  add<
    TArgs = unknown,
    TResult = unknown,
    TToHandler = unknown,
    TFromHandler = unknown,
  >(
    runnerOrOptions:
      | BunRunner<TArgs, TResult, TToHandler, TFromHandler>
      | (Omit<BunRunnerOptions<TArgs>, "namespace"> & { namespace?: string }),
  ): BunRunner<TArgs, TResult, TToHandler, TFromHandler> {
    const runner =
      runnerOrOptions instanceof BunRunner
        ? runnerOrOptions
        : new BunRunner<TArgs, TResult, TToHandler, TFromHandler>({
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
  get<
    TArgs = unknown,
    TResult = unknown,
    TToHandler = unknown,
    TFromHandler = unknown,
  >(
    id: string,
  ): BunRunner<TArgs, TResult, TToHandler, TFromHandler> | undefined {
    // The registry holds runners of every declared type, so the caller names
    // the one it registered; nothing at runtime can check it.
    return this.#runners.get(id) as
      | BunRunner<TArgs, TResult, TToHandler, TFromHandler>
      | undefined;
  }

  /** Every registered runner. */
  list(): BunRunner<any, any>[] {
    return [...this.#runners.values()];
  }

  /**
   * Drops a runner from **this manager**, stopping it first unless told not
   * to. Returns `false` when the id is not registered here.
   *
   * It does not unregister the runner from the backend. Its record stays, so
   * `driver.listRunners()` — and with it {@link discover}, {@link controller},
   * the management API's `GET /runners/<id>` and every runner mutation —
   * still answers for the id, and the runner stays remotely controllable: a
   * pause or a rescheduled cron set on it is still stored, and is still
   * adopted by whichever process registers that id next. That is deliberate:
   * the record carries intent that has to outlive the processes holding the
   * runner, not liveness — liveness is the run lock. `driver.purge()`, which
   * erases the whole namespace, is the only thing that erases it.
   */
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

  /**
   * A controller for a runner registered by **any** process sharing this
   * manager's driver and namespace: `info`, `pause`, `resume`,
   * `updateSchedule`, `trigger`, `history` and `stats`.
   *
   * When the runner is registered here the controller delegates to it;
   * otherwise it works through the backend alone — see {@link RunnerController}
   * for how each call reaches the owning process, and how soon. A run cannot
   * be killed remotely: only the process executing it can stop it.
   *
   * Rejects with {@link RunnerNotFoundError} when the id is neither
   * registered here nor known to the backend, and with a `ConfigError` when
   * it is not a valid runner id.
   */
  async controller<TArgs = unknown, TResult = unknown>(
    id: string,
  ): Promise<RunnerController<TArgs, TResult>> {
    assertSegment(id, "runner id");
    // As with get(): the caller names the types it registered the runner with.
    const local = this.get<TArgs, TResult>(id);

    if (!local && !this.driver) {
      throw new RunnerNotFoundError(id, this.namespace, {
        reason: "not registered, and the manager has no driver to ask",
      });
    }

    const controller = new RunnerController<TArgs, TResult>({
      id,
      namespace: this.namespace,
      driver: this.driver,
      local,
      logger: this.#logger,
    });

    if (!(await controller.exists())) {
      throw new RunnerNotFoundError(id, this.namespace);
    }

    return controller;
  }

  /** Runner ids the backend knows about, including other processes'. */
  async discover(): Promise<string[]> {
    if (!this.driver) {
      return this.list().map((runner) => runner.id);
    }

    return await this.driver.listRunners(this.namespace);
  }
}
