import type {
  ExecutionMode,
  JobsDriver,
  QueuedTrigger,
  RunHistoryPage,
  RunHistoryQuery,
  RunnerRunCounters,
  RunnerRunDelta,
  RunRecord,
  RunSource,
  RunStatus,
} from "../drivers/index";
import type {
  RunnerControlAction,
  RunnerEventName,
  RunnerEventPayloads,
} from "../shared/events";
import type { LogFields, Logger } from "../shared/logger";
import type { RunnerSchedule, ScheduleInput, Ticker } from "../shared/schedule";
import type { ClearHistoryOptions, ClearHistoryResult } from "./clearHistory";
import type { RunnerConfigError } from "./config";
import type {
  Executor,
  ExecutorHandle,
  RunOutcome,
} from "./executors/executor";
import type {
  BunRunnerEvents,
  BunRunnerOptions,
  ResolvedRunnerOptions,
  RunContext,
  RunHandle,
  RunnerConfigInfo,
  RunnerConfigKey,
  RunnerConfigPatch,
  RunnerConfigValues,
  RunnerInfo,
  RunnerStats,
  RunnerStatus,
  TriggerOutcome,
} from "./types";
import { deserializeError, serializeError } from "@kingsleyweb/bun-common";
import { readHistoryPage } from "../drivers/runHistory";
import { TypedEmitterBase } from "../shared/emitter";
import { RunnerStoppedError } from "../shared/errors";
import { runnerEvent } from "../shared/events";
import { HOST, newId, newToken, parseToken } from "../shared/ids";
import { stringifyBounded } from "../shared/json";
import { runnerKey } from "../shared/keys";
import { createJobsLogger } from "../shared/logger";
import {
  createTicker,
  nextFireDate,
  normalizeSchedule,
} from "../shared/schedule";
import { clearRunnerHistory } from "./clearHistory";
import {
  adoptableExecutionModes,
  fromRunnerConcurrency,
  readStoredRunnerConfig,
  resolveRunnerConfig,
  RUNNER_CONFIG_STATE,
  runnerConfigFields,
  runnerConfigResetFields,
  toRunnerConcurrency,
  writeRunnerConfig,
} from "./config";
import { InProcessExecutor } from "./executors/in-process";
import { SpawnExecutor } from "./executors/spawn";
import { WorkerExecutor } from "./executors/worker";
import { resolveRunnerOptions } from "./options";
import { RunLogCapture } from "./runLogCapture";

/** A publish that does nothing: already settled, and shared, so it costs nothing. */
const SETTLED: Promise<void> = Promise.resolve();

/**
 * How many times a paused drain peeks again after losing a forced head to
 * another drainer, before leaving the queue to that drainer.
 */
const TAKE_QUEUED_ATTEMPTS = 16;

/**
 * Which analytics counter each way a run can end bumps. The series' `failed`
 * is a run that threw and nothing else — unlike the lifetime `stat:failed`,
 * which also counts timeouts and kills — because the series reports every
 * outcome in a counter of its own.
 */
const OUTCOME_COUNTERS = {
  success: "succeeded",
  failed: "failed",
  timeout: "timeout",
  killed: "killed",
} as const satisfies Record<
  Exclude<RunStatus, "running">,
  keyof RunnerRunCounters
>;

/**
 * Runs a JS/TS file on a schedule or on demand.
 *
 * The interesting part is not starting a process — it is deciding whether a
 * run should start at all. In `single` mode that decision spans processes: a
 * lock in the driver means one run happens at a time across the whole
 * cluster, extra triggers are either queued in the driver (so they survive
 * the holder crashing) or dropped, and whoever holds the lock drains the
 * queue when its run finishes.
 *
 * ```ts
 * const runner = new BunRunner({
 *   id: "cleanup",
 *   namespace: "account",
 *   file: "./jobs/cleanup.ts",
 *   schedule: "*\/10 * * * * *",
 *   driver: { type: "memory" },
 * });
 * await runner.start();
 * ```
 *
 * Nothing starts in the constructor: `start()` is explicit, because the
 * implementation this replaces started itself and that hid ordering bugs.
 */
export class BunRunner<
  TArgs = unknown,
  TResult = unknown,
  TToHandler = unknown,
  TFromHandler = unknown,
> extends TypedEmitterBase<BunRunnerEvents<TArgs, TResult, TFromHandler>> {
  /** Identifies the runner within its namespace. */
  readonly id: string;
  /** Display name; defaults to the id. */
  readonly name: string;
  /** The namespace this runner belongs to. */
  readonly namespace: string;
  /** The resolved handler file. */
  readonly file: string;
  /** Every option with its default applied. */
  readonly options: ResolvedRunnerOptions<TArgs>;
  /** Where state lives. Shared with queues and workers when passed in. */
  readonly driver: JobsDriver;

  /** Whether this instance created the driver and must close it. */
  readonly #ownsDriver: boolean;
  /** Logger bound to this runner's identity. */
  #logger: Logger;
  /** The key every driver call for this runner uses. */
  readonly #key: string;
  /**
   * How runs execute. Rebuilt when {@link #executionMode} changes, so a run
   * in flight keeps the executor — and the mode — it started with.
   */
  #executor: Executor;
  /**
   * Where runs execute, live: the adopted override when there is one, else
   * what this process's options asked for. Read at every site that used to
   * read `options.executionMode`, so a change applies from the next run.
   */
  #executionMode: ExecutionMode;
  /** Whether runs may overlap, live. */
  #runMode: "parallel" | "single";
  /** The concurrency cap in `parallel`, live; `Infinity` means unlimited. */
  #maxConcurrency: number;
  /** What this process's own options asked for, before any override. */
  readonly #codeConfig: RunnerConfigValues;
  /** The execution modes this runner's code permits an override to choose (`remoteConfig.executionModes`). */
  readonly #permittedModes: readonly ExecutionMode[];
  /**
   * The execution modes an override may choose *and* this owner can adopt:
   * {@link #permittedModes} less the child modes a runner built from a driver
   * instance cannot run (`adoptableExecutionModes`). What it publishes as
   * `allowed` and checks `updateConfig()` against.
   */
  readonly #allowedModes: readonly ExecutionMode[];
  /** The version of the stored override this instance has adopted. */
  #configSeq = 0;
  /** Which settings an override is stored for, as of the last adoption. */
  #overridden: RunnerConfigKey[] = [];
  /** Why part of the last override was refused, when some of it was. */
  #configError: RunnerConfigError | undefined;
  /** When the stored override was last written, epoch ms. */
  #configUpdatedAt: number | undefined;
  /** Identifies this runner's published events as coming from this process. */
  readonly #origin = newToken();
  /** Awaited before each publish; see `BunRunnerOptions.publishGate`. */
  readonly #publishGate: (() => Promise<void>) | undefined;
  /**
   * Why each active run was asked to stop, by run id, so the `killed` event
   * carries the caller's reason rather than a placeholder.
   */
  readonly #abortReasons = new Map<string, string>();

  /** Runs in flight in this process. */
  readonly #active = new Map<string, RunHandle>();
  /**
   * Triggers parked locally (parallel mode only; single mode uses the driver),
   * oldest first. `force` is set when the request asked to run even while
   * paused, so the drain can hold back the rest while the runner is paused.
   */
  readonly #localQueue: { id: string; args?: TArgs; force?: boolean }[] = [];
  /**
   * Bookkeeping still being written for runs that have already left
   * {@link #active}.
   *
   * A run leaves `#active` as soon as its handler settles, because the drain
   * that follows must see an empty map to know it may start what is queued.
   * That leaves a window where history, counters and the lock release are
   * still in flight, and a `stop()` that ignored it would let the process
   * exit mid-write — losing the record and, on the file driver, stranding
   * the lock it was holding.
   */
  readonly #settling = new Set<Promise<RunStatus>>();
  /** Publishes still in flight, which `close()` waits for. */
  readonly #publishing = new Set<Promise<void>>();
  /**
   * Whether an analytics write has failed yet. The first failure is logged
   * and every later one is not: a backend that refuses one count refuses
   * them all, and a line per run would drown the log it was meant to help.
   */
  #metricsFailed = false;

  /** The schedule ticker, while started. */
  #ticker: Ticker | undefined;
  /** Periodic re-read of the paused flag and schedule. */
  #syncTimer: ReturnType<typeof setInterval> | undefined;
  /** This instance's status. */
  #status: RunnerStatus = "idle";
  /** Cached paused flag, refreshed from the driver. */
  #paused: boolean;
  /** The current schedule; `updateSchedule` replaces it. */
  #schedule: RunnerSchedule;
  /** The single-run lock token, while held. */
  #lockToken: string | undefined;
  /**
   * The release of the lock in flight, while one is. A trigger waits for it
   * before asking for the lock: the token is dropped the moment a release
   * starts, but the driver may still hold the lock until the release lands,
   * and an acquire in that window is refused as if another process held it.
   */
  #releasing: Promise<void> | undefined;
  /**
   * Triggers reusing the lock this instance holds, from the renewal until the
   * run they start is tracked. The drain does not release the lock while one
   * is: a release racing that renewal could land before it — the run then
   * goes ahead holding nothing — or after it on a driver whose renewal is a
   * read then a write, which puts the released lock back under a token this
   * instance has already forgotten, so nothing ever releases it again.
   */
  #reusing = 0;
  /** Renews the lock while a run holds it. */
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  /** Set while the lock holder drains queued triggers, to avoid re-entering. */
  #draining = false;
  /** The drain of triggers queued while nothing ran here, while one is in flight. */
  #drainingQueued: Promise<void> | undefined;
  /** Ends the `control` subscription, while `remoteControl` holds one. */
  #unsubscribeControl: (() => Promise<void>) | undefined;

  constructor(options: BunRunnerOptions<TArgs>) {
    super();

    const { resolved, driver, ownsDriver } = resolveRunnerOptions(options);

    this.options = resolved;
    this.id = resolved.id;
    this.name = resolved.name;
    this.namespace = resolved.namespace;
    this.file = resolved.file;
    this.driver = driver;
    this.#ownsDriver = ownsDriver;
    this.#key = runnerKey(resolved.id);
    this.#paused = resolved.startPaused;
    this.#schedule = resolved.schedule;
    this.#publishGate = options.publishGate;
    this.#logger = createJobsLogger(
      options.logger,
      { namespace: resolved.namespace, runnerId: resolved.id },
      resolved.name,
    );

    this.#executionMode = resolved.executionMode;
    this.#runMode = resolved.runMode;
    this.#maxConcurrency = resolved.maxConcurrency;
    this.#permittedModes = resolved.remoteConfig.executionModes;
    this.#allowedModes = adoptableExecutionModes(
      resolved.remoteConfig.executionModes,
      resolved.executionMode,
      resolved.childDriver !== undefined,
    );
    this.#codeConfig = {
      executionMode: resolved.executionMode,
      runMode: resolved.runMode,
      maxConcurrency: fromRunnerConcurrency(resolved.maxConcurrency),
    };

    this.#executor = this.#createExecutor();

    if (resolved.autostart) {
      void this.start().catch((error: unknown) => {
        this.#emitError(error, "autostart");
      });
    }
  }

  /* --- accessors ---------------------------------------------------- */

  /** The runner's logger. */
  get logger(): Logger {
    return this.#logger;
  }

  /** Replaces the logger, keeping this runner's bindings. */
  set logger(logger: Logger) {
    this.#logger = createJobsLogger(
      logger,
      { namespace: this.namespace, runnerId: this.id },
      this.name,
    );
  }

  /** What this instance is doing. */
  get status(): RunnerStatus {
    return this.#status;
  }

  /** Runs in flight in this process, by run id. */
  get activeRuns(): ReadonlyMap<string, RunHandle> {
    return this.#active;
  }

  /** The schedule, normalised. */
  get schedule(): RunnerSchedule {
    return this.#schedule;
  }

  /** Where runs execute now: the adopted override, else what the code asked for. */
  get executionMode(): ExecutionMode {
    return this.#executionMode;
  }

  /** Whether runs may overlap now. */
  get runMode(): "parallel" | "single" {
    return this.#runMode;
  }

  /** The concurrency cap in force now; `Infinity` when unlimited. */
  get maxConcurrency(): number {
    return this.#maxConcurrency;
  }

  /**
   * What this instance runs with, what its code asked for, and whether it has
   * adopted the stored override. Read from this process's own view, so it is
   * current without a driver round trip.
   */
  get config(): RunnerConfigInfo {
    return {
      effective: {
        executionMode: this.#executionMode,
        runMode: this.#runMode,
        maxConcurrency: fromRunnerConcurrency(this.#maxConcurrency),
      },
      code: { ...this.#codeConfig },
      overridden: [...this.#overridden],
      allowed: [...this.#allowedModes],
      seq: this.#configSeq,
      appliedSeq: this.#configSeq,
      ...(this.#configError
        ? {
            error: {
              ...this.#configError,
              keys: [...this.#configError.keys],
            },
          }
        : {}),
      ...(this.#configUpdatedAt !== undefined
        ? { updatedAt: this.#configUpdatedAt }
        : {}),
    };
  }

  /** When this instance next fires, or `null` when nothing is scheduled. */
  nextRunAt(): Date | null {
    return this.#ticker?.next() ?? nextFireDate(this.#schedule);
  }

  /* --- lifecycle ----------------------------------------------------- */

  /**
   * Connects the driver, restores the paused flag and schedule other
   * processes may have changed, and arms the ticker. Idempotent, so it is
   * safe to call again after a hot reload dropped the process's timers.
   */
  async start(): Promise<this> {
    if (this.#status === "running" || this.#status === "paused") {
      return this;
    }

    await this.driver.connect();

    const state = await this.#readState();
    // A paused flag or an updated schedule set elsewhere wins over the
    // constructor's options: they are the cluster's current intent.
    this.#paused = state.paused ?? this.options.startPaused;
    if (state.schedule !== undefined) {
      this.#schedule = state.schedule;
    }

    // So does a stored configuration override — adopted before the write
    // below, which persists the *effective* values it produced.
    if (state.raw) {
      await this.#adoptConfig(state.raw, { persist: false });
    }

    await this.driver.setState(this.namespace, this.#key, {
      paused: this.#paused ? "1" : "0",
      schedule: JSON.stringify(this.#schedule),
      file: this.file,
      // What a remote controller needs to describe the runner and to queue a
      // trigger within its cap, from a process that never saw the options.
      name: this.name,
      queueRuns: this.options.queueRuns ? "1" : "0",
      maxQueuedRuns: String(this.options.maxQueuedRuns),
      lockTtl: String(this.options.lockTtl),
      updatedAt: Date.now(),
      updatedBy: newToken(),
      ...this.#configStateFields(),
    });

    this.#status = this.#paused ? "paused" : "running";
    this.#armTicker();
    this.#armSync();
    await this.#subscribeControl();

    // A trigger queued while no instance was running — by a remote
    // controller, or left behind by a holder that crashed — runs now.
    await this.#drainQueued();

    return this;
  }

  /**
   * Stops the ticker, refuses new triggers, waits for runs in flight (killing
   * them at `timeout`), releases the lock and closes an owned driver.
   */
  async stop(options?: { timeout?: number; force?: boolean }): Promise<void> {
    this.#status = "stopped";
    this.#ticker?.stop();
    this.#ticker = undefined;
    this.#clearSync();
    await this.#unsubscribeFromControl();

    const timeout = options?.timeout ?? this.options.closeTimeout;

    if (this.#active.size > 0) {
      if (options?.force) {
        await this.kill(undefined, { force: true, reason: "stop" });
      } else {
        const settled = await Promise.race([
          Promise.allSettled([...this.#active.values()].map((run) => run.done)),
          Bun.sleep(timeout).then(() => "timeout" as const),
        ]);

        if (settled === "timeout") {
          await this.kill(undefined, { reason: "stop" });
        }
      }
    }

    await Promise.allSettled([...this.#active.values()].map((run) => run.done));
    this.#executor.close?.();
    // Then whatever is still being written for runs that already settled.
    await Promise.allSettled([...this.#settling]);
    await Promise.allSettled([...this.#publishing]);

    this.#clearHeartbeat();
    await this.#releaseLock();
    await this.#flushMetrics();

    if (this.#ownsDriver) {
      await this.driver.close();
    }

    this.safeEmit("stopped");
  }

  /** Pauses the runner everywhere: the flag lives in the driver. */
  async pause(): Promise<void> {
    this.#paused = true;
    if (this.#status !== "stopped") {
      this.#status = "paused";
    }

    await this.driver.setState(this.namespace, this.#key, {
      paused: "1",
      updatedAt: Date.now(),
    });
    this.safeEmit("paused");
  }

  /**
   * Resumes the runner everywhere, optionally firing a run straight away.
   *
   * Triggers the pause held back in the queue start first, oldest first, so
   * a `triggerNow` run lines up behind them rather than jumping the queue.
   */
  async resume(options?: {
    /** Also ask for a run once the queue has been drained. */
    triggerNow?: boolean;
  }): Promise<void> {
    this.#paused = false;
    if (this.#status !== "stopped") {
      this.#status = "running";
      this.#armTicker();
    }

    await this.driver.setState(this.namespace, this.#key, {
      paused: "0",
      updatedAt: Date.now(),
    });
    this.safeEmit("resumed");

    await this.#drainAll();

    if (options?.triggerNow) {
      await this.trigger({ source: "resume" as RunSource });
    }
  }

  /** Replaces the schedule, re-arms the ticker and persists it. */
  async updateSchedule(schedule: ScheduleInput): Promise<void> {
    this.#schedule = normalizeSchedule(schedule);

    await this.driver.setState(this.namespace, this.#key, {
      schedule: JSON.stringify(this.#schedule),
      updatedAt: Date.now(),
    });

    if (this.#status === "running") {
      this.#armTicker();
    }
  }

  /* --- triggering ----------------------------------------------------- */

  /**
   * Asks for a run.
   *
   * The outcome says what happened rather than throwing: `started` with the
   * run's id, `queued` with its position, or `skipped` with the reason —
   * paused, already busy, the lock is held elsewhere, the concurrency cap is
   * reached, or the queue is full.
   *
   * `force` runs it even while paused. A forced trigger that has to wait —
   * behind a run in flight, the lock held elsewhere, or the concurrency cap —
   * is queued with `force: true` recorded on it, and a drain while paused
   * still runs it. The queue stays strict FIFO and the gate looks at the head
   * only: while paused, a drain runs the head if it is forced and otherwise
   * leaves the whole queue untouched, in order, until `resume()`. So a forced
   * trigger queued behind an unforced one waits for the resume too. Unforced
   * triggers are refused while paused, so an unforced head can only be one
   * queued before the pause.
   *
   * A trigger queued by a version before `force` was recorded carries no
   * `force` field, reads as unforced, and so waits for `resume()` — where
   * those versions ran every queued trigger regardless of the pause.
   */
  async trigger(options?: {
    /** Arguments for this run; defaults to the runner's `args`. */
    args?: TArgs;
    /**
     * Run even while paused — including later, from the queue, when it has to
     * wait (see above for the head-only rule). Defaults to `false`.
     */
    force?: boolean;
    /** What is asking. Defaults to `"manual"`. */
    source?: RunSource;
  }): Promise<TriggerOutcome> {
    const source = options?.source ?? "manual";
    const args = options?.args ?? this.options.args;

    if (this.#status === "stopped") {
      if (source === "manual") {
        throw new RunnerStoppedError(this.id);
      }
      return await this.#skip("stopped");
    }

    if (this.#paused && !options?.force) {
      return await this.#skip("paused");
    }

    if (this.#runMode === "parallel") {
      if (this.#active.size >= this.#maxConcurrency) {
        return await this.#queueLocally(
          args,
          "max-concurrency",
          options?.force,
        );
      }
      return { outcome: "started", runId: await this.#startRun(args, source) };
    }

    // Single mode. A run already in flight here means the lock is ours, so
    // there is no point asking for it again.
    if (this.#active.size > 0) {
      return await this.#queueInDriver(args, source, "busy", options?.force);
    }

    // The lock outlives a run until its drain finishes, so a trigger arriving
    // in that window reuses what this instance already holds rather than
    // fighting itself for it. Counted from here, synchronously, so a drain
    // deciding whether to release sees this trigger before it lets go.
    if (this.#lockToken) {
      const held = this.#lockToken;
      this.#reusing += 1;

      try {
        if ((await this.#renew(held)) && this.#lockToken === held) {
          return {
            outcome: "started",
            runId: await this.#startRun(args, source),
          };
        }
      } finally {
        this.#reusing -= 1;
      }
    }

    // A release of our own still in flight is not another holder: let it land.
    await this.#releasing;

    const token = newToken(this.id);
    const acquired = await this.#acquireLock(token);
    if (!acquired) {
      return await this.#queueInDriver(
        args,
        source,
        "lock-held",
        options?.force,
      );
    }

    this.#lockToken = token;
    const runId = await this.#startRun(args, source);
    return { outcome: "started", runId };
  }

  /** Kills one run, or every local run when no id is given. */
  async kill(
    runId?: string,
    options?: { force?: boolean; reason?: string },
  ): Promise<void> {
    const reason = options?.reason ?? "killed";
    const targets = runId
      ? [this.#active.get(runId)].filter(
          (run): run is RunHandle => run !== undefined,
        )
      : [...this.#active.values()];

    for (const run of targets) {
      run.abort(reason, { force: options?.force });
    }

    await Promise.allSettled(targets.map((run) => run.done));
  }

  /** Sends a message to a running handler; `false` when nothing received it. */
  send(message: TToHandler, runId?: string): boolean {
    if (runId) {
      return this.#active.get(runId)?.send(message) ?? false;
    }

    let delivered = false;
    for (const run of this.#active.values()) {
      delivered = run.send(message) || delivered;
    }
    return delivered;
  }

  /* --- introspection --------------------------------------------------- */

  /** Run history, newest first. */
  async history(limit?: number): Promise<RunRecord[]> {
    try {
      return await this.driver.listHistory(this.namespace, this.#key, limit);
    } catch (error) {
      this.#emitError(error, "history");
      return [];
    }
  }

  /**
   * A page of the run history, with the whole history's size.
   *
   * What {@link BunRunner.history} cannot do: reach past the first `limit`
   * records. `keepHistory` may be far larger than any one page, and without an
   * offset those older records are stored but unreadable.
   */
  async historyPage(opts: RunHistoryQuery): Promise<RunHistoryPage> {
    try {
      return await readHistoryPage(
        this.driver,
        this.namespace,
        this.#key,
        opts,
      );
    } catch (error) {
      this.#emitError(error, "history");
      return { records: [], total: 0 };
    }
  }

  /**
   * Clears the run history — each finished run's record **and** its log —
   * keeping every run still in progress whole, and answers what went and what
   * stayed.
   *
   * Kept: the runs this process is executing, the run the runner's live lock
   * holder is executing, and any other run whose record still says `running`
   * and started less than `staleAfter` ago (a day by default). A `running`
   * record nothing vouches for is a run whose process crashed, and is cleared
   * like a finished one — see `planHistoryClear` for the full rule.
   *
   * The lifetime counters ({@link BunRunner.stats}), the analytics series and
   * the runner's state are untouched: resetting the counters is
   * {@link BunRunner.resetStats}. Throws `NotSupportedError` on a driver
   * without `removeRuns`.
   */
  async clearHistory(
    options?: ClearHistoryOptions,
  ): Promise<ClearHistoryResult> {
    return await clearRunnerHistory(this.driver, this.namespace, this.#key, {
      ...options,
      local: this.#active,
    });
  }

  /** Lifetime counters. */
  async stats(): Promise<RunnerStats> {
    const state = await this.driver.getState(this.namespace, this.#key);
    const read = (field: string) => Number(state[`stat:${field}`] ?? 0) || 0;

    return {
      success: read("success"),
      failed: read("failed"),
      timeout: read("timeout"),
      killed: read("killed"),
      skipped: read("skipped"),
      queued: read("queued"),
      total: read("total"),
    };
  }

  /** Resets the counters to zero. */
  async resetStats(): Promise<void> {
    await this.driver.setState(this.namespace, this.#key, {
      "stat:success": null,
      "stat:failed": null,
      "stat:timeout": null,
      "stat:killed": null,
      "stat:skipped": null,
      "stat:queued": null,
      "stat:total": null,
    });
  }

  /**
   * A snapshot merging this process's view with the driver's, so `isRunning`
   * and `runningOn` describe the whole cluster rather than this instance.
   */
  async info(): Promise<RunnerInfo> {
    const now = Date.now();
    const [state, lock, stats, queuedTriggers, history] = await Promise.all([
      this.driver.getState(this.namespace, this.#key),
      this.driver.getLock(this.namespace, this.#key, now),
      this.stats(),
      this.driver.countQueuedTriggers(this.namespace, this.#key),
      this.history(1),
    ]);

    const owner = lock ? parseToken(lock.token) : null;
    // The lock is taken before its run exists and outlives it until the drain
    // finishes, so the token cannot name the run; the holder records each run
    // it starts, and that is the one in flight.
    const runningRunId = state.lastRunId;
    const lastError = state.lastError
      ? (JSON.parse(state.lastError) as { name: string; message: string })
      : undefined;

    return {
      id: this.id,
      name: this.name,
      namespace: this.namespace,
      file: this.file,
      schedule: this.#schedule,
      nextRunAt: this.nextRunAt(),
      executionMode: this.#executionMode,
      runMode: this.#runMode,
      queueRuns: this.options.queueRuns,
      maxConcurrency: this.#maxConcurrency,
      config: this.config,
      status: this.#status,
      isPaused: state.paused === "1",
      isRunning: lock !== null,
      ...(owner && runningRunId
        ? {
            runningOn: {
              host: owner.host,
              pid: owner.pid,
              runId: runningRunId,
              since: lock ? lock.expiresAt - this.options.lockTtl : now,
            },
          }
        : {}),
      activeRuns: [...this.#active.values()].map((run) => ({ ...run.record })),
      queuedTriggers,
      stats,
      lastRun: history[0],
      lastError,
    };
  }

  /* --- internals -------------------------------------------------------- */

  /** Builds the executor for the mode in force now. */
  #createExecutor(): Executor {
    switch (this.#executionMode) {
      case "in-process":
        return new InProcessExecutor(this.options.inProcess);
      case "worker":
        return new WorkerExecutor(this.options.worker);
      default:
        return new SpawnExecutor(this.options.spawn);
    }
  }

  /**
   * Reads the persisted paused flag and schedule, tolerating a bad read.
   *
   * `raw` is the whole state hash, so a caller that also needs the `config:*`
   * family — every caller that adopts an override — does not read twice.
   */
  async #readState(): Promise<{
    paused?: boolean;
    schedule?: RunnerSchedule;
    raw?: Record<string, string>;
  }> {
    try {
      const state = await this.driver.getState(this.namespace, this.#key);
      return {
        paused: state.paused === undefined ? undefined : state.paused === "1",
        schedule: state.schedule
          ? (JSON.parse(state.schedule) as RunnerSchedule)
          : undefined,
        raw: state,
      };
    } catch (error) {
      this.#emitError(error, "readState");
      return {};
    }
  }

  /** (Re-)arms the schedule ticker. */
  #armTicker(): void {
    this.#ticker?.stop();

    if (!this.#schedule || this.#status === "stopped") {
      this.#ticker = undefined;
      this.safeEmit("scheduled", null);
      return;
    }

    this.#ticker = createTicker(
      this.#schedule,
      () => {
        // Must return synchronously: Bun.cron computes its next fire only
        // after the handler's promise settles, so awaiting here would make a
        // long run suppress the cadence.
        void this.trigger({ source: "schedule" }).catch((error: unknown) => {
          this.#emitError(error, "tick");
        });
      },
      { keepAlive: this.options.waitToExit },
    );

    this.safeEmit("scheduled", this.#ticker.next());
  }

  /** Arms the periodic re-read of cluster-wide state. */
  #armSync(): void {
    this.#clearSync();

    if (this.options.syncInterval <= 0) {
      return;
    }

    this.#syncTimer = setInterval(() => {
      void this.#sync();
    }, this.options.syncInterval);
    this.#syncTimer.unref?.();
  }

  /** Stops the periodic re-read. */
  #clearSync(): void {
    if (this.#syncTimer) {
      clearInterval(this.#syncTimer);
      this.#syncTimer = undefined;
    }
  }

  /** Re-reads the paused flag and schedule another process may have changed. */
  async #sync(): Promise<void> {
    const state = await this.#readState();

    if (state.paused !== undefined && state.paused !== this.#paused) {
      this.#paused = state.paused;
      this.#status = state.paused ? "paused" : "running";
      this.safeEmit(state.paused ? "paused" : "resumed");
    }

    if (
      state.schedule !== undefined &&
      JSON.stringify(state.schedule) !== JSON.stringify(this.#schedule)
    ) {
      this.#schedule = state.schedule;
      this.#armTicker();
    }

    if (state.raw) {
      await this.#adoptConfig(state.raw, { persist: true });
    }

    // A resume adopted from elsewhere releases what the pause held back — and
    // so does a configuration change: a raised cap, or a mode switch that
    // stranded the lock or the local queue.
    await this.#drainAll();
  }

  /**
   * Subscribes to this runner's `control` events when the resolved
   * `remoteControl` asks — which `"auto"`, the default, decides from the
   * driver: yes where events are pushed or local, no where they are polled —
   * so a remote change is adopted as soon as it is published rather than at
   * the next sync. A failure is reported and the sync carries on regardless.
   */
  async #subscribeControl(): Promise<void> {
    if (!this.options.remoteControl || this.#unsubscribeControl) {
      return;
    }

    try {
      this.#unsubscribeControl = await this.driver.subscribe(
        this.namespace,
        "runner",
        this.id,
        (event) => {
          // Its own announcement is skipped: it adopted that change before
          // publishing it.
          if (
            event.type === "control" &&
            event.origin !== this.#origin &&
            this.#status !== "stopped"
          ) {
            void this.#sync().catch((error: unknown) => {
              this.#emitError(error, "control");
            });
          }
        },
      );
    } catch (error) {
      this.#emitError(error, "subscribeControl");
    }
  }

  /** Ends the `control` subscription, if there is one. */
  async #unsubscribeFromControl(): Promise<void> {
    const unsubscribe = this.#unsubscribeControl;
    this.#unsubscribeControl = undefined;

    try {
      await unsubscribe?.();
    } catch (error) {
      this.#emitError(error, "unsubscribeControl");
    }
  }

  /* --- configuration ---------------------------------------------------- */

  /**
   * Overrides this runner's executor or overlap settings for every process
   * that owns it, and adopts the change here at once.
   *
   * A merge patch: a field left out is untouched, `null` clears that
   * override. The change applies from the *next* run — a run in flight keeps
   * the mode it started with, and lowering `maxConcurrency` or switching
   * `parallel` → `single` never kills one.
   *
   * @throws ConfigError when the patch is empty, out of bounds, or asks for
   * an execution mode this runner's `remoteConfig` does not permit.
   */
  async updateConfig(patch: RunnerConfigPatch): Promise<RunnerConfigInfo> {
    const fields = runnerConfigFields(patch, { allowed: this.#allowedModes });
    return await this.#writeAndAdopt(fields);
  }

  /** Clears every override, so the runner goes back to what its code asked for. */
  async resetConfig(): Promise<RunnerConfigInfo> {
    return await this.#writeAndAdopt(runnerConfigResetFields());
  }

  /**
   * Stores an override, adopts it here, drains what it may have released, and
   * announces it — so the runner's other owners adopt it within the driver's
   * event latency rather than at their next sync (`syncInterval`, 30 s by
   * default). The same `control` event `RemoteRunner` publishes.
   */
  async #writeAndAdopt(
    fields: Record<string, string | null>,
  ): Promise<RunnerConfigInfo> {
    await writeRunnerConfig(this.driver, this.namespace, this.#key, fields);

    const state = await this.driver.getState(this.namespace, this.#key);
    await this.#adoptConfig(state, { persist: true });
    await this.#drainAll();
    await this.#announceControl("config");

    return this.config;
  }

  /**
   * Publishes a `control` event for this runner's other owners, whatever the
   * `publish` option says: like `RemoteRunner`'s, it is addressed to the
   * processes that own the runner, not to dashboards. The change is already
   * stored, so a failure is logged rather than thrown — the others still
   * adopt it at their next sync.
   */
  async #announceControl(action: RunnerControlAction): Promise<void> {
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

  /**
   * Adopts the stored override, dropping any field it cannot honour.
   *
   * Everything that reads a configured value reads the live field, so a
   * change takes effect from the next decision each of them makes: the next
   * run's executor and `RunRecord.mode`, the next trigger's concurrency gate,
   * the next drain's lock handling. Nothing in flight is touched.
   *
   * `persist` writes the effective values, the adopted version and any
   * refusal back — skipped by `start()`, which folds them into its own write.
   */
  async #adoptConfig(
    state: Record<string, string>,
    options: { persist: boolean },
  ): Promise<void> {
    const stored = readStoredRunnerConfig(state);
    const resolved = resolveRunnerConfig({
      override: stored.override,
      code: this.#codeConfig,
      // The code's list, not the published one, so an override stored before
      // this owner started is refused with the specific reason.
      allowed: this.#permittedModes,
      hasChildDriver: this.options.childDriver !== undefined,
    });

    const previousRunMode = this.#runMode;
    const previous = {
      executionMode: this.#executionMode,
      runMode: this.#runMode,
      maxConcurrency: this.#maxConcurrency,
    };

    if (resolved.effective.executionMode !== this.#executionMode) {
      this.#executionMode = resolved.effective.executionMode;
      // Only the next run sees it: a handle already started owns its child.
      this.#executor.close?.();
      this.#executor = this.#createExecutor();
    }
    this.#runMode = resolved.effective.runMode;
    this.#maxConcurrency = toRunnerConcurrency(
      resolved.effective.maxConcurrency,
    );

    this.#overridden = resolved.overridden;
    this.#configUpdatedAt = stored.updatedAt;
    this.#configError =
      resolved.refusals.length > 0
        ? {
            at: Date.now(),
            message: resolved.refusals.join("; "),
            keys: resolved.refusedKeys,
          }
        : undefined;

    for (const warning of resolved.warnings) {
      this.#logger.warn(warning, { runnerId: this.id });
    }
    for (const refusal of resolved.refusals) {
      this.#logger.warn(`Refused a runner configuration override: ${refusal}`, {
        runnerId: this.id,
      });
    }

    const changed =
      previous.executionMode !== this.#executionMode ||
      previous.runMode !== this.#runMode ||
      previous.maxConcurrency !== this.#maxConcurrency;
    const adopted = stored.seq !== this.#configSeq;
    this.#configSeq = stored.seq;

    // `parallel` → `single`: this process's local queue is never drained in
    // single mode, so its triggers would sit there for good. They belong in
    // the driver's queue, which single mode does drain.
    if (previousRunMode === "parallel" && this.#runMode === "single") {
      await this.#migrateLocalQueue();
    }

    if (changed) {
      this.safeEmit("configured", this.config);
    }

    if (options.persist && (changed || adopted)) {
      try {
        await this.driver.setState(
          this.namespace,
          this.#key,
          this.#configStateFields(),
        );
      } catch (error) {
        this.#emitError(error, "adoptConfig");
      }
    }
  }

  /**
   * The state fields an owner writes: the effective values under their
   * original names — so `RemoteRunner.info()` and older clients are unchanged
   * — plus what only an owner knows.
   */
  #configStateFields(): Record<string, string | number | null> {
    return {
      executionMode: this.#executionMode,
      runMode: this.#runMode,
      maxConcurrency: String(this.#maxConcurrency),
      [RUNNER_CONFIG_STATE.code]: JSON.stringify(this.#codeConfig),
      [RUNNER_CONFIG_STATE.allowed]: JSON.stringify(this.#allowedModes),
      [RUNNER_CONFIG_STATE.appliedSeq]: this.#configSeq,
      [RUNNER_CONFIG_STATE.appliedAt]: Date.now(),
      [RUNNER_CONFIG_STATE.error]: this.#configError
        ? JSON.stringify(this.#configError)
        : null,
    };
  }

  /**
   * Moves triggers parked in this process into the driver's queue, which is
   * the only one `single` mode drains.
   *
   * `maxQueuedRuns` is honoured against the driver's queue, so a migration
   * that overflows it counts the rest as skipped rather than silently
   * dropping them — the same outcome a trigger arriving at a full queue gets.
   */
  async #migrateLocalQueue(): Promise<void> {
    if (this.#localQueue.length === 0) {
      return;
    }

    const parked = this.#localQueue.splice(0, this.#localQueue.length);

    for (const trigger of parked) {
      let queued = false;
      try {
        queued = await this.driver.pushQueuedTrigger(
          this.namespace,
          this.#key,
          {
            id: trigger.id,
            ...(trigger.args !== undefined ? { args: trigger.args } : {}),
            source: "manual",
            requestedAt: Date.now(),
            requestedBy: newToken(this.id),
            ...(trigger.force ? { force: true } : {}),
          },
          this.options.maxQueuedRuns,
        );
      } catch (error) {
        this.#emitError(error, "migrateLocalQueue");
      }

      if (!queued) {
        // Already counted as `queued` when it was parked; a trigger that no
        // longer fits is a skip, exactly as it would have been on arrival.
        await this.#skip("queue-full");
      }
    }
  }

  /**
   * Starts triggers waiting in the driver while nothing runs here.
   *
   * The lock holder drains the queue when its run finishes, but a trigger
   * queued while *no* run is in flight — by a remote controller, or by a
   * holder that died before draining — has nobody finishing a run to notice
   * it. This is that somebody: called on start, on every sync and on every
   * `control` event.
   *
   * In `single` mode it takes the lock first, and leaves the queue to whoever
   * holds it when it cannot.
   *
   * While paused it applies the same gate as the holder's drain (see
   * {@link #takeQueued}): it peeks at the head and goes on only when that
   * trigger was forced, leaving the queue untouched otherwise. In `single`
   * mode the peek comes before the lock, so a paused runner with nothing it
   * may run never takes the lock at all.
   */
  async #drainQueued(): Promise<void> {
    if (this.#drainingQueued) {
      return await this.#drainingQueued;
    }

    const draining = this.#doDrainQueued().finally(() => {
      this.#drainingQueued = undefined;
    });
    this.#drainingQueued = draining;
    return await draining;
  }

  /** The body of {@link #drainQueued}. */
  async #doDrainQueued(): Promise<void> {
    if (
      (this.#status !== "running" && this.#status !== "paused") ||
      this.#draining
    ) {
      return;
    }

    try {
      if (this.#runMode === "parallel") {
        // Re-read on every pass: `stop()` may land while a run is starting,
        // which the narrowing from the check above cannot know about.
        while (
          this.#active.size < this.#maxConcurrency &&
          (this.#status as RunnerStatus) !== "stopped"
        ) {
          const trigger = await this.#takeQueued();
          if (!trigger) {
            return;
          }

          const args = (trigger.args as TArgs | undefined) ?? this.options.args;
          this.safeEmit("dequeued", { id: trigger.id, args });
          await this.#startRun(args, "queued");
        }
        return;
      }

      // A run in flight here holds the lock and drains when it finishes.
      if (this.#active.size > 0) {
        return;
      }

      // Nothing this instance may run: leave the lock alone. While paused
      // that means an empty queue or an unforced head.
      if (this.#paused) {
        const head = await this.driver.peekQueuedTrigger(
          this.namespace,
          this.#key,
        );
        if (head?.force !== true) {
          return;
        }
      } else if (
        (await this.driver.countQueuedTriggers(this.namespace, this.#key)) === 0
      ) {
        return;
      }

      if (!this.#lockToken) {
        const token = newToken(this.id);
        if (!(await this.#acquireLock(token))) {
          // Held elsewhere: that holder drains when its run finishes.
          return;
        }
        this.#lockToken = token;
      }
    } catch (error) {
      this.#emitError(error, "drainQueued");
      return;
    }

    await this.#drain();
  }

  /**
   * Records a skipped trigger and reports it.
   *
   * The counter write is awaited rather than fired and forgotten: an
   * unawaited driver write can still be mid-flight when the process exits,
   * which loses the count and — on the file driver — strands the lock it was
   * holding until the stale window expires.
   */
  async #skip(
    reason: (TriggerOutcome & { outcome: "skipped" })["reason"],
  ): Promise<TriggerOutcome> {
    const outcome = { outcome: "skipped", reason } as const;
    await this.#bump({ skipped: 1 });
    await this.#countRun(Date.now(), { skipped: 1 });
    this.safeEmit("skipped", outcome);
    void this.#publish("skipped", { reason: outcome.reason });
    return outcome;
  }

  /**
   * Drains both queues after something that may have released them — a
   * resume, here or adopted from elsewhere, and every sync: this process's
   * local queue (parallel mode), then the driver's.
   */
  async #drainAll(): Promise<void> {
    if (this.#status !== "running" && this.#status !== "paused") {
      return;
    }

    // Single mode has no local queue, and its `#drain` pops without taking
    // the lock, so it is reached only through `#drainQueued`.
    if (this.#runMode === "parallel") {
      await this.#drain();
    }
    await this.#drainQueued();
  }

  /**
   * Takes the next trigger from the driver's queue that may run now, or
   * `null` when there is none.
   *
   * Not paused, it pops. Paused, it peeks and takes only a head that was
   * forced (`force === true`); anything else — including a record from
   * before `force` was recorded — stays where it is, and so does everything
   * behind it, until the runner resumes. Strict FIFO, head only.
   *
   * The forced head is taken *by id* with
   * {@link JobsDriver.popQueuedTriggerIf}, atomically against every other
   * process, so a drainer never pops a record it did not inspect: drainers
   * in several processes (parallel mode) racing for one forced head get it
   * exactly once between them, and nothing behind it moves. A `null` there
   * means the head changed under us — another drainer took it — so this
   * peeks again and decides afresh, at most {@link TAKE_QUEUED_ATTEMPTS}
   * times. Each miss means another drainer made progress, and that drainer
   * goes on draining, so giving up after the cap strands nothing.
   */
  async #takeQueued(): Promise<QueuedTrigger | null> {
    for (let attempt = 0; attempt < TAKE_QUEUED_ATTEMPTS; attempt++) {
      if (!this.#paused) {
        return await this.driver.popQueuedTrigger(this.namespace, this.#key);
      }

      const head = await this.driver.peekQueuedTrigger(
        this.namespace,
        this.#key,
      );
      if (head?.force !== true) {
        return null;
      }

      const taken = await this.driver.popQueuedTriggerIf(
        this.namespace,
        this.#key,
        head.id,
      );
      if (taken) {
        return taken;
      }
    }
    return null;
  }

  /**
   * Parks a trigger in this process (parallel mode). `force` is whether the
   * request asked to run even while paused, so the drain can tell.
   */
  async #queueLocally(
    args: TArgs | undefined,
    reason: (TriggerOutcome & { outcome: "skipped" })["reason"],
    force?: boolean,
  ): Promise<TriggerOutcome> {
    if (!this.options.queueRuns) {
      return await this.#skip(reason);
    }

    if (this.#localQueue.length >= this.options.maxQueuedRuns) {
      return await this.#skip("queue-full");
    }

    const trigger = { id: newId(), args, ...(force ? { force: true } : {}) };
    this.#localQueue.push(trigger);
    await this.#bump({ queued: 1 });
    this.safeEmit("queued", { id: trigger.id, args });
    void this.#publish("queued", { runId: trigger.id });

    return { outcome: "queued", position: this.#localQueue.length };
  }

  /**
   * Parks a trigger in the driver (single mode), so the demand survives this
   * process and whoever holds the lock drains it.
   *
   * `force` is whether the request asked to run even while paused. It is
   * recorded on the trigger as `force: true` only when set, so a drainer can
   * tell a forced trigger apart; an unforced record carries no `force` key.
   */
  async #queueInDriver(
    args: TArgs | undefined,
    source: RunSource,
    reason: (TriggerOutcome & { outcome: "skipped" })["reason"],
    force?: boolean,
  ): Promise<TriggerOutcome> {
    if (!this.options.queueRuns) {
      return await this.#skip(reason);
    }

    const trigger = {
      id: newId(),
      args,
      source:
        source === "schedule" ? ("schedule" as const) : ("manual" as const),
      requestedAt: Date.now(),
      requestedBy: newToken(this.id),
      // Only a forced trigger says so, so an unforced record is unchanged.
      ...(force ? { force: true } : {}),
    };

    const queued = await this.driver.pushQueuedTrigger(
      this.namespace,
      this.#key,
      trigger,
      this.options.maxQueuedRuns,
    );

    if (!queued) {
      return await this.#skip("queue-full");
    }

    void this.#bump({ queued: 1 });
    this.safeEmit("queued", { id: trigger.id, args });
    void this.#publish("queued", { runId: trigger.id });

    return {
      outcome: "queued",
      position: await this.driver.countQueuedTriggers(
        this.namespace,
        this.#key,
      ),
    };
  }

  /** Takes the single-run lock, failing closed on any driver error. */
  async #acquireLock(token: string): Promise<boolean> {
    try {
      return await this.driver.acquireLock(
        this.namespace,
        this.#key,
        token,
        this.options.lockTtl,
        Date.now(),
      );
    } catch (error) {
      // Fail closed: running a single-mode job whose exclusivity cannot be
      // verified is worse than not running it.
      this.#emitError(error, "acquireLock");
      return false;
    }
  }

  /** Releases the lock, if this instance holds it. */
  async #releaseLock(): Promise<void> {
    if (!this.#lockToken) {
      return;
    }

    const token = this.#lockToken;
    this.#lockToken = undefined;

    const releasing = (async () => {
      try {
        await this.driver.releaseLock(this.namespace, this.#key, token);
      } catch (error) {
        this.#emitError(error, "releaseLock");
      }
    })();
    this.#releasing = releasing;
    await releasing;

    if (this.#releasing === releasing) {
      this.#releasing = undefined;
    }
  }

  /** Starts renewing the lock for as long as a run holds it. */
  #armHeartbeat(runId: string): void {
    this.#clearHeartbeat();

    if (!this.#lockToken) {
      return;
    }

    this.#heartbeat = setInterval(() => {
      void this.#renewLock(runId);
    }, this.options.heartbeatInterval);
    this.#heartbeat.unref?.();
  }

  /** Stops renewing the lock. */
  #clearHeartbeat(): void {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
  }

  /** Extends the lock for `token`; `false` when it is no longer ours. */
  async #renew(token: string): Promise<boolean> {
    try {
      return await this.driver.renewLock(
        this.namespace,
        this.#key,
        token,
        this.options.lockTtl,
        Date.now(),
      );
    } catch (error) {
      this.#emitError(error, "renewLock");
      return false;
    }
  }

  /** Renews the lock; a failure means the run no longer owns its exclusivity. */
  async #renewLock(runId: string): Promise<void> {
    const token = this.#lockToken;
    if (!token) {
      return;
    }

    const renewed = await this.#renew(token);

    if (renewed) {
      return;
    }

    const run = this.#active.get(runId);
    if (run) {
      this.safeEmit("lockLost", run.record);
      if (this.options.onLockLost === "abort") {
        await this.kill(runId, { reason: "lock-lost" });
      }
    }
  }

  /** Starts a run and tracks it until it settles. */
  async #startRun(args: TArgs | undefined, source: RunSource): Promise<string> {
    const runId = newId();
    const startedAt = Date.now();

    const record: RunRecord = {
      runId,
      runnerId: this.id,
      attempt: 1,
      source,
      mode: this.#executionMode,
      host: HOST,
      startedAt,
      status: "running",
    };

    await this.driver.appendHistory(
      this.namespace,
      this.#key,
      record,
      this.options.keepHistory,
    );
    await this.driver.setState(this.namespace, this.#key, {
      lastRunAt: startedAt,
      lastRunId: runId,
      lastStatus: "running",
    });
    await this.#bump({ total: 1 });
    await this.#countRun(startedAt, { started: 1 });

    const controller = new AbortController();
    const capture = this.#createCapture(runId);
    const context = this.#buildContext(
      runId,
      args,
      source,
      startedAt,
      controller,
      capture,
    );

    const handle = this.#executor.start({
      context,
      file: this.file,
      timeout: this.options.timeout,
      closeTimeout: this.options.closeTimeout,
      killTimeout: this.options.killTimeout,
      waitToExit: this.options.waitToExit,
      forwardLogs: this.options.forwardLogs,
      // A run sharing a console — in-process, or a worker's realm — has no
      // pipes, so its console calls are captured by async context instead
      // (`consoleCapture.ts`). A spawned run's console is in its pipes.
      captureConsole:
        capture !== undefined &&
        this.options.captureLogs.console &&
        this.#executionMode !== "spawn",
      events: {
        onProgress: (value) => this.safeEmit("progress", record, value),
        // The executor is transport and hands messages over untyped; this is
        // where they take the type the runner was declared with. Nothing at
        // runtime checks it — the handler is trusted to send what it declares.
        onMessage: (data) =>
          this.safeEmit("message", record, data as TFromHandler),
        onLog: (level, message, fields) => {
          capture?.line(message, {
            level,
            fields: this.#logFields(fields, runId),
          });
          this.safeEmit("log", record, level, message, fields);
        },
        onOutput: (stream, chunk) => {
          capture?.output(stream, chunk);
          this.safeEmit("output", record, stream, chunk);
        },
        onOutputEnd: (stream) => capture?.endOutput(stream),
        // Into the store only: the public `output` event stays what its JSDoc
        // says, a child writing to a piped stream.
        onConsole: (stream, text) => capture?.output(stream, text),
        onPid: (pid) => {
          record.pid = pid;
        },
      },
    });

    const settle = this.#finish(runId, record, handle, capture);
    const tracked = settle.finally(() => {
      this.#settling.delete(tracked);
    });
    this.#settling.add(tracked);

    this.#active.set(runId, {
      record,
      abort: (reason, abortOptions) => {
        // The first reason wins: a kill followed by the runner stopping is
        // still the kill the caller asked for.
        if (!this.#abortReasons.has(runId)) {
          this.#abortReasons.set(runId, reason);
        }
        handle.stop(reason, abortOptions);
      },
      send: (message) => handle.send(message),
      done: settle,
    });

    this.#armHeartbeat(runId);
    this.safeEmit("started", record);
    void this.#publish("started", { runId: record.runId });

    return runId;
  }

  /**
   * Starts capturing one run's output, when there is somewhere to put it.
   *
   * `undefined` — no capture at all — when the option is off or the driver
   * cannot store run logs, so neither the executor callbacks nor the context
   * carry a per-line branch for those cases.
   */
  #createCapture(runId: string): RunLogCapture | undefined {
    if (
      !this.options.captureLogs.enabled ||
      typeof this.driver.appendRunLog !== "function"
    ) {
      return undefined;
    }

    return new RunLogCapture({
      driver: this.driver,
      namespace: this.namespace,
      key: this.#key,
      runId,
      caps: {
        maxLines: this.options.captureLogs.maxLines,
        maxBytes: this.options.captureLogs.maxBytes,
        // A run in the history and a run with a log are the same set: the
        // driver contract asks the caller to match them, and `clearHistory`
        // drops both together.
        keepRuns: this.options.keepHistory,
      },
      options: this.options.captureLogs,
      logger: this.#logger,
      // The `logs` hint: that this run's stored log grew, and to where — the
      // number only, never a line. Throttled inside capture. Only built when
      // the runner publishes at all, so a quiet runner arms no timers for it.
      ...(this.options.publish
        ? {
            hint: (lastSeq: number) => {
              void this.#publish("logs", { runId, lastSeq });
            },
          }
        : {}),
      // Only a spawned run has pipes of its own, and only the ones actually
      // piped: an explicit `"inherit"` leaves nothing for capture to wait for.
      streams:
        this.#executionMode === "spawn"
          ? (["stdout", "stderr"] as const).filter(
              (stream) => this.options.spawn[stream] === "pipe",
            )
          : [],
    });
  }

  /**
   * The fields of a forwarded log record worth storing on the line.
   *
   * A forwarded record carries the child logger's bindings, which are this
   * run's own namespace and ids — true of every line in this log by
   * definition, so rendering them onto each one is noise. Only bindings whose
   * value is this run's are dropped; a field that happens to share a name but
   * not a value is kept.
   */
  #logFields(fields: LogFields, runId: string): LogFields {
    const self: Record<string, string> = {
      namespace: this.namespace,
      runnerId: this.id,
      runId,
    };

    const kept: LogFields = {};
    for (const [key, value] of Object.entries(fields)) {
      if (self[key] === value) {
        continue;
      }
      kept[key] = value;
    }

    return kept;
  }

  /** The context handed to the handler. */
  #buildContext(
    runId: string,
    args: TArgs | undefined,
    source: RunSource,
    startedAt: number,
    controller: AbortController,
    capture: RunLogCapture | undefined,
  ): RunContext<TArgs> {
    return {
      runId,
      runnerId: this.id,
      runnerName: this.name,
      namespace: this.namespace,
      attempt: 1,
      source,
      mode: this.#executionMode,
      startedAt,
      deadline:
        this.options.timeout > 0 ? startedAt + this.options.timeout : null,
      args: args as TArgs,
      signal: controller.signal,
      logger: this.#logger.child({ runId }),
      // Only an in-process run gets these: `toSerializable` drops every
      // function, and a child builds its own pair over the IPC channel.
      log: (message, options) => capture?.line(message, options),
      flushLogs: async () => await (capture?.flush() ?? SETTLED),
      progress: () => {},
      send: () => {},
      onMessage: () => () => {},
      ...(this.options.childDriver
        ? { driverConfig: this.options.childDriver }
        : {}),
      ...(this.#executionMode === "in-process" ? { driver: this.driver } : {}),
    };
  }

  /** Waits for a run to settle, records the outcome and drains what is queued. */
  async #finish(
    runId: string,
    record: RunRecord,
    handle: ExecutorHandle,
    capture: RunLogCapture | undefined,
  ): Promise<RunStatus> {
    const outcome = await handle.done;
    // Before the record is written, so the history row and the log agree, and
    // bounded by `RUN_LOG_GRACE_MS` inside `close()` so a store that has
    // stopped answering cannot hold the run open.
    const logs = await capture?.close();
    const finishedAt = Date.now();

    Object.assign(record, {
      status: outcome.status,
      finishedAt,
      durationMs: finishedAt - record.startedAt,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.signal !== undefined ? { signal: outcome.signal } : {}),
      ...(outcome.detached ? { detached: true } : {}),
      // Absent, not zero, when nothing captured: `undefined` is how a reader
      // is told this backend stores no run logs, and `0` that the run was
      // simply quiet.
      ...(logs ? { logLines: logs.count, logsDropped: logs.dropped } : {}),
      ...(outcome.result !== undefined
        ? {
            result: JSON.parse(
              stringifyBounded(outcome.result, this.options.maxResultBytes),
            ) as unknown,
          }
        : {}),
    } satisfies Partial<RunRecord>);

    this.#active.delete(runId);
    this.#clearHeartbeat();

    await this.#record(record, outcome);
    this.#emitOutcome(record, outcome, this.#abortReasons.get(runId));
    this.#abortReasons.delete(runId);

    // Drain what is waiting before letting go of the lock, so a queued
    // trigger runs here rather than waiting for someone else to notice it.
    await this.#drain();

    return outcome.status;
  }

  /** Persists a finished run: history, last-* fields and counters. */
  async #record(record: RunRecord, outcome: RunOutcome): Promise<void> {
    const counters: Record<string, number> = { [outcome.status]: 1 };
    if (outcome.status !== "success") {
      counters.failed = 1;
    }

    try {
      await this.driver.updateHistory(
        this.namespace,
        this.#key,
        record.runId,
        record,
      );
      await this.driver.setState(this.namespace, this.#key, {
        lastFinishedAt: record.finishedAt ?? Date.now(),
        lastStatus: record.status,
        lastExitCode: record.exitCode ?? null,
        lastError: record.error
          ? JSON.stringify({
              name: record.error.name,
              message: record.error.message,
            })
          : null,
      });
      await this.#bump(counters);
    } catch (error) {
      this.#emitError(error, "record");
    }

    // Outside the block above, so a history write that failed does not lose
    // the run from the series too: the run did finish, whatever was stored.
    // One call carrying the duration, so a finished run is one write, into the
    // bucket it finished in.
    const finishedAt = record.finishedAt ?? Date.now();
    await this.#countRun(finishedAt, {
      [OUTCOME_COUNTERS[outcome.status]]: 1,
      durationMs: record.durationMs ?? finishedAt - record.startedAt,
    });
  }

  /**
   * Publishes an event for other processes, when this runner was asked to.
   *
   * A failure to publish is logged and swallowed: an observer missing an event
   * must never fail the run that produced it.
   */
  /**
   * Publishes an event, tracked so `close()` can wait for it.
   *
   * Callers fire it and move on, and a caller may close straight after — from
   * the very listener the event was emitted to. Untracked, the close shut the
   * driver under the write: a `completed` event from a process that closed on
   * completion was lost, and on MongoDB, whose publish takes two round trips,
   * reliably.
   */
  #publish<Name extends RunnerEventName>(
    type: Name,
    payload: RunnerEventPayloads[Name],
  ): Promise<void> {
    // Nothing to track, and nothing to allocate, for a runner that does not
    // publish.
    if (!this.options.publish) {
      return SETTLED;
    }

    const publishing = this.#doPublish(type, payload).finally(() => {
      this.#publishing.delete(publishing);
    });
    this.#publishing.add(publishing);
    return publishing;
  }

  /** The body of {@link #publish}. */
  async #doPublish<Name extends RunnerEventName>(
    type: Name,
    payload: RunnerEventPayloads[Name],
  ): Promise<void> {
    await this.#publishGate?.();

    try {
      await this.driver.publish(
        runnerEvent(
          { ns: this.namespace, target: this.id, type, origin: this.#origin },
          payload,
        ),
      );
    } catch (error) {
      this.#logger.warn("Could not publish a runner event", { error, type });
    }
  }

  /** Emits the event matching a run's outcome. */
  #emitOutcome(
    record: RunRecord,
    outcome: RunOutcome,
    abortReason: string | undefined,
  ): void {
    if (outcome.status !== "success") {
      void this.#publish("failed", {
        runId: record.runId,
        error:
          outcome.error ??
          serializeError(
            new Error(`The run ended with status ${outcome.status}`),
          ),
      });
    }

    switch (outcome.status) {
      case "success":
        this.safeEmit("finished", record, outcome.result as TResult);
        void this.#publish("succeeded", {
          runId: record.runId,
          durationMs: record.durationMs ?? 0,
        });
        break;
      case "timeout":
        this.safeEmit("timeout", record);
        void this.#publish("timeout", { runId: record.runId });
        this.safeEmit(
          "failed",
          record,
          outcome.error
            ? deserializeError(outcome.error)
            : new Error("timeout"),
        );
        break;
      case "killed":
        this.safeEmit("killed", record, abortReason ?? "killed");
        void this.#publish("killed", {
          runId: record.runId,
          reason: abortReason ?? "killed",
        });
        this.safeEmit(
          "failed",
          record,
          outcome.error ? deserializeError(outcome.error) : new Error("killed"),
        );
        break;
      default:
        this.safeEmit(
          "failed",
          record,
          outcome.error ? deserializeError(outcome.error) : new Error("failed"),
        );
    }
  }

  /**
   * Runs whatever is queued, then releases the lock in single mode.
   *
   * While paused only a forced head is taken, from either queue; an unforced
   * head stops the drain and leaves the queue as it was for `resume()`.
   */
  async #drain(): Promise<void> {
    if (this.#draining) {
      return;
    }

    this.#draining = true;
    try {
      if (this.#runMode === "parallel") {
        while (
          this.#active.size < this.#maxConcurrency &&
          this.#status !== "stopped"
        ) {
          // The same gate as the driver's queue: while paused, only a forced
          // head runs, and an unforced one holds everything behind it.
          const trigger = this.#localQueue[0];
          if (!trigger || (this.#paused && trigger.force !== true)) {
            break;
          }
          this.#localQueue.shift();
          this.safeEmit("dequeued", { id: trigger.id, args: trigger.args });
          await this.#startRun(trigger.args, "queued");
        }
        return;
      }

      while (this.#status !== "stopped") {
        // Something triggered while we were draining: that run holds the
        // exclusivity now, and its own drain will pick up where this left off.
        if (this.#active.size > 0) {
          return;
        }

        // While paused, only a forced head is taken; the lock is released
        // below when nothing runs.
        const trigger = await this.#takeQueued();
        if (!trigger) {
          break;
        }

        // A remote controller queues a trigger without knowing the runner's
        // default arguments; a local trigger has already resolved them.
        const args = (trigger.args as TArgs | undefined) ?? this.options.args;
        this.safeEmit("dequeued", { id: trigger.id, args });
        await this.#startRun(args, "queued");
      }
    } catch (error) {
      this.#emitError(error, "drain");
    } finally {
      this.#draining = false;

      // Whenever the lock is held and nothing is running, not only in single
      // mode: a `single` → `parallel` switch leaves a lock nothing will ever
      // release again, and it would sit there until its TTL lapsed. Only
      // single mode ever takes one, so this is a no-op the rest of the time.
      // Nor while a trigger is reusing it: that trigger's run holds it now,
      // and its own drain releases it.
      if (this.#lockToken && this.#active.size === 0 && this.#reusing === 0) {
        await this.#releaseLock();
      }
    }
  }

  /** Applies counter deltas, tolerating a driver that cannot take them. */
  async #bump(deltas: Record<string, number>): Promise<void> {
    const prefixed: Record<string, number> = {};
    for (const [field, delta] of Object.entries(deltas)) {
      prefixed[`stat:${field}`] = delta;
    }

    try {
      await this.driver.incrementCounters(this.namespace, this.#key, prefixed);
    } catch (error) {
      this.#emitError(error, "counters");
    }
  }

  /**
   * Counts a runner event into the analytics buckets — a run starting, one
   * finishing with its duration, a trigger skipped — beside the lifetime
   * counters {@link #bump} keeps, which stay exactly as they are.
   *
   * Written only while `metrics.runners` is on and the driver has
   * `countRunnerRun`; the duration only while `metrics.durations` is. Never
   * throws: capture must not change a run's outcome, so a driver that fails is
   * logged once and otherwise ignored. Awaited by its callers, so the count is
   * in the driver's buffer before `stop()` flushes it.
   */
  async #countRun(at: number, counts: RunnerRunDelta): Promise<void> {
    const { runners, durations } = this.options.metrics;

    if (!runners || typeof this.driver.countRunnerRun !== "function") {
      return;
    }

    const { durationMs, ...outcomes } = counts;

    try {
      await this.driver.countRunnerRun(
        this.namespace,
        this.#key,
        at,
        durations && durationMs !== undefined
          ? { ...outcomes, durationMs }
          : outcomes,
      );
    } catch (error) {
      this.#metricsFailure(error);
    }
  }

  /**
   * Writes the analytics counts the driver has gathered in memory. Awaited on
   * stop whether or not this runner owns the driver: a process sharing one
   * driver may exit without ever closing it, and the last second of counts
   * would go with the process.
   */
  async #flushMetrics(): Promise<void> {
    if (typeof this.driver.flushMetrics !== "function") {
      return;
    }

    try {
      await this.driver.flushMetrics();
    } catch (error) {
      this.#metricsFailure(error);
    }
  }

  /**
   * Logs an analytics write that failed, the first time only. Never through
   * the `error` event: a series losing a point is not a failure of the runner,
   * and a listener that treats `error` as fatal must not be handed one.
   */
  #metricsFailure(error: unknown): void {
    if (this.#metricsFailed) {
      return;
    }

    this.#metricsFailed = true;
    this.#logger.warn(
      "Could not record runner analytics; further failures will not be logged",
      { error },
    );
  }

  /** Reports a failure outside a run, and logs it when nobody is listening. */
  #emitError(error: unknown, context: string): void {
    const failure =
      error instanceof Error ? error : deserializeError(serializeError(error));

    // Asked of `error` itself: a listener for any other event makes `emit`
    // throw on an unheard `error`, which `safeEmit` swallows as "heard".
    if (this.listenerCount("error") === 0) {
      this.#logger.error(failure, { context });
      return;
    }

    this.safeEmit("error", failure, context);
  }
}
