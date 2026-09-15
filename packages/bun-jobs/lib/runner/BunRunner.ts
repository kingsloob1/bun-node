import type {
  JobsDriver,
  RunRecord,
  RunSource,
  RunStatus,
} from "../drivers/index";
import type { RunnerEventName, RunnerEventPayloads } from "../shared/events";
import type { Logger } from "../shared/logger";
import type { RunnerSchedule, ScheduleInput, Ticker } from "../shared/schedule";
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
  RunnerInfo,
  RunnerStats,
  RunnerStatus,
  TriggerOutcome,
} from "./types";
import { deserializeError, serializeError } from "@kingsleyweb/bun-common";
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
import { InProcessExecutor } from "./executors/in-process";
import { SpawnExecutor } from "./executors/spawn";
import { WorkerExecutor } from "./executors/worker";
import { resolveRunnerOptions } from "./options";

/** A publish that does nothing: already settled, and shared, so it costs nothing. */
const SETTLED: Promise<void> = Promise.resolve();

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
  /** How runs execute. */
  readonly #executor: Executor;
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
  /** Triggers parked locally (parallel mode only; single mode uses the driver). */
  readonly #localQueue: { id: string; args?: TArgs }[] = [];
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
  /** Renews the lock while a run holds it. */
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  /** Set while the lock holder drains queued triggers, to avoid re-entering. */
  #draining = false;

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

    await this.driver.setState(this.namespace, this.#key, {
      paused: this.#paused ? "1" : "0",
      schedule: JSON.stringify(this.#schedule),
      file: this.file,
      updatedAt: Date.now(),
      updatedBy: newToken(),
    });

    this.#status = this.#paused ? "paused" : "running";
    this.#armTicker();
    this.#armSync();

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
    // Then whatever is still being written for runs that already settled.
    await Promise.allSettled([...this.#settling]);
    await Promise.allSettled([...this.#publishing]);

    this.#clearHeartbeat();
    await this.#releaseLock();

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

  /** Resumes the runner everywhere, optionally firing a run straight away. */
  async resume(options?: { triggerNow?: boolean }): Promise<void> {
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
   */
  async trigger(options?: {
    /** Arguments for this run; defaults to the runner's `args`. */
    args?: TArgs;
    /** Run even while paused. */
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

    if (this.options.runMode === "parallel") {
      if (this.#active.size >= this.options.maxConcurrency) {
        return await this.#queueLocally(args, "max-concurrency");
      }
      return { outcome: "started", runId: await this.#startRun(args, source) };
    }

    // Single mode. A run already in flight here means the lock is ours, so
    // there is no point asking for it again.
    if (this.#active.size > 0) {
      return await this.#queueInDriver(args, source, "busy");
    }

    // The lock outlives a run until its drain finishes, so a trigger arriving
    // in that window reuses what this instance already holds rather than
    // fighting itself for it.
    if (this.#lockToken && (await this.#renew(this.#lockToken))) {
      return { outcome: "started", runId: await this.#startRun(args, source) };
    }

    const token = newToken(this.id);
    const acquired = await this.#acquireLock(token);
    if (!acquired) {
      return await this.#queueInDriver(args, source, "lock-held");
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
      executionMode: this.options.executionMode,
      runMode: this.options.runMode,
      queueRuns: this.options.queueRuns,
      maxConcurrency: this.options.maxConcurrency,
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

  /** Builds the executor for the configured mode. */
  #createExecutor(): Executor {
    switch (this.options.executionMode) {
      case "in-process":
        return new InProcessExecutor(this.options.inProcess);
      case "worker":
        return new WorkerExecutor(this.options.worker);
      default:
        return new SpawnExecutor(this.options.spawn);
    }
  }

  /** Reads the persisted paused flag and schedule, tolerating a bad read. */
  async #readState(): Promise<{
    paused?: boolean;
    schedule?: RunnerSchedule;
  }> {
    try {
      const state = await this.driver.getState(this.namespace, this.#key);
      return {
        paused: state.paused === undefined ? undefined : state.paused === "1",
        schedule: state.schedule
          ? (JSON.parse(state.schedule) as RunnerSchedule)
          : undefined,
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
    this.safeEmit("skipped", outcome);
    void this.#publish("skipped", { reason: outcome.reason });
    return outcome;
  }

  /** Parks a trigger in this process (parallel mode). */
  async #queueLocally(
    args: TArgs | undefined,
    reason: (TriggerOutcome & { outcome: "skipped" })["reason"],
  ): Promise<TriggerOutcome> {
    if (!this.options.queueRuns) {
      return await this.#skip(reason);
    }

    if (this.#localQueue.length >= this.options.maxQueuedRuns) {
      return await this.#skip("queue-full");
    }

    const trigger = { id: newId(), args };
    this.#localQueue.push(trigger);
    await this.#bump({ queued: 1 });
    this.safeEmit("queued", trigger);
    void this.#publish("queued", { runId: trigger.id });

    return { outcome: "queued", position: this.#localQueue.length };
  }

  /**
   * Parks a trigger in the driver (single mode), so the demand survives this
   * process and whoever holds the lock drains it.
   */
  async #queueInDriver(
    args: TArgs | undefined,
    source: RunSource,
    reason: (TriggerOutcome & { outcome: "skipped" })["reason"],
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

    try {
      await this.driver.releaseLock(this.namespace, this.#key, token);
    } catch (error) {
      this.#emitError(error, "releaseLock");
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
      mode: this.options.executionMode,
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

    const controller = new AbortController();
    const context = this.#buildContext(
      runId,
      args,
      source,
      startedAt,
      controller,
    );

    const handle = this.#executor.start({
      context,
      file: this.file,
      timeout: this.options.timeout,
      closeTimeout: this.options.closeTimeout,
      killTimeout: this.options.killTimeout,
      waitToExit: this.options.waitToExit,
      forwardLogs: this.options.forwardLogs,
      events: {
        onProgress: (value) => this.safeEmit("progress", record, value),
        // The executor is transport and hands messages over untyped; this is
        // where they take the type the runner was declared with. Nothing at
        // runtime checks it — the handler is trusted to send what it declares.
        onMessage: (data) =>
          this.safeEmit("message", record, data as TFromHandler),
        onLog: (level, message, fields) =>
          this.safeEmit("log", record, level, message, fields),
        onOutput: (stream, chunk) =>
          this.safeEmit("output", record, stream, chunk),
        onPid: (pid) => {
          record.pid = pid;
        },
      },
    });

    const settle = this.#finish(runId, record, handle);
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

  /** The context handed to the handler. */
  #buildContext(
    runId: string,
    args: TArgs | undefined,
    source: RunSource,
    startedAt: number,
    controller: AbortController,
  ): RunContext<TArgs> {
    return {
      runId,
      runnerId: this.id,
      runnerName: this.name,
      namespace: this.namespace,
      attempt: 1,
      source,
      mode: this.options.executionMode,
      startedAt,
      deadline:
        this.options.timeout > 0 ? startedAt + this.options.timeout : null,
      args: args as TArgs,
      signal: controller.signal,
      logger: this.#logger.child({ runId }),
      progress: () => {},
      send: () => {},
      onMessage: () => () => {},
      ...(this.options.childDriver
        ? { driverConfig: this.options.childDriver }
        : {}),
      ...(this.options.executionMode === "in-process"
        ? { driver: this.driver }
        : {}),
    };
  }

  /** Waits for a run to settle, records the outcome and drains what is queued. */
  async #finish(
    runId: string,
    record: RunRecord,
    handle: ExecutorHandle,
  ): Promise<RunStatus> {
    const outcome = await handle.done;
    const finishedAt = Date.now();

    Object.assign(record, {
      status: outcome.status,
      finishedAt,
      durationMs: finishedAt - record.startedAt,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.signal !== undefined ? { signal: outcome.signal } : {}),
      ...(outcome.detached ? { detached: true } : {}),
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

  /** Runs whatever is queued, then releases the lock in single mode. */
  async #drain(): Promise<void> {
    if (this.#draining) {
      return;
    }

    this.#draining = true;
    try {
      if (this.options.runMode === "parallel") {
        while (
          this.#localQueue.length > 0 &&
          this.#active.size < this.options.maxConcurrency &&
          this.#status !== "stopped"
        ) {
          const trigger = this.#localQueue.shift();
          if (!trigger) {
            break;
          }
          this.safeEmit("dequeued", trigger);
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

        const trigger = await this.driver.popQueuedTrigger(
          this.namespace,
          this.#key,
        );
        if (!trigger) {
          break;
        }

        this.safeEmit("dequeued", {
          id: trigger.id,
          args: trigger.args as TArgs,
        });
        await this.#startRun(trigger.args as TArgs, "queued");
      }
    } catch (error) {
      this.#emitError(error, "drain");
    } finally {
      this.#draining = false;

      if (this.options.runMode === "single" && this.#active.size === 0) {
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
