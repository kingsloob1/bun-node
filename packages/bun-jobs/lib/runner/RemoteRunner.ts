import type { JobsDriver } from "../drivers/index";
import type { RunnerControlAction } from "../shared/events";
import type { Logger, LoggerLike } from "../shared/logger";
import type { RunnerSchedule, ScheduleInput } from "../shared/schedule";
import type { BunRunner } from "./BunRunner";
import type {
  RemoteRunnerInfo,
  RemoteRunRecord,
  RunnerStats,
  TriggerOutcome,
} from "./types";
import { DEFAULT_LOCK_TTL, DEFAULT_MAX_QUEUED_RUNS } from "../shared/constants";
import { RunnerNotFoundError } from "../shared/errors";
import { runnerEvent } from "../shared/events";
import { newId, newToken, parseToken } from "../shared/ids";
import { assertNamespace, assertSegment, runnerKey } from "../shared/keys";
import { createJobsLogger } from "../shared/logger";
import { nextFireDate, normalizeSchedule } from "../shared/schedule";

/** Options for a {@link RemoteRunner}. */
export interface RemoteRunnerOptions<TArgs = unknown, TResult = unknown> {
  /** The runner's id. */
  id: string;
  /** The namespace the runner belongs to. */
  namespace: string;
  /**
   * The driver the runner's owners use. Required unless `local` is given, in
   * which case the local runner's driver is used.
   */
  driver?: JobsDriver;
  /**
   * The runner, when it is registered in this process. Operations delegate to
   * it, so a local controller behaves exactly as the runner itself does.
   */
  local?: BunRunner<TArgs, TResult>;
  /** Logger for publish failures, or anything `resolveLogger` accepts. No-op by default. */
  logger?: LoggerLike;
}

/** The counters a runner keeps in its state, without the `stat:` prefix. */
const STAT_FIELDS = [
  "success",
  "failed",
  "timeout",
  "killed",
  "skipped",
  "queued",
  "total",
] as const;

/**
 * Controls a runner registered by **any** process sharing the driver and
 * namespace — this one or another. Get one with
 * `BunRunnerManager.remote(id)`.
 *
 * ```ts
 * const cleanup = await jobs.runners.remote<CleanupArgs>("cleanup");
 * await cleanup.pause();
 * await cleanup.trigger({ args: { olderThanDays: 30 } }); // queued for an owner
 * const { isRunning, runningOn } = await cleanup.info();
 * ```
 *
 * Everything goes through what the runner already persists — its state
 * fields, its lock, its history and its trigger queue — so no owner has to be
 * reachable for a call to succeed:
 *
 * - `pause`, `resume` and `updateSchedule` write the shared state. An owner
 *   adopts it at its next sync (`syncInterval`, 30s by default), or within the
 *   driver's event latency when it was started with `remoteControl: true`.
 * - `trigger` queues the run in the driver, and an owner drains it: at once
 *   when it is idle and follows `control` events, at its next sync otherwise,
 *   or when its current run finishes.
 * - `info`, `history` and `stats` read the shared state, lock and history.
 *
 * When the runner is registered in this process the controller delegates to
 * it, so it behaves exactly as calling the runner does — a trigger may then
 * start at once rather than queue.
 *
 * **There is no remote kill.** A run can only be stopped by the process
 * executing it, with `BunRunner.kill()`; nothing here claims to stop one.
 */
export class RemoteRunner<TArgs = unknown, TResult = unknown> {
  /** The runner's id. */
  readonly id: string;
  /** The namespace the runner belongs to. */
  readonly namespace: string;
  /** The driver every read and write goes through. */
  readonly driver: JobsDriver;

  /** The runner, when it is registered in this process. */
  readonly #local: BunRunner<TArgs, TResult> | undefined;
  /** The key the runner's state lives under. */
  readonly #key: string;
  /** Identifies this controller's `control` events. */
  readonly #origin = newToken();
  /** Logger for publish failures. */
  readonly #logger: Logger;

  constructor(options: RemoteRunnerOptions<TArgs, TResult>) {
    this.id = assertSegment(options.id, "runner id");
    this.namespace = assertNamespace(options.namespace);

    const driver = options.local?.driver ?? options.driver;
    if (!driver) {
      throw new RunnerNotFoundError(this.id, this.namespace, {
        reason: "no driver to look it up in",
      });
    }

    this.driver = driver;
    this.#local = options.local;
    this.#key = runnerKey(this.id);
    this.#logger = createJobsLogger(
      options.logger,
      { namespace: this.namespace, runnerId: this.id },
      "remote-runner",
    );
  }

  /** Whether the runner is registered in this process, so calls delegate to it. */
  get isLocal(): boolean {
    return this.#local !== undefined;
  }

  /**
   * Whether the backend knows the runner — it has persisted state, which
   * every `start()` writes, or a lock. A local runner always exists.
   *
   * Asked of `listRunners` rather than by reading the runner's state: on the
   * memory driver a read registers the key it reads, so looking up an id that
   * does not exist would make it exist.
   */
  async exists(): Promise<boolean> {
    if (this.#local) {
      return true;
    }

    await this.driver.connect();
    return (await this.driver.listRunners(this.namespace)).includes(this.id);
  }

  /* --- control -------------------------------------------------------- */

  /**
   * Pauses the runner everywhere. Its owners stop starting scheduled and
   * manual runs once they adopt the flag; a run already in flight carries on.
   */
  async pause(): Promise<void> {
    if (this.#local) {
      await this.#local.pause();
    } else {
      await this.#assertKnown();
      await this.driver.setState(this.namespace, this.#key, {
        paused: "1",
        updatedAt: Date.now(),
      });
    }

    await this.#announce("pause");
  }

  /**
   * Resumes the runner everywhere. `triggerNow` also asks for a run: locally
   * it starts one (source `resume`); remotely it queues one for an owner.
   */
  async resume(options?: {
    /** Also ask for a run straight away. */
    triggerNow?: boolean;
  }): Promise<void> {
    if (this.#local) {
      await this.#local.resume(options);
      await this.#announce("resume");
      return;
    }

    await this.#assertKnown();
    await this.driver.setState(this.namespace, this.#key, {
      paused: "0",
      updatedAt: Date.now(),
    });
    await this.#announce("resume");

    if (options?.triggerNow) {
      await this.trigger();
    }
  }

  /**
   * Replaces and persists the schedule. It is normalised — and a malformed
   * one rejected with a `ConfigError` — here, before anything is written.
   */
  async updateSchedule(schedule: ScheduleInput): Promise<void> {
    if (this.#local) {
      await this.#local.updateSchedule(schedule);
    } else {
      const normalised = normalizeSchedule(schedule);
      await this.#assertKnown();
      await this.driver.setState(this.namespace, this.#key, {
        schedule: JSON.stringify(normalised),
        updatedAt: Date.now(),
      });
    }

    await this.#announce("schedule");
  }

  /**
   * Asks for a run.
   *
   * Remotely this always goes through the runner's trigger queue in the
   * driver, whatever its `queueRuns` option says — queueing is the only way
   * to hand a run to another process. It resolves to `queued` with the
   * trigger's position, or `skipped` with `paused` (unless `force`) or
   * `queue-full` (at the owner's `maxQueuedRuns`). The run itself starts in
   * whichever owner drains it, with source `queued`, and the runner's default
   * `args` when none are given here.
   *
   * Locally it is `BunRunner.trigger()`, and may start the run at once.
   *
   * A remote controller cannot tell whether any owner is running: a trigger
   * queued while none is waits until one starts.
   */
  async trigger(options?: {
    /** Arguments for the run; defaults to the owner's `args`. */
    args?: TArgs;
    /** Queue it even while paused. */
    force?: boolean;
  }): Promise<TriggerOutcome> {
    if (this.#local) {
      const outcome = await this.#local.trigger(options);
      if (outcome.outcome === "queued") {
        await this.#announce("trigger");
      }
      return outcome;
    }

    await this.#assertKnown();
    const state = await this.driver.getState(this.namespace, this.#key);

    if (state.paused === "1" && !options?.force) {
      return await this.#skip("paused");
    }

    const max = Number(state.maxQueuedRuns) || DEFAULT_MAX_QUEUED_RUNS;
    const queued = await this.driver.pushQueuedTrigger(
      this.namespace,
      this.#key,
      {
        id: newId(),
        ...(options?.args !== undefined ? { args: options.args } : {}),
        source: "manual",
        requestedAt: Date.now(),
        requestedBy: newToken(this.id),
      },
      max,
    );

    if (!queued) {
      return await this.#skip("queue-full");
    }

    await this.driver.incrementCounters(this.namespace, this.#key, {
      "stat:queued": 1,
    });
    await this.#announce("trigger");

    return {
      outcome: "queued",
      position: await this.driver.countQueuedTriggers(
        this.namespace,
        this.#key,
      ),
    };
  }

  /* --- introspection ---------------------------------------------------- */

  /** Run history, newest first, from any process that ran it. */
  async history(limit?: number): Promise<RemoteRunRecord<TResult>[]> {
    // The stored result is whatever the handler returned — the declared
    // result type — or the marker `maxResultBytes` put in its place.
    if (this.#local) {
      return (await this.#local.history(limit)) as RemoteRunRecord<TResult>[];
    }

    await this.#assertKnown();
    return (await this.driver.listHistory(
      this.namespace,
      this.#key,
      limit,
    )) as RemoteRunRecord<TResult>[];
  }

  /** Lifetime counters, shared by every process. */
  async stats(): Promise<RunnerStats> {
    if (this.#local) {
      return await this.#local.stats();
    }

    await this.#assertKnown();
    return readStats(await this.driver.getState(this.namespace, this.#key));
  }

  /**
   * A snapshot from the backend: persisted configuration, paused flag and
   * schedule, who holds the lock and since when, the queue depth, counters
   * and the last run. `local` adds this process's view when the runner is
   * registered here.
   */
  async info(): Promise<RemoteRunnerInfo<TResult>> {
    await this.#assertKnown();
    const now = Date.now();
    const [state, lock, queuedTriggers, history] = await Promise.all([
      this.driver.getState(this.namespace, this.#key),
      this.driver.getLock(this.namespace, this.#key, now),
      this.driver.countQueuedTriggers(this.namespace, this.#key),
      this.driver.listHistory(this.namespace, this.#key, 1),
    ]);

    const local = this.#local;
    const schedule = state.schedule
      ? (JSON.parse(state.schedule) as RunnerSchedule)
      : (local?.schedule ?? null);
    const lockTtl =
      Number(state.lockTtl) || local?.options.lockTtl || DEFAULT_LOCK_TTL;
    const owner = lock ? parseToken(lock.token) : null;
    const lastRun = history[0] as RemoteRunRecord<TResult> | undefined;

    return {
      id: this.id,
      namespace: this.namespace,
      isLocal: local !== undefined,
      name: state.name ?? local?.name ?? this.id,
      file: state.file ?? local?.file,
      schedule,
      nextRunAt: nextFireDate(schedule),
      executionMode:
        (state.executionMode as RemoteRunnerInfo["executionMode"]) ??
        local?.options.executionMode,
      runMode:
        (state.runMode as RemoteRunnerInfo["runMode"]) ??
        local?.options.runMode,
      queueRuns:
        state.queueRuns === undefined
          ? local?.options.queueRuns
          : state.queueRuns === "1",
      maxQueuedRuns:
        state.maxQueuedRuns === undefined
          ? local?.options.maxQueuedRuns
          : Number(state.maxQueuedRuns),
      maxConcurrency:
        state.maxConcurrency === undefined
          ? local?.options.maxConcurrency
          : Number(state.maxConcurrency),
      isPaused: state.paused === "1",
      isRunning: lock !== null,
      ...(owner && state.lastRunId
        ? {
            runningOn: {
              host: owner.host,
              pid: owner.pid,
              runId: state.lastRunId,
              since: lock ? lock.expiresAt - lockTtl : now,
            },
          }
        : {}),
      queuedTriggers,
      stats: readStats(state),
      ...(lastRun ? { lastRun } : {}),
      ...(state.lastError
        ? {
            lastError: JSON.parse(state.lastError) as {
              name: string;
              message: string;
            },
          }
        : {}),
      ...(state.updatedAt ? { updatedAt: Number(state.updatedAt) } : {}),
      ...(local
        ? {
            local: {
              status: local.status,
              activeRuns: [...local.activeRuns.values()].map((run) => ({
                ...run.record,
              })),
              nextRunAt: local.nextRunAt(),
            },
          }
        : {}),
    };
  }

  /* --- internals -------------------------------------------------------- */

  /** Throws {@link RunnerNotFoundError} when the backend does not know the runner. */
  async #assertKnown(): Promise<void> {
    if (!(await this.exists())) {
      throw new RunnerNotFoundError(this.id, this.namespace);
    }
  }

  /** Counts and reports a trigger that was not queued, as the runner does. */
  async #skip(
    reason: "paused" | "queue-full",
  ): Promise<TriggerOutcome & { outcome: "skipped" }> {
    await this.driver.incrementCounters(this.namespace, this.#key, {
      "stat:skipped": 1,
    });
    return { outcome: "skipped", reason };
  }

  /**
   * Publishes a `control` event, so owners following them adopt the change
   * now. The change is already persisted, so a failure is logged, not thrown:
   * owners still pick it up at their next sync.
   */
  async #announce(action: RunnerControlAction): Promise<void> {
    try {
      await this.driver.publish(
        runnerEvent(
          {
            ns: this.namespace,
            target: this.id,
            type: "control",
            origin: this.#origin,
          },
          { action },
        ),
      );
    } catch (error) {
      this.#logger.warn("Could not publish a runner control event", {
        error,
        action,
      });
    }
  }
}

/** Reads the `stat:*` counters out of a runner's state. */
function readStats(state: Record<string, string>): RunnerStats {
  const stats = {} as RunnerStats;
  for (const field of STAT_FIELDS) {
    stats[field] = Number(state[`stat:${field}`] ?? 0) || 0;
  }
  return stats;
}
