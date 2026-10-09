import type { QueueDemand } from "../drivers/readApis";
import type { BunQueueWorker } from "../queue/BunQueueWorker";
import type { JobMapOf } from "../queue/types";
import type { Logger, LoggerLike } from "../shared/logger";
import type { WorkerTargetKind } from "../shared/workers";
import process from "node:process";
import { readDemand, supportsWorkers } from "../drivers/readApis";
import { SET_SUMMONED_MODE, SUMMON_OPTION_ID } from "../queue/BunQueueWorker";
import { TARGET_CLOSE_GRACE, TARGET_CLOSE_REAP } from "../queue/workerTarget";
import { DEFAULT_CLOSE_TIMEOUT } from "../shared/constants";
import { ConfigError } from "../shared/errors";
import { resolveLogger } from "../shared/logger";
import { summonedFromArgs } from "./args";
import { markSummonClaimExit } from "./claim";

/**
 * The worker half of summoning: {@link runSummoned} runs a worker — or a
 * unit's workers, one per queue — until it is no longer needed, handles the
 * platform's signals, and stops it inside the platform's grace.
 *
 * It uses only the worker's public surface (`run()`, `close()`, `pause()`,
 * `resume()`, `activeCount`, `state`, `summon`, its events and its driver),
 * so nothing here touches the worker's close path. The one write of its own
 * is the exit mark on the worker's summon claim, before it closes the worker
 * (`#markExit`).
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
   * idle check costs one `countDemand`, which includes one worker listing.
   * Defaults to `5_000`.
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
   * operator's. Defaults to `false`: handling SIGTSTP means Ctrl-Z no longer
   * suspends the process, so a platform that sends it opts in. Ignored in
   * `"in-invocation"` mode. Whether catching SIGTSTP delays the platform's
   * own pause is unverified.
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
  /**
   * Attempts it failed, as the worker reported them. After a forced close an
   * abandoned attempt's failure may not land before the driver closes: it
   * then counts on a driver that writes in memory, not on Postgres, Redis or
   * MongoDB, and the job is recovered as stalled either way.
   */
  failed: number;
  /** The exit code it used, or would have used in `"in-invocation"` mode. */
  code: 0 | 1;
  /**
   * Each queue's own totals, keyed by queue, when `runSummoned` was given a
   * set of workers (`completed` and `failed` are then their sums). Absent
   * for `runSummoned(worker)`, whose result is what it always was.
   */
  queues?: Record<
    string,
    {
      /** Jobs that queue's worker completed. */
      completed: number;
      /** Attempts that queue's worker failed. */
      failed: number;
    }
  >;
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
  | "closing"
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
  /**
   * The least time the hard backstop leaves a close that has started, in ms,
   * however little budget there was: a forced close kills a child-process
   * target's children only after its first round trips (handing over the
   * sweep leases), so a backstop firing sooner orphans them. `1_000` is
   * `TARGET_CLOSE_REAP` (500 ms) for the target plus 500 ms for those round
   * trips: forced closes measured 11 to 35 ms locally, 94 ms at worst on a
   * loaded machine. Past it the platform's own kill is the backstop.
   *
   * It applies to every limit, not only a signal's. At the deadline the
   * backstop fires at the later of `deadline − 250` and a second after the
   * close began, so a close that starts with under 1,250 ms to the deadline
   * (a small `shutdownBuffer`, or a deadline already near at the start) can
   * run past `deadline − 250` by up to the floor itself.
   */
  forcedCloseFloor: 1_000,
} as const;

/**
 * The longest a close waits for its exit mark to be written first, in ms —
 * never more than a quarter of the close's budget, and not at all with none
 * left. One compare-and-set on a reachable backend is a few ms; the bound is
 * for one that is not, and the write carries on behind the close.
 */
const EXIT_MARK_WAIT = 1_000;

/**
 * How long a target's `close()` can take, graceful and forced, derived from
 * the package's close constants rather than chosen:
 *
 * - a target with children (`"child-process"`, `"worker-thread"`): graceful
 *   is `TARGET_CLOSE_GRACE + TARGET_CLOSE_REAP` (4,500 ms), forced is
 *   `TARGET_CLOSE_REAP` (500 ms);
 * - `"in-process"`: nothing of its own;
 * - `"custom"`: the worker's bound on any
 *   target's close, `DEFAULT_CLOSE_TIMEOUT` (5,000 ms), either way, since it
 *   may ignore `force`.
 *
 * Internal; exported for its tests.
 */
export function summonTargetClose(
  /** The target's kind: `worker.target.kind`. */
  kind: WorkerTargetKind,
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
  /** The target's kind: `worker.target.kind`. */
  kind: WorkerTargetKind;
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
  /**
   * Replaces {@link RUN_SUMMONED_DEFAULTS.forcedCloseFloor}; `0` restores
   * the backstop that could fire before a forced close had done anything.
   */
  forcedCloseFloor?: number;
  /**
   * `false` skips the `close({ force: true })` a signal during a graceful
   * close issues, so the close runs on to its own end as it did before a
   * forced close could escalate one (#207): the negative control for that
   * escalation. Default `true`.
   */
  escalate?: boolean;
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
  | "summon"
  | "logger"
  | "target"
  | "config"
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
    pauseSignals: !inInvocation && (options.pauseSignals ?? false),
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

/** One worker's listeners, bound to its place in the unit. */
interface SummonedListeners {
  /** `completed`. */
  completed: () => void;
  /** `failed`. */
  failed: () => void;
  /** `paused` and `resumed`. */
  pausedOrResumed: () => void;
  /** `closing`. */
  closing: () => void;
  /** `closed`. */
  closed: () => void;
  /** `ready`, once. */
  ready: () => void;
}

/** What the unit knows of one of its workers. */
interface SummonedMember {
  /** The worker, through its public surface. */
  worker: SummonedWorker;
  /** The same worker's events. */
  events: SummonedWorkerEvents;
  /** Its listeners. */
  listeners: SummonedListeners;
  /** Jobs it completed. */
  completed: number;
  /** Attempts it failed. */
  failed: number;
  /** Whether it has emitted `ready`. */
  ready: boolean;
  /**
   * Whether its `run()` failed during startup. It never became ready, so the
   * close forces it, as it does a worker still starting.
   */
  startFailed: boolean;
  /**
   * Whether it left the unit without a close of ours: its owner began
   * closing it, or it was closed before it was handed over. Such a worker
   * is no longer watched; the unit runs on for the others.
   */
  gone: boolean;
  /** Whether it was closed before it was handed over: `run()` resolved with no `ready`. */
  unstarted: boolean;
  /** Whether a close of its owner's has finished. */
  ownerClosed: boolean;
}

/**
 * One summoned run over a unit's workers — one, or one per queue: the
 * listeners, the timers and the single close. Built and started by
 * {@link runSummoned}.
 */
class SummonedRun {
  /** The unit's workers, in the order given. */
  readonly #members: SummonedMember[];
  /** Whether `runSummoned` was given one worker rather than a set: its result then has no `queues`. */
  readonly #single: boolean;
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

  /** Whether every worker still in the unit has emitted `ready`. */
  #ready = false;
  /** Set once closing has started: the workers are closed at most once. */
  #closing: SummonedStop | undefined;
  /** Whether it has finished. */
  #done = false;
  /** Whether the close in progress is the owner's, not one of ours. */
  #ownerClose = false;
  /** Since when every queue has been idle, epoch ms. */
  #idleSince: number | undefined;
  /** Since when every worker has been parked, epoch ms. */
  #parkedSince: number | undefined;
  /** Whether a check is in progress. */
  #checking = false;
  /** The deadline, epoch ms, or `undefined` for none. */
  #deadlineAt: number | undefined;
  /** The deadline the deadline timer is armed for. */
  #deadlineArmedFor: number | undefined;
  /**
   * The target kind the close is budgeted for, known from the workers'
   * construction: the one whose close takes longest, since the workers
   * close in parallel.
   */
  readonly #targetKind: WorkerTargetKind;
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
  /** When closing started, epoch ms: the backstop leaves it the floor. */
  #closeStartedAt: number | undefined;
  /** Whether the close in progress is forced. */
  #closingForced = false;
  /**
   * Whether a worker's `run()` failed. The unit then closes with reason
   * `"error"` and code `1`: the failed worker and any still starting are
   * forced, and the ready ones close by the close rule.
   */
  #startFailed = false;
  /** The warning for a close that outlives its budget, without a backstop. */
  #overrunWarning: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** The workers, each with its own events: one, or one per queue. */
    workers: readonly {
      /** The worker. */
      worker: SummonedWorker;
      /** The same worker's events. */
      events: SummonedWorkerEvents;
    }[],
    /** Whether `runSummoned` was given one worker rather than a set. */
    single: boolean,
    /** The resolved options. */
    options: ResolvedSummonedOptions,
  ) {
    this.#single = single;
    this.#options = options;
    this.#logger = options.logger;
    this.#deadlineAt = options.readDeadline();
    this.#members = workers.map(({ worker, events }, index) => ({
      worker,
      events,
      listeners: this.#listenersFor(index),
      completed: 0,
      failed: 0,
      ready: false,
      startFailed: false,
      gone: false,
      unstarted: false,
      ownerClosed: false,
    }));
    this.#targetKind = workers
      .map(({ worker }) => worker.target.kind)
      .reduce((longest, kind) =>
        summonTargetClose(kind, false) > summonTargetClose(longest, false)
          ? kind
          : longest,
      );
  }

  /** Installs everything, starts the workers, and settles with the result. */
  async start(): Promise<SummonedExit> {
    this.#install();
    this.#armDeadline();

    for (const member of this.#members) {
      member.worker.run().then(
        () => {
          // `run()` resolves once the claim loop stops, which a close in
          // progress already accounts for, and so does a close of ours that
          // ended the startup: the worker then resolves `run()` without
          // `ready`, before that close has finished. An owner's close is seen
          // through `closing` first and waited out through `closed`. What is
          // left is a worker that was closed before it was handed over: its
          // `run()` does nothing and resolves at once, with no `ready`,
          // `closing` or `closed`, and nothing else would ever end it.
          if (
            !member.ready &&
            !member.gone &&
            this.#closing === undefined &&
            !this.#done
          ) {
            member.gone = true;
            member.unstarted = true;
            if (this.#members.every((one) => one.gone)) {
              this.#closing = { reason: "closed" };
              this.#logger.info("Summoned worker was already closed", {
                reason: "closed",
              });
              this.#finish(this.#closing);
            } else {
              this.#maybeReady();
            }
          }
        },
        (error: unknown) => {
          // A failure after a close of ours began is the worker's to swallow:
          // it resolves `run()` then. Reaching here, nothing had stopped it.
          // The unit is not marked ready: the workers that did start, and may
          // hold jobs, close by the rule, while this one and any still
          // starting are forced (`#beginClose`).
          this.#logger.error("Summoned worker could not start", {
            error,
            ...this.#queueField(member),
          });
          member.startFailed = true;
          this.#startFailed = true;
          this.#beginClose({ reason: "error" });
        },
      );
    }

    return await this.#finished.promise;
  }

  /** The `queue` field a log line about one worker of a set carries; none for one worker. */
  #queueField(member: SummonedMember): { queue?: string } {
    return this.#single ? {} : { queue: member.worker.ref.queue };
  }

  /** The workers still in the unit: those not closed by their owner or before the start. */
  #active(): SummonedMember[] {
    return this.#members.filter((member) => !member.gone);
  }

  /* --- listeners ------------------------------------------------------- */

  /** The listeners for the worker at `index`. */
  #listenersFor(index: number): SummonedListeners {
    const member = (): SummonedMember => this.#members[index]!;
    return {
      completed: () => {
        member().completed += 1;
      },
      failed: () => {
        member().failed += 1;
      },
      // A pause or resume this code did not make hands the pause to whoever
      // made it: an operator's pause must survive the next SIGCONT.
      pausedOrResumed: () => {
        if (!this.#toggling) {
          this.#pausedBySignal = false;
        }
      },
      closing: () => this.#onClosing(member()),
      closed: () => this.#onClosed(member()),
      ready: () => {
        member().ready = true;
        this.#maybeReady();
      },
    };
  }

  /**
   * A close that is not ours began: the caller's own code, say. It is waited
   * out rather than finished here — during startup the worker resolves
   * `run()` as soon as startup stops, well before that close has unregistered
   * the worker and closed its driver, and exiting then would cut it short.
   * With several workers, the unit runs on for the others, and ends with
   * reason `"closed"` once every one of them has been closed so.
   */
  #onClosing(member: SummonedMember): void {
    if (this.#closing !== undefined || this.#done || member.gone) {
      return;
    }
    member.gone = true;
    if (!this.#members.every((one) => one.gone)) {
      this.#logger.info(
        "Summoned worker is being closed by its owner; the unit runs on for its other queues",
        { reason: "closed", ...this.#queueField(member) },
      );
      this.#maybeReady();
      return;
    }
    this.#closing = { reason: "closed" };
    this.#ownerClose = true;
    this.#closeStartedAt = Date.now();
    this.#logger.info("Summoned worker is being closed by its owner", {
      reason: "closed",
    });
  }

  /**
   * An owner's close finished. Once every worker's has, the result is
   * settled on the next turn, so the owner's own `await worker.close()`
   * resumes first — before the process exits, with `exit`.
   */
  #onClosed(member: SummonedMember): void {
    if (member.gone) {
      member.ownerClosed = true;
    }
    if (
      this.#ownerClose &&
      !this.#done &&
      this.#members.every((one) => one.ownerClosed || one.unstarted)
    ) {
      const stop = this.#closing ?? { reason: "closed" as const };
      setTimeout(() => this.#finish(stop), 0);
    }
  }

  /** Every worker still in the unit is running: start watching idleness and parking. */
  #maybeReady(): void {
    if (this.#ready || this.#closing !== undefined || this.#done) {
      return;
    }
    if (this.#active().every((member) => member.ready)) {
      this.#ready = true;
      this.#startWatching();
    }
  }

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
    if (this.#closing !== undefined) {
      this.#logger.info("Summoned worker already stopping; signal noted", {
        signal,
      });
      // The platform's clock started with this signal, whatever began the
      // close: its kill lands `grace` from now.
      this.#noteSignal();
      this.#escalate();
      return;
    }
    this.#requestStop({ reason: "signal", signal });
  }

  readonly #onTstp = (): void => {
    const active = this.#active();
    if (
      this.#closing !== undefined ||
      active.every((member) => member.worker.isPaused())
    ) {
      this.#logger.info("SIGTSTP: already paused or stopping; left as it is", {
        signal: "SIGTSTP",
      });
      return;
    }
    this.#toggling = true;
    try {
      for (const { worker } of active) {
        if (!worker.isPaused()) {
          void worker.pause().catch((error: unknown) => {
            this.#logger.warn("SIGTSTP: pausing failed", { error });
          });
        }
      }
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
      for (const { worker } of this.#active()) {
        worker.resume();
      }
    } finally {
      this.#toggling = false;
    }
    this.#logger.info("SIGCONT: claiming again", { signal: "SIGCONT" });
  };

  #install(): void {
    for (const { events, listeners } of this.#members) {
      events.on("completed", listeners.completed);
      events.on("failed", listeners.failed);
      events.on("paused", listeners.pausedOrResumed);
      events.on("resumed", listeners.pausedOrResumed);
      events.on("closing", listeners.closing);
      events.on("closed", listeners.closed);
      events.once("ready", listeners.ready);
    }

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
    for (const { events, listeners } of this.#members) {
      events.off("completed", listeners.completed);
      events.off("failed", listeners.failed);
      events.off("paused", listeners.pausedOrResumed);
      events.off("resumed", listeners.pausedOrResumed);
      events.off("closing", listeners.closing);
      events.off("closed", listeners.closed);
      events.off("ready", listeners.ready);
    }
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
  }

  /**
   * Records that the platform's clock has started: its kill lands `grace`
   * from now. Arms the backstop that far out, less its margin.
   */
  #noteSignal(): void {
    const at =
      Date.now() + this.#options.grace - RUN_SUMMONED_DEFAULTS.backstopMargin;
    this.#killAt = Math.min(this.#killAt ?? at, at);
    this.#armLimit(this.#killAt, "signal");
  }

  /**
   * A signal during a graceful close forces it: `close({ force: true })`
   * issued mid-close escalates the close already running (#207), aborting
   * the attempts in flight and force-closing the target, so a child-process
   * or worker-thread attempt is killed at once rather than after its grace.
   * A custom target may ignore `force`; the backstop still bounds that.
   */
  #escalate(): void {
    if (this.#closing === undefined || this.#closingForced) {
      return;
    }
    if (this.#options.probe?.escalate === false) {
      return;
    }
    this.#closingForced = true;
    for (const member of this.#members) {
      void member.worker.close({ force: true }).catch((error: unknown) => {
        this.#logger.warn("Summoned worker could not force its close", {
          error,
          ...this.#queueField(member),
        });
      });
    }
  }

  /**
   * Arms what bounds a stop that must be over by `at`: the hard backstop, or
   * without one (`"in-invocation"`, `exit: false`) a warning when it is
   * still running then.
   */
  #armLimit(at: number, reason: SummonedExit["reason"]): void {
    if (this.#options.backstop) {
      this.#armBackstop(at);
      return;
    }
    if (this.#overrunWarning !== undefined || this.#done) {
      return;
    }
    this.#overrunWarning = setTimeout(
      () => {
        this.#overrunWarning = undefined;
        this.#logger.warn("Summoned worker's close outlived its deadline", {
          reason,
        });
      },
      Math.max(0, at - Date.now()),
    );
    this.#overrunWarning.unref();
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
      () => this.#fireBackstop(),
      Math.max(0, at - Date.now()),
    );
  }

  /**
   * The backstop's timer. A close that has started gets at least the floor
   * first, so a budget at or below zero still lets a forced close kill a
   * child-process target's children before the process goes.
   */
  #fireBackstop(): void {
    const floor =
      this.#options.probe?.forcedCloseFloor ??
      RUN_SUMMONED_DEFAULTS.forcedCloseFloor;
    if (this.#closeStartedAt !== undefined) {
      const earliest = this.#closeStartedAt + floor;
      const wait = earliest - Date.now();
      if (wait > 0) {
        this.#backstop = setTimeout(() => this.#fireBackstop(), wait);
        return;
      }
    }
    const reason = this.#closing?.reason ?? "signal";
    const code = codeFor(reason);
    this.#logger.error(
      "Summoned worker did not finish closing within its budget: exiting now. Jobs still held are recovered as stalled.",
      { reason, code, ranForMs: Date.now() - this.#startedAt },
    );
    process.exit(code);
  }

  /* --- idleness, parking, the deadline, the target --------------------- */

  #startWatching(): void {
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

  /**
   * One check over the unit. Parked means every worker still in the unit is
   * parked; idle means every one is idle or parked: with several workers the
   * unit stops only when none of its running workers' queues has work. A
   * parked worker's queue counts as idle whatever it holds — the unit would
   * otherwise run, and cost, for work nothing in it will take — but a
   * worker still holding a job is not idle, parked or not.
   */
  async #checkOnce(): Promise<void> {
    const { mode, idleFor } = this.#options;
    const active = this.#active();
    const parked = (member: SummonedMember): boolean =>
      member.worker.state === "stopped";

    if (this.#options.deadlineIsLive) {
      this.#deadlineAt = this.#options.readDeadline();
      this.#armDeadline();
    }

    const now = Date.now();

    // Parked: an operator stopped every worker. It serves nothing and costs
    // money. One parked worker among running ones runs on while the others
    // have work, and its own queue does not keep the unit alive.
    if (active.length > 0 && active.every(parked)) {
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

    if (active.some((member) => member.worker.activeCount > 0)) {
      this.#idleSince = undefined;
      return;
    }

    // One reading per running worker's queue, together.
    const running = active.filter((member) => !parked(member));
    const demands = await Promise.all(
      running.map(
        async ({ worker }) =>
          await readDemand(worker.driver, worker.ref, { now, cap: 1 }),
      ),
    );
    if (this.#closing !== undefined || this.#done) {
      return;
    }
    const idle = running.every(({ worker }, index) => {
      const demand = demands[index]!;
      // The count includes this worker's own record wherever it keeps one.
      // Its first report is not awaited, so the first check may not see it
      // yet: that reads one other worker too few, which only ever delays an
      // exit, never hastens one.
      const selfListed =
        supportsWorkers(worker.driver) &&
        worker.config.effective.reportInterval > 0;
      return isSummonIdle({
        ownActive: worker.activeCount,
        demand,
        otherLiveWorkers: Math.max(0, demand.workers - (selfListed ? 1 : 0)),
        now,
        idleFor,
      });
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
    if (this.#closing !== undefined || this.#done) {
      return;
    }
    if (stop.reason === "signal") {
      this.#noteSignal();
    }
    this.#beginClose(stop);
  }

  /**
   * Closes every worker, concurrently, under one budget: the close rule is
   * evaluated once, for the target whose close takes longest, and each
   * worker is closed with what it decided.
   */
  #beginClose(stop: SummonedStop): void {
    if (this.#closing !== undefined || this.#done) {
      return;
    }
    this.#closing = stop;
    this.#closeStartedAt = Date.now();
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
    const total = until === undefined ? Number.POSITIVE_INFINITY : until - now;
    // The exit marks are written before the close starts, out of this same
    // budget (`#markExit`), so the close rule is given what is left after
    // the most those writes may wait: sized against the whole budget, a
    // close could plan a graceful drain that a slow mark write then pushes
    // past its limit, escalating it to a forced one.
    const markWait = this.#active().every(
      ({ worker }) => worker.summon === undefined,
    )
      ? 0
      : Math.min(EXIT_MARK_WAIT, Math.max(0, total / 4));
    const budget = total - markWait;
    // Before `ready` a worker has claimed no job, and a graceful close would
    // first wait out the connect it interrupts: a forced one ends the
    // startup at once, and the worker resolves `run()` for it. That is
    // decided per worker: in a unit stopped while some workers are still
    // starting — or after one failed to start — those are forced and the
    // ready ones, which may hold jobs, close by the rule; forcing them would
    // abandon their jobs for nothing.
    const starting = this.#ready
      ? []
      : this.#active().filter((member) => !member.ready);
    const early =
      starting.length > 0 && starting.length === this.#active().length;
    const decision: SummonCloseDecision = early
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
      this.#armLimit(until, reason);
    }
    this.#closingForced = decision.force;

    const failed = starting.filter((member) => member.startFailed);
    const connecting = starting.filter((member) => !member.startFailed);
    this.#logger.info(
      this.#startFailed
        ? decision.force
          ? "Summoned worker closing with force after a failed start"
          : "Summoned worker closing gracefully after a failed start"
        : early
          ? "Summoned worker closing with force before it was ready: nothing claimed yet"
          : decision.force
            ? "Summoned worker closing with force: the budget does not cover a graceful close"
            : "Summoned worker closing gracefully",
      {
        ...stop,
        mode,
        target: this.#targetKind,
        budget: Number.isFinite(budget) ? Math.floor(budget) : null,
        targetClose: decision.targetClose,
        tailReserve,
        force: decision.force,
        ...(decision.timeout === undefined
          ? {}
          : { timeout: decision.timeout }),
        ...(this.#single
          ? {}
          : {
              queues: this.#members.map(({ worker }) => worker.ref.queue),
            }),
        ...(connecting.length === 0 || early || decision.force
          ? {}
          : { starting: connecting.map(({ worker }) => worker.ref.queue) }),
        ...(failed.length === 0 || early || decision.force
          ? {}
          : { startFailed: failed.map(({ worker }) => worker.ref.queue) }),
      },
    );

    const options = decision.force
      ? { force: true }
      : decision.timeout === undefined
        ? undefined
        : { timeout: decision.timeout };
    const closeOne = async (
      /** The worker to close. */
      member: SummonedMember,
      /** Its close's options. */
      closeOptions: { force?: boolean; timeout?: number } | undefined,
    ): Promise<void> => {
      try {
        await member.worker.close(closeOptions);
      } catch (error) {
        this.#logger.error("Summoned worker failed to close cleanly", {
          reason,
          error,
          ...this.#queueField(member),
        });
      }
    };
    // The workers still starting are forced now, before the exit marks are
    // waited for: `close()` marks a worker closing synchronously, so one whose
    // connect completes during that wait abandons its startup rather than
    // becoming ready, claiming a job and only then being forced (#238). The
    // mark is still written on any summon claim one of them won, over the
    // `closed` its own close writes.
    const forced = new Map(
      starting.map((member) => [member, closeOne(member, { force: true })]),
    );
    const close = async (): Promise<void> => {
      await this.#markExit(stop, markWait);
      await Promise.all(
        this.#members.map(
          async (member) =>
            await (forced.get(member) ?? closeOne(member, options)),
        ),
      );
    };
    void close().then(() => this.#finish(stop));
  }

  /**
   * Writes the real reason and code onto the summon claim each worker won,
   * under its own queue, **before** the close starts: each worker's own
   * `close()` then finds a mark and leaves it, so the controller reads
   * `idle`, `deadline`, `signal` or `error` rather than a bare `closed` — and
   * it is there before the record goes, so a check never sees neither. A
   * code `1` mark is never replaced by a clean one.
   *
   * Waits at most `wait` — {@link EXIT_MARK_WAIT}, or a quarter of the
   * budget if less, already taken out of the budget the close rule sized the
   * close against — for every write, then lets the close begin while any
   * still running carries on. A failed write is logged, never thrown: the
   * exit goes ahead either way, and the worker's own close still fills in
   * its `closed` mark.
   */
  async #markExit(
    /** The stop under way. */
    stop: SummonedStop,
    /** The most to wait for the writes before the close begins, in ms. */
    wait: number,
  ): Promise<void> {
    // A worker its owner already closed keeps the mark its own close wrote.
    const writes = this.#active().flatMap((member) => {
      const { worker } = member;
      const summon = worker.summon;
      if (summon === undefined) {
        return [];
      }
      return [
        markSummonClaimExit(
          worker.driver,
          worker.ref,
          summon.id,
          worker.id,
          {
            exitedAt: Date.now(),
            reason: stop.reason,
            code: codeFor(stop.reason),
            ...(this.#closingForced ? { forced: true } : {}),
          },
          true,
        ).then(
          (result) => {
            if (result === "contended") {
              this.#logger.warn(
                "Summoned worker could not mark its exit on its summon claim: the entry kept changing",
                { summonId: summon.id, ...this.#queueField(member) },
              );
            }
          },
          (error: unknown) => {
            this.#logger.warn(
              "Summoned worker could not mark its exit on its summon claim",
              { summonId: summon.id, error, ...this.#queueField(member) },
            );
          },
        ),
      ];
    });
    if (writes.length === 0 || wait <= 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(writes),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, wait);
      }),
    ]);
    clearTimeout(timer);
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
      completed: this.#members.reduce((sum, one) => sum + one.completed, 0),
      failed: this.#members.reduce((sum, one) => sum + one.failed, 0),
      code: codeFor(stop.reason),
      ...(this.#single
        ? {}
        : {
            queues: Object.fromEntries(
              this.#members.map(({ worker, completed, failed }) => [
                worker.ref.queue,
                { completed, failed },
              ]),
            ),
          }),
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
 * The refusals of {@link runSummoned}, before anything runs: an empty set,
 * two workers on one queue, workers summoned by different attempts, and —
 * in a summoned process — a queue the summon arguments name with no worker.
 * Warns about a worker on a queue the arguments do not name: it runs, and
 * claims under its own queue, which is harmless.
 *
 * @throws {ConfigError} naming what is wrong.
 */
function checkUnit(
  /** The workers, one or one per queue. */
  workers: readonly BunQueueWorker<unknown, unknown, never>[],
  /** Where the warning goes. */
  logger: Logger,
): void {
  const queues = workers.map((worker) => worker.ref.queue);
  const twice = queues.find((queue, index) => queues.indexOf(queue) !== index);
  if (twice !== undefined) {
    throw new ConfigError(
      `runSummoned runs one worker per queue, and was given two for queue ${twice}`,
      { queue: twice },
    );
  }
  const ids = [
    ...new Set(
      workers
        .map((worker) => worker[SUMMON_OPTION_ID])
        .filter((id) => id !== undefined),
    ),
  ];
  if (ids.length > 1) {
    throw new ConfigError(
      "runSummoned runs one summoned unit: its workers were given summon options from different attempts",
      { ids },
    );
  }

  const summoned = summonedFromArgs();
  const named = summoned?.queues ?? [];
  if (named.length === 0) {
    return;
  }
  const serves = (worker: BunQueueWorker<unknown, unknown, never>): boolean =>
    named.includes(worker.ref.queue) &&
    (summoned?.namespace === undefined || worker.ref.ns === summoned.namespace);
  const missing = named.filter(
    (queue) =>
      !workers.some((worker) => worker.ref.queue === queue && serves(worker)),
  );
  if (missing.length > 0) {
    throw new ConfigError(
      `runSummoned: the summon arguments name ${missing.length === 1 ? "a queue" : "queues"} with no worker (${missing.join(", ")}): build one worker for each queue in summonedFromArgs().queues. A unit that serves fewer queues belongs to another summon group`,
      {
        missing,
        queues: [...named],
        ...(summoned?.namespace === undefined
          ? {}
          : { namespace: summoned.namespace }),
      },
    );
  }
  const extra = workers.filter((worker) => !serves(worker));
  if (extra.length > 0) {
    logger.warn(
      "A worker's queue is not named in the summon arguments: it runs, and claims under its own queue",
      { queues: extra.map((worker) => worker.ref.queue) },
    );
  }
}

/**
 * Runs a summoned unit until it is no longer needed, then stops it cleanly:
 * one worker, or one worker per queue for a unit summoned for several
 * queues. Starts each worker's `run()`, installs the signal handlers, watches
 * idleness and the deadline, and closes the workers by the close rule.
 *
 * ```ts
 * const summon = summonedFromArgs();
 * const worker = jobs.worker(summon?.queue ?? "emails", handlers, { summon });
 * await runSummoned(worker, { idleFor: 30_000 }); // exits the process
 * ```
 *
 * A unit for several queues gets one `--bun-jobs-summon-queue=` per queue;
 * build a worker for each and pass them together:
 *
 * ```ts
 * const summon = summonedFromArgs();
 * const handlers: Record<string, JobProcessor> = {
 *   renders: render,
 *   thumbs: thumb,
 * };
 * const workers = (summon?.queues ?? ["renders"]).map((queue) => {
 *   const handler = handlers[queue];
 *   if (handler === undefined) {
 *     throw new Error(`no handler for queue ${queue}`);
 *   }
 *   return jobs.worker(queue, handler, { summon });
 * });
 * await runSummoned(workers, { idleFor: 30_000 });
 * ```
 *
 * - **Signals first.** The handlers are installed synchronously, before
 *   `run()` connects and before this returns its promise, so a platform
 *   stopping the unit during boot still gets a clean exit 0. A stop that
 *   arrives before a worker is ready closes that worker at once, with
 *   `force`: it has claimed nothing, and the close ends its startup, however
 *   long the connect would have taken. In a unit stopped while only some of
 *   its workers are ready, the ones still starting are forced at once — before
 *   the exit marks are written, so none becomes ready and claims a job in the
 *   meantime — and the ready ones close by the close rule below.
 * - **The close rule.** Once closing starts, the budget `A` is the time left
 *   until the hard backstop: `grace − 250` after a signal, `deadline − 250`
 *   otherwise, none for an idle stop with no deadline. The close is graceful,
 *   with the jobs' `timeout` whatever the target's close and `tailReserve`
 *   leave, while `A` covers them, and `force` otherwise. Abandoned jobs are
 *   recovered as stalled: the at-least-once contract, unchanged. Several
 *   workers close concurrently under that one budget, sized for the target
 *   whose close takes longest.
 * - **The hard backstop.** Outside `"in-invocation"` mode, with `exit`, the
 *   process exits at `A` if `close()` has not returned, with a log line,
 *   rather than leaving SIGKILL to do it silently — but never sooner than
 *   `forcedCloseFloor` (1 s) after the close started, so a budget at or
 *   below zero still lets a forced close kill a target's children.
 * - **A signal during a graceful close** escalates it with
 *   `close({ force: true })`: the attempts in flight are aborted and the
 *   target force-closed, so the close finishes promptly and a child-process
 *   attempt is killed, not orphaned. The backstop still bounds a custom
 *   target that ignores `force`.
 * - **A second SIGINT exits at once**, with code 130, whatever `exit` says.
 * - **SIGTSTP / SIGCONT**, with `pauseSignals`, pause and resume claiming;
 *   SIGCONT resumes only a pause SIGTSTP made.
 * - **A parked unit exits** (`"parked"`) after `idleFor`, unless the mode is
 *   `"until-stopped"`, whose platform would restart it. With several
 *   workers, only once every one is parked.
 * - **Several workers.** The unit is idle only when every worker is idle or
 *   parked: a parked worker's queue counts as idle whatever work waits on
 *   it, so the unit exits `"idle"` once the others are, and `"parked"` only
 *   when every worker is parked. One worker's `run()` failing closes them
 *   all with reason `"error"` and code `1`: the failed one and any still
 *   starting with `force`, the ready ones by the close rule, so a job one
 *   holds can finish within the budget. An owner closing one worker leaves
 *   the others running, still on the idle clock, and the unit ends
 *   (`"closed"`) if its owner closes every one; each worker marks its own
 *   claim; and the result adds `queues`, each queue's totals.
 * - **Every queue the summon names needs a worker.** In a summoned process,
 *   a queue in `summonedFromArgs().queues` with no worker is refused before
 *   anything runs, so the attempt is lost fast rather than registering on
 *   some queues and leaving the others starving. Build the workers in the
 *   main thread: Bun gives a `Worker` thread an empty `argv`, so
 *   `summonedFromArgs()` answers `undefined` there, and `runSummoned` owns
 *   the process's signals.
 *
 * The workers must not be running yet: `runSummoned` starts them. Construct
 * them without `autorun`; a worker from `BunJobs.start()` has already been
 * run, so it is refused.
 *
 * @throws {ConfigError} (as a rejection) on an invalid option, a malformed
 *   summon argument, a worker that is already running, an empty set, two
 *   workers on one queue, workers given different summon attempts, or a
 *   queue the summon arguments name with no worker.
 */
export async function runSummoned<
  TData,
  TResult,
  TJobs extends JobMapOf<TJobs>,
>(
  /** The worker to run. Not yet running. */
  worker: BunQueueWorker<TData, TResult, TJobs>,
  /** How it runs and stops. */
  options?: RunSummonedOptions,
): Promise<SummonedExit>;
export async function runSummoned(
  /**
   * The unit's workers, one per queue. None running yet. `any`, as
   * `BunJobs`' own set of workers is: a worker's type parameters are
   * invariant (its private fields use them both ways), so workers of
   * different data and result types share no narrower element type.
   */
  workers: readonly BunQueueWorker<any, any, any>[],
  /** How they run and stop. */
  options?: RunSummonedOptions,
): Promise<SummonedExit>;
export async function runSummoned(
  target:
    | BunQueueWorker<unknown, unknown, never>
    | readonly BunQueueWorker<unknown, unknown, never>[],
  options: RunSummonedOptions = {},
): Promise<SummonedExit> {
  const single = !Array.isArray(target);
  const workers: readonly BunQueueWorker<unknown, unknown, never>[] = single
    ? [target as BunQueueWorker<unknown, unknown, never>]
    : (target as readonly BunQueueWorker<unknown, unknown, never>[]);
  if (workers.length === 0) {
    throw new ConfigError(
      "runSummoned needs a worker: it was given an empty set",
    );
  }
  const resolved = resolveOptions(options, workers[0]!.logger);

  for (const worker of workers) {
    if (worker.isRunning) {
      throw new ConfigError(
        "runSummoned starts the worker itself: do not call run() first or construct it with autorun",
        { worker: worker.id },
      );
    }
  }
  checkUnit(workers, resolved.logger);

  // The mode it runs in, on the record beside the mode the summoner asked
  // for: once, before `run()`, and only on a worker given `summon` (the
  // worker ignores it otherwise).
  for (const worker of workers) {
    worker[SET_SUMMONED_MODE](resolved.mode);
  }

  return await new SummonedRun(
    workers.map((worker) => ({
      worker,
      // The events a generic worker's map cannot show the compiler; see
      // `SummonedWorkerEvents`.
      events: worker as unknown as SummonedWorkerEvents,
    })),
    single,
    resolved,
  ).start();
}
