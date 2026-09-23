import type { SerializedError } from "@kingsleyweb/bun-common";
import type { PendingRewritePlan } from "../queue/jobDefaults";
import type { AttributionFilter } from "./attribution";
import type {
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
  PromoteDelayedResult,
  QueuedTrigger,
  QueueRef,
  QueueStateEntry,
  RepeatRecord,
  Retention,
  RunLogAppendResult,
  RunLogCaps,
  RunLogInput,
  RunLogLine,
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
  BufferWriteResult,
  BusynessSample,
  BusynessStats,
  CounterBucket,
  DurationStats,
  JobCounters,
  MetricsOptions,
  MetricsSupport,
  PendingMetric,
  ResolvedMetricsOptions,
  RunnerRunCounters,
  WorkerMetricsRef,
} from "./metrics";
import type { PendingThroughput, ThroughputWriteResult } from "./readApis";
import type { RunHistoryPage, RunHistoryQuery } from "./runHistory";
import type { StoredRunLogLine } from "./runLogs";
import { Buffer } from "node:buffer";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { jsonClone, sleep } from "@kingsleyweb/bun-common";
import { MINUTE_BUCKET_MS } from "../api/contract/constants";
import {
  assertRewriteRequest,
  decodeRewriteCursor,
  emptyRewriteResult,
  encodeRewriteCursor,
  JOB_OPTION_BITS,
  planPendingRewrite,
  tallyMoved,
  tallyRewrite,
} from "../queue/jobDefaults";
import { assertWritableStateName } from "../queue/windows";
import { DriverError } from "../shared/errors";
import { EventRetention } from "../shared/eventRetention";
import { fitName } from "../shared/fit";
import { newId } from "../shared/ids";
import { safeJsonParse } from "../shared/json";
import { PauseCache } from "../shared/pauseCache";
import { compareCodePoints } from "../shared/strings";
import {
  attributionFilter,
  attributionOf,
  canMatchState,
  hasRange,
  inFinishedRange,
  matchesAttribution,
  matchesNothing,
} from "./attribution";
import { canBury } from "./bury";
import {
  decodeName,
  decodeSegment,
  encodeName,
  encodeSegment,
  MAX_ENCODED_NAME,
  NAME_MAX,
  NAME_OVERHEAD,
} from "./file-names";
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
  mergeBusynessStats,
  mergeCounterBuckets,
  mergeDurationBuckets,
  mergeDurationStats,
  MetricsBuffer,
  MetricsPruneClock,
  metricsPruneCutoff,
  metricsSupportOf,
  NAMESPACE_ENTITY,
  PendingBuffer,
  resolveMetricsOptions,
  RUNNER_RUN_COUNTERS,
  runnerTotalsOf,
  uniqueWorkerRefs,
  workerTotalsOf,
} from "./metrics";
import {
  jobFilter,
  matchesFilter,
  orderByIds,
  sortWorkers,
  sumBuckets,
  THROUGHPUT_RETENTION_MS,
  ThroughputBuffer,
} from "./readApis";
import { pageRunHistory } from "./runHistory";
import {
  emptyRunLog,
  pageRunLog,
  readRunLogLine,
  runLogBytes,
  runLogOverflow,
  storeRunLogLine,
} from "./runLogs";

/**
 * A driver backed by a directory, for processes that share a filesystem.
 *
 * It exists because "several processes on one box" is the common case that
 * neither the memory driver (one process) nor Redis/SQL (a service to run)
 * serves well. Everything it guarantees comes from two POSIX primitives:
 * `open(…, "wx")`, which exactly one process can win, and `rename`, which is
 * atomic and fails with `ENOENT` for whoever arrives second. Claiming a job
 * is* renaming its index entry — the process that renames it, has it.
 *
 * Records live at a stable path and the state directories hold empty marker
 * files, so reading a job by id is one read rather than a scan, and a marker
 * that disagrees with its record (a crash between the two writes) is healed
 * on the next claim instead of corrupting anything.
 *
 * Scope: one host, or a filesystem with real POSIX semantics. Not NFS, and
 * `capabilities.multiHost` says so.
 */

/**
 * How long a write lock is respected before it is treated as abandoned.
 *
 * The critical section is one small read and one small write, so a lock held
 * for longer than this belongs to a process that is gone. Keeping it short
 * matters: a crash must not stall every other process for the whole window.
 */
const LOCK_STALE_MS = 1_000;

/** How long to keep trying for a lock that is merely contended. */
const LOCK_WAIT_MS = 15_000;

/** How long to wait between attempts at a contended write lock. */
const LOCK_RETRY_MS = 5;

/**
 * How long a transition keeps retrying a marker somebody else has moved.
 *
 * Twice `LOCK_STALE_MS`, because the marker may be held by a process that
 * died holding it, and a hold is only healed once it is older than that.
 */
const HOLD_PATIENCE_MS = LOCK_STALE_MS * 2;

/** How often `waitForJob` and event subscribers look for changes. */
const POLL_MS = 25;

/** Every job state, in the order `countJobs` reports them. */
const STATES: JobState[] = [
  "waiting",
  "delayed",
  "active",
  "completed",
  "failed",
  "dead",
  // Its own directory, which no claim or promotion ever reads: that is the
  // whole of what keeps a parent waiting on children from running early.
  "waiting-children",
];

/** States holding a job that is due later. */
const SCHEDULED_STATES: JobState[] = ["delayed", "failed"];

/** Priorities may be negative; the offset keeps marker names sortable. */
const PRIORITY_OFFSET = 1_048_576;

/** How many waiting markers' job names a driver remembers for exclusion. */
const NAME_CACHE_SIZE = 10_000;

/**
 * How many jobs `addJobs` creates at once. Each create is independent — its
 * own `O_EXCL` file and marker — so a few in flight keep the thread pool busy
 * instead of waiting on one file at a time.
 */
const ADD_CONCURRENCY = 16;

/**
 * The longest `pruneExpired` goes without re-reading a finished record it found
 * not due (see `#pruneSkips`): five sweeps at the worker's minute cadence.
 */
const PRUNE_SKIP_MS = 5 * 60_000;

/** How many finished markers `pruneExpired` remembers as not due. */
const PRUNE_SKIP_CACHE_SIZE = 100_000;

/** How many job logs' line counts a driver remembers (see `#logCounts`). */
const LOG_COUNT_CACHE_SIZE = 1_000;

/** How many files a read API reads at once: job records, worker records. */
const READ_CONCURRENCY = 16;

/**
 * How many jobs `rewritePendingOptions` changes at once, each under its own
 * hold. A rewrite is a record write plus two renames, so a handful in flight
 * hides the filesystem's latency; more only lengthens the moment a burst of
 * claims finds markers held.
 */
const REWRITE_CONCURRENCY = 16;

/** What a rewrite cursor's key holds here: the last marker examined in its state. */
const REWRITE_CURSOR_KEY = ["string"] as const;

/**
 * A throughput bucket file's name: the minute's start, in epoch milliseconds,
 * then `.jsonl`. Nothing else in `throughput/` matches, `.tmp` files included.
 */
const THROUGHPUT_FILE = /^(\d+)\.jsonl$/;

/**
 * The kinds of analytics series this driver stores, each its own directory
 * under a namespace's `metrics/`.
 *
 * The first three are counters and are exactly `NamespaceMetricKind`, because
 * each of them also carries the namespace's own roll-up; the last two have no
 * roll-up, since nothing in `NamespaceMetricsRead` is made of them.
 */
type MetricKind = "busyness" | "durations" | "jobs" | "runs" | "workerJobs";

/**
 * The entity directory the namespace roll-up is stored under.
 *
 * `encodeName` never emits `-`, so no queue, worker key or runner id can
 * encode to this and share the roll-up's files.
 */
const NAMESPACE_DIR = "-ns";

/**
 * A metric bucket file's name: the bucket's start in epoch milliseconds, then
 * `.jsonl`. One width per driver — minutes — so no start can mean two things.
 */
const METRIC_FILE = /^(\d+)\.jsonl$/;

/**
 * One bucket of a statistic that is not a counter, waiting to be written: the
 * duration and busyness counterpart of `PendingMetric`.
 */
interface PendingStats<S> {
  /** The namespace. */
  ns: string;
  /** The runner id or worker key it belongs to. */
  entity: string;
  /** The bucket's start, epoch ms. */
  at: number;
  /** The bucket's width, ms. */
  interval: number;
  /** What has been gathered for it so far. */
  stats: S;
}

/** What two gathered stats rows are one row by: their bucket, per entity. */
function metricStatsKey(entry: PendingStats<unknown>): string {
  return `${entry.ns}\n${entry.entity}\n${entry.interval}\n${entry.at}`;
}

/**
 * Key of {@link FileDriver}'s `renewLock` test seam: a hook awaited between
 * `renewLock`'s first read of the lock and its locked re-check, so a test can
 * land a release exactly there without timing.
 *
 * Deliberately never exported, and not a declared member of the class, so the
 * seam is no part of the module's surface or its shipped declarations. It is
 * a registered symbol (`Symbol.for`), so this package's own tests reach it by
 * the same description, without an import.
 */
const RENEW_LOCK_GATE = Symbol.for("bun-jobs: FileDriver renewLock gate");

/** The `renewLock` test seam set on `driver`, if a test set one. */
function renewLockGate(driver: object): (() => Promise<void>) | undefined {
  const gate: unknown = Reflect.get(driver, RENEW_LOCK_GATE);
  return typeof gate === "function" ? (gate as () => Promise<void>) : undefined;
}

/**
 * Key of {@link FileDriver}'s `acquireLock` test seam: a hook awaited after
 * `acquireLock` has created `lock.json` exclusively and before it has written
 * the token into it, so a test can land a contender in exactly the moment the
 * file exists but is still empty. Never exported, like `RENEW_LOCK_GATE`.
 */
const ACQUIRE_LOCK_GATE = Symbol.for("bun-jobs: FileDriver acquireLock gate");

/** The `acquireLock` test seam set on `driver`, if a test set one. */
function acquireLockGate(driver: object): (() => Promise<void>) | undefined {
  const gate: unknown = Reflect.get(driver, ACQUIRE_LOCK_GATE);
  return typeof gate === "function" ? (gate as () => Promise<void>) : undefined;
}

/** Whether `held` is a live lock under `token` at `now`. */
function ownsLock(held: LockInfo | null, token: string, now: number): boolean {
  return held !== null && held.token === token && held.expiresAt > now;
}

/** Options for {@link FileDriver}. */
export interface FileDriverOptions {
  /** Directory the driver owns. Created on demand. */
  root: string;
  /**
   * What to record into the analytics buckets.
   *
   * **This backend serves minute resolution only**, whatever is asked for:
   * per-second buckets here would mean a directory listing per queue per flush
   * over thousands of entries, and hundreds of file opens per read.
   * `getMetricsSupport()` reports that, so a range resolves to minutes with
   * `reason: "driver"` rather than being served something that does not exist.
   */
  metrics?: MetricsOptions;
  /** How often to poll for new work and events. Defaults to 25ms. */
  pollInterval?: number;
  /**
   * How long a stored event is kept, in milliseconds.
   *
   * Defaults to an hour. Events are a live notification channel rather than an
   * audit trail, and this backend writes each one down — so without a limit
   * the log grows for as long as the queue runs. Set `0` to keep everything,
   * and prune it yourself.
   */
  eventRetentionMs?: number;
}

export class FileDriver implements JobsDriver {
  /** Identifies the implementation in errors and capability checks. */
  readonly name = "file";
  /** Decides when this driver should prune its stored events. */
  readonly #eventRetention: EventRetention;

  /**
   * Several processes on one host can share this safely. `multiHost` is
   * `false` on purpose: the guarantees rest on POSIX `rename` and `O_EXCL`,
   * which network filesystems do not reliably provide.
   */
  readonly capabilities: DriverCapabilities = {
    blockingWait: false,
    events: "poll",
    multiProcess: true,
    multiHost: false,
    jobAttribution: true,
  };

  /** The directory this driver owns. */
  readonly root: string;
  /** How often to poll for new work and events. */
  /** Pause flags, so a claim does not read one per call. */
  readonly #pauseCache = new PauseCache();
  readonly #poll: number;
  /** Active event subscriptions, so `close()` can stop them. */
  readonly #subscriptions = new Set<() => void>();
  /**
   * Job names by waiting marker path, so a claim excluding names does not read
   * the same capped job's record on every call. A waiting marker's name holds
   * the job's `createdAt` and id, and a job's name never changes, so an entry
   * cannot go stale short of an id reused within the same millisecond — and
   * the claim checks the name again under the rename anyway. Insertion-ordered,
   * so the oldest entry goes first past {@link NAME_CACHE_SIZE}.
   */
  readonly #names = new Map<string, string>();
  /**
   * Queue directories this instance has already created, so `addJob` and
   * `claimJob` do not `mkdir` nine directories that exist on every call —
   * measured, 24 of the ~37 system calls an add made. Only a cache of what
   * this process made: a directory deleted underneath it (a `purge` from
   * another process) is recreated by the write that finds it missing, since
   * every write here creates its directory on `ENOENT`. Its own `purge`
   * forgets the namespace's entries.
   */
  readonly #ensured = new Set<string>();
  /**
   * Line counts of job logs this process last appended to, with the file's
   * identity at that moment, so the next append to a log it wrote need not
   * read the whole log to count it — which made a job's logging O(L²) over
   * its life. Insertion-ordered and capped at {@link LOG_COUNT_CACHE_SIZE};
   * an entry whose file has changed since is simply not used.
   */
  readonly #logCounts = new Map<string, LogCount>();

  /**
   * Finished markers `pruneExpired` read and found not due, each with the time
   * before which reading it again is pointless: its record's `expiresAt`, but
   * never more than {@link PRUNE_SKIP_MS} after the read. Skipping only ever
   * defers a removal — `#deleteJob` still judges the record under its hold —
   * and the cap bounds the deferral when the record changes somewhere this
   * process does not see (a flow child marked recorded by another process).
   * Changes this process makes drop the entry (`#mutateJob`). Capped at
   * {@link PRUNE_SKIP_CACHE_SIZE} entries.
   */
  readonly #pruneSkips = new Map<string, number>();
  /**
   * The last time `#touchWake` set, in epoch milliseconds, so the next is
   * always later even when the clock has not visibly moved.
   */
  #lastWake = 0;
  /**
   * Completions and failed attempts counted in memory and appended to
   * `throughput/<minute>.jsonl` once a second, so counting a job costs a `Map`
   * update rather than a file write. Flushed by `getThroughput` and `close`.
   */
  readonly #throughput = new ThroughputBuffer(
    async (batch) => await this.#writeThroughput(batch),
  );

  /** What is recorded into the analytics buckets, and for how long. */
  readonly #metrics: ResolvedMetricsOptions;
  /** The one width this backend records at, ms — a minute. */
  readonly #metricsInterval: number;
  /** Decides when the analytics buckets are swept: once a minute per process. */
  readonly #metricsPrune = new MetricsPruneClock();
  /** Namespaces this instance has written a metric for, which is what it sweeps. */
  readonly #metricsNamespaces = new Set<string>();
  /** Queue completions and failures, gathered per bucket and written once a second. */
  readonly #jobMetrics: MetricsBuffer<JobCounters>;
  /** The same, counted by the worker that finished the job. */
  readonly #workerMetrics: MetricsBuffer<JobCounters>;
  /** Runner outcomes, gathered per bucket and written once a second. */
  readonly #runMetrics: MetricsBuffer<RunnerRunCounters>;
  /** Run durations and their histograms, gathered beside the outcomes. */
  readonly #durationMetrics: PendingBuffer<PendingStats<DurationStats>>;
  /** Worker busyness samples, gathered as the heartbeats arrive. */
  readonly #busynessMetrics: PendingBuffer<PendingStats<BusynessStats>>;

  constructor(options: FileDriverOptions) {
    this.root = options.root;
    this.#poll = options.pollInterval ?? POLL_MS;
    this.#eventRetention = new EventRetention(options.eventRetentionMs);

    // `seconds: false` is this backend's answer, not a default: see
    // `FileDriverOptions.metrics`.
    this.#metrics = resolveMetricsOptions(options.metrics, { seconds: false });
    this.#metricsInterval = this.#metrics.intervals[0] ?? MINUTE_BUCKET_MS;

    const intervals = this.#metrics.intervals;

    this.#jobMetrics = new MetricsBuffer<JobCounters>({
      write: async (batch) => await this.#writeCounters("jobs", batch),
      keys: JOB_COUNTERS,
      intervals,
    });
    this.#workerMetrics = new MetricsBuffer<JobCounters>({
      write: async (batch) => await this.#writeCounters("workerJobs", batch),
      keys: JOB_COUNTERS,
      intervals,
    });
    this.#runMetrics = new MetricsBuffer<RunnerRunCounters>({
      write: async (batch) => await this.#writeCounters("runs", batch),
      keys: RUNNER_RUN_COUNTERS,
      intervals,
    });
    this.#durationMetrics = new PendingBuffer<PendingStats<DurationStats>>({
      write: async (batch) => await this.#writeStats("durations", batch),
      key: metricStatsKey,
      merge: (into, from) => mergeDurationStats(into.stats, from.stats),
      ns: (entry) => entry.ns,
    });
    this.#busynessMetrics = new PendingBuffer<PendingStats<BusynessStats>>({
      write: async (batch) => await this.#writeStats("busyness", batch),
      key: metricStatsKey,
      merge: (into, from) => mergeBusynessStats(into.stats, from.stats),
      ns: (entry) => entry.ns,
    });
  }

  /** Every analytics buffer, so lifecycle and purge need name no single one. */
  get #metricBuffers(): {
    close: () => Promise<void>;
    flush: () => Promise<void>;
    forget: (ns: string) => void;
  }[] {
    return [
      this.#jobMetrics,
      this.#workerMetrics,
      this.#runMetrics,
      this.#durationMetrics,
      this.#busynessMetrics,
    ];
  }

  /* --- lifecycle ---------------------------------------------------- */

  async connect(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async close(): Promise<void> {
    for (const stop of this.#subscriptions) {
      stop();
    }
    this.#subscriptions.clear();
    await this.#throughput.close();

    for (const buffer of this.#metricBuffers) {
      await buffer.close();
    }
  }

  /** Writes the counts gathered in memory and not yet written. */
  async flushThroughput(): Promise<void> {
    await this.#throughput.flush();
  }

  /** Writes the analytics counts gathered in memory and not yet written. */
  async flushMetrics(): Promise<void> {
    for (const buffer of this.#metricBuffers) {
      await buffer.flush();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await stat(this.root);
      return true;
    } catch {
      return false;
    }
  }

  async purge(ns: string): Promise<void> {
    // Forgotten first, then any write already in flight waited out: its
    // `mkdir` would otherwise put the queue's directory back after the `rm`.
    this.#throughput.forget(ns);
    await this.#throughput.flush().catch(() => undefined);

    for (const buffer of this.#metricBuffers) {
      buffer.forget(ns);
      await buffer.flush().catch(() => undefined);
    }
    this.#metricsNamespaces.delete(ns);

    const nsDir = join(this.root, encodeSegment(ns));
    for (const cache of [this.#ensured, this.#pruneSkips, this.#logCounts]) {
      for (const path of cache.keys()) {
        if (path.startsWith(`${nsDir}/`)) {
          cache.delete(path);
        }
      }
    }

    await rm(nsDir, {
      recursive: true,
      force: true,
    });
  }

  async listRunners(ns: string): Promise<string[]> {
    return await this.#listSegments(
      join(this.root, encodeSegment(ns), "runners"),
    );
  }

  async listQueues(ns: string): Promise<string[]> {
    return await this.#listSegments(
      join(this.root, encodeSegment(ns), "queues"),
    );
  }

  /* --- runner: locks -------------------------------------------------- */

  async acquireLock(
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    const dir = this.#runnerDir(ns, key);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "lock.json");
    const info: LockInfo = { token, expiresAt: now + ttlMs };

    // Outside the mutex: `O_EXCL` wins only on an absent file, and nothing
    // holding the mutex leaves the file absent and then writes it again.
    if (await this.#createLockFile(path, JSON.stringify(info))) {
      return true;
    }

    return await this.#withLockMutex(dir, async () => {
      const held = await this.#readJson<LockInfo>(path);

      // Ours already, or expired: either way we may take it.
      if (held && held.token !== token && held.expiresAt > now) {
        return false;
      }

      // Present but unreadable is a lock being written, not a stale one: the
      // exclusive create and the write of the token are two steps, and a
      // contender whose create failed reads the file in between. Taking it
      // as stale renamed the winner's lock away, and both ran. Only once it
      // is older than a TTL is it a crash's leftover, safe to break.
      if (!held && (await this.#fresherThan(path, now - ttlMs))) {
        return false;
      }

      if (held?.token === token) {
        await this.#writeAtomic(path, JSON.stringify(info));
        return true;
      }

      // Break a stale lock by renaming it away first: exactly one process can
      // win that rename, and the loser sees ENOENT and backs off.
      const claimed = join(dir, `lock.stale-${newId()}`);
      try {
        await rename(path, claimed);
      } catch {
        return false;
      }

      await rm(claimed, { force: true });
      return await this.#createLockFile(path, JSON.stringify(info));
    });
  }

  /**
   * `#createExclusive` for `lock.json`, with the `acquireLock` test seam
   * between the exclusive create and the write: the moment a contender can
   * find the file present and still empty.
   */
  async #createLockFile(path: string, contents: string): Promise<boolean> {
    const gate = acquireLockGate(this);
    if (!gate) {
      return await this.#createExclusive(path, contents);
    }

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw new DriverError("file", "createExclusive", error, { path });
    }

    try {
      await gate();
      await handle.writeFile(contents);
    } finally {
      await handle.close();
    }
    return true;
  }

  /** Whether the file at `path` exists and was modified after `since`. */
  async #fresherThan(path: string, since: number): Promise<boolean> {
    const modified = await this.#mtime(path);
    return modified > 0 && modified > since;
  }

  /**
   * Extends a lock this token holds, never one it has released.
   *
   * A read and then a write, and without the mutex a `releaseLock` landing
   * between the two — another process's, or this one's — let the write put
   * the lock back under a token its owner had already forgotten, where it
   * blocked every trigger across the cluster until the TTL ran out. So the
   * decision is taken again under the mutex `releaseLock` takes, with the
   * file re-read there: a lock released since answers `false` and stays gone.
   *
   * The first read, outside the mutex, only turns a non-owner away cheaply.
   */
  async renewLock(
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    const dir = this.#runnerDir(ns, key);
    const path = join(dir, "lock.json");

    if (!ownsLock(await this.#readJson<LockInfo>(path), token, now)) {
      return false;
    }

    // Test seam; unset outside tests. See RENEW_LOCK_GATE.
    await renewLockGate(this)?.();

    return await this.#withLockMutex(dir, async () => {
      if (!ownsLock(await this.#readJson<LockInfo>(path), token, now)) {
        return false;
      }

      await this.#writeAtomic(
        path,
        JSON.stringify({ token, expiresAt: now + ttlMs }),
      );
      return true;
    });
  }

  async releaseLock(ns: string, key: string, token: string): Promise<boolean> {
    const dir = this.#runnerDir(ns, key);
    const path = join(dir, "lock.json");

    // Cheaply refused when it is not ours, as `renewLock` is.
    if ((await this.#readJson<LockInfo>(path))?.token !== token) {
      return false;
    }

    return await this.#withLockMutex(dir, async () => {
      const held = await this.#readJson<LockInfo>(path);

      if (!held || held.token !== token) {
        return false;
      }

      await rm(path, { force: true });
      return true;
    });
  }

  async getLock(
    ns: string,
    key: string,
    now: number,
  ): Promise<LockInfo | null> {
    const held = await this.#readJson<LockInfo>(
      join(this.#runnerDir(ns, key), "lock.json"),
    );
    return held && held.expiresAt > now ? held : null;
  }

  /* --- runner: state -------------------------------------------------- */

  async getState(ns: string, key: string): Promise<Record<string, string>> {
    const state = await this.#readState(ns, key);
    return { ...state.fields };
  }

  async setState(
    ns: string,
    key: string,
    fields: Record<string, string | number | null>,
  ): Promise<void> {
    await this.#mutateState(ns, key, (state) => {
      for (const [field, value] of Object.entries(fields)) {
        if (value === null) {
          delete state.fields[field];
        } else {
          state.fields[field] = String(value);
        }
      }
    });
  }

  async incrementCounters(
    ns: string,
    key: string,
    deltas: Record<string, number>,
  ): Promise<Record<string, number>> {
    const updated: Record<string, number> = {};

    await this.#mutateState(ns, key, (state) => {
      for (const [field, delta] of Object.entries(deltas)) {
        const current = Number(state.fields[field] ?? 0);
        const next = (Number.isFinite(current) ? current : 0) + delta;
        state.fields[field] = String(next);
        updated[field] = next;
      }
    });

    return updated;
  }

  async appendHistory(
    ns: string,
    key: string,
    record: RunRecord,
    keep: number,
  ): Promise<void> {
    await this.#mutateState(ns, key, (state) => {
      state.history.unshift(jsonClone(record));
      if (keep > 0 && state.history.length > keep) {
        state.history.length = keep;
      }
    });
  }

  async updateHistory(
    ns: string,
    key: string,
    runId: string,
    patch: Partial<RunRecord>,
  ): Promise<boolean> {
    let found = false;

    await this.#mutateState(ns, key, (state) => {
      const index = state.history.findIndex((entry) => entry.runId === runId);
      if (index === -1) {
        return;
      }
      state.history[index] = { ...state.history[index], ...jsonClone(patch) };
      found = true;
    });

    return found;
  }

  async listHistory(
    ns: string,
    key: string,
    limit?: number,
  ): Promise<RunRecord[]> {
    const state = await this.#readState(ns, key);
    return limit && limit > 0 ? state.history.slice(0, limit) : state.history;
  }

  async pageHistory(
    ns: string,
    key: string,
    opts: RunHistoryQuery,
  ): Promise<RunHistoryPage> {
    // Free: `#readState` already parses the whole state document, history and
    // all, so the count costs no extra read and comes from the same snapshot.
    const state = await this.#readState(ns, key);
    return pageRunHistory(state.history, opts);
  }

  async clearHistory(ns: string, key: string): Promise<void> {
    await this.#mutateState(ns, key, (state) => {
      state.history = [];
    });
    // A run the history no longer names cannot be asked about, so its log file
    // would be bytes on disk that nothing could ever reach or collect.
    await this.clearRunLogs(ns, key);
  }

  async appendRunLog(
    ns: string,
    key: string,
    runId: string,
    lines: RunLogInput[],
    caps: RunLogCaps,
  ): Promise<RunLogAppendResult> {
    this.#assertNameFits(runId, "runId", "appendRunLog");

    const dir = this.#runLogDir(ns, key);
    await mkdir(dir, { recursive: true });

    // A lock of its own, not `state.lock`: an append must not queue behind
    // every state write, and must not make one either. It serialises the
    // read-modify-write a trim needs, and the readdir `keepRuns` walks.
    const release = await this.#lockFile(join(dir, "runlogs.lock"));

    try {
      const existing = await this.#runLogFiles(dir);
      const name =
        existing.find((entry) => entry.runId === runId)?.name ??
        `${pad(lines[0]?.at ?? Date.now(), 13)}-${encodeName(runId)}.jsonl`;
      const path = join(dir, name);

      const stored = readRunLogFile(await this.#readText(path));
      let seq = stored.at(-1)?.seq ?? 0;
      const added = lines.map((line) => storeRunLogLine(line, ++seq));
      stored.push(...added);

      const overflow = runLogOverflow(stored, caps);

      if (overflow > 0) {
        // A trim is a rewrite, as it is for a job's log: the lines a cap drops
        // are at the front of the file, and only the whole file can lose them.
        stored.splice(0, overflow);
        await this.#writeAtomic(path, writeRunLogFile(stored));
      } else {
        // The ordinary path, and why the lines are a JSONL file at all: one
        // append, no read-back, whatever the log already holds.
        await writeFile(path, writeRunLogFile(added), { flag: "a" });
      }

      // `keepRuns` on the write path too, so nothing has to sweep. The names
      // lead with the first line's timestamp, so the listing is already in run
      // order and the oldest are simply the first of it.
      if (caps.keepRuns > 0) {
        const after = existing.some((entry) => entry.runId === runId)
          ? existing
          : [...existing, { name, runId }].sort((a, b) =>
              a.name < b.name ? -1 : 1,
            );

        for (const stale of after.slice(0, after.length - caps.keepRuns)) {
          await rm(join(dir, stale.name), { force: true });
        }
      }

      return {
        count: stored.length,
        // Nothing records how many lines went: the numbering does. The first
        // line the file still holds is line N, so N-1 of them are gone.
        dropped: (stored[0]?.seq ?? seq + 1) - 1,
        lastSeq: seq,
      };
    } finally {
      await release();
    }
  }

  async getRunLog(
    ns: string,
    key: string,
    runId: string,
    opts: RunLogQuery,
  ): Promise<RunLogPage> {
    const dir = this.#runLogDir(ns, key);
    const name = (await this.#runLogFiles(dir)).find(
      (entry) => entry.runId === runId,
    )?.name;

    if (name === undefined) {
      return emptyRunLog();
    }

    const lines = readRunLogFile(await this.#readText(join(dir, name)));

    return pageRunLog(lines, opts, {
      dropped: (lines[0]?.seq ?? 1) - 1,
      lastSeq: lines.at(-1)?.seq ?? 0,
    });
  }

  async clearRunLogs(ns: string, key: string, runId?: string): Promise<void> {
    const dir = this.#runLogDir(ns, key);

    if (runId === undefined) {
      await rm(dir, { recursive: true, force: true });
      return;
    }

    const name = (await this.#runLogFiles(dir)).find(
      (entry) => entry.runId === runId,
    )?.name;

    if (name !== undefined) {
      await rm(join(dir, name), { force: true });
    }
  }

  async removeRuns(
    ns: string,
    key: string,
    runIds: readonly string[],
  ): Promise<number> {
    const dir = this.#runnerDir(ns, key);

    // Both writes below would make the runner's directory, and `listRunners`
    // is a listing of those: removing from a runner that does not exist must
    // not make it exist.
    if (runIds.length === 0 || !(await isDirectory(dir))) {
      return 0;
    }

    const named = new Set(runIds);
    let removed = 0;

    // The records, under `state.lock` like every other history write — the
    // only lock that orders this against an append or a settle rewriting the
    // same `state.json`. Nothing named, nothing rewritten.
    await this.#mutateState(ns, key, (state) => {
      const kept = state.history.filter((entry) => !named.has(entry.runId));
      removed = state.history.length - kept.length;
      if (removed === 0) {
        return false;
      }
      state.history = kept;
    });

    // The logs, under `runlogs.lock` and never inside `state.lock`: the lock
    // `appendRunLog` holds for its read-modify-write, so a named file cannot
    // be deleted half way through a trim's rewrite. A run not named is never
    // looked at, which is what keeps an in-flight run's log whole. A named log
    // goes whether or not its record did — one outliving its record is bytes
    // nothing could reach.
    const logs = this.#runLogDir(ns, key);
    if (await isDirectory(logs)) {
      const release = await this.#lockFile(join(logs, "runlogs.lock"));

      try {
        for (const entry of await this.#runLogFiles(logs)) {
          if (named.has(entry.runId)) {
            await rm(join(logs, entry.name), { force: true });
          }
        }
      } finally {
        await release();
      }
    }

    return removed;
  }

  async pushQueuedTrigger(
    ns: string,
    key: string,
    trigger: QueuedTrigger,
    max: number,
  ): Promise<boolean> {
    let pushed = false;

    await this.#mutateState(ns, key, (state) => {
      if (max > 0 && state.queued.length >= max) {
        return;
      }
      state.queued.push(jsonClone(trigger));
      pushed = true;
    });

    return pushed;
  }

  async popQueuedTrigger(
    ns: string,
    key: string,
  ): Promise<QueuedTrigger | null> {
    // Read first: a mutation writes the runner's state file, and asking an
    // unknown runner whether it has anything queued must not create it.
    if ((await this.#readState(ns, key)).queued.length === 0) {
      return null;
    }

    let trigger: QueuedTrigger | null = null;

    await this.#mutateState(ns, key, (state) => {
      trigger = state.queued.shift() ?? null;
    });

    return trigger;
  }

  async peekQueuedTrigger(
    ns: string,
    key: string,
  ): Promise<QueuedTrigger | null> {
    // A read alone: nothing is taken, and an unknown runner is not created.
    return (await this.#readState(ns, key)).queued[0] ?? null;
  }

  async popQueuedTriggerIf(
    ns: string,
    key: string,
    expectedId: string,
  ): Promise<QueuedTrigger | null> {
    // Read first, as a pop does: taking the lock creates the runner's
    // directory, and a runner nobody pushed to must not appear. This read is
    // only a shortcut — the decision is the re-check under the lock below.
    if ((await this.#readState(ns, key)).queued[0]?.id !== expectedId) {
      return null;
    }

    let trigger: QueuedTrigger | null = null;

    // The same lock file every pop and push holds, so the check against the
    // head and the shift are one step for every process sharing the directory.
    await this.#mutateState(ns, key, (state) => {
      if (state.queued[0]?.id !== expectedId) {
        return false;
      }
      trigger = state.queued.shift() ?? null;
    });

    return trigger;
  }

  async countQueuedTriggers(ns: string, key: string): Promise<number> {
    return (await this.#readState(ns, key)).queued.length;
  }

  async clearQueuedTriggers(ns: string, key: string): Promise<number> {
    let count = 0;

    await this.#mutateState(ns, key, (state) => {
      count = state.queued.length;
      state.queued = [];
    });

    return count;
  }

  /* --- queue: jobs ---------------------------------------------------- */

  async ensureQueue(q: QueueRef): Promise<void> {
    const dir = this.#queueDir(q);
    await mkdir(join(dir, "jobs"), { recursive: true });
    await mkdir(join(dir, "repeats"), { recursive: true });
    for (const state of STATES) {
      await mkdir(join(dir, "index", state), { recursive: true });
    }
    this.#ensured.add(dir);
  }

  /**
   * `ensureQueue`, once per queue per instance. The hot paths call this; no
   * correctness rests on it, because every write creates its own directory
   * when it finds it missing (see `#ensured`).
   */
  async #ensureQueueOnce(q: QueueRef): Promise<void> {
    if (!this.#ensured.has(this.#queueDir(q))) {
      await this.ensureQueue(q);
    }
  }

  async addJob(
    q: QueueRef,
    job: JobRecord,
  ): Promise<{ job: JobRecord; added: boolean }> {
    this.#assertNameFits(job.id, "id", "addJob");
    await this.#ensureQueueOnce(q);
    const result = await this.#addOne(q, job);

    if (result.added && result.job.state === "waiting") {
      await this.#touchWake(q);
    }

    return result;
  }

  /**
   * Adds several jobs: the results in input order, each exactly what `addJob`
   * would have answered.
   *
   * It was `addJob` in a loop, paying the queue check and a wake per job and
   * running every create one after another. Now the ids are checked and the
   * queue made once, the creates run {@link ADD_CONCURRENCY} at a time (each is
   * its own `O_EXCL` create, so they are independent), and the wake file is
   * touched when the first waiting job lands — so an idle worker starts at
   * once — and again at the end. Claim order comes from marker names, not from
   * the order files were created, so running creates side by side changes
   * nothing a claim sees.
   *
   * An id repeated inside the batch is added once, by its first occurrence;
   * the rest answer `added: false` with that job, as a second `addJob` would.
   * Two creates of one id never race inside one call.
   */
  async addJobs(
    q: QueueRef,
    jobs: JobRecord[],
  ): Promise<{ job: JobRecord; added: boolean }[]> {
    for (const job of jobs) {
      this.#assertNameFits(job.id, "id", "addJob");
    }

    if (jobs.length === 0) {
      return [];
    }

    await this.#ensureQueueOnce(q);

    const results: ({ job: JobRecord; added: boolean } | undefined)[] = [];
    results.length = jobs.length;
    const firstOf = new Map<string, number>();
    const work: number[] = [];

    jobs.forEach((job, index) => {
      if (!firstOf.has(job.id)) {
        firstOf.set(job.id, index);
        work.push(index);
      }
    });

    let next = 0;
    let failure: { error: unknown } | undefined;
    /** Waiting jobs added since the wake file was last touched. */
    let unannounced = 0;
    /** Whether the first waiting job's wake has been sent. */
    let announced = false;

    const lane = async (): Promise<void> => {
      while (next < work.length && failure === undefined) {
        const index = work[next++]!;

        try {
          const result = await this.#addOne(q, jobs[index]!);
          results[index] = result;

          if (result.added && result.job.state === "waiting") {
            unannounced++;

            if (!announced) {
              announced = true;
              unannounced = 0;
              await this.#touchWake(q);
            }
          }
        } catch (error) {
          failure ??= { error };
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(ADD_CONCURRENCY, work.length) }, lane),
      );
    } finally {
      // Whatever landed is announced, a failed batch included: a job added
      // is claimable, and a worker must not sleep through it.
      if (unannounced > 0) {
        await this.#touchWake(q);
      }
    }

    if (failure) {
      throw failure.error;
    }

    return jobs.map((job, index) => {
      const own = results[index];
      if (own) {
        return own;
      }

      const first = results[firstOf.get(job.id)!]!;
      return { job: jsonClone(first.job) as JobRecord, added: false };
    });
  }

  /**
   * One job's create and marker, with no queue check and no wake: what
   * `addJob` and `addJobs` share. The caller has checked the id's length.
   */
  async #addOne(
    q: QueueRef,
    job: JobRecord,
  ): Promise<{ job: JobRecord; added: boolean }> {
    const path = this.#jobPath(q, job.id);
    // `undefined` is not JSON; every other driver stores it as null. Encoded
    // once: the text is what is written, and parsing it back is the clone the
    // caller gets — `jsonClone` and then a second `stringify` did it twice.
    const text = JSON.stringify({ ...job, data: job.data ?? null });
    const record = JSON.parse(text) as JobRecord;

    // The record file *is* the idempotency key: exactly one caller creates it.
    if (!(await this.#createExclusive(path, text))) {
      const existing = await this.#readJob(path);
      return { job: existing ?? record, added: false };
    }

    await this.#addMarker(q, record);
    return { job: record, added: true };
  }

  async claimJob(q: QueueRef, opts: ClaimOptions): Promise<JobRecord | null> {
    return (await this.#claim(q, opts, 1))[0] ?? null;
  }

  /**
   * Claims up to `limit` jobs off one listing of `waiting/`.
   *
   * `claimByLoop` would call `claimJob` once per slot, and each call lists and
   * sorts the whole directory again — at a 2,500-job backlog that listing was
   * most of what a claim cost. Here the queue check, the pause check, the
   * listing and the sort happen once per batch, and the per-marker body is
   * `claimJob`'s own. Each job is still taken by its own rename, so the batch
   * is not atomic (the contract does not ask it to be) and each job is claimed
   * exactly once. The listing goes stale while the batch walks it, which costs
   * a failed rename per name somebody else took, as it always did.
   */
  async claimJobs(
    q: QueueRef,
    opts: ClaimOptions,
    limit: number,
  ): Promise<JobRecord[]> {
    return await this.#claim(q, opts, limit);
  }

  /** `claimJob` and `claimJobs`: up to `limit` jobs, in claim order. */
  async #claim(
    q: QueueRef,
    opts: ClaimOptions,
    limit: number,
  ): Promise<JobRecord[]> {
    const claimedJobs: JobRecord[] = [];

    if (limit <= 0) {
      return claimedJobs;
    }

    await this.#ensureQueueOnce(q);

    if (await this.#pauseCache.read(q, () => this.isQueuePaused(q))) {
      return claimedJobs;
    }

    // No `promoteDelayed` here: it ran before every claim whether or not
    // anything was delayed. Promotion keeps the reported state honest, it is
    // not what makes a job claimable, and the worker sweeps at 1Hz.

    const waiting = join(this.#queueDir(q), "index", "waiting");
    const markers = (await this.#list(waiting)).sort();
    const lockExpiresAt = opts.now + opts.lockMs;
    /** Whether this claim has already made sure `active/` exists. */
    const claimState = { madeDir: false };
    const excluded =
      opts.excludeNames && opts.excludeNames.length > 0
        ? new Set(opts.excludeNames)
        : null;

    for (const marker of markers) {
      const id = markerId(marker);

      // Exclusion is decided *before* the rename, from a plain read, and only
      // when there is something to exclude. Renaming a capped job's marker into
      // `active` and back would have it count as active meanwhile, and — worse
      // — make it vanish from `waiting` for every other claim, `updateJob` and
      // removal, none of which excluded it: a worker without the cap would skip
      // the job, and might sleep believing the queue empty. Reading first leaves
      // the index untouched. A stale read costs nothing here, because exclusion
      // is advisory — the checks that matter still run on the record read
      // under the rename below.
      if (excluded && (await this.#isExcluded(q, waiting, marker, excluded))) {
        continue;
      }

      // Whoever renames the marker owns the job, and the loser gets ENOENT.
      //
      // The rename comes *before* the record is read, which is what makes a
      // claim safe against `updateJob`. Read first, and a patch that took the
      // marker, rewrote the record and put the marker back under the same name
      // lands in between: the rename still succeeds, and the claim writes the
      // copy it read over the patch — the worker runs the old payload while
      // `updateJob` has already answered with the new one. Holding the marker
      // first means the record read below is the one that won. It costs
      // nothing: the same rename, read and write, in a different order.
      const taken = join(
        this.#queueDir(q),
        "index",
        "active",
        activeMarker(lockExpiresAt, id),
      );
      if (!(await this.#take(join(waiting, marker), taken, claimState))) {
        continue;
      }

      const record = await this.#readJob(this.#jobPath(q, id));

      if (!record) {
        // The record is gone: the marker is litter from a removed job.
        await rm(taken, { force: true });
        continue;
      }

      // A record in `delayed` or `failed` whose time has come is claimable:
      // the only thing between it and `waiting` is a promotion write, and this
      // claim is about to overwrite the state anyway.
      const due = record.runAt <= opts.now;
      const promotable =
        due && (record.state === "delayed" || record.state === "failed");

      // An excluded name is one more way of being not claimable *now*: the
      // pre-check above could only have missed it on an id reused under a
      // different name since, but a cap is only as good as its last check.
      if (
        !due ||
        (record.state !== "waiting" && !promotable) ||
        excluded?.has(record.name)
      ) {
        // The marker disagrees with its record. That is either litter from a
        // crash or a promotion in flight, and from here the two are
        // indistinguishable — so only a record that can no longer *become*
        // waiting is safe to clean up after, and the rest goes back exactly
        // where it was.
        //
        // Deleting the rest loses jobs. `promoteDelayed` once moved the marker
        // into `waiting` before rewriting the record, so for that instant the
        // record still read `failed`; a claim that removed the marker there
        // left a record no index pointed at, and nothing ever ran it again. The
        // cross-process retry suite found it as jobs that simply never
        // finished, after 45 seconds of waiting each.
        //
        // A crash before the marker goes back leaves it in `active` under a
        // record that is not, which `recoverStalled` re-files once the lock
        // this claim would have taken has expired.
        if (record.state === "completed" || record.state === "dead") {
          await rm(taken, { force: true });
        } else {
          await rename(taken, join(waiting, marker)).catch(() => undefined);
        }
        continue;
      }

      const claimed: JobRecord = {
        ...record,
        state: "active",
        attemptsMade: record.attemptsMade + 1,
        processedOn: opts.now,
        lockToken: opts.token,
        lockExpiresAt,
        workerId: opts.workerId,
        // Replaces the last attempt's stamp, in the write the claim already
        // makes. Every later write spreads the record, so no settle, stall
        // recovery or retry clears it; they clear only `workerId`.
        processedBy: attributionOf(opts),
      };

      try {
        await this.#writeAtomic(this.#jobPath(q, id), JSON.stringify(claimed));
      } catch (error) {
        // The marker is in `active` under a record that still says `waiting`,
        // which `recoverStalled` re-files once this lock would have expired.
        // Jobs already taken in this batch are the caller's: never throw
        // after claiming any, as the contract says.
        if (claimedJobs.length === 0) {
          throw error;
        }
        break;
      }

      claimedJobs.push(claimed);
      if (claimedJobs.length >= limit) {
        break;
      }
    }

    return claimedJobs;
  }

  async extendJobLock(
    q: QueueRef,
    id: string,
    token: string,
    lockMs: number,
    now: number,
  ): Promise<boolean> {
    const deadline = Date.now() + HOLD_PATIENCE_MS;

    for (;;) {
      const record = await this.#readJob(this.#jobPath(q, id));
      if (!record || record.state !== "active" || record.lockToken !== token) {
        return false;
      }

      const marker = this.#markerFor(record);
      const updated = { ...record, lockExpiresAt: now + lockMs };

      if (await this.#move(q, marker, "active", updated)) {
        await this.#writeAtomic(this.#jobPath(q, id), JSON.stringify(updated));
        return true;
      }

      if (!(await this.#retryLostRename(q, id, token, marker, deadline))) {
        return false;
      }
    }
  }

  async completeJob(
    q: QueueRef,
    id: string,
    token: string,
    result: unknown,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    const deadline = Date.now() + HOLD_PATIENCE_MS;

    for (;;) {
      const record = await this.#readJob(this.#jobPath(q, id));
      if (!record || record.state !== "active" || record.lockToken !== token) {
        return false;
      }

      if (retention === true) {
        const removed = await this.#completeRemoving(q, record, now);
        if (removed) {
          return true;
        }

        if (
          !(await this.#retryLostRename(
            q,
            id,
            token,
            this.#markerFor(record),
            deadline,
          ))
        ) {
          return false;
        }
        continue;
      }

      const completed: JobRecord = {
        ...record,
        state: "completed",
        finishedOn: now,
        returnValue: jsonClone(result ?? null),
        expiresAt: expiryFor(retention, now, record.expiresAt),
        lockToken: null,
        lockExpiresAt: null,
        workerId: null,
      };

      const marker = this.#markerFor(record);

      if (await this.#move(q, marker, "active", completed)) {
        await this.#writeAtomic(
          this.#jobPath(q, id),
          JSON.stringify(completed),
        );
        // Counted once the transition has landed, and in memory: no I/O here.
        this.#countJob(q, now, { completed: 1 });
        await this.#applyRetention(q, completed, retention);
        return true;
      }

      if (!(await this.#retryLostRename(q, id, token, marker, deadline))) {
        return false;
      }
    }
  }

  /**
   * `completeJob` under `removeOnComplete: true`: the job is deleted rather
   * than written as `completed` and then deleted, and says whether it was.
   *
   * The completed record used to be written, its marker moved into
   * `completed/`, and retention then took that marker into `held/`, read the
   * record again and unlinked everything — 12 trips to the thread pool where
   * a kept completion makes 3. Now the active marker goes straight into
   * `held/`, and that rename is the exclusion exactly as the move into
   * `completed/` was: a stale token or a patch holding the marker makes it
   * fail, and the caller reads again. Then the log, the record and the hold
   * go, in `#deleteJob`'s order.
   *
   * A crash after the hold leaves it with the still-`active` record, which
   * `#healHolds` files back into `active/` and `recoverStalled` retries once
   * the lock lapses — the outcome of a crash just before a completion, not a
   * lost job. Nobody can observe the `completed` record this no longer
   * writes: it lived only between two of this call's own steps.
   */
  async #completeRemoving(
    q: QueueRef,
    record: JobRecord,
    now: number,
  ): Promise<boolean> {
    const hold = await this.#hold(q, "active", this.#markerFor(record));
    if (!hold) {
      return false;
    }

    await unlink(this.#logPath(q, record)).catch(() => undefined);

    try {
      await unlink(this.#jobPath(q, record.id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await this.#place(q, hold, record);
        throw new DriverError("file", "completeJob", error, { id: record.id });
      }
    }

    await unlink(hold).catch(() => undefined);
    // Counted once the transition has landed, and in memory: no I/O here.
    this.#countJob(q, now, { completed: 1 });
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
    const deadline = Date.now() + HOLD_PATIENCE_MS;

    for (;;) {
      const record = await this.#readJob(this.#jobPath(q, id));
      if (!record || record.state !== "active" || record.lockToken !== token) {
        return false;
      }

      const base: JobRecord = {
        ...record,
        failedReason: jsonClone(error),
        stacktrace: [jsonClone(error), ...record.stacktrace].slice(
          0,
          Math.max(0, keepStacktraces),
        ),
        lockToken: null,
        lockExpiresAt: null,
        workerId: null,
      };

      const updated: JobRecord = outcome.retry
        ? { ...base, state: "failed", runAt: outcome.runAt, finishedOn: null }
        : {
            ...base,
            state: "dead",
            finishedOn: now,
            expiresAt: expiryFor(outcome.retention, now, base.expiresAt),
          };

      const marker = this.#markerFor(record);

      if (await this.#move(q, marker, "active", updated)) {
        await this.#writeAtomic(this.#jobPath(q, id), JSON.stringify(updated));
        // A failed attempt, retried or dead alike; in memory, no I/O here.
        this.#countJob(q, now, { failed: 1 });

        if (!outcome.retry) {
          await this.#applyRetention(q, updated, outcome.retention);
        }

        return true;
      }

      if (!(await this.#retryLostRename(q, id, token, marker, deadline))) {
        return false;
      }
    }
  }

  async buryJob(
    q: QueueRef,
    id: string,
    error: SerializedError,
    opts: { retention: Retention; keepStacktraces: number; token?: string },
    now: number,
  ): Promise<JobRecord | null> {
    // Under the job's hold, like `updateJob`: judged against the record read
    // once held, so a claim, a completion or a promotion cannot slip between
    // the check and the write. An active job's marker is held like any other,
    // which is what makes its worker's completion miss and give up.
    const bury = (record: JobRecord): JobRecord | null => {
      if (!canBury(record, opts.token)) {
        return null;
      }

      return {
        ...record,
        state: "dead",
        failedReason: jsonClone(error),
        stacktrace: [jsonClone(error), ...record.stacktrace].slice(
          0,
          Math.max(0, opts.keepStacktraces),
        ),
        lockToken: null,
        lockExpiresAt: null,
        workerId: null,
        finishedOn: now,
        expiresAt: expiryFor(opts.retention, now, record.expiresAt),
      };
    };
    const buried = await this.#mutateJob(q, id, bury);

    if (!buried) {
      return null;
    }

    // A failure, counted as `failJob` counts one; in memory, no I/O here.
    this.#countJob(q, now, { failed: 1 });
    await this.#applyRetention(q, buried, opts.retention);
    return buried;
  }

  async updateProgress(
    q: QueueRef,
    id: string,
    progress: unknown,
  ): Promise<boolean> {
    const path = this.#jobPath(q, id);
    const active = join(this.#queueDir(q), "index", "active");
    const deadline = Date.now() + HOLD_PATIENCE_MS;

    for (;;) {
      const record = await this.#readJob(path);
      if (!record) {
        return false;
      }

      // Progress is reported by the processor, so this is nearly always an
      // active job. Anything else is rare enough to take the full hold.
      if (record.state !== "active") {
        const updated = await this.#mutateJob(q, id, (current) => ({
          ...current,
          progress: jsonClone(progress ?? null),
        }));
        return updated !== null;
      }

      // A read-modify-write with nothing around it used to be safe, because
      // nothing else rewrote an active job's record in place. `updateJob` does,
      // and each would write over the other's change. So this renames the
      // marker as `extendJobLock` does — one millisecond more lock gives it a
      // new name — and the rename is the exclusion: a patch holding the marker
      // makes it fail, and it makes a patch or completion that read the record
      // first miss the old name and read again. One rename, and no second read.
      //
      // Every writer of an active record now changes the marker's name, which
      // is what lets a successful rename prove the record read is current. The
      // cost is a lock that creeps a millisecond per report until the next
      // `extendJobLock` resets it.
      const marker = this.#markerFor(record);
      const updated: JobRecord = {
        ...record,
        progress: jsonClone(progress ?? null),
        lockExpiresAt: (record.lockExpiresAt ?? 0) + 1,
      };

      let moved = true;
      try {
        await rename(
          join(active, marker),
          join(active, this.#markerFor(updated)),
        );
      } catch {
        moved = false;
      }

      if (moved) {
        await this.#writeAtomic(path, JSON.stringify(updated));
        return true;
      }

      if (Date.now() >= deadline) {
        return false;
      }

      const fresh = await this.#readJob(path);
      if (fresh?.state === "active" && this.#markerFor(fresh) === marker) {
        await this.#healHolds(q);
        await sleep(LOCK_RETRY_MS, { unref: true }).catch(() => {});
      }
    }
  }

  async updateJob(
    q: QueueRef,
    id: string,
    patch: JobPatch,
    now: number,
  ): Promise<JobRecord | null> {
    const updated = await this.#mutateJob(q, id, (record) => {
      // Judged against the record read *under the hold*, which is what makes
      // `onlyIn` hold at the moment of the write rather than of some earlier
      // read: a claim cannot slip between the check and the change.
      if (patch.onlyIn && !patch.onlyIn.includes(record.state)) {
        return null;
      }

      if (
        patch.runAt !== undefined &&
        record.state !== "waiting" &&
        record.state !== "delayed"
      ) {
        return null;
      }

      const next: JobRecord = { ...record };

      if (patch.data !== undefined) {
        next.data = jsonClone(patch.data);
      }

      if (patch.priority !== undefined) {
        next.priority = patch.priority;
        next.opts = {
          ...next.opts,
          priority: patch.priority,
          // An operator's per-job priority is explicit, so a queue's stored
          // defaults never replace it — set even when the value is unchanged,
          // since choosing it is what pins it. A job without a mask stays
          // without one: a mask of only this bit would claim every other
          // option of an older job was defaulted.
          ...(typeof next.opts.explicit === "number"
            ? { explicit: next.opts.explicit | JOB_OPTION_BITS.priority }
            : {}),
        };
      }

      if (patch.runAt !== undefined) {
        next.runAt = patch.runAt;
        next.state = patch.runAt > now ? "delayed" : "waiting";
      }

      return next;
    });

    if (updated?.state === "waiting") {
      await this.#touchWake(q);
    }

    return updated;
  }

  /**
   * Walks each requested state's marker directory in claim order — the
   * markers' own lexical order, which is what makes the marker name a keyset
   * cursor — and rewrites each job under its own hold (`#mutateJob`), up to
   * `REWRITE_CONCURRENCY` at once.
   *
   * - **Atomic per job, state re-checked**: the plan is judged again on the
   *   record read under the hold, so a job claimed (or otherwise moved out of
   *   `states`) after the listing is not written and counts `moved` — this
   *   backend sees those, unlike the ones that lock a batch. A claim that
   *   finds the marker held moves on to the next job, as it does for any held
   *   marker, and one that comes after reads the whole rewritten record.
   * - **Priority reorders** because `#mutateJob` puts the marker back under
   *   the name the new record gives it: the priority prefix changes, and
   *   `createdAt` then the id keep the job's FIFO place among equals.
   * - **The cursor is the last marker examined.** A job whose rewrite renames
   *   its marker ahead of the cursor is met again by a later call and counts
   *   `unchanged`; one renamed behind it was already rewritten. Markers held
   *   by another change at listing time (in `held/`) are walked too, so a job
   *   an operator happens to be patching is not skipped.
   *
   * Cost: one directory listing per state per call (plus one of `held/`), one
   * record read per job examined, and for each job written, one record write
   * and two renames. Per job that is the `updateJob` path, 0.7–5 ms measured;
   * the concurrency is what brings a call of 1,000 down to a fraction of a
   * second.
   */
  async rewritePendingOptions(
    q: QueueRef,
    request: PendingOptionsRewrite,
  ): Promise<PendingOptionsRewriteResult> {
    assertRewriteRequest(request);

    const result = emptyRewriteResult();
    const { states } = request;
    let from = 0;
    let after: string | null = null;
    /** The last marker examined in this call, which the next call resumes after. */
    let last: { state: JobState; marker: string } | undefined;

    if (request.cursor !== null) {
      const cursor = decodeRewriteCursor(
        request.cursor,
        states,
        REWRITE_CURSOR_KEY,
      );
      from = states.indexOf(cursor.state);
      after = cursor.key[0] as string;
    }

    for (let index = from; index < states.length; index++) {
      const state = states[index]!;
      const floor = after;
      after = null;

      const markers = await this.#pendingMarkers(q, state);
      const candidates =
        floor === null ? markers : markers.filter((marker) => marker > floor);

      if (candidates.length === 0) {
        continue;
      }

      const room = request.limit - result.examined;

      if (room <= 0 && last) {
        // Stopping only when there *is* a next candidate means a walk that ends
        // exactly at the limit answers `next: null`, not one empty call more.
        // The cursor may name an earlier state: the next call finds nothing
        // left there and carries on here.
        result.next = encodeRewriteCursor(last.state, [last.marker]);
        return result;
      }

      const batch = candidates.slice(0, room);

      for (let at = 0; at < batch.length; at += REWRITE_CONCURRENCY) {
        await Promise.all(
          batch
            .slice(at, at + REWRITE_CONCURRENCY)
            .map(
              async (marker) =>
                await this.#rewriteOne(q, state, marker, request, result),
            ),
        );
      }

      last = { state, marker: batch.at(-1)! };

      if (candidates.length > batch.length) {
        result.next = encodeRewriteCursor(state, [last.marker]);
        return result;
      }
    }

    return result;
  }

  /**
   * The markers of every job in `state`, sorted into claim order: those in the
   * index, and those another change holds right now (`held/`), which are back
   * in a moment.
   */
  async #pendingMarkers(q: QueueRef, state: JobState): Promise<string[]> {
    const markers = new Set(
      await this.#list(join(this.#queueDir(q), "index", state)),
    );

    for (const name of await this.#list(this.#heldDir(q))) {
      const hold = parseHold(name);
      if (hold?.state === state) {
        markers.add(hold.marker);
      }
    }

    // Marker names are ASCII, so the default sort is byte order: claim order.
    return [...markers].sort();
  }

  /**
   * Examines one job of a `rewritePendingOptions` walk, rewrites it when its
   * plan says so, and counts what happened into `result`.
   */
  async #rewriteOne(
    q: QueueRef,
    state: JobState,
    marker: string,
    request: PendingOptionsRewrite,
    result: PendingOptionsRewriteResult,
  ): Promise<void> {
    const id = markerId(marker);
    const record = id === "" ? null : await this.#readJob(this.#jobPath(q, id));

    // Gone, or moved on since the listing — claimed, removed, promoted.
    if (!record || record.state !== state) {
      tallyMoved(result);
      return;
    }

    const plan = planPendingRewrite(
      record,
      request.values,
      request.includeUnmarked,
    );

    if (plan.outcome !== "rewritten" || request.dryRun) {
      tallyRewrite(result, plan);
      return;
    }

    /**
     * The last judgment `decide` made: the one under the hold whenever it got
     * that far. `null` when the record had left `states`.
     */
    const judged: { plan: PendingRewritePlan | null } = { plan: null };

    const updated = await this.#mutateJob(
      q,
      id,
      (current) => {
        if (!request.states.includes(current.state)) {
          judged.plan = null;
          return null;
        }

        const now = planPendingRewrite(
          current,
          request.values,
          request.includeUnmarked,
        );
        judged.plan = now;

        return now.outcome === "rewritten"
          ? {
              ...current,
              opts: now.opts,
              priority: now.priority,
              maxAttempts: now.maxAttempts,
            }
          : null;
      },
      record,
    );

    const final = judged.plan;

    if (updated && final) {
      tallyRewrite(result, final);
    } else if (!final || final.outcome === "rewritten") {
      // Left `states` before the write, or — the plan still stood — its marker
      // stayed held past `HOLD_PATIENCE_MS`. Either way it was not written.
      tallyMoved(result);
    } else {
      // Changed under the hold into a job with nothing to write.
      tallyRewrite(result, final);
    }
  }

  async addJobLog(
    q: QueueRef,
    id: string,
    line: string,
    keep: number,
  ): Promise<number> {
    // Under the job's own hold, which removal takes too. That is what keeps a
    // log from outliving its job: an append cannot land between a removal
    // deleting the log and deleting the record, so a log file exists only
    // while its record does. It also serialises appends to one job, which
    // counting and trimming — a read and a rewrite — need.
    const held = await this.#holdJob(q, id, () => true);
    if (!held) {
      return 0;
    }

    const path = this.#logPath(q, held.record);

    try {
      // The count, without reading the log, when this process wrote its last
      // line: the file is the one it appended to (same inode and size), so it
      // holds exactly the lines counted then and ends in a newline. Appends to
      // one job are serialised by the hold, in every process, so nobody can
      // have added a line meanwhile without changing the size, and a trim is a
      // rewrite through a new inode. Anything else reads the log, as it always
      // did. A `stat` and the append, where the read was the whole log.
      const known = this.#logCounts.get(path);
      const seen = known ? await stat(path).catch(() => null) : null;

      if (
        known &&
        seen &&
        seen.ino === known.ino &&
        seen.size === known.size &&
        (keep <= 0 || known.count < keep)
      ) {
        const encoded = `${JSON.stringify(line)}\n`;
        await this.#append(path, encoded);
        this.#setLogCount(path, {
          ino: known.ino,
          size: known.size + Buffer.byteLength(encoded),
          count: known.count + 1,
        });
        return known.count + 1;
      }

      const existing = await this.#readText(path);
      // Only newline-terminated lines count. A crash mid-append leaves a
      // partial last line, and appending after it would fuse the two into one
      // line that is neither.
      const whole = existing.slice(0, existing.lastIndexOf("\n") + 1);
      const encoded = `${JSON.stringify(line)}\n`;
      let count = countLines(whole) + 1;

      if (keep > 0 && count > keep) {
        await this.#writeAtomic(path, dropLines(whole, count - keep) + encoded);
        count = keep;
      } else if (whole.length !== existing.length) {
        await this.#writeAtomic(path, whole + encoded);
      } else {
        await this.#append(path, encoded);
      }

      await this.#rememberLogCount(path, count);
      return count;
    } finally {
      await this.#place(q, held.hold, held.record);

      // A claim that found the marker held moved on, and may have gone to
      // sleep believing the queue empty.
      if (held.record.state === "waiting") {
        await this.#touchWake(q);
      }
    }
  }

  async getJobLogs(
    q: QueueRef,
    id: string,
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<{ logs: string[]; count: number }> {
    const record = await this.#readJob(this.#jobPath(q, id));
    if (!record) {
      return { logs: [], count: 0 };
    }

    const text = await this.#readText(this.#logPath(q, record));
    // The last element is whatever follows the final newline: empty for a
    // complete log, a partial line for one an append is still writing.
    const lines = text.split("\n").slice(0, -1);
    const ordered = opts.order === "desc" ? lines.toReversed() : lines;

    return {
      logs: ordered
        .slice(opts.offset, opts.offset + opts.limit)
        .map((encoded) => safeJsonParse<string>(encoded, encoded)),
      count: lines.length,
    };
  }

  async clearJobLogs(q: QueueRef, id: string): Promise<ClearJobLogsResult> {
    // Under the job's own hold — the one a claim needs too, since a claim
    // moves the marker this takes out of the index. So the state `accept`
    // reads under the hold is the state for the whole clear: a job claimed
    // after it is refused, and one claimed before it cannot be claimed until
    // the log is gone.
    for (let attempt = 0; ; attempt++) {
      const held = await this.#holdJob(
        q,
        id,
        (record) => record.state !== "active",
      );

      if (held) {
        const path = this.#logPath(q, held.record);

        try {
          const text = await this.#readText(path);
          // What a read counts: newline-terminated lines only.
          const removed = countLines(text);
          // Gone rather than emptied: the count is the file's lines, so the
          // next append answers one and `keep` trims from there.
          await unlink(path).catch(() => undefined);
          return { status: "cleared", removed };
        } finally {
          await this.#place(q, held.hold, held.record);

          // A claim that found the marker held moved on, and may have gone
          // to sleep believing the queue empty.
          if (held.record.state === "waiting") {
            await this.#touchWake(q);
          }
        }
      }

      // `#holdJob` answers `null` for three things. Two are answers.
      const current = await this.#readJob(this.#jobPath(q, id));
      if (!current) {
        return { status: "missing" };
      }
      if (current.state === "active") {
        return { status: "active" };
      }

      // The third: somebody kept the marker past `HOLD_PATIENCE_MS`, or the
      // job settled between the refusal and the read above. Once more, then
      // give up loudly rather than guess.
      if (attempt >= 1) {
        throw new DriverError(
          "file",
          "clearJobLogs",
          new Error("the job's marker stayed held"),
          { id },
        );
      }
    }
  }

  async recordChild(
    q: QueueRef,
    parentId: string,
    child: JobRef,
    outcome: ChildOutcome,
    now: number,
  ): Promise<ChildRecordResult> {
    const key = flowKey(child);
    const settles = outcome.completed || outcome.ignored;

    /** What recording would answer from `record`, without writing anything. */
    const answer = (record: JobRecord | null): ChildRecordResult | "write" => {
      if (!record?.flow || !listsChild(record.flow, child)) {
        return "missing";
      }
      if (
        Object.hasOwn(record.flow.values, key) ||
        Object.hasOwn(record.flow.failures, key)
      ) {
        return "already";
      }
      if (record.state === "dead") {
        return settles ? "write" : "parent-dead";
      }
      return record.state === "waiting-children" ? "write" : "already";
    };

    // Under the parent's hold, like every other change here: two children
    // finishing at once each read the parent, and without the hold the second
    // write would put back the `pending` count the first had just lowered —
    // a parent that then never runs.
    const held = await this.#holdJob(
      q,
      parentId,
      (record) => answer(record) === "write",
    );

    if (!held) {
      // `#holdJob` answers `null` for three different things, and only two of
      // them are answers. Guessing for the third — somebody kept the marker
      // past `HOLD_PATIENCE_MS` — could have the caller mark the child recorded
      // and let its retention remove it, with the outcome never delivered and
      // nothing left for healing to find. So that one throws.
      const current = answer(await this.#readJob(this.#jobPath(q, parentId)));
      if (current !== "write") {
        return current;
      }
      throw new DriverError(
        "file",
        "recordChild",
        new Error("the parent's marker stayed held"),
        { id: parentId, child: key },
      );
    }

    const { record: current, hold } = held;

    // A failure that is no longer the child's current outcome is stale, and
    // must not bury the parent: either it was delivered once already (the
    // child is marked recorded — it buried this parent, which has been retried
    // since), or the child is no longer dead (it has been retried itself, which
    // resets `recorded`, and is waiting or running again). Both come from a
    // delivery decided from an earlier view — a healing pass that read the
    // child before the first delivery marked it. A child with no record still
    // buries, as does one that failed again (dead, unrecorded).
    //
    // The child is read under the parent's hold, and every retry of the parent
    // (`requeueParent`) takes the same hold, so none can land between this
    // read and the bury. The window is widest here of every backend: the stale
    // delivery waits on the hold for as long as the first one and the retry
    // take.
    if (current.state === "waiting-children" && !settles) {
      const stored = await this.#readJob(
        this.#jobPath({ ns: q.ns, queue: child.queue }, child.id),
      );

      if (
        stored !== null &&
        (stored.flow?.recorded === true || stored.state !== "dead")
      ) {
        await this.#place(q, hold, current);
        return "already";
      }
    }

    const flow = current.flow!;
    // New objects throughout: `current` is also what the hold is put back by
    // if the write below fails.
    const stored: JobFlow = {
      ...flow,
      values: outcome.completed
        ? { ...flow.values, [key]: jsonClone(outcome.value ?? null) }
        : flow.values,
      failures: outcome.completed
        ? flow.failures
        : { ...flow.failures, [key]: jsonClone(outcome.error) },
    };
    let updated: JobRecord;
    let result: ChildRecordResult;

    if (current.state === "dead") {
      // Kept for a retry of the parent, which then does not wait on it.
      updated = { ...current, flow: stored };
      result = "recorded";
    } else if (!outcome.completed && !outcome.ignored) {
      // A child that failed buries its parent, which can then never run.
      updated = {
        ...current,
        state: "dead",
        failedReason: jsonClone(outcome.error),
        finishedOn: now,
      };
      result = "buried";
    } else {
      const pending = Math.max(0, flow.pending - 1);
      updated = {
        ...current,
        flow: { ...stored, pending },
        state:
          pending > 0
            ? "waiting-children"
            : current.runAt > now
              ? "delayed"
              : "waiting",
      };
      result = pending > 0 ? "recorded" : "released";
    }

    try {
      await this.#writeAtomic(
        this.#jobPath(q, parentId),
        JSON.stringify(updated),
      );
    } catch (error) {
      await this.#place(q, hold, current);
      throw error;
    }

    await this.#release(q, hold, current, updated);

    // A parent buried by a failed child is a failure too.
    if (result === "buried") {
      this.#countJob(q, now, { failed: 1 });
    }

    if (updated.state === "waiting") {
      await this.#touchWake(q);
    }

    return result;
  }

  async requeueParent(q: QueueRef, id: string, now: number): Promise<boolean> {
    const updated = await this.#mutateJob(q, id, (record) => {
      if (record.state !== "dead" || !record.flow) {
        return null;
      }

      // Counted here, under the hold: an outcome recorded in the meantime
      // is then never counted as still to come.
      const remaining = unsettledChildren(record.flow);
      return {
        ...record,
        // `recorded: false` as after `retryJob`: the outcome it ends with this
        // time has not reached its own parent, and without it a nested parent
        // that fails again would have that failure refused as already
        // delivered.
        flow: { ...record.flow, pending: remaining, recorded: false },
        failedReason: null,
        finishedOn: null,
        expiresAt: null,
        state:
          remaining > 0
            ? "waiting-children"
            : record.runAt > now
              ? "delayed"
              : "waiting",
      };
    });

    if (!updated) {
      return false;
    }

    if (updated.state === "waiting") {
      await this.#touchWake(q);
    }

    return true;
  }

  async markChildRecorded(
    q: QueueRef,
    id: string,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    const updated = await this.#mutateJob(q, id, (record) => {
      const finished = record.state === "completed" || record.state === "dead";

      return {
        ...record,
        flow: {
          parent: record.flow?.parent ?? null,
          children: record.flow?.children ?? [],
          pending: record.flow?.pending ?? 0,
          values: record.flow?.values ?? {},
          failures: record.flow?.failures ?? {},
          recorded: true,
        },
        // The TTL goes in with the same write, as completion does it: a
        // second write afterwards could land over a patch, or under one.
        expiresAt: finished
          ? expiryFor(retention, now, record.expiresAt)
          : record.expiresAt,
      };
    });

    if (!updated) {
      return false;
    }

    if (updated.state === "completed" || updated.state === "dead") {
      await this.#applyRetention(q, updated, retention);
    }

    return true;
  }

  async getJob(q: QueueRef, id: string): Promise<JobRecord | null> {
    return await this.#readJob(this.#jobPath(q, id));
  }

  async listJobs(
    q: QueueRef,
    states: JobState[],
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<JobRecord[]> {
    const dir = this.#queueDir(q);
    const found: JobRecord[] = [];

    // One state is already in order by its markers' names, so only the page
    // asked for is read — a maintenance pass paging through a large state
    // then costs one directory listing and `limit` reads, not every record.
    if (states.length === 1) {
      const state = states[0]!;
      const markers = (await this.#list(join(dir, "index", state))).sort();
      if (opts.order === "desc") {
        markers.reverse();
      }

      // A marker whose record has moved on is skipped without counting, so
      // the page is exactly what a full read and slice would give.
      let skip = opts.offset;
      for (const marker of markers) {
        if (found.length >= opts.limit) {
          break;
        }
        const record = await this.#readJob(this.#jobPath(q, markerId(marker)));
        if (!record || record.state !== state) {
          continue;
        }
        if (skip > 0) {
          skip--;
          continue;
        }
        found.push(record);
      }

      return found;
    }

    for (const state of states) {
      const markers = (await this.#list(join(dir, "index", state))).sort();
      for (const marker of markers) {
        const record = await this.#readJob(this.#jobPath(q, markerId(marker)));
        if (record && record.state === state) {
          found.push(record);
        }
      }
    }

    // Several states at once have no shared order but creation time.
    if (states.length > 1) {
      found.sort((a, b) => a.createdAt - b.createdAt);
    }

    if (opts.order === "desc") {
      found.reverse();
    }

    return found.slice(opts.offset, opts.offset + opts.limit);
  }

  async countJobs(q: QueueRef): Promise<Record<JobState, number>> {
    const dir = this.#queueDir(q);
    const counts = {
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      dead: 0,
      "waiting-children": 0,
    } satisfies Record<JobState, number>;

    for (const state of STATES) {
      counts[state] = (await this.#list(join(dir, "index", state))).length;
    }

    return counts;
  }

  /* --- queue: read APIs ------------------------------------------------ */

  /**
   * A page narrowed by name, search or attribution. There is no index on
   * names or workers, so a filtered read opens the records of the states
   * asked for — a single state a bounded batch at a time, stopping once the
   * page is full unless a total is wanted. Unfiltered, it is `listJobs` (a
   * single state reads only the page) and a total is the markers counted. The
   * payload is never matched.
   *
   * A `finishedOn` range is served from the markers: only `completed` and
   * `dead` can match one, so no other state's directory is even listed, and
   * theirs are named by the padded `finishedOn`, so the markers outside the
   * range are dropped by name and only the jobs inside it are opened — to
   * check the worker filters, and that the marker still speaks for its record.
   */
  async findJobs(q: QueueRef, query: JobQuery): Promise<JobPage> {
    const filter = jobFilter(query);
    const attribution = attributionFilter(query);
    const offset = Math.max(0, Math.floor(query.offset));
    const limit = Math.max(0, Math.floor(query.limit));
    // Each state once: a job is in one state, so it is one match.
    const states = [...new Set(query.states)];
    const index = join(this.#queueDir(q), "index");

    if (attribution && matchesNothing(attribution, states)) {
      return query.total ? { jobs: [], total: 0 } : { jobs: [] };
    }

    if (!filter && !attribution) {
      const jobs =
        limit === 0
          ? []
          : await this.listJobs(q, states, {
              offset,
              limit,
              order: query.order,
            });

      if (!query.total) {
        return { jobs };
      }

      let total = 0;
      for (const state of states) {
        total += (await this.#list(join(index, state))).length;
      }
      return { jobs, total };
    }

    /** Whether a record read through a `state` marker is a match. */
    const matches = (
      record: JobRecord | null,
      state: JobState,
    ): record is JobRecord =>
      // A marker whose record has moved on is not a match, as in `listJobs`.
      record !== null &&
      record.state === state &&
      (!filter || matchesFilter(filter, record.id, record.name)) &&
      (!attribution || matchesAttribution(attribution, record));

    /** A state's markers in order, less those a range rules out by name. */
    const markersOf = async (state: JobState): Promise<string[]> => {
      const markers = (await this.#list(join(index, state))).sort();
      return attribution && hasRange(attribution)
        ? markers.filter((marker) => mayFinishIn(attribution, marker))
        : markers;
    };

    const jobs: JobRecord[] = [];

    // One state is already in order by its markers' names, as in `listJobs`.
    // (With a range, `matchesNothing` has already answered for any other.)
    if (states.length === 1) {
      const state = states[0]!;
      const markers = await markersOf(state);
      if (query.order === "desc") {
        markers.reverse();
      }

      let skip = offset;
      let total = 0;

      for (let at = 0; at < markers.length; at += READ_CONCURRENCY) {
        if (!query.total && jobs.length >= limit) {
          break;
        }

        for (const record of await this.#readMarked(
          q,
          markers.slice(at, at + READ_CONCURRENCY),
        )) {
          if (!matches(record, state)) {
            continue;
          }

          total++;
          if (skip > 0) {
            skip--;
          } else if (jobs.length < limit) {
            jobs.push(record);
          }
        }
      }

      return query.total ? { jobs, total } : { jobs };
    }

    // Several states share no order but creation time, which needs them all —
    // all that can match, that is: a range skips every unfinished state.
    const matching: JobRecord[] = [];
    for (const state of states) {
      if (attribution && !canMatchState(attribution, state)) {
        continue;
      }

      const markers = await markersOf(state);

      for (let at = 0; at < markers.length; at += READ_CONCURRENCY) {
        for (const record of await this.#readMarked(
          q,
          markers.slice(at, at + READ_CONCURRENCY),
        )) {
          if (matches(record, state)) {
            matching.push(record);
          }
        }
      }
    }

    // Filtering before a stable sort leaves the order `listJobs` would give.
    matching.sort((a, b) => a.createdAt - b.createdAt);
    if (query.order === "desc") {
      matching.reverse();
    }

    jobs.push(...matching.slice(offset, offset + limit));
    return query.total ? { jobs, total: matching.length } : { jobs };
  }

  /** Several jobs by id: each distinct id read once, a bounded batch at a time. */
  async getJobs(q: QueueRef, ids: string[]): Promise<(JobRecord | null)[]> {
    const distinct = [...new Set(ids)];
    const found = new Map<string, JobRecord | null>();

    for (let at = 0; at < distinct.length; at += READ_CONCURRENCY) {
      const chunk = distinct.slice(at, at + READ_CONCURRENCY);
      const records = await Promise.all(
        chunk.map(async (id) => await this.#readJob(this.#jobPath(q, id))),
      );
      chunk.forEach((id, index) => found.set(id, records[index] ?? null));
    }

    return orderByIds(ids, found);
  }

  /** Writes a worker's record over its last one, by rename, so a read sees one whole. */
  async registerWorker(q: QueueRef, worker: WorkerInfo): Promise<void> {
    await this.#writeAtomic(
      this.#workerPath(q, worker.id),
      JSON.stringify(worker),
    );

    // Records lapsed as of this report go now, not only when somebody lists:
    // one directory read per report, never per job.
    await this.listWorkers(q, worker.heartbeatAt);
  }

  /** Removes a worker's record; of two removals at once, one unlink wins. */
  async removeWorker(q: QueueRef, id: string): Promise<boolean> {
    try {
      await unlink(this.#workerPath(q, id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw new DriverError("file", "removeWorker", error, { id });
    }
  }

  /** The workers whose records outlast `now`, deleting lapsed ones on the way. */
  async listWorkers(q: QueueRef, now: number): Promise<WorkerInfo[]> {
    const dir = join(this.#queueDir(q), "workers");
    // Only a finished `<encoded id>.json`: not a `.tmp` from an interrupted
    // write, nor a lapsed record set aside mid-delete. An encoded name never
    // contains a dot, so the first dot ends it.
    const files = (await this.#list(dir)).filter((file) => {
      const dot = file.indexOf(".");
      return (
        dot > 0 &&
        file.slice(dot) === ".json" &&
        decodeName(file.slice(0, dot)) !== null
      );
    });
    const live: WorkerInfo[] = [];

    for (let at = 0; at < files.length; at += READ_CONCURRENCY) {
      const chunk = files.slice(at, at + READ_CONCURRENCY);
      const records = await Promise.all(
        chunk.map(
          async (file) => await this.#readJson<WorkerInfo>(join(dir, file)),
        ),
      );

      for (const [index, worker] of records.entries()) {
        if (!worker) {
          continue;
        }

        if (worker.expiresAt > now) {
          live.push(worker);
        } else {
          await this.#dropLapsedWorker(join(dir, chunk[index]!), now);
        }
      }
    }

    return sortWorkers(live);
  }

  /** Counts per state for every queue directory in the namespace. */
  async countJobsByQueue(
    ns: string,
  ): Promise<Record<string, Record<JobState, number>>> {
    const result: Record<string, Record<JobState, number>> = {};

    for (const queue of await this.listQueues(ns)) {
      result[queue] = await this.countJobs({ ns, queue });
    }

    return result;
  }

  /**
   * Completions and failed attempts per minute in `[from, to]`: this driver's
   * own pending counts written first, then every line of every bucket file in
   * range summed — one line per process per flush, so writers never share one.
   */
  async getThroughput(
    q: QueueRef,
    range: { from: number; to: number },
  ): Promise<ThroughputBucket[]> {
    await this.#throughput.flush();

    const dir = this.#throughputDir(q);
    const rows: ThroughputBucket[] = [];

    for (const file of await this.#list(dir)) {
      const match = THROUGHPUT_FILE.exec(file);
      const at = Number(match?.[1]);
      if (!match || at < range.from || at > range.to) {
        continue;
      }

      // Newline-terminated lines only: a partial last line is an append in
      // flight, or one a crash cut short.
      const lines = (await this.#readText(join(dir, file))).split("\n");
      for (const line of lines.slice(0, -1)) {
        const row = safeJsonParse<Partial<ThroughputBucket> | null>(line, null);
        if (row) {
          rows.push({
            at,
            completed: Number(row.completed) || 0,
            failed: Number(row.failed) || 0,
          });
        }
      }
    }

    return sumBuckets(rows, range);
  }

  /* --- analytics ------------------------------------------------------ */

  /**
   * Minutes and nothing finer, whatever was asked for — see
   * {@link FileDriverOptions.metrics}. Reported rather than silently served,
   * so `resolveAnalyticsRange` answers `clamped` with `reason: "driver"`.
   */
  getMetricsSupport(): MetricsSupport {
    return metricsSupportOf(this.#metrics);
  }

  async getQueueMetrics(
    q: QueueRef,
    query: MetricsQuery,
  ): Promise<CounterBucket<JobCounters>[]> {
    return mergeCounterBuckets(
      await this.#readMetrics<JobCounters>(
        q.ns,
        "jobs",
        this.#queueEntity(q.queue),
        query,
      ),
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
    if (this.#metrics.workers) {
      this.#workerMetrics.count(q.ns, this.#workerEntity(q, key), at, counts);
    }
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

    for (const interval of this.#metrics.intervals) {
      const stats = emptyBusynessStats();
      // `at` itself, not the bucket's start: which sample is the latest is
      // what makes a merged bucket's `concurrency` well defined.
      addBusynessSample(stats, at, sample);
      this.#busynessMetrics.add({
        ns: q.ns,
        entity: this.#workerEntity(q, key),
        at: bucketStart(at, interval),
        interval,
        stats,
      });
    }
  }

  async getWorkerMetrics(
    q: QueueRef,
    key: string,
    query: WorkerMetricsQuery,
  ): Promise<WorkerMetricsRead> {
    await this.flushMetrics();
    return await this.#readWorker(q.ns, this.#workerEntity(q, key), query);
  }

  /**
   * Every worker key's totals, each its own read reduced by `workerTotalsOf`
   * — the definition a grouped read is held to, so this matches the per-key
   * read by construction.
   *
   * The candidates are read off the directory tree: a queue directory under
   * `workerJobs/`, a key directory under that, and under `busyness/` too when
   * busyness is asked for — a worker that only sampled busyness has no job
   * series to be found by. The roll-up's `-ns` decodes to no queue, so it is
   * never a row. One flush for the whole read, not one per key.
   */
  async getWorkerMetricsTotals(
    ns: string,
    query: WorkerMetricsTotalsQuery,
  ): Promise<WorkerMetricsTotals[]> {
    // A width this backend does not keep has nothing in it: answered without
    // listing a directory, as the per-entity read answers it without a read.
    if (!this.#servesInterval(query.interval)) {
      return [];
    }

    await this.flushMetrics();

    const kinds: MetricKind[] =
      query.busyness && this.#metrics.workers
        ? ["workerJobs", "busyness"]
        : ["workerJobs"];
    // An empty filter lists no queue at all: "none of them", never "all".
    const queues = query.queues ? new Set(query.queues) : undefined;
    const refs = new Map<string, WorkerMetricsRef>();

    for (const kind of kinds) {
      const kindDir = join(this.root, encodeSegment(ns), "metrics", kind);
      const queueDirs = queues
        ? [...queues].map((queue) => encodeName(queue))
        : await this.#list(kindDir);

      for (const queueDir of queueDirs) {
        const queue = decodeName(queueDir);
        // `-ns` (the roll-up) and anything we did not write decode to null.
        if (!queue || (queues && !queues.has(queue))) {
          continue;
        }

        for (const keyDir of await this.#list(join(kindDir, queueDir))) {
          const key = decodeName(keyDir);
          if (key !== null && !METRIC_FILE.test(keyDir)) {
            refs.set(join(queueDir, keyDir), { queue, key });
          }
        }
      }
    }

    const rows: WorkerMetricsTotals[] = [];

    for (const [entity, ref] of refs) {
      const totals = workerTotalsOf(await this.#readWorker(ns, entity, query));
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
    const unique = uniqueWorkerRefs(workers);
    if (unique.length === 0 || !this.#servesInterval(query.interval)) {
      return [];
    }

    await this.flushMetrics();

    const series: WorkerMetricsSeries[] = [];

    for (const ref of unique) {
      const read = await this.#readWorker(
        ns,
        this.#workerEntity({ ns, queue: ref.queue }, ref.key),
        query,
      );
      if (hasMetricBuckets(read.jobs, read.busyness)) {
        series.push({ ...ref, ...read });
      }
    }

    return series;
  }

  /**
   * One worker entity's read from what is on disk, without a flush: the
   * per-key read and both grouped ones share it, so they cannot disagree.
   */
  async #readWorker(
    ns: string,
    entity: string,
    query: WorkerMetricsQuery,
  ): Promise<WorkerMetricsRead> {
    const read: WorkerMetricsRead = {
      jobs: mergeCounterBuckets(
        await this.#readMetricRows<JobCounters>(
          ns,
          "workerJobs",
          entity,
          query,
        ),
        query,
        JOB_COUNTERS,
      ),
    };

    if (query.busyness && this.#metrics.workers) {
      read.busyness = mergeBusynessBuckets(
        await this.#readMetricRows<BusynessStats>(
          ns,
          "busyness",
          entity,
          query,
        ),
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

    this.#runMetrics.count(ns, encodeName(runner), at, counts);

    // The duration rides with the outcome, so a finished run is one event
    // here too — gathered in the same second's batch, not a second write.
    if (this.#metrics.durations && counts.durationMs !== undefined) {
      for (const interval of this.#metrics.intervals) {
        const stats = emptyDurationStats();
        addDuration(stats, counts.durationMs);
        this.#durationMetrics.add({
          ns,
          entity: encodeName(runner),
          at: bucketStart(at, interval),
          interval,
          stats,
        });
      }
    }
  }

  async getRunnerMetrics(
    ns: string,
    runner: string,
    query: RunnerMetricsQuery,
  ): Promise<RunnerMetricsRead> {
    await this.flushMetrics();
    return await this.#readRunner(ns, encodeName(runner), query);
  }

  /**
   * Every runner's totals, each its own read reduced by `runnerTotalsOf`.
   *
   * The candidates are the runner directories under `runs/` — and under
   * `durations/` when durations are asked for and recorded — or, with a
   * filter, exactly the runners it names. The roll-up is never one: its
   * `-ns` directory decodes to nothing, and its empty name is skipped when a
   * filter names it.
   */
  async getRunnerMetricsTotals(
    ns: string,
    query: RunnerMetricsTotalsQuery,
  ): Promise<RunnerMetricsTotals[]> {
    if (!this.#servesInterval(query.interval)) {
      return [];
    }

    await this.flushMetrics();

    let runners: Set<string>;

    if (query.runners) {
      // The filter *is* the candidate list: an empty one answers nothing.
      runners = new Set(query.runners);
    } else {
      runners = new Set();
      const kinds: MetricKind[] =
        query.durations && this.#metrics.durations
          ? ["runs", "durations"]
          : ["runs"];

      for (const kind of kinds) {
        const kindDir = join(this.root, encodeSegment(ns), "metrics", kind);
        for (const entry of await this.#list(kindDir)) {
          const runner = decodeName(entry);
          if (runner !== null && !METRIC_FILE.test(entry)) {
            runners.add(runner);
          }
        }
      }
    }

    const rows: RunnerMetricsTotals[] = [];

    for (const runner of runners) {
      if (runner === NAMESPACE_ENTITY) {
        continue;
      }

      const totals = runnerTotalsOf(
        await this.#readRunner(ns, encodeName(runner), query),
      );
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
    // `getRunnerMetrics(ns, "")` happens to answer the roll-up; a batch of
    // entities never does.
    const unique = [...new Set(runners)].filter(
      (runner) => runner !== NAMESPACE_ENTITY,
    );
    if (unique.length === 0 || !this.#servesInterval(query.interval)) {
      return [];
    }

    await this.flushMetrics();

    const series: RunnerMetricsSeries[] = [];

    for (const runner of unique) {
      const read = await this.#readRunner(ns, encodeName(runner), query);
      if (hasMetricBuckets(read.runs, read.durations)) {
        series.push({ runner, ...read });
      }
    }

    return series;
  }

  /** One runner's read from what is on disk, without a flush. */
  async #readRunner(
    ns: string,
    entity: string,
    query: RunnerMetricsQuery,
  ): Promise<RunnerMetricsRead> {
    const read: RunnerMetricsRead = {
      runs: mergeCounterBuckets(
        await this.#readMetricRows<RunnerRunCounters>(
          ns,
          "runs",
          entity,
          query,
        ),
        query,
        RUNNER_RUN_COUNTERS,
      ),
    };

    if (query.durations && this.#metrics.durations) {
      read.durations = mergeDurationBuckets(
        await this.#readMetricRows<DurationStats>(
          ns,
          "durations",
          entity,
          query,
        ),
        query,
      );
    }

    return read;
  }

  async getNamespaceMetrics(
    ns: string,
    query: NamespaceMetricsQuery,
  ): Promise<NamespaceMetricsRead> {
    const read: NamespaceMetricsRead = {};

    // A kind that is not recorded stays absent rather than answering zeros:
    // "nothing happened" and "nothing is kept" are different answers.
    if (query.kinds.includes("jobs")) {
      read.jobs = mergeCounterBuckets(
        await this.#rollUp<JobCounters>(ns, "jobs", query),
        query,
        JOB_COUNTERS,
      );
    }
    if (query.kinds.includes("runs") && this.#metrics.runners) {
      read.runs = mergeCounterBuckets(
        await this.#rollUp<RunnerRunCounters>(ns, "runs", query),
        query,
        RUNNER_RUN_COUNTERS,
      );
    }
    if (query.kinds.includes("workerJobs") && this.#metrics.workers) {
      read.workerJobs = mergeCounterBuckets(
        await this.#rollUp<JobCounters>(ns, "workerJobs", query),
        query,
        JOB_COUNTERS,
      );
    }

    return read;
  }

  async removeJob(q: QueueRef, id: string): Promise<boolean> {
    return await this.#deleteJob(q, id, (record) => record.state !== "active");
  }

  async retryJob(
    q: QueueRef,
    id: string,
    resetAttempts: boolean,
    now: number,
  ): Promise<boolean> {
    // Under a hold, like `updateJob`: a retry that wrote the copy it read
    // before the rename would put back whatever a patch had just replaced.
    const updated = await this.#mutateJob(q, id, (record) => {
      // A parent waiting on children is not finished; moving it would run it
      // before they settle.
      if (
        record.state === "active" ||
        record.state === "waiting" ||
        record.state === "waiting-children"
      ) {
        return null;
      }

      return {
        ...record,
        state: "waiting",
        runAt: now,
        finishedOn: null,
        expiresAt: null,
        // The outcome it ends with this time has not reached its parent.
        flow: record.flow ? { ...record.flow, recorded: false } : null,
        ...(resetAttempts ? { attemptsMade: 0, stalledCount: 0 } : {}),
      };
    });

    if (!updated) {
      return false;
    }

    await this.#touchWake(q);
    return true;
  }

  async promoteJob(q: QueueRef, id: string, now: number): Promise<boolean> {
    const updated = await this.#mutateJob(q, id, (record) => {
      if (!SCHEDULED_STATES.includes(record.state)) {
        return null;
      }

      return { ...record, state: "waiting", runAt: now };
    });

    if (!updated) {
      return false;
    }

    await this.#touchWake(q);
    return true;
  }

  async promoteDelayed(
    q: QueueRef,
    now: number,
    limit: number,
  ): Promise<PromoteDelayedResult> {
    const dir = this.#queueDir(q);
    let promoted = 0;
    /**
     * The earliest due time still scheduled, read off the same listings the
     * promotion walks, so answering it costs no directory read of its own.
     */
    let nextDueAt: number | null = null;
    const consider = (due: number): void => {
      if (Number.isFinite(due) && (nextDueAt === null || due < nextDueAt)) {
        nextDueAt = due;
      }
    };

    // Only the due names are sorted. Every marker's prefix is its due time,
    // padded to one width, so comparing it with `pad(now)` as a string is the
    // numeric test — and a large future backlog is filtered in one pass rather
    // than sorted on every sweep.
    const cutoff = `${pad(now, 13)}-`;

    for (const state of SCHEDULED_STATES) {
      const listed = await this.#list(join(dir, "index", state));
      const markers = listed
        .filter((marker) => marker < cutoff || marker.startsWith(cutoff))
        .sort();
      /** Markers this pass moved out of the index, so none of them is next. */
      const settled = new Set<string>();

      for (const marker of markers) {
        if (promoted >= limit) {
          break;
        }

        // The marker's prefix is the due time, so an unripe one ends the scan.
        if (Number(marker.split("-")[0]) > now) {
          break;
        }

        // Hold the marker, then read. Reading first and writing `waiting` over
        // what was read races `updateJob`: a patch that pushes this job's
        // `runAt` back and replaces its data lands between the read and the
        // write, and the promotion then writes the old copy over it — the
        // debounce case, exactly when the job falls due.
        const hold = await this.#hold(q, state, marker);
        if (!hold) {
          continue;
        }

        const record = await this.#readJob(this.#jobPath(q, markerId(marker)));

        if (!record) {
          await rm(hold, { force: true });
          settled.add(marker);
          continue;
        }

        // `waiting` is allowed as well as the state being swept: a promotion
        // that wrote the record and then died leaves exactly that, and this
        // pass has to finish the job rather than skip it forever.
        if (
          (record.state !== state && record.state !== "waiting") ||
          record.runAt > now
        ) {
          await this.#place(q, hold, record);
          // Filed again by the record: under its real due time if it is
          // still scheduled, out of the scheduled indexes if it is not.
          settled.add(marker);
          if (SCHEDULED_STATES.includes(record.state)) {
            consider(record.runAt);
          }
          continue;
        }

        const updated: JobRecord = { ...record, state: "waiting" };

        // Record first, marker second. The other order leaves a window where
        // the marker says `waiting` and the record does not, which a claim
        // running at that moment cannot tell from litter. A crash in between
        // leaves a hold that `recoverStalled` files by the record.
        try {
          await this.#writeAtomic(
            this.#jobPath(q, record.id),
            JSON.stringify(updated),
          );
        } catch (error) {
          await this.#place(q, hold, record);
          throw error;
        }

        await this.#release(q, hold, record, updated);
        settled.add(marker);
        promoted++;
      }

      // Everything listed and not moved is still scheduled — past the limit,
      // not yet due, or held by another process that may put it back.
      for (const marker of listed) {
        if (!settled.has(marker)) {
          consider(Number(marker.split("-")[0]));
        }
      }
    }

    if (promoted > 0) {
      await this.#touchWake(q);
    }

    return { promoted, nextDueAt };
  }

  async recoverStalled(
    q: QueueRef,
    now: number,
    maxStalledCount: number,
    limit: number,
  ): Promise<{ requeued: string[]; dead: string[] }> {
    const dir = join(this.#queueDir(q), "index", "active");
    const requeued: string[] = [];
    const dead: string[] = [];

    // Markers taken out of the index by a process that died holding them.
    await this.#healHolds(q);

    for (const marker of (await this.#list(dir)).sort()) {
      if (requeued.length + dead.length >= limit) {
        break;
      }

      // The marker's prefix is when the lock expires.
      if (Number(marker.split("-")[0]) > now) {
        break;
      }

      const record = await this.#readJob(this.#jobPath(q, markerId(marker)));

      if (!record) {
        // Litter: a claim that found no record and died before removing it.
        await rm(join(dir, marker), { force: true });
        continue;
      }

      if (record.state !== "active") {
        // A claim renames the marker before it writes the record, so one that
        // died in between leaves the marker here under a record that is still
        // `waiting`. Nothing else ever looks for it in `active`: file it where
        // the record says it belongs. Only once the lock it would have taken
        // has expired, so a claim still in flight is never disturbed.
        await this.#place(q, join(dir, marker), record);
        continue;
      }

      const stalledCount = record.stalledCount + 1;
      const buried = stalledCount > maxStalledCount;

      const updated: JobRecord = {
        ...record,
        stalledCount,
        lockToken: null,
        lockExpiresAt: null,
        workerId: null,
        ...(buried
          ? { state: "dead" as const, finishedOn: now }
          : { state: "waiting" as const, runAt: now }),
      };

      if (!(await this.#move(q, marker, "active", updated))) {
        continue;
      }

      await this.#writeAtomic(
        this.#jobPath(q, record.id),
        JSON.stringify(updated),
      );
      (buried ? dead : requeued).push(record.id);
    }

    if (requeued.length > 0) {
      await this.#touchWake(q);
    }

    // A burial is a failure, counted as a failed attempt is.
    if (dead.length > 0) {
      this.#countJob(q, now, { failed: dead.length });
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
    const cutoff = now - olderThanMs;
    const removed: string[] = [];

    for (const marker of await this.#list(
      join(this.#queueDir(q), "index", state),
    )) {
      if (removed.length >= limit) {
        break;
      }

      const record = await this.#readJob(this.#jobPath(q, markerId(marker)));
      if (!record) {
        continue;
      }

      const expired = (candidate: JobRecord) =>
        candidate.state === state &&
        (candidate.finishedOn ?? candidate.createdAt) <= cutoff;

      if (await this.#deleteJob(q, record.id, expired, record)) {
        removed.push(record.id);
      }
    }

    return removed;
  }

  async pruneExpired(q: QueueRef, now: number, limit: number): Promise<number> {
    let removed = 0;

    for (const state of ["completed", "dead"] as const) {
      const dir = join(this.#queueDir(q), "index", state);

      for (const marker of await this.#list(dir)) {
        if (removed >= limit) {
          break;
        }

        // A record this driver read lately and found not due, and which
        // cannot be due yet, is not read again. The worker calls this
        // repeatedly per sweep until a batch comes back short, and each call
        // used to re-read every unexpired record it met before the expired
        // ones — measured, 12,000 record reads to remove 600 of 3,000.
        const key = join(dir, marker);
        const skipUntil = this.#pruneSkips.get(key);
        if (skipUntil !== undefined) {
          if (now < skipUntil) {
            continue;
          }
          this.#pruneSkips.delete(key);
        }

        const record = await this.#readJob(this.#jobPath(q, markerId(marker)));
        const due = (candidate: JobRecord) =>
          candidate.state === state &&
          candidate.expiresAt !== null &&
          candidate.expiresAt <= now &&
          // A child whose parent has not taken its outcome yet stays.
          !awaitsDelivery(candidate);

        if (!record) {
          continue;
        }

        if (due(record)) {
          if (await this.#deleteJob(q, record.id, due, record)) {
            removed++;
          }
          continue;
        }

        if (record.state === state) {
          this.#skipPrune(key, record, now);
        }
      }
    }

    return removed;
  }

  async drainQueue(q: QueueRef, includeDelayed: boolean): Promise<number> {
    // A parent waiting on children is queued work that has not run, so it
    // goes with `waiting` whether or not delayed jobs are drained too.
    const states: JobState[] = includeDelayed
      ? ["waiting", "waiting-children", ...SCHEDULED_STATES]
      : ["waiting", "waiting-children"];
    let removed = 0;

    for (const state of states) {
      for (const marker of await this.#list(
        join(this.#queueDir(q), "index", state),
      )) {
        const record = await this.#readJob(this.#jobPath(q, markerId(marker)));
        if (
          record &&
          (await this.#deleteJob(
            q,
            record.id,
            (candidate) => candidate.state === state,
            record,
          ))
        ) {
          removed++;
        }
      }
    }

    return removed;
  }

  async getQueueState(
    q: QueueRef,
    name: string,
  ): Promise<QueueStateEntry | null> {
    // A name too long to be a file name cannot have been written.
    if (encodeName(name).length > MAX_ENCODED_NAME) {
      return null;
    }

    // No lock: every write lands by rename, so a read sees one whole version.
    return await this.#readJson<QueueStateEntry>(this.#statePath(q, name));
  }

  async setQueueState(
    q: QueueRef,
    name: string,
    value: unknown,
    expected: number | null,
    options?: { internal?: symbol },
  ): Promise<number | null> {
    assertWritableStateName(name, options);
    // Before anything is written or locked. This package's own names are
    // fitted to the budget, so only a caller's name can be refused here.
    this.#assertNameFits(name, "name", "setQueueState");

    const path = this.#statePath(q, name);

    // The compare and the write under one lock file, which is what makes them
    // one step across processes: `O_EXCL` lets exactly one process in, and the
    // write goes through a rename so a reader outside the lock never sees half
    // of it. Creating an absent entry takes the same lock rather than an
    // exclusive create of its own, so a delete cannot land between somebody's
    // check for absence and their create.
    const release = await this.#lockFile(
      `${path.slice(0, -".json".length)}.lock`,
    );

    try {
      const current = await this.#readJson<QueueStateEntry>(path);

      if ((current?.version ?? null) !== expected) {
        return null;
      }

      if (value === null) {
        await unlink(path).catch(() => undefined);
        return 0;
      }

      const version = (current?.version ?? 0) + 1;
      await this.#writeAtomic(
        path,
        JSON.stringify({ version, value } satisfies QueueStateEntry),
      );
      return version;
    } finally {
      await release();
    }
  }

  async listQueueState(
    q: QueueRef,
    options: { prefix: string; after?: string; limit: number },
  ): Promise<string[]> {
    const names: string[] = [];

    for (const file of await this.#list(join(this.#queueDir(q), "state"))) {
      // Only a finished `<encoded name>.json` is an entry. The directory also
      // holds `.lock` files (an orphan outlives a crashed compare-and-set),
      // `.stale` locks mid-break and `.tmp` files from an interrupted atomic
      // write. An encoded name never contains a dot, so the first dot ends it
      // and only `.json` straight after makes an entry.
      const dot = file.indexOf(".");
      if (dot === -1 || file.slice(dot) !== ".json") {
        continue;
      }

      const name = decodeName(file.slice(0, dot));
      if (name === null) {
        // Not a name this driver wrote; nothing it could be looked up by.
        continue;
      }

      // Compared decoded, because the prefix is literal text rather than an
      // encoded fragment — and with `compareCodePoints`, never `>`. JavaScript
      // compares UTF-16 units, so `"\u{1F600}" > "￿"` is false, and a page
      // ending at U+FFFF would silently drop the emoji from the next one.
      if (
        name.startsWith(options.prefix) &&
        (options.after === undefined ||
          compareCodePoints(name, options.after) > 0)
      ) {
        names.push(name);
      }
    }

    // Code-point order, as the contract requires; the default `sort()` is
    // UTF-16 order, which puts U+10000 and above ahead of U+E000–U+FFFF.
    names.sort(compareCodePoints);
    return names.slice(0, Math.max(0, options.limit));
  }

  async pauseQueue(q: QueueRef): Promise<void> {
    await this.#setMeta(q, { paused: true });
    this.#pauseCache.write(q, true);
  }

  async resumeQueue(q: QueueRef): Promise<void> {
    await this.#setMeta(q, { paused: false });
    await this.#touchWake(q);
    this.#pauseCache.write(q, false);
  }

  async isQueuePaused(q: QueueRef): Promise<boolean> {
    const meta = await this.#readJson<{ paused?: boolean }>(
      join(this.#queueDir(q), "meta.json"),
    );
    return meta?.paused === true;
  }

  /* --- queue: repeats ------------------------------------------------- */

  async upsertRepeat(q: QueueRef, def: RepeatRecord): Promise<void> {
    await this.ensureQueue(q);
    await this.#writeAtomic(this.#repeatPath(q, def.key), JSON.stringify(def));
  }

  async getRepeat(q: QueueRef, key: string): Promise<RepeatRecord | null> {
    return await this.#readJson<RepeatRecord>(this.#repeatPath(q, key));
  }

  async listRepeats(q: QueueRef): Promise<RepeatRecord[]> {
    const dir = join(this.#queueDir(q), "repeats");
    const found: RepeatRecord[] = [];

    for (const file of await this.#list(dir)) {
      const record = await this.#readJson<RepeatRecord>(join(dir, file));
      if (record) {
        found.push(record);
      }
    }

    return found;
  }

  async removeRepeat(q: QueueRef, key: string): Promise<boolean> {
    const path = this.#repeatPath(q, key);
    if (!(await this.#readJson<RepeatRecord>(path))) {
      return false;
    }

    await rm(path, { force: true });
    return true;
  }

  /* --- queue: waiting and events --------------------------------------- */

  async nextDelayedAt(q: QueueRef): Promise<number | null> {
    let earliest: number | null = null;

    for (const state of SCHEDULED_STATES) {
      const markers = (
        await this.#list(join(this.#queueDir(q), "index", state))
      ).sort();

      const first = markers[0];
      if (!first) {
        continue;
      }

      // Markers sort by due time, so the first is the earliest.
      const due = Number(first.split("-")[0]);
      if (Number.isFinite(due) && (earliest === null || due < earliest)) {
        earliest = due;
      }
    }

    return earliest;
  }

  async waitForJob(
    q: QueueRef,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const wake = join(this.#queueDir(q), "wake");

    // Snapshotted *before* the first look for work, and the order is the whole
    // point. This watches `wake` for a change, so anything that arrived before
    // the snapshot is already folded into it and will never look like one —
    // and a caller reaches here precisely because its claim came back empty,
    // which is the window a job most often lands in. Taking the snapshot first
    // and then looking means a job landing either side of it is caught: before,
    // by the look; after, by the change.
    //
    // Getting this backwards cost a full poll interval. Measured, round-trip
    // p90 was 1001ms against a p50 of 1.69ms — `DEFAULT_POLL_INTERVAL` exactly,
    // spent asleep with a claimable job sitting in the queue.
    const before = await this.#mtime(wake);

    if (await this.#hasWaiting(q)) {
      return;
    }

    // The gap between polls grows from a millisecond up to the configured
    // interval, rather than being flat. Without a push channel this loop is the
    // only thing that notices a new job, and a flat interval makes a job that
    // arrives just after a poll wait the whole of it — a tail, not an average.
    // Measured on Postgres, that was p99 53ms against a 50ms interval; backing
    // off brought it to 4ms while leaving an idle worker's cost where it was.
    let wait = 1;

    while (Date.now() < deadline && !signal?.aborted) {
      // A change to the wake file means someone added or promoted work; the
      // caller still has to claim, since another worker may get there first.
      if ((await this.#mtime(wake)) !== before) {
        return;
      }

      await sleep(Math.min(wait, Math.max(1, deadline - Date.now())), {
        unref: true,
      }).catch(() => {});
      wait = Math.min(this.#poll, wait * 2);
    }
  }

  async publish(event: DriverEvent): Promise<void> {
    const path = this.#eventsPath(event);
    // One line, appended: writes below the pipe-buffer size are atomic on
    // POSIX, so concurrent publishers cannot interleave within a line.
    await this.#append(path, `${JSON.stringify(event)}\n`);
    // Only once the line is down. A sweep started before the append judged
    // this log by its state a moment earlier — stale, or not there yet — and
    // could truncate it after the new line had landed, dropping an event
    // milliseconds old.
    this.#pruneEvents(event.ns);
  }

  /**
   * Prunes this namespace's stored events, if it is time to.
   *
   * Deliberately not awaited: a publisher should not wait on housekeeping for
   * a log it is not reading, and a failure here costs disk rather than
   * correctness. `EventRetention` records the attempt either way, so a delete
   * that keeps failing does not become a write per event.
   */
  #pruneEvents(ns: string): void {
    const before = this.#eventRetention.due(ns);

    if (before === null) {
      return;
    }

    void this.cleanEvents(ns, before).catch(() => undefined);
  }

  /**
   * Drops event logs under `ns` that have nothing left worth keeping.
   *
   * **Whole files, never part of one.** A subscriber reads this log by byte
   * offset and treats the file shrinking as a rotation, starting again from
   * zero — so rewriting a log to keep its newer half would make every
   * subscriber replay the events that survived. Truncating a log whose *last*
   * write is already past the cutoff has nothing to replay.
   *
   * Modification time is the last append, which is exactly the question being
   * asked, and reading it does not mean parsing the file.
   *
   * **One `stat` per log, and a missing log is skipped.** Age and size used to
   * come from two separate calls, with a missing file reading as modified at
   * the epoch — so a log whose directory existed but whose first line was
   * still being appended read as ancient, then as non-empty, and was emptied
   * of an event younger than the window. Both answers now describe the same
   * moment. A publisher in another process can still append between that
   * `stat` and the truncate; nothing short of a lock shared with every
   * publisher closes that, and the window is two system calls wide.
   */
  async cleanEvents(ns: string, before: number): Promise<number> {
    let dropped = 0;

    for (const path of await this.#eventLogs(ns)) {
      const log = await stat(path).catch(() => null);

      // Not written yet (its directory is made first), or written since the
      // cutoff: either way, nothing in it has expired.
      if (!log || log.mtimeMs >= before) {
        continue;
      }

      // Already empty: truncating it again would report work that did not
      // happen, and emptying a log updates its modification time, so every
      // later sweep would find it stale and count it afresh.
      if (log.size === 0) {
        continue;
      }

      // Truncate rather than unlink: a subscriber holds the path, and an empty
      // file is the rotation it already understands.
      await Bun.write(path, "").catch(() => undefined);
      dropped++;
    }

    return dropped;
  }

  /** Every event log under one namespace, queues and runners alike. */
  async #eventLogs(ns: string): Promise<string[]> {
    const logs: string[] = [];

    const queues = join(this.root, encodeSegment(ns), "queues");
    const runners = join(this.root, encodeSegment(ns), "runners");

    for (const [dir, targets, names] of [
      // A queue holds two logs: its own events, and its workers'.
      [
        queues,
        await this.#list(queues),
        ["events.jsonl", "worker-events.jsonl"],
      ],
      [runners, await this.#list(runners), ["events.jsonl"]],
    ] as const) {
      for (const target of targets) {
        for (const name of names) {
          logs.push(join(dir, target, name));
        }
      }
    }

    return logs;
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

    const path = this.#eventsPath({ ns, kind, target });
    await mkdir(join(path, ".."), { recursive: true });

    let offset = await this.#size(path);
    let stopped = false;
    /** Whether a poll is still reading, so the next one does not overlap it. */
    let reading = false;

    const timer = setInterval(() => {
      if (stopped || reading) {
        return;
      }

      reading = true;
      void (async () => {
        const size = await this.#size(path);
        if (size <= offset) {
          // A truncated (rotated) file starts over. Only trustworthy because
          // polls never overlap: a stale one could otherwise see a size below
          // an offset its successor had already moved, and replay the log.
          offset = size < offset ? 0 : offset;
          return;
        }

        const handle = await open(path, "r").catch(() => null);
        if (!handle) {
          return;
        }

        try {
          const buffer = Buffer.alloc(size - offset);
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            offset,
          );

          // Complete lines only. A line can be caught half written — another
          // process's append split across writes, or a short read — and the
          // offset used to move past it all the same, so the half failed to
          // parse and the rest never started a line: the event was lost. The
          // tail after the last newline is read again, whole, next time.
          const chunk = buffer.subarray(0, bytesRead);
          const end = chunk.lastIndexOf(0x0a);
          if (end === -1) {
            return;
          }
          offset += end + 1;

          for (const line of chunk
            .subarray(0, end)
            .toString("utf8")
            .split("\n")) {
            if (!line.trim()) {
              continue;
            }
            const event = safeJsonParse<DriverEvent | null>(line, null);
            if (event && event.ns === ns && event.target === target) {
              deliver(event);
            }
          }
        } finally {
          await handle.close();
        }
      })()
        .catch(() => {
          // A failed poll is retried on the next tick.
        })
        .finally(() => {
          reading = false;
        });
    }, this.#poll);
    timer.unref?.();

    const stop = () => {
      stopped = true;
      clearInterval(timer);
    };

    this.#subscriptions.add(stop);

    return async () => {
      stop();
      this.#subscriptions.delete(stop);
    };
  }

  /* --- paths ------------------------------------------------------------ */
  //
  // Every name becomes a file name through `file-names.ts`, never as typed:
  // on a case-insensitive filesystem (macOS, Windows) `Report` and `report`
  // would otherwise be one file. Namespaces, queue names and runner ids go
  // through `encodeSegment`, which keeps them readable; ids, state names and
  // repeat keys through `encodeName`, which also keeps their order.

  /** Directory holding one runner's lock, state and events. */
  #runnerDir(ns: string, key: string): string {
    return join(
      this.root,
      encodeSegment(ns),
      "runners",
      encodeSegment(key.replace(/^r:/, "")),
    );
  }

  /**
   * Directory holding one runner's captured run output, one JSONL file per
   * run. Inside the runner's directory, so `purge` takes it with everything
   * else, and beside `state.json` rather than inside it — a line must not
   * rewrite the run history.
   */
  #runLogDir(ns: string, key: string): string {
    return join(this.#runnerDir(ns, key), "runlogs");
  }

  /**
   * The run-log files in `dir`, oldest run first, each with the run it holds.
   *
   * The name leads with the first line's timestamp and ends with the encoded
   * run id — the same shape a job marker uses — so `readdir` sorted gives run
   * order, which is what `keepRuns` evicts by, and no second index is needed
   * to find the oldest. An entry that is not one of ours is ignored.
   */
  async #runLogFiles(dir: string): Promise<{ name: string; runId: string }[]> {
    const files: { name: string; runId: string }[] = [];

    for (const name of await this.#list(dir)) {
      const match = /^\d{13}-(.+)\.jsonl$/.exec(name);
      const runId = match ? decodeName(match[1]!) : null;

      if (runId !== null) {
        files.push({ name, runId });
      }
    }

    return files.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Directory holding one queue. */
  #queueDir(q: QueueRef): string {
    return join(
      this.root,
      encodeSegment(q.ns),
      "queues",
      encodeSegment(q.queue),
    );
  }

  /**
   * Refuses an id whose *encoded* name would not fit in a file name.
   *
   * The shared character cap does not bound this. `encodeName` is a per
   * character expansion — up to 3 for ASCII punctuation and 9 for a BMP
   * character outside Latin — so an id of 191 characters, every one of them
   * legal, can encode to over 1,700. And the encoded id is only part of the
   * name: a marker prepends an ordering key, and an atomic write appends
   * `.<pid>.<uuid>.tmp`, which is the widest of them.
   *
   * Checked here, when a record is created, rather than inside `#jobPath`:
   * that is on every read too, and `getJob` of an over-long id should answer
   * `null` rather than throw. Without this the failure was an `ENAMETOOLONG`
   * rewrapped as a bare `DriverError` naming only the path — and on the marker
   * and hold paths it was swallowed entirely and reported as lost contention.
   */
  #assertNameFits(
    /** The job id or queue-state name. */
    name: string,
    /** What it is, as the message and context name it: `"id"`, `"name"`. */
    what: string,
    /** The driver operation refusing it. */
    operation: string,
  ): void {
    const encoded = encodeName(name).length;

    if (encoded > MAX_ENCODED_NAME) {
      throw new DriverError(
        "file",
        operation,
        new Error(
          `the ${what} encodes to ${encoded} bytes as a file name, and the most is ${MAX_ENCODED_NAME} (${NAME_MAX} minus ${NAME_OVERHEAD} for the marker and temp-file suffixes)`,
        ),
        { [what]: name, encoded, max: MAX_ENCODED_NAME, nameMax: NAME_MAX },
      );
    }
  }

  /** Path of a job's record. */
  #jobPath(q: QueueRef, id: string): string {
    return join(this.#queueDir(q), "jobs", `${encodeName(id)}.json`);
  }

  /**
   * Path of a job's log: one JSON-encoded line per entry, so a line holding a
   * newline still reads back as one entry.
   *
   * The name carries `createdAt` as well as the id. A job removed and added
   * again under the same id is a different job with a different `createdAt`, so
   * a log its predecessor left behind — a crash between deleting the record and
   * the log, or an append racing the removal — is never read as its own.
   */
  #logPath(q: QueueRef, record: Pick<JobRecord, "id" | "createdAt">): string {
    return join(
      this.#queueDir(q),
      "logs",
      `${encodeName(record.id)}.${record.createdAt}.jsonl`,
    );
  }

  /**
   * Path of a named value stored on a queue. Inside the queue's directory, so
   * `purge` takes it with the queue, and a lock beside it shares the stem.
   */
  #statePath(q: QueueRef, name: string): string {
    return join(this.#queueDir(q), "state", `${encodeName(name)}.json`);
  }

  /** Directory markers are moved into while their job is being changed. */
  #heldDir(q: QueueRef): string {
    return join(this.#queueDir(q), "held");
  }

  /**
   * Path of a worker's heartbeat record. Its own directory in the queue's, so
   * `purge` takes it with the queue and `listQueues` never sees it.
   */
  #workerPath(q: QueueRef, id: string): string {
    return join(this.#queueDir(q), "workers", `${encodeName(id)}.json`);
  }

  /**
   * Directory of a queue's throughput bucket files, one `<minute>.jsonl` per
   * minute. Its own directory, so no bucket name meets any other file's.
   */
  #throughputDir(q: QueueRef): string {
    return join(this.#queueDir(q), "throughput");
  }

  /**
   * Path of a repeat definition.
   *
   * The key is fitted to the file-name budget rather than refused: a series
   * key, generated or not, can be 191 legal characters that encode to far more
   * than a file name holds, and refusing it would throw where the caller never
   * chose. The fitting is invisible — `listRepeats` reads each key from the
   * record, never from a file name — and deterministic, so every lookup of one
   * key reaches one file.
   */
  #repeatPath(q: QueueRef, key: string): string {
    const name = fitName(key, {
      maxLength: MAX_ENCODED_NAME,
      measured: {
        max: MAX_ENCODED_NAME,
        measure: (value) => encodeName(value).length,
      },
    });
    return join(this.#queueDir(q), "repeats", `${encodeName(name)}.json`);
  }

  /**
   * Path of the events log for one target.
   *
   * Three ways, one per kind, and both halves of that matter. A `worker`
   * event's target is a queue name, so the runner branch this used to fall
   * into would have created `runners/<queue>/` — and `listRunners`, which
   * lists that directory, would have reported the queue as a runner. Nor can
   * it share the queue's own log: the subscription filters by path alone, so
   * a queue subscriber would then receive every worker event as well.
   */
  #eventsPath(event: { ns: string; kind: EventKind; target: string }): string {
    switch (event.kind) {
      case "queue":
        return join(
          this.#queueDir({ ns: event.ns, queue: event.target }),
          "events.jsonl",
        );
      case "worker":
        return join(
          this.#queueDir({ ns: event.ns, queue: event.target }),
          "worker-events.jsonl",
        );
      default:
        return join(this.#runnerDir(event.ns, event.target), "events.jsonl");
    }
  }

  /* --- index markers ----------------------------------------------------- */

  /**
   * The marker name for a record. The prefix is what its state is ordered
   * by, zero-padded so a lexical `readdir` sort *is* the claim order.
   *
   * The id comes last, through `encodeName`, which preserves code-point order
   * and emits ASCII only. So a marker name is all ASCII, the default `sort()`
   * on markers is already byte (and so code-point) order, and ties on the
   * prefix break by id exactly as `compareCodePoints` would — non-ASCII ids
   * included, which `encodeURIComponent` (`%` sorting before every letter) got
   * wrong. The encoded id never contains `-`, so the marker splits one way.
   */
  #markerFor(record: JobRecord): string {
    switch (record.state) {
      case "waiting":
        return `${pad(record.priority + PRIORITY_OFFSET, 8)}-${pad(record.createdAt, 13)}-${encodeName(record.id)}`;
      case "delayed":
      case "failed":
        return `${pad(record.runAt, 13)}-${encodeName(record.id)}`;
      case "active":
        return activeMarker(record.lockExpiresAt ?? 0, record.id);
      // By creation, not by the finish time the default uses: a parent
      // requeued after being buried has had `finishedOn` cleared, and one
      // that still carried it would sort as if it had finished.
      case "waiting-children":
        return `${pad(record.createdAt, 13)}-${encodeName(record.id)}`;
      default:
        return `${pad(record.finishedOn ?? record.createdAt, 13)}-${encodeName(record.id)}`;
    }
  }

  /** Creates the marker for a newly added job. */
  async #addMarker(q: QueueRef, record: JobRecord): Promise<void> {
    // `Bun.write` creates a missing directory itself.
    const dir = join(this.#queueDir(q), "index", record.state);
    await Bun.write(join(dir, this.#markerFor(record)), "");
  }

  /**
   * Moves a job's marker to where `updated` belongs. The rename is the
   * mutual exclusion: whoever completes it owns the transition, and whoever
   * arrives second gets `ENOENT` and `false`.
   */
  async #move(
    q: QueueRef,
    marker: string,
    from: JobState,
    updated: JobRecord,
  ): Promise<boolean> {
    const dir = join(this.#queueDir(q), "index");
    const target = join(dir, updated.state, this.#markerFor(updated));

    return await this.#take(join(dir, from, marker), target, {
      madeDir: false,
    });
  }

  /**
   * Renames `from` to `to`, and says whether it did. The rename is the
   * exclusion, so `false` means somebody else moved `from` first.
   *
   * The target's directory is made only when the rename fails, and then the
   * rename is tried once more — the pattern `#hold` and `#place` use. A
   * missing directory and a missing source both arrive as `ENOENT`, so a lost
   * race costs one `mkdir` more than it did; `state.madeDir` bounds that to
   * once per caller, which is what keeps a claim walking a contended listing
   * from paying it per marker.
   */
  async #take(
    from: string,
    to: string,
    /** Shared across one caller's renames: whether the `mkdir` has run. */
    state: { madeDir: boolean },
  ): Promise<boolean> {
    try {
      await rename(from, to);
      return true;
    } catch (error) {
      if (state.madeDir || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        return false;
      }
    }

    state.madeDir = true;
    await mkdir(join(to, ".."), { recursive: true }).catch(() => undefined);

    try {
      await rename(from, to);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Changes one job while holding its marker, and answers with what was
   * written — or `null` when there is no such job or `decide` refuses it.
   *
   * The marker is the job's lock everywhere else in this driver, so it is here
   * too: renamed out of the index into `held/`, which no claim, completion or
   * promotion looks in, the job cannot move under the change. The record is
   * read again once held, `decide` judges *that* copy, the record is written,
   * and the marker goes back wherever the new record says it belongs.
   *
   * Record before marker, as `promoteDelayed` does, so a crash at any point
   * leaves a hold whose record is either the old job or the new one — both
   * whole — and `#healHolds` files the marker by whichever it finds.
   *
   * `decide` is called twice, once to refuse without taking anything and once
   * under the hold, so it must not have side effects beyond remembering its
   * last judgment.
   *
   * `known` stands in for the first read when the caller has just read the
   * record anyway (a rewrite walk); it is still read again under the hold.
   */
  async #mutateJob(
    q: QueueRef,
    id: string,
    decide: (record: JobRecord) => JobRecord | null,
    known?: JobRecord,
  ): Promise<JobRecord | null> {
    const held = await this.#holdJob(
      q,
      id,
      (record) => decide(record) !== null,
      known,
    );
    if (!held) {
      return null;
    }

    const { record: current, hold } = held;
    let updated = decide(current);

    // Whatever `pruneExpired` concluded about this job may no longer hold.
    this.#pruneSkips.delete(
      join(this.#queueDir(q), "index", current.state, this.#markerFor(current)),
    );

    if (!updated) {
      await this.#place(q, hold, current);
      return null;
    }

    // An active job's marker is named by its lock expiry. A change that leaves
    // that alone would put the marker back under the name it was taken from,
    // and a completion that read the record before the change would still find
    // it and write its stale copy over this one. One millisecond more lock
    // renames the marker, so that completion misses and reads again instead.
    if (
      updated.state === "active" &&
      current.state === "active" &&
      this.#markerFor(updated) === this.#markerFor(current)
    ) {
      updated = { ...updated, lockExpiresAt: (current.lockExpiresAt ?? 0) + 1 };
    }

    try {
      await this.#writeAtomic(this.#jobPath(q, id), JSON.stringify(updated));
    } catch (error) {
      await this.#place(q, hold, current);
      throw error;
    }

    await this.#release(q, hold, current, updated);
    return updated;
  }

  /**
   * Removes a job while holding its marker, and says whether it did — `false`
   * when there is no such job, `accept` refuses the record read under the
   * hold, or somebody else kept the marker past `HOLD_PATIENCE_MS`.
   *
   * Every path that deletes a job comes through here — `removeJob`,
   * `cleanJobs`, `pruneExpired`, `drainQueue` and retention, by count or on
   * completion — so none of them can forget the log, and none can race a
   * change.
   *
   * **Why a hold, rather than `updateJob` checking afterwards.** A removal
   * that just deleted the marker and the record could land while a patch held
   * the marker, and the patch's record write then brought the job back.
   * Having the patch look afterwards for a removal it missed and undo its write
   * is a check-then-act of its own: between the look and the undo, the id can
   * be added again, and the undo deletes the new job. Taking the same marker
   * leaves no window. Whichever of the two renames it first, the other cannot
   * until the first puts it back — and a removal never puts it back.
   *
   * **Log, then record, then the hold.** A crash after the log goes leaves a
   * hold `#healHolds` returns to the index with its record, so the job survives
   * the failed removal, without its log. A crash after the record goes leaves a
   * hold with no record, which it discards. Neither leaves a log without a
   * record, and `addJobLog` takes the same hold, so no append can recreate one
   * in between.
   *
   * `known` stands in for the first read when the caller has just read the
   * record anyway: a listing sweep, or retention straight after a completion.
   * The record is still read again under the hold.
   */
  async #deleteJob(
    q: QueueRef,
    id: string,
    accept: (record: JobRecord) => boolean,
    known?: JobRecord,
  ): Promise<boolean> {
    const held = await this.#holdJob(q, id, accept, known);
    if (!held) {
      return false;
    }

    await unlink(this.#logPath(q, held.record)).catch(() => undefined);

    try {
      await unlink(this.#jobPath(q, id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await this.#place(q, held.hold, held.record);
        throw new DriverError("file", "deleteJob", error, { id });
      }
    }

    await unlink(held.hold).catch(() => undefined);
    return true;
  }

  /**
   * Takes a job's marker out of the index for as long as the caller needs the
   * job to stand still, and answers with the record as read under the hold —
   * or `null` when there is no such job, `accept` refuses it, or somebody else
   * kept hold of it past `HOLD_PATIENCE_MS`.
   *
   * The caller owns the hold it gets back, and must end it: put the marker
   * back with `#place`/`#release`, or delete it along with the job.
   *
   * `accept` is asked twice, once before taking anything and once of the copy
   * read under the hold, so it must not have side effects.
   */
  async #holdJob(
    q: QueueRef,
    id: string,
    accept: (record: JobRecord) => boolean,
    known?: JobRecord,
  ): Promise<HeldJob | null> {
    const path = this.#jobPath(q, id);
    const deadline = Date.now() + HOLD_PATIENCE_MS;
    let first: JobRecord | undefined = known;

    for (;;) {
      const record = first ?? (await this.#readJob(path));
      first = undefined;

      if (!record || !accept(record)) {
        return null;
      }

      const marker = this.#markerFor(record);
      const hold = await this.#hold(q, record.state, marker);

      if (!hold) {
        if (Date.now() >= deadline) {
          return null;
        }

        // The marker is not where the record says. If the record has moved on
        // since, somebody finished a transition: read again and decide afresh.
        // If it has not, somebody is part-way through one — a claim renames
        // before it writes — or holds the marker; wait for them.
        const fresh = await this.#readJob(path);
        if (
          fresh &&
          fresh.state === record.state &&
          this.#markerFor(fresh) === marker
        ) {
          await this.#healHolds(q);
          await sleep(LOCK_RETRY_MS, { unref: true }).catch(() => {});
        }
        continue;
      }

      const current = await this.#readJob(path);

      if (!current) {
        await rm(hold, { force: true });
        return null;
      }

      // The record moved between the first read and the hold: the marker held
      // is not this record's. Put it where the record says and start over.
      if (
        current.state !== record.state ||
        this.#markerFor(current) !== marker
      ) {
        await this.#place(q, hold, current);
        continue;
      }

      if (!accept(current)) {
        await this.#place(q, hold, current);
        return null;
      }

      return { record: current, hold };
    }
  }

  /**
   * Takes a marker out of the index, and answers with where it now is — or
   * `null` when somebody else got to it first.
   *
   * The hold's name starts with when it was taken, which is how `#healHolds`
   * tells a hold whose process died from one still in use. A marker's own
   * modification time would not do: `rename` keeps it, and it dates from when
   * the job was added.
   */
  async #hold(
    q: QueueRef,
    state: JobState,
    marker: string,
  ): Promise<string | null> {
    const dir = this.#heldDir(q);
    const from = join(this.#queueDir(q), "index", state, marker);
    const path = join(dir, `${Date.now()}.${state}.${marker}`);

    try {
      await rename(from, path);
      return path;
    } catch {
      // Made on the first failure rather than in `ensureQueue`, which runs on
      // every add and claim; a missing directory and a missing marker both
      // arrive as ENOENT, so try once more.
      await mkdir(dir, { recursive: true });
    }

    try {
      await rename(from, path);
      return path;
    } catch {
      return null;
    }
  }

  /** Moves a marker to where `record` says it belongs. `false` when it is gone. */
  async #place(q: QueueRef, from: string, record: JobRecord): Promise<boolean> {
    const dir = join(this.#queueDir(q), "index", record.state);
    const target = join(dir, this.#markerFor(record));

    try {
      await rename(from, target);
      return true;
    } catch {
      await mkdir(dir, { recursive: true }).catch(() => undefined);
    }

    try {
      await rename(from, target);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns a held marker to the index for `after`, the record just written.
   *
   * The hold can be gone: a holder slow enough to look dead has had it filed
   * by `#healHolds`, which placed it by whichever record it read — `before` or
   * `after`. If it was `before`, move it on from there.
   */
  async #release(
    q: QueueRef,
    hold: string,
    before: JobRecord,
    after: JobRecord,
  ): Promise<void> {
    if (await this.#place(q, hold, after)) {
      return;
    }

    await this.#place(
      q,
      join(this.#queueDir(q), "index", before.state, this.#markerFor(before)),
      after,
    );
  }

  /** Files every hold older than `LOCK_STALE_MS` by its job's record. */
  async #healHolds(q: QueueRef): Promise<void> {
    const dir = this.#heldDir(q);
    const now = Date.now();

    for (const name of await this.#list(dir)) {
      const hold = parseHold(name);
      if (!hold || now - hold.stamp <= LOCK_STALE_MS) {
        continue;
      }

      const path = join(dir, name);
      const record = await this.#readJob(
        this.#jobPath(q, markerId(hold.marker)),
      );

      if (!record) {
        await rm(path, { force: true });
        continue;
      }

      await this.#place(q, path, record);
    }
  }

  /**
   * Whether a lock holder whose marker rename failed should read again and
   * retry, rather than report the lock lost.
   *
   * A failed rename used to mean exactly that. It no longer does: `updateJob`
   * may hold the marker for a moment, or have renamed it by bumping the lock a
   * millisecond. So look at the record: if the lock is still this token's, the
   * job is still ours, and the marker is either somewhere new (retry at once)
   * or on its way back (wait a beat). Only the failure path pays for this.
   */
  async #retryLostRename(
    q: QueueRef,
    id: string,
    token: string,
    marker: string,
    deadline: number,
  ): Promise<boolean> {
    if (Date.now() >= deadline) {
      return false;
    }

    const fresh = await this.#readJob(this.#jobPath(q, id));
    if (!fresh || fresh.state !== "active" || fresh.lockToken !== token) {
      return false;
    }

    if (this.#markerFor(fresh) === marker) {
      await this.#healHolds(q);
      await sleep(LOCK_RETRY_MS, { unref: true }).catch(() => {});
    }

    return true;
  }

  /**
   * Whether the job behind a waiting marker has an excluded name. `false` when
   * its record is missing: the claim's own path deals with litter.
   */
  async #isExcluded(
    q: QueueRef,
    waiting: string,
    marker: string,
    excluded: Set<string>,
  ): Promise<boolean> {
    const key = join(waiting, marker);
    let name = this.#names.get(key);

    if (name === undefined) {
      const record = await this.#readJob(this.#jobPath(q, markerId(marker)));
      if (!record) {
        return false;
      }

      name = record.name;
      if (this.#names.size >= NAME_CACHE_SIZE) {
        this.#names.delete(this.#names.keys().next().value!);
      }
      this.#names.set(key, name);
    }

    return excluded.has(name);
  }

  /**
   * Removes a finished job now, or caps how many are kept. A TTL is already in
   * the record, put there by `expiryFor` when the job finished.
   */
  async #applyRetention(
    q: QueueRef,
    record: JobRecord,
    retention: Retention,
  ): Promise<void> {
    const sameState = (candidate: JobRecord) =>
      candidate.state === record.state;

    if (retention === true) {
      await this.#deleteJob(q, record.id, sameState, record);
      return;
    }

    if (retention === false || retention === undefined) {
      return;
    }

    // A TTL is not stamped here: `expiryFor` put it in the record the
    // completion wrote. A second write afterwards, with nothing around it,
    // could land over a patch — or a patch over it, and the job would then
    // never expire.
    const count = typeof retention === "number" ? retention : retention.count;

    if (count === undefined || count < 0) {
      return;
    }

    // Markers sort by finish time, so the oldest beyond the cap are first.
    const dir = join(this.#queueDir(q), "index", record.state);
    const markers = (await this.#list(dir)).sort();

    // A child whose parent has not taken its outcome yet stays — checked
    // again under the hold, since it may be marked recorded in between.
    const sweepable = (candidate: JobRecord) =>
      sameState(candidate) && !awaitsDelivery(candidate);

    for (const marker of markers.slice(
      0,
      Math.max(0, markers.length - count),
    )) {
      const stale = await this.#readJob(this.#jobPath(q, markerId(marker)));
      if (stale && !awaitsDelivery(stale)) {
        await this.#deleteJob(q, stale.id, sweepable, stale);
      }
    }
  }

  /* --- read API helpers ---------------------------------------------------- */

  /** The records behind some index markers, read at once; `null` where missing. */
  async #readMarked(
    q: QueueRef,
    markers: string[],
  ): Promise<(JobRecord | null)[]> {
    return await Promise.all(
      markers.map(
        async (marker) =>
          await this.#readJob(this.#jobPath(q, markerId(marker))),
      ),
    );
  }

  /**
   * Deletes a worker record found lapsed at `now` — unless the worker reported
   * again since it was read. The record is renamed aside first, which exactly
   * one caller wins, and the copy it moved is read again: still lapsed, it is
   * dropped; live, it goes back, unless a newer report has taken the path.
   */
  async #dropLapsedWorker(path: string, now: number): Promise<void> {
    const aside = `${path}.${newId()}.lapsed`;

    try {
      await rename(path, aside);
    } catch {
      return;
    }

    const moved = await this.#readJson<WorkerInfo>(aside);
    if (moved && moved.expiresAt > now) {
      await link(aside, path).catch(() => undefined);
    }
    await rm(aside, { force: true });
  }

  /**
   * Writes one batch of throughput counts: a JSON line per entry, appended to
   * its queue's `throughput/<minute>.jsonl`.
   *
   * No lock. Each append is one small `O_APPEND` write, which POSIX makes
   * atomic, so processes appending to the same minute cannot interleave within
   * a line — and each line is this process's count, summed on read. An entry
   * whose append fails is counted again for the next flush rather than failing
   * the batch, which would re-add the entries that did land and count them
   * twice. Then, per queue written, minute files older than the retention
   * before the latest minute in the batch are deleted: one listing per queue
   * per flush, never per job.
   */
  async #writeThroughput(
    batch: PendingThroughput[],
  ): Promise<ThroughputWriteResult> {
    const latest = new Map<string, number>();
    const unwritten: PendingThroughput[] = [];
    let failure: unknown;

    for (const entry of batch) {
      const dir = this.#throughputDir(entry.q);
      const line = `${JSON.stringify({
        at: entry.at,
        completed: entry.completed,
        failed: entry.failed,
      })}\n`;

      try {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${entry.at}.jsonl`), line, { flag: "a" });
      } catch (error) {
        // Reported, so only this line is written again.
        unwritten.push(entry);
        failure ??= error;
        continue;
      }

      latest.set(dir, Math.max(latest.get(dir) ?? entry.at, entry.at));
    }

    for (const [dir, at] of latest) {
      const cutoff = at - THROUGHPUT_RETENTION_MS;

      for (const file of await this.#list(dir)) {
        const match = THROUGHPUT_FILE.exec(file);
        if (match && Number(match[1]) < cutoff) {
          await unlink(join(dir, file)).catch(() => undefined);
        }
      }
    }

    return failure === undefined
      ? { unwritten }
      : { unwritten, error: failure };
  }

  /* --- analytics storage -------------------------------------------------- */

  /**
   * Counts a queue's completions or failed attempts, into both the shipped
   * per-minute throughput and the analytics buckets.
   *
   * The two are separate stores answering the same question at different
   * widths: `getThroughput` is the shipped one and keeps its own retention,
   * and `getQueueMetrics` has no other writer, so a queue's analytics series
   * is made here or nowhere.
   */
  #countJob(q: QueueRef, now: number, counts: Partial<JobCounters>): void {
    this.#throughput.add(q, now, counts.completed ?? 0, counts.failed ?? 0);
    this.#jobMetrics.count(q.ns, this.#queueEntity(q.queue), now, counts);
  }

  /**
   * Writes one batch of counter rows: a JSON line each, appended to
   * `metrics/<kind>/<entity>/<bucket>.jsonl`.
   *
   * The throughput layout's shape, and for its reasons — an `O_APPEND` write
   * of one small line is atomic, so processes sharing a bucket cannot
   * interleave within a line, and the read sums the lines. An entry whose
   * append fails is reported rather than thrown, so only it is written again.
   */
  async #writeCounters<C extends Record<keyof C, number>>(
    kind: MetricKind,
    batch: PendingMetric<C>[],
  ): Promise<BufferWriteResult<PendingMetric<C>>> {
    return await this.#appendBatch(
      kind,
      batch,
      (entry) => entry.counts as Record<string, unknown>,
    );
  }

  /** The same, for the rows that carry a histogram or a sample rather than counters. */
  async #writeStats<S>(
    kind: MetricKind,
    batch: PendingStats<S>[],
  ): Promise<BufferWriteResult<PendingStats<S>>> {
    return await this.#appendBatch(
      kind,
      batch,
      (entry) => entry.stats as Record<string, unknown>,
    );
  }

  /**
   * Appends a batch's rows, then sweeps if the prune is due.
   *
   * The sweep is **not** per entity written, which is what the throughput
   * layout does (`#writeThroughput`): that is a directory listing per queue
   * per flush, and it never reaches a series nobody writes to any more, so a
   * worker that stopped reporting would keep its buckets for good.
   */
  async #appendBatch<TEntry extends { at: number; entity: string; ns: string }>(
    kind: MetricKind,
    batch: TEntry[],
    payload: (entry: TEntry) => Record<string, unknown>,
  ): Promise<BufferWriteResult<TEntry>> {
    const unwritten: TEntry[] = [];
    let failure: unknown;
    let latest = 0;

    for (const entry of batch) {
      const dir = this.#metricsDir(entry.ns, kind, entry.entity);

      try {
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, `${entry.at}.jsonl`),
          `${JSON.stringify(payload(entry))}\n`,
          { flag: "a" },
        );
      } catch (error) {
        unwritten.push(entry);
        failure ??= error;
        continue;
      }

      this.#metricsNamespaces.add(entry.ns);
      latest = Math.max(latest, entry.at);
    }

    await this.#pruneMetrics(latest);

    return failure === undefined
      ? { unwritten }
      : { unwritten, error: failure };
  }

  /**
   * Drops every metric bucket past the retention, once a minute per process.
   *
   * By range: every entity of every kind in every namespace this instance has
   * written to, read back from the directory rather than from the batch — so a
   * queue, worker or runner that stopped being written to loses its old
   * buckets like any other. The clock is what keeps a whole-tree walk off the
   * counting path.
   *
   * `latest` is the newest bucket just written, and the later of it and the
   * wall clock drives the clock — so a caller that passes times in, as the
   * contract suite does, can step the sweep forward instead of waiting.
   */
  async #pruneMetrics(latest: number): Promise<void> {
    const now = Math.max(Date.now(), latest);

    if (!this.#metricsPrune.due(now)) {
      return;
    }

    const cutoff = metricsPruneCutoff(
      this.#metrics,
      this.#metricsInterval,
      now,
    );

    for (const ns of this.#metricsNamespaces) {
      await this.#pruneMetricsDir(
        join(this.root, encodeSegment(ns), "metrics"),
        cutoff,
      );
    }
  }

  /**
   * One directory of the metrics tree swept, and everything below it.
   *
   * Whatever is not a bucket file is taken for a directory and descended into
   * — a kind, a queue, a worker key — which is what lets a kind nest as deep
   * as it needs to. An encoded entity name can hold no `.`, so nothing but a
   * bucket file can match {@link METRIC_FILE}, and `#list` answers `[]` for
   * anything that turns out not to be a directory.
   */
  async #pruneMetricsDir(dir: string, cutoff: number): Promise<void> {
    for (const entry of await this.#list(dir)) {
      const match = METRIC_FILE.exec(entry);

      if (!match) {
        await this.#pruneMetricsDir(join(dir, entry), cutoff);
      } else if (Number(match[1]) < cutoff) {
        await unlink(join(dir, entry)).catch(() => undefined);
      }
    }
  }

  /**
   * One series' stored rows in range, this driver's own pending counts written
   * first so a caller sees what it has just counted.
   *
   * Empty without a file read for a width this backend does not keep: the
   * route asks for one `getMetricsSupport()` reported, and answering nothing
   * is what says the width is not there.
   */
  async #readMetrics<T>(
    ns: string,
    kind: MetricKind,
    entity: string,
    query: MetricsQuery,
  ): Promise<({ at: number } & Partial<T>)[]> {
    if (!this.#servesInterval(query.interval)) {
      return [];
    }

    await this.flushMetrics();
    return await this.#readMetricRows<T>(ns, kind, entity, query);
  }

  /**
   * {@link FileDriver.#readMetrics} without the flush, for a read that has
   * flushed once already and now reads many series: a grouped read flushes
   * once, not once per entity and kind.
   */
  async #readMetricRows<T>(
    ns: string,
    kind: MetricKind,
    entity: string,
    query: MetricsQuery,
  ): Promise<({ at: number } & Partial<T>)[]> {
    if (!this.#servesInterval(query.interval)) {
      return [];
    }

    const dir = this.#metricsDir(ns, kind, entity);
    const rows: ({ at: number } & Partial<T>)[] = [];

    for (const file of await this.#list(dir)) {
      const match = METRIC_FILE.exec(file);
      const at = Number(match?.[1]);
      if (!match || at < query.from || at > query.to) {
        continue;
      }

      // Newline-terminated lines only: a partial last line is an append in
      // flight, or one a crash cut short.
      const lines = (await this.#readText(join(dir, file))).split("\n");
      for (const line of lines.slice(0, -1)) {
        const row = safeJsonParse<Partial<T> | null>(line, null);
        if (row) {
          rows.push({ ...row, at });
        }
      }
    }

    return rows;
  }

  /**
   * Whether this backend keeps buckets of `interval` — minutes only, unless
   * recording was turned down further. A read at any other width answers
   * nothing, which is how a caller learns the width is not kept.
   */
  #servesInterval(interval: number): boolean {
    return this.#metrics.intervals.includes(interval);
  }

  /** The namespace's own roll-up rows for a counter kind. */
  async #rollUp<C>(
    ns: string,
    kind: MetricKind,
    query: MetricsQuery,
  ): Promise<({ at: number } & Partial<C>)[]> {
    return await this.#readMetrics<C>(ns, kind, NAMESPACE_ENTITY, query);
  }

  /**
   * Directory of one series' bucket files, one `<bucket>.jsonl` per bucket.
   *
   * A directory per entity rather than a file per entity, because the prune is
   * a range: deleting whole files below a cutoff needs no read, where one file
   * per series would mean rewriting it.
   *
   * `entity` is already encoded, and may be more than one segment deep — a
   * worker's series is its queue and then its key. The sweep walks whatever
   * depth it finds, so a kind may nest as far as it needs to.
   */
  #metricsDir(ns: string, kind: MetricKind, entity: string): string {
    return join(
      this.root,
      encodeSegment(ns),
      "metrics",
      kind,
      entity === NAMESPACE_ENTITY ? NAMESPACE_DIR : entity,
    );
  }

  /**
   * The stored path of one queue's series: the queue name, encoded.
   *
   * `encodeName` rather than `encodeSegment`, so that the roll-up's
   * {@link NAMESPACE_DIR} — which starts with a `-`, a character `encodeName`
   * never emits — cannot be some queue's directory as well.
   */
  #queueEntity(queue: string): string {
    return encodeName(queue);
  }

  /**
   * The stored path of one worker's series: its queue, then its stable
   * `WorkerInfo.key`.
   *
   * Keyed by `key` and never by `WorkerInfo.id`: an id is one incarnation, so
   * a rolling redeploy would shred the series into one per replica. Scoped by
   * queue because a worker record is, so two queues' workers that happen to
   * share a key stay two series.
   */
  #workerEntity(q: QueueRef, key: string): string {
    return join(encodeName(q.queue), encodeName(key));
  }

  /* --- primitives --------------------------------------------------------- */

  /**
   * Directory entries, or `[]` when the directory does not exist yet.
   * Temporary files from an interrupted atomic write are skipped, so a crash
   * mid-write cannot be mistaken for an index entry.
   */
  async #list(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir)).filter((entry) => !entry.endsWith(".tmp"));
    } catch {
      return [];
    }
  }

  /**
   * Directory names under `dir`, decoded back into the segments they encode.
   * An entry `encodeSegment` could not have written is not one of ours.
   */
  async #listSegments(dir: string): Promise<string[]> {
    const segments: string[] = [];

    for (const entry of await this.#list(dir)) {
      const segment = decodeSegment(entry);
      if (segment !== null) {
        segments.push(segment);
      }
    }

    return segments;
  }

  /** A file's text, or `""` when it is missing. */
  async #readText(path: string): Promise<string> {
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  }

  /**
   * A job's record, or `null` when it is missing or malformed.
   *
   * Every record read goes through here rather than `#readJson`, because a
   * record written before flows existed has no `flow` key at all, and the
   * contract says `null`. Filling it in at the one place records are read
   * means no caller sees `undefined`, and no write carries it forward.
   */
  async #readJob(path: string): Promise<JobRecord | null> {
    const record = await this.#readJson<JobRecord>(path);
    if (record && record.flow === undefined) {
      record.flow = null;
    }
    return record;
  }

  /** Parses a JSON file, or `null` when it is missing or malformed. */
  async #readJson<T>(path: string): Promise<T | null> {
    try {
      return safeJsonParse<T | null>(await readFile(path, "utf8"), null);
    } catch {
      return null;
    }
  }

  /**
   * Creates a file only if it does not exist. `O_EXCL` is the primitive the
   * whole driver rests on: exactly one caller can win.
   */
  async #createExclusive(path: string, contents: string): Promise<boolean> {
    try {
      await this.#writeExclusive(path, contents);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw new DriverError("file", "createExclusive", error, { path });
    }
  }

  /**
   * `writeFile` with `wx`, making the directory only if the first attempt finds
   * it missing — not before every create, which was a `mkdir` and a `stat` on a
   * directory that nearly always exists. One call rather than `open`, write
   * and `close` on a handle: the same system calls, in one trip to the thread
   * pool instead of three.
   */
  async #writeExclusive(path: string, contents: string): Promise<void> {
    try {
      await writeFile(path, contents, { flag: "wx" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents, { flag: "wx" });
  }

  /**
   * Writes via a temp file and a rename, so a reader never sees a partial file.
   * No `mkdir` first: `Bun.write` creates a missing directory itself, and the
   * rename stays inside it.
   */
  async #writeAtomic(path: string, contents: string): Promise<void> {
    const temp = `${path}.${process.pid}.${newId()}.tmp`;

    try {
      // `Bun.write` rather than `node:fs`. Measured on this exact shape — a
      // ~400 byte JSON record — it is 7.3us against 19.1us, and this runs on
      // every add, claim, promotion and completion. Reads stay on `node:fs`:
      // `Bun.file().json()` measured 16.8us against 16.4us, so there is
      // nothing to gain and it reports a missing file differently.
      await Bun.write(temp, contents);
      await rename(temp, path);
    } catch (error) {
      // Best effort: the temp file may never have been created — a name too
      // long fails before it is — and a failure here must not replace the
      // error that explains what went wrong.
      await rm(temp, { force: true }).catch(() => undefined);
      throw new DriverError("file", "writeAtomic", error, { path });
    }
  }

  /**
   * Remembers that the finished marker at `key` need not be read again by
   * `pruneExpired` before its record could be due (see `#pruneSkips`).
   */
  #skipPrune(key: string, record: JobRecord, now: number): void {
    const cap = now + PRUNE_SKIP_MS;
    const until =
      record.expiresAt !== null && !awaitsDelivery(record)
        ? Math.min(record.expiresAt, cap)
        : cap;

    if (this.#pruneSkips.size >= PRUNE_SKIP_CACHE_SIZE) {
      // Lapsed entries first; when every entry is live, remember no more.
      for (const [entry, lapses] of this.#pruneSkips) {
        if (lapses <= now) {
          this.#pruneSkips.delete(entry);
        }
      }
      if (this.#pruneSkips.size >= PRUNE_SKIP_CACHE_SIZE) {
        return;
      }
    }

    this.#pruneSkips.set(key, until);
  }

  /**
   * Records `count` as the line count of the job log at `path`, with the file's
   * identity as it stands now (see `#logCounts`): one `stat`, taken only after
   * a log had to be read.
   */
  async #rememberLogCount(path: string, count: number): Promise<void> {
    const info = await stat(path).catch(() => null);

    if (!info) {
      this.#logCounts.delete(path);
      return;
    }

    this.#setLogCount(path, { ino: info.ino, size: info.size, count });
  }

  /** Stores a job log's count, dropping the oldest entry past the cap. */
  #setLogCount(path: string, entry: LogCount): void {
    this.#logCounts.delete(path);

    if (this.#logCounts.size >= LOG_COUNT_CACHE_SIZE) {
      this.#logCounts.delete(this.#logCounts.keys().next().value!);
    }
    this.#logCounts.set(path, entry);
  }

  /**
   * Appends to a file, making its directory only when the append finds it
   * missing rather than before every append.
   */
  async #append(path: string, contents: string): Promise<void> {
    try {
      await writeFile(path, contents, { flag: "a" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents, { flag: "a" });
  }

  /**
   * Whether anything is sitting in the queue's waiting index.
   *
   * Only asked once per wait, at the top, so the cost is a single `readdir` on
   * a directory that is almost always empty — a caller only waits because its
   * claim just came back with nothing.
   */
  async #hasWaiting(q: QueueRef): Promise<boolean> {
    const waiting = join(this.#queueDir(q), "index", "waiting");
    return (await this.#list(waiting)).length > 0;
  }

  /** Modification time in milliseconds, or `0` when the file is absent. */
  async #mtime(path: string): Promise<number> {
    try {
      return (await stat(path)).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** File size in bytes, or `0` when absent. */
  async #size(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch {
      return 0;
    }
  }

  /**
   * Touches the file workers watch for new work.
   *
   * Only its modification time is ever read (`waitForJob` compares it), so
   * this sets the time rather than rewriting the file: one `utimes` where an
   * atomic write was a create, a write, a close and a rename. The time given
   * is fine-grained and strictly increasing within the process, so two wakes
   * inside one kernel timestamp tick still read as two changes — a
   * kernel-stamped mtime is only tick-granular on older kernels.
   */
  async #touchWake(q: QueueRef): Promise<void> {
    const path = join(this.#queueDir(q), "wake");
    const at = Math.max(
      performance.timeOrigin + performance.now(),
      this.#lastWake + 0.001,
    );
    this.#lastWake = at;

    try {
      await utimes(path, at / 1000, at / 1000);
    } catch {
      // Not there yet (a first wake, or a purge since): creating it is a
      // change from the `0` a missing file reads as. `Bun.write` makes the
      // directory too.
      await Bun.write(path, "");
    }
  }

  /** Merges fields into a queue's metadata. */
  async #setMeta(q: QueueRef, fields: Record<string, unknown>): Promise<void> {
    await this.ensureQueue(q);
    const path = join(this.#queueDir(q), "meta.json");
    const meta = (await this.#readJson<Record<string, unknown>>(path)) ?? {};
    await this.#writeAtomic(path, JSON.stringify({ ...meta, ...fields }));
  }

  /** A runner's persisted state, with defaults for a first read. */
  async #readState(
    ns: string,
    key: string,
  ): Promise<{
    fields: Record<string, string>;
    history: RunRecord[];
    queued: QueuedTrigger[];
  }> {
    const state = await this.#readJson<{
      fields?: Record<string, string>;
      history?: RunRecord[];
      queued?: QueuedTrigger[];
    }>(join(this.#runnerDir(ns, key), "state.json"));

    return {
      fields: state?.fields ?? {},
      history: state?.history ?? [],
      queued: state?.queued ?? [],
    };
  }

  /**
   * Runs `critical` holding a runner's `lock.mutex`, the file lock every
   * read-then-write of its `lock.json` takes — except `acquireLock`'s `O_EXCL`
   * fast path, which needs none. Its own file, not `state.lock`: a renewal
   * must not queue behind state writes.
   */
  async #withLockMutex<T>(dir: string, critical: () => Promise<T>): Promise<T> {
    const release = await this.#lockFile(join(dir, "lock.mutex"));

    try {
      return await critical();
    } finally {
      await release();
    }
  }

  /**
   * Read-modify-writes a runner's state while holding an exclusive lock file,
   * so two processes cannot both read, both modify, and both write.
   *
   * `mutate` returning `false` means it changed nothing, and the file is left
   * as it was rather than rewritten with the same content.
   */
  async #mutateState(
    ns: string,
    key: string,
    mutate: (state: {
      fields: Record<string, string>;
      history: RunRecord[];
      queued: QueuedTrigger[];
    }) => void | false,
  ): Promise<void> {
    const dir = this.#runnerDir(ns, key);
    await mkdir(dir, { recursive: true });
    const lock = join(dir, "state.lock");
    const release = await this.#lockFile(lock);

    try {
      const state = await this.#readState(ns, key);
      if (mutate(state) !== false) {
        await this.#writeAtomic(join(dir, "state.json"), JSON.stringify(state));
      }
    } finally {
      await release();
    }
  }

  /** Takes an exclusive lock file, breaking one left behind by a crash. */
  async #lockFile(path: string): Promise<() => Promise<void>> {
    const deadline = Date.now() + LOCK_WAIT_MS;

    while (Date.now() < deadline) {
      if (await this.#createExclusive(path, String(Date.now()))) {
        return async () => {
          await rm(path, { force: true });
        };
      }

      const held = await this.#mtime(path);
      if (held > 0 && Date.now() - held > LOCK_STALE_MS) {
        // Whoever held this is gone; break it and race for it again.
        //
        // By renaming it aside, not deleting it. Two processes can both judge
        // the same lock stale, and with `rm` the slower one deletes the lock the
        // faster one has just created in its place — both then hold it, which
        // for `setQueueState` means two compare-and-sets winning. Only one
        // rename of a given file succeeds, and the file it moved is checked:
        // still stale, it is dropped; fresh, it was somebody's live lock, and
        // goes back unless the path has been taken again meanwhile.
        const aside = `${path}.${newId()}.stale`;
        try {
          await rename(path, aside);
        } catch {
          continue;
        }

        if (Date.now() - (await this.#mtime(aside)) <= LOCK_STALE_MS) {
          await link(aside, path).catch(() => undefined);
        }
        await rm(aside, { force: true });
        continue;
      }

      await sleep(LOCK_RETRY_MS, { unref: true }).catch(() => {});
    }

    throw new DriverError(
      "file",
      "lockFile",
      new Error(`Timed out waiting for ${path}`),
      { path },
    );
  }
}

/** A job log's line count, and the file it was counted in (see `#logCounts`). */
interface LogCount {
  /** The log file's inode when counted; a rewrite gives it a new one. */
  ino: number;
  /** The log file's size in bytes when counted; an append changes it. */
  size: number;
  /** Newline-terminated lines the file held. */
  count: number;
}

/** A job whose marker the caller has taken out of the index. */
interface HeldJob {
  /** The job's record, as read once the marker was held. */
  record: JobRecord;
  /** Where the marker is while held; the caller must place or delete it. */
  hold: string;
}

/**
 * When a finished job should expire under `retention`: now plus its TTL when
 * it has one, and otherwise whatever the record already said.
 */
function expiryFor(
  retention: Retention,
  now: number,
  current: number | null,
): number | null {
  if (typeof retention === "object" && retention.ttl && retention.ttl > 0) {
    return now + retention.ttl;
  }
  return current;
}

/** Left-pads a number so lexical order matches numeric order. */
function pad(value: number, width: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(width, "0");
}

/**
 * Whether a `completed` or `dead` marker may name a job that finished inside
 * the filter's range, judged by its name alone: its prefix is the padded
 * `finishedOn`. A superset, never a guess — the prefix is `finishedOn` floored
 * and clamped at `0`, so the lower bound is floored to match and a `0` prefix
 * is always kept, and a name that does not parse is kept too. The record,
 * read afterwards, has the last word.
 */
function mayFinishIn(filter: AttributionFilter, marker: string): boolean {
  const prefix = Number(marker.slice(0, marker.indexOf("-")));

  if (!Number.isFinite(prefix) || prefix === 0) {
    return true;
  }

  return inFinishedRange(
    {
      finishedFrom:
        filter.finishedFrom === undefined
          ? undefined
          : Math.floor(filter.finishedFrom),
      finishedTo: filter.finishedTo,
    },
    prefix,
  );
}

/** The marker name of an active job, which is ordered by its lock expiry. */
function activeMarker(lockExpiresAt: number, id: string): string {
  return `${pad(lockExpiresAt, 13)}-${encodeName(id)}`;
}

/** Splits a hold's name into when it was taken, the state it was taken from and the marker it holds. */
function parseHold(
  name: string,
): { stamp: number; state: string; marker: string } | null {
  // `<stamp>.<state>.<marker>`: none of the three contains a dot (an encoded
  // id never does), but reading only the first two keeps that from mattering.
  const first = name.indexOf(".");
  const second = name.indexOf(".", first + 1);
  const stamp = Number(name.slice(0, first));

  if (first <= 0 || second <= first || !Number.isFinite(stamp)) {
    return null;
  }

  return {
    stamp,
    state: name.slice(first + 1, second),
    marker: name.slice(second + 1),
  };
}

/**
 * Reads a run's JSONL log back, oldest first.
 *
 * Only newline-terminated records count, and one that will not parse is
 * skipped: a crash mid-append leaves a partial last record, and treating it as
 * a line would put a half-written object into a reader's page. `bytes` is
 * recomputed rather than stored, so the file holds exactly the contract's
 * fields and nothing a future version would have to keep writing.
 */
function readRunLogFile(text: string): StoredRunLogLine[] {
  const lines: StoredRunLogLine[] = [];

  for (const record of text.split("\n").slice(0, -1)) {
    const line = safeJsonParse<RunLogLine | null>(record, null);

    if (line && typeof line.seq === "number") {
      lines.push({ ...line, bytes: runLogBytes(line.text) });
    }
  }

  return lines;
}

/** Renders run-log lines as JSONL, each record newline-terminated. */
function writeRunLogFile(lines: readonly StoredRunLogLine[]): string {
  return lines
    .map((line) => `${JSON.stringify(readRunLogLine(line))}\n`)
    .join("");
}

/** Whether `path` is a directory: `false` when it is absent. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** How many newline-terminated lines `text` holds. */
function countLines(text: string): number {
  let count = 0;
  for (
    let at = text.indexOf("\n");
    at !== -1;
    at = text.indexOf("\n", at + 1)
  ) {
    count++;
  }
  return count;
}

/** `text` without its first `lines` lines. */
function dropLines(text: string, lines: number): string {
  let at = -1;
  for (let dropped = 0; dropped < lines; dropped++) {
    at = text.indexOf("\n", at + 1);
    if (at === -1) {
      return "";
    }
  }
  return text.slice(at + 1);
}

/**
 * The job id encoded in a marker name.
 *
 * Everything after the last `-`, because `encodeName` never emits one. The
 * old URI-encoded ids kept their dashes, and telling a waiting marker's two
 * numeric prefixes from one prefix and an id that merely *began* with digits
 * and a dash — `1700000000000-abc`, delayed — was a guess that got it wrong.
 *
 * `""` for a name this driver did not write: no record lives there, so every
 * caller treats the file as litter.
 */
function markerId(marker: string): string {
  return decodeName(marker.slice(marker.lastIndexOf("-") + 1)) ?? "";
}
