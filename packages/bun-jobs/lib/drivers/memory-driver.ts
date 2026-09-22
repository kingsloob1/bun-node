import type { SerializedError } from "@kingsleyweb/bun-common";
import type {
  AddedRange,
  ChildOutcome,
  ChildRecordResult,
  ClaimOptions,
  ClearJobLogsResult,
  DriverCapabilities,
  DriverEvent,
  EventKind,
  EventOfKind,
  FailOutcome,
  JobFlow,
  JobPage,
  JobPatch,
  JobQuery,
  JobRecord,
  JobRef,
  JobsDriver,
  JobState,
  LockInfo,
  MetricsQuery,
  NamespaceMetricsQuery,
  NamespaceMetricsRead,
  PendingOptionsRewrite,
  PendingOptionsRewriteResult,
  QueuedTrigger,
  QueueRef,
  QueueStateEntry,
  RepeatRecord,
  Retention,
  RunLogAppendResult,
  RunLogCaps,
  RunLogInput,
  RunLogPage,
  RunLogQuery,
  RunnerMetricsQuery,
  RunnerMetricsRead,
  RunnerMetricsSeries,
  RunnerMetricsTotals,
  RunnerMetricsTotalsQuery,
  RunnerRunDelta,
  RunRecord,
  ThroughputBucket,
  WorkerInfo,
  WorkerMetricsQuery,
  WorkerMetricsRead,
  WorkerMetricsSeries,
  WorkerMetricsTotals,
  WorkerMetricsTotalsQuery,
} from "./driver";
import type {
  BusynessSample,
  BusynessStats,
  CounterBucket,
  DurationStats,
  JobCounters,
  MetricsOptions,
  MetricsSupport,
  ResolvedMetricsOptions,
  RunnerRunCounters,
  WorkerMetricsRef,
} from "./metrics";
import type { StoredRunLogLine } from "./runLogs";
import { jsonClone } from "@kingsleyweb/bun-common";
import { SECOND_BUCKET_MS } from "../api/contract/constants";
import {
  assertRewriteRequest,
  decodeRewriteCursor,
  emptyRewriteResult,
  encodeRewriteCursor,
  JOB_OPTION_BITS,
  planPendingRewrite,
  tallyRewrite,
} from "../queue/jobDefaults";
import { assertWritableStateName } from "../queue/windows";
import { compareCodePoints } from "../shared/strings";
import {
  compareCreated,
  countAddedByScan,
  inAddedRange,
  rangeMatchesNothing,
  sortsByCreated,
} from "./added";
import {
  attributionFilter,
  attributionOf,
  matchesAttribution,
  matchesNothing,
} from "./attribution";
import { canBury } from "./bury";
import { awaitsDelivery, flowKey, listsChild, unsettledChildren } from "./flow";
import {
  addBusynessSample,
  addDuration,
  bucketStart,
  emptyBusynessStats,
  emptyDurationStats,
  hasMetricBuckets,
  JOB_COUNTERS,
  mergeBusynessBuckets,
  mergeCounterBuckets,
  mergeDurationBuckets,
  MetricsPruneClock,
  metricsPruneCutoff,
  metricsSupportOf,
  NAMESPACE_ENTITY,
  resolveMetricsOptions,
  RUNNER_RUN_COUNTERS,
  runnerTotalsOf,
  splitWorkerMetricsEntity,
  uniqueWorkerRefs,
  workerMetricsEntity,
  workerTotalsOf,
  zeroCounters,
} from "./metrics";
import {
  jobFilter,
  matchesFilter,
  orderByIds,
  sortWorkers,
  sumBuckets,
  THROUGHPUT_RETENTION_MS,
  throughputBucket,
} from "./readApis";
import {
  emptyRunLog,
  pageRunLog,
  runLogOverflow,
  storeRunLogLine,
} from "./runLogs";

/**
 * The in-process driver: `Map`s, no I/O, no dependencies.
 *
 * It is the reference implementation of the contract — every rule the other
 * drivers work to reproduce is readable here in a few lines — and the backend
 * the test suite runs against by default. It is also genuinely useful for a
 * single-process application that wants scheduling and a queue without
 * standing up Redis.
 *
 * Atomicity is free: every operation below runs to completion without
 * awaiting, so the event loop cannot interleave two of them. That is exactly
 * what the other drivers buy with `SET NX`, `SKIP LOCKED` and `rename`.
 *
 * What it cannot do is cross a process. `capabilities.multiProcess` is
 * `false`, and a runner lock taken here means nothing to another process — so
 * a `single`-mode runner is only cluster-wide with a shared backend.
 */

/** One run's captured output, as the memory driver holds it. */
interface RunLog {
  /** The lines, oldest first. */
  lines: StoredRunLogLine[];
  /** How many the caps have dropped, which is the gap in the numbering. */
  dropped: number;
}

/** A runner's stored state. */
interface RunnerState {
  /** The current lock, if held. */
  lock?: LockInfo;
  /** State fields, including counters. */
  fields: Map<string, string>;
  /** Run history, newest first. */
  history: RunRecord[];
  /** Triggers parked while a run holds the lock, oldest first. */
  queued: QueuedTrigger[];
  /**
   * Each run's captured output, by run id — apart from `history`, because a
   * line must not rewrite the run record, and oldest run first, because a
   * `Map` iterates in insertion order and that is what `keepRuns` evicts by.
   */
  runLogs: Map<string, RunLog>;
}

/** A queue's stored state. */
interface QueueState {
  /** Every job, by id. */
  jobs: Map<string, JobRecord>;
  /** Insertion order, for a stable FIFO tie-break at equal priority. */
  order: Map<string, number>;
  /**
   * Ids of the waiting jobs, kept in claim order.
   *
   * Claiming used to build this list every time: materialise every job in the
   * queue, filter it down to the waiting ones, sort them, take the first.
   * That is O(n log n) per claim over jobs that are mostly not candidates, and
   * it showed — 0.022ms per claim at a backlog of 100 against 0.308ms at
   * 5,000, so the in-process driver drained at 7,088/s where Redis, over a
   * socket, managed 37,165/s.
   *
   * Maintained by {@link MemoryDriver.#setState} alone, which is what keeps it
   * honest: every state change in this driver goes through there.
   */
  waiting: string[];
  /**
   * Where {@link QueueState.waiting} actually starts.
   *
   * Claiming takes from the front, and splicing index 0 of a long array moves
   * every remaining element. A cursor makes that O(1); the dead prefix is
   * compacted once it is worth the copy.
   */
  waitingFrom: number;
  /**
   * Ids of the jobs that are `delayed` or `failed`.
   *
   * Promotion used to walk every job in the queue before every claim, looking
   * for something due. Almost always there is nothing scheduled at all, and
   * the set's size says so without looking; when something is, it is what
   * {@link QueueState.due} is rebuilt from.
   *
   * Maintained by {@link MemoryDriver.#setState}, `addJob` and
   * {@link MemoryDriver.#delete}, like {@link QueueState.waiting}.
   */
  scheduled: Set<string>;
  /**
   * A min-heap of the scheduled jobs by `runAt`, so promotion and
   * `nextDelayedAt` look at the earliest instead of walking every retained
   * job. Lazily deleted: an entry whose job is gone or no longer scheduled is
   * dropped when it surfaces, and one whose job's `runAt` has changed is put
   * back at the new time — so a missed update is late at worst, never lost.
   */
  due: DueEntry[];
  /**
   * The `completed` and `dead` jobs in retention order, one index per state,
   * so count retention trims from the front instead of sorting every job in
   * the queue on every finish. Maintained by {@link MemoryDriver.#setState},
   * `addJob` and {@link MemoryDriver.#delete}.
   */
  finished: { completed: FinishedIndex; dead: FinishedIndex };
  /** Repeat definitions, by key. */
  repeats: Map<string, RepeatRecord>;
  /**
   * Each job's log lines, oldest first, by job id.
   *
   * Removed in {@link MemoryDriver.#delete}, which every removal goes through,
   * so a log cannot outlive its job or be inherited by a later job that
   * reuses the id.
   */
  logs: Map<string, string[]>;
  /** Named values stored on the queue, for compare-and-set. */
  state: Map<string, QueueStateEntry>;
  /** Worker heartbeat records, by worker id; lapsed ones are dropped when listed. */
  workers: Map<string, WorkerInfo>;
  /**
   * Completions and failed attempts per minute, by the minute's start. Counted
   * in `completeJob` and `failJob`; minutes older than the retention before
   * the latest are dropped when a new minute starts.
   */
  throughput: Map<number, ThroughputBucket>;
  /** Whether claiming is paused for every worker. */
  paused: boolean;
  /** Next insertion sequence number. */
  seq: number;
  /** Resolvers of the callers waiting in `waitForJob`. */
  waiters: Set<() => void>;
  /**
   * The buckets a completion or failure of this queue lands in, for the
   * second last counted — `undefined` until the first count.
   *
   * Every finished job bumps four analytics buckets (second and minute, the
   * queue's and the namespace roll-up's) and a throughput minute. Found
   * afresh each time that is a dozen `Map` lookups, a closure and an object
   * per job; kept here it is four additions, recomputed once a second.
   */
  counting?: CountingBuckets;
}

/** One entry of {@link QueueState.due}. */
interface DueEntry {
  /** The job's `runAt` when the entry was pushed. */
  runAt: number;
  /** Push order, the tie-break at equal `runAt`. */
  seq: number;
  /** The job. */
  id: string;
}

/**
 * The jobs of one finished state, in the order count retention keeps them:
 * oldest `finishedOn` (or `createdAt`) first and, at an equal time, the later
 * added first — the exact reverse of the stable newest-first sort retention
 * used to do, so the same jobs go.
 */
interface FinishedIndex {
  /** Job ids, in retention order from {@link FinishedIndex.from}. */
  ids: string[];
  /** Where {@link FinishedIndex.ids} actually starts; trimming moves it. */
  from: number;
  /** Each indexed job's key when it was indexed, to find it again. */
  keys: Map<string, number>;
}

/** Push order for {@link DueEntry.seq}. */
let dueSeq = 0;

/** Whether heap entry `a` comes out before `b`. */
function dueBefore(a: DueEntry, b: DueEntry): boolean {
  return a.runAt < b.runAt || (a.runAt === b.runAt && a.seq < b.seq);
}

/** Adds an entry to a {@link QueueState.due} heap. */
function duePush(heap: DueEntry[], entry: DueEntry): void {
  heap.push(entry);
  let at = heap.length - 1;

  while (at > 0) {
    const parent = (at - 1) >> 1;
    if (!dueBefore(heap[at]!, heap[parent]!)) {
      break;
    }
    [heap[at], heap[parent]] = [heap[parent]!, heap[at]!];
    at = parent;
  }
}

/** Removes the earliest entry of a {@link QueueState.due} heap. */
function duePop(heap: DueEntry[]): void {
  const last = heap.pop();
  if (last === undefined || heap.length === 0) {
    return;
  }

  heap[0] = last;
  let at = 0;

  for (;;) {
    const left = at * 2 + 1;
    const right = left + 1;
    let first = at;

    if (left < heap.length && dueBefore(heap[left]!, heap[first]!)) {
      first = left;
    }
    if (right < heap.length && dueBefore(heap[right]!, heap[first]!)) {
      first = right;
    }
    if (first === at) {
      return;
    }
    [heap[at], heap[first]] = [heap[first]!, heap[at]!];
    at = first;
  }
}

/**
 * Where one second's job counts of a queue go, held by
 * {@link QueueState.counting}.
 */
interface CountingBuckets {
  /** The start of the finest analytics width's bucket these were found for. */
  second: number;
  /**
   * {@link MemoryDriver}'s prune generation when these were found: a sweep can
   * delete a series a reference points at, so a newer generation means find
   * them again.
   */
  generation: number;
  /** Every analytics bucket a count bumps: each width, queue and roll-up. */
  buckets: JobCounters[];
  /** The throughput minute a count bumps. */
  throughput: ThroughputBucket;
}

/**
 * One entity's buckets of some statistic: the bucket width, then the bucket's
 * start, then whatever is kept for it.
 *
 * Nested rather than keyed by a composite, because the prune walks one width
 * at a time — each has its own retention — and a flat key would mean parsing
 * one back out per entry per sweep.
 */
type IntervalBuckets<T> = Map<number, Map<number, T>>;

/**
 * A namespace's analytics buckets, by kind and then by entity.
 *
 * The namespace roll-up is stored as an entity like any other, under
 * {@link NAMESPACE_ENTITY} — so `getNamespaceMetrics` is three ordinary reads,
 * and neither the prune nor `purge` needs a case for it.
 */
interface MetricsState {
  /** What each queue's backend finished, by queue name. */
  jobs: Map<string, IntervalBuckets<JobCounters>>;
  /** What each worker finished itself, by {@link workerEntity}. */
  workerJobs: Map<string, IntervalBuckets<JobCounters>>;
  /** How busy each worker reported itself, by {@link workerEntity}. */
  busyness: Map<string, IntervalBuckets<BusynessStats>>;
  /** How each runner's runs ended, by runner key. */
  runs: Map<string, IntervalBuckets<RunnerRunCounters>>;
  /** How long each runner's runs took, by runner key. */
  durations: Map<string, IntervalBuckets<DurationStats>>;
}

/** Everything stored under one namespace. */
interface NamespaceState {
  /** Runner state, by runner key. */
  runners: Map<string, RunnerState>;
  /** Queue state, by queue name. */
  queues: Map<string, QueueState>;
  /** Event listeners, by `<kind>:<target>`. */
  subscribers: Map<string, Set<(event: DriverEvent) => void>>;
  /** Analytics buckets, per §4 of the analytics design. */
  metrics: MetricsState;
}

/**
 * Which worker a metric series belongs to: its queue, then its stable
 * `WorkerInfo.key`.
 *
 * Keyed by `key` and never by `WorkerInfo.id`, because an id is one
 * incarnation — a rolling redeploy would shred the series into one per
 * replica. Scoped by queue because a worker record is, so two queues' workers
 * that happen to share a key stay two series. A queue name cannot hold a colon
 * (`assertSegment` allows `[A-Za-z0-9_.-]` only) while a worker key may, so the
 * **first** colon always splits the pair the same way and no two pairs meet.
 */
function workerEntity(q: Pick<QueueRef, "queue">, key: string): string {
  return workerMetricsEntity(q.queue, key);
}

/** Options for {@link MemoryDriver}. */
export interface MemoryDriverOptions {
  /**
   * What to record into the analytics buckets. Everything, at one-second
   * resolution, by default: nothing here costs I/O, so the only reason to turn
   * a series off in this driver is to reproduce a leaner backend's behaviour.
   */
  metrics?: MetricsOptions;
}

/** States holding a job that is due later. */
const SCHEDULED_STATES: JobState[] = ["delayed", "failed"];

/** How long a claimed-out prefix may grow before the waiting list is copied. */
const COMPACT_AFTER = 1_000;

/** What a rewrite cursor's key holds here: priority, createdAt, insertion order. */
const CURSOR_KEY = ["number", "number", "number"] as const;

/** Orders two rewrite-walk keys, part by part. */
function compareKeys(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export class MemoryDriver implements JobsDriver {
  /** Identifies the implementation in errors and capability checks. */
  readonly name = "memory";

  /** In-process only: no other process can see these `Map`s. */
  readonly capabilities: DriverCapabilities = {
    blockingWait: true,
    events: "local",
    multiProcess: false,
    multiHost: false,
    jobAttribution: true,
  };

  /** All state, by namespace. */
  readonly #namespaces = new Map<string, NamespaceState>();

  /** What is recorded into the analytics buckets, and for how long. */
  readonly #metrics: ResolvedMetricsOptions;

  /**
   * When the analytics buckets were last swept. Once a minute per process,
   * whatever the write rate — the sweep is over every entity, so paying it per
   * count would be paying it thousands of times a second.
   */
  readonly #metricsPrune = new MetricsPruneClock();

  /**
   * How many analytics sweeps have run: bumped by each, so a queue's cached
   * {@link QueueState.counting} knows its references may point at a deleted
   * bucket.
   */
  #metricsGeneration = 0;

  constructor(
    /** What to record; everything, at one-second resolution, by default. */
    options: MemoryDriverOptions = {},
  ) {
    this.#metrics = resolveMetricsOptions(options.metrics);
  }

  /* --- lifecycle --------------------------------------------------- */

  async connect(): Promise<void> {
    // Nothing to open; `connect()` exists so callers need not special-case.
  }

  async close(): Promise<void> {
    // Release anyone blocked in `waitForJob`, or their promises never settle.
    for (const namespace of this.#namespaces.values()) {
      for (const queue of namespace.queues.values()) {
        for (const wake of queue.waiters) {
          wake();
        }
        queue.waiters.clear();
      }
      namespace.subscribers.clear();
    }
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async purge(ns: string): Promise<void> {
    const namespace = this.#namespaces.get(ns);
    if (!namespace) {
      return;
    }

    for (const queue of namespace.queues.values()) {
      for (const wake of queue.waiters) {
        wake();
      }
    }
    this.#namespaces.delete(ns);
  }

  async listRunners(ns: string): Promise<string[]> {
    return [...(this.#namespaces.get(ns)?.runners.keys() ?? [])].map((key) =>
      key.replace(/^r:/, ""),
    );
  }

  async listQueues(ns: string): Promise<string[]> {
    return [...(this.#namespaces.get(ns)?.queues.keys() ?? [])];
  }

  /* --- runner: locks ----------------------------------------------- */

  async acquireLock(
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    const runner = this.#runner(ns, key);
    const held = runner.lock;

    if (held && held.expiresAt > now && held.token !== token) {
      return false;
    }

    runner.lock = { token, expiresAt: now + ttlMs };
    return true;
  }

  async renewLock(
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    const runner = this.#runner(ns, key);
    if (!runner.lock || runner.lock.token !== token) {
      return false;
    }

    // An expired lock is not renewable: someone else may already have taken
    // it, so the caller has to learn it lost rather than quietly continue.
    if (runner.lock.expiresAt <= now) {
      return false;
    }

    runner.lock.expiresAt = now + ttlMs;
    return true;
  }

  async releaseLock(ns: string, key: string, token: string): Promise<boolean> {
    const runner = this.#runner(ns, key);
    if (!runner.lock || runner.lock.token !== token) {
      return false;
    }

    runner.lock = undefined;
    return true;
  }

  async getLock(
    ns: string,
    key: string,
    now: number,
  ): Promise<LockInfo | null> {
    const held = this.#existingRunner(ns, key)?.lock;
    return held && held.expiresAt > now ? { ...held } : null;
  }

  /* --- runner: state, history, queued triggers ---------------------- */

  async getState(ns: string, key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.#existingRunner(ns, key)?.fields ?? []);
  }

  async setState(
    ns: string,
    key: string,
    fields: Record<string, string | number | null>,
  ): Promise<void> {
    const runner = this.#runner(ns, key);
    for (const [field, value] of Object.entries(fields)) {
      if (value === null) {
        runner.fields.delete(field);
      } else {
        runner.fields.set(field, String(value));
      }
    }
  }

  async incrementCounters(
    ns: string,
    key: string,
    deltas: Record<string, number>,
  ): Promise<Record<string, number>> {
    const runner = this.#runner(ns, key);
    const updated: Record<string, number> = {};

    for (const [field, delta] of Object.entries(deltas)) {
      const current = Number(runner.fields.get(field) ?? 0);
      const next = (Number.isFinite(current) ? current : 0) + delta;
      runner.fields.set(field, String(next));
      updated[field] = next;
    }

    return updated;
  }

  async appendHistory(
    ns: string,
    key: string,
    record: RunRecord,
    keep: number,
  ): Promise<void> {
    const runner = this.#runner(ns, key);
    runner.history.unshift(jsonClone(record));
    if (keep > 0 && runner.history.length > keep) {
      runner.history.length = keep;
    }
  }

  async updateHistory(
    ns: string,
    key: string,
    runId: string,
    patch: Partial<RunRecord>,
  ): Promise<boolean> {
    const runner = this.#runner(ns, key);
    const index = runner.history.findIndex((entry) => entry.runId === runId);
    if (index === -1) {
      return false;
    }

    runner.history[index] = { ...runner.history[index], ...jsonClone(patch) };
    return true;
  }

  async listHistory(
    ns: string,
    key: string,
    limit?: number,
  ): Promise<RunRecord[]> {
    const history = this.#existingRunner(ns, key)?.history ?? [];
    const slice = limit && limit > 0 ? history.slice(0, limit) : history;
    return slice.map((entry) => ({ ...entry }));
  }

  async clearHistory(ns: string, key: string): Promise<void> {
    const runner = this.#runner(ns, key);
    runner.history = [];
    // A run the history no longer names cannot be asked about, so its log
    // would be bytes nothing could ever reach or collect.
    runner.runLogs.clear();
  }

  async appendRunLog(
    ns: string,
    key: string,
    runId: string,
    lines: RunLogInput[],
    caps: RunLogCaps,
  ): Promise<RunLogAppendResult> {
    const runner = this.#runner(ns, key);
    let log = runner.runLogs.get(runId);

    if (!log) {
      log = { lines: [], dropped: 0 };
      runner.runLogs.set(runId, log);
    }

    // Continues the run's own numbering, which survives a trim: the last
    // line's number, or what has already been dropped when none is left.
    let seq = log.lines.at(-1)?.seq ?? log.dropped;

    for (const line of lines) {
      log.lines.push(storeRunLogLine(line, ++seq));
    }

    const overflow = runLogOverflow(log.lines, caps);
    if (overflow > 0) {
      log.lines.splice(0, overflow);
      log.dropped += overflow;
    }

    // `keepRuns` on the write path too, so nothing has to sweep. Insertion
    // order is run order, so the oldest are simply the first keys.
    if (caps.keepRuns > 0 && runner.runLogs.size > caps.keepRuns) {
      const stale = [...runner.runLogs.keys()].slice(
        0,
        runner.runLogs.size - caps.keepRuns,
      );
      for (const id of stale) {
        runner.runLogs.delete(id);
      }
    }

    return { count: log.lines.length, dropped: log.dropped, lastSeq: seq };
  }

  async getRunLog(
    ns: string,
    key: string,
    runId: string,
    opts: RunLogQuery,
  ): Promise<RunLogPage> {
    const log = this.#existingRunner(ns, key)?.runLogs.get(runId);

    if (!log) {
      return emptyRunLog();
    }

    return pageRunLog(log.lines, opts, {
      dropped: log.dropped,
      lastSeq: log.lines.at(-1)?.seq ?? log.dropped,
    });
  }

  async clearRunLogs(ns: string, key: string, runId?: string): Promise<void> {
    const runner = this.#existingRunner(ns, key);

    if (runId === undefined) {
      runner?.runLogs.clear();
    } else {
      runner?.runLogs.delete(runId);
    }
  }

  async removeRuns(
    ns: string,
    key: string,
    runIds: readonly string[],
  ): Promise<number> {
    // Read, never created: removing from a runner that does not exist must
    // not make it exist, as `listRunners` would then report it.
    const runner = this.#existingRunner(ns, key);

    if (!runner || runIds.length === 0) {
      return 0;
    }

    const named = new Set(runIds);
    const before = runner.history.length;
    runner.history = runner.history.filter((entry) => !named.has(entry.runId));

    // A named log goes whether or not a record still names it: one that
    // outlived its record is bytes nothing could reach.
    for (const runId of named) {
      runner.runLogs.delete(runId);
    }

    return before - runner.history.length;
  }

  async pushQueuedTrigger(
    ns: string,
    key: string,
    trigger: QueuedTrigger,
    max: number,
  ): Promise<boolean> {
    const runner = this.#runner(ns, key);
    if (max > 0 && runner.queued.length >= max) {
      return false;
    }

    runner.queued.push(jsonClone(trigger));
    return true;
  }

  async popQueuedTrigger(
    ns: string,
    key: string,
  ): Promise<QueuedTrigger | null> {
    return this.#existingRunner(ns, key)?.queued.shift() ?? null;
  }

  async peekQueuedTrigger(
    ns: string,
    key: string,
  ): Promise<QueuedTrigger | null> {
    // A copy, as on the way in: the caller must not be able to edit the
    // stored head through the object it was handed.
    const head = this.#existingRunner(ns, key)?.queued[0];
    return head ? jsonClone(head) : null;
  }

  async popQueuedTriggerIf(
    ns: string,
    key: string,
    expectedId: string,
  ): Promise<QueuedTrigger | null> {
    // The check and the shift are one synchronous step, with no `await`
    // between them, so no other caller can run in the gap. An unknown runner
    // is looked up, never created.
    const queued = this.#existingRunner(ns, key)?.queued;
    if (!queued || queued[0]?.id !== expectedId) {
      return null;
    }
    return queued.shift() ?? null;
  }

  async countQueuedTriggers(ns: string, key: string): Promise<number> {
    return this.#existingRunner(ns, key)?.queued.length ?? 0;
  }

  async clearQueuedTriggers(ns: string, key: string): Promise<number> {
    const runner = this.#runner(ns, key);
    const count = runner.queued.length;
    runner.queued = [];
    return count;
  }

  /* --- queue: jobs -------------------------------------------------- */

  async ensureQueue(q: QueueRef): Promise<void> {
    this.#queue(q);
  }

  async addJob(
    q: QueueRef,
    job: JobRecord,
  ): Promise<{ job: JobRecord; added: boolean }> {
    const queue = this.#queue(q);
    const existing = queue.jobs.get(job.id);
    if (existing) {
      return { job: { ...existing }, added: false };
    }

    // `undefined` is not JSON; every other driver stores it as null.
    const stored = jsonClone({ ...job, data: job.data ?? null });
    queue.jobs.set(stored.id, stored);
    queue.order.set(stored.id, queue.seq++);

    if (stored.state === "waiting") {
      // `order` has to be set first: it is the comparator's last tie-break, so
      // inserting before it is known would place the job against a zero.
      this.#enterWaiting(queue, stored);
      this.#wake(queue);
    } else {
      // A job can arrive already delayed, failed or even finished, and the
      // promotion guard and retention read the indexes rather than looking.
      this.#enterIndexes(queue, stored);
    }

    return { job: { ...stored }, added: true };
  }

  async addJobs(
    q: QueueRef,
    jobs: JobRecord[],
  ): Promise<{ job: JobRecord; added: boolean }[]> {
    const results: { job: JobRecord; added: boolean }[] = [];
    for (const job of jobs) {
      results.push(await this.addJob(q, job));
    }
    return results;
  }

  async claimJob(q: QueueRef, opts: ClaimOptions): Promise<JobRecord | null> {
    const queue = this.#queue(q);
    if (queue.paused) {
      return null;
    }

    // Due delayed jobs are not promoted here: that is the worker's maintenance,
    // which `maintenance: false` turns off, as on every other driver.

    // The index is already in claim order, so the first due entry is the
    // answer. Walking past a not-yet-due one matters because `runAt` can move
    // forward under a job that is already waiting — a retry sets both — and
    // the index is ordered by priority, not by time.
    const job = this.#firstClaimable(queue, opts.now, opts.excludeNames);

    if (!job) {
      return null;
    }

    this.#setState(queue, job, "active");
    job.attemptsMade += 1;
    job.processedOn = opts.now;
    job.lockToken = opts.token;
    job.lockExpiresAt = opts.now + opts.lockMs;
    job.workerId = opts.workerId;
    // Replaces the last attempt's stamp; nothing else ever writes it, and no
    // settle clears it.
    job.processedBy = attributionOf(opts);

    return { ...job };
  }

  async extendJobLock(
    q: QueueRef,
    id: string,
    token: string,
    lockMs: number,
    now: number,
  ): Promise<boolean> {
    const job = this.#queue(q).jobs.get(id);
    if (!job || job.state !== "active" || job.lockToken !== token) {
      return false;
    }

    job.lockExpiresAt = now + lockMs;
    return true;
  }

  async completeJob(
    q: QueueRef,
    id: string,
    token: string,
    result: unknown,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);
    if (!job || job.state !== "active" || job.lockToken !== token) {
      return false;
    }

    // Before the state: the retention index is ordered by it.
    job.finishedOn = now;
    this.#setState(queue, job, "completed");
    job.returnValue = jsonClone(result ?? null);
    job.lockToken = null;
    job.lockExpiresAt = null;
    job.workerId = null;

    this.#count(q, queue, now, "completed");
    this.#applyRetention(queue, job, retention, now);
    return true;
  }

  async failJob(
    q: QueueRef,
    id: string,
    token: string,
    error: SerializedError,
    outcome: FailOutcome,
    now: number,
    keepStacktraces: number,
  ): Promise<boolean> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);
    if (!job || job.state !== "active" || job.lockToken !== token) {
      return false;
    }

    job.failedReason = jsonClone(error);
    job.stacktrace = [jsonClone(error), ...job.stacktrace].slice(
      0,
      Math.max(0, keepStacktraces),
    );
    job.lockToken = null;
    job.lockExpiresAt = null;
    job.workerId = null;
    this.#count(q, queue, now, "failed");

    // `runAt` and `finishedOn` before the state: the promotion heap and the
    // retention index are keyed by them.
    if (outcome.retry) {
      job.runAt = outcome.runAt;
      job.finishedOn = null;
      this.#setState(queue, job, "failed");
      return true;
    }

    job.finishedOn = now;
    this.#setState(queue, job, "dead");
    this.#applyRetention(queue, job, outcome.retention, now);
    return true;
  }

  async buryJob(
    q: QueueRef,
    id: string,
    error: SerializedError,
    opts: { retention: Retention; keepStacktraces: number; token?: string },
    now: number,
  ): Promise<JobRecord | null> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);

    if (!job || !canBury(job, opts.token)) {
      return null;
    }

    job.failedReason = jsonClone(error);
    job.stacktrace = [jsonClone(error), ...job.stacktrace].slice(
      0,
      Math.max(0, opts.keepStacktraces),
    );
    job.lockToken = null;
    job.lockExpiresAt = null;
    job.workerId = null;
    this.#count(q, queue, now, "failed");
    job.finishedOn = now;
    this.#setState(queue, job, "dead");

    // Taken before retention, which may remove the job: the caller still
    // needs what it buried, to announce it and file its dead letter.
    const buried = jsonClone(job);
    this.#applyRetention(queue, job, opts.retention, now);
    return { ...buried, expiresAt: job.expiresAt };
  }

  async updateProgress(
    q: QueueRef,
    id: string,
    progress: unknown,
  ): Promise<boolean> {
    const job = this.#queue(q).jobs.get(id);
    if (!job) {
      return false;
    }

    job.progress = jsonClone(progress ?? null);
    return true;
  }

  async updateJob(
    q: QueueRef,
    id: string,
    patch: JobPatch,
    now: number,
  ): Promise<JobRecord | null> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);

    if (!job || (patch.onlyIn && !patch.onlyIn.includes(job.state))) {
      return null;
    }

    if (
      patch.runAt !== undefined &&
      job.state !== "waiting" &&
      job.state !== "delayed"
    ) {
      return null;
    }

    if (patch.data !== undefined) {
      job.data = jsonClone(patch.data);
    }

    if (patch.priority !== undefined) {
      // The waiting index is ordered by priority, so a waiting job has to be
      // taken out before its key changes and put back after.
      const reindex =
        job.state === "waiting" && patch.priority !== job.priority;

      if (reindex) {
        this.#leaveWaiting(queue, id);
      }

      job.priority = patch.priority;
      job.opts = {
        ...job.opts,
        priority: patch.priority,
        // An operator's per-job priority is explicit, so a queue's stored
        // defaults never replace it — set even when the value is unchanged,
        // since choosing it is what pins it. A job without a mask stays
        // without one: a mask of only this bit would claim every other option
        // of an older job was defaulted.
        ...(typeof job.opts.explicit === "number"
          ? { explicit: job.opts.explicit | JOB_OPTION_BITS.priority }
          : {}),
      };

      if (reindex) {
        this.#enterWaiting(queue, job);
      }
    }

    if (patch.runAt !== undefined) {
      const was = job.state;
      job.runAt = patch.runAt;
      this.#setState(queue, job, patch.runAt > now ? "delayed" : "waiting");

      // Already scheduled, the state did not change, so nothing re-entered
      // the heap: an earlier time must be pushed or it would surface late.
      if (was === job.state && queue.scheduled.has(job.id)) {
        duePush(queue.due, { runAt: job.runAt, seq: dueSeq++, id: job.id });
      }
    }

    if (job.state === "waiting") {
      this.#wake(queue);
    }

    return { ...job };
  }

  async rewritePendingOptions(
    q: QueueRef,
    request: PendingOptionsRewrite,
  ): Promise<PendingOptionsRewriteResult> {
    assertRewriteRequest(request);

    const queue = this.#queue(q);
    const result = emptyRewriteResult();
    const { states } = request;

    // Every state is walked by (priority, createdAt, insertion order): the
    // waiting index's own order, and a key that is unique per job. A rewrite
    // changes only the first part, so a job it moves lands either behind the
    // cursor (never met again) or ahead of it (met again, `unchanged`) — and
    // nothing not yet visited moves past it.
    const keyOf = (job: JobRecord): [number, number, number] => [
      job.priority,
      job.createdAt,
      queue.order.get(job.id) ?? 0,
    ];

    let from = 0;
    let after: [number, number, number] | null = null;
    /** The last job examined in this call, which the next call resumes after. */
    let last: { state: JobState; key: [number, number, number] } | undefined;

    if (request.cursor !== null) {
      const cursor = decodeRewriteCursor(request.cursor, states, CURSOR_KEY);
      from = states.indexOf(cursor.state);
      after = cursor.key as [number, number, number];
    }

    // The whole call runs without yielding, so it is atomic against claims:
    // a job's state is the one it is filtered on right up to its write, and
    // `moved` is always 0 here.
    for (let index = from; index < states.length; index++) {
      const state = states[index]!;
      const floor = after;
      after = null;

      const candidates = [...queue.jobs.values()]
        .filter(
          (job) =>
            job.state === state &&
            (floor === null || compareKeys(keyOf(job), floor) > 0),
        )
        .map((job) => ({ job, key: keyOf(job) }))
        .sort((a, b) => compareKeys(a.key, b.key));

      for (const { job, key } of candidates) {
        if (result.examined >= request.limit && last) {
          // Resume after the last job examined — set, since the limit is at
          // least 1. It may be in an earlier state than this one: the next
          // call then finds nothing left there and carries on here. Stopping
          // only when there *is* a next candidate means a walk that ends
          // exactly at the limit answers `next: null`, not one empty call more.
          result.next = encodeRewriteCursor(last.state, last.key);
          return result;
        }

        const plan = planPendingRewrite(
          job,
          request.values,
          request.includeUnmarked,
        );
        tallyRewrite(result, plan);
        last = { state, key };

        if (plan.outcome !== "rewritten" || request.dryRun) {
          continue;
        }

        const reindex =
          job.state === "waiting" && plan.priority !== job.priority;

        if (reindex) {
          this.#leaveWaiting(queue, job.id);
        }

        job.opts = plan.opts;
        job.priority = plan.priority;
        job.maxAttempts = plan.maxAttempts;

        if (reindex) {
          this.#enterWaiting(queue, job);
        }
      }
    }

    return result;
  }

  async addJobLog(
    q: QueueRef,
    id: string,
    line: string,
    keep: number,
  ): Promise<number> {
    const queue = this.#queue(q);

    if (!queue.jobs.has(id)) {
      return 0;
    }

    let logs = queue.logs.get(id);

    if (!logs) {
      logs = [];
      queue.logs.set(id, logs);
    }

    logs.push(line);

    if (keep > 0 && logs.length > keep) {
      logs.splice(0, logs.length - keep);
    }

    return logs.length;
  }

  async getJobLogs(
    q: QueueRef,
    id: string,
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<{ logs: string[]; count: number }> {
    const logs = this.#queue(q).logs.get(id) ?? [];
    const ordered = opts.order === "desc" ? logs.toReversed() : logs;

    return {
      logs: ordered.slice(opts.offset, opts.offset + opts.limit),
      count: logs.length,
    };
  }

  async clearJobLogs(q: QueueRef, id: string): Promise<ClearJobLogsResult> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);

    if (!job) {
      return { status: "missing" };
    }

    // Checked in the same synchronous step as the removal, so a claim cannot
    // land between the two.
    if (job.state === "active") {
      return { status: "active" };
    }

    // Gone, not emptied in place: the count every read answers with is the
    // array's length, so the next line counts from one and `keep` trims from
    // there.
    const removed = queue.logs.get(id)?.length ?? 0;
    queue.logs.delete(id);

    return { status: "cleared", removed };
  }

  async getJob(q: QueueRef, id: string): Promise<JobRecord | null> {
    const job = this.#queue(q).jobs.get(id);
    return job ? { ...job } : null;
  }

  async recordChild(
    q: QueueRef,
    parentId: string,
    child: JobRef,
    outcome: ChildOutcome,
    now: number,
  ): Promise<ChildRecordResult> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(parentId);
    // A job that does not list this child is not its parent, whatever the
    // child believes: a flow re-added under the same parent id, say.
    if (!job?.flow || !listsChild(job.flow, child)) {
      return "missing";
    }

    const flow = job.flow;
    const key = flowKey(child);
    if (Object.hasOwn(flow.values, key) || Object.hasOwn(flow.failures, key)) {
      return "already";
    }

    const settles = outcome.completed || outcome.ignored;

    if (job.state === "dead") {
      if (!settles) {
        return "parent-dead";
      }
      // Kept for a retry of the parent, which then does not wait on it.
      this.#storeOutcome(flow, key, outcome);
      return "recorded";
    }

    if (job.state !== "waiting-children") {
      return "already";
    }

    if (!settles) {
      // A failure decided from an earlier view of the child is stale, and must
      // not bury a retried parent again: one already delivered (it buried
      // this parent, which has been retried since), or one from a child that
      // is no longer dead (it has been retried itself). Read in the same
      // synchronous step as the bury, so no retry can land between the two.
      // A child with no record at all still buries.
      const siblings = this.#namespace(q.ns).queues.get(child.queue);
      const stored = siblings?.jobs.get(child.id);
      if (
        stored &&
        (stored.flow?.recorded === true || stored.state !== "dead")
      ) {
        return "already";
      }
      // A child that failed buries its parent, which can then never run.
      job.failedReason = jsonClone(outcome.error);
      job.finishedOn = now;
      this.#setState(queue, job, "dead");
      this.#count(q, queue, now, "failed");
      return "buried";
    }

    this.#storeOutcome(flow, key, outcome);
    flow.pending = Math.max(0, flow.pending - 1);
    if (flow.pending > 0) {
      return "recorded";
    }

    const released = job.runAt > now ? "delayed" : "waiting";
    this.#setState(queue, job, released);
    if (released === "waiting") {
      this.#wake(queue);
    }
    return "released";
  }

  /** Stores a settled child's value or ignored failure on its parent's flow. */
  #storeOutcome(flow: JobFlow, key: string, outcome: ChildOutcome): void {
    if (outcome.completed) {
      flow.values[key] = jsonClone(outcome.value ?? null);
    } else {
      flow.failures[key] = jsonClone(outcome.error);
    }
  }

  async requeueParent(q: QueueRef, id: string, now: number): Promise<boolean> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);
    if (!job || job.state !== "dead" || !job.flow) {
      return false;
    }

    job.flow.pending = unsettledChildren(job.flow);
    // The outcome it ends with this time has not reached its own parent, as
    // after `retryJob`: without this a nested parent that fails again would
    // have that failure refused as already delivered.
    job.flow.recorded = false;
    job.failedReason = null;
    job.finishedOn = null;
    job.expiresAt = null;

    if (job.flow.pending > 0) {
      this.#setState(queue, job, "waiting-children");
    } else {
      const released = job.runAt > now ? "delayed" : "waiting";
      this.#setState(queue, job, released);
      if (released === "waiting") {
        this.#wake(queue);
      }
    }

    return true;
  }

  async markChildRecorded(
    q: QueueRef,
    id: string,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);
    if (!job) {
      return false;
    }

    job.flow = {
      parent: job.flow?.parent ?? null,
      children: job.flow?.children ?? [],
      pending: job.flow?.pending ?? 0,
      values: job.flow?.values ?? {},
      failures: job.flow?.failures ?? {},
      recorded: true,
    };

    if (job.state === "completed" || job.state === "dead") {
      this.#applyRetention(queue, job, retention, now);
    }

    return true;
  }

  async listJobs(
    q: QueueRef,
    states: JobState[],
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<JobRecord[]> {
    const queue = this.#queue(q);
    const wanted = new Set(states);
    const single = states.length === 1 ? states[0] : undefined;

    const sorted = [...queue.jobs.values()]
      .filter((job) => wanted.has(job.state))
      .sort((a, b) => {
        if (single === "waiting") {
          return this.#compareWaiting(queue, a, b);
        }
        return this.#sortKey(a, single) - this.#sortKey(b, single);
      });

    if (opts.order === "desc") {
      sorted.reverse();
    }

    return sorted
      .slice(opts.offset, opts.offset + opts.limit)
      .map((job) => ({ ...job }));
  }

  async countJobs(q: QueueRef): Promise<Record<JobState, number>> {
    const counts: Record<JobState, number> = {
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      dead: 0,
      "waiting-children": 0,
    };

    for (const job of this.#queue(q).jobs.values()) {
      counts[job.state] += 1;
    }

    return counts;
  }

  async findJobs(q: QueueRef, query: JobQuery): Promise<JobPage> {
    const queue = this.#queue(q);
    const filter = jobFilter(query);
    const attribution = attributionFilter(query);

    if (attribution && matchesNothing(attribution, query.states)) {
      return query.total ? { jobs: [], total: 0 } : { jobs: [] };
    }

    const wanted = new Set(query.states);
    const single = query.states.length === 1 ? query.states[0] : undefined;
    const byCreated = sortsByCreated(query);

    const matching = [...queue.jobs.values()]
      .filter(
        (job) =>
          wanted.has(job.state) &&
          (!filter || matchesFilter(filter, job.id, job.name)) &&
          (!attribution || matchesAttribution(attribution, job)),
      )
      .sort((a, b) =>
        byCreated
          ? compareCreated(a, b)
          : single === "waiting"
            ? this.#compareWaiting(queue, a, b)
            : this.#sortKey(a, single) - this.#sortKey(b, single),
      );

    if (query.order === "desc") {
      matching.reverse();
    }

    const offset = Math.max(0, Math.floor(query.offset));
    const jobs = matching
      .slice(offset, offset + Math.max(0, Math.floor(query.limit)))
      .map((job) => ({ ...job }));

    return query.total ? { jobs, total: matching.length } : { jobs };
  }

  async getJobs(q: QueueRef, ids: string[]): Promise<(JobRecord | null)[]> {
    const queue = this.#queue(q);
    const found = new Map<string, JobRecord | null>();

    for (const id of ids) {
      const job = queue.jobs.get(id);
      found.set(id, job ? { ...job } : null);
    }

    return orderByIds(ids, found);
  }

  async registerWorker(q: QueueRef, worker: WorkerInfo): Promise<void> {
    const queue = this.#queue(q);

    // Records lapsed as of this report go now, not only when somebody lists.
    for (const [id, other] of queue.workers) {
      if (other.expiresAt <= worker.heartbeatAt) {
        queue.workers.delete(id);
      }
    }

    queue.workers.set(worker.id, { ...worker });
  }

  async removeWorker(q: QueueRef, id: string): Promise<boolean> {
    return this.#queue(q).workers.delete(id);
  }

  async listWorkers(q: QueueRef, now: number): Promise<WorkerInfo[]> {
    const queue = this.#queue(q);
    const live: WorkerInfo[] = [];

    for (const [id, worker] of queue.workers) {
      if (worker.expiresAt > now) {
        live.push({ ...worker });
      } else {
        queue.workers.delete(id);
      }
    }

    return sortWorkers(live);
  }

  async countJobsByQueue(
    ns: string,
  ): Promise<Record<string, Record<JobState, number>>> {
    const result: Record<string, Record<JobState, number>> = {};

    for (const name of this.#namespaces.get(ns)?.queues.keys() ?? []) {
      result[name] = await this.countJobs({ ns, queue: name });
    }

    return result;
  }

  /**
   * One pass over each queue's jobs, as {@link countJobsByQueue} makes: the
   * reference `countAddedByScan` applied to what is stored. A queue with no
   * job in the range is left out.
   */
  async countAddedJobs(
    ns: string,
    range: AddedRange,
    queue?: string,
  ): Promise<Record<string, Record<JobState, number>>> {
    const result: Record<string, Record<JobState, number>> = {};

    if (rangeMatchesNothing(range)) {
      return result;
    }

    const queues = this.#namespaces.get(ns)?.queues;

    for (const [name, state] of queues ?? []) {
      if (queue !== undefined && name !== queue) {
        continue;
      }

      const jobs = [...state.jobs.values()];

      if (jobs.some((job) => inAddedRange(range, job.createdAt))) {
        result[name] = countAddedByScan(jobs, range);
      }
    }

    return result;
  }

  async getThroughput(
    q: QueueRef,
    range: { from: number; to: number },
  ): Promise<ThroughputBucket[]> {
    return sumBuckets(this.#queue(q).throughput.values(), range);
  }

  /**
   * Counts a completion or a failed attempt in the minute of `now`, and drops
   * minutes past the retention once a new minute starts — so the sweep runs
   * once a minute at most, never per job.
   *
   * The same event is counted into the analytics buckets, which are the same
   * numbers at whatever widths this driver records — `getQueueMetrics` has no
   * other writer, so a queue's series is made here or nowhere.
   */
  #count(
    q: QueueRef,
    queue: QueueState,
    now: number,
    kind: "completed" | "failed",
  ): void {
    const counting = this.#countingBuckets(q, queue, now);

    for (const bucket of counting.buckets) {
      bucket[kind] += 1;
    }
    counting.throughput[kind] += 1;
  }

  /**
   * The buckets a count of `queue` at `now` lands in: the cached set while
   * `now` is in the same second and no sweep has run since, found afresh
   * otherwise. Every width is a whole number of the finest, so one second
   * shares every width's bucket.
   */
  #countingBuckets(
    q: QueueRef,
    queue: QueueState,
    now: number,
  ): CountingBuckets {
    const intervals = this.#metrics.intervals;
    const second = bucketStart(now, intervals[0] ?? SECOND_BUCKET_MS);
    const cached = queue.counting;

    if (
      cached !== undefined &&
      cached.second === second &&
      cached.generation === this.#metricsGeneration
    ) {
      return cached;
    }

    const entities = this.#namespace(q.ns).metrics.jobs;
    const targets =
      q.queue === NAMESPACE_ENTITY
        ? [this.#series(entities, q.queue)]
        : [
            this.#series(entities, q.queue),
            this.#series(entities, NAMESPACE_ENTITY),
          ];
    const buckets: JobCounters[] = [];

    for (const interval of intervals) {
      for (const series of targets) {
        buckets.push(
          this.#bucket(
            series,
            interval,
            now,
            () => zeroCounters(JOB_COUNTERS) as JobCounters,
          ),
        );
      }
    }

    const at = throughputBucket(now);
    let throughput = queue.throughput.get(at);

    if (!throughput) {
      throughput = { at, completed: 0, failed: 0 };
      queue.throughput.set(at, throughput);

      for (const minute of queue.throughput.keys()) {
        if (minute < at - THROUGHPUT_RETENTION_MS) {
          queue.throughput.delete(minute);
        }
      }
    }

    const counting: CountingBuckets = {
      second,
      generation: this.#metricsGeneration,
      buckets,
      throughput,
    };
    queue.counting = counting;
    return counting;
  }

  /* --- analytics ---------------------------------------------------- */

  /**
   * Everything, at one-second resolution, unless the constructor said
   * otherwise: a `Map` update costs nothing, so there is no backend limit to
   * report here.
   */
  getMetricsSupport(): MetricsSupport {
    return metricsSupportOf(this.#metrics);
  }

  /**
   * Nothing is gathered in memory *and unwritten*: a count in this driver is
   * the write. Implemented anyway so a worker or runner closing need not ask
   * which backend it has.
   */
  async flushMetrics(): Promise<void> {
    // Already written, by the time `count…` returned.
  }

  async getQueueMetrics(
    q: QueueRef,
    query: MetricsQuery,
  ): Promise<CounterBucket<JobCounters>[]> {
    return this.#readCounters(
      this.#namespaces.get(q.ns)?.metrics.jobs,
      q.queue,
      query,
      JOB_COUNTERS,
    );
  }

  async countWorkerJobs(
    q: QueueRef,
    key: string,
    at: number,
    counts: Partial<JobCounters>,
  ): Promise<void> {
    if (!this.#metrics.workers) {
      return;
    }

    this.#countMetric(
      this.#namespace(q.ns).metrics.workerJobs,
      workerEntity(q, key),
      at,
      counts,
      JOB_COUNTERS,
    );
    this.#pruneMetrics(at);
  }

  async sampleWorkerBusyness(
    q: QueueRef,
    key: string,
    at: number,
    sample: BusynessSample,
  ): Promise<void> {
    if (!this.#metrics.workers) {
      return;
    }

    const series = this.#series(
      this.#namespace(q.ns).metrics.busyness,
      workerEntity(q, key),
    );

    for (const interval of this.#metrics.intervals) {
      // `at` itself, not the bucket's start: which sample is the latest is
      // what makes a merged bucket's `concurrency` well defined.
      addBusynessSample(
        this.#bucket(series, interval, at, emptyBusynessStats),
        at,
        sample,
      );
    }

    this.#pruneMetrics(at);
  }

  async getWorkerMetrics(
    q: QueueRef,
    key: string,
    query: WorkerMetricsQuery,
  ): Promise<WorkerMetricsRead> {
    return this.#readWorker(
      this.#namespaces.get(q.ns)?.metrics,
      workerEntity(q, key),
      query,
    );
  }

  /**
   * Every worker key's totals, by reducing each one's own read with
   * `workerTotalsOf` — the definition the other backends' `GROUP BY` is
   * compared against, so this is the reference by construction.
   */
  async getWorkerMetricsTotals(
    ns: string,
    query: WorkerMetricsTotalsQuery,
  ): Promise<WorkerMetricsTotals[]> {
    const metrics = this.#namespaces.get(ns)?.metrics;
    if (!metrics) {
      return [];
    }

    const queues =
      query.queues === undefined ? undefined : new Set(query.queues);
    // A worker that only reported busyness has no job series, so its name is
    // found under busyness — when that was asked for.
    const entities = new Set([
      ...metrics.workerJobs.keys(),
      ...(query.busyness ? metrics.busyness.keys() : []),
    ]);
    const rows: WorkerMetricsTotals[] = [];

    for (const entity of entities) {
      // The roll-up splits to nothing, so it is never a row.
      const ref = splitWorkerMetricsEntity(entity);
      if (!ref || (queues && !queues.has(ref.queue))) {
        continue;
      }

      const totals = workerTotalsOf(this.#readWorker(metrics, entity, query));
      if (totals) {
        rows.push({ ...ref, ...totals });
      }
    }

    return rows;
  }

  async getWorkerMetricsMany(
    ns: string,
    workers: readonly WorkerMetricsRef[],
    query: WorkerMetricsQuery,
  ): Promise<WorkerMetricsSeries[]> {
    const metrics = this.#namespaces.get(ns)?.metrics;
    const series: WorkerMetricsSeries[] = [];

    for (const ref of uniqueWorkerRefs(workers)) {
      const read = this.#readWorker(metrics, workerEntity(ref, ref.key), query);
      if (hasMetricBuckets(read.jobs, read.busyness)) {
        series.push({ ...ref, ...read });
      }
    }

    return series;
  }

  /** One worker entity's read: `getWorkerMetrics` without the name encoding. */
  #readWorker(
    metrics: MetricsState | undefined,
    entity: string,
    query: WorkerMetricsQuery,
  ): WorkerMetricsRead {
    const read: WorkerMetricsRead = {
      jobs: this.#readCounters(
        metrics?.workerJobs,
        entity,
        query,
        JOB_COUNTERS,
      ),
    };

    if (query.busyness && this.#metrics.workers) {
      read.busyness = mergeBusynessBuckets(
        this.#rows(metrics?.busyness.get(entity), query.interval),
        query,
      );
    }

    return read;
  }

  async countRunnerRun(
    ns: string,
    runner: string,
    at: number,
    counts: RunnerRunDelta,
  ): Promise<void> {
    if (!this.#metrics.runners) {
      return;
    }

    const metrics = this.#namespace(ns).metrics;
    this.#countMetric(metrics.runs, runner, at, counts, RUNNER_RUN_COUNTERS);

    // One call per run event, the duration riding with the outcome: the
    // histogram costs no write of its own.
    if (this.#metrics.durations && counts.durationMs !== undefined) {
      const series = this.#series(metrics.durations, runner);

      for (const interval of this.#metrics.intervals) {
        addDuration(
          this.#bucket(series, interval, at, emptyDurationStats),
          counts.durationMs,
        );
      }
    }

    this.#pruneMetrics(at);
  }

  async getRunnerMetrics(
    ns: string,
    runner: string,
    query: RunnerMetricsQuery,
  ): Promise<RunnerMetricsRead> {
    return this.#readRunner(this.#namespaces.get(ns)?.metrics, runner, query);
  }

  /**
   * Every runner's totals, by reducing each one's own read with
   * `runnerTotalsOf` — the reference the engine-side sums are compared to.
   */
  async getRunnerMetricsTotals(
    ns: string,
    query: RunnerMetricsTotalsQuery,
  ): Promise<RunnerMetricsTotals[]> {
    const metrics = this.#namespaces.get(ns)?.metrics;
    if (!metrics) {
      return [];
    }

    // The filter, when there is one, *is* the candidate list: an empty one
    // answers nothing rather than falling through to every runner.
    const runners = new Set(
      query.runners ?? [
        ...metrics.runs.keys(),
        ...(query.durations ? metrics.durations.keys() : []),
      ],
    );
    const rows: RunnerMetricsTotals[] = [];

    for (const runner of runners) {
      if (runner === NAMESPACE_ENTITY) {
        continue;
      }

      const totals = runnerTotalsOf(this.#readRunner(metrics, runner, query));
      if (totals) {
        rows.push({ runner, ...totals });
      }
    }

    return rows;
  }

  async getRunnerMetricsMany(
    ns: string,
    runners: readonly string[],
    query: RunnerMetricsQuery,
  ): Promise<RunnerMetricsSeries[]> {
    const metrics = this.#namespaces.get(ns)?.metrics;
    const series: RunnerMetricsSeries[] = [];

    for (const runner of new Set(runners)) {
      // `getRunnerMetrics(ns, "")` happens to answer the roll-up; a batch of
      // entities never does.
      if (runner === NAMESPACE_ENTITY) {
        continue;
      }

      const read = this.#readRunner(metrics, runner, query);
      if (hasMetricBuckets(read.runs, read.durations)) {
        series.push({ runner, ...read });
      }
    }

    return series;
  }

  /** One runner's read, from a namespace's buckets that may not exist yet. */
  #readRunner(
    metrics: MetricsState | undefined,
    runner: string,
    query: RunnerMetricsQuery,
  ): RunnerMetricsRead {
    const read: RunnerMetricsRead = {
      runs: this.#readCounters(
        metrics?.runs,
        runner,
        query,
        RUNNER_RUN_COUNTERS,
      ),
    };

    if (query.durations && this.#metrics.durations) {
      read.durations = mergeDurationBuckets(
        this.#rows(metrics?.durations.get(runner), query.interval),
        query,
      );
    }

    return read;
  }

  async getNamespaceMetrics(
    ns: string,
    query: NamespaceMetricsQuery,
  ): Promise<NamespaceMetricsRead> {
    const metrics = this.#namespaces.get(ns)?.metrics;
    const read: NamespaceMetricsRead = {};

    // A kind that is not recorded stays absent rather than answering zeros:
    // "nothing happened" and "nothing is kept" are different answers.
    if (query.kinds.includes("jobs")) {
      read.jobs = this.#readCounters(
        metrics?.jobs,
        NAMESPACE_ENTITY,
        query,
        JOB_COUNTERS,
      );
    }
    if (query.kinds.includes("runs") && this.#metrics.runners) {
      read.runs = this.#readCounters(
        metrics?.runs,
        NAMESPACE_ENTITY,
        query,
        RUNNER_RUN_COUNTERS,
      );
    }
    if (query.kinds.includes("workerJobs") && this.#metrics.workers) {
      read.workerJobs = this.#readCounters(
        metrics?.workerJobs,
        NAMESPACE_ENTITY,
        query,
        JOB_COUNTERS,
      );
    }

    return read;
  }

  /**
   * Counts one entity's event into every width recorded — and, in the same
   * pass, into the namespace's own roll-up.
   *
   * The roll-up is what makes an overview three reads whatever the fleet size,
   * and it is written here rather than summed on read because summing would be
   * a read per entity per refresh. It is stored as the entity
   * {@link NAMESPACE_ENTITY}, so nothing downstream needs a second code path.
   */
  #countMetric<C extends Record<keyof C, number>>(
    /** The kind's entities. */
    entities: Map<string, IntervalBuckets<C>>,
    /** The queue, worker key or runner id. */
    entity: string,
    /** When it happened, epoch ms; floored to each width. */
    at: number,
    /** The deltas; anything absent is zero. */
    counts: Partial<C>,
    /** The counters this kind carries. */
    keys: readonly (keyof C & string)[],
  ): void {
    if (!keys.some((key) => (counts[key] ?? 0) !== 0)) {
      return;
    }

    const targets =
      entity === NAMESPACE_ENTITY ? [entity] : [entity, NAMESPACE_ENTITY];

    for (const interval of this.#metrics.intervals) {
      for (const target of targets) {
        const bucket = this.#bucket(
          this.#series(entities, target),
          interval,
          at,
          // Every counter present, so a merge is a plain addition.
          () => zeroCounters(keys) as C,
        );

        for (const key of keys) {
          bucket[key] = ((bucket[key] ?? 0) + (counts[key] ?? 0)) as C[keyof C &
            string];
        }
      }
    }
  }

  /** One entity's buckets within a kind, created on first use. */
  #series<T>(
    entities: Map<string, IntervalBuckets<T>>,
    entity: string,
  ): IntervalBuckets<T> {
    let series = entities.get(entity);
    if (!series) {
      series = new Map();
      entities.set(entity, series);
    }
    return series;
  }

  /** The bucket of `interval` that `at` falls in, created on first use. */
  #bucket<T>(
    series: IntervalBuckets<T>,
    interval: number,
    at: number,
    empty: () => T,
  ): T {
    let buckets = series.get(interval);
    if (!buckets) {
      buckets = new Map();
      series.set(interval, buckets);
    }

    const start = bucketStart(at, interval);
    let bucket = buckets.get(start);
    if (!bucket) {
      bucket = empty();
      buckets.set(start, bucket);
    }
    return bucket;
  }

  /** One series' stored buckets at a width, as rows the merge helpers take. */
  #rows<T>(
    series: IntervalBuckets<T> | undefined,
    interval: number,
  ): ({ at: number } & T)[] {
    return [...(series?.get(interval) ?? [])].map(([at, stats]) => ({
      at,
      ...stats,
    }));
  }

  /** One entity's counters in range, sparse and oldest first. */
  #readCounters<K extends string>(
    entities: Map<string, IntervalBuckets<Record<K, number>>> | undefined,
    entity: string,
    query: MetricsQuery,
    keys: readonly K[],
  ): CounterBucket<Record<K, number>>[] {
    return mergeCounterBuckets(
      this.#rows(entities?.get(entity), query.interval),
      query,
      keys,
    );
  }

  /**
   * Drops every analytics bucket past its width's retention, once a minute per
   * process.
   *
   * By range over every entity, not per entity as it is written: a worker that
   * stopped reporting would otherwise keep its buckets for good, since nothing
   * writes to its series again. The sweep is the whole of memory, so the clock
   * is what keeps it off the counting path.
   *
   * `at` is the event's own time, and the later of it and the wall clock
   * drives the clock — so a caller that passes times in, as the contract suite
   * does, can step the sweep forward instead of waiting a minute for it.
   */
  #pruneMetrics(at: number): void {
    const now = Math.max(Date.now(), at);

    if (!this.#metricsPrune.due(now)) {
      return;
    }

    this.#metricsGeneration += 1;

    for (const namespace of this.#namespaces.values()) {
      const metrics = namespace.metrics;

      for (const entities of [
        metrics.jobs,
        metrics.workerJobs,
        metrics.busyness,
        metrics.runs,
        metrics.durations,
      ] as Map<string, IntervalBuckets<unknown>>[]) {
        this.#pruneSeries(entities, now);
      }
    }
  }

  /** One kind's entities swept: every bucket below its width's cutoff goes. */
  #pruneSeries(
    entities: Map<string, IntervalBuckets<unknown>>,
    now: number,
  ): void {
    for (const [entity, series] of entities) {
      for (const [interval, buckets] of series) {
        const cutoff = metricsPruneCutoff(this.#metrics, interval, now);

        for (const start of buckets.keys()) {
          if (start < cutoff) {
            buckets.delete(start);
          }
        }

        if (buckets.size === 0) {
          series.delete(interval);
        }
      }

      if (series.size === 0) {
        entities.delete(entity);
      }
    }
  }

  async removeJob(q: QueueRef, id: string): Promise<boolean> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);
    if (!job || job.state === "active") {
      return false;
    }

    return this.#delete(queue, id);
  }

  async retryJob(
    q: QueueRef,
    id: string,
    resetAttempts: boolean,
    now: number,
  ): Promise<boolean> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);
    // A parent waiting on children is not finished; moving it would run it
    // before they settle.
    if (
      !job ||
      job.state === "active" ||
      job.state === "waiting" ||
      job.state === "waiting-children"
    ) {
      return false;
    }

    this.#setState(queue, job, "waiting");
    job.runAt = now;
    job.finishedOn = null;
    job.expiresAt = null;
    if (job.flow) {
      // The outcome it ends with this time has not reached its parent.
      job.flow.recorded = false;
    }
    if (resetAttempts) {
      job.attemptsMade = 0;
      job.stalledCount = 0;
    }

    this.#wake(this.#queue(q));
    return true;
  }

  async promoteJob(q: QueueRef, id: string, now: number): Promise<boolean> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);
    if (!job || (job.state !== "delayed" && job.state !== "failed")) {
      return false;
    }

    this.#setState(queue, job, "waiting");
    job.runAt = now;
    this.#wake(queue);
    return true;
  }

  async promoteDelayed(
    q: QueueRef,
    now: number,
    limit: number,
  ): Promise<number> {
    return this.#promoteDue(this.#queue(q), now, limit);
  }

  async recoverStalled(
    q: QueueRef,
    now: number,
    maxStalledCount: number,
    limit: number,
  ): Promise<{ requeued: string[]; dead: string[] }> {
    const queue = this.#queue(q);
    const requeued: string[] = [];
    const dead: string[] = [];

    for (const job of queue.jobs.values()) {
      if (requeued.length + dead.length >= limit) {
        break;
      }

      if (
        job.state !== "active" ||
        job.lockExpiresAt === null ||
        job.lockExpiresAt > now
      ) {
        continue;
      }

      job.stalledCount += 1;
      job.lockToken = null;
      job.lockExpiresAt = null;
      job.workerId = null;

      if (job.stalledCount > maxStalledCount) {
        job.finishedOn = now;
        this.#setState(queue, job, "dead");
        this.#count(q, queue, now, "failed");
        dead.push(job.id);
      } else {
        this.#setState(queue, job, "waiting");
        job.runAt = now;
        requeued.push(job.id);
      }
    }

    if (requeued.length > 0) {
      this.#wake(queue);
    }

    return { requeued, dead };
  }

  async cleanJobs(
    q: QueueRef,
    state:
      | "completed"
      | "failed"
      | "dead"
      | "waiting"
      | "delayed"
      | "waiting-children",
    olderThanMs: number,
    limit: number,
    now: number,
  ): Promise<string[]> {
    const queue = this.#queue(q);
    const cutoff = now - olderThanMs;
    const removed: string[] = [];

    for (const job of [...queue.jobs.values()]) {
      if (removed.length >= limit) {
        break;
      }

      if (job.state !== state) {
        continue;
      }

      const stamp = job.finishedOn ?? job.createdAt;
      if (stamp <= cutoff) {
        this.#delete(queue, job.id);
        removed.push(job.id);
      }
    }

    return removed;
  }

  async pruneExpired(q: QueueRef, now: number, limit: number): Promise<number> {
    const queue = this.#queue(q);
    let removed = 0;

    for (const job of [...queue.jobs.values()]) {
      if (removed >= limit) {
        break;
      }

      if (
        job.expiresAt !== null &&
        job.expiresAt <= now &&
        !awaitsDelivery(job)
      ) {
        this.#delete(queue, job.id);
        removed++;
      }
    }

    return removed;
  }

  async drainQueue(q: QueueRef, includeDelayed: boolean): Promise<number> {
    const queue = this.#queue(q);
    let removed = 0;

    for (const job of [...queue.jobs.values()]) {
      const drainable =
        job.state === "waiting" ||
        job.state === "waiting-children" ||
        (includeDelayed && SCHEDULED_STATES.includes(job.state));

      if (drainable) {
        this.#delete(queue, job.id);
        removed++;
      }
    }

    return removed;
  }

  async getQueueState(
    q: QueueRef,
    name: string,
  ): Promise<QueueStateEntry | null> {
    const entry = this.#queue(q).state.get(name);
    return entry
      ? { value: jsonClone(entry.value), version: entry.version }
      : null;
  }

  async setQueueState(
    q: QueueRef,
    name: string,
    value: unknown,
    expected: number | null,
    options?: { internal?: symbol },
  ): Promise<number | null> {
    assertWritableStateName(name, options);

    const state = this.#queue(q).state;
    const current = state.get(name);

    if ((current?.version ?? null) !== expected) {
      return null;
    }

    if (value === null) {
      state.delete(name);
      return 0;
    }

    const version = (current?.version ?? 0) + 1;
    state.set(name, { value: jsonClone(value), version });
    return version;
  }

  async listQueueState(
    q: QueueRef,
    options: { prefix: string; after?: string; limit: number },
  ): Promise<string[]> {
    const names = [...this.#queue(q).state.keys()]
      .filter(
        (name) =>
          name.startsWith(options.prefix) &&
          (options.after === undefined ||
            compareCodePoints(name, options.after) > 0),
      )
      .sort(compareCodePoints);

    return names.slice(0, Math.max(0, options.limit));
  }

  async pauseQueue(q: QueueRef): Promise<void> {
    this.#queue(q).paused = true;
  }

  async resumeQueue(q: QueueRef): Promise<void> {
    const queue = this.#queue(q);
    queue.paused = false;
    this.#wake(queue);
  }

  async isQueuePaused(q: QueueRef): Promise<boolean> {
    return this.#queue(q).paused;
  }

  /* --- queue: repeats ---------------------------------------------- */

  async upsertRepeat(q: QueueRef, def: RepeatRecord): Promise<void> {
    this.#queue(q).repeats.set(def.key, jsonClone(def));
  }

  async getRepeat(q: QueueRef, key: string): Promise<RepeatRecord | null> {
    const repeat = this.#queue(q).repeats.get(key);
    return repeat ? { ...repeat } : null;
  }

  async listRepeats(q: QueueRef): Promise<RepeatRecord[]> {
    return [...this.#queue(q).repeats.values()].map((repeat) => ({
      ...repeat,
    }));
  }

  async removeRepeat(q: QueueRef, key: string): Promise<boolean> {
    return this.#queue(q).repeats.delete(key);
  }

  /* --- queue: waiting & events -------------------------------------- */

  async nextDelayedAt(q: QueueRef): Promise<number | null> {
    const queue = this.#queue(q);

    // Asked on every idle pass: with nothing delayed or failed there is no
    // reason to walk every retained job to find that out.
    if (queue.scheduled.size === 0) {
      queue.due.length = 0;
      return null;
    }

    return this.#earliestDue(queue)?.runAt ?? null;
  }

  async waitForJob(
    q: QueueRef,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const queue = this.#queue(q);

    // A paused queue has nothing claimable however many jobs are waiting;
    // saying otherwise turns a caller's wait loop into a busy loop.
    // The waiting index holds exactly the jobs that could be claimable, so
    // this asks it rather than copying and walking every retained job.
    const claimable =
      !queue.paused && this.#firstClaimable(queue, Date.now()) !== null;

    if (claimable || signal?.aborted || timeoutMs <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        queue.waiters.delete(finish);
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };

      timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      queue.waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  async publish(event: DriverEvent): Promise<void> {
    const namespace = this.#namespace(event.ns);
    const listeners = namespace.subscribers.get(
      `${event.kind}:${event.target}`,
    );

    for (const listener of listeners ?? []) {
      listener(event);
    }
  }

  async subscribe<TKind extends EventKind>(
    ns: string,
    kind: TKind,
    target: string,
    listener: (event: EventOfKind<TKind>) => void,
  ): Promise<() => Promise<void>> {
    // Widened once, here, because everything below works on the envelope
    // rather than on one subsystem's events. The narrowing is the caller's:
    // asking for `"queue"` is what makes their listener see queue events only.
    const deliver = listener as (event: DriverEvent) => void;

    const namespace = this.#namespace(ns);
    const key = `${kind}:${target}`;
    const listeners = namespace.subscribers.get(key) ?? new Set();
    listeners.add(deliver);
    namespace.subscribers.set(key, listeners);

    return async () => {
      listeners.delete(deliver);
      if (listeners.size === 0) {
        namespace.subscribers.delete(key);
      }
    };
  }

  /* --- internals ---------------------------------------------------- */

  /** The namespace's state, created on first use. */
  #namespace(ns: string): NamespaceState {
    let namespace = this.#namespaces.get(ns);
    if (!namespace) {
      namespace = {
        runners: new Map(),
        queues: new Map(),
        subscribers: new Map(),
        metrics: {
          jobs: new Map(),
          workerJobs: new Map(),
          busyness: new Map(),
          runs: new Map(),
          durations: new Map(),
        },
      };
      this.#namespaces.set(ns, namespace);
    }
    return namespace;
  }

  /** A runner's state, created on first use. */
  #runner(ns: string, key: string): RunnerState {
    const namespace = this.#namespace(ns);
    let runner = namespace.runners.get(key);
    if (!runner) {
      runner = {
        fields: new Map(),
        history: [],
        queued: [],
        runLogs: new Map(),
      };
      namespace.runners.set(key, runner);
    }
    return runner;
  }

  /**
   * A runner's state if it already has any, without bringing one into being.
   *
   * Every read goes through this rather than {@link MemoryDriver.#runner}:
   * asking a question about a runner must not create it. It used to, so
   * merely inspecting an id — which `info()` does through `getLock` and
   * `getState` — put that id into `listRunners()` for good, and kept its
   * namespace alive for as long as the driver. Every other driver answers a
   * read without writing; this is that behaviour.
   */
  #existingRunner(ns: string, key: string): RunnerState | undefined {
    return this.#namespaces.get(ns)?.runners.get(key);
  }

  /** A queue's state, created on first use. */
  #queue(q: QueueRef): QueueState {
    const namespace = this.#namespace(q.ns);
    let queue = namespace.queues.get(q.queue);
    if (!queue) {
      queue = {
        jobs: new Map(),
        order: new Map(),
        waiting: [],
        waitingFrom: 0,
        scheduled: new Set(),
        due: [],
        finished: {
          completed: { ids: [], from: 0, keys: new Map() },
          dead: { ids: [], from: 0, keys: new Map() },
        },
        repeats: new Map(),
        logs: new Map(),
        state: new Map(),
        workers: new Map(),
        throughput: new Map(),
        paused: false,
        seq: 0,
        waiters: new Set(),
      };
      namespace.queues.set(q.queue, queue);
    }
    return queue;
  }

  /** Releases everyone waiting for work. */
  #wake(queue: QueueState): void {
    for (const wake of [...queue.waiters]) {
      wake();
    }
  }

  /** Removes a job and its ordering entry. */
  #delete(queue: QueueState, id: string): boolean {
    const job = queue.jobs.get(id);

    if (job) {
      this.#leaveIndexes(queue, job);
    }

    queue.order.delete(id);
    queue.logs.delete(id);

    // Only a waiting job is in the waiting index (`#setState` keeps it so), and
    // looking for any other is a scan of the whole backlog that must miss —
    // paid by every `removeOnComplete: true` completion, prune and clean.
    if (job?.state === "waiting") {
      this.#leaveWaiting(queue, id);
    }
    return queue.jobs.delete(id);
  }

  /** Claim order: priority, then when it was added, then insertion order. */
  /**
   * Moves a job to a new state, keeping the waiting index in step.
   *
   * Every state change in this driver goes through here. That is the whole
   * design: an index maintained at nine separate assignment sites is an index
   * that goes stale the first time someone adds a tenth, and a stale one here
   * means a job that is never claimed.
   */
  #setState(queue: QueueState, job: JobRecord, state: JobState): void {
    if (job.state === state) {
      return;
    }

    if (job.state === "waiting") {
      this.#leaveWaiting(queue, job.id);
    }

    this.#leaveIndexes(queue, job);
    job.state = state;

    if (state === "waiting") {
      this.#enterWaiting(queue, job);
    }

    this.#enterIndexes(queue, job);
  }

  /**
   * Puts a job in the scheduled or finished index its state keeps. Read by
   * key, so the caller sets `runAt` or `finishedOn` **before** the state.
   */
  #enterIndexes(queue: QueueState, job: JobRecord): void {
    switch (job.state) {
      case "delayed":
      case "failed":
        queue.scheduled.add(job.id);
        duePush(queue.due, { runAt: job.runAt, seq: dueSeq++, id: job.id });
        return;
      case "completed":
      case "dead":
        this.#enterFinished(queue, queue.finished[job.state], job);
    }
  }

  /** Takes a job out of the scheduled or finished index its state keeps. */
  #leaveIndexes(queue: QueueState, job: JobRecord): void {
    switch (job.state) {
      case "delayed":
      case "failed":
        // Its heap entry is dropped when it surfaces.
        queue.scheduled.delete(job.id);
        return;
      case "completed":
      case "dead":
        this.#leaveFinished(queue, queue.finished[job.state], job.id);
    }
  }

  /** Whether finished job `a` (key, id) sorts before `b` in retention order. */
  #finishedBefore(
    queue: QueueState,
    aKey: number,
    aId: string,
    bKey: number,
    bId: string,
  ): boolean {
    if (aKey !== bKey) {
      return aKey < bKey;
    }
    // At an equal time the later added comes first: it is the one the old
    // newest-first stable sort placed last, so the first to go.
    return (queue.order.get(aId) ?? 0) > (queue.order.get(bId) ?? 0);
  }

  /** Inserts a finished job into its state's retention order. */
  #enterFinished(
    queue: QueueState,
    index: FinishedIndex,
    job: JobRecord,
  ): void {
    const key = job.finishedOn ?? job.createdAt;
    let low = index.from;
    let high = index.ids.length;

    // Upper bound: finishing is almost always the newest, so this lands at
    // the end and the splice moves nothing.
    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = index.ids[middle]!;

      if (
        this.#finishedBefore(
          queue,
          key,
          job.id,
          index.keys.get(other) ?? 0,
          other,
        )
      ) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }

    index.ids.splice(low, 0, job.id);
    index.keys.set(job.id, key);
  }

  /** Takes a job out of its finished state's retention order. */
  #leaveFinished(queue: QueueState, index: FinishedIndex, id: string): void {
    const key = index.keys.get(id);
    if (key === undefined) {
      return;
    }
    index.keys.delete(id);

    // Lower bound on the key, then along the equal keys to the id.
    let low = index.from;
    let high = index.ids.length;

    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((index.keys.get(index.ids[middle]!) ?? key) < key) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    let at = -1;
    for (let scan = low; scan < index.ids.length; scan++) {
      if (index.ids[scan] === id) {
        at = scan;
        break;
      }
      if (index.keys.get(index.ids[scan]!) !== key) {
        break;
      }
    }
    if (at < 0) {
      at = index.ids.indexOf(id, index.from);
      if (at < 0) {
        return;
      }
    }

    if (at === index.from) {
      index.from++;

      if (index.from > COMPACT_AFTER && index.from * 2 > index.ids.length) {
        index.ids = index.ids.slice(index.from);
        index.from = 0;
      }
      return;
    }

    index.ids.splice(at, 1);
  }

  /** The first waiting job that is due, in claim order, or `null`. */
  #firstClaimable(
    queue: QueueState,
    now: number,
    excludeNames?: string[],
  ): JobRecord | null {
    const excluded =
      excludeNames && excludeNames.length > 0 ? new Set(excludeNames) : null;

    for (let at = queue.waitingFrom; at < queue.waiting.length; at++) {
      const job = queue.jobs.get(queue.waiting[at]!);

      if (
        job &&
        job.state === "waiting" &&
        job.runAt <= now &&
        !excluded?.has(job.name)
      ) {
        return job;
      }
    }

    return null;
  }

  /** Inserts a job into the waiting index, in claim order. */
  #enterWaiting(queue: QueueState, job: JobRecord): void {
    // Binary search for the insertion point rather than pushing and re-sorting:
    // the list is already ordered, so placing one job is a comparison per
    // halving rather than a sort of the whole thing.
    let low = queue.waitingFrom;
    let high = queue.waiting.length;

    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = queue.jobs.get(queue.waiting[middle]!);

      if (other && this.#compareWaiting(queue, other, job) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    queue.waiting.splice(low, 0, job.id);
  }

  /** Takes a job out of the waiting index. */
  #leaveWaiting(queue: QueueState, id: string): void {
    const at = queue.waiting.indexOf(id, queue.waitingFrom);

    if (at < 0) {
      return;
    }

    // Taking the head is the common case — that is what claiming does — and
    // moving the cursor costs nothing where splicing would move the rest of
    // the array.
    if (at === queue.waitingFrom) {
      queue.waitingFrom++;

      // Compact once the dead prefix is most of the array, so the copy is paid
      // once per many claims rather than once per claim.
      if (
        queue.waitingFrom > COMPACT_AFTER &&
        queue.waitingFrom * 2 > queue.waiting.length
      ) {
        queue.waiting = queue.waiting.slice(queue.waitingFrom);
        queue.waitingFrom = 0;
      }

      return;
    }

    queue.waiting.splice(at, 1);
  }

  #compareWaiting(queue: QueueState, a: JobRecord, b: JobRecord): number {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    return (queue.order.get(a.id) ?? 0) - (queue.order.get(b.id) ?? 0);
  }

  /**
   * The timestamp a state is naturally ordered by. Listing several states at
   * once falls back to creation time, the only key they all share.
   */
  #sortKey(job: JobRecord, single: JobState | undefined): number {
    switch (single) {
      case "delayed":
      case "failed":
        return job.runAt;
      case "active":
        return job.lockExpiresAt ?? job.processedOn ?? job.createdAt;
      case "completed":
      case "dead":
        return job.finishedOn ?? job.createdAt;
      default:
        return job.createdAt;
    }
  }

  /** Moves due `delayed`/`failed` jobs to `waiting`; returns how many moved. */
  #promoteDue(queue: QueueState, now: number, limit: number): number {
    // Nothing is delayed or failed, so there is nothing to promote and no
    // reason to look at every job in the queue to find that out.
    if (queue.scheduled.size === 0) {
      queue.due.length = 0;
      return 0;
    }

    let promoted = 0;

    while (promoted < limit) {
      const job = this.#earliestDue(queue);

      if (!job || job.runAt > now) {
        break;
      }

      duePop(queue.due);
      this.#setState(queue, job, "waiting");
      promoted++;
    }

    if (promoted > 0) {
      this.#wake(queue);
    }

    return promoted;
  }

  /**
   * The scheduled job at the top of {@link QueueState.due}, with the entries
   * above it that no longer describe a scheduled job dropped (and one whose
   * job's `runAt` moved put back at the new time). Rebuilds the heap from
   * {@link QueueState.scheduled} once stale entries outnumber live ones.
   */
  #earliestDue(queue: QueueState): JobRecord | null {
    if (queue.due.length > 2 * queue.scheduled.size + 1024) {
      queue.due = [];
      for (const id of queue.scheduled) {
        const job = queue.jobs.get(id);
        if (job) {
          duePush(queue.due, { runAt: job.runAt, seq: dueSeq++, id });
        }
      }
    }

    for (;;) {
      const top = queue.due[0];
      if (top === undefined) {
        return null;
      }

      const job = queue.jobs.get(top.id);
      if (!job || !queue.scheduled.has(top.id)) {
        duePop(queue.due);
        continue;
      }
      if (job.runAt !== top.runAt) {
        duePop(queue.due);
        duePush(queue.due, { runAt: job.runAt, seq: dueSeq++, id: job.id });
        continue;
      }
      return job;
    }
  }

  /**
   * Applies retention to a job that just finished: remove it now, cap how
   * many of its state are kept, and/or stamp when it expires.
   */
  #applyRetention(
    queue: QueueState,
    job: JobRecord,
    retention: Retention,
    now: number,
  ): void {
    if (retention === true) {
      this.#delete(queue, job.id);
      return;
    }

    if (retention === false || retention === undefined) {
      job.expiresAt = null;
      return;
    }

    const count = typeof retention === "number" ? retention : retention.count;
    const ttl = typeof retention === "number" ? undefined : retention.ttl;

    job.expiresAt = ttl && ttl > 0 ? now + ttl : null;

    if (
      count !== undefined &&
      count >= 0 &&
      (job.state === "completed" || job.state === "dead")
    ) {
      // Everything before the newest `count` of the state goes: usually one
      // job, taken from the front of an index already in that order.
      const index = queue.finished[job.state];
      const end = index.ids.length - count;
      const stale = end > index.from ? index.ids.slice(index.from, end) : [];

      for (const id of stale) {
        const other = queue.jobs.get(id);
        // A child whose parent has not taken its outcome yet stays.
        if (other && !awaitsDelivery(other)) {
          this.#delete(queue, id);
        }
      }
    }
  }
}
