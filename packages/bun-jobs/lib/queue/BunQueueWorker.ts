import type { SerializedError } from "@kingsleyweb/bun-common";
import type {
  ChildOutcome,
  ChildRecordResult,
  JobRecord,
  JobRef,
  JobsDriver,
  PromotionRead,
  QueueRef,
  RepeatRecord,
  StoredJobOptions,
  WorkerConfigInfo,
  WorkerControlInfo,
} from "../drivers/index";
import type {
  QueueEventName,
  QueueEventPayloads,
  WorkerEventPayloads,
} from "../shared/events";
import type { Logger } from "../shared/logger";
import type {
  WorkerConfigKey,
  WorkerConfigPatch,
  WorkerConfigValues,
  WorkerEventName,
  WorkerState,
  WorkerStopPersistence,
  WorkerSummonProvenance,
  WorkerTargetInfo,
} from "../shared/workers";
import type { JobEvent } from "./Job";
import type { Reservation } from "./limits";
import type {
  BunQueueWorkerEvents,
  BunQueueWorkerOptions,
  DeadLetter,
  JobMap,
  JobMapOf,
  JobProcessor,
  ProcessorContext,
  WorkerEventsOf,
} from "./types";
import type { WorkerControlEntry } from "./workerControl";
import type {
  WorkerTargetCloseOptions,
  WorkerTargetExecutor,
} from "./workerTarget";
import process from "node:process";
import {
  createDeferred,
  deserializeError,
  jsonClone,
  serializeError,
  sleep,
  withTimeout,
} from "@kingsleyweb/bun-common";
import { awaitsDelivery, flowKey } from "../drivers/flow";
import {
  claimJobBatch,
  CompletionBatcher,
  listWorkerRecords,
  readPromotion,
  registerWorkerRecord,
  removeWorkerRecord,
  resolveDriver,
  resolveMetricsOptions,
  supportsWorkers,
} from "../drivers/index";
import {
  DEFAULT_CLOSE_TIMEOUT,
  DEFAULT_LOCK_DURATION,
  DEFAULT_MAX_BLOCK,
  DEFAULT_MAX_STALLED,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_STALLED_INTERVAL,
  JOBS_VERSION,
} from "../shared/constants";
import { TypedEmitterBase } from "../shared/emitter";
import {
  ChildFailedError,
  ConfigError,
  JobTimeoutError,
  LockLostError,
  UnrecoverableJobError,
} from "../shared/errors";
import { queueEvent, workerEvent } from "../shared/events";
import { HOST, newClaimToken, newId, newToken } from "../shared/ids";
import { assertNamespace, assertSegment } from "../shared/keys";
import { createJobsLogger } from "../shared/logger";
import { Pulse, waitForAny } from "../shared/wait";
import {
  WORKER_CONFIG_KEYS,
  workerConfigCrossFieldIssue,
  workerConfigIssue,
} from "../shared/workers";
import { resolveSummonProvenance } from "../summon/provenance";
import { AttemptWrites } from "./attemptWrites";
import { BackoffStrategies, nextBackoff } from "./backoff";
import { BunQueue } from "./BunQueue";
import { addDeadLetter, selfLetterError } from "./deadLetter";
import { noteScheduled, scheduleEpoch } from "./delayedHints";
import { Job } from "./Job";
import { JobDefaultsCache, overlayJobDefaults } from "./jobDefaults";
import { QueueLimiter } from "./limits";
import { displayRepeatKey, shortenJobId } from "./options";
import { nextOccurrence, repeatJobId } from "./repeat";
import {
  isRepeatDisabled,
  occurrenceRecord,
  removePendingOccurrence,
} from "./repeatControl";
import {
  RESERVED_STATE_PREFIX,
  setReservedState,
  supportsWindowSweep,
  sweepWindows,
} from "./windows";
import {
  readWorkerConfig,
  readWorkerControl,
  readWorkerStop,
  removeWorkerControl,
  supportsWorkerControl,
  sweepWorkerControls,
  watchWorkerChanges,
  WORKER_CONTROL_GRACE_LIFETIMES,
  writeWorkerStop,
} from "./workerControl";
import { WorkerMetricsRecorder } from "./workerMetrics";
import {
  buildTargetExecutor,
  describeTarget,
  resolveWorkerTarget,
} from "./workerTarget";

/**
 * The queue-state entry naming the one worker that runs the queue's
 * stalled-interval sweeps — stalled recovery and flow healing:
 * a {@link SweepLease}, taken by compare-and-set (C12).
 *
 * The name is the one the flow-heal lease carried when flow healing was the
 * only leased sweep. It is kept so that a fleet part-way through an upgrade
 * shares a single lease rather than electing one leader per version.
 */
const STALLED_SWEEP_LEASE = `${RESERVED_STATE_PREFIX}fheal`;

/**
 * The queue-state entry naming the one worker that runs the queue's minute
 * sweeps — pruning, repeat healing, the window sweep and the worker-control
 * sweep. The same {@link SweepLease} shape as {@link STALLED_SWEEP_LEASE}.
 */
const MINUTE_SWEEP_LEASE = `${RESERVED_STATE_PREFIX}msweep`;

/**
 * What one of the queue's sweep leases records: who is sweeping, until when,
 * and how often they sweep.
 */
interface SweepLease {
  /** The id of the worker that holds the lease. */
  holder?: unknown;
  /** The epoch millisecond the lease lapses at, if nobody renews it. */
  until?: unknown;
  /**
   * The holder's cadence for this sweep, in milliseconds — what the queue is
   * actually swept at while this worker holds the lease, and what a faster
   * worker measures itself against before taking over. Absent on a lease
   * written before this was recorded; see
   * {@link SWEEP_LEASE_TAKEOVER_FACTOR}.
   */
  cadence?: unknown;
}

/**
 * How many of its own cadences a sweep lease lasts. The holder renews it on
 * every pass, so it survives one missed pass and lapses after two; another
 * worker's next pass then falls within one more cadence, which is what bounds
 * the hand-over at three.
 */
const SWEEP_LEASE_LIFETIMES = 2;

/**
 * How much longer than its own a holder's cadence must be before a worker
 * takes a live lease from it: the lease settles on the fastest sweeper rather
 * than on whoever won the first race, so a worker deliberately given a short
 * `stalledInterval` governs the queue whether or not it started first.
 *
 * It is {@link SWEEP_LEASE_LIFETIMES} deliberately, not an arbitrary number: a
 * worker takes over only when the whole lease it would take — two of its own
 * cadences — still fits inside a single one of the holder's. A hand-over
 * therefore always at least halves how often the queue is swept, never trades
 * one cadence for a barely different one.
 *
 * **Why it cannot thrash.** Worker B takes from holder A only when
 * `cA > 2·cB`.
 *
 * - *Equal or near-equal cadences never move it.* `cA > 2·cA` is false, and
 *   so is anything within a factor of two, so two workers configured alike —
 *   the overwhelmingly common fleet — never take the lease from each other:
 *   whoever wins the first race keeps it exactly as in #108.
 * - *The slow holder cannot take it back.* After B takes over, the lease
 *   records `cB`, and A would need `cB > 2·cA`; but `cA > 2·cB` gives
 *   `2·cA > 4·cB > cB`. False for every positive pair.
 * - *And no longer cycle exists either.* Each takeover at least halves the
 *   recorded cadence, so the recorded value is strictly decreasing: a fleet
 *   spanning a factor of `k` hands over at most `log2(k)` times, ever, and
 *   then never again.
 *
 * A lease that records no cadence at all — one written by a worker from before
 * this, which shares the `fheal` name — is waited out rather than taken early.
 * An unknown cadence is not a known-slower one, and treating it as slower
 * would have a new worker and an old one take the lease from each other on
 * alternate passes, which is the one thing this must not do.
 */
const SWEEP_LEASE_TAKEOVER_FACTOR = SWEEP_LEASE_LIFETIMES;

/**
 * How often, in milliseconds, the sweeps that are not tied to the stalled
 * interval run: pruning, repeat healing, windows and worker controls.
 */
const MINUTE_SWEEP_INTERVAL = 60_000;

/** How many jobs one maintenance sweep touches. */
const MAINTENANCE_BATCH = 100;

/**
 * How long the failure record of an attempt the worker *gave up on* waits for
 * the writes that attempt had in flight — its progress, its log lines.
 *
 * Enough for a driver write that is merely slow — one statement or one
 * command, single-digit milliseconds even on a loaded database, so this is two
 * orders of magnitude of headroom — and small next to everything it could
 * delay: a hundredth of the default `lockDuration`, and a thirtieth of the
 * budget `#persist` gives the failure write itself, so the failure still lands
 * far inside the lock it is written under. Past it the failure is recorded
 * regardless: a driver that is not answering must not keep a dead job `active`
 * until the stalled sweep takes it.
 *
 * One bound for both kinds of write, but only on that ending: an attempt that
 * reached its own end is given the ending write's own budget instead, a
 * quarter of `lockDuration` — see `#awaitWrites` for why they differ.
 */
const WRITE_SETTLE_TIMEOUT = 250;

/**
 * The most batches of expired jobs one prune pass removes, back to back, while
 * each comes back full. With {@link MAINTENANCE_BATCH} that is 5,000 jobs: one
 * batch a minute capped the whole sweep at 100 jobs a minute, so a queue
 * finishing more than about 1.7 jobs a second under the default 24-hour
 * retention fell behind for good and its finished jobs grew without bound.
 *
 * The batch itself stays at 100 because it is one unit of work on the backend
 * — one Lua script on Redis, which blocks the server while it runs, and one
 * `SELECT` plus a statement per row on SQL — so it is repeated rather than
 * enlarged.
 */
const PRUNE_MAX_BATCHES = 50;

/**
 * How long one prune pass may keep going, in milliseconds, whatever
 * {@link PRUNE_MAX_BATCHES} still allows. Short enough that a slow backend,
 * or the memory driver's in-process scan, never holds a worker's maintenance
 * — or its event loop — for long.
 */
const PRUNE_TIME_BUDGET_MS = 500;

/**
 * How soon, in milliseconds, a prune pass that stopped on its budget with
 * expired jobs still left runs again, rather than waiting for the next
 * minute's maintenance. The pause is what keeps a backlog from turning the
 * sweep into a busy loop: one {@link PRUNE_TIME_BUDGET_MS} pass at most per
 * {@link PRUNE_CATCH_UP_MS} pause, so a third of the time at worst, and only
 * while there is a backlog to clear.
 */
const PRUNE_CATCH_UP_MS = 1_000;

/**
 * How long a parent may list a child that does not exist before the child is
 * treated as failed. Long enough for a flow still being added to finish; a
 * child still missing after it was never added, or was removed by hand.
 */
const FLOW_MISSING_GRACE_MS = 60_000;

/**
 * How many times an unfinished flow delivery is retried on its own short timer
 * before it is left to the maintenance passes. A flow is added children first,
 * so a quick child can finish before its parent exists; these retries are what
 * deliver it promptly once the parent does, rather than a `stalledInterval`
 * later.
 */
const FAST_REDELIVERY_ATTEMPTS = 8;

/** The first fast retry's delay; each one after waits twice as long, to 5s. */
const FAST_REDELIVERY_BASE_MS = 50;

/**
 * How many children one maintenance pass reads while checking the parents
 * waiting on them. Bounds the pass however wide a flow is; the next pass
 * resumes at the child this one stopped on.
 */
const FLOW_HEAL_LOOKUPS = 100;

/** How a finished child ended, before it is shaped for its parent. */
type SettledOutcome =
  | {
      /** It completed. */
      completed: true;
      /** What its processor returned, as stored. */
      value: unknown;
    }
  | {
      /** It failed for good. */
      completed: false;
      /** Its own reason, not yet wrapped for the parent. */
      error: SerializedError;
    };

/**
 * The lock `record`'s attempt holds: the token its own claim stamped, which
 * {@link BunQueueWorker}'s claim pass sets on every record it takes. Never the
 * worker's — see `newClaimToken`. The fallback never matches a held lock, so a
 * record that somehow has none is refused rather than settled.
 */
function heldLock(record: JobRecord): string {
  return record.lockToken ?? "";
}

/**
 * One claim of one job, running on this worker — the key of every piece of
 * per-attempt state the worker keeps (`#active`, `#aborts`, `#heartbeats`).
 *
 * **Keyed per attempt, never by job id.** The same worker can hold two
 * attempts at one job: at a concurrency above one, its own stalled sweep can
 * hand back a job whose abandoned attempt is still running, and a free slot
 * claims it again. Keyed by id, the second attempt's entries overwrote the
 * first's, and the first's cleanup then deleted the second's — clearing its
 * heartbeat (so it stalled again and died), dropping it from the in-flight
 * count (so the worker ran more than its concurrency), from what `close()`
 * waits for, and from what a forced close aborts; and a limiter charge was
 * released once for two attempts. An object per claimed record cannot
 * collide, even for a batch that shares one lock token.
 */
interface Attempt {
  /** The job as this claim took it; its `lockToken` is this claim's own. */
  readonly record: JobRecord;
  /**
   * Whether this claim was charged to a limiter reservation, so that its end
   * is exactly one release — and cleared by that release. A job claimed while
   * the queue had no limits was never counted, and releasing it anyway took
   * it off a lease still holding jobs that were, so limits set again later
   * under-counted this worker and admitted more than their cap (B7).
   */
  reserved: boolean;
}

/** How a stored `completed` or `dead` job ended. */
function settledOutcome(record: JobRecord): SettledOutcome {
  return record.state === "completed"
    ? { completed: true, value: record.returnValue }
    : {
        completed: false,
        error:
          record.failedReason ?? serializeError(new Error("the child failed")),
      };
}

/** The longest a worker held back by a concurrency limit waits before asking again. */
const LIMITED_RECHECK_MS = 100;

/** How long a paused check is cached before the driver is asked again. */
const PAUSE_CACHE_MS = 1000;

/**
 * How often the delayed-job promotion sweep runs for a poll interval: as often
 * as the worker polls, and at least once a second, so a busy worker that is
 * never idle still promotes retries whose backoff has elapsed.
 */
function promotionCadence(pollInterval: number): number {
  return Math.min(pollInterval, 1000);
}

/**
 * The longest a timer can be set for. A longer delay does not wait longer: it
 * overflows and fires at once, which turns an idle worker's wait into a spin.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Checks a runtime-set interval is a positive number of milliseconds a timer
 * can actually wait.
 */
function assertPositiveMs(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${what} must be a positive number of milliseconds`, {
      [what]: value,
    });
  }

  if (value > MAX_TIMER_MS) {
    throw new ConfigError(
      `${what} cannot be longer than ${MAX_TIMER_MS}ms (about 24.8 days), the longest a timer can be set for`,
      { [what]: value, max: MAX_TIMER_MS },
    );
  }

  return value;
}

/**
 * How often a worker writes its heartbeat record, unless told otherwise, in
 * milliseconds: 10,000. It is also how often a worker's busyness is sampled,
 * since the sample rides the report. Exported so the management API's
 * `DEFAULT_BUSYNESS_INTERVAL_MS` can be pinned to it by a test: the API cannot
 * see another process's `reportInterval`, so it reports this default.
 */
export const DEFAULT_REPORT_INTERVAL = 10_000;

/** How often a worker reads its stored instructions when it cannot subscribe. */
const DEFAULT_CONTROL_INTERVAL = 2_000;

/**
 * What a worker is doing, before its `paused` flag is folded in.
 *
 * `paused` is kept separate because it is the one part of the state a worker
 * can be in *while* running — it has a loop, timers and jobs in flight, and a
 * resume is immediate. The three phases here are the ones that change what
 * the worker is, not just whether it claims.
 */
type WorkerPhase = "running" | "stopping" | "stopped" | "restarting";

/**
 * A worker's stable key, as it is derived when none was given:
 * `[service.]queue[.name]`, with the ordinal standing in for a name from the
 * second worker a context builds on one queue.
 *
 * The ordinal is the weakest of the three and deliberately last: it shifts the
 * moment a worker's creation becomes conditional, and an override then follows
 * the wrong worker. `name` exists so nobody has to rely on it.
 */
export function deriveWorkerKey(parts: {
  /** The service, when the worker belongs to one. */
  service?: string;
  /** The queue it consumes. */
  queue: string;
  /** What it is called within the queue, when it was named. */
  name?: string;
  /** Its ordinal among a context's workers on that queue, from `1`. */
  ordinal?: number;
}): string {
  const segments = parts.service ? [parts.service, parts.queue] : [parts.queue];

  if (parts.name !== undefined) {
    segments.push(parts.name);
  } else if (parts.ordinal !== undefined && parts.ordinal > 1) {
    segments.push(String(parts.ordinal));
  }

  return segments.join(".");
}

/**
 * How many workers this process has built, so two of them can never derive
 * the same id.
 *
 * The obvious tag — host, pid and start time — is unique among live
 * processes* and nothing more, so two workers built here under one key (two
 * replicas of a shard in one process, or simply two plain
 * `new BunQueueWorker("mail", ...)`) collided on it. They would then share a
 * heartbeat record, a lock token and a limiter lease, which is the very
 * corruption the derived id exists to make impossible.
 */
let workerSerial = 0;

/**
 * Eight base-36 characters standing for one worker of one incarnation of a
 * process.
 *
 * Derived rather than random so it can be computed in the constructor, which
 * is what keeps `readonly id` possible: the lock token and the limiter's lease
 * holder are fixed there, and deferring them to `run()` would be a far larger
 * change.
 */
export function incarnationTag(
  host: string,
  pid: number,
  processStartedAt: number,
  serial: number,
): string {
  return Bun.hash(`${host}:${pid}:${processStartedAt}:${serial}`)
    .toString(36)
    .padStart(8, "0")
    .slice(-8);
}

/** How many report intervals a heartbeat record outlives its last write by. */
const REPORT_LIFETIMES = 3;

/**
 * This *process's* resident memory in bytes, for the heartbeat record's
 * `rssBytes`; `undefined` where the runtime does not report it.
 *
 * `process.memoryUsage.rss()` rather than `process.memoryUsage()`: it reads
 * the one figure instead of gathering the whole heap breakdown. Called once
 * per report, never per job. It is the process's number, not the worker's, so
 * two workers sharing a process report the same one.
 */
function processRss(): number | undefined {
  const rss = process.memoryUsage?.rss;
  if (typeof rss !== "function") {
    return undefined;
  }

  try {
    const bytes = rss();
    return Number.isFinite(bytes) ? bytes : undefined;
  } catch {
    // A runtime that has the function but cannot answer: the record simply
    // carries no `rssBytes`, which readers already handle.
    return undefined;
  }
}

/** A publish that does nothing: already settled, and shared, so it costs nothing. */
const SETTLED: Promise<void> = Promise.resolve();

/**
 * A processor's result as it is stored: what `jsonClone` makes of it, without
 * paying for the round trip where it would change nothing. `null`, strings,
 * booleans and finite numbers come back from JSON exactly as they went in;
 * `NaN` and the infinities become `null`, as JSON makes them; anything else is
 * cloned, so a result mutated after it was returned is stored as it was.
 */
function storedResult(result: unknown): unknown {
  if (result === undefined || result === null) {
    return null;
  }

  switch (typeof result) {
    case "string":
    case "boolean":
      return result;
    case "number":
      return Number.isFinite(result) ? result : null;
    default:
      return jsonClone(result);
  }
}

/**
 * Whether a stored failure is the one given: the same name, message and
 * stack. The stack pins it to the one throw, so two failures that merely say
 * the same thing are not mistaken for each other.
 */
function sameError(
  stored: SerializedError | null,
  error: SerializedError,
): boolean {
  return (
    stored !== null &&
    stored.name === error.name &&
    stored.message === error.message &&
    stored.stack === error.stack
  );
}

/**
 * How long a worker trusts a series' disabled flag as last read before
 * reading it again.
 */
const REPEAT_FLAG_CACHE_MS = 1_000;

/**
 * The consumer side of a queue.
 *
 * Any number of workers, in any number of processes on any number of hosts,
 * may consume the same queue: exclusivity comes from the driver's claim being
 * atomic, not from registration, leases or a coordinator. That is why adding
 * capacity is just starting another process.
 *
 * Every worker also keeps the queue live — promoting delayed jobs, recovering
 * jobs whose worker died, healing flows — and, by default, does the queue's
 * housekeeping too: pruning expired results, healing repeat series, sweeping
 * stale queue state. Every one of those operations is idempotent, so they need
 * no leader and no single process is load-bearing.
 * {@link BunQueueWorkerOptions.maintenance} turns the housekeeping half off;
 * nothing turns the liveness half off.
 *
 * ```ts
 * const worker = new BunQueueWorker("mail", async (job) => send(job.data), {
 *   namespace: "account",
 *   driver,
 *   concurrency: 8,
 * });
 * await worker.run();
 * ```
 *
 * @typeParam TData What the jobs it runs carry.
 * @typeParam TResult What its processor answers with.
 * @typeParam TJobs A declared job map, for the registry worker `jobs.start()`
 * returns: its listeners are then handed a `TypedJob`, discriminated by name,
 * and each declared name's scoped events carry that name's own types. The
 * default, `JobMap`, means none — the events are exactly as before.
 */
export class BunQueueWorker<
  TData = unknown,
  TResult = unknown,
  TJobs extends JobMapOf<TJobs> = JobMap,
> extends TypedEmitterBase<
  WorkerEventsOf<TData, TResult, TJobs>,
  BunQueueWorkerEvents<TData, TResult>
> {
  /**
   * Identifies this worker in job records and logs: its **incarnation**,
   * unique among live workers and new every time the process starts unless
   * an explicit id was given. Lifecycle control is addressed by it.
   */
  readonly id: string;
  /**
   * The **stable** identity a configuration override is keyed by, so an
   * override survives restarts and reaches every replica of this worker.
   */
  readonly key: string;
  /** The service it belongs to, when its context named one. */
  readonly service: string | undefined;
  /**
   * When this process started, in epoch milliseconds — `performance.timeOrigin`
   * rounded. What tells one incarnation from the next when the id is stable.
   */
  readonly processStartedAt: number;
  /** The queue it consumes. */
  readonly queueName: string;
  /** The namespace it consumes from. */
  readonly namespace: string;
  /** Where jobs live. */
  readonly driver: JobsDriver;

  /** What to run for each job. */
  readonly #processor: JobProcessor<TData, TResult> | undefined;
  /**
   * Where each attempt runs, when not simply a call to `#processor`: a
   * processor file in any local target, or a custom target's executor.
   * `undefined` only for a function processor run in-process, which
   * `#process()` calls directly.
   */
  readonly #target: WorkerTargetExecutor | undefined;
  /**
   * The heartbeat record's `target`, derived once from the very target
   * `#target` was built from, so the record cannot disagree with it. Frozen,
   * because {@link BunQueueWorker.target} hands out this very object and the
   * memory driver keeps a reference to it in the record it stores.
   */
  readonly #targetInfo: Readonly<WorkerTargetInfo>;
  /**
   * The heartbeat record's `summon`: the `summon` option, checked and copied
   * field by field in the constructor. `undefined` for a worker nobody
   * summoned, which then writes no `summon` at all.
   */
  readonly #summon: Readonly<WorkerSummonProvenance> | undefined;
  /** Options with defaults applied. */
  readonly #options: Required<
    Pick<
      BunQueueWorkerOptions,
      | "concurrency"
      | "lockDuration"
      | "heartbeatInterval"
      | "stalledInterval"
      | "maxStalledCount"
      | "pollInterval"
      | "maxBlock"
      | "maintenance"
      | "drainDelay"
    >
  >;

  /** Whether this worker built the driver and must close it. */
  readonly #ownsDriver: boolean;
  /** Logger bound to this worker. */
  readonly #logger: Logger;
  /**
   * This worker's identity on the events it publishes (`origin`), stable for
   * its whole life. **Not a lock**: every claim mints its own token (see
   * {@link #claimUpToConcurrency}), because a lock shared by all of a
   * worker's claims let an abandoned attempt settle, renew or fail the same
   * worker's later claim of the same job (#187).
   */
  readonly #origin: string;
  /** Named backoff strategies, for jobs that name one. */
  readonly #backoffs: BackoffStrategies;
  /**
   * This worker's side of the queue's stored limits, when the driver can hold
   * them. It costs one cached read a second on a queue with none.
   */
  /**
   * The attribution every claim stamps (`ClaimOptions.worker`): built once,
   * since none of it changes for a worker's lifetime, rather than per claim.
   */
  readonly #workerRef: { key: string; host: string; pid: number };
  readonly #limiter: QueueLimiter | undefined;
  /**
   * The queue's stored job defaults as this worker last read them — read
   * only to build a repeat series' next occurrence, trusted for
   * `jobDefaultsRefreshInterval`.
   */
  readonly #jobDefaults: JobDefaultsCache;
  /** Where the next sweep of debounce and throttle pointers resumes. */
  #windowCursor: string | undefined;
  /**
   * Where the next pass over parents waiting on children resumes: a page
   * offset into them, and the child of that page's first parent to start at.
   * Wraps to the start after the last page.
   */
  #parentsCursor = { offset: 0, child: 0 };
  /**
   * Where the next pass over finished jobs looking for unrecorded children
   * resumes: the state, `completed` then `dead`, and an offset into it.
   */
  #childrenCursor: { state: "completed" | "dead"; offset: number } = {
    state: "completed",
    offset: 0,
  };

  /**
   * Flow deliveries this worker started and could not finish — a write that
   * failed, or a parent not there yet — by `queue:id`, with how many tries
   * they have had and the fast retry timer, if one is set. Tried again before
   * any maintenance scan.
   */
  readonly #redeliveries = new Map<
    string,
    {
      /** The child's queue. */
      queue: string;
      /** The child's id. */
      id: string;
      /** Tries so far. */
      attempts: number;
      /** The pending fast retry, if any. */
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * How long to wait before claiming again after a pass the limits held back,
   * or `undefined` when the last pass was not limited.
   */
  #limitedFor: number | undefined;
  /** The dead-letter queue for jobs that do not name their own. */
  readonly #deadLetterQueue: string | undefined;
  /** When each series was last read as enabled; see `#repeatDisabled`. */
  readonly #enabledRepeats = new Map<string, number>();
  /** Dead-letter queues opened so far, by name, closed with the worker. */
  readonly #deadLetters = new Map<
    string,
    BunQueue<DeadLetter, unknown, string>
  >();

  /** Whether this worker announces its job events to other processes. */
  readonly #publishes: boolean;
  /** Awaited before each publish; see `BunQueueWorkerOptions.publishGate`. */
  readonly #publishGate: (() => Promise<void>) | undefined;
  /** When the queue was first seen empty, for `drainDelay`. */
  #emptySince: number | undefined;
  /** Whether `drained` has been emitted for the current quiet spell. */
  #drainedAnnounced = false;
  /**
   * Whether the last wait for work ended within a millisecond and nothing has
   * been claimed since. `#idle` sleeps its 1ms floor only on the second such
   * wait in a row: the first is usually a job that arrived a moment ago.
   */
  #instantIdle = false;
  /**
   * Attempts in flight, by {@link Attempt} — not by job id, so two attempts
   * at the same job both count against the concurrency and `close()` waits
   * for both.
   */
  readonly #active = new Map<Attempt, Promise<void>>();
  /**
   * Fired each time a running job leaves `#active`, so a full or limited
   * worker waits on one signal rather than on every running job's promise —
   * those left a reaction per wait on each still-running job (B1).
   */
  readonly #slotFreed = new Pulse();
  /** Controllers for the attempts in flight, so they can be aborted. */
  readonly #aborts = new Map<Attempt, AbortController>();
  /** Completion writes still in flight, so `close()` does not abandon one. */
  readonly #settling = new Set<Promise<void>>();
  /** Publishes still in flight, which `close()` waits for. */
  readonly #publishing = new Set<Promise<void>>();
  /** Batches finished jobs, so a burst settles in one round trip. */
  readonly #completions: CompletionBatcher;

  /**
   * What this worker's own code asked for, before any override — every
   * setting an override may replace, kept as the code said it so
   * {@link BunQueueWorker.config} can show both, and so removing an override
   * restores what the process actually configured.
   *
   * A local setter (`worker.concurrency = 8`, `jobs.processEvery(...)`)
   * changes *this*, not what is in force: the effective value stays
   * `override ?? code`, and the setter warns when an override shadows it.
   */
  readonly #codeConfig: WorkerConfigValues;
  /** The settings a stored override currently replaces. */
  #override: WorkerConfigPatch = {};
  /** The version of the override in force; `0` when there is none. */
  #configSeq = 0;
  /** When that override was written, epoch ms; unset when there is none. */
  #configUpdatedAt: number | undefined;
  /** Settings whose code value was derived rather than given. */
  readonly #derivedConfig: WorkerConfigKey[];
  /** How this worker hears about instructions, and how often it looks. */
  readonly #controlOptions: {
    /** Whether it listens at all. */
    enabled: boolean;
    /** Whether it subscribes rather than only polling. */
    subscribe: boolean;
    /** How often it reads the entries when it does not subscribe, in ms. */
    interval: number;
  };

  /** How long a stop given to this worker lasts. */
  readonly #stopPersistence: WorkerStopPersistence;
  /** Whether one instruction may ask for the other persistence. */
  readonly #stopPersistenceOverridable: boolean;
  /** What the worker is, before `paused` is folded in. */
  #phase: WorkerPhase = "running";
  /**
   * The state last announced, so only a real change raises an event;
   * `undefined` until `run()` makes the first announcement, which carries no
   * `previous`.
   */
  #announcedState: WorkerState | undefined;
  /**
   * The reason given with the latest change made before the first
   * announcement — a stop recorded against the key, adopted during startup —
   * carried on that announcement.
   */
  #firstReason: string | undefined;
  /** Resolved by `start()` to call off a stop that is still draining. */
  #stopCancel: ReturnType<typeof createDeferred<void>> | undefined;
  /** Instruction applications chained, so the latest wins rather than a queue of stale steps. */
  #controlChain: Promise<void> = SETTLED;
  /** Whether an adoption is running, so a report does not start another. */
  #adopting = false;
  /** Whether an instruction has been accepted and is still being carried out. */
  #controlPending = false;
  /** The version of the lifecycle instruction this worker has applied. */
  #appliedSeq = 0;
  /** The last instruction that could not be applied, and why. */
  #controlError: WorkerControlInfo["lastError"] | undefined;
  /**
   * Stops following the queue's control change counter, when this worker
   * polls rather than subscribes. The counter is read once per process per
   * queue (`watchWorkerChanges`); this worker reads its own entries only
   * when it moves (C7).
   */
  #controlUnwatch: (() => void) | undefined;
  /** Closes the worker-channel subscription, when there is one. */
  #controlUnsubscribe: (() => Promise<void>) | undefined;
  /** Where the next sweep of dead workers' instructions resumes. */
  #controlSweepCursor: string | undefined;
  /** Whether the heartbeat has yet looked for another worker using this id. */
  #checkedDuplicateId = false;

  /** How many jobs to process at once; settable at runtime. */
  #concurrency: number;
  /** Whether the claim loop is running. */
  #running = false;
  /** Whether `close()` has been called. */
  #closing = false;
  /**
   * Whether `close()` has closed the driver this worker owns. Read by a
   * `run()` that the close overtook during startup: a forced close does not
   * wait for it, so the driver may have been closed before a connect that
   * was already under way opened it again.
   */
  #driverClosed = false;
  /** Whether this worker is locally paused. */
  #paused = false;
  /** Resolves when the claim loop has stopped. */
  #stopped = createDeferred<void>();
  /** Whether a running worker holds the process open. */
  readonly #waitToExit: boolean;
  /** The handle holding the process open while the loop runs, if any. */
  #keepAlive: ReturnType<typeof setInterval> | undefined;
  /** Aborted to wake the loop out of a wait. */
  #wake = new AbortController();
  /**
   * When the queue's next delayed job is due, as the last promotion reported
   * it (`null`: nothing scheduled), and the `scheduleEpoch` it was read under.
   *
   * While it stands — `at` still in the future, and no writer in this process
   * has scheduled anything on the queue since — an empty pass skips its
   * promotion and budgets its wait from it. A job *another* process (or
   * another driver instance) schedules earlier is not seen by it: the
   * promotion sweep, which runs every `promotionCadence` (at most a second)
   * whatever this holds, promotes that one and wakes the loop, so it is at
   * most that much late. Cleared by any wake. `undefined`: not known, so the
   * next empty pass promotes.
   */
  #nextDue: { at: number | null; epoch: number } | undefined;
  /**
   * Each running attempt's lock renewal, by {@link Attempt}: the timer, and
   * what it needs to renew with.
   *
   * The record and the controller are kept beside the timer because a
   * configuration change has to re-arm every renewal in flight — at the new
   * cadence, and with an immediate renewal at the new duration — and it can
   * only do that if it can call `#heartbeat` for a job it did not start.
   */
  readonly #heartbeats = new Map<
    Attempt,
    {
      /** The renewal timer. */
      timer: ReturnType<typeof setInterval>;
      /** The job being renewed. */
      record: JobRecord;
      /** Its abort controller, so a lost lock can end the attempt. */
      controller: AbortController;
    }
  >();

  /** Maintenance timers, cleared on close. */
  readonly #timers = new Set<ReturnType<typeof setInterval>>();
  /** Cached queue-paused flag and when it was read. */
  #pauseCache: { paused: boolean; at: number } = { paused: false, at: 0 };
  /**
   * How often the heartbeat record is written, in milliseconds; `0` for never.
   * Not `readonly`: it is one of the settings an override may replace, and
   * changing it re-arms the timer.
   */
  #reportInterval: number;
  /** When `run()` last started consuming, for the heartbeat record. */
  #startedAt = 0;
  /** The timer writing the heartbeat record, while the worker runs. */
  #reportTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * The heartbeat write in flight, so writes never overlap and `close()` can
   * wait for one before removing the record — otherwise a write landing after
   * the removal would list a closed worker until its record lapsed.
   */
  #reporting: Promise<void> | undefined;
  /**
   * Whether a heartbeat write was ever attempted. Closing removes the record
   * only then: a worker that never ran, or never got as far as connecting,
   * has nothing to remove, and asking a driver to remove it would connect —
   * and on an unreachable backend, wait — for nothing.
   */
  #reported = false;
  /**
   * How long the last heartbeat write took, in milliseconds, for the next
   * record's `heartbeatRttMs`. `undefined` until one has completed — a write
   * cannot time itself, so the figure a record carries is the previous
   * write's. Only a write that landed is kept; a failed one leaves the last
   * good sample alone rather than reporting the time spent failing.
   */
  #reportRttMs: number | undefined;
  /**
   * This worker's analytics: the outcomes it counts under its stable key, the
   * busyness each report samples, and the cumulative counts the heartbeat
   * record carries. Built in the constructor, once the logger exists.
   */
  readonly #metrics: WorkerMetricsRecorder;

  constructor(
    queueName: string,
    /**
     * What runs each job: a function, or the path (or URL) of a file that
     * default-exports one — which `target` can then run in a `Worker` or a
     * child process.
     */
    processor: JobProcessor<TData, TResult> | string | URL,
    options: BunQueueWorkerOptions,
  ) {
    super();

    this.queueName = assertSegment(queueName, "queue name");
    this.namespace = assertNamespace(options.namespace);
    // Validated here, before the worker has any side effects; the executor
    // is built below, once the id and logger a factory is handed exist.
    const target = resolveWorkerTarget(options, processor);
    this.#processor = typeof processor === "function" ? processor : undefined;
    this.processStartedAt = Math.round(performance.timeOrigin);
    this.service =
      options.service === undefined
        ? undefined
        : assertSegment(options.service, "service");
    this.key =
      options.key === undefined
        ? (options.id ??
          deriveWorkerKey({
            ...(this.service === undefined ? {} : { service: this.service }),
            queue: this.queueName,
            ...(options.name === undefined
              ? {}
              : { name: assertSegment(options.name, "worker name") }),
            ...(options.keyOrdinal === undefined
              ? {}
              : { ordinal: options.keyOrdinal }),
          }))
        : assertSegment(options.key, "worker key");
    // Derived rather than random, so two live workers cannot collide by
    // chance and a supervisor reading a log can tell which process a worker
    // belongs to. `newId()` is still the fallback for the impossible case of
    // an empty key.
    this.id =
      options.id ??
      `${this.key || newId()}.${incarnationTag(
        HOST,
        process.pid,
        this.processStartedAt,
        ++workerSerial,
      )}`;
    this.#origin = newToken(this.id);
    this.#workerRef = { key: this.key, host: HOST, pid: process.pid };

    const { driver, owned } = resolveDriver(options.driver, options.metrics);
    this.driver = driver;
    this.#ownsDriver = owned;
    this.#completions = new CompletionBatcher(driver, this.ref);

    const lockDuration = options.lockDuration ?? DEFAULT_LOCK_DURATION;
    this.#concurrency = Math.max(1, options.concurrency ?? 1);
    this.#options = {
      concurrency: this.#concurrency,
      lockDuration,
      heartbeatInterval:
        options.heartbeatInterval ??
        Math.max(250, Math.floor(lockDuration / 3)),
      stalledInterval: options.stalledInterval ?? DEFAULT_STALLED_INTERVAL,
      maxStalledCount: options.maxStalledCount ?? DEFAULT_MAX_STALLED,
      pollInterval: options.pollInterval ?? DEFAULT_POLL_INTERVAL,
      maxBlock: options.maxBlock ?? DEFAULT_MAX_BLOCK,
      maintenance: options.maintenance ?? true,
      drainDelay: options.drainDelay ?? 0,
    };

    const reportInterval = options.reportInterval ?? DEFAULT_REPORT_INTERVAL;
    if (!Number.isFinite(reportInterval) || reportInterval < 0) {
      throw new ConfigError(
        "reportInterval must be a number of milliseconds, or 0 to turn reporting off",
        { reportInterval },
      );
    }
    this.#reportInterval = reportInterval;
    // Checked here, before any side effect, and needs the report interval and
    // the driver: a summoned worker that never reports could never release
    // its attempt.
    this.#summon = resolveSummonProvenance(
      options.summon,
      reportInterval,
      supportsWorkers(driver),
    );

    this.#derivedConfig =
      options.heartbeatInterval === undefined ? ["heartbeatInterval"] : [];
    this.#codeConfig = {
      concurrency: this.#concurrency,
      pollInterval: this.#options.pollInterval,
      maxBlock: this.#options.maxBlock,
      lockDuration: this.#options.lockDuration,
      heartbeatInterval: this.#options.heartbeatInterval,
      stalledInterval: this.#options.stalledInterval,
      maxStalledCount: this.#options.maxStalledCount,
      reportInterval,
      drainDelay: this.#options.drainDelay,
    };

    const control = options.control ?? false;
    const controlOptions =
      typeof control === "object" ? control : { enabled: control };
    this.#controlOptions = {
      enabled: controlOptions.enabled ?? true,
      // A subscription on a driver that polls is one query every few dozen
      // milliseconds per queue, so it is opt-in there and automatic where the
      // backend pushes. Either way the heartbeat re-reads the entries, so the
      // choice is about latency, never about whether control works.
      subscribe:
        controlOptions.subscribe ?? driver.capabilities.events !== "poll",
      interval: Math.max(
        100,
        controlOptions.interval ??
          Math.min(
            DEFAULT_CONTROL_INTERVAL,
            reportInterval || DEFAULT_CONTROL_INTERVAL,
          ),
      ),
    };
    this.#stopPersistence = options.stopPersistence ?? "process";
    this.#stopPersistenceOverridable =
      options.stopPersistenceOverridable ?? false;

    this.#publishes = options.publish ?? false;
    this.#publishGate = options.publishGate;
    this.#waitToExit = options.waitToExit ?? true;
    this.#backoffs = BackoffStrategies.from(options.backoffStrategies);
    this.#limiter = QueueLimiter.supports(driver)
      ? new QueueLimiter(
          driver,
          this.ref,
          this.id,
          lockDuration,
          options.limitsRefreshInterval,
        )
      : undefined;
    this.#jobDefaults = new JobDefaultsCache(
      driver,
      this.ref,
      options.jobDefaultsRefreshInterval,
    );
    this.#deadLetterQueue =
      options.deadLetterQueue === undefined
        ? undefined
        : assertSegment(options.deadLetterQueue, "deadLetterQueue");

    this.#logger = createJobsLogger(
      options.logger,
      {
        namespace: this.namespace,
        queue: this.queueName,
        workerId: this.id,
        workerKey: this.key,
      },
      `worker:${this.queueName}`,
    );
    this.#target = buildTargetExecutor(target, processor, {
      namespace: this.namespace,
      queue: this.queueName,
      workerId: this.id,
      logger: this.#logger,
    });
    this.#targetInfo = Object.freeze(describeTarget(target, this.#target));
    this.#metrics = new WorkerMetricsRecorder({
      driver,
      ref: this.ref,
      // The stable key, never the incarnation's id: a rolling redeploy must
      // continue the series, not start one per replica. The id only stands in
      // for a key that is somehow empty.
      key: this.key || this.id,
      metrics: resolveMetricsOptions(options.metrics),
      logger: this.#logger,
    });

    if (options.autorun) {
      void this.run().catch((error: unknown) => {
        this.#emitError(error, "autorun");
      });
    }
  }

  /* --- accessors -------------------------------------------------------- */

  /** The queue this worker consumes, as the driver wants it. */
  get ref(): QueueRef {
    return { ns: this.namespace, queue: this.queueName };
  }

  /** How many jobs it processes at once. */
  get concurrency(): number {
    return this.#concurrency;
  }

  /**
   * Changes the concurrency at runtime; takes effect on the next claim.
   *
   * It changes what this worker's **code** asks for. A stored override of
   * `concurrency` still wins — that is the point of an override — and the
   * call is then recorded and logged rather than silently obeyed or silently
   * dropped. Remove the override to hand the setting back to the process.
   */
  set concurrency(value: number) {
    const next = Math.max(1, Math.floor(value));
    this.#codeConfig.concurrency = next;

    if (this.#shadowed("concurrency", next)) {
      return;
    }

    this.#concurrency = next;
    this.#wake.abort();
    void this.#report();
  }

  /**
   * How long an idle worker waits before looking for work again, on a driver
   * that polls; also the cadence of the delayed-job promotion sweep, capped at
   * once a second.
   */
  get pollInterval(): number {
    return this.#options.pollInterval;
  }

  /**
   * Changes the poll interval at runtime, and re-arms a running worker's
   * promotion sweep when its cadence changes. At most 2,147,483,647ms, the
   * longest a timer can wait.
   *
   * On a polling driver the wait in progress is cut short, so the new
   * interval applies at once. On a blocking one (`capabilities.blockingWait`)
   * it is left to finish and the new value applies from the next wait: a
   * blocking read cannot be called off, and one abandoned mid-wait still
   * consumes the wake a new job sends, which would leave that job waiting out
   * the whole of the next wait.
   */
  set pollInterval(value: number) {
    const ms = assertPositiveMs(value, "pollInterval");
    this.#codeConfig.pollInterval = ms;

    if (this.#shadowed("pollInterval", ms)) {
      return;
    }

    const before = promotionCadence(this.#options.pollInterval);

    this.#options.pollInterval = ms;

    if (promotionCadence(ms) !== before) {
      this.#armPromotion();
    }

    this.#wakeForNewInterval();
  }

  /** Longest an idle worker blocks waiting for work, on a blocking driver. */
  get maxBlock(): number {
    return this.#options.maxBlock;
  }

  /**
   * Changes `maxBlock` at runtime, at most 2,147,483,647ms. As with
   * `pollInterval`, a wait in progress is cut short only on a polling driver;
   * on a blocking one the new value applies from the next wait.
   */
  set maxBlock(value: number) {
    const ms = assertPositiveMs(value, "maxBlock");
    this.#codeConfig.maxBlock = ms;

    if (this.#shadowed("maxBlock", ms)) {
      return;
    }

    this.#options.maxBlock = ms;
    this.#wakeForNewInterval();
  }

  /**
   * Whether a stored override replaces `key`, so a local set of it changes
   * only what the code asks for. Says so once per call, because a change
   * quietly ignored is the kind of thing somebody debugs for an afternoon.
   */
  #shadowed(key: WorkerConfigKey, value: number): boolean {
    if (this.#override[key] === undefined) {
      return false;
    }

    this.#logger.warn(
      `${key} was set locally but a stored override is in force, so it did not take effect`,
      { setting: key, requested: value, effective: this.#override[key] },
    );
    return true;
  }

  /**
   * Ends the current wait so a changed interval applies at once — only where
   * that is safe. See {@link BunQueueWorker.pollInterval}'s setter for why a
   * blocking driver's wait is left alone.
   */
  #wakeForNewInterval(): void {
    if (!this.driver.capabilities.blockingWait) {
      this.#wake.abort();
    }
  }

  /**
   * How many attempts are in flight, which is what the concurrency caps.
   * Usually one per job; two for a job whose abandoned attempt — its lock
   * lapsed and the stalled sweep handed it back — is still running beside the
   * attempt that claimed it again, since both hold a slot.
   */
  get activeCount(): number {
    return this.#active.size;
  }

  /** Whether the claim loop is running. */
  get isRunning(): boolean {
    return this.#running;
  }

  /**
   * What this worker is doing — the same five values a management API
   * reports. `paused` is folded in here: it is a thing a *running* worker is.
   */
  get state(): WorkerState {
    if (this.#phase !== "running") {
      return this.#phase;
    }

    return this.#paused ? "paused" : "running";
  }

  /**
   * Whether it is parked: not claiming, not doing maintenance, still
   * heartbeating so a controller can reach it — and `run()` still pending, so
   * a supervisor awaiting it is not told the worker shut down.
   */
  isStopped(): boolean {
    return this.#phase === "stopping" || this.#phase === "stopped";
  }

  /** Every setting in force, and what this worker's own code asked for. */
  get config(): WorkerConfigInfo {
    return {
      effective: this.#liveConfig(),
      code: { ...this.#codeConfig },
      overridden: WORKER_CONFIG_KEYS.filter(
        (key) => this.#override[key] !== undefined,
      ),
      ...(this.#derivedConfig.length > 0
        ? { derived: [...this.#derivedConfig] }
        : {}),
      seq: this.#configSeq,
      ...(this.#configUpdatedAt === undefined
        ? {}
        : { updatedAt: this.#configUpdatedAt }),
    };
  }

  /** What this worker says about being controlled from another process. */
  get control(): WorkerControlInfo {
    return {
      enabled: this.#controlEnabled(),
      mode: this.#controlOptions.subscribe ? "subscribe" : "poll",
      appliedSeq: this.#appliedSeq,
      configSeq: this.#configSeq,
      pending: this.#controlPending,
      stopPersistence: this.#stopPersistence,
      stopPersistenceOverridable: this.#stopPersistenceOverridable,
      ...(this.#controlError === undefined
        ? {}
        : { lastError: this.#controlError }),
    };
  }

  /** The settings actually in force, read off the fields that hold them. */
  #liveConfig(): WorkerConfigValues {
    return {
      concurrency: this.#concurrency,
      pollInterval: this.#options.pollInterval,
      maxBlock: this.#options.maxBlock,
      lockDuration: this.#options.lockDuration,
      heartbeatInterval: this.#options.heartbeatInterval,
      stalledInterval: this.#options.stalledInterval,
      maxStalledCount: this.#options.maxStalledCount,
      reportInterval: this.#reportInterval,
      drainDelay: this.#options.drainDelay,
    };
  }

  /** Whether this worker listens for instructions, and can reach where they live. */
  #controlEnabled(): boolean {
    return this.#controlOptions.enabled && supportsWorkerControl(this.driver);
  }

  /** The worker's logger. */
  get logger(): Logger {
    return this.#logger;
  }

  /**
   * Where this worker's attempts run, as its heartbeat record reports it
   * (`WorkerInfo.target`): the kind, whether the processor is a function or a
   * file, a custom executor's `name`, and a processor file's absolute path.
   *
   * Known from the constructor on, so a caller need not wait for the first
   * report to land. It is the very object the record publishes, frozen, so
   * it always equals what `listWorkers()` returns for this worker. `file` is
   * included: this is the configuring application asking in-process, and
   * `serialize.exposeProcessorFiles` governs only what the management API
   * serves.
   */
  get target(): Readonly<WorkerTargetInfo> {
    return this.#targetInfo;
  }

  /* --- lifecycle --------------------------------------------------------- */

  /**
   * Consumes until closed. Resolves when the loop has stopped and every job
   * in flight has settled, so a supervising process can simply await it.
   *
   * A `close()` that lands while this is still starting — connecting,
   * creating the queue, reading its control entries — ends it there, and it
   * resolves: nothing is armed, no `ready` is emitted, and the process is not
   * held. On a worker already closed it resolves at once and does nothing: a
   * closed worker is not restarted.
   */
  async run(): Promise<void> {
    if (this.#running) {
      return await this.#stopped.promise;
    }
    // A closed worker stays closed (`#closing` is never reset), so running it
    // again would only open a connection for the startup checks to abandon.
    if (this.#closing) {
      return;
    }

    this.#running = true;
    this.#stopped = createDeferred<void>();

    try {
      await this.driver.connect();
      // Each startup await is re-checked against a close that landed during
      // it, and a closed worker goes no further: `close()` has already
      // cleared the timers, so anything armed after it would outlive it.
      if (!this.#closing) {
        await this.driver.ensureQueue(this.ref);
      }
    } catch (error) {
      if (!this.#closing) {
        // Never started, so nothing will ever stop: without this, `#running`
        // stayed true and `#stopped` never resolved, and a later `close()` —
        // which waits for the loop to stop — hung for good. A `run()` called
        // again tries to connect again rather than joining a dead start.
        this.#running = false;
        this.#stopped.resolve();
        throw error;
      }
      // A close was asked for, and most likely caused this — a forced close
      // shuts the driver under the connect. Either way the worker was never
      // going to start, so `run()` ends the way a close ends it.
      this.#logger.debug("Startup failed after close() was called", {
        error,
      });
    }

    if (this.#closing) {
      return await this.#abandonStart();
    }

    this.#armMaintenance();
    this.#startedAt = Date.now();
    // The first heartbeat, deliberately not awaited. Holding `run()` on a
    // write moves when the claim loop starts relative to whatever the caller
    // does next, and a job added straight after `run()` is then claimed along
    // a different path — which changed when a timed-out attempt's abort was
    // seen. A worker is listed moments after `ready`, not necessarily by it.
    void this.#report();
    this.#armReports();

    // Before the loop turns, never after: a worker whose stop was recorded
    // against its key must not claim one job on the way to finding that out.
    await this.#adoptControl({ initial: true });
    if (this.#closing) {
      // What startup armed above, `close()` has cleared; this goes no
      // further, so no `ready`, no announced state and no hold on the process.
      return await this.#abandonStart();
    }
    this.#armControl();
    // The first announcement, once startup has settled what the worker is —
    // `running`, `paused`, or `stopped` by a stop recorded against its key —
    // and with no `previous`, which is how a listener tells a start from a
    // transition. Only a worker's first `run()` reaches here unannounced.
    if (this.#announcedState === undefined) {
      this.#announceState(this.#firstReason, { first: true });
      this.#firstReason = undefined;
    }
    this.safeEmit("ready");

    // Held only once the worker is actually running: a `run()` that failed to
    // connect must not leave the process unable to exit.
    this.#holdProcess();
    void this.#loop();
    return await this.#stopped.promise;
  }

  /**
   * Ends a `run()` that a `close()` overtook during startup, before the claim
   * loop was started: stands down as the loop's own exit would, so a graceful
   * close waiting for it carries on.
   *
   * A forced close does not wait, and may already have closed the driver —
   * possibly before a connect it could not cancel opened it again, which
   * would keep the process alive for good. So an owned driver the close has
   * closed is closed once more. A graceful close is still waiting here, and
   * closes the driver itself after.
   */
  async #abandonStart(): Promise<void> {
    if (this.#ownsDriver && this.#driverClosed) {
      await this.driver.close().catch((error: unknown) => {
        this.#logger.debug("Could not close the driver again", { error });
      });
    }

    this.#running = false;
    this.#stopped.resolve();
  }

  /** Stops claiming. Jobs in flight are left to finish. */
  async pause(options?: { waitActive?: boolean }): Promise<void> {
    this.#paused = true;
    this.#wake.abort();
    this.safeEmit("paused");
    this.#announceState();
    void this.#report();

    if (options?.waitActive) {
      await Promise.allSettled([...this.#active.values()]);
    }
  }

  /** Resumes claiming. */
  resume(): void {
    this.#paused = false;
    this.#wake.abort();
    this.safeEmit("resumed");
    this.#announceState();
    void this.#report();
  }

  /** Whether this worker is locally paused. */
  isPaused(): boolean {
    return this.#paused;
  }

  /**
   * Parks the worker: stops claiming, disarms maintenance, waits for the jobs
   * in flight and gives back its share of the queue's limits — but keeps the
   * loop, the heartbeat record and `run()`'s promise alive, so
   * {@link BunQueueWorker.start} can bring it back.
   *
   * That is the whole difference from `close()`, and it is deliberate.
   * `await worker.run()` is the documented supervisor pattern, so resolving
   * it would make a stop look like a shutdown and the process would exit;
   * and a worker that unregistered could never be told to start again,
   * because nothing would know it was there.
   *
   * Jobs in flight are not aborted unless `timeout` says to. An abandoned
   * job's lock lapses and another worker recovers it as stalled, which is a
   * delay rather than a loss — but it is a second run of work that had
   * already started, so it is never the default.
   *
   * A {@link BunQueueWorker.start} while this is still draining calls it off,
   * and this resolves without having parked.
   */
  async stop(options?: {
    /** Abandon jobs still running after this many milliseconds. */
    timeout?: number;
    /** Why, for the `state` event. */
    reason?: string;
  }): Promise<void> {
    if (this.#closing || this.isStopped()) {
      return;
    }

    this.#setPhase("stopping", options?.reason);
    this.#wake.abort();
    this.#disarmMaintenance();
    // A parked worker runs no sweeps, so it must not go on holding the leases
    // for them; the expiry would cover it, three cadences later.
    void this.#releaseSweepLeases();
    void this.#report();

    const cancel = createDeferred<void>();
    this.#stopCancel = cancel;

    try {
      if (this.#active.size > 0) {
        const races: Promise<"done" | "started" | "timeout">[] = [
          Promise.allSettled([...this.#active.values()]).then(
            () => "done" as const,
          ),
          cancel.promise.then(() => "started" as const),
        ];

        if (options?.timeout !== undefined) {
          races.push(
            sleep(options.timeout, { unref: true }).then(
              () => "timeout" as const,
            ),
          );
        }

        if ((await Promise.race(races)) === "timeout") {
          this.#abandonActive();
        }
      }
    } finally {
      if (this.#stopCancel === cancel) {
        this.#stopCancel = undefined;
      }
    }

    // `start()` landed while the jobs were draining, so this stop is off.
    if (this.#phase !== "stopping" || this.#closing) {
      return;
    }

    // Held capacity goes back now rather than at its lease's expiry: a
    // stopped worker counted against a queue's concurrency limit would hold
    // slots its peers could be using for as long as it is parked.
    await this.#limiter
      ?.close()
      .catch((error: unknown) => this.#emitError(error, "limits"));

    this.#setPhase("stopped");
    await this.#report();
  }

  /**
   * Brings a parked worker back: re-arms maintenance and the promotion sweep,
   * clears `paused`, and wakes the loop. A stop still draining is called off,
   * so the worker simply carries on with the jobs it already had.
   */
  start(): void {
    if (this.#closing) {
      return;
    }

    if (this.#phase === "running") {
      if (this.#paused) {
        this.resume();
      }
      return;
    }

    this.#stopCancel?.resolve();
    this.#stopCancel = undefined;
    this.#paused = false;
    this.#setPhase("running");

    // A deliberate start lifts a stop recorded against the key too, so the
    // next replacement does not come up stopped (B14). Only where one can be
    // honoured, and only with remote control, which is what writes them.
    if (this.#controlEnabled() && this.#honoursKeyStop) {
      this.#clearKeyStop();
    }

    if (this.#running) {
      this.#armMaintenance();
      this.#armReports();
    }

    this.#wake.abort();
    void this.#report();
  }

  /**
   * Moves to a phase and announces the state if it changed. Every transition
   * goes through here, so a `state` event is raised exactly once per real
   * change — never for a stop that was asked for twice.
   */
  #setPhase(phase: WorkerPhase, reason?: string): void {
    this.#phase = phase;
    this.#controlPending = phase === "stopping" || phase === "restarting";
    this.#announceState(reason);
  }

  /**
   * Emits and publishes the worker's state, if it has changed since the last
   * announcement.
   *
   * Nothing is announced before `run()` has made the first announcement
   * (`first`): a change made earlier — a `pause()` before `run()`, or what
   * startup adopts — is folded into that one, which carries no `previous`.
   */
  #announceState(reason?: string, options?: { first?: boolean }): void {
    const state = this.state;

    if (this.#announcedState === undefined && !options?.first) {
      this.#firstReason = reason;
      return;
    }

    if (state === this.#announcedState) {
      return;
    }

    const previous = this.#announcedState;
    this.#announcedState = state;
    this.#publishWorker("state", {
      worker: this.id,
      key: this.key,
      state,
      ...(previous === undefined ? {} : { previous }),
      ...(reason === undefined ? {} : { reason }),
      at: Date.now(),
    });
  }

  /**
   * Clears the maintenance and promotion timers a parked worker must not run.
   * The heartbeat timer is deliberately left alone — a stopped worker that
   * stopped reporting would vanish from the registry and could never be
   * started again.
   */
  #disarmMaintenance(): void {
    for (const timer of this.#timers) {
      clearInterval(timer);
    }
    this.#timers.clear();
    this.#promotionTimer = undefined;
    this.#passesArmed = false;
    this.#housekeepingArmed = false;
  }

  /**
   * Stops claiming, waits for jobs in flight, and releases what it owns.
   *
   * A job still running at `timeout` — or at once, with `force` — has its
   * signal aborted, and is no longer waited for. What happens to its run then
   * depends on where it runs:
   *
   * - **On a `"child-process"` or `"worker-thread"` target** the run is ended
   *   for certain before `close()` returns. With `force` it is killed at once,
   *   its cleanup skipped. When `timeout` runs out it is asked to stop first,
   *   and given up to 4000 ms (`TARGET_CLOSE_GRACE`) to clean up and end; one
   *   that has not is killed. Either way, a process exiting straight after
   *   `close()` leaves nothing running behind it.
   * - **In-process**, a processor that honours its signal ends; one that
   *   ignores it cannot be stopped, and runs on while the process lives.
   *
   * A run that ends, killed or not, is recorded as a failed attempt, retried
   * if it has attempts left, when that write lands before the worker's driver
   * closes. Otherwise — and for a run that never ends — the job's lock is left
   * to expire, and another worker recovers it as stalled rather than the job
   * being lost.
   */
  async close(options?: { force?: boolean; timeout?: number }): Promise<void> {
    // Held for as long as closing takes, whatever `waitToExit` says. A caller
    // awaiting this in a signal handler has nothing else keeping the process
    // alive — every wait the worker makes is unref'd — so without it Bun could
    // exit halfway through draining in-flight work, completions and the
    // driver, and the handler would never reach its next line.
    const hold = setInterval(() => {}, 2_147_483_647);

    try {
      await this.#close(options);
    } finally {
      clearInterval(hold);
    }
  }

  /** The body of {@link BunQueueWorker.close}, under its hold on the process. */
  async #close(options?: { force?: boolean; timeout?: number }): Promise<void> {
    if (this.#closing) {
      await this.#stopped.promise;
      return;
    }

    this.#closing = true;
    this.safeEmit("closing");
    this.#wake.abort();

    for (const timer of this.#timers) {
      clearInterval(timer);
    }
    this.#timers.clear();

    // Before either path below closes the driver: a worker leaving hands the
    // queue's sweeps to another straight away, rather than leaving them to
    // wait out the lease it will never renew again.
    await this.#releaseSweepLeases();

    if (this.#reportTimer) {
      clearInterval(this.#reportTimer);
      this.#reportTimer = undefined;
    }

    this.#controlUnwatch?.();
    this.#controlUnwatch = undefined;

    // A stop still draining would otherwise wait out its jobs a second time,
    // behind the close that is already waiting for them.
    this.#stopCancel?.resolve();
    this.#stopCancel = undefined;

    const unsubscribe = this.#controlUnsubscribe;
    this.#controlUnsubscribe = undefined;
    await unsubscribe?.().catch((error: unknown) =>
      this.#emitError(error, "control"),
    );
    await this.#controlChain.catch(() => undefined);

    if (options?.force) {
      this.#abandonActive();

      // Deliberately no wait on the jobs themselves. A processor that ignores
      // its signal must not hold shutdown hostage; its lock lapses and the
      // stalled sweep returns the job to the queue, so the work is delayed
      // rather than lost. A built-in target's runs are killed here, though,
      // at once — `force` said not to wait, so they get no grace — because a
      // child left running would outlive the process (#166).
      await this.#closeTarget({ force: true });
      await this.#unregister();
      await this.#flushThroughput();
      await this.#metrics.close();
      await this.#closeDeadLetters();
      await this.#limiter
        ?.close()
        .catch((error: unknown) => this.#emitError(error, "limits"));
      await Promise.allSettled([...this.#publishing]);

      if (this.#ownsDriver) {
        await this.driver.close();
        this.#driverClosed = true;
      }

      this.#running = false;
      this.#releaseProcess();
      this.safeEmit("closed");
      return;
    }

    let abandoned = false;

    if (this.#active.size > 0) {
      const timeout = options?.timeout ?? this.#options.lockDuration;
      const finished = Promise.allSettled([...this.#active.values()]);
      const raced = await Promise.race([
        finished.then(() => "done" as const),
        sleep(timeout, { unref: true }).then(() => "timeout" as const),
      ]);

      if (raced === "timeout") {
        // Out of patience: from here this is a forced close for whatever is
        // still running. Waiting on those jobs again would hang on exactly the
        // processor the timeout exists for — one that ignores its signal.
        this.#abandonActive();
        abandoned = true;
      }
    }

    if (!abandoned) {
      await Promise.allSettled([...this.#active.values()]);
    }
    // Jobs finish before their completions are written, so drain those too.
    await this.#completions.idle();
    await Promise.allSettled([...this.#settling]);
    // Events published on the way here — `completed` among them — before the
    // driver they are written through can be closed.
    await Promise.allSettled([...this.#publishing]);

    if (this.#running) {
      await this.#stopped.promise;
    }

    await this.#closeTarget();
    await this.#unregister();
    await this.#flushThroughput();
    await this.#metrics.close();
    await this.#closeDeadLetters();
    await this.#limiter
      ?.close()
      .catch((error: unknown) => this.#emitError(error, "limits"));

    if (this.#ownsDriver) {
      await this.driver.close();
      this.#driverClosed = true;
    }

    this.#running = false;
    this.#releaseProcess();
    this.safeEmit("closed");
  }

  /**
   * Releases what the target holds, once the attempts have settled or been
   * abandoned: a custom target's resources, or the built-in child-process and
   * worker-thread target's runs still being killed, which it kills outright
   * before anything here waits (#166). Bounded like a built-in target's stop, by
   * `DEFAULT_CLOSE_TIMEOUT`: the worker's own state has settled by now, so a
   * `close()` that never returns is logged and left behind rather than
   * allowed to hang the shutdown. A rejection is logged the same way.
   */
  async #closeTarget(
    /** `{ force: true }` from a forced close, passed on; absent otherwise. */
    options?: WorkerTargetCloseOptions,
  ): Promise<void> {
    const target = this.#target;
    if (!target?.close) {
      return;
    }

    try {
      const closed = await Promise.race([
        Promise.resolve(
          options?.force ? target.close({ force: true }) : target.close(),
        ).then(() => "closed" as const),
        sleep(DEFAULT_CLOSE_TIMEOUT, { unref: true }).then(
          () => "timeout" as const,
        ),
      ]);
      if (closed === "timeout") {
        this.#logger.warn(
          `Target "${target.name}" did not close within ${DEFAULT_CLOSE_TIMEOUT}ms; closing without it`,
          { target: target.name, timeout: DEFAULT_CLOSE_TIMEOUT },
        );
      }
    } catch (error) {
      this.#logger.warn(`Target "${target.name}" failed to close`, {
        target: target.name,
        error,
      });
    }
  }

  /**
   * Gives up on every job still running: aborts its signal and stops renewing
   * its lock.
   *
   * Stopping the renewal is the half that matters for a processor ignoring
   * its signal. Its heartbeat would otherwise go on extending the lock for as
   * long as the process lives, so the lock never lapses and the stalled sweep
   * — in this process or any other — never returns the job to the queue.
   */
  #abandonActive(): void {
    for (const controller of this.#aborts.values()) {
      controller.abort();
    }

    for (const running of this.#heartbeats.values()) {
      clearInterval(running.timer);
    }
    this.#heartbeats.clear();
  }

  /**
   * Keeps the process alive while the claim loop runs, when the worker was
   * asked to — the default.
   *
   * A timer that never fires, whose only purpose is to count as pending work
   * to the event loop. The alternative, ref'ing the loop's own waits, would
   * make the rule depend on whichever wait happens to be in progress; one
   * handle held for exactly the life of `run()` is a rule that can be read.
   */
  #holdProcess(): void {
    if (!this.#waitToExit || this.#keepAlive) {
      return;
    }

    this.#keepAlive = setInterval(() => {}, 2_147_483_647);
  }

  /** Lets the process exit on the worker's account. */
  #releaseProcess(): void {
    if (this.#keepAlive) {
      clearInterval(this.#keepAlive);
      this.#keepAlive = undefined;
    }
  }

  /** Closes the dead-letter queues this worker opened. They share its driver. */
  async #closeDeadLetters(): Promise<void> {
    const queues = [...this.#deadLetters.values()];
    this.#deadLetters.clear();
    await Promise.allSettled(queues.map((queue) => queue.close()));
  }

  /* --- the claim loop ------------------------------------------------------ */

  /**
   * Claims and processes until closed.
   *
   * A failure inside the loop is reported and the loop carries on. Letting
   * one escape would end consumption for the life of the process: the worker
   * would sit there looking healthy while its queue filled up. Backends do
   * fail transiently — a connection drops, a database is briefly overloaded —
   * and the answer to that is to try again shortly, not to stop.
   */
  async #loop(): Promise<void> {
    try {
      while (!this.#closing) {
        try {
          await this.#iterate();
        } catch (error) {
          this.#emitError(error, "loop");
          // Wait before retrying, so a persistent failure is not a hot loop.
          await sleep(this.#options.pollInterval, { unref: true }).catch(
            () => {},
          );
        }
      }
    } finally {
      this.#running = false;
      this.#releaseProcess();
      this.#stopped.resolve();
    }
  }

  /** One pass of the claim loop. */
  async #iterate(): Promise<void> {
    if (this.isStopped()) {
      // Parked. The loop keeps turning — that is what keeps `run()` pending
      // and `start()` able to wake it — but it claims nothing and asks the
      // driver nothing, so a stopped worker costs a timer and its heartbeat.
      await this.#sleepUntilWake(this.#options.pollInterval);
      return;
    }

    if (this.#paused || (await this.#queuePaused())) {
      // Waiting *for work* is the wrong question while paused — there may be
      // plenty, and none of it claimable — so this is a plain sleep that
      // `resume()` cuts short.
      await this.#sleepUntilWake(this.#options.pollInterval);
      return;
    }

    const claimed = await this.#claimUpToConcurrency();

    if (claimed > 0) {
      // Work arrived, so the quiet spell is over and the next one is its own
      // event rather than a continuation of this one. Reset here rather than
      // further down: at a concurrency of one the branch below returns first,
      // so a worker that is never idle for long would never reset at all.
      this.#emptySince = undefined;
      this.#drainedAnnounced = false;
      this.#instantIdle = false;
    }

    if (this.#active.size >= this.#concurrency && this.#active.size > 0) {
      // Full: wait for a slot rather than spinning on a claim that cannot
      // succeed — or for a wake, so `close()` is not left waiting on a loop
      // that is itself waiting on a job that may never finish.
      await this.#sleepUntilWake(this.#options.lockDuration, true);
      return;
    }

    if (claimed > 0) {
      return;
    }

    if (this.#limitedFor !== undefined) {
      // Held back by the queue's limits, not short of work: wait for the
      // window to end or for one of this worker's own jobs to finish, and do
      // not announce a drain that did not happen.
      const wait = this.#limitedFor;
      this.#limitedFor = undefined;
      await this.#sleepUntilWake(wait, this.#active.size > 0);
      return;
    }

    // Nothing claimable. This is the moment to promote whatever has come due,
    // because it is the only moment the answer can change and the worker has
    // nothing else to do.
    //
    // Promotion used to run inside every `claimJob`, which charged a write to
    // every claim on a busy queue to serve a case that only arises on an idle
    // one. Moving it here removes that cost without slowing a retry down: a
    // job whose backoff has elapsed is picked up on the next empty pass rather
    // than waiting out the 1Hz maintenance sweep.
    //
    // Unless the last promotion said nothing more comes due before a known
    // time, and that time has not come: then the promotion would find nothing
    // — bar a job another process scheduled earlier since, which the sweep
    // still promotes within a second. See `#nextDue`.
    //
    // Never conditional on `maintenance`: promotion is liveness, and a queue
    // whose only worker opted out of it stranded every delayed retry.
    let nextDueAt: number | null | undefined = this.#knownNextDue(Date.now());
    if (nextDueAt === undefined) {
      const pass = await this.#promoteDue();
      if (pass && pass.promoted > 0) {
        return;
      }
      nextDueAt = pass?.nextDueAt;
    }

    this.#announceDrained();
    await this.#idle(await this.#waitBudget(nextDueAt));
  }

  /**
   * Publishes an event, tracked so `close()` can wait for it.
   *
   * Callers fire it and move on, and a caller may close straight after — from
   * the very listener the event was emitted to. Untracked, the close shut the
   * driver under the write: a `completed` event from a process that closed on
   * completion was lost, and on MongoDB, whose publish takes two round trips,
   * reliably.
   */
  #publish<Name extends QueueEventName>(
    type: Name,
    payload: QueueEventPayloads[Name],
    target: string = this.queueName,
  ): Promise<void> {
    // Nothing to track, and nothing to allocate, for a worker that does not
    // publish — which is most of them, on every job.
    if (!this.#publishes) {
      return SETTLED;
    }

    const publishing = this.#doPublish(type, payload, target).finally(() => {
      this.#publishing.delete(publishing);
    });
    this.#publishing.add(publishing);
    return publishing;
  }

  /**
   * Announces an event to other processes, when asked to.
   *
   * The worker is the only thing that knows a job became active, reported
   * progress, completed, failed or stalled — it is the process running it. So
   * without this, a producer or a dashboard elsewhere can observe only what it
   * did itself, which is why `BunQueue` declared those events and never saw
   * one.
   *
   * `type` selects the payload's shape, so a mismatched pair is a compile
   * error here rather than a surprise in a subscriber somewhere else. A
   * failure to publish is logged and swallowed: an observer missing an event
   * must never fail the job that produced it.
   *
   * `target` is the queue the event is about: this worker's own, or — for a
   * flow parent a child here released or buried — the parent's.
   */
  async #doPublish<Name extends QueueEventName>(
    type: Name,
    payload: QueueEventPayloads[Name],
    target: string,
  ): Promise<void> {
    await this.#publishGate?.();

    try {
      await this.driver.publish(
        queueEvent(
          {
            ns: this.namespace,
            target,
            type,
            origin: this.#origin,
          },
          payload,
        ),
      );
    } catch (error) {
      this.#logger.warn("Could not publish a worker event", { error, type });
    }
  }

  /**
   * Emits `drained` once the queue has been quiet for `drainDelay`.
   *
   * The option was resolved and never read, so `drained` fired on every empty
   * pass — which on an idle worker is once per poll, forever. That is not an
   * event, it is a heartbeat, and a listener that logs or alerts on it has to
   * debounce what should have arrived debounced.
   *
   * Quiet means *continuously* empty: the timer starts at the first empty pass
   * and is reset by the next claim, so a queue that hands out one job a second
   * with a one-second delay never drains. Emitted once per quiet spell rather
   * than once per pass, which is what makes it an event.
   */
  #announceDrained(): void {
    const delay = this.#options.drainDelay;

    if (delay <= 0) {
      this.safeEmit("drained");
      return;
    }

    this.#emptySince ??= Date.now();

    if (this.#drainedAnnounced || Date.now() - this.#emptySince < delay) {
      return;
    }

    this.#drainedAnnounced = true;
    this.safeEmit("drained");
  }

  /**
   * Claims up to the free slots and starts every job it gets.
   *
   * Exactly the free slots, and nothing is buffered: a job is only claimed when
   * there is a slot ready to run it. Holding claimed-but-unstarted jobs would
   * be faster on a backlog and would break three things at once — the jobs are
   * `active` with no heartbeat, so this worker's own stalled sweep would take
   * them back and run them twice; `close()` would abandon them; and peers would
   * idle while one worker sat on the queue.
   */
  async #claimUpToConcurrency(): Promise<number> {
    const slots = this.#concurrency - this.#active.size;

    if (slots <= 0 || this.#closing) {
      return 0;
    }

    const now = Date.now();
    const reservation = this.#limiter?.knownUnlimited(now)
      ? null
      : await this.#reserve(slots, now);

    // Reading the limits is an await, and `pause()` or `close()` may have
    // landed during it. The check at the top of the pass has already been
    // made, so it is made again here, before anything is claimed — and any
    // capacity reserved in the meantime goes straight back.
    if (this.#paused || this.#closing) {
      if (reservation && reservation.grant > 0) {
        await this.#limiter!.commit(reservation, [], Date.now()).catch(
          (error: unknown) => this.#emitError(error, "limits"),
        );
      }

      return 0;
    }

    if (reservation && reservation.grant === 0) {
      this.#limitedFor = this.#limitedWait(reservation.retryAfter);
      return 0;
    }

    // A lock of this claim's own, drawn now — never the worker's, and never
    // anything computed before this call. The same worker re-claiming a job
    // its own sweep took back must not share a token with the abandoned claim,
    // whose completion is not awaited and can land late: sharing one let that
    // completion record the abandoned result over the recovered one (#187).
    // `newClaimToken` says why it is random rather than a counter.
    const token = newClaimToken(this.id);
    let records: JobRecord[];

    try {
      records = await claimJobBatch(
        this.driver,
        this.ref,
        {
          workerId: this.id,
          worker: this.#workerRef,
          token,
          lockMs: this.#options.lockDuration,
          now,
          ...(reservation && reservation.excludeNames.length > 0
            ? { excludeNames: reservation.excludeNames }
            : {}),
        },
        reservation?.grant ?? slots,
      );
    } catch (error) {
      // The reservation already charged every open limited name for the whole
      // grant. Without the `commit` below nothing gives that back: the charge
      // sits on this worker's own lease, which it keeps renewing, so the name
      // reads as full until the worker closes. A claim that throws — InnoDB
      // picking it as a deadlock victim, a dropped connection — claimed
      // nothing, so all of it goes back before the error is reported.
      if (reservation && reservation.grant > 0) {
        await this.#limiter!.commit(reservation, [], Date.now()).catch(
          (commitError: unknown) => this.#emitError(commitError, "limits"),
        );
      }

      throw error;
    }

    // A forced close does not wait for this pass, so it can have started while
    // the claim was out — and the records the claim brought back must not be
    // started now. Run, they would meet a target that has already closed and
    // spend an attempt on a job that never ran: its last, for a job with one.
    // Left alone, each one's lock lapses and the stalled sweep returns it to
    // the queue — one stall, which `maxStalledCount` allows, and no attempt.
    // The driver has no way to hand a claim back without either.
    if (records.length > 0 && this.#closing) {
      await this.#declineClaimed(records, reservation, false);
      return 0;
    }

    // Every driver reports the token its claim stamped, and every write this
    // attempt makes — heartbeat, lock extension, completion, failure, and the
    // processor's own `extendLock()` and `fail()` — reads it off the record.
    // The claim's own value is what the driver stored, so it is the one kept:
    // a driver that reported something else would otherwise have its jobs
    // settle under a lock nobody holds.
    for (const record of records) {
      record.lockToken = token;
    }

    if (reservation) {
      await this.#limiter!.commit(
        reservation,
        records.map((record) => record.name),
        Date.now(),
      ).catch((error: unknown) => this.#emitError(error, "limits"));

      // Nothing came back while names were being skipped: there may well be
      // work, all of it capped. Waiting for work would return at once and
      // spin, so wait out the limit instead — and never call that drained.
      if (records.length === 0 && reservation.excludeNames.length > 0) {
        this.#limitedFor = this.#limitedWait(undefined);
      }
    }

    const reserved = reservation !== null && reservation.grant > 0;

    for (const [index, record] of records.entries()) {
      // The same rule as above, for a close that landed during the commit or
      // during the previous record's scheduling: from here, nothing starts.
      if (this.#closing) {
        await this.#declineClaimed(records.slice(index), reservation, true);
        return index;
      }

      // Schedule the series' next occurrence *before* running this one, so a
      // crash mid-job cannot end the series.
      if (record.repeatKey) {
        await this.#scheduleNextRepeat(record);

        // Declined after scheduling is a crash at this point, which the series
        // already survives: the stalled run schedules again when it runs.
        if (this.#closing) {
          await this.#declineClaimed(records.slice(index), reservation, true);
          return index;
        }
      }

      const attempt: Attempt = { record, reserved };
      const running = this.#process(attempt).finally(() => {
        this.#active.delete(attempt);
        this.#aborts.delete(attempt);
        this.#slotFreed.notify();
      });

      this.#active.set(attempt, running);
    }

    return records.length;
  }

  /**
   * Leaves claimed records unstarted, because the worker is closing, and gives
   * back the capacity reserved for them. Their locks are left to lapse, so the
   * stalled sweep returns them to the queue.
   *
   * Before the reservation is committed, committing it with nothing claimed
   * gives back all of it — the running count, the queue's rate window and
   * each name's tentative charge — exactly as a claim that found nothing
   * would. After, each record's share of the running count goes back the way
   * a finished job's does; its place in a rate window stays taken until the
   * window ends, as the commit recorded it.
   */
  async #declineClaimed(
    /** The records not to start. */
    records: JobRecord[],
    /** What was reserved for the claim, or `null` with no limits. */
    reservation: Reservation | null,
    /** Whether the reservation was already committed with these records. */
    committed: boolean,
  ): Promise<void> {
    this.#logger.debug(
      "Leaving claimed jobs unstarted: the worker is closing, and their locks will lapse",
      { jobIds: records.map((record) => record.id) },
    );

    if (!reservation || reservation.grant === 0 || !this.#limiter) {
      return;
    }

    if (!committed) {
      await this.#limiter
        .commit(reservation, [], Date.now())
        .catch((error: unknown) => this.#emitError(error, "limits"));
      return;
    }

    for (const record of records) {
      this.#limiter.release(record.name);
    }
  }

  /** Reserves capacity under the queue's limits, or `null` when it has none. */
  async #reserve(slots: number, now: number): Promise<Reservation | null> {
    if (!this.#limiter) {
      return null;
    }

    try {
      return await this.#limiter.reserve(slots, now);
    } catch (error) {
      // Limits that cannot be read are not a reason to stop consuming: the
      // cost of running unlimited for a moment is less than a stalled queue.
      this.#emitError(error, "limits");
      return null;
    }
  }

  /** How long a limited pass waits: until its window ends, within bounds. */
  #limitedWait(retryAfter: number | undefined): number {
    const recheck = Math.min(this.#options.pollInterval, LIMITED_RECHECK_MS);
    return retryAfter === undefined
      ? recheck
      : Math.max(1, Math.min(retryAfter, this.#options.maxBlock));
  }

  /**
   * Promotes whatever has come due, reporting how many moved and when the
   * next is due (remembered in `#nextDue`), or `null` when it failed.
   *
   * Anything promoted sends the loop straight back to claiming instead of
   * idling.
   */
  async #promoteDue(): Promise<PromotionRead | null> {
    try {
      return await this.#promote();
    } catch (error) {
      this.#emitError(error, "promote");
      return null;
    }
  }

  /**
   * One `promoteDelayed`, with its next due time remembered for the empty
   * passes after it. The epoch is read *before* the call, so a job this
   * process schedules while it is in flight invalidates what it answers.
   */
  async #promote(): Promise<PromotionRead> {
    const epoch = scheduleEpoch(this.driver, this.ref);
    const read = readPromotion(
      await this.driver.promoteDelayed(this.ref, Date.now(), MAINTENANCE_BATCH),
    );

    // A driver on the older contract answers the count alone: nothing to
    // remember, and the wait budget asks `nextDelayedAt` as it always did.
    this.#nextDue =
      read.nextDueAt === undefined ? undefined : { at: read.nextDueAt, epoch };
    return read;
  }

  /**
   * The remembered next due time while it still stands — `null` for nothing
   * scheduled — or `undefined` when the pass must promote: nothing is
   * remembered, the time has come, or a writer in this process has scheduled
   * a job on the queue since it was read.
   */
  #knownNextDue(now: number): number | null | undefined {
    const known = this.#nextDue;
    if (!known || known.epoch !== scheduleEpoch(this.driver, this.ref)) {
      return undefined;
    }

    return known.at !== null && known.at <= now ? undefined : known.at;
  }

  /** Runs one attempt at a job and records how it ended. */
  async #process(attempt: Attempt): Promise<void> {
    const { record } = attempt;
    /** The reason the processor gave `job.fail()`, which settles the attempt. */
    let failedWith: UnrecoverableJobError | undefined;
    /** Whether the processor has returned or thrown, so `fail()` is too late. */
    let attemptOver = false;
    const controller = new AbortController();
    /**
     * What this attempt has written about the job but not yet had answered, so
     * the record of how the job ended can be put behind it whichever way the
     * attempt ends and wherever the processor ran. It reads the abort signal,
     * so giving up on an attempt — a deadline, a lost lock, a closing worker —
     * ends it for its writes too: what the processor reports while it is being
     * stopped belongs to a job whose ending the worker is already writing, and
     * must not land on top of it.
     */
    const writes = new AttemptWrites(controller.signal);

    // The progress hook is how `updateProgress` reaches an emitter: `Job` has
    // none of its own, and the worker is the only thing that sees the call.
    // `onFail` is what makes this view the job's owner.
    const job = new Job<TData, TResult>(this.driver, this.ref, record, true, {
      writes,
      onProgress: (progress) => {
        this.safeEmitScoped("progress", record.name, job, progress);
        void this.#publish("progress", { id: record.id, progress });
      },
      onFail: (error) => {
        if (attemptOver) {
          return false;
        }

        // The first reason stands: failing is final, and a second call is
        // not a change of mind.
        failedWith ??= error;
        return true;
      },
      onEvent: async (event) => await this.#onJobEvent(event),
    });
    this.#aborts.set(attempt, controller);

    const heartbeat = setInterval(() => {
      void this.#heartbeat(record, controller);
    }, this.#options.heartbeatInterval);
    heartbeat.unref?.();
    this.#heartbeats.set(attempt, { timer: heartbeat, record, controller });

    // Built on first use: most processors never log, and a child logger is an
    // object and a copy of its bindings for every job.
    const parentLogger = this.#logger;
    let jobLogger: Logger | undefined;

    const context: ProcessorContext = {
      signal: controller.signal,
      get logger(): Logger {
        jobLogger ??= parentLogger.child({
          jobId: record.id,
          jobName: record.name,
        });
        return jobLogger;
      },
      workerId: this.id,
      attempt: record.attemptsMade,
      heartbeat: async () => {
        await this.#heartbeat(record, controller);
      },
      log: async (line) => await job.log(line),
    };

    this.safeEmitScoped("active", record.name, job);
    void this.#publish("active", { id: record.id });

    try {
      const running = this.#target
        ? this.#target.run({
            job: job as Job<unknown, unknown>,
            record,
            context,
          })
        : Promise.resolve(this.#processor!(job, context));
      // No timeout, no wrapper around it.
      const result =
        record.opts.timeout > 0
          ? await withTimeout(running, record.opts.timeout, {
              message: `Job ${record.id} exceeded its ${record.opts.timeout}ms timeout`,
              onTimeout: () => controller.abort(),
            })
          : await running;
      attemptOver = true;
      // Whatever the processor asked to have written, before the record of how
      // its job ended. The `if` is the whole cost for a job that wrote nothing
      // — no promise, no microtask — and this sits immediately in front of the
      // completion write that is deliberately not awaited.
      const settling = writes.settle();
      if (settling) {
        await this.#awaitWrites(record, settling, controller.signal.aborted);
      }

      // `job.fail()` was called: the attempt ends that way however the
      // processor returned.
      if (failedWith) {
        await this.#recordFailure(job, record, failedWith);
        return;
      }

      // Not awaited, deliberately.
      //
      // The job has run; recording that is bookkeeping, and holding the worker
      // on it makes every job cost two serial round trips instead of one. Let
      // go here and the next claim goes out on another pooled connection while
      // this write is still in flight — measured, that is most of the distance
      // to graphile-worker, which does exactly this.
      //
      // `close()` still waits for these through `#settling`, so a clean
      // shutdown never abandons one.
      this.#settle(job, record, result as TResult);
    } catch (error) {
      attemptOver = true;
      // A timeout rejects without waiting for the run — the point of a
      // deadline is not to wait — and a processor that threw may have left a
      // write behind it. Wait for those writes here, and only those: the run
      // itself stays abandoned, its child may be wedged, and none of that is
      // needed to put the values it already reported before the record that
      // says how the job ended.
      const settling = writes.settle();
      if (settling) {
        await this.#awaitWrites(record, settling, controller.signal.aborted);
      }
      // A reason given to `job.fail()` wins over whatever was thrown after it
      // — very often the processor's own way of stopping once it had failed.
      await this.#recordFailure(job, record, failedWith ?? error);
    } finally {
      // The map's timer, not `heartbeat`: a configuration change may have
      // replaced it, and clearing the one this call created would leave the
      // replacement renewing a lock for a job that has finished.
      clearInterval(this.#heartbeats.get(attempt)?.timer ?? heartbeat);
      this.#heartbeats.delete(attempt);
      if (attempt.reserved) {
        attempt.reserved = false;
        this.#limiter?.release(record.name);
      }
    }
  }

  /**
   * Waits for the writes an attempt had in flight when it ended — its
   * progress, its log lines — so they land before the record of how the job
   * ended.
   *
   * Those writes only: never the run, which may have been abandoned for
   * overrunning its deadline and whose child may be wedged.
   *
   * **Always capped**, because a driver that hangs rather than rejects is not
   * a driver that answers late: nothing else in this method would ever end the
   * wait, and a worker waiting here is a concurrency slot not taking jobs.
   * `#persist` is no help — its budget bounds *retries* and rejections, not
   * one `write()` that never settles — and the ending write it guards is not
   * awaited either, so before this barrier existed a hung write cost the job
   * nothing. It must not start costing a slot now.
   *
   * How long, though, turns on how the attempt ended, and the two cases are
   * genuinely not in the same situation:
   *
   * - **It reached its own end** — returned, threw, called `job.fail()`. These
   *   are writes it asked for and, in a processor's own thread, waited for
   *   itself, so the wait is worth making properly: a quarter of
   *   `lockDuration`, exactly the budget {@link #persist} gives the ending
   *   write, and for the same reason — past the lock the job is the stalled
   *   sweep's to recover, so waiting longer than the lock's own budget buys
   *   nothing and costs a slot. It is 7.5 s at the default lock, 25× a chain
   *   of progress writes to a store taking 150 ms each; `WRITE_SETTLE_TIMEOUT`
   *   would not clear that chain, which is why this is not that number — and
   *   it is the floor, so a very short lock cannot take the budget to zero,
   *   which `withTimeout` reads as no budget at all.
   * - **The worker gave up on it** — a deadline, a lost lock, a closing
   *   worker. Nobody is waiting for that run any more and the job is already
   *   dying, so the flat `WRITE_SETTLE_TIMEOUT` applies instead: a dead job
   *   must not sit `active` for seconds waiting on writes nothing will read.
   *
   * Past either cap the ending is recorded anyway and a write still in flight
   * may land after it, exactly as it did before this existed.
   *
   * A job with nothing in flight — the ordinary job — never gets here at all:
   * its caller sees `settle()` answer `undefined` and skips this.
   */
  async #awaitWrites(
    /** The job whose attempt is ending. */
    record: JobRecord,
    /** What `AttemptWrites.settle()` answered: the writes still in flight. */
    pending: Promise<void>,
    /** Whether the worker gave up on the attempt rather than it ending itself. */
    abandoned: boolean,
  ): Promise<void> {
    const budget = abandoned
      ? WRITE_SETTLE_TIMEOUT
      : // Never below the flat cap: an attempt that ended itself should not be
        // given less patience than one the worker abandoned, and `withTimeout`
        // reads a budget of zero as "no timeout at all", which is the one
        // thing this must never be.
        Math.max(WRITE_SETTLE_TIMEOUT, this.#options.lockDuration / 4);

    try {
      await withTimeout(pending, budget, {
        message: `Job ${record.id}'s writes did not land within ${budget}ms of its attempt ending`,
      });
    } catch (error) {
      this.#logger.debug(
        "Recording how a job ended without waiting for its last write",
        { jobId: record.id, error },
      );
    }
  }

  /**
   * Runs a write that records how a job ended, retrying it while it throws.
   *
   * The job has already run, so a write that fails strands it: `active`, under
   * a lock nobody renews, until the stalled sweep takes it back `lockDuration`
   * plus up to `stalledInterval` later — a minute by default — and runs it a
   * second time. Most such failures are the database saying "busy, try again"
   * (a deadlock victim, a lock wait timeout), which a short wait cures.
   *
   * Every write retried here is conditional on this worker's lock token, so a
   * repeat of one that did land, its reply lost, changes nothing and answers
   * `false`. The retries stop at a quarter of the lock duration, so they can
   * never outlive the lock they depend on.
   */
  async #persist<T>(write: () => Promise<T>): Promise<T> {
    /** Attempts in all, the first included. */
    const attempts = 5;
    const giveUpAt = Date.now() + this.#options.lockDuration / 4;

    for (let attempt = 1; ; attempt++) {
      try {
        return await write();
      } catch (error) {
        // Jittered and doubling — up to 50, 100, 200, 400ms — so two workers
        // that lost the same deadlock do not collide again in step.
        const wait = Math.random() * 25 * 2 ** attempt;

        if (attempt >= attempts || Date.now() + wait > giveUpAt) {
          throw error;
        }

        await sleep(wait, { unref: true }).catch(() => {});
      }
    }
  }

  /**
   * Makes a job this worker could not record claimable again as soon as the
   * stalled sweep next runs, rather than a whole lock duration later.
   *
   * Only reached once {@link #persist} has given up, so the database is
   * failing persistently and this may well fail too; that is fine, the lock
   * then lapses on its own. Conditional on the token, like the write it stands
   * in for, so a job whose outcome did land is left alone.
   */
  async #expireLock(record: JobRecord): Promise<void> {
    await this.driver
      .extendJobLock(this.ref, record.id, heldLock(record), 0, Date.now())
      .catch(() => false);
  }

  /**
   * Records a finished job, off the critical path.
   *
   * The write is tracked so `close()` can wait for it. A failure here is not
   * the job failing — it already ran — so it is retried, not turned into a
   * failed attempt; losing the lock means someone else owns the outcome. When
   * the retries run out the error is reported and the job's lock expired, so
   * the next stalled sweep returns it instead of one a lock duration later.
   */
  #settle(job: Job<TData, TResult>, record: JobRecord, result: TResult): void {
    const written = createDeferred<void>();
    const stored = storedResult(result);
    const retention = record.opts.removeOnComplete;
    // A child's record stays until its parent has its result, so a crash
    // between the two can still deliver it; its retention applies after.
    const completionRetention = record.flow?.parent ? false : retention;

    /** Reports the outcome once the write has answered. */
    const settled = (kept: boolean) => {
      if (kept) {
        // Counted only once the write landed: a lost lock means someone else
        // owns the outcome, and counting it here would count it twice.
        this.#metrics.count("completed");
        this.safeEmitScoped("completed", record.name, job, result);
        void this.#publish("completed", {
          id: record.id,
          returnValue: result ?? null,
        });

        if (record.flow?.parent) {
          this.#track(
            this.#deliverSafely(this.queueName, record, {
              completed: true,
              value: stored,
            }),
          );
        }
      } else {
        this.safeEmit("lockLost", job);
      }
    };

    this.#completions.add({
      id: record.id,
      token: heldLock(record),
      result: stored,
      retention: completionRetention,
      settle: (kept) => {
        settled(kept);
        written.resolve();
      },
      // The batched attempt failed. This one job is retried alone: the batch
      // it shared may have failed for a reason that was never its own.
      fail: () => {
        void this.#persist(
          async () =>
            await this.driver.completeJob(
              this.ref,
              record.id,
              heldLock(record),
              stored,
              completionRetention,
              Date.now(),
            ),
        )
          .then(settled)
          .catch(async (error: unknown) => {
            this.#emitError(error, "complete");
            await this.#expireLock(record);
          })
          .finally(() => written.resolve());
      },
    });

    const tracked = written.promise.finally(() => {
      this.#settling.delete(tracked);
    });

    this.#settling.add(tracked);
  }

  /** Keeps `close()` waiting for work started off the critical path. */
  #track(work: Promise<unknown>): void {
    const tracked = work
      .then(() => undefined)
      .finally(() => {
        this.#settling.delete(tracked);
      });
    this.#settling.add(tracked);
  }

  /* --- flows ---------------------------------------------------------------- */

  /**
   * {@link #deliver}, reporting rather than throwing. A delivery that fails is
   * remembered and tried again soon, and on every maintenance pass after that,
   * so a transient error does not wait for a scan to find it.
   */
  async #deliverSafely(
    queue: string,
    record: JobRecord,
    outcome: SettledOutcome,
  ): Promise<ChildRecordResult | undefined> {
    try {
      return await this.#deliver(queue, record, outcome);
    } catch (error) {
      this.#rememberDelivery(queue, record.id);
      this.#emitError(error, "flow");
      return undefined;
    }
  }

  /**
   * Tells a finished child's parent how it ended, then lets the child's own
   * retention apply, then follows through on what that did to the parent: a
   * released parent is announced, a buried one gets the events, dead-lettering
   * and retention a normal bury has, and its failure travels on up the flow.
   *
   * Every step is repeat-safe, so a crash anywhere in here is healed by doing
   * the whole thing again; the parent's record of the outcome is what counts.
   *
   * The child is marked recorded — letting its retention remove it — only once
   * the parent needs nothing more from it. Not while there is no parent yet
   * (a flow is added children first, so a quick child can finish before it),
   * and not when a buried parent refuses a failure: that failed child stays, so
   * a retry of the parent waits on it and it can be retried in turn.
   */
  async #deliver(
    queue: string,
    record: JobRecord,
    outcome: SettledOutcome,
  ): Promise<ChildRecordResult | undefined> {
    const parent = record.flow?.parent;
    if (!parent || !this.driver.recordChild || !this.driver.markChildRecorded) {
      return undefined;
    }

    const child: JobRef = { queue, id: record.id };
    const childRef: QueueRef = { ns: this.namespace, queue };
    const parentRef: QueueRef = { ns: this.namespace, queue: parent.queue };
    const ignored = record.opts.ignoreFailure === true;
    const delivered: ChildOutcome = outcome.completed
      ? outcome
      : {
          completed: false,
          ignored,
          error: ignored
            ? outcome.error
            : serializeError(new ChildFailedError(child, outcome.error)),
        };
    const retention = outcome.completed
      ? record.opts.removeOnComplete
      : record.opts.removeOnFail;

    const result = await this.#persist(
      async () =>
        await this.driver.recordChild!(
          parentRef,
          parent.id,
          child,
          delivered,
          Date.now(),
        ),
    );

    // A repeat of the delivery that buried the parent — its first attempt died
    // before the mark — reads as a refusal, and is told apart by the reason.
    const repeatOfBury =
      result === "parent-dead" &&
      (await this.#wasBuriedBy(parentRef, parent.id, child));

    if (result === "missing") {
      const finishedAt = record.finishedOn ?? Date.now();
      if (Date.now() - finishedAt <= FLOW_MISSING_GRACE_MS) {
        // Most likely a flow still being added: its parent arrives last.
        this.#rememberDelivery(queue, record.id);
        return result;
      }
      // Past the grace period the parent is not coming: an orphan, whose own
      // retention may now apply.
    } else if (result === "parent-dead" && !repeatOfBury) {
      this.#forgetDelivery(queue, record.id);
      return result;
    }

    await this.#persist(
      async () =>
        await this.driver.markChildRecorded!(
          childRef,
          record.id,
          retention,
          Date.now(),
        ),
    );
    this.#forgetDelivery(queue, record.id);

    if (result === "released") {
      await this.#announceReleased(parentRef, parent.id);
    } else if (result === "buried" || repeatOfBury) {
      const error = delivered.completed ? undefined : delivered.error;
      await this.#afterBury(parentRef, parent.id, error, {
        announce: result === "buried",
      });
    }

    return result;
  }

  /**
   * Announces what a job this worker handed out did to itself: `remove()`,
   * `promote()` and `retry()` are published as the queue's own methods
   * publish them — a worker has no local event for any of the three — and a
   * job buried by `fail()` from outside its processor gets the `failed` and
   * `dead` events a job that died here gets.
   */
  async #onJobEvent(event: JobEvent): Promise<void> {
    switch (event.type) {
      case "removed":
      case "promoted":
        await this.#publish(event.type, { id: event.id });
        return;

      case "retried":
        await this.#publish("retried", { ids: [event.id] });
        return;

      case "buried": {
        const { record, error } = event;
        const job = new Job<TData, TResult>(this.driver, this.ref, record);
        const failure = deserializeError(error);
        this.safeEmitScoped("failed", record.name, job, failure);
        this.safeEmitScoped("dead", record.name, job, failure);
        await this.#publish("failed", { id: record.id, error });
        await this.#publish("dead", { id: record.id, error });
      }
    }
  }

  /** Whether a buried parent's reason names `child` as what buried it. */
  async #wasBuriedBy(
    ref: QueueRef,
    id: string,
    child: JobRef,
  ): Promise<boolean> {
    const parent = await this.driver.getJob(ref, id);
    return (
      parent?.state === "dead" &&
      parent.failedReason?.name === ChildFailedError.name &&
      parent.failedReason.data?.child === flowKey(child)
    );
  }

  /** Publishes the state a parent was released to, on the parent's queue. */
  async #announceReleased(ref: QueueRef, id: string): Promise<void> {
    const parent = await this.driver.getJob(ref, id);

    if (parent?.state === "waiting") {
      await this.#publish("waiting", { id }, ref.queue);
    } else if (parent?.state === "delayed") {
      noteScheduled(this.driver, ref);
      await this.#publish("delayed", { id, runAt: parent.runAt }, ref.queue);
    }
  }

  /**
   * Does for a parent a child buried what failing does for any job that dies:
   * `failed` and `dead` events, a dead letter when one is configured, and
   * retention. A nested parent's retention waits for its own parent to record
   * it, like any child's; its failure is delivered there, which carries it on
   * up the flow. A top-level parent applies its `removeOnFail` now.
   */
  async #afterBury(
    ref: QueueRef,
    id: string,
    reason: SerializedError | undefined,
    options: {
      /** Whether to emit and publish `failed` and `dead`; not on a repeat. */
      announce: boolean;
    },
  ): Promise<void> {
    const record = await this.driver.getJob(ref, id);
    if (!record || record.state !== "dead") {
      return;
    }

    const error =
      record.failedReason ??
      reason ??
      serializeError(new Error("buried by a child"));
    // Local listeners hear about jobs in this worker's own queue only; other
    // queues' listeners hear through the published events.
    const own = ref.queue === this.queueName;
    const job = own
      ? new Job<TData, TResult>(this.driver, ref, record)
      : undefined;

    if (options.announce) {
      if (job) {
        const failure = deserializeError(error);
        this.safeEmitScoped("failed", record.name, job, failure);
        this.safeEmitScoped("dead", record.name, job, failure);
      }
      await this.#publish("failed", { id, error }, ref.queue);
      await this.#publish("dead", { id, error }, ref.queue);
    }

    const deadLetter =
      record.opts.deadLetter ?? (own ? this.#deadLetterQueue : undefined);
    if (deadLetter !== undefined) {
      await this.#fileDeadLetter(
        deadLetter,
        ref.queue,
        job,
        record,
        error,
        Date.now(),
      );
    }

    if (record.flow?.parent) {
      await this.#deliver(ref.queue, record, { completed: false, error });
      return;
    }

    await this.#persist(
      async () =>
        await this.driver.markChildRecorded!(
          ref,
          id,
          record.opts.removeOnFail,
          Date.now(),
        ),
    );
  }

  /**
   * Keeps a delivery that did not finish for another try: soon, on a short
   * doubling delay for its first few attempts, and on every maintenance pass
   * until it goes through or the child is gone.
   */
  #rememberDelivery(queue: string, id: string): void {
    const key = flowKey({ queue, id });
    const entry = this.#redeliveries.get(key) ?? { queue, id, attempts: 0 };
    entry.attempts++;
    this.#redeliveries.set(key, entry);

    if (
      this.#closing ||
      entry.timer !== undefined ||
      entry.attempts > FAST_REDELIVERY_ATTEMPTS
    ) {
      return;
    }

    const timer = setTimeout(
      () => {
        this.#timers.delete(timer);
        entry.timer = undefined;
        if (!this.#closing) {
          this.#track(this.#redeliver(key));
        }
      },
      Math.min(FAST_REDELIVERY_BASE_MS * 2 ** (entry.attempts - 1), 5_000),
    );
    timer.unref?.();
    entry.timer = timer;
    this.#timers.add(timer);
  }

  /** Drops a remembered delivery that went through, or no longer applies. */
  #forgetDelivery(queue: string, id: string): void {
    const key = flowKey({ queue, id });
    const entry = this.#redeliveries.get(key);
    if (entry?.timer !== undefined) {
      clearTimeout(entry.timer);
      this.#timers.delete(entry.timer);
    }
    this.#redeliveries.delete(key);
  }

  /** Tries a remembered delivery again, from the child as it is stored now. */
  async #redeliver(key: string): Promise<void> {
    const entry = this.#redeliveries.get(key);
    if (!entry) {
      return;
    }

    const record = await this.driver
      .getJob({ ns: this.namespace, queue: entry.queue }, entry.id)
      .catch(() => undefined);

    if (record === undefined) {
      // The read failed: keep it for the next pass.
      return;
    }

    if (
      !record ||
      !awaitsDelivery(record) ||
      (record.state !== "completed" && record.state !== "dead")
    ) {
      this.#forgetDelivery(entry.queue, entry.id);
      return;
    }

    await this.#deliverSafely(entry.queue, record, settledOutcome(record));
  }

  /**
   * Finishes what a crash, a failed write or an early finish left half done
   * in this queue's flows. Three steps, each bounded and resumed across passes:
   *
   * 1. Deliveries this worker remembers as unfinished, first.
   * 2. Parents here waiting on children: a child that settled without the
   *    parent knowing is delivered again; one that does not exist, once the
   *    parent is older than the grace period, counts as failed.
   * 3. Children here that finished and were never recorded on their parent:
   *    delivered again, or released to their retention once their parent has
   *    been missing past the grace period.
   *
   * Per pass that is at most one page of {@link MAINTENANCE_BATCH} parents,
   * {@link FLOW_HEAL_LOOKUPS} child reads, and one page of finished jobs, plus
   * a delivery for each thing found in need of one.
   */
  async #healFlows(): Promise<void> {
    if (!this.driver.recordChild || !this.driver.markChildRecorded) {
      return;
    }

    await this.#healParents();
    await this.#healChildren();
  }

  /**
   * Delivers again anything this worker recorded as undelivered. Its own work,
   * not the queue's: no other worker has these keys, so it runs on every
   * worker rather than under the sweep lease.
   */
  async #redeliverPending(): Promise<void> {
    if (!this.driver.recordChild || !this.driver.markChildRecorded) {
      return;
    }

    for (const key of [...this.#redeliveries.keys()]) {
      if (this.#closing) {
        return;
      }
      await this.#redeliver(key);
    }
  }

  /**
   * Takes or renews one of the queue's sweep leases, answering whether this
   * worker holds it — so that one worker per queue runs the sweeps that read
   * and repair the queue's shared state, rather than every worker on it
   * running the same pass (C12, item 7).
   *
   * The lease is taken for {@link SWEEP_LEASE_LIFETIMES} times `cadence` —
   * the *taker's* cadence, always, so the bound follows whoever holds it now
   * and tightens as they sweep more often. A holder whose process dies leaves
   * two of its own cadences of lease behind, and the next worker's pass takes
   * it over within one more of that worker's: three cadences in a fleet
   * configured alike (90 seconds for the stalled sweeps at the defaults, three
   * minutes for the minute sweeps). A graceful park or close hands over at
   * once by releasing what it holds. A driver without queue state has no lease
   * and every worker sweeps, exactly as before.
   *
   * A live lease is not the end of it: a worker whose own cadence is
   * materially shorter than the holder's takes it over there and then, so the
   * queue is swept at the shortest `stalledInterval` among its workers rather
   * than at whichever worker won the first race. See
   * {@link SWEEP_LEASE_TAKEOVER_FACTOR} for the threshold and why it settles.
   * It costs no extra driver call: the entry this already reads to find out
   * whether it holds the lease is the one that says whose cadence is on it.
   *
   * The lease is an optimisation, never a correctness mechanism: every sweep
   * under it is idempotent and atomic at the driver, so two holders during a
   * hand-over duplicate work and never corrupt it — which is also why a
   * takeover needs no coordination beyond the compare-and-set below.
   *
   * @param name The reserved queue-state entry holding the lease.
   * @param cadence How often, in milliseconds, this worker runs this sweep.
   */
  async #holdsSweepLease(name: string, cadence: number): Promise<boolean> {
    if (
      typeof this.driver.getQueueState !== "function" ||
      typeof this.driver.setQueueState !== "function"
    ) {
      return true;
    }

    const now = Date.now();
    const entry = await this.driver.getQueueState(this.ref, name);
    const lease = entry?.value as SweepLease | null;

    // Held by someone else and still live. Take it anyway if this worker
    // sweeps materially more often than the holder does; otherwise stand down.
    if (
      lease &&
      lease.holder !== this.id &&
      typeof lease.until === "number" &&
      lease.until > now &&
      !(
        typeof lease.cadence === "number" &&
        lease.cadence > SWEEP_LEASE_TAKEOVER_FACTOR * cadence
      )
    ) {
      this.#sweepLeases.delete(name);
      return false;
    }

    const version = await setReservedState(
      this.driver,
      this.ref,
      name,
      {
        holder: this.id,
        until: now + SWEEP_LEASE_LIFETIMES * cadence,
        cadence,
      },
      entry?.version ?? null,
    );

    // Lost the race to another worker taking it at the same moment.
    if (version === null) {
      this.#sweepLeases.delete(name);
      return false;
    }

    this.#sweepLeases.add(name);
    return true;
  }

  /**
   * Gives up every sweep lease this worker holds, so that a worker being
   * parked or closed hands the queue's sweeps to another straight away rather
   * than leaving them to wait out an expiry.
   *
   * Best effort, and deliberately so: the expiry is what guarantees the
   * hand-over, and a worker that is killed, or whose driver has already gone,
   * simply lets its lease lapse. It only ever clears a lease still recorded
   * against itself, never one another worker has since taken over.
   */
  async #releaseSweepLeases(): Promise<void> {
    const held = [...this.#sweepLeases];
    this.#sweepLeases.clear();

    if (
      held.length === 0 ||
      typeof this.driver.getQueueState !== "function" ||
      typeof this.driver.setQueueState !== "function"
    ) {
      return;
    }

    for (const name of held) {
      try {
        const entry = await this.driver.getQueueState(this.ref, name);
        const lease = entry?.value as SweepLease | null;

        if (!entry || lease?.holder !== this.id) {
          continue;
        }

        await setReservedState(
          this.driver,
          this.ref,
          name,
          null,
          entry.version,
        );
      } catch {
        // Left to lapse: a lease nobody can clear still expires.
      }
    }
  }

  /**
   * The sweep leases this worker currently holds, so parking or closing it can
   * hand them over rather than leaving the queue's sweeps to wait out an
   * expiry. Empty on a driver without queue state, which has no leases.
   */
  readonly #sweepLeases = new Set<string>();

  /**
   * Whether this worker holds `name` according to what its last pass recorded
   * — no driver read, so it is free to ask. True on a driver without queue
   * state, where there is no lease and every worker sweeps.
   *
   * @param name The reserved queue-state entry holding the lease.
   */
  #holdsRecordedSweepLease(name: string): boolean {
    return (
      this.#sweepLeases.has(name) ||
      typeof this.driver.getQueueState !== "function" ||
      typeof this.driver.setQueueState !== "function"
    );
  }

  /** Step 2 of {@link #healFlows}: parents waiting on children. */
  async #healParents(): Promise<void> {
    const cursor = this.#parentsCursor;
    const parents = await this.driver.listJobs(this.ref, ["waiting-children"], {
      offset: cursor.offset,
      limit: MAINTENANCE_BATCH,
      order: "asc",
    });

    // Past the end: the next pass starts again from the first parent.
    this.#parentsCursor =
      parents.length < MAINTENANCE_BATCH
        ? { offset: 0, child: 0 }
        : { offset: cursor.offset + parents.length, child: 0 };

    let lookups = FLOW_HEAL_LOOKUPS;

    for (const [index, parent] of parents.entries()) {
      const flow = parent.flow;
      if (!flow) {
        continue;
      }

      const from = index === 0 ? cursor.child : 0;

      for (let at = from; at < flow.children.length; at++) {
        if (this.#closing) {
          return;
        }

        const child = flow.children[at]!;
        const key = flowKey(child);
        if (
          Object.hasOwn(flow.values, key) ||
          Object.hasOwn(flow.failures, key)
        ) {
          continue;
        }

        if (lookups-- <= 0) {
          // Out of reads for this pass: resume at this very child next time.
          this.#parentsCursor = { offset: cursor.offset + index, child: at };
          return;
        }

        const buried = await this.#healChild(parent, child);
        if (buried) {
          break;
        }
      }
    }
  }

  /**
   * Looks at one unsettled child of a waiting parent, and delivers what it
   * finds. Answers whether the parent is now buried.
   */
  async #healChild(parent: JobRecord, child: JobRef): Promise<boolean> {
    const stored = await this.driver.getJob(
      { ns: this.namespace, queue: child.queue },
      child.id,
    );
    const ours =
      stored?.flow?.parent?.queue === this.queueName &&
      stored.flow.parent.id === parent.id;

    if (stored && ours) {
      if (stored.state === "completed") {
        return (
          (await this.#deliverSafely(
            child.queue,
            stored,
            settledOutcome(stored),
          )) === "buried"
        );
      }

      if (stored.state !== "dead") {
        return false;
      }

      // A failure already delivered once buried this parent, which has been
      // retried since: it waits for the child to be retried too, rather than
      // being buried again by the failure it was retried past.
      if (stored.opts.ignoreFailure !== true && stored.flow?.recorded) {
        return false;
      }

      return (
        (await this.#deliverSafely(
          child.queue,
          stored,
          settledOutcome(stored),
        )) === "buried"
      );
    }

    // Absent, or a job of the same id that is not this parent's child.
    if (Date.now() - parent.createdAt <= FLOW_MISSING_GRACE_MS) {
      return false;
    }

    const error = serializeError(
      new ChildFailedError(
        child,
        serializeError(
          new Error(
            "the child does not exist: it was never added, or was removed",
          ),
        ),
      ),
    );
    const result = await this.driver.recordChild!(
      this.ref,
      parent.id,
      child,
      { completed: false, error, ignored: false },
      Date.now(),
    );

    if (result !== "buried") {
      return false;
    }

    await this.#afterBury(this.ref, parent.id, error, { announce: true });
    return true;
  }

  /** Step 3 of {@link #healFlows}: finished children never recorded. */
  async #healChildren(): Promise<void> {
    const cursor = this.#childrenCursor;
    const page = await this.driver.listJobs(this.ref, [cursor.state], {
      offset: cursor.offset,
      limit: MAINTENANCE_BATCH,
      order: "asc",
    });

    this.#childrenCursor =
      page.length < MAINTENANCE_BATCH
        ? {
            state: cursor.state === "completed" ? "dead" : "completed",
            offset: 0,
          }
        : { state: cursor.state, offset: cursor.offset + page.length };

    for (const record of page) {
      if (this.#closing) {
        return;
      }

      if (awaitsDelivery(record)) {
        await this.#deliverSafely(
          this.queueName,
          record,
          settledOutcome(record),
        );
      }
    }
  }

  /** Decides whether a failed attempt is retried, and tells the driver. */
  async #recordFailure(
    job: Job<TData, TResult>,
    record: JobRecord,
    error: unknown,
  ): Promise<void> {
    if (error instanceof LockLostError) {
      // Nothing to write: whoever recovered the job owns it now.
      this.safeEmit("lockLost", job);
      return;
    }

    const failure =
      error instanceof Error ? error : deserializeError(serializeError(error));
    const serialized = serializeError(
      failure instanceof Error && failure.name === "TimeoutError"
        ? new JobTimeoutError(record.opts.timeout, { jobId: record.id })
        : failure,
    );

    const attempt = record.attemptsMade;
    const retryable =
      attempt < record.maxAttempts &&
      // By name too: an error from a worker-thread, child-process or custom
      // target is rebuilt from a serialized form, and is no longer an instance
      // of the class.
      !(
        error instanceof UnrecoverableJobError ||
        (error instanceof Error && error.name === "UnrecoverableJobError")
      );
    // `false` when the job's own strategy says to stop, attempts left or not.
    const delay = retryable
      ? nextBackoff(
          attempt,
          record,
          failure,
          this.#backoffs,
          (message, fields) => this.#logger.warn(message, fields),
        )
      : false;

    const now = Date.now();

    // Retried like a completion, for the same reason: see `#persist`. The
    // write checks the lock token and the job's state itself, so a repeat of
    // one that landed changes nothing.
    try {
      if (delay !== false) {
        const runAt = now + delay;
        const written = await this.#persist(
          async () =>
            await this.driver.failJob(
              this.ref,
              record.id,
              heldLock(record),
              serialized,
              { retry: true, runAt },
              now,
              record.opts.keepStacktraces,
            ),
        );

        // The retry is scheduled now, possibly before whatever this worker
        // last heard was due next: its empty passes must promote again.
        noteScheduled(this.driver, this.ref);

        if (!written && !(await this.#failureLanded(record, serialized))) {
          this.safeEmit("lockLost", job);
          return;
        }

        this.#metrics.count("failed");
        this.safeEmitScoped("failed", record.name, job, failure);
        this.safeEmitScoped("retrying", record.name, job, failure, runAt);
        void this.#publish("failed", { id: record.id, error: serialized });
        void this.#publish("retrying", {
          id: record.id,
          error: serialized,
          runAt,
        });
        return;
      }

      const written = await this.#persist(
        async () =>
          await this.driver.failJob(
            this.ref,
            record.id,
            heldLock(record),
            serialized,
            {
              retry: false,
              retention: record.flow?.parent ? false : record.opts.removeOnFail,
            },
            now,
            record.opts.keepStacktraces,
          ),
      );

      // Refused, and not because an earlier try of this very write landed:
      // the job is someone else's now — most often buried from outside by
      // `Job.fail()`, which announced `failed` and `dead` itself. Saying so
      // again would deliver both twice; nor is its letter or its parent this
      // worker's to see to.
      if (!written && !(await this.#failureLanded(record, serialized))) {
        this.safeEmit("lockLost", job);
        return;
      }

      this.#metrics.count("failed");
      this.safeEmitScoped("failed", record.name, job, failure);
      this.safeEmitScoped("dead", record.name, job, failure);
      void this.#publish("failed", { id: record.id, error: serialized });
      void this.#publish("dead", { id: record.id, error: serialized });
    } catch (writeError) {
      this.#emitError(writeError, "failJob");
      await this.#expireLock(record);
      return;
    }

    if (record.flow?.parent) {
      await this.#deliverSafely(this.queueName, record, {
        completed: false,
        error: serialized,
      });
    }

    const deadLetter = record.opts.deadLetter ?? this.#deadLetterQueue;

    if (deadLetter !== undefined) {
      await this.#fileDeadLetter(
        deadLetter,
        this.queueName,
        job,
        record,
        serialized,
        now,
      );
    }
  }

  /**
   * Whether a failure write this worker saw refused had in fact landed: an
   * earlier try whose reply was lost wrote it, and the retry that followed
   * found the lock already released. Told apart from a job someone else
   * settled — buried from outside, recovered as stalled — by reading the job
   * back: ours is `failed` or `dead` with exactly the failure this worker
   * wrote.
   *
   * A job that is gone reads as ours: retention may have removed it the
   * moment our write landed, and reporting a failure that happened beats
   * losing it.
   */
  async #failureLanded(
    record: JobRecord,
    written: SerializedError,
  ): Promise<boolean> {
    const now = await this.driver
      .getJob(this.ref, record.id)
      .catch(() => undefined);

    if (now === undefined || now === null) {
      return true;
    }

    return (
      (now.state === "failed" || now.state === "dead") &&
      sameError(now.failedReason, written)
    );
  }

  /**
   * Adds a copy of a dead job to its dead-letter queue, through the shared
   * {@link addDeadLetter}, reporting rather than throwing.
   *
   * `source` is the queue the dead job is in: this worker's, or another's for
   * a flow parent a child here buried. `job` is the view local listeners get,
   * and is left out for a job in another queue, which they do not hear about.
   */
  async #fileDeadLetter(
    queueName: string,
    source: string,
    job: Job<TData, TResult> | undefined,
    record: JobRecord,
    error: SerializedError,
    now: number,
  ): Promise<void> {
    const refused = selfLetterError(queueName, source, record);
    if (refused) {
      this.#emitError(refused, "deadLetter");
      return;
    }

    try {
      let queue = this.#deadLetters.get(queueName);

      if (!queue) {
        queue = new BunQueue<DeadLetter, unknown, string>(queueName, {
          namespace: this.namespace,
          driver: this.driver,
          logger: this.#logger,
        });
        this.#deadLetters.set(queueName, queue);
      }

      const letter = await addDeadLetter(queue, source, record, error, now);

      if (job) {
        this.safeEmitScoped(
          "deadLettered",
          record.name,
          job,
          letter as Job<DeadLetter<TData>, unknown>,
        );
      }
    } catch (letterError) {
      this.#emitError(letterError, "deadLetter");
    }
  }

  /** Renews a job's lock; losing it aborts the attempt. */
  async #heartbeat(
    record: JobRecord,
    controller: AbortController,
  ): Promise<void> {
    // An aborted job has been given up on — timed out, or its worker closed.
    // Renewing its lock would keep it from ever being recovered.
    if (controller.signal.aborted) {
      return;
    }

    try {
      const held = await this.driver.extendJobLock(
        this.ref,
        record.id,
        heldLock(record),
        this.#options.lockDuration,
        Date.now(),
      );

      if (!held) {
        this.safeEmit(
          "lockLost",
          new Job<TData, TResult>(this.driver, this.ref, record),
        );
        controller.abort();
      }
    } catch (error) {
      this.#emitError(error, "heartbeat");
    }
  }

  /* --- repeats -------------------------------------------------------------- */

  /**
   * Schedules the occurrence after `record`.
   *
   * Deliberately unguarded by any lock: the next occurrence's id is derived
   * from the series and its due time, so several workers doing this at once
   * converge on the same job instead of creating duplicates.
   */
  async #scheduleNextRepeat(record: JobRecord): Promise<void> {
    if (!record.repeatKey) {
      return;
    }

    try {
      const definition = await this.driver.getRepeat(
        this.ref,
        record.repeatKey,
      );
      if (!definition) {
        // The series was removed while this occurrence was queued.
        return;
      }

      // Disabled: this occurrence runs — it was claimed before anyone could
      // stop it — but it schedules nothing after it.
      if (await this.#repeatDisabled(definition.key)) {
        return;
      }

      const count = definition.count + 1;
      const now = Date.now();
      const scheduled = { ...definition, count };

      let next = nextOccurrence(scheduled, record.runAt);

      // A series that fell behind while nothing was consuming has a choice,
      // and `catchUp` is it. Off — the default — it skips to the next real
      // occurrence: an hourly job that was down for a day should run once when
      // it comes back, not twenty-four times at once, and for most series the
      // missed runs have been overtaken by events anyway.
      //
      // On, the occurrence it just computed stands even though it is already
      // due, so the backlog is replayed one occurrence per completion until
      // the series catches up with the clock. That is what a caller wants when
      // each run does a bounded piece of work that still needs doing — billing
      // a period, rolling a report — rather than reporting a current state.
      if (next !== null && next <= now && !scheduled.catchUp) {
        next = nextOccurrence(scheduled, now);
      }

      if (next === null) {
        await this.driver.upsertRepeat(this.ref, {
          ...scheduled,
          nextRunAt: null,
          nextJobId: null,
          updatedAt: now,
        });
        return;
      }

      const jobId = shortenJobId(
        repeatJobId(displayRepeatKey(definition.key), next),
      );
      await this.driver.addJob(this.ref, {
        ...record,
        ...(await this.#occurrenceOptions(definition, record)),
        id: jobId,
        state: next > now ? "delayed" : "waiting",
        runAt: next,
        createdAt: now,
        processedOn: null,
        finishedOn: null,
        expiresAt: null,
        attemptsMade: 0,
        stalledCount: 0,
        progress: null,
        returnValue: null,
        failedReason: null,
        stacktrace: [],
        lockToken: null,
        lockExpiresAt: null,
        workerId: null,
        // A new occurrence, in no flow, whatever the finished one belonged to.
        flow: null,
      });
      if (next > now) {
        noteScheduled(this.driver, this.ref);
      }

      await this.driver.upsertRepeat(this.ref, {
        ...scheduled,
        nextRunAt: next,
        nextJobId: jobId,
        updatedAt: now,
      });
    } catch (error) {
      this.#emitError(error, "scheduleNextRepeat");
    }
  }

  /**
   * The options of a repeat series' next occurrence: the series' own (the
   * code's layers and its explicit mask, as `add()` stored them) with the
   * queue's stored job defaults over every key its `add()` did not pass — so
   * a saved override reaches every future occurrence within
   * `jobDefaultsRefreshInterval`, and a reset takes effect on the next one.
   *
   * A series stored before the mask existed has nothing to say which of its
   * options were explicit, so it keeps what `previous` (the finished
   * occurrence, or the series' own record) carries, exactly as before. A
   * failed read of the stored defaults is reported and the occurrence built
   * without them, rather than not scheduled at all.
   */
  async #occurrenceOptions(
    definition: RepeatRecord,
    previous: JobRecord,
  ): Promise<Pick<JobRecord, "opts" | "priority" | "maxAttempts">> {
    const own = definition.opts as StoredJobOptions;

    if (typeof own.explicit !== "number") {
      return {
        opts: previous.opts,
        priority: previous.priority,
        maxAttempts: previous.maxAttempts,
      };
    }

    const override = await this.#jobDefaults.get().catch((error: unknown) => {
      this.#emitError(error, "jobDefaults");
      return {};
    });
    const opts = overlayJobDefaults(own, override);

    return { opts, priority: opts.priority, maxAttempts: opts.attempts };
  }

  /**
   * Whether the series stored as `key` is disabled.
   *
   * Every claimed occurrence asks, and a busy series should not cost a read
   * per job to answer a question whose answer changes by hand, so an
   * enabled* answer is trusted for {@link REPEAT_FLAG_CACHE_MS}. A series
   * disabled in that window gets at most one more occurrence, which the next
   * maintenance pass removes.
   *
   * A *disabled* answer is never cached. Trusting it would outlive an
   * `enable()`: the occurrence `enable()` scheduled would then schedule
   * nothing after it, and the series would stop for good.
   */
  async #repeatDisabled(key: string): Promise<boolean> {
    const now = Date.now();
    const enabledAt = this.#enabledRepeats.get(key);

    if (enabledAt !== undefined && now - enabledAt < REPEAT_FLAG_CACHE_MS) {
      return false;
    }

    const disabled = await isRepeatDisabled(this.driver, this.ref, key);

    if (disabled) {
      this.#enabledRepeats.delete(key);
    } else {
      // Bounded: a queue with many series forgets the lot rather than growing.
      if (this.#enabledRepeats.size >= 1_000) {
        this.#enabledRepeats.clear();
      }
      this.#enabledRepeats.set(key, now);
    }

    return disabled;
  }

  /* --- remote control ---------------------------------------------------------- */

  /**
   * Reads what has been asked of this worker and does it, now.
   *
   * The same pass the subscription, the control poll and the heartbeat all
   * run, exposed so a controller in this process can save its own worker the
   * round trip — and so a test can be deterministic instead of waiting out an
   * interval. Resolves once the instruction has been *accepted*; a stop, which
   * drains, goes on in the background.
   */
  async syncControl(): Promise<void> {
    await this.#adoptControl();
  }

  /**
   * Starts listening for instructions: a subscription where the driver pushes
   * events, a short poll where it does not, and in both cases the heartbeat
   * as the fallback that makes a lost event cost at most one report interval.
   */
  #armControl(): void {
    if (!this.#controlEnabled() || this.#closing) {
      return;
    }

    if (this.#controlOptions.subscribe) {
      void this.#subscribeControl();
      return;
    }

    this.#controlUnwatch = watchWorkerChanges(
      this.driver,
      this.ref,
      this.#controlOptions.interval,
      () => {
        if (!this.#closing) {
          void this.#adoptControl();
        }
      },
    );
  }

  /**
   * Follows the queue's worker channel.
   *
   * One subscription per queue per process would be ideal and this is one per
   * worker; that is the cost of a worker owning its own control, and a
   * process rarely runs many workers on one queue. The event is only a hint —
   * every one of them re-reads the stored entries — so a missed or duplicated
   * delivery costs nothing but latency.
   */
  async #subscribeControl(): Promise<void> {
    try {
      const unsubscribe = await this.driver.subscribe(
        this.namespace,
        "worker",
        this.queueName,
        (event) => {
          if (event.type !== "control" || this.#closing) {
            return;
          }

          const { worker, key } = event.payload;

          // Addressed to one incarnation, to one stable key, or to the whole
          // queue. Anything else on this channel is another worker's news.
          if (
            worker !== undefined
              ? worker !== this.id
              : key !== undefined && key !== this.key
          ) {
            return;
          }

          void this.#adoptControl();
        },
      );

      if (this.#closing) {
        await unsubscribe();
        return;
      }

      this.#controlUnsubscribe = unsubscribe;
    } catch (error) {
      this.#emitError(error, "control");
    }
  }

  /**
   * Reads what has been asked of this worker and does it — chained, so an
   * instruction arriving mid-apply is coalesced into "apply the latest"
   * rather than replayed as a sequence of stale steps.
   */
  async #adoptControl(options?: {
    /** The first pass, at `run()`: a persistent stop is honoured here. */
    initial?: boolean;
  }): Promise<void> {
    if (!this.#controlEnabled()) {
      return;
    }

    const previous = this.#controlChain;
    const adopting = (async () => {
      await previous.catch(() => undefined);

      if (this.#closing) {
        return;
      }

      this.#adopting = true;
      try {
        await this.#adoptOnce(options?.initial === true);
      } catch (error) {
        this.#emitError(error, "control");
      } finally {
        this.#adopting = false;
      }
    })();

    this.#controlChain = adopting;
    await adopting;
  }

  /** One pass of {@link BunQueueWorker.#adoptControl}. */
  async #adoptOnce(initial: boolean): Promise<void> {
    let changed = false;

    // A stop recorded against the stable key, read once at startup. It is
    // written and cleared by the worker itself when it applies a stop or a
    // start, so nothing else has to know how this worker is configured.
    if (initial && this.#honoursKeyStop) {
      const stopped = await readWorkerStop(this.driver, this.ref, this.key);

      if (stopped) {
        this.#setPhase("stopped", "stopped persistently");
        this.#disarmMaintenance();
        void this.#releaseSweepLeases();
        changed = true;
      }
    }

    const stored = await readWorkerConfig(this.driver, this.ref, this.key);
    const seq = stored?.seq ?? 0;

    if (seq !== this.#configSeq || (initial && seq > 0)) {
      this.#applyOverride(stored?.value.values ?? {}, seq, stored?.value.at);
      changed = true;
    }

    const instruction = await readWorkerControl(this.driver, this.ref, this.id);

    if (instruction) {
      if (instruction.value.incarnation !== this.processStartedAt) {
        // Written to the process this one replaced. Lifecycle intent never
        // survives a restart — a deploy must come back running — so it goes,
        // conditionally on the version, in case a controller wrote a real one
        // between the read and here.
        await removeWorkerControl(
          this.driver,
          this.ref,
          this.id,
          instruction.seq,
        );
      } else if (instruction.seq !== this.#appliedSeq) {
        // A stop with nothing to drain finishes in a moment, so it is
        // acknowledged only once it has: the records written on the way say
        // `stopping` under the old `appliedSeq`, and the acknowledgement a
        // `?wait=` caller reads says `stopped`, not pending (B18). A stop that
        // drains is acknowledged at once, as `stopping`, as it always was.
        const idleStop =
          instruction.value.state === "stopped" && this.#active.size === 0;
        if (!idleStop) {
          this.#appliedSeq = instruction.seq;
        }
        // Part of it was unusable — a nonsense stop timeout, say. The
        // instruction is still obeyed, and the reason is reported rather
        // than swallowed, so a caller can see that what they sent did not
        // arrive whole.
        this.#controlError =
          instruction.issue === undefined
            ? this.#controlError
            : {
                at: Date.now(),
                message: instruction.issue,
                action:
                  instruction.value.state === "stopped" ? "stop" : "start",
                seq: instruction.seq,
              };
        const settling = this.#applyDesired(instruction.value);
        if (idleStop) {
          await settling;
          this.#appliedSeq = instruction.seq;
        }
        changed = true;
      }
    }

    if (changed) {
      await this.#report();
    }
  }

  /**
   * Does what an instruction asks.
   *
   * A stop is started rather than awaited, deliberately: draining can take as
   * long as the longest job in flight, and the chain has to stay free to
   * receive the `start` that calls it off. Its promise is returned (never
   * rejecting) so a caller that knows there is nothing to drain may await it.
   */
  #applyDesired(instruction: WorkerControlEntry): Promise<void> | undefined {
    const persist =
      this.#stopPersistenceOverridable && instruction.persist !== undefined
        ? instruction.persist
        : this.#stopPersistence;

    switch (instruction.state) {
      case "stopped":
        if (persist === "key") {
          void writeWorkerStop(this.driver, this.ref, this.key, true).catch(
            (error: unknown) => this.#emitError(error, "control"),
          );
        }
        return this.stop({
          reason: "stopped remotely",
          // Absent — including when the stored one was refused — means wait
          // for the jobs in flight rather than abandon them.
          ...(instruction.timeout === undefined
            ? {}
            : { timeout: instruction.timeout }),
        }).catch((error: unknown) => this.#emitError(error, "control"));

      case "paused":
        this.start();
        void this.pause().catch((error: unknown) =>
          this.#emitError(error, "control"),
        );
        return;

      default:
        // Whatever this instruction's own `persist`: a worker that can hold
        // a key stop clears it on any start, or the next replacement would
        // come up stopped again after a deliberate start (B14).
        if (persist === "key" || this.#honoursKeyStop) {
          this.#clearKeyStop();
        }
        this.start();
    }
  }

  /**
   * Whether this worker obeys a stop recorded against its key at startup:
   * one configured with `stopPersistence: "key"`, or one whose
   * `stopPersistenceOverridable` lets a single instruction ask for it. A
   * non-overridable `"process"` worker never does — the process, not the
   * caller, decides whether a stop outlives it (B14).
   */
  get #honoursKeyStop(): boolean {
    return this.#stopPersistence === "key" || this.#stopPersistenceOverridable;
  }

  /** Removes the stop recorded against this worker's key, if any; never throws. */
  #clearKeyStop(): void {
    void writeWorkerStop(this.driver, this.ref, this.key, false).catch(
      (error: unknown) => this.#emitError(error, "control"),
    );
  }

  /**
   * Adopts a stored override: merges it over what the code asked for, drops
   * any field it cannot accept, and applies the result in place.
   *
   * A field that is out of bounds — or a pair that cannot hold together after
   * a code change moved the other half — is dropped one at a time rather than
   * refused wholesale. The worker keeps its own value for that field, says so
   * in `control.lastError` and in the `config` event, and goes on running:
   * an override written months ago must never be able to stop a deployment.
   */
  #applyOverride(
    values: WorkerConfigPatch,
    seq: number,
    updatedAt: number | undefined,
  ): void {
    this.#configSeq = seq;
    this.#configUpdatedAt =
      updatedAt === undefined || updatedAt === 0 ? undefined : updatedAt;

    const merged: WorkerConfigValues = { ...this.#codeConfig };
    const accepted: WorkerConfigPatch = {};
    let refusal: string | undefined;

    for (const key of WORKER_CONFIG_KEYS) {
      const value = values[key];

      if (value === undefined) {
        continue;
      }

      const issue = workerConfigIssue(key, value);

      if (issue === null) {
        merged[key] = value;
        accepted[key] = value;
      } else {
        refusal ??= issue;
      }
    }

    // The one rule that spans two fields. Whichever half is overridden gives
    // way to the code's value, because the code's pair was consistent when
    // the worker started.
    for (const key of ["heartbeatInterval", "lockDuration"] as const) {
      const cross = workerConfigCrossFieldIssue(merged);

      if (cross === null) {
        break;
      }

      refusal ??= cross.message;

      if (accepted[key] !== undefined) {
        delete accepted[key];
        merged[key] = this.#codeConfig[key];
      }
    }

    this.#override = accepted;
    this.#controlError =
      refusal === undefined
        ? undefined
        : { at: Date.now(), message: refusal, action: "config", seq };

    this.#applyValues(merged);
    this.#publishWorker("config", {
      worker: this.id,
      key: this.key,
      seq,
      overridden: WORKER_CONFIG_KEYS.filter(
        (key) => accepted[key] !== undefined,
      ),
      ...(refusal === undefined ? {} : { error: refusal }),
    });
  }

  /**
   * Puts a set of settings into force on a running worker, without dropping a
   * claim or a job.
   *
   * Every one of the nine can be applied in place, which is why there is no
   * drain-and-rebuild here: on a queue with ten-minute jobs, restarting to
   * change `concurrency` would stop claiming for ten minutes on every replica
   * at once. The subtle one is the pair of lock settings — a lock renewed at
   * the old cadence can lapse under a shortened duration, and the stalled
   * sweep would then run a job that is still running — so every renewal in
   * flight is re-armed *and* renewed immediately at the new duration.
   */
  #applyValues(next: WorkerConfigValues): void {
    const before = this.#liveConfig();
    const running = this.#phase === "running";

    if (running) {
      this.#setPhase("restarting");
    }

    this.#concurrency = next.concurrency;

    if (next.pollInterval !== before.pollInterval) {
      this.#options.pollInterval = next.pollInterval;

      if (
        promotionCadence(next.pollInterval) !==
        promotionCadence(before.pollInterval)
      ) {
        this.#armPromotion();
      }
    }

    this.#options.maxBlock = next.maxBlock;

    if (next.lockDuration !== before.lockDuration) {
      this.#options.lockDuration = next.lockDuration;
      this.#limiter?.setLeaseMs(next.lockDuration);
    }

    this.#options.heartbeatInterval = next.heartbeatInterval;

    if (
      next.lockDuration !== before.lockDuration ||
      next.heartbeatInterval !== before.heartbeatInterval
    ) {
      this.#rearmJobHeartbeats();
    }

    // Read live by the sweep and by `#announceDrained`, so setting them is
    // all there is to do.
    this.#options.maxStalledCount = next.maxStalledCount;
    this.#options.drainDelay = next.drainDelay;

    if (next.stalledInterval !== before.stalledInterval) {
      this.#options.stalledInterval = next.stalledInterval;

      if (this.#passesArmed) {
        this.#disarmMaintenance();
        this.#armMaintenance();
      }
    }

    if (next.reportInterval !== before.reportInterval) {
      this.#reportInterval = next.reportInterval;

      if (this.#reportTimer) {
        clearInterval(this.#reportTimer);
        this.#reportTimer = undefined;
      }

      this.#armReports();
    }

    if (running) {
      this.#setPhase("running");
    }

    this.#wake.abort();
  }

  /**
   * Re-arms every running job's lock renewal at the current cadence, and
   * renews each one now.
   *
   * The immediate renewal is the half that matters: a timer re-armed for
   * later still leaves the lock at its old expiry, and a shortened
   * `lockDuration` can pass before the new timer's first tick.
   */
  #rearmJobHeartbeats(): void {
    for (const [attempt, running] of this.#heartbeats) {
      clearInterval(running.timer);

      const timer = setInterval(() => {
        void this.#heartbeat(running.record, running.controller);
      }, this.#options.heartbeatInterval);
      timer.unref?.();
      this.#heartbeats.set(attempt, { ...running, timer });

      void this.#heartbeat(running.record, running.controller);
    }
  }

  /**
   * Announces something about this worker to other processes, when the worker
   * publishes at all. Tracked like a job event, so `close()` waits for it.
   */
  #publishWorker<Name extends WorkerEventName>(
    type: Name,
    payload: WorkerEventPayloads[Name],
  ): void {
    if (!this.#publishes) {
      return;
    }

    const publishing = (async () => {
      await this.#publishGate?.();

      try {
        await this.driver.publish(
          workerEvent(
            {
              ns: this.namespace,
              target: this.queueName,
              type,
              origin: this.#origin,
            },
            payload,
          ),
        );
      } catch (error) {
        this.#logger.warn("Could not publish a worker event", { error, type });
      }
    })().finally(() => {
      this.#publishing.delete(publishing);
    });

    this.#publishing.add(publishing);
  }

  /* --- worker inventory ------------------------------------------------------- */

  /** Writes the heartbeat record on the report interval, while the worker runs. */
  #armReports(): void {
    if (this.#reportInterval === 0 || this.#reportTimer) {
      return;
    }

    this.#reportTimer = setInterval(() => {
      void this.#report();
    }, this.#reportInterval);
    this.#reportTimer.unref?.();
  }

  /**
   * Writes this worker's heartbeat record: who it is, how busy, and until when
   * the record stands. Never throws — a failed write is reported as an error
   * and the next interval writes again.
   *
   * Writes are chained rather than overlapping, and nothing is written once
   * the worker has begun closing.
   */
  async #report(): Promise<void> {
    if (
      !this.#running ||
      this.#closing ||
      this.#reportInterval === 0 ||
      !supportsWorkers(this.driver)
    ) {
      return;
    }

    this.#reported = true;
    const previous = this.#reporting;
    const write = (async () => {
      await previous;

      if (this.#closing) {
        return;
      }

      const now = Date.now();

      if (!this.#checkedDuplicateId) {
        this.#checkedDuplicateId = true;
        await this.#detectDuplicateId(now);
      }

      const active = this.#active.size;
      const concurrency = this.#concurrency;
      // Two samples that cost the report no driver call of its own: the
      // process's resident memory (one reading, once per interval — never per
      // job), and how long the *previous* write took. A write cannot time
      // itself, so the record carries the last sample rather than this one.
      const rssBytes = processRss();
      const heartbeatRttMs = this.#reportRttMs;
      const startedWrite = performance.now();

      try {
        await registerWorkerRecord(this.driver, this.ref, {
          id: this.id,
          key: this.key,
          ...(this.service === undefined ? {} : { service: this.service }),
          queue: this.queueName,
          host: HOST,
          pid: process.pid,
          concurrency,
          active,
          paused: this.#paused,
          state: this.state,
          startedAt: this.#startedAt,
          processStartedAt: this.processStartedAt,
          heartbeatAt: now,
          expiresAt: now + this.#reportInterval * REPORT_LIFETIMES,
          version: JOBS_VERSION,
          completed: this.#metrics.completed,
          failed: this.#metrics.failed,
          ...(rssBytes === undefined ? {} : { rssBytes }),
          ...(heartbeatRttMs === undefined ? {} : { heartbeatRttMs }),
          // The very condition `#armMaintenance` branches on, so the record
          // cannot disagree with what the worker arms. Always written, so
          // absent means "a worker too old to say" and never "does not
          // sweep" — and it is the housekeeping half only: this worker keeps
          // the queue live either way.
          sweeps: this.#sweeps,
          // The same rule: derived from the target the worker dispatches to,
          // and always written, so absent means "a worker too old to say" —
          // never "in-process".
          target: this.#targetInfo,
          // Only when the worker was summoned: absent means "not summoned, or
          // too old to say", and is never defaulted.
          ...(this.#summon === undefined ? {} : { summon: this.#summon }),
          config: this.config,
          control: this.control,
        });
        // Only a write that landed: a failure leaves the last good round trip
        // in place rather than reporting how long the failure took.
        this.#reportRttMs = performance.now() - startedWrite;
        // The busyness sample rides the heartbeat — this tick, the values the
        // record just carried — so it costs no timer of its own: a second
        // timer would have an idle worker writing forever. Only after a
        // report that landed, so a sample always means the worker reported.
        this.#metrics.sample({ active, concurrency }, now);
      } catch (error) {
        this.#emitError(error, "report");
      }

      // The always-on fallback. A subscription that failed, an event a
      // transport dropped, a poll driver with no subscription at all: every
      // one of them converges here, within one report interval.
      if (this.#controlEnabled() && !this.#adopting) {
        void this.#adoptControl();
      }
    })();

    this.#reporting = write;
    await write;

    if (this.#reporting === write) {
      this.#reporting = undefined;
    }
  }

  /**
   * Looks, once, for another live worker registered under this worker's id.
   *
   * Sharing an id is already a latent corruption — the id names the heartbeat
   * record, the lock token and the limiter's lease holder — and the derived
   * id makes it impossible by accident. It is still possible on purpose, by
   * passing the same explicit `id` twice, so the first report says so rather
   * than letting two workers quietly overwrite each other's records.
   *
   * A failure here is swallowed: the report that follows reports it properly,
   * and a check that cannot run must not stop a worker from starting.
   */
  async #detectDuplicateId(now: number): Promise<void> {
    try {
      const others = await listWorkerRecords(this.driver, this.ref, now);
      const clash = others.find(
        (worker) =>
          worker.id === this.id &&
          (worker.host !== HOST ||
            worker.pid !== process.pid ||
            (worker.processStartedAt ?? this.processStartedAt) !==
              this.processStartedAt),
      );

      if (!clash) {
        return;
      }

      const message = `another live worker is registered as "${this.id}" (${clash.host}:${clash.pid}); two workers sharing an id corrupt job locks and concurrency limits`;
      this.#controlError = { at: now, message };
      this.#emitError(
        new ConfigError(message, {
          id: this.id,
          host: clash.host,
          pid: clash.pid,
        }),
        "duplicate-id",
      );
    } catch {
      // The write that follows reports a backend that cannot be read.
    }
  }

  /**
   * Removes the heartbeat record once the worker is closing, after any write
   * still in flight, so a closed worker stops being listed straight away.
   */
  async #unregister(): Promise<void> {
    if (
      !this.#reported ||
      this.#reportInterval === 0 ||
      !supportsWorkers(this.driver)
    ) {
      return;
    }

    await this.#reporting;

    try {
      await removeWorkerRecord(this.driver, this.ref, this.id);
    } catch (error) {
      this.#emitError(error, "report");
    }
  }

  /**
   * Writes the throughput counts the driver has gathered in memory, when it
   * gathers any. Awaited on close whether or not this worker owns the driver:
   * a process sharing one driver across its workers may exit without closing
   * it, and the last second of counts would go with the process.
   */
  async #flushThroughput(): Promise<void> {
    try {
      await this.driver.flushThroughput?.();
    } catch (error) {
      this.#emitError(error, "throughput");
    }
  }

  /* --- maintenance ------------------------------------------------------------ */

  /**
   * Arms the background passes this worker contributes to — the two halves of
   * what used to be one `maintenance` switch, each under its own lease.
   *
   * Every pass on either timer reads and repairs state belonging to the
   * **queue** rather than to this worker, so each timer runs under a sweep
   * lease: one worker per queue does the pass and the rest spend a single
   * queue-state read finding that out (C12, item 7). What is genuinely this
   * worker's own — redelivering its undelivered flow events, and promoting
   * delayed jobs, which is what bounds its own next wake-up — stays on every
   * worker and takes no lease at all.
   *
   * **Liveness is armed unconditionally**: the stalled sweep, the flow heal
   * that rides it, and the delayed promotion. Each is the only thing that
   * moves a particular kind of stuck job — a retry out of `delayed`, a job
   * out of a dead process's hands, a flow parent past a child that already
   * finished — so a queue whose only worker had them off stranded all three.
   * There is no configuration under which that is wanted, and
   * {@link BunQueueWorkerOptions.maintenance} no longer reaches them.
   *
   * **Housekeeping is what `maintenance: false` opts out of, and it is
   * exactly the minute timer**: the expiry prune, the repeat heal and the two
   * queue-state sweeps. Nothing stalls while they wait — a worker that skips
   * them costs the queue tidiness, not progress — so a fleet may leave them
   * to a subset of its workers, and one that opts out arms no timer for them
   * and makes no call of theirs. It never reads or takes
   * {@link MINUTE_SWEEP_LEASE} either: a lease for a timer it does not arm
   * would be a lease it could win and then never sweep under, which is
   * strictly worse than not contending.
   *
   * **One `if`, on one timer, and nothing else.** The liveness passes above
   * it carry no `maintenance` check at all, deliberately — and that includes
   * their lease. The stalled timer takes {@link STALLED_SWEEP_LEASE} so that
   * one worker per queue recovers stalled jobs and heals flows, and
   * **contending for that lease is how a worker takes part** — one
   * queue-state read per stalled interval, which is the correct price for an
   * opt-out worker to pay. An opt-out worker that skipped the stalled lease would
   * never be the one holding it, so on a queue whose only worker sets
   * `maintenance: false` nothing would ever recover a stalled job: exactly
   * the bug this split fixes, reached through the lease instead of the timer.
   * That the two leases differ here is the whole point. Do not tidy them into
   * one gate.
   *
   * **Cadence.** The stalled sweeps run at this worker's `stalledInterval`,
   * which workers on a queue may set differently, so their lease settles on
   * the shortest of them; the minute sweeps run at
   * {@link MINUTE_SWEEP_INTERVAL} on every worker, so theirs is never
   * contested for cadence and stays with whoever took it.
   */
  #armMaintenance(): void {
    this.#passesArmed = true;

    this.#every(this.#options.stalledInterval, async () => {
      await this.#redeliverPending();

      if (
        !(await this.#holdsSweepLease(
          STALLED_SWEEP_LEASE,
          this.#options.stalledInterval,
        ))
      ) {
        return;
      }

      const { requeued, dead } = await this.driver.recoverStalled(
        this.ref,
        Date.now(),
        this.#options.maxStalledCount,
        MAINTENANCE_BATCH,
      );

      const recovered = [...requeued, ...dead];
      if (recovered.length > 0) {
        this.safeEmit("stalled", recovered);
        void this.#publish("stalled", { ids: recovered });
        this.#wake.abort();
      }

      await this.#healFlows();
    });

    this.#armPromotion();

    // Liveness is armed, lease and all. The one line the option decides, and
    // everything past it is housekeeping — including its lease, which an
    // opt-out worker never reads.
    if (!this.#sweeps) {
      return;
    }

    this.#housekeepingArmed = true;

    this.#every(MINUTE_SWEEP_INTERVAL, async () => {
      if (
        !(await this.#holdsSweepLease(
          MINUTE_SWEEP_LEASE,
          MINUTE_SWEEP_INTERVAL,
        ))
      ) {
        return;
      }

      await this.#pruneExpired();
      await this.#healRepeats();
      await this.#sweepWindows();
      await this.#sweepWorkerControls();
    });
  }

  /**
   * Whether this worker does the queue's **housekeeping** — the minute
   * timer's passes — which is what {@link BunQueueWorkerOptions.maintenance}
   * decides and what its heartbeat record reports as `sweeps`.
   *
   * Both read it here rather than the option, so the record can never
   * disagree with what the worker actually arms. It says nothing about
   * liveness: every worker promotes, and every worker contends for
   * {@link STALLED_SWEEP_LEASE} and recovers while it holds it, whatever this
   * answers.
   *
   * It reports what the worker arms and contends for, not what it did this
   * minute: on a queue of `true` workers, one holds
   * {@link MINUTE_SWEEP_LEASE} on any given pass and the rest stand down.
   */
  get #sweeps(): boolean {
    return this.#options.maintenance;
  }

  /**
   * Removes expired jobs in batches of {@link MAINTENANCE_BATCH}, for as long
   * as each batch comes back full, up to {@link PRUNE_MAX_BATCHES} batches or
   * {@link PRUNE_TIME_BUDGET_MS}, whichever comes first. A pass that stops on
   * that budget with a full last batch has more to do, and runs again after
   * {@link PRUNE_CATCH_UP_MS} rather than a minute later, so the sweep keeps
   * up with a queue finishing thousands of jobs a second.
   *
   * A batch short of full means the backend found nothing more it could
   * remove, which ends the pass. Only one pass runs at a time: the catch-up
   * and the minute's maintenance would otherwise race over the same jobs.
   */
  async #pruneExpired(): Promise<void> {
    if (this.#pruning) {
      return;
    }

    this.#pruning = true;
    let backlog = false;
    try {
      const deadline = Date.now() + PRUNE_TIME_BUDGET_MS;

      for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
        if (this.#closing || !this.#housekeepingArmed) {
          return;
        }

        const removed = await this.driver.pruneExpired(
          this.ref,
          Date.now(),
          MAINTENANCE_BATCH,
        );

        backlog = removed >= MAINTENANCE_BATCH;
        if (!backlog || Date.now() >= deadline) {
          break;
        }
      }
    } finally {
      this.#pruning = false;
    }

    if (backlog) {
      this.#pruneSoon();
    }
  }

  /**
   * Runs {@link #pruneExpired} again after {@link PRUNE_CATCH_UP_MS}.
   *
   * Only while this worker still holds the minute sweep's lease — checked
   * against what it recorded, not with another queue-state read, since the
   * lease it took a moment ago outlasts this pause many times over.
   */
  #pruneSoon(): void {
    if (
      this.#closing ||
      !this.#housekeepingArmed ||
      !this.#holdsRecordedSweepLease(MINUTE_SWEEP_LEASE)
    ) {
      return;
    }

    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (
        this.#closing ||
        !this.#housekeepingArmed ||
        !this.#holdsRecordedSweepLease(MINUTE_SWEEP_LEASE)
      ) {
        return;
      }
      void this.#pruneExpired().catch((error: unknown) => {
        this.#emitError(error, "maintenance");
      });
    }, PRUNE_CATCH_UP_MS);
    timer.unref?.();
    // In the set every other maintenance timer is in, so parking the worker
    // or closing it clears this one too.
    this.#timers.add(timer);
  }

  /** Whether a prune pass is running, so another does not start beside it. */
  #pruning = false;

  /**
   * Arms — or re-arms, replacing the timer it armed before — the sweep that
   * promotes delayed jobs, at the cadence the poll interval implies.
   *
   * Only once `run()` has armed maintenance, and not while closing. `#running`
   * alone is not enough: it is set before `run()` connects, so a setter called
   * during a connect that then fails would leave a timer calling the driver
   * for a worker that never started. And a closing worker must not gain a
   * timer `close()` has already cleared.
   */
  #armPromotion(): void {
    if (!this.#passesArmed || !this.#running || this.#closing) {
      return;
    }

    if (this.#promotionTimer) {
      clearInterval(this.#promotionTimer);
      this.#timers.delete(this.#promotionTimer);
    }

    this.#promotionTimer = this.#every(
      promotionCadence(this.#options.pollInterval),
      async () => {
        // Runs whatever `#nextDue` says: this sweep is what bounds how late a
        // job another process schedules can be promoted while the loop trusts
        // it, and its answer refreshes it.
        const { promoted } = await this.#promote();
        if (promoted > 0) {
          this.#wake.abort();
        }
      },
    );
  }

  /** The promotion sweep's timer, so a changed poll interval can replace it. */
  #promotionTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Whether `run()` has armed the worker's background passes — set only after
   * it connected — so a changed poll interval re-arms the promotion sweep only
   * on a worker that actually got that far.
   *
   * It says the timers are armed, not which of them: a worker with
   * {@link BunQueueWorkerOptions.maintenance} off arms liveness and nothing
   * else, and this is `true` for it too. Parking clears it.
   */
  #passesArmed = false;

  /**
   * Whether the minute timer's **housekeeping** passes are armed, which only a
   * worker with {@link BunQueueWorkerOptions.maintenance} on ever is.
   *
   * Separate from {@link #passesArmed} because it guards
   * something else: the prune's catch-up reads it as its stop flag, and it
   * must stop for a worker parked or closed *and* say nothing about the
   * liveness passes, which are armed on every worker.
   */
  #housekeepingArmed = false;

  /**
   * Removes a page of stale debounce and throttle pointers, resuming where
   * the last pass stopped, so a queue with many ids is covered over several
   * passes rather than by one unbounded one.
   */
  async #sweepWindows(): Promise<void> {
    if (!supportsWindowSweep(this.driver)) {
      return;
    }

    const sweep = await sweepWindows(this.driver, this.ref, {
      now: Date.now(),
      limit: MAINTENANCE_BATCH,
      ...(this.#windowCursor !== undefined
        ? { after: this.#windowCursor }
        : {}),
    });

    this.#windowCursor = sweep.next;
  }

  /**
   * Removes a page of lifecycle instructions left behind by workers that are
   * gone.
   *
   * They are keyed by incarnation, so every one of them becomes garbage when
   * its process ends and nothing else would ever remove it. Bounded like
   * every other pass, resuming where the last one stopped.
   */
  async #sweepWorkerControls(): Promise<void> {
    if (!supportsWorkerControl(this.driver) || !supportsWorkers(this.driver)) {
      return;
    }

    const now = Date.now();
    const live = new Set(
      (await listWorkerRecords(this.driver, this.ref, now)).map(
        (worker) => worker.id,
      ),
    );

    const sweep = await sweepWorkerControls(this.driver, this.ref, {
      now,
      liveIds: live,
      graceMs:
        (this.#reportInterval || DEFAULT_REPORT_INTERVAL) *
        WORKER_CONTROL_GRACE_LIFETIMES,
      ...(this.#controlSweepCursor !== undefined
        ? { after: this.#controlSweepCursor }
        : {}),
    });

    this.#controlSweepCursor = sweep.next;
  }

  /**
   * Runs `work` now and then on an interval, reporting failures rather than
   * throwing.
   *
   * The immediate first pass matters: a worker starting up is exactly when
   * there is most likely something to repair — jobs a crashed process was
   * holding, a repeat series whose pending occurrence went with it — and
   * waiting a full interval to look would leave the queue stuck in the
   * meantime.
   */
  #every(
    ms: number,
    work: () => Promise<void>,
  ): ReturnType<typeof setInterval> {
    const run = () => {
      if (this.#closing) {
        return;
      }
      void work().catch((error: unknown) => {
        this.#emitError(error, "maintenance");
      });
    };

    const timer = setInterval(run, ms);
    timer.unref?.();
    this.#timers.add(timer);

    const first = setTimeout(run, 0);
    first.unref?.();

    return timer;
  }

  /**
   * Re-schedules any series whose pending occurrence has vanished — removed
   * by hand, or lost with the backend it was written to.
   */
  async #healRepeats(): Promise<void> {
    for (const definition of await this.driver.listRepeats(this.ref)) {
      if (!definition.nextJobId || definition.nextRunAt === null) {
        continue;
      }

      // Read fresh, never cached: this is the pass that repairs what a stale
      // answer let through. A disabled series keeps no pending occurrence —
      // one a worker scheduled just as it was disabled is removed here — and
      // gets no replacement for one that has gone.
      if (await isRepeatDisabled(this.driver, this.ref, definition.key)) {
        await removePendingOccurrence(this.driver, this.ref, definition);
        continue;
      }

      if (await this.driver.getJob(this.ref, definition.nextJobId)) {
        continue;
      }

      const now = Date.now();
      const next = nextOccurrence(definition, now);
      if (next === null) {
        continue;
      }

      const built = occurrenceRecord(definition, next, now);
      const record: JobRecord = {
        ...built,
        ...(await this.#occurrenceOptions(definition, built)),
      };
      await this.driver.addJob(this.ref, record);
      if (record.state === "delayed") {
        noteScheduled(this.driver, this.ref);
      }

      await this.driver.upsertRepeat(this.ref, {
        ...definition,
        nextRunAt: next,
        nextJobId: record.id,
        updatedAt: now,
      });
    }
  }

  /* --- waiting ------------------------------------------------------------------ */

  /** Whether the queue is paused, cached briefly to avoid a read per loop. */
  async #queuePaused(): Promise<boolean> {
    const now = Date.now();
    if (now - this.#pauseCache.at < PAUSE_CACHE_MS) {
      return this.#pauseCache.paused;
    }

    try {
      const paused = await this.driver.isQueuePaused(this.ref);
      this.#pauseCache = { paused, at: now };
      return paused;
    } catch (error) {
      this.#emitError(error, "isQueuePaused");
      return this.#pauseCache.paused;
    }
  }

  /**
   * How long to wait for work: never past the next delayed job's due time.
   *
   * `known` is that time when the pass already has it — from the promotion it
   * just ran, or from `#nextDue` — so only a driver that did not say pays a
   * `nextDelayedAt` for it. Every worker promotes, so every worker has it.
   */
  async #waitBudget(known?: number | null): Promise<number> {
    const base = this.driver.capabilities.blockingWait
      ? this.#options.maxBlock
      : this.#options.pollInterval;

    try {
      const next =
        known !== undefined ? known : await this.driver.nextDelayedAt(this.ref);
      if (next === null) {
        return base;
      }

      return Math.max(1, Math.min(base, next - Date.now()));
    } catch {
      return base;
    }
  }

  /**
   * Waits for work, a wake, or the budget — whichever comes first.
   *
   * A driver may legitimately answer at once (there is work, someone else
   * took it), so a wait that keeps answering at once is floored at a
   * millisecond: without that, a claim that keeps coming back empty turns this
   * loop into a spin that starves the event loop it is running on.
   *
   * Only the second instant answer in a row, with nothing claimed in between,
   * pays the floor. The first is nearly always a job that arrived between the
   * empty claim and the wait — a producer adding the next job just as the
   * last one finishes — and charging it a millisecond put a 1ms tail on a
   * third of the memory driver's round trips (p90 92µs -> 1.15ms), on a
   * backend with no I/O at all. A spinning driver still gets at most two
   * passes per millisecond.
   */
  async #idle(ms: number): Promise<void> {
    if (this.#closing) {
      return;
    }

    if (this.#wake.signal.aborted) {
      this.#rearmWake();
      return;
    }

    const wake = this.#wake;
    const startedAt = Date.now();

    try {
      await this.driver.waitForJob(this.ref, ms, wake.signal);
    } catch {
      // Only an abort rejects, and an abort is exactly what we want.
    }

    if (wake.signal.aborted) {
      this.#rearmWake();
      return;
    }

    if (Date.now() - startedAt >= 1) {
      this.#instantIdle = false;
      return;
    }

    if (!this.#instantIdle) {
      this.#instantIdle = true;
      return;
    }

    await sleep(1, { unref: true }).catch(() => {});
  }

  /**
   * Sleeps until `ms` pass, `resume()` or `close()` wakes the worker, or —
   * with `untilSlotFrees` — one of its running jobs finishes, whichever comes
   * first, and leaves nothing behind on the wake signal or the slot pulse,
   * both of which live as long as the worker. See `waitForAny`.
   */
  async #sleepUntilWake(ms: number, untilSlotFrees = false): Promise<void> {
    if (this.#closing) {
      return;
    }

    if (this.#wake.signal.aborted) {
      this.#rearmWake();
      return;
    }

    const wake = this.#wake;
    await waitForAny(ms, {
      signal: wake.signal,
      ...(untilSlotFrees ? { pulse: this.#slotFreed } : {}),
    });

    if (wake.signal.aborted) {
      this.#rearmWake();
    }
  }

  /**
   * Replaces a spent wake signal, and forgets `#nextDue`: whatever woke the
   * loop — a resume, a changed setting, a sweep that promoted — may have
   * changed what is scheduled.
   */
  #rearmWake(): void {
    this.#wake = new AbortController();
    this.#nextDue = undefined;
  }

  /** Reports a failure outside a job, logging it when nobody is listening. */
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
