import type { QueueDemand } from "../drivers/readApis";
import type { BunQueueWorker } from "../queue/BunQueueWorker";
import type { JobMapOf } from "../queue/types";
import type { Logger, LoggerLike } from "../shared/logger";
import type { WorkerTargetKind } from "../shared/workers";
import process from "node:process";
import {
  listWorkerRecords,
  readDemand,
  supportsWorkers,
} from "../drivers/readApis";
import { TARGET_CLOSE_GRACE, TARGET_CLOSE_REAP } from "../queue/workerTarget";
import { DEFAULT_CLOSE_TIMEOUT } from "../shared/constants";
import { ConfigError } from "../shared/errors";
import { resolveLogger } from "../shared/logger";
import { summonedFromArgs } from "./args";

/**
 * The worker half of summoning: {@link runSummoned} runs a worker until it is
 * no longer needed, handles the platform's signals, and stops it inside the
 * platform's grace.
 *
 * It uses only the worker's public surface (`run()`, `close()`, `pause()`,
 * `resume()`, `activeCount`, `state`, its events and its driver), so nothing
 * here touches the worker's close path.
 */

/** How a summoned worker drains and stops. */
export interface RunSummonedOptions {
  /**
   * `"exit-on-idle"`: exit once the queue has been idle for `idleFor`, or
   * parked for as long. `"until-stopped"`: never exit on idle or when parked,
   * only on a signal or the deadline, because the platform restarts an exited
   * service. `"in-invocation"`: as `"exit-on-idle"`, but resolve instead of
   * exiting and install no signal handlers, for a Lambda handler that must
   * return with no lease outliving the invocation. Defaults to the mode the
   * summoner requested (`--bun-jobs-summon-mode=`), else `"exit-on-idle"`.
   */
  mode?: "exit-on-idle" | "until-stopped" | "in-invocation";
  /**
   * How long the queue must stay idle before an `"exit-on-idle"` or
   * `"in-invocation"` worker stops, in ms, and how long a parked one waits
   * before it does. Idle means nothing in flight here, no demand, no other
   * worker's jobs left with nobody alive to finish them, and nothing due
   * within `idleFor`. Defaults to `30_000`.
   */
  idleFor?: number;
  /**
   * How often idleness, parking and the deadline are checked, in ms. Each
   * idle check costs one `countDemand` and one worker listing. Defaults to
   * `5_000`.
   */
  idleCheckInterval?: number;
  /**
   * The latest the worker may run to, as epoch ms or a function returning it
   * (Lambda: `() => Date.now() + context.getRemainingTimeInMillis()`). A
   * function is read at the start and again at every check. Defaults to the
   * summoner's `--bun-jobs-summon-max-lifetime-ms=` from now, else none.
   */
  deadline?: number | (() => number);
  /**
   * Stop claiming this long before `deadline`, in ms, so jobs in flight can
   * settle before the platform kills the process. Defaults to `7_000`,
   * Temporal's `shutdownDeadlineBufferMs`.
   */
  shutdownBuffer?: number;
  /**
   * How long the platform waits after its stop signal before `SIGKILL`, in
   * ms. After a signal the worker closes gracefully only when this budget
   * covers the target's close and `tailReserve`, and with `force` otherwise
   * (the close rule). Defaults to the summoner's `--bun-jobs-summon-grace-ms=`,
   * else `10_000` (Cloud Run's figure, the shortest common non-zero one).
   */
  grace?: number;
  /**
   * How much of the budget to keep for what `close()` does after the target
   * has closed (deregistering, flushing, metrics, dead letters, the limiter,
   * the driver), in ms. The target's own close is budgeted separately, from
   * the package's close constants. Defaults to `1_000`: measured at 5 to
   * 15 ms against local servers, so the rest is headroom for a remote one.
   * A hard exit at `grace − 250` backs it up.
   */
  tailReserve?: number;
  /**
   * Signals that start a graceful stop. Defaults to `["SIGTERM", "SIGINT"]`:
   * SIGINT because Fly sends it by default. A second SIGINT exits at once
   * with code 130. `false` installs none. Ignored in `"in-invocation"` mode,
   * which installs no handlers.
   */
  signals?: readonly NodeJS.Signals[] | false;
  /**
   * Treat SIGTSTP as "stop claiming" and SIGCONT as "resume", for Cloud Run
   * jobs over an hour. SIGCONT resumes only a pause SIGTSTP made, never an
   * operator's. Defaults to `true`; ignored in `"in-invocation"` mode.
   * Whether catching SIGTSTP delays the platform's own pause is unverified.
   */
  pauseSignals?: boolean;
  /**
   * Call `process.exit(code)` once closed, and exit at the hard backstop if
   * the close overruns the budget. Defaults to `true`, except in
   * `"in-invocation"` mode, which never arms the backstop. The code is `0`
   * after an idle drain, parking, a deadline or a signal, and `1` only when
   * `run()` itself failed: several platforms restart a non-zero exit.
   */
  exit?: boolean;
  /** Where it logs its decisions. Defaults to the worker's logger. */
  logger?: LoggerLike;
}

/** Why and how a summoned worker stopped. */
export interface SummonedExit {
  /**
   * What ended it: `"idle"`, `"parked"` (an operator stopped it), `"signal"`,
   * `"deadline"`, `"error"` (`run()` failed), or `"closed"` (something other
   * than `runSummoned` closed the worker).
   */
  reason: "idle" | "parked" | "signal" | "deadline" | "error" | "closed";
  /** The signal, when `reason` is `"signal"`. */
  signal?: string;
  /** How long it ran, in ms. */
  ranForMs: number;
  /** Jobs it completed. */
  completed: number;
  /** Attempts it failed. */
  failed: number;
  /** The exit code it used, or would have used in `"in-invocation"` mode. */
  code: 0 | 1;
}

/**
 * The events {@link runSummoned} listens to, each with a listener that takes
 * no arguments. Every worker, whatever its job map, emits them: a listener
 * ignoring an event's arguments fits any of its signatures, which a generic
 * worker's event map cannot show the compiler.
 */
interface SummonedWorkerEvents {
  /** Adds a listener. */
  on: (event: SummonedWorkerEvent, listener: () => void) => unknown;
  /** Adds a one-shot listener. */
  once: (event: SummonedWorkerEvent, listener: () => void) => unknown;
  /** Removes a listener. */
  off: (event: SummonedWorkerEvent, listener: () => void) => unknown;
}

/** The worker events {@link runSummoned} listens to. */
type SummonedWorkerEvent =
  | "ready"
  | "completed"
  | "failed"
  | "paused"
  | "resumed"
  | "closed";

/** The modes {@link RunSummonedOptions.mode} accepts. */
type SummonedMode = NonNullable<RunSummonedOptions["mode"]>;

/** Every default {@link runSummoned} applies, named in one place. */
export const RUN_SUMMONED_DEFAULTS = {
  /** {@link RunSummonedOptions.idleFor}. */
  idleFor: 30_000,
  /** {@link RunSummonedOptions.idleCheckInterval}. */
  idleCheckInterval: 5_000,
  /** {@link RunSummonedOptions.shutdownBuffer}. */
  shutdownBuffer: 7_000,
  /** {@link RunSummonedOptions.grace}, when the summoner passed none. */
  grace: 10_000,
  /** {@link RunSummonedOptions.tailReserve}. */
  tailReserve: 1_000,
  /**
   * How far ahead of the platform's kill the hard backstop exits, in ms: it
   * fires at `grace − 250` after a signal and at `deadline − 250`.
   */
  backstopMargin: 250,
} as const;

/**
 * How long a target's `close()` can take, graceful and forced, derived from
 * the package's close constants rather than chosen:
 *
 * - a target with children (`"child-process"`, `"worker-thread"`): graceful
 *   is `TARGET_CLOSE_GRACE + TARGET_CLOSE_REAP` (4,500 ms), forced is
 *   `TARGET_CLOSE_REAP` (500 ms);
 * - `"in-process"`: nothing of its own;
 * - `"custom"`, or a target not yet known: the worker's bound on any
 *   target's close, `DEFAULT_CLOSE_TIMEOUT` (5,000 ms), either way, since it
 *   may ignore `force`.
 *
 * Internal; exported for its tests.
 */
export function summonTargetClose(
  /** The target's kind, from the worker's record; `undefined` when unknown. */
  kind: WorkerTargetKind | undefined,
  /** Whether the close is forced. */
  force: boolean,
): number {
  switch (kind) {
    case "child-process":
    case "worker-thread":
      return force ? TARGET_CLOSE_REAP : TARGET_CLOSE_GRACE + TARGET_CLOSE_REAP;
    case "in-process":
      return 0;
    default:
      return DEFAULT_CLOSE_TIMEOUT;
  }
}

/** What the close rule decided: the options to close with, and why. */
export interface SummonCloseDecision {
  /** `true` for `close({ force: true })`. */
  force: boolean;
  /**
   * For a graceful close with a finite budget, the jobs' `timeout`: what is
   * left once the target's close and the tail are reserved. Absent for a
   * forced close, and for a graceful one with no budget at all (the
   * worker's own default then applies).
   */
  timeout?: number;
  /** The time until the hard backstop, in ms, `Infinity` when there is none. */
  budget: number;
  /** The target's close that was reserved, in ms. */
  targetClose: number;
}

/**
 * The close rule: graceful while the budget covers the target's graceful
 * close plus `tailReserve`, with the jobs given the rest; `force` otherwise.
 * Evaluated once, when closing starts: the budget only shrinks, so a graceful
 * choice never needs revisiting except by the backstop.
 *
 * Internal; exported for its tests.
 */
export function summonCloseRule(input: {
  /** The time until the hard backstop, in ms; `Infinity` for none. */
  budget: number;
  /** The target's kind; `undefined` when unknown. */
  kind: WorkerTargetKind | undefined;
  /** {@link RunSummonedOptions.tailReserve}. */
  tailReserve: number;
}): SummonCloseDecision {
  const graceful = summonTargetClose(input.kind, false);

  if (input.budget === Number.POSITIVE_INFINITY) {
    return { force: false, budget: input.budget, targetClose: graceful };
  }

  if (input.budget >= graceful + input.tailReserve) {
    return {
      force: false,
      timeout: Math.floor(input.budget - graceful - input.tailReserve),
      budget: input.budget,
      targetClose: graceful,
    };
  }

  return {
    force: true,
    budget: input.budget,
    targetClose: summonTargetClose(input.kind, true),
  };
}

/**
 * A test seam: set under {@link RUN_SUMMONED_PROBE} on the options object, it
 * replaces the close rule, so a negative control can show what a close the
 * rule would not choose does. Nothing in the package sets it.
 */
export interface RunSummonedProbe {
  /** Decides the close in place of {@link summonCloseRule}. */
  closeRule?: typeof summonCloseRule;
}

/** The property a {@link RunSummonedProbe} is set under on the options. */
export const RUN_SUMMONED_PROBE: unique symbol = Symbol.for(
  "@kingsleyweb/bun-jobs:run-summoned-probe",
);

/**
 * Whether a queue is idle for a summoned worker: nothing in flight here, no
 * demand, none of another worker's jobs left with nobody alive to finish
 * them, and nothing coming due within `idleFor`.
 *
 * `activeCount > 0` is busy, always: a worker may count an attempt twice
 * while a recovered one is still running, never fewer than it has.
 *
 * Internal; exported for its tests.
 */
export function isSummonIdle(input: {
  /** The worker's `activeCount`. */
  ownActive: number;
  /** The queue's demand reading. */
  demand: Pick<QueueDemand, "demand" | "active" | "nextDueAt">;
  /** Live workers other than this one. */
  otherLiveWorkers: number;
  /** The instant of the reading, epoch ms. */
  now: number;
  /** {@link RunSummonedOptions.idleFor}. */
  idleFor: number;
}): boolean {
  const { demand } = input;
  return (
    input.ownActive === 0 &&
    demand.demand === 0 &&
    !(demand.active > 0 && input.otherLiveWorkers === 0) &&
    (demand.nextDueAt === null || demand.nextDueAt > input.now + input.idleFor)
  );
}

/** A non-negative finite number of ms, or a `ConfigError` naming the option. */
function duration(
  name: string,
  value: number | undefined,
  fallback: number,
  { positive = false }: { positive?: boolean } = {},
): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (positive && value === 0)
  ) {
    throw new ConfigError(
      `runSummoned: ${name} must be a ${positive ? "positive" : "non-negative"} finite number of milliseconds`,
      { [name]: value },
    );
  }
  return value;
}

/** Whether `value` is one of the modes. */
function isMode(value: unknown): value is SummonedMode {
  return (
    value === "exit-on-idle" ||
    value === "until-stopped" ||
    value === "in-invocation"
  );
}

/** The part of a worker {@link runSummoned} uses: its public surface only. */
type SummonedWorker = Pick<
  BunQueueWorker,
  | "id"
  | "ref"
  | "driver"
  | "logger"
  | "state"
  | "activeCount"
  | "isRunning"
  | "isPaused"
  | "run"
  | "close"
  | "pause"
  | "resume"
>;

/** A stop, and why. */
interface SummonedStop {
  /** Why it stops. */
  reason: SummonedExit["reason"];
  /** The signal, for a signal. */
  signal?: string;
}

/** {@link RunSummonedOptions}, resolved once, before anything starts. */
interface ResolvedSummonedOptions {
  /** The mode in force. */
  mode: SummonedMode;
  /** {@link RunSummonedOptions.idleFor}. */
  idleFor: number;
  /** {@link RunSummonedOptions.idleCheckInterval}. */
  idleCheckInterval: number;
  /** {@link RunSummonedOptions.shutdownBuffer}. */
  shutdownBuffer: number;
  /** {@link RunSummonedOptions.grace}. */
  grace: number;
  /** {@link RunSummonedOptions.tailReserve}. */
  tailReserve: number;
  /** The stop signals to handle; empty for none. */
  signals: readonly NodeJS.Signals[];
  /** Whether SIGTSTP/SIGCONT are handled. */
  pauseSignals: boolean;
  /** Whether it calls `process.exit`. */
  exit: boolean;
  /** Whether the hard backstop is armed: `exit`, outside `"in-invocation"`. */
  backstop: boolean;
  /** Where it logs. */
  logger: Logger;
  /** The test seam, when set. */
  probe: RunSummonedProbe | undefined;
  /** Reads the deadline, epoch ms, or `undefined` for none. */
  readDeadline: () => number | undefined;
  /** Whether the deadline is a function, re-read at every check. */
  deadlineIsLive: boolean;
}

/** Resolves and checks the options. Throws a `ConfigError` on a bad one. */
function resolveOptions(
  options: RunSummonedOptions,
  workerLogger: Logger,
): ResolvedSummonedOptions {
  const summoned = summonedFromArgs();
  const mode = options.mode ?? summoned?.mode ?? "exit-on-idle";
  if (!isMode(mode)) {
    throw new ConfigError(
      "runSummoned: mode must be exit-on-idle, until-stopped or in-invocation",
      { mode },
    );
  }
  const inInvocation = mode === "in-invocation";
  const exit = options.exit ?? !inInvocation;

  const readDeadline = (): number | undefined => {
    const raw =
      typeof options.deadline === "function"
        ? options.deadline()
        : (options.deadline ?? summoned?.deadlineAt);
    if (raw === undefined) {
      return undefined;
    }
    if (typeof raw !== "number" || Number.isNaN(raw)) {
      throw new ConfigError("runSummoned: deadline must be epoch ms", {
        deadline: raw,
      });
    }
    return raw;
  };

  return {
    mode,
    idleFor: duration(
      "idleFor",
      options.idleFor,
      RUN_SUMMONED_DEFAULTS.idleFor,
    ),
    idleCheckInterval: duration(
      "idleCheckInterval",
      options.idleCheckInterval,
      RUN_SUMMONED_DEFAULTS.idleCheckInterval,
      { positive: true },
    ),
    shutdownBuffer: duration(
      "shutdownBuffer",
      options.shutdownBuffer,
      RUN_SUMMONED_DEFAULTS.shutdownBuffer,
    ),
    grace: duration(
      "grace",
      options.grace,
      summoned?.graceMs ?? RUN_SUMMONED_DEFAULTS.grace,
    ),
    tailReserve: duration(
      "tailReserve",
      options.tailReserve,
      RUN_SUMMONED_DEFAULTS.tailReserve,
    ),
    signals:
      inInvocation || options.signals === false
        ? []
        : (options.signals ?? ["SIGTERM", "SIGINT"]),
    pauseSignals: !inInvocation && (options.pauseSignals ?? true),
    exit,
    backstop: exit && !inInvocation,
    logger:
      options.logger === undefined
        ? workerLogger
        : resolveLogger(options.logger),
    probe: (options as { [RUN_SUMMONED_PROBE]?: RunSummonedProbe })[
      RUN_SUMMONED_PROBE
    ],
    readDeadline,
    deadlineIsLive: typeof options.deadline === "function",
  };
}

/**
 * One summoned run: the listeners, the timers and the single close. Built
 * and started by {@link runSummoned}.
 */
class SummonedRun {
  /** The worker, through its public surface. */
  readonly #worker: SummonedWorker;
  /** The worker's events, with argument-less listeners. */
  readonly #events: SummonedWorkerEvents;
  /** The resolved options. */
  readonly #options: ResolvedSummonedOptions;
  /** Where decisions are logged. */
  readonly #logger: Logger;
  /** When it started, epoch ms. */
  readonly #startedAt = Date.now();
  /** Settles with the result. */
  readonly #finished = Promise.withResolvers<SummonedExit>();
  /** The signal handlers installed, to remove exactly those. */
  readonly #signalHandlers = new Map<NodeJS.Signals, () => void>();

  /** Jobs completed. */
  #completed = 0;
  /** Attempts failed. */
  #failed = 0;
  /** Whether the worker has emitted `ready` (or failed to start). */
  #ready = false;
  /** A stop asked for before `ready`, carried out once it fires. */
  #pendingStop: SummonedStop | undefined;
  /** Set once closing has started: `close()` is called at most once. */
  #closing: SummonedStop | undefined;
  /** Whether it has finished. */
  #done = false;
  /** Since when the queue has been idle, epoch ms. */
  #idleSince: number | undefined;
  /** Since when the worker has been parked, epoch ms. */
  #parkedSince: number | undefined;
  /** Whether a check is in progress. */
  #checking = false;
  /** The deadline, epoch ms, or `undefined` for none. */
  #deadlineAt: number | undefined;
  /** The deadline the deadline timer is armed for. */
  #deadlineArmedFor: number | undefined;
  /** The target's kind, once the worker's own record has been read. */
  #targetKind: WorkerTargetKind | undefined;
  /** Whether the worker's own record has been seen, so it can be discounted. */
  #selfListed = false;
  /** Whether a SIGINT has been received: a second one exits at once. */
  #sawSigint = false;
  /** Whether the current pause is one SIGTSTP made. */
  #pausedBySignal = false;
  /** Set while this code pauses or resumes, so its own events are told apart. */
  #toggling = false;
  /** The periodic check. */
  #tick: ReturnType<typeof setInterval> | undefined;
  /** The stop at `deadline − shutdownBuffer`. */
  #deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  /** The hard backstop. */
  #backstop: ReturnType<typeof setTimeout> | undefined;
  /** When the hard backstop fires, epoch ms. */
  #backstopAt: number | undefined;
  /**
   * The earliest the platform's kill can land after a signal, less the
   * backstop's margin, epoch ms; `undefined` before any signal.
   */
  #killAt: number | undefined;
  /** The warning for a close that outlives its budget, without a backstop. */
  #overrunWarning: ReturnType<typeof setTimeout> | undefined;
  /** The quick retries reading the worker's own record after `ready`. */
  #lookupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** The worker. */
    worker: SummonedWorker,
    /** The same worker's events. */
    events: SummonedWorkerEvents,
    /** The resolved options. */
    options: ResolvedSummonedOptions,
  ) {
    this.#worker = worker;
    this.#events = events;
    this.#options = options;
    this.#logger = options.logger;
    this.#deadlineAt = options.readDeadline();
  }

  /** Installs everything, starts the worker, and settles with the result. */
  async start(): Promise<SummonedExit> {
    this.#install();
    this.#armDeadline();

    this.#worker.run().then(
      () => {
        // `run()` resolves once the claim loop stops, which a close in
        // progress already accounts for; one nobody here started is seen
        // through the `closed` event.
      },
      (error: unknown) => {
        this.#logger.error("Summoned worker could not start", { error });
        this.#ready = true;
        this.#pendingStop = undefined;
        this.#beginClose({ reason: "error" });
      },
    );

    return await this.#finished.promise;
  }

  /* --- listeners ------------------------------------------------------- */

  readonly #onCompleted = (): void => {
    this.#completed += 1;
  };

  readonly #onFailed = (): void => {
    this.#failed += 1;
  };

  /**
   * A pause or resume this code did not make hands the pause to whoever
   * made it: an operator's pause must survive the next SIGCONT.
   */
  readonly #onPausedOrResumed = (): void => {
    if (!this.#toggling) {
      this.#pausedBySignal = false;
    }
  };

  /** Closed by something else: the caller's own code, say. */
  readonly #onClosed = (): void => {
    if (this.#closing === undefined && !this.#done) {
      this.#closing = { reason: "closed" };
      this.#logger.info("Summoned worker was closed by its owner", {
        reason: "closed",
      });
      this.#finish(this.#closing);
    }
  };

  /**
   * Synchronous, inside the `ready` event: a close started here marks the
   * worker closing before its claim loop takes its first turn.
   */
  readonly #onReady = (): void => {
    this.#ready = true;
    const pending = this.#pendingStop;
    if (pending !== undefined) {
      this.#pendingStop = undefined;
      this.#beginClose(pending);
      return;
    }
    this.#startWatching();
  };

  #onStopSignal(signal: NodeJS.Signals): void {
    if (signal === "SIGINT") {
      // Ctrl-C twice: a developer is not held hostage by a drain. Only a
      // second SIGINT, never the first arriving during an idle or deadline
      // close, which is simply the platform's stop.
      if (this.#sawSigint) {
        this.#logger.warn("Second SIGINT: exiting at once", {
          signal,
          code: 130,
        });
        process.exit(130);
      }
      this.#sawSigint = true;
    }
    if (this.#closing !== undefined || this.#pendingStop !== undefined) {
      this.#logger.info("Summoned worker already stopping; signal noted", {
        signal,
      });
      // The platform's clock started with this signal, whatever began the
      // close: its kill lands `grace` from now.
      this.#noteSignal();
      return;
    }
    this.#requestStop({ reason: "signal", signal });
  }

  readonly #onTstp = (): void => {
    if (this.#closing !== undefined || this.#worker.isPaused()) {
      this.#logger.info("SIGTSTP: already paused or stopping; left as it is", {
        signal: "SIGTSTP",
      });
      return;
    }
    this.#toggling = true;
    try {
      void this.#worker.pause().catch((error: unknown) => {
        this.#logger.warn("SIGTSTP: pausing failed", { error });
      });
      this.#pausedBySignal = true;
    } finally {
      this.#toggling = false;
    }
    this.#logger.info("SIGTSTP: stopped claiming until SIGCONT", {
      signal: "SIGTSTP",
    });
  };

  readonly #onCont = (): void => {
    if (!this.#pausedBySignal || this.#closing !== undefined) {
      this.#logger.info(
        "SIGCONT: no pause of SIGTSTP's to lift; left as it is",
        { signal: "SIGCONT" },
      );
      return;
    }
    this.#pausedBySignal = false;
    this.#toggling = true;
    try {
      this.#worker.resume();
    } finally {
      this.#toggling = false;
    }
    this.#logger.info("SIGCONT: claiming again", { signal: "SIGCONT" });
  };

  #install(): void {
    this.#events.on("completed", this.#onCompleted);
    this.#events.on("failed", this.#onFailed);
    this.#events.on("paused", this.#onPausedOrResumed);
    this.#events.on("resumed", this.#onPausedOrResumed);
    this.#events.on("closed", this.#onClosed);
    this.#events.once("ready", this.#onReady);

    for (const signal of this.#options.signals) {
      const handler = (): void => this.#onStopSignal(signal);
      this.#signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    if (this.#options.pauseSignals) {
      this.#signalHandlers.set("SIGTSTP", this.#onTstp);
      process.on("SIGTSTP", this.#onTstp);
      this.#signalHandlers.set("SIGCONT", this.#onCont);
      process.on("SIGCONT", this.#onCont);
    }
  }

  #uninstall(): void {
    this.#events.off("completed", this.#onCompleted);
    this.#events.off("failed", this.#onFailed);
    this.#events.off("paused", this.#onPausedOrResumed);
    this.#events.off("resumed", this.#onPausedOrResumed);
    this.#events.off("closed", this.#onClosed);
    this.#events.off("ready", this.#onReady);
    for (const [signal, handler] of this.#signalHandlers) {
      process.off(signal, handler);
    }
    this.#signalHandlers.clear();
  }

  /* --- timers ---------------------------------------------------------- */

  #clearTimers(): void {
    clearInterval(this.#tick);
    this.#tick = undefined;
    clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = undefined;
    clearTimeout(this.#backstop);
    this.#backstop = undefined;
    clearTimeout(this.#overrunWarning);
    this.#overrunWarning = undefined;
    clearTimeout(this.#lookupTimer);
    this.#lookupTimer = undefined;
  }

  /**
   * Records that the platform's clock has started: its kill lands `grace`
   * from now. Arms the backstop that far out, less its margin.
   */
  #noteSignal(): void {
    const at =
      Date.now() + this.#options.grace - RUN_SUMMONED_DEFAULTS.backstopMargin;
    this.#killAt = Math.min(this.#killAt ?? at, at);
    this.#armBackstop(this.#killAt);
  }

  /** (Re)arms the stop at `deadline − shutdownBuffer`. */
  #armDeadline(): void {
    const deadlineAt = this.#deadlineAt;
    if (deadlineAt === undefined || deadlineAt === this.#deadlineArmedFor) {
      return;
    }
    clearTimeout(this.#deadlineTimer);
    this.#deadlineArmedFor = deadlineAt;
    const at = deadlineAt - this.#options.shutdownBuffer;
    this.#deadlineTimer = setTimeout(
      () => {
        this.#deadlineTimer = undefined;
        this.#requestStop({ reason: "deadline" });
      },
      Math.max(0, at - Date.now()),
    );
    this.#deadlineTimer.unref();
  }

  /**
   * The hard backstop: exits with the stop's code if `close()` has not
   * returned by `at`. Only ever moved earlier. Ref'd on purpose: it is the
   * one thing that must fire while a close hangs.
   */
  #armBackstop(at: number): void {
    if (!this.#options.backstop || this.#done) {
      return;
    }
    if (this.#backstopAt !== undefined && this.#backstopAt <= at) {
      return;
    }
    clearTimeout(this.#backstop);
    this.#backstopAt = at;
    this.#backstop = setTimeout(
      () => {
        const reason =
          this.#closing?.reason ?? this.#pendingStop?.reason ?? "signal";
        const code = codeFor(reason);
        this.#logger.error(
          "Summoned worker did not finish closing within its budget: exiting now. Jobs still held are recovered as stalled.",
          { reason, code, ranForMs: Date.now() - this.#startedAt },
        );
        process.exit(code);
      },
      Math.max(0, at - Date.now()),
    );
  }

  /* --- idleness, parking, the deadline, the target --------------------- */

  /** Reads the worker's own record, for its target and to discount it. */
  async #lookupSelf(): Promise<void> {
    const worker = this.#worker;
    if (this.#selfListed || !supportsWorkers(worker.driver)) {
      return;
    }
    const records = await listWorkerRecords(
      worker.driver,
      worker.ref,
      Date.now(),
    );
    const self = records.find((record) => record.id === worker.id);
    if (self !== undefined) {
      this.#selfListed = true;
      this.#targetKind = self.target?.kind;
    }
  }

  /** Retries {@link SummonedRun.lookupSelf} quickly after `ready`, until the first report lands. */
  #scheduleLookup(attempt: number): void {
    if (
      this.#done ||
      this.#closing !== undefined ||
      this.#selfListed ||
      attempt >= 20
    ) {
      return;
    }
    this.#lookupTimer = setTimeout(
      () => {
        this.#lookupTimer = undefined;
        void this.#lookupSelf()
          .catch((error: unknown) => {
            this.#logger.debug("Could not read the worker's own record yet", {
              error,
            });
          })
          .finally(() => this.#scheduleLookup(attempt + 1));
      },
      attempt === 0 ? 50 : Math.min(250, this.#options.idleCheckInterval),
    );
    this.#lookupTimer.unref();
  }

  #startWatching(): void {
    this.#scheduleLookup(0);
    this.#tick = setInterval(
      () => void this.#check(),
      this.#options.idleCheckInterval,
    );
    this.#tick.unref();
    void this.#check();
  }

  async #check(): Promise<void> {
    if (this.#checking || this.#done || this.#closing !== undefined) {
      return;
    }
    this.#checking = true;
    try {
      await this.#checkOnce();
    } catch (error) {
      // A reading that failed says nothing about idleness: start over.
      this.#idleSince = undefined;
      this.#logger.warn("Summoned worker could not check idleness", {
        error,
      });
    } finally {
      this.#checking = false;
    }
  }

  async #checkOnce(): Promise<void> {
    const { mode, idleFor } = this.#options;
    const worker = this.#worker;

    if (this.#options.deadlineIsLive) {
      this.#deadlineAt = this.#options.readDeadline();
      this.#armDeadline();
    }

    const now = Date.now();

    // Parked: an operator stopped it. It serves nothing and costs money.
    if (worker.state === "stopped") {
      this.#parkedSince ??= now;
      this.#idleSince = undefined;
      if (mode !== "until-stopped" && now - this.#parkedSince >= idleFor) {
        this.#requestStop({ reason: "parked" });
      }
      return;
    }
    this.#parkedSince = undefined;

    if (mode === "until-stopped") {
      return;
    }

    if (worker.activeCount > 0) {
      this.#idleSince = undefined;
      return;
    }

    const [demand] = await Promise.all([
      readDemand(worker.driver, worker.ref, { now, cap: 1 }),
      this.#lookupSelf(),
    ]);
    if (this.#closing !== undefined || this.#done) {
      return;
    }
    const idle = isSummonIdle({
      ownActive: worker.activeCount,
      demand,
      otherLiveWorkers: Math.max(
        0,
        demand.workers - (this.#selfListed ? 1 : 0),
      ),
      now,
      idleFor,
    });

    if (!idle) {
      this.#idleSince = undefined;
      return;
    }
    this.#idleSince ??= now;
    if (now - this.#idleSince >= idleFor) {
      this.#requestStop({ reason: "idle" });
    }
  }

  /* --- stopping -------------------------------------------------------- */

  #requestStop(stop: SummonedStop): void {
    if (
      this.#closing !== undefined ||
      this.#pendingStop !== undefined ||
      this.#done
    ) {
      return;
    }
    if (stop.reason === "signal") {
      this.#noteSignal();
    }
    if (!this.#ready) {
      this.#pendingStop = stop;
      this.#logger.info(
        "Summoned worker asked to stop while starting; stopping once ready",
        { ...stop },
      );
      return;
    }
    this.#beginClose(stop);
  }

  #beginClose(stop: SummonedStop): void {
    if (this.#closing !== undefined || this.#done) {
      return;
    }
    this.#closing = stop;
    const { reason } = stop;
    const { tailReserve, mode } = this.#options;
    const now = Date.now();

    // The budget: whichever of the platform's kill and the deadline lands
    // first, less the backstop's margin.
    const limits: number[] = [];
    if (this.#killAt !== undefined) {
      limits.push(this.#killAt);
    }
    if (this.#deadlineAt !== undefined) {
      limits.push(this.#deadlineAt - RUN_SUMMONED_DEFAULTS.backstopMargin);
    }
    const until = limits.length === 0 ? undefined : Math.min(...limits);
    const budget = until === undefined ? Number.POSITIVE_INFINITY : until - now;
    const decision: SummonCloseDecision =
      reason === "error"
        ? {
            force: true,
            budget,
            targetClose: summonTargetClose(this.#targetKind, true),
          }
        : (this.#options.probe?.closeRule ?? summonCloseRule)({
            budget,
            kind: this.#targetKind,
            tailReserve,
          });

    if (until !== undefined) {
      this.#armBackstop(until);
      if (!this.#options.backstop) {
        this.#overrunWarning = setTimeout(
          () => {
            this.#overrunWarning = undefined;
            this.#logger.warn("Summoned worker's close outlived its deadline", {
              reason,
              budget,
            });
          },
          Math.max(0, until - now),
        );
        this.#overrunWarning.unref();
      }
    }

    this.#logger.info(
      reason === "error"
        ? "Summoned worker closing with force after a failed start"
        : decision.force
          ? "Summoned worker closing with force: the budget does not cover a graceful close"
          : "Summoned worker closing gracefully",
      {
        ...stop,
        mode,
        target: this.#targetKind ?? "unknown",
        budget: Number.isFinite(budget) ? Math.floor(budget) : null,
        targetClose: decision.targetClose,
        tailReserve,
        force: decision.force,
        ...(decision.timeout === undefined
          ? {}
          : { timeout: decision.timeout }),
      },
    );

    void this.#worker
      .close(
        decision.force
          ? { force: true }
          : decision.timeout === undefined
            ? undefined
            : { timeout: decision.timeout },
      )
      .catch((error: unknown) => {
        this.#logger.error("Summoned worker failed to close cleanly", {
          reason,
          error,
        });
      })
      .then(() => this.#finish(stop));
  }

  #finish(stop: SummonedStop): void {
    if (this.#done) {
      return;
    }
    this.#done = true;
    this.#clearTimers();
    this.#uninstall();
    const result: SummonedExit = {
      reason: stop.reason,
      ...(stop.signal === undefined ? {} : { signal: stop.signal }),
      ranForMs: Date.now() - this.#startedAt,
      completed: this.#completed,
      failed: this.#failed,
      code: codeFor(stop.reason),
    };
    this.#logger.info("Summoned worker stopped", {
      ...result,
      mode: this.#options.mode,
    });
    if (this.#options.exit) {
      process.exit(result.code);
    }
    this.#finished.resolve(result);
  }
}

/** The exit code for a reason: `1` only when `run()` failed. */
function codeFor(reason: SummonedExit["reason"]): 0 | 1 {
  return reason === "error" ? 1 : 0;
}

/**
 * Runs a worker until it is no longer needed, then stops it cleanly. Starts
 * `worker.run()`, installs the signal handlers, watches idleness and the
 * deadline, and calls `worker.close()` exactly once, by the close rule.
 *
 * ```ts
 * const summon = summonedFromArgs();
 * const worker = jobs.worker(summon?.queue ?? "emails", handlers, { summon });
 * await runSummoned(worker, { idleFor: 30_000 }); // exits the process
 * ```
 *
 * - **Signals first.** The handlers are installed synchronously, before
 *   `run()` connects and before this returns its promise, so a platform
 *   stopping the unit during boot still gets a clean exit 0. A stop asked for
 *   before the worker is ready is held until it is, then closes before the
 *   first claim.
 * - **The close rule.** Once closing starts, the budget `A` is the time left
 *   until the hard backstop: `grace − 250` after a signal, `deadline − 250`
 *   otherwise, none for an idle stop with no deadline. The close is graceful,
 *   with the jobs' `timeout` whatever the target's close and `tailReserve`
 *   leave, while `A` covers them, and `force` otherwise. Abandoned jobs are
 *   recovered as stalled: the at-least-once contract, unchanged.
 * - **The hard backstop.** Outside `"in-invocation"` mode, with `exit`, the
 *   process exits at `A` if `close()` has not returned, with a log line,
 *   rather than leaving SIGKILL to do it silently.
 * - **A second SIGINT exits at once**, with code 130, whatever `exit` says.
 * - **SIGTSTP / SIGCONT** pause and resume claiming; SIGCONT resumes only a
 *   pause SIGTSTP made.
 * - **A parked worker exits** (`"parked"`) after `idleFor`, unless the mode
 *   is `"until-stopped"`, whose platform would restart it.
 *
 * The worker must not be running yet: `runSummoned` starts it. Construct it
 * without `autorun`.
 *
 * @throws {ConfigError} (as a rejection) on an invalid option, a malformed
 *   summon argument, or a worker that is already running.
 */
export async function runSummoned<
  TData,
  TResult,
  TJobs extends JobMapOf<TJobs>,
>(
  /** The worker to run. Not yet running. */
  worker: BunQueueWorker<TData, TResult, TJobs>,
  /** How it runs and stops. */
  options: RunSummonedOptions = {},
): Promise<SummonedExit> {
  const resolved = resolveOptions(options, worker.logger);

  if (worker.isRunning) {
    throw new ConfigError(
      "runSummoned starts the worker itself: do not call run() first or construct it with autorun",
      { worker: worker.id },
    );
  }

  return await new SummonedRun(
    worker,
    // The events a generic worker's map cannot show the compiler; see
    // `SummonedWorkerEvents`.
    worker as unknown as SummonedWorkerEvents,
    resolved,
  ).start();
}
