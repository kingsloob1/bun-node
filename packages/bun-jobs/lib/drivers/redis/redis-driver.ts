import type { SerializedError } from "@kingsleyweb/bun-common";
import type { RedisClient } from "bun";
import type {
  ConnectionInput,
  ConnectionOptions,
} from "../../shared/connection";
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
  JobWorkerRef,
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
  StoredJobOptions,
  ThroughputBucket,
  WorkerInfo,
  WorkerMetricsQuery,
  WorkerMetricsRead,
  WorkerMetricsSeries,
  WorkerMetricsTotals,
  WorkerMetricsTotalsQuery,
} from "../driver";
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
  RawBusynessBucket,
  RawDurationBucket,
  ResolvedMetricsOptions,
  RunnerRunCounters,
  WorkerMetricsRef,
} from "../metrics";
import type { MetricsSeries } from "./keys";
import type { RenderedScripts } from "./scripts";
import { Buffer } from "node:buffer";
import { jsonClone } from "@kingsleyweb/bun-common";
import { RedisClient as BunRedis } from "bun";
import {
  JOB_DEFAULT_KEYS,
  MINUTE_BUCKET_MS,
  SECOND_BUCKET_MS,
} from "../../api/contract/constants";
import {
  assertRewriteRequest,
  decodeRewriteCursor,
  emptyRewriteResult,
  encodeRewriteCursor,
} from "../../queue/jobDefaults";
import { assertWritableStateName } from "../../queue/windows";
import { resolveConnectionUrl } from "../../shared/connection";
import { DriverError } from "../../shared/errors";
import { safeJsonParse } from "../../shared/json";
import { runnerKey } from "../../shared/keys";
import { waitForAny } from "../../shared/wait";
import {
  attributionFilter,
  attributionOf,
  canMatchState,
  matchesNothing,
} from "../attribution";
import {
  addBusynessSample,
  addDuration,
  bucketStart,
  DURATION_HISTOGRAM_SIZE,
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
  metricsRetentionFor,
  metricsSupportOf,
  NAMESPACE_ENTITY,
  PendingBuffer,
  resolveMetricsOptions,
  RUNNER_RUN_COUNTERS,
  runnerTotalsOf,
  splitWorkerMetricsEntity,
  uniqueWorkerRefs,
  workerMetricsEntity,
  workerTotalsOf,
} from "../metrics";
import {
  jobFilter,
  matchesFilter,
  orderByIds,
  sortWorkers,
  sumBuckets,
  sumStates,
  THROUGHPUT_BUCKET_MS,
  THROUGHPUT_RETENTION_MS,
} from "../readApis";
import { emptyRunLog, pageRunLog, runLogBytes } from "../runLogs";
import {
  metricsField,
  metricsGroupSpan,
  metricsGroupStart,
  parseMetricsField,
  RedisKeys,
} from "./keys";
import * as scripts from "./scripts";
import { packStamp, STAMP_FIELD, unpackStamp } from "./stamp";

/**
 * What a rewrite cursor's key holds: the score and member of the last entry
 * examined in the state's sorted set.
 */
const REWRITE_CURSOR_KEY = ["number", "string"] as const;

/** Every answer `RECORD_CHILD` may give; anything else is a fault. */
const CHILD_RECORD_RESULTS = new Set<ChildRecordResult>([
  "recorded",
  "released",
  "buried",
  "already",
  "parent-dead",
  "missing",
]);

/**
 * A flow reference as JSON, keys always `queue` then `id`. The skeleton is
 * written with it and `RECORD_CHILD` searches the skeleton for it, so the two
 * must produce the same bytes for the same reference.
 */
function flowRefJson(ref: JobRef): string {
  return JSON.stringify({ queue: ref.queue, id: ref.id });
}

/**
 * What a worker series' buffered rows are keyed by inside one namespace: the
 * queue and the worker's stable key, joined.
 *
 * A buffer row carries a namespace and one entity name, and a worker belongs to
 * a queue, so the two travel together in that one field. `\0` is the separator
 * because a queue name is a validated key segment (letters, digits, `_`, `.`
 * and `-` only) and can never hold one, while a worker key is not validated at
 * all and may hold anything — so the split takes the **first** separator and a
 * worker key containing one is still read correctly.
 */
const WORKER_ENTITY_SEPARATOR = "\u0000";

/** A queue and a worker key as one buffer entity name. */
function workerEntity(queue: string, key: string): string {
  return `${queue}${WORKER_ENTITY_SEPARATOR}${key}`;
}

/** A buffer entity name split back into its queue and worker key. */
function splitWorkerEntity(entity: string): { queue: string; key: string } {
  const cut = entity.indexOf(WORKER_ENTITY_SEPARATOR);

  return cut === -1
    ? { queue: entity, key: "" }
    : { queue: entity.slice(0, cut), key: entity.slice(cut + 1) };
}

/**
 * One bucket of statistics waiting to be written, for the two series that are
 * not plain counters.
 *
 * The counter series ride {@link MetricsBuffer}, which merges by adding; these
 * two merge by their own rules — durations take the extremes and add the
 * histogram, busyness takes the concurrency of the later sample — so they ride
 * {@link PendingBuffer} directly with the shared merge function.
 */
interface PendingStats<TStats> {
  /** The namespace. */
  ns: string;
  /** The runner id, or a {@link workerEntity}. */
  entity: string;
  /** The bucket's start, epoch ms. */
  at: number;
  /** The bucket's width, ms. */
  interval: number;
  /** What has been gathered for it. */
  stats: TStats;
}

/**
 * One entity a flush names in a metrics index — see `RedisKeys.metricsIndex`.
 */
interface IndexEntry {
  /** The index: the namespace's set for runners, or for worker keys. */
  key: string;
  /**
   * The entity as the read will name it: a runner's id, or a worker as
   * `workerMetricsEntity(queue, key)`.
   */
  member: string;
}

/** A buffered row, as far as naming it in an index needs. */
interface IndexedRow {
  /** The namespace. */
  ns: string;
  /** The entity, as the buffer holds it. */
  entity: string;
  /** The bucket's start, epoch ms. */
  at: number;
  /** The bucket's width, ms. */
  interval: number;
}

/**
 * A driver backed by Redis.
 *
 * Redis has no transaction that can branch on what it reads — `MULTI` queues
 * commands and cannot look at a reply — so every decision here is a Lua
 * script instead. A script is the unit of atomicity: the server runs it start
 * to finish with nothing interleaved, which is precisely the guarantee
 * claiming a job needs. The scripts live in `scripts.ts`, cached by SHA and
 * re-sent whenever the server says it has forgotten them.
 *
 * It is also the only backend here that can wait properly. `BLPOP` on a wake
 * list means a worker learns about a job in about a millisecond rather than
 * on its next poll, which is why `blockingWait` is `true` — and why the
 * blocking pop and the subscriber each get their own connection, since a
 * connection inside a blocking call can do nothing else.
 */

/**
 * The score of the first entry in a `WITHSCORES` reply.
 *
 * The client hands those back as member/score pairs rather than the flat
 * array the protocol describes, and a future version may not; reading both
 * shapes costs a line and removes the question.
 */
function firstScore(reply: unknown): number | null {
  if (!Array.isArray(reply) || reply.length === 0) {
    return null;
  }

  const head = reply[0];
  const score = Array.isArray(head) ? head[1] : reply[1];

  return score === undefined ? null : Number(score);
}

/**
 * A claimer's ref exactly as its packed stamp reads back: absent parts left
 * out rather than present as `undefined`. A pid the stamp cannot carry (not
 * finite) decodes to no stamp at all, so it is decoded for real instead.
 */
function stampedRef(ref: JobWorkerRef): JobWorkerRef | null {
  if (ref.pid !== undefined && !Number.isFinite(ref.pid)) {
    return unpackStamp(packStamp(ref));
  }

  const out: JobWorkerRef = { id: ref.id };
  if (ref.key !== undefined) {
    out.key = ref.key;
  }
  if (ref.host !== undefined) {
    out.host = ref.host;
  }
  if (ref.pid !== undefined) {
    out.pid = ref.pid;
  }
  return out;
}

/** How long a blocking pop waits, at most, before the caller checks again. */
const MAX_BLOCK_SECONDS = 5;

/** How long a wake-control list outlives the push that made it, ms. */
const WAKE_CONTROL_TTL_MS = 60_000;

/**
 * One blocking connection and the pop loop that serves every wake key it
 * names — the whole driver outside Cluster, one queue name inside it.
 */
interface WakeGroup {
  /**
   * The connection, memoised as a promise so concurrent first waits share
   * one. Rejects when it could not be made; the waits report that.
   */
  client: Promise<RedisClient>;
  /** The private list the pop also names; a push to it re-issues the pop. */
  control: string;
  /** The wake keys this group serves; those without a waiter drop out. */
  keys: Set<string>;
  /** When each current wait ends; the pop blocks until the latest, at most. */
  deadlines: Set<{ at: number }>;
  /** When the pop in flight times out, ms since the epoch. */
  parkedUntil: number;
  /** Whether the pop loop is running. */
  running: boolean;
  /** The keys the pop in flight names, or `null` between pops. */
  parked: Set<string> | null;
  /** Whether a control push is already on its way for the pop in flight. */
  nudged: boolean;
}

/**
 * How many jobs go into one add script.
 *
 * A script takes its arguments as one flat list, and each job contributes its
 * values, so a large chunk is both a large packet and a long stretch of Redis's
 * single thread — during which every other client waits. Measured across chunk
 * sizes for 5,000 jobs, the curve is shallow and flattens here: 60.6ms at 100,
 * 57.5ms at 200, 55.4ms at 500, 55.7ms at 1,000, 57.2ms at 2,500. 500 also
 * happens to be the batch size a caller adding in pages tends to reach for, so
 * a page becomes one round trip rather than three.
 */
const ADD_CHUNK = 500;

/**
 * How many set members one `FIND_JOBS` call examines while a filtered
 * `findJobs` walks a state. Each member costs the script one `HMGET` and, when
 * it matches, the reply an id and perhaps a name, so this bounds both how long
 * one call holds Redis's single thread and how large a reply gets — and it is
 * why a walk over *n* members is `ceil(n / FIND_CHUNK)` calls, never *n*.
 */
const FIND_CHUNK = 500;

/**
 * Job fields stored as JSON rather than as scalars.
 *
 * A hash keeps the scalars the scripts compare on — state, priority, runAt,
 * the lock token — readable and writable from Lua without parsing anything,
 * while the payloads stay opaque strings, exactly as every other driver
 * stores them.
 */
type JsonField =
  | "data"
  | "opts"
  | "progress"
  | "returnValue"
  | "failedReason"
  | "stacktrace"
  | "flow";

/** Options for {@link RedisDriver}. */
export interface RedisDriverOptions extends ConnectionInput {
  /** A connection string. Wins over `connection` when both are given. */
  url?: string;
  /** The connection as fields, for when a URL is not what you have. */
  connection?: ConnectionOptions;
  /**
   * Prepended to every key, ahead of the namespace, so this driver's keys are
   * one `SCAN` away in a Redis it shares. Defaults to `bun-jobs`.
   */
  keyPrefix?: string;
  /**
   * Whether the server is a cluster. Keys are then hash-tagged per queue and
   * per runner, because a script may only touch one slot.
   */
  cluster?: boolean;
  /**
   * An already-connected client, when the application has one to share. It
   * carries commands and scripts only; `url` is still required, because
   * blocking waits and pub/sub each need a connection of their own, and the
   * driver opens those from it. Without `url` the constructor throws a
   * `ConfigError`.
   */
  client?: RedisClient;
  /** How long a blocking wait lasts, at most. Defaults to 5 seconds. */
  maxBlockSeconds?: number;
  /**
   * What analytics to record, and for how long. Every default applies as it
   * stands — Redis can afford per-second buckets, so nothing here is capped
   * away.
   *
   * Two things follow from changing it. `resolution: "minute"` turns the
   * per-second half off everywhere, including the block inside `COMPLETE` and
   * `FAIL`; and `secondRetentionMs` is interpolated into those scripts, so two
   * drivers configured differently are running different script text (§9.10 of
   * the analytics design).
   */
  metrics?: MetricsOptions;
}

export class RedisDriver implements JobsDriver {
  /** Identifies the implementation in errors and capability checks. */
  readonly name = "redis";

  /**
   * The only backend that can wait rather than poll: a worker blocks on the
   * queue's wake list and hears about a job in about a millisecond.
   */
  readonly capabilities: DriverCapabilities = {
    blockingWait: true,
    events: "push",
    multiProcess: true,
    multiHost: true,
    jobAttribution: true,
  };

  /** How keys are named. */
  readonly keys: RedisKeys;

  /** The connection commands run on. */
  readonly #client: RedisClient;
  /** Whether this driver opened the connection and must close it. */
  readonly #ownsClient: boolean;
  /** The connection URL, so extra connections can be made from it. */
  readonly #url: string;
  /** Longest a blocking pop waits. */
  readonly #maxBlock: number;
  /**
   * Cached script SHAs, so a script is sent once rather than per call.
   *
   * **Keyed by the script's source text, never by its name, and owned by one
   * driver** (§9.10). Two of these scripts carry their retention in a
   * `PEXPIREAT`, so two drivers configured differently hold different text for
   * the same operation; a cache keyed by name would hand the second driver the
   * first one's digest and quietly write the first one's expiries.
   */
  readonly #shas = new Map<string, string>();
  /** What this driver records and for how long, with defaults and caps applied. */
  readonly #metrics: ResolvedMetricsOptions;
  /** The scripts whose text depends on {@link RedisDriver.#metrics}. */
  readonly #scripts: RenderedScripts;
  /**
   * The namespace's job roll-up, gathered in memory and written once a second.
   *
   * **The one thing Redis cannot count inside the script** (§4f): a namespace
   * key sits outside the queue's hash tag, so a script touching both would be
   * cross-slot in Cluster and rejected. The consequence is written down here
   * because callers see it — the roll-up is up to a second behind the
   * per-queue counts it mirrors, exactly as on every buffered backend, and a
   * process killed outright loses the second it had not written.
   */
  readonly #nsJobs: MetricsBuffer<JobCounters>;
  /** Per-worker job counts, and the namespace's `workerJobs` roll-up beside them. */
  readonly #workerJobs: MetricsBuffer<JobCounters>;
  /** Per-runner outcome counts, and the namespace's `runs` roll-up beside them. */
  readonly #runnerRuns: MetricsBuffer<RunnerRunCounters>;
  /** Per-runner run durations, merged per bucket before they are written. */
  readonly #durations: PendingBuffer<PendingStats<DurationStats>>;
  /** Per-worker busyness samples, merged per bucket before they are written. */
  readonly #busyness: PendingBuffer<PendingStats<BusynessStats>>;
  /**
   * The connection reserved for pub/sub, once anything subscribes. A promise,
   * memoised, so two first subscriptions in the same tick share one
   * connection rather than each opening one and leaking the first.
   */
  #subscriber: Promise<RedisClient> | undefined;
  /**
   * The blocking pops, one per {@link WakeGroup}: a single group outside
   * Cluster, one per queue name inside it. See `waitForJob`.
   */
  readonly #wakeGroups = new Map<string, WakeGroup>();
  /**
   * What each waited-on wake key's waiters are released by: resolved when a
   * token for that key arrives, or when its group's connection fails.
   */
  readonly #wakes = new Map<string, PromiseWithResolvers<void>>();
  /** A name for this instance's private wake-control lists. */
  readonly #wakeOwner = Bun.randomUUIDv7();
  /** How many callers are currently waiting on each wake key. */
  readonly #waiters = new Map<string, number>();
  /**
   * Keys whose pop took a wake token with nobody left to give it to.
   *
   * `BLPOP` is a destructive read of a list, so a token it takes is gone for
   * everyone. A pop whose caller has since given up would therefore swallow
   * the wake an `add()` sent and leave that job waiting out a whole further
   * period; remembering it here hands it to the next waiter instead.
   */
  readonly #missed = new Set<string>();
  /** Channels with listeners, so `close()` can unsubscribe them. */
  readonly #channels = new Map<string, Set<(event: DriverEvent) => void>>();
  /** Resolves once the client is connected. */
  #ready: Promise<void> | undefined;

  constructor(options: RedisDriverOptions) {
    this.#url = resolveConnectionUrl(
      options,
      { scheme: "redis", tlsScheme: "rediss", host: "127.0.0.1", port: 6379 },
      "The Redis driver",
    );

    this.keys = new RedisKeys({
      prefix: options.keyPrefix,
      cluster: options.cluster,
    });

    this.#maxBlock = options.maxBlockSeconds ?? MAX_BLOCK_SECONDS;
    this.#client = options.client ?? new BunRedis(this.#url);
    this.#ownsClient = !options.client;

    // No `MetricsLimits`: Redis keeps per-second buckets perfectly well.
    this.#metrics = resolveMetricsOptions(options.metrics);
    this.#scripts = scripts.renderScripts({
      secondRetentionMs: this.#metrics.secondRetentionMs,
      minuteRetentionMs: this.#metrics.minuteRetentionMs,
    });

    const intervals = this.#metrics.intervals;

    // Named rather than inline, so each `write` is one readable line.
    const nsJobsKey = (row: PendingMetric<JobCounters>): string =>
      this.#namespaceSeriesKey("jobs", row);
    const workerJobsKey = (row: PendingMetric<JobCounters>): string =>
      this.#workerSeriesKey("wjobs", row);
    const runnerRunsKey = (row: PendingMetric<RunnerRunCounters>): string =>
      this.#runnerSeriesKey("runs", row);
    const workerIndex = (row: IndexedRow): IndexEntry | undefined =>
      this.#workerIndexEntry(row);
    const runnerIndex = (row: IndexedRow): IndexEntry | undefined =>
      this.#runnerIndexEntry(row);

    this.#nsJobs = new MetricsBuffer<JobCounters>({
      keys: JOB_COUNTERS,
      intervals,
      // There is nothing to roll up: these rows *are* the roll-up, and the
      // per-queue rows they mirror are written inside COMPLETE and FAIL.
      rollUp: false,
      write: async (batch) =>
        await this.#writeCounts(batch, JOB_COUNTERS, nsJobsKey),
    });

    this.#workerJobs = new MetricsBuffer<JobCounters>({
      keys: JOB_COUNTERS,
      intervals,
      write: async (batch) =>
        await this.#writeCounts(
          batch,
          JOB_COUNTERS,
          workerJobsKey,
          workerIndex,
        ),
    });

    this.#runnerRuns = new MetricsBuffer<RunnerRunCounters>({
      keys: RUNNER_RUN_COUNTERS,
      intervals,
      write: async (batch) =>
        await this.#writeCounts(
          batch,
          RUNNER_RUN_COUNTERS,
          runnerRunsKey,
          runnerIndex,
        ),
    });

    this.#durations = new PendingBuffer<PendingStats<DurationStats>>({
      key: (row) => `${row.ns}\n${row.entity}\n${row.interval}\n${row.at}`,
      merge: (into, from) => mergeDurationStats(into.stats, from.stats),
      ns: (row) => row.ns,
      write: async (batch) => await this.#writeDurations(batch),
    });

    this.#busyness = new PendingBuffer<PendingStats<BusynessStats>>({
      key: (row) => `${row.ns}\n${row.entity}\n${row.interval}\n${row.at}`,
      merge: (into, from) => mergeBusynessStats(into.stats, from.stats),
      ns: (row) => row.ns,
      write: async (batch) => await this.#writeBusyness(batch),
    });
  }

  /* --- lifecycle ---------------------------------------------------- */

  async connect(): Promise<void> {
    this.#ready ??= this.#client.connect().then(() => undefined);
    await this.#ready;
  }

  async close(): Promise<void> {
    // Before the connections go: closing a buffer writes what it still holds,
    // and it has nothing to write with afterwards.
    await Promise.allSettled([
      this.#nsJobs.close(),
      this.#workerJobs.close(),
      this.#runnerRuns.close(),
      this.#durations.close(),
      this.#busyness.close(),
    ]);

    const subscriber = await this.#subscriber?.catch(() => undefined);
    for (const channel of this.#channels.keys()) {
      await subscriber?.unsubscribe(channel).catch(() => {});
    }
    this.#channels.clear();

    // The extra connections are always ours, whoever owns the main one.
    // Closing a blocking one fails its parked pop, which releases that
    // group's waiters; the group is dropped first so its loop stops there.
    const groups = [...this.#wakeGroups.values()];
    this.#wakeGroups.clear();
    for (const group of groups) {
      (await group.client.catch(() => undefined))?.close();
    }
    subscriber?.close();
    this.#subscriber = undefined;

    // Nothing may be carried over to a driver that connects again.
    for (const wake of this.#wakes.values()) {
      wake.resolve();
    }
    this.#wakes.clear();
    this.#waiters.clear();
    this.#missed.clear();

    if (this.#ownsClient) {
      this.#client.close();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.connect();
      return (await this.#client.ping()) !== null;
    } catch {
      return false;
    }
  }

  async purge(ns: string): Promise<void> {
    await this.connect();

    // Before the deletes, not after: a row still in a buffer would otherwise be
    // written back and bring the purged namespace's counts with it.
    this.#nsJobs.forget(ns);
    this.#workerJobs.forget(ns);
    this.#runnerRuns.forget(ns);
    this.#durations.forget(ns);
    this.#busyness.forget(ns);

    // SCAN rather than KEYS: a namespace may hold a great many keys, and
    // KEYS blocks the server while it walks all of them.
    const pattern = `${this.keys.namespace(ns)}:*`;
    let cursor = "0";

    do {
      const [next, batch] = (await this.#client.send("SCAN", [
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        "500",
      ])) as [string, string[]];

      cursor = next;

      if (batch.length > 0) {
        await this.#client.send("DEL", batch);
      }
    } while (cursor !== "0");
  }

  async listRunners(ns: string): Promise<string[]> {
    await this.connect();
    return (await this.#client.smembers(this.keys.runners(ns))) ?? [];
  }

  async listQueues(ns: string): Promise<string[]> {
    await this.connect();
    return (await this.#client.smembers(this.keys.queues(ns))) ?? [];
  }

  /* --- runner: locks -------------------------------------------------- */

  async acquireLock(
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    try {
      await this.connect();

      const taken = await this.#run(
        scripts.ACQUIRE_LOCK,
        [this.keys.runner(ns, this.#runnerId(key)).lock],
        [token, String(now), String(now + ttlMs), String(ttlMs)],
      );

      if (Number(taken) !== 1) {
        return false;
      }

      // A runner exists as soon as it has taken its lock.
      await this.#client.sadd(this.keys.runners(ns), this.#runnerId(key));
      return true;
    } catch {
      // Fail closed: never run exclusive work whose exclusivity is unproven.
      return false;
    }
  }

  async renewLock(
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    await this.connect();

    const renewed = await this.#run(
      scripts.RENEW_LOCK,
      [this.keys.runner(ns, this.#runnerId(key)).lock],
      [token, String(now), String(now + ttlMs), String(ttlMs)],
    );

    return Number(renewed) === 1;
  }

  async releaseLock(ns: string, key: string, token: string): Promise<boolean> {
    await this.connect();

    const released = await this.#run(
      scripts.RELEASE_LOCK,
      [this.keys.runner(ns, this.#runnerId(key)).lock],
      [token],
    );

    return Number(released) === 1;
  }

  async getLock(
    ns: string,
    key: string,
    now: number,
  ): Promise<LockInfo | null> {
    await this.connect();

    const held = (await this.#run(
      scripts.GET_LOCK,
      [this.keys.runner(ns, this.#runnerId(key)).lock],
      [String(now)],
    )) as string | null;

    if (!held) {
      return null;
    }

    const separator = held.lastIndexOf("|");
    return {
      token: held.slice(0, separator),
      expiresAt: Number(held.slice(separator + 1)),
    };
  }

  /* --- runner: state -------------------------------------------------- */

  async getState(ns: string, key: string): Promise<Record<string, string>> {
    await this.connect();
    const state = await this.#client.hgetall(
      this.keys.runner(ns, this.#runnerId(key)).state,
    );

    return (state as Record<string, string> | null) ?? {};
  }

  async setState(
    ns: string,
    key: string,
    fields: Record<string, string | number | null>,
  ): Promise<void> {
    await this.connect();
    const stateKey = this.keys.runner(ns, this.#runnerId(key)).state;

    const set: string[] = [];
    const remove: string[] = [];

    for (const [field, value] of Object.entries(fields)) {
      if (value === null) {
        remove.push(field);
      } else {
        set.push(field, String(value));
      }
    }

    // A runner exists once it has written state — on `start()`, whether or
    // not it ever takes a lock, as a parallel-mode runner never does.
    await this.#client.sadd(this.keys.runners(ns), this.#runnerId(key));

    if (set.length > 0) {
      await this.#client.send("HSET", [stateKey, ...set]);
    }
    if (remove.length > 0) {
      await this.#client.send("HDEL", [stateKey, ...remove]);
    }
  }

  async incrementCounters(
    ns: string,
    key: string,
    deltas: Record<string, number>,
  ): Promise<Record<string, number>> {
    await this.connect();
    const stateKey = this.keys.runner(ns, this.#runnerId(key)).state;
    const updated: Record<string, number> = {};

    // `HINCRBY` is atomic, so concurrent runners cannot lose a count.
    for (const [field, delta] of Object.entries(deltas)) {
      updated[field] = Number(
        await this.#client.hincrby(stateKey, field, delta),
      );
    }

    return updated;
  }

  async appendHistory(
    ns: string,
    key: string,
    record: RunRecord,
    keep: number,
  ): Promise<void> {
    await this.connect();

    await this.#run(
      scripts.APPEND_HISTORY,
      [this.keys.runner(ns, this.#runnerId(key)).history],
      [JSON.stringify(record), String(keep)],
    );
  }

  async updateHistory(
    ns: string,
    key: string,
    runId: string,
    patch: Partial<RunRecord>,
  ): Promise<boolean> {
    await this.connect();
    const history = this.keys.runner(ns, this.#runnerId(key)).history;

    const entries = (await this.#client.lrange(history, 0, -1)) ?? [];
    const index = entries.findIndex(
      (entry) => safeJsonParse<RunRecord | null>(entry, null)?.runId === runId,
    );

    if (index === -1) {
      return false;
    }

    const merged = {
      ...safeJsonParse<RunRecord>(entries[index], {} as RunRecord),
      ...jsonClone(patch),
    };

    const updated = await this.#run(
      scripts.UPDATE_HISTORY,
      [history],
      [runId, JSON.stringify(merged)],
    );

    return Number(updated) === 1;
  }

  async listHistory(
    ns: string,
    key: string,
    limit?: number,
  ): Promise<RunRecord[]> {
    await this.connect();

    const entries =
      (await this.#client.lrange(
        this.keys.runner(ns, this.#runnerId(key)).history,
        0,
        limit && limit > 0 ? limit - 1 : -1,
      )) ?? [];

    return entries
      .map((entry) => safeJsonParse<RunRecord | null>(entry, null))
      .filter((record): record is RunRecord => record !== null);
  }

  async clearHistory(ns: string, key: string): Promise<void> {
    await this.connect();
    await this.#client.del(this.keys.runner(ns, this.#runnerId(key)).history);
    // A run the history no longer names cannot be asked about, so its keys
    // would be memory nothing could ever reach or collect.
    await this.clearRunLogs(ns, key);
  }

  async appendRunLog(
    ns: string,
    key: string,
    runId: string,
    lines: RunLogInput[],
    caps: RunLogCaps,
  ): Promise<RunLogAppendResult> {
    await this.connect();
    const keys = this.keys.runner(ns, this.#runnerId(key));

    let bytes = 0;
    const encoded = lines.map((line) => {
      bytes += runLogBytes(line.text);
      // No `seq`: the list position carries it, so nothing has to renumber a
      // log when a cap drops its front.
      return JSON.stringify({
        stream: line.stream,
        at: line.at,
        text: line.text,
        ...(line.level === undefined ? {} : { level: line.level }),
        ...(line.truncated ? { truncated: true } : {}),
      });
    });

    const reply = await this.#run(
      scripts.APPEND_RUN_LOG,
      [
        `${keys.runLogPrefix}${runId}`,
        `${keys.runLinePrefix}${runId}`,
        keys.runLogs,
      ],
      [
        runId,
        String(Math.max(0, Math.floor(caps.maxLines))),
        String(Math.max(0, Math.floor(caps.maxBytes))),
        String(Math.max(0, Math.floor(caps.keepRuns))),
        String(bytes),
        keys.runLogPrefix,
        keys.runLinePrefix,
        ...encoded,
      ],
    );

    const [count, dropped, lastSeq] = Array.isArray(reply) ? reply : [0, 0, 0];

    return {
      count: Number(count ?? 0),
      dropped: Number(dropped ?? 0),
      lastSeq: Number(lastSeq ?? 0),
    };
  }

  async getRunLog(
    ns: string,
    key: string,
    runId: string,
    opts: RunLogQuery,
  ): Promise<RunLogPage> {
    await this.connect();
    const keys = this.keys.runner(ns, this.#runnerId(key));

    const reply = await this.#run(
      scripts.GET_RUN_LOG,
      [`${keys.runLogPrefix}${runId}`, `${keys.runLinePrefix}${runId}`],
      [],
    );

    const [dropped, ...stored] = Array.isArray(reply) ? reply : [0];

    if (stored.length === 0) {
      return emptyRunLog();
    }

    // The number a line never carried: the list is in order, and everything
    // ahead of it was dropped from the front.
    const offset = Number(dropped ?? 0);
    const lines = stored.map((entry, index) => ({
      ...safeJsonParse<Omit<RunLogLine, "seq">>(String(entry), {
        stream: "stdout",
        at: 0,
        text: String(entry),
      }),
      seq: offset + index + 1,
    }));

    return pageRunLog(lines, opts, {
      dropped: offset,
      lastSeq: offset + lines.length,
    });
  }

  async clearRunLogs(ns: string, key: string, runId?: string): Promise<void> {
    await this.connect();
    const keys = this.keys.runner(ns, this.#runnerId(key));

    if (runId !== undefined) {
      await this.#client.del(
        `${keys.runLogPrefix}${runId}`,
        `${keys.runLinePrefix}${runId}`,
      );
      await this.#client.lrem(keys.runLogs, 0, runId);
      return;
    }

    const runs = (await this.#client.lrange(keys.runLogs, 0, -1)) ?? [];

    if (runs.length > 0) {
      await this.#client.del(
        ...runs.flatMap((id) => [
          `${keys.runLogPrefix}${id}`,
          `${keys.runLinePrefix}${id}`,
        ]),
      );
    }

    await this.#client.del(keys.runLogs);
  }

  async removeRuns(
    ns: string,
    key: string,
    runIds: readonly string[],
  ): Promise<number> {
    const named = [...new Set(runIds)];

    if (named.length === 0) {
      return 0;
    }

    await this.connect();
    const keys = this.keys.runner(ns, this.#runnerId(key));

    // Every key the script touches is named here, and all of them carry the
    // runner's hash tag. Nothing joins the runner set, so a runner that did
    // not exist still does not.
    const removed = await this.#run(
      scripts.REMOVE_RUNS,
      [
        keys.history,
        keys.runLogs,
        ...named.flatMap((runId) => [
          `${keys.runLogPrefix}${runId}`,
          `${keys.runLinePrefix}${runId}`,
        ]),
      ],
      named,
    );

    return Number(removed ?? 0);
  }

  async pushQueuedTrigger(
    ns: string,
    key: string,
    trigger: QueuedTrigger,
    max: number,
  ): Promise<boolean> {
    await this.connect();

    const pushed = await this.#run(
      scripts.PUSH_QUEUED,
      [this.keys.runner(ns, this.#runnerId(key)).queued],
      [JSON.stringify(trigger), String(max)],
    );

    return Number(pushed) === 1;
  }

  async popQueuedTrigger(
    ns: string,
    key: string,
  ): Promise<QueuedTrigger | null> {
    await this.connect();

    const head = await this.#client.lpop(
      this.keys.runner(ns, this.#runnerId(key)).queued,
    );

    return head ? safeJsonParse<QueuedTrigger | null>(head, null) : null;
  }

  async peekQueuedTrigger(
    ns: string,
    key: string,
  ): Promise<QueuedTrigger | null> {
    await this.connect();

    // `LINDEX 0` is the element `LPOP` takes next, read without removing it;
    // a missing key answers `nil` and is not created.
    const head = await this.#client.lindex(
      this.keys.runner(ns, this.#runnerId(key)).queued,
      0,
    );

    return head ? safeJsonParse<QueuedTrigger | null>(head, null) : null;
  }

  async popQueuedTriggerIf(
    ns: string,
    key: string,
    expectedId: string,
  ): Promise<QueuedTrigger | null> {
    await this.connect();

    // One script — `LINDEX 0`, compare the id, `LPOP` — so the head checked
    // is the head taken, whatever other clients do meanwhile.
    const head = await this.#run(
      scripts.POP_QUEUED_IF,
      [this.keys.runner(ns, this.#runnerId(key)).queued],
      [expectedId],
    );

    return typeof head === "string"
      ? safeJsonParse<QueuedTrigger | null>(head, null)
      : null;
  }

  async countQueuedTriggers(ns: string, key: string): Promise<number> {
    await this.connect();
    return Number(
      await this.#client.llen(this.keys.runner(ns, this.#runnerId(key)).queued),
    );
  }

  async clearQueuedTriggers(ns: string, key: string): Promise<number> {
    await this.connect();
    const queued = this.keys.runner(ns, this.#runnerId(key)).queued;

    const count = Number(await this.#client.llen(queued));
    await this.#client.del(queued);
    return count;
  }

  /* --- queue: jobs ------------------------------------------------------ */

  async ensureQueue(q: QueueRef): Promise<void> {
    await this.connect();
    await this.#client.sadd(this.keys.queues(q.ns), q.queue);
  }

  async addJob(
    q: QueueRef,
    job: JobRecord,
  ): Promise<{ job: JobRecord; added: boolean }> {
    await this.connect();

    const values = this.#toValues(job);
    // The namespace's queue list beside the script, not inside it: the set
    // has no hash tag, so a script naming it is cross-slot in Cluster. Sent
    // together, so it rides the same round trip.
    const [added] = await Promise.all([
      this.#runQueue(q, scripts.ADD_JOB, [
        q.queue,
        String(Date.now()),
        String(values.length),
        ...values,
      ]),
      this.#client.sadd(this.keys.queues(q.ns), q.queue),
    ]);

    if (Number(added) === 1) {
      return { job: jsonClone(job), added: true };
    }

    const existing = await this.getJob(q, job.id);
    return { job: existing ?? jsonClone(job), added: false };
  }

  /**
   * Adds many jobs with one script per chunk.
   *
   * The loop this replaces cost a round trip per job. Chunked because a script
   * takes its arguments as one flat list, and a very long one is both a large
   * packet and a long stretch of Redis's single thread.
   */
  async addJobs(
    q: QueueRef,
    jobs: JobRecord[],
  ): Promise<{ job: JobRecord; added: boolean }[]> {
    if (jobs.length === 0) {
      return [];
    }

    // One job is not a batch, and the singular path already reports precisely
    // what happened to it.
    if (jobs.length === 1) {
      return [await this.addJob(q, jobs[0]!)];
    }

    await this.connect();
    // Beside the scripts, for the reason `addJob` gives.
    const listed = this.#client.sadd(this.keys.queues(q.ns), q.queue);
    // Awaited at the end; a chunk that throws first must not leave it unhandled.
    listed.catch(() => {});

    const results: { job: JobRecord; added: boolean }[] = [];

    for (let start = 0; start < jobs.length; start += ADD_CHUNK) {
      const chunk = jobs.slice(start, start + ADD_CHUNK);
      const args = [q.queue, String(Date.now()), String(chunk.length)];

      // Each job contributes a count and then that many values, in
      // `JOB_FIELDS` order. The count is how a brand-new job says it stopped
      // early; the script reads id, state, priority and runAt from fixed
      // positions within the values, so nothing else needs sending.
      for (const job of chunk) {
        const values = this.#toValues(job);
        args.push(String(values.length), ...values);
      }

      const reply = await this.#runQueue(q, scripts.ADD_JOBS, args);
      const flags = Array.isArray(reply) ? reply : [];

      // The ids already present, read back together — one round trip for
      // the chunk, where awaiting each in the loop cost one per duplicate.
      const present = chunk.filter(
        (_job, index) => Number(flags[index] ?? 0) !== 1,
      );
      const existing = await this.getJobs(
        q,
        present.map((job) => job.id),
      );
      const found = new Map(
        present.map((job, index) => [job.id, existing[index] ?? null]),
      );

      for (const [index, job] of chunk.entries()) {
        const added = Number(flags[index] ?? 0) === 1;
        results.push({
          job: added ? jsonClone(job) : (found.get(job.id) ?? jsonClone(job)),
          added,
        });
      }
    }

    await listed;
    return results;
  }

  async claimJob(q: QueueRef, opts: ClaimOptions): Promise<JobRecord | null> {
    await this.connect();

    const stamp = attributionOf(opts);
    const claimed = await this.#runQueue(q, scripts.CLAIM, [
      String(opts.now),
      opts.token,
      opts.workerId,
      String(opts.lockMs),
      "1000",
      // Who is claiming, packed into the one field the script writes beside
      // `workerId` — see stamp.ts.
      packStamp(stamp),
      // Last, because they are variadic. None at all is how the script knows
      // to take the plain head read.
      ...(opts.excludeNames ?? []),
    ]);

    const fields = this.#toObject(claimed);
    return fields ? this.#toRecord(fields, stamp) : null;
  }

  /**
   * Claims several jobs in one script.
   *
   * The script is the unit of atomicity, so a batch is exactly as exclusive as
   * a single claim. The reply is one `HGETALL` per job rather than a joined
   * string, because job data is arbitrary JSON and any separator would show up
   * inside it sooner or later.
   */
  async claimJobs(
    q: QueueRef,
    opts: ClaimOptions,
    limit: number,
  ): Promise<JobRecord[]> {
    await this.connect();

    const stamp = attributionOf(opts);
    const claimed = await this.#runQueue(q, scripts.CLAIM_MANY, [
      String(opts.now),
      opts.token,
      opts.workerId,
      String(opts.lockMs),
      "1000",
      String(Math.max(1, Math.floor(limit))),
      packStamp(stamp),
      // Last, because they are variadic. None at all is how the script knows
      // to take the plain head read.
      ...(opts.excludeNames ?? []),
    ]);

    if (!Array.isArray(claimed)) {
      return [];
    }

    // `ZRANGE` yielded these in score order and the script preserved it, so
    // claim order needs no restoring here.
    const records: JobRecord[] = [];
    for (const entry of claimed) {
      const fields = this.#toObject(entry);
      if (fields) {
        records.push(this.#toRecord(fields, stamp));
      }
    }

    return records;
  }

  async extendJobLock(
    q: QueueRef,
    id: string,
    token: string,
    lockMs: number,
    now: number,
  ): Promise<boolean> {
    await this.connect();

    const extended = await this.#runQueue(q, scripts.EXTEND_LOCK, [
      id,
      token,
      String(now + lockMs),
    ]);

    return Number(extended) === 1;
  }

  async completeJob(
    q: QueueRef,
    id: string,
    token: string,
    result: unknown,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    await this.connect();
    const { mode, count, ttl } = this.#retention(retention);

    const completed = await this.#runQueue(q, this.#scripts.COMPLETE, [
      id,
      token,
      String(now),
      JSON.stringify(result ?? null),
      mode,
      count,
      ttl,
    ]);

    if (Number(completed) !== 1) {
      return false;
    }

    // The queue's own buckets were counted inside the script; the namespace's
    // copy cannot be, so it is buffered here.
    this.#nsJobs.count(q.ns, NAMESPACE_ENTITY, now, { completed: 1 });
    return true;
  }

  /**
   * Completes several jobs held under one token in one script, so a worker's
   * burst of completions is one round trip rather than one each — see
   * `COMPLETE_MANY`.
   */
  async completeJobs(
    q: QueueRef,
    token: string,
    completions: { id: string; result: unknown; retention: Retention }[],
    now: number,
  ): Promise<string[]> {
    if (completions.length === 0) {
      return [];
    }

    await this.connect();

    const args = [token, String(now)];
    for (const { id, result, retention } of completions) {
      const { mode, count, ttl } = this.#retention(retention);
      args.push(id, JSON.stringify(result ?? null), mode, count, ttl);
    }

    const reply = await this.#runQueue(q, this.#scripts.COMPLETE_MANY, args);
    const done = Array.isArray(reply) ? reply.map(String) : [];

    if (done.length > 0) {
      this.#nsJobs.count(q.ns, NAMESPACE_ENTITY, now, {
        completed: done.length,
      });
    }
    return done;
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
    await this.connect();

    const existing = await this.getJob(q, id);
    if (!existing) {
      return false;
    }

    const stacktrace = [error, ...existing.stacktrace].slice(
      0,
      Math.max(0, keepStacktraces),
    );

    const { mode, count, ttl } = this.#retention(
      outcome.retry ? false : outcome.retention,
    );

    const failed = await this.#runQueue(q, this.#scripts.FAIL, [
      id,
      token,
      String(now),
      JSON.stringify(error),
      JSON.stringify(stacktrace),
      outcome.retry ? "1" : "0",
      String(outcome.retry ? outcome.runAt : existing.runAt),
      mode,
      count,
      ttl,
    ]);

    if (Number(failed) !== 1) {
      return false;
    }

    this.#nsJobs.count(q.ns, NAMESPACE_ENTITY, now, { failed: 1 });
    return true;
  }

  async buryJob(
    q: QueueRef,
    id: string,
    error: SerializedError,
    opts: { retention: Retention; keepStacktraces: number; token?: string },
    now: number,
  ): Promise<JobRecord | null> {
    await this.connect();

    const existing = await this.getJob(q, id);
    if (!existing) {
      return null;
    }

    // Built here, as `failJob` builds it: the script only swaps it in. The
    // state and lock are checked in the script, which is what counts.
    const stacktrace = [error, ...existing.stacktrace].slice(
      0,
      Math.max(0, opts.keepStacktraces),
    );
    const { mode, count, ttl } = this.#retention(opts.retention);

    const buried = await this.#runQueue(q, this.#scripts.BURY, [
      id,
      opts.token ?? "",
      String(now),
      JSON.stringify(error),
      JSON.stringify(stacktrace),
      mode,
      count,
      ttl,
    ]);

    const fields = this.#toObject(buried);

    if (!fields) {
      return null;
    }

    // BURY counts the failure exactly when it returns a record, so the roll-up
    // follows the same condition rather than guessing at the job's state.
    this.#nsJobs.count(q.ns, NAMESPACE_ENTITY, now, { failed: 1 });
    return this.#toRecord(fields);
  }

  async updateProgress(
    q: QueueRef,
    id: string,
    progress: unknown,
  ): Promise<boolean> {
    await this.connect();

    // One script, so a job removed meanwhile cannot be recreated as an
    // orphan hash — see `UPDATE_PROGRESS`.
    const written = await this.#run(
      scripts.UPDATE_PROGRESS,
      [`${this.keys.queue(q).jobPrefix}${id}`],
      [JSON.stringify(progress ?? null)],
    );

    return Number(written) === 1;
  }

  /**
   * Changes a job's data, priority or due time in one script.
   *
   * Everything the script cannot know without a clock is settled here first:
   * the state a new `runAt` leads to, and which states the patch allows. An
   * empty allowed set can match nothing, so it costs no round trip at all.
   */
  async updateJob(
    q: QueueRef,
    id: string,
    patch: JobPatch,
    now: number,
  ): Promise<JobRecord | null> {
    const pending: JobState[] = ["waiting", "delayed"];
    let allowed: JobState[] | undefined = patch.onlyIn;

    // Only a pending job has a due time to move.
    if (patch.runAt !== undefined) {
      allowed = (allowed ?? pending).filter((state) => pending.includes(state));
    }

    if (allowed && allowed.length === 0) {
      return null;
    }

    await this.connect();

    const reply = await this.#runQueue(q, scripts.UPDATE_JOB, [
      id,
      patch.data === undefined ? "0" : "1",
      patch.data === undefined ? "" : JSON.stringify(patch.data),
      patch.priority === undefined ? "0" : "1",
      patch.priority === undefined ? "" : String(patch.priority),
      patch.runAt === undefined ? "0" : "1",
      patch.runAt === undefined ? "" : String(patch.runAt),
      patch.runAt !== undefined && patch.runAt > now ? "delayed" : "waiting",
      ...(allowed ?? []),
    ]);

    const fields = this.#toObject(reply);
    return fields ? this.#toRecord(fields) : null;
  }

  /**
   * Rewrites pending jobs' options with a queue's stored defaults, one
   * `REWRITE_PENDING` script per batch of at most `REWRITE_BATCH_MAX` jobs.
   *
   * Each state's sorted set is walked in its own order — the wait set by
   * priority then add sequence, the others by due time or creation — from a
   * `(score, member)` cursor, so jobs claimed, added or re-scored between
   * batches never make the walk skip one. A batch is one script: atomic
   * against claims, which is why `moved` counts only a hash that disagrees
   * with its set. The per-job rule, and why nothing re-encodes the blob, are
   * the script's.
   */
  async rewritePendingOptions(
    q: QueueRef,
    request: PendingOptionsRewrite,
  ): Promise<PendingOptionsRewriteResult> {
    assertRewriteRequest(request);

    const result = emptyRewriteResult();
    const { states } = request;
    let from = 0;
    let after: [number, string] | null = null;

    if (request.cursor !== null) {
      const cursor = decodeRewriteCursor(
        request.cursor,
        states,
        REWRITE_CURSOR_KEY,
      );
      from = states.indexOf(cursor.state);
      after = cursor.key as [number, string];
    }

    await this.connect();

    // Encoded once for the whole walk, and written by the script as sent.
    const values: string[] = [];
    for (const key of JOB_DEFAULT_KEYS) {
      const value = request.values[key];
      if (value !== undefined) {
        values.push(key, JSON.stringify(value));
      }
    }

    const keys = this.keys.queue(q);
    const sets: Partial<Record<JobState, string>> = {
      waiting: keys.wait,
      delayed: keys.delayed,
      failed: keys.failed,
      "waiting-children": keys.children,
    };
    /** The last job examined in this call, which the next call resumes after. */
    let last: { state: JobState; key: [number, string] } | undefined;

    for (let index = from; index < states.length; index++) {
      const state = states[index]!;
      let cursor = after;
      after = null;

      if (result.examined >= request.limit) {
        // The limit was met exactly at the end of an earlier state: the next
        // call is owed only when something is left to walk here.
        if (last && (await this.#client.zcard(sets[state]!)) > 0) {
          result.next = encodeRewriteCursor(last.state, last.key);
          return result;
        }
        continue;
      }

      for (;;) {
        const batch = Math.min(
          scripts.REWRITE_BATCH_MAX,
          request.limit - result.examined,
        );
        const reply = (await this.#runQueue(q, scripts.REWRITE_PENDING, [
          state,
          cursor ? "1" : "0",
          cursor ? String(cursor[0]) : "",
          cursor ? cursor[1] : "",
          String(batch),
          request.includeUnmarked ? "1" : "0",
          request.dryRun ? "1" : "0",
          ...values,
        ])) as unknown[];

        result.examined += Number(reply[0]);
        result.rewritten += Number(reply[1]);
        result.unchanged += Number(reply[2]);
        result.skippedExplicit += Number(reply[3]);
        result.skippedUnmarked += Number(reply[4]);
        result.moved += Number(reply[5]);
        result.exhausted += Number(reply[6]);

        const member = String(reply[8] ?? "");
        if (member !== "") {
          cursor = [Number(reply[7]), member];
          last = { state, key: cursor };
        }

        if (Number(reply[9]) !== 1) {
          break;
        }

        if (result.examined >= request.limit && last) {
          result.next = encodeRewriteCursor(last.state, last.key);
          return result;
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
    await this.connect();
    const keys = this.keys.queue(q);

    const count = await this.#run(
      scripts.ADD_JOB_LOG,
      [`${keys.jobPrefix}${id}`, `${keys.logPrefix}${id}`],
      [line, String(Math.max(0, Math.floor(keep)))],
    );

    return Number(count ?? 0);
  }

  async getJobLogs(
    q: QueueRef,
    id: string,
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<{ logs: string[]; count: number }> {
    await this.connect();

    const reply = await this.#run(
      scripts.GET_JOB_LOGS,
      [`${this.keys.queue(q).logPrefix}${id}`],
      [
        String(Math.max(0, Math.floor(opts.offset))),
        String(Math.max(0, Math.floor(opts.limit))),
        opts.order,
      ],
    );

    // The count leads, and the lines follow in the order asked for. They are
    // bulk strings, so they arrive exactly as they were pushed.
    const [count, ...lines] = Array.isArray(reply) ? reply : [0];
    return { logs: lines.map(String), count: Number(count ?? 0) };
  }

  async clearJobLogs(q: QueueRef, id: string): Promise<ClearJobLogsResult> {
    await this.connect();
    const keys = this.keys.queue(q);

    // The state check is inside the script, so a claim cannot land between
    // it and the delete.
    const reply = await this.#run(
      scripts.CLEAR_JOB_LOGS,
      [`${keys.jobPrefix}${id}`, `${keys.logPrefix}${id}`],
      [],
    );

    const [status, removed] = Array.isArray(reply) ? reply : [];

    if (status === "cleared") {
      return { status: "cleared", removed: Number(removed ?? 0) };
    }

    if (status === "active" || status === "missing") {
      return { status };
    }

    throw new DriverError(
      "redis",
      "clearJobLogs",
      new Error(`unexpected reply: ${JSON.stringify(reply)}`),
      { id },
    );
  }

  async getJob(q: QueueRef, id: string): Promise<JobRecord | null> {
    await this.connect();

    const fields = (await this.#client.hgetall(
      `${this.keys.queue(q).jobPrefix}${id}`,
    )) as Record<string, string> | null;

    return fields && Object.keys(fields).length > 0
      ? this.#toRecord(fields)
      : null;
  }

  /**
   * Records a child's outcome on its parent in one script on the parent's
   * queue — see `RECORD_CHILD` for how it stays repeat-safe without decoding
   * anything, and how it refuses a failure already delivered.
   */
  async recordChild(
    q: QueueRef,
    parentId: string,
    child: JobRef,
    outcome: ChildOutcome,
    now: number,
  ): Promise<ChildRecordResult> {
    await this.connect();

    let kind: "completed" | "ignored" | "failed" = "failed";
    let payload: unknown = null;

    if (outcome.completed) {
      kind = "completed";
      payload = outcome.value ?? null;
    } else {
      kind = outcome.ignored ? "ignored" : "failed";
      payload = outcome.error;
    }

    // Whether a failure is stale is read off the child's own record by the
    // script that would bury — unless the child's hash is in another slot (a
    // cluster, another queue), when it is read here first: a window of one
    // round trip, where a script can have none. The rule is the script's.
    const childHash = `${this.keys.queue({ ns: q.ns, queue: child.queue }).jobPrefix}${child.id}`;
    const inScript = !this.keys.cluster || child.queue === q.queue;
    let stale = false;

    if (kind === "failed" && !inScript) {
      const [state, recorded] = (await this.#client.hmget(childHash, [
        "state",
        "flowRecorded",
      ])) as (string | null)[];
      stale = state != null && (recorded === "1" || state !== "dead");
    }

    const reply = await this.#runQueue(q, this.#scripts.RECORD_CHILD, [
      parentId,
      `${child.queue}:${child.id}`,
      kind,
      // Encoded once, here, and stored as sent: the script never decodes it.
      JSON.stringify(payload) ?? "null",
      String(now),
      // Exactly as `#values` writes each entry of `children`.
      flowRefJson(child),
      kind === "failed" && inScript ? childHash : "",
      stale ? "1" : "0",
    ]);

    if (!CHILD_RECORD_RESULTS.has(reply as ChildRecordResult)) {
      // Guessing would be worse than failing: an answer that lets the child's
      // retention run could lose an outcome that was never stored.
      throw new DriverError(
        "redis",
        "recordChild",
        new Error(`unexpected reply ${String(reply)}`),
        { id: parentId },
      );
    }

    // Only a burial is counted, as the script counts only a burial.
    if (reply === "buried") {
      this.#nsJobs.count(q.ns, NAMESPACE_ENTITY, now, { failed: 1 });
    }

    return reply as ChildRecordResult;
  }

  async requeueParent(q: QueueRef, id: string, now: number): Promise<boolean> {
    await this.connect();

    const moved = await this.#runQueue(q, scripts.REQUEUE_PARENT, [
      id,
      String(now),
    ]);

    return Number(moved) === 1;
  }

  async markChildRecorded(
    q: QueueRef,
    id: string,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    await this.connect();
    const { mode, count, ttl } = this.#retention(retention);

    const marked = await this.#runQueue(q, scripts.MARK_CHILD_RECORDED, [
      id,
      String(now),
      mode,
      count,
      ttl,
    ]);

    return Number(marked) === 1;
  }

  async listJobs(
    q: QueueRef,
    states: JobState[],
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<JobRecord[]> {
    await this.connect();

    const ids = (await this.#runQueue(q, scripts.LIST_JOBS, [
      String(opts.offset),
      String(opts.limit),
      opts.order,
      ...states,
    ])) as string[] | null;

    const found: JobRecord[] = [];
    for (const id of ids ?? []) {
      const job = await this.getJob(q, id);
      if (job) {
        found.push(job);
      }
    }

    return found;
  }

  async countJobs(q: QueueRef): Promise<Record<JobState, number>> {
    await this.connect();

    const counts = (await this.#runQueue(q, scripts.COUNT_JOBS, [])) as
      | number[]
      | null;

    const [waiting, delayed, active, completed, failed, dead, children] =
      counts ?? [];

    return {
      waiting: Number(waiting ?? 0),
      delayed: Number(delayed ?? 0),
      active: Number(active ?? 0),
      completed: Number(completed ?? 0),
      failed: Number(failed ?? 0),
      dead: Number(dead ?? 0),
      "waiting-children": Number(children ?? 0),
    };
  }

  /**
   * A page of jobs narrowed by name, a search, the worker that last claimed
   * it, or when it finished.
   *
   * Unfiltered, this is `listJobs` plus, when asked, the states' counts.
   * Filtered, there is no index on names or workers to use — deliberately, for
   * workers: a per-key set would have to be removed from on every path that
   * removes a job, and one missed path leaks members for good — so the states'
   * sets are walked in `listJobs` order a {@link FIND_CHUNK} at a time through
   * `FIND_JOBS`. The script applies the attribution filters itself and answers
   * matches only, each as an id and, when the query names jobs or searches, a
   * name, which is filtered here. The walk stops once the page is full unless a
   * total is wanted, and the page's full records are then read in one batch.
   *
   * **A `finishedOn` range is a score range.** It can match only `completed`
   * and `dead`, whose sets are scored by `finishedOn`, so every other state is
   * skipped without a call, and those two are walked inside the window
   * `[finishedFrom, finishedTo)` alone: the work is linear in the jobs *in the
   * range*, never in the set. Round trips for a range read: one `FIND_JOBS`
   * per {@link FIND_CHUNK} members of the window, per finished state walked —
   * a page that fills from its first chunk is **one** call — then one
   * pipelined batch of `HGETALL`s for the page. Nothing here uses `KEYS` or
   * `SCAN`.
   */
  async findJobs(q: QueueRef, query: JobQuery): Promise<JobPage> {
    const attribution = attributionFilter(query);

    // Nothing matches an empty name list, or no states, or an attribution
    // filter nothing can pass: answered here, as the SQL and memory drivers
    // do, rather than walking every set to find so.
    if (
      query.names?.length === 0 ||
      query.states.length === 0 ||
      (attribution && matchesNothing(attribution, query.states))
    ) {
      return query.total ? { jobs: [], total: 0 } : { jobs: [] };
    }

    await this.connect();

    const filter = jobFilter(query);
    const offset = Math.max(0, Math.floor(query.offset));
    const limit = Math.max(0, Math.floor(query.limit));

    if (!filter && !attribution) {
      const [jobs, counts] = await Promise.all([
        limit === 0
          ? Promise.resolve([])
          : this.listJobs(q, query.states, {
              offset,
              limit,
              order: query.order,
            }),
        query.total ? this.countJobs(q) : Promise.resolve(null),
      ]);

      return counts
        ? { jobs, total: sumStates(counts, query.states) }
        : { jobs };
    }

    // The order LIST_JOBS concatenates sets in: as given, reversed for desc.
    // A range skips every state it cannot match without asking Redis.
    const states = (
      query.order === "desc" ? [...query.states].reverse() : query.states
    ).filter((state) => !attribution || canMatchState(attribution, state));

    const keys = attribution?.workerKeys ? [...attribution.workerKeys] : [];
    const workerIds = attribution?.workerIds ? [...attribution.workerIds] : [];
    const bound = (value: number | undefined): string =>
      value === undefined ? "" : String(value);
    const withNames = filter !== null;
    const stride = withNames ? 2 : 1;

    const ids: string[] = [];
    let skip = offset;
    let total = 0;

    walk: for (const state of states) {
      for (let start = 0; ; start += FIND_CHUNK) {
        if (!query.total && ids.length >= limit) {
          break walk;
        }

        const reply = await this.#runQueue(q, scripts.FIND_JOBS, [
          state,
          String(start),
          String(FIND_CHUNK),
          query.order,
          bound(attribution?.finishedFrom),
          bound(attribution?.finishedTo),
          withNames ? "1" : "0",
          String(keys.length),
          String(workerIds.length),
          ...keys,
          ...workerIds,
        ]);
        const values = Array.isArray(reply) ? reply.map(String) : [];
        const examined = Number(values[0] ?? 0);

        for (let index = 1; index < values.length; index += stride) {
          const id = values[index]!;

          if (filter) {
            const name = this.#decodeName(values[index + 1]!);
            if (name === null || !matchesFilter(filter, id, name)) {
              continue;
            }
          }

          total++;

          if (skip > 0) {
            skip--;
          } else if (ids.length < limit) {
            ids.push(id);
          }
        }

        if (examined < FIND_CHUNK) {
          break;
        }
      }
    }

    // A job removed since the walk read it has no record, and is left out.
    const jobs = (await this.getJobs(q, ids)).filter(
      (job): job is JobRecord => job !== null,
    );

    return query.total ? { jobs, total } : { jobs };
  }

  /**
   * Several jobs by id, one `HGETALL` per distinct id sent together — the
   * client pipelines them onto one connection — and answered in the order
   * asked.
   */
  async getJobs(q: QueueRef, ids: string[]): Promise<(JobRecord | null)[]> {
    if (ids.length === 0) {
      return [];
    }

    await this.connect();

    const distinct = [...new Set(ids)];
    const records = await Promise.all(
      distinct.map(async (id) => await this.getJob(q, id)),
    );

    return orderByIds(
      ids,
      new Map(distinct.map((id, index) => [id, records[index] ?? null])),
    );
  }

  /**
   * Writes a worker's record and its expiry in one script, which also removes lapsed
   * records and gives both keys a relative lifetime — see `REGISTER_WORKER`.
   */
  async registerWorker(q: QueueRef, worker: WorkerInfo): Promise<void> {
    await this.connect();
    const keys = this.keys.queue(q);
    // Twice the record's own lifetime, and never under a second: the keys
    // outlive every live record, measured on the server's clock.
    const ttl = 2 * Math.max(1_000, worker.expiresAt - worker.heartbeatAt);

    await this.#run(
      scripts.REGISTER_WORKER,
      [keys.workers, keys.workersExpiry],
      [
        worker.id,
        JSON.stringify(worker),
        String(worker.expiresAt),
        String(worker.heartbeatAt),
        String(Math.ceil(ttl)),
      ],
    );
  }

  async removeWorker(q: QueueRef, id: string): Promise<boolean> {
    await this.connect();
    const keys = this.keys.queue(q);

    const removed = await this.#run(
      scripts.REMOVE_WORKER,
      [keys.workers, keys.workersExpiry],
      [id],
    );

    return Number(removed) > 0;
  }

  /** The live workers, removing lapsed records in the same script. */
  async listWorkers(q: QueueRef, now: number): Promise<WorkerInfo[]> {
    await this.connect();
    const keys = this.keys.queue(q);

    const reply = await this.#run(
      scripts.LIST_WORKERS,
      [keys.workers, keys.workersExpiry],
      [String(now)],
    );

    const workers = (Array.isArray(reply) ? reply : [])
      .map((entry) => safeJsonParse<WorkerInfo | null>(String(entry), null))
      .filter((worker): worker is WorkerInfo => worker !== null);

    return sortWorkers(workers);
  }

  /** Counts for every queue the namespace's queue set names, sent together. */
  async countJobsByQueue(
    ns: string,
  ): Promise<Record<string, Record<JobState, number>>> {
    const names = await this.listQueues(ns);
    const counts = await Promise.all(
      names.map(async (queue) => await this.countJobs({ ns, queue })),
    );

    return Object.fromEntries(
      names.map((queue, index) => [queue, counts[index]!]),
    );
  }

  /**
   * The minutes in `[from, to]` from the hashes COMPLETE and FAIL count into.
   * The range is cut to the minutes retention can still hold — a day and one
   * minute back from `to` — so a careless range cannot make the script walk
   * years of empty minutes.
   */
  async getThroughput(
    q: QueueRef,
    range: { from: number; to: number },
  ): Promise<ThroughputBucket[]> {
    const last =
      Math.floor(range.to / THROUGHPUT_BUCKET_MS) * THROUGHPUT_BUCKET_MS;
    const first = Math.max(
      Math.ceil(range.from / THROUGHPUT_BUCKET_MS) * THROUGHPUT_BUCKET_MS,
      last - THROUGHPUT_RETENTION_MS,
    );

    if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) {
      return [];
    }

    await this.connect();

    const reply = await this.#runQueue(q, scripts.GET_THROUGHPUT, [
      String(first),
      String(last),
    ]);
    const flat = Array.isArray(reply) ? reply : [];
    const rows: { at: number; completed: number; failed: number }[] = [];

    for (let index = 0; index + 2 < flat.length; index += 3) {
      rows.push({
        at: Number(flat[index]),
        completed: Number(flat[index + 1]),
        failed: Number(flat[index + 2]),
      });
    }

    return sumBuckets(rows, range);
  }

  /* --- analytics -------------------------------------------------------- *
   *
   * The layout, in full, because every future reader of these keys needs it.
   *
   * **One hash holds sixty buckets**, and that single decision is what makes
   * per-second analytics affordable here. A key per second would be ~19,500
   * keys in a mid-sized namespace and sixty `HMGET`s to read a minute; sixty
   * second-fields in one hash per minute is ~305 keys and two `HGETALL`s. The
   * same grouping one width up puts sixty minute-fields in one hash per hour,
   * so a day of minutes is 24 keys rather than 1,440.
   *
   * ```text
   * <prefix>:<ns>:q:<queue>:tp:<minute>                 jobs, 60 s  (shipped)
   * <prefix>:<ns>:q:<queue>:mx:jobs:s:<minute>          jobs, 1 s
   * <prefix>:<ns>:q:<queue>:mx:wjobs:<s|m>:<g>:<key>    one worker's jobs
   * <prefix>:<ns>:q:<queue>:mx:wbusy:<s|m>:<g>:<key>    one worker's busyness
   * <prefix>:<ns>:r:<runner>:mx:runs:<s|m>:<g>          one runner's outcomes
   * <prefix>:<ns>:r:<runner>:mx:rdur:<s|m>:<g>          one runner's durations
   * <prefix>:<ns>:mx:<jobs|runs|wjobs>:<s|m>:<g>        the namespace roll-up
   * ```
   *
   * `s` groups by the minute, `m` by the hour, `<g>` is that group's start, and
   * a field is `<offset in the group>:<counter or statistic>`. The queue's
   * **minute** jobs counts are the one exception: they stay in the shipped
   * `tp:` hashes, so `getQueueMetrics` at a minute and `getThroughput` cannot
   * disagree about the same events.
   *
   * Three consequences worth stating outright:
   *
   * - **Retention is the key's own expiry.** Every hash is created with a
   *   `PEXPIREAT` at the end of its group plus that width's retention, so there
   *   is no prune pass and no `MetricsPruneClock` here — a worker that dies
   *   leaves buckets that remove themselves, which is the problem §9.13 exists
   *   to solve elsewhere.
   * - **The namespace roll-up is up to a second behind.** Its keys are outside
   *   every queue's hash tag, so no script may write both it and the queue's
   *   own counts; it is buffered by this driver and flushed once a second, and
   *   a process killed outright loses what it had gathered. In practice an
   *   overview refreshed on a timer never notices; a test that completes a job
   *   and reads the roll-up in the same tick must `flushMetrics()` first.
   * - **Everything else is counted inside the script that caused it.** A queue's
   *   own buckets are one extra `HINCRBY` in `COMPLETE`/`FAIL`, which is free —
   *   the rule that per-second counts must not ride the per-job statement exists
   *   for row contention on SQL, which a Redis hash field does not have.
   */

  /** What this driver records and serves, for `/meta` and range resolution. */
  getMetricsSupport(): MetricsSupport {
    return metricsSupportOf(this.#metrics);
  }

  /**
   * Writes every analytics count gathered in memory: the namespace roll-up, the
   * per-worker and per-runner series, and the durations and busyness beside
   * them.
   */
  async flushMetrics(): Promise<void> {
    const settled = await Promise.allSettled([
      this.#nsJobs.flush(),
      this.#workerJobs.flush(),
      this.#runnerRuns.flush(),
      this.#durations.flush(),
      this.#busyness.flush(),
    ]);

    const failed = settled.find((result) => result.status === "rejected");

    if (failed) {
      throw failed.reason;
    }
  }

  /**
   * Writes the namespace roll-up this driver holds, as
   * {@link RedisDriver.flushMetrics} does.
   *
   * Redis counts a queue's own throughput inside `COMPLETE` and `FAIL`, so
   * there was nothing for this to do before the roll-up existed. There is now:
   * a queue closing flushes it here, rather than leaving the last second of the
   * namespace's own counts to the process's exit.
   */
  async flushThroughput(): Promise<void> {
    await this.#nsJobs.flush();
  }

  /** One runner's outcome counts, and the duration when a run has just finished. */
  async countRunnerRun(
    ns: string,
    runner: string,
    at: number,
    counts: RunnerRunDelta,
  ): Promise<void> {
    if (!this.#metrics.runners) {
      return;
    }

    const { durationMs, ...deltas } = counts;
    this.#runnerRuns.count(ns, this.#runnerId(runner), at, deltas);

    if (durationMs === undefined || !this.#metrics.durations) {
      return;
    }

    for (const interval of this.#metrics.intervals) {
      const stats = emptyDurationStats();
      addDuration(stats, durationMs);
      this.#durations.add({
        ns,
        entity: this.#runnerId(runner),
        at: bucketStart(at, interval),
        interval,
        stats,
      });
    }
  }

  /** One runner's buckets: its outcomes, and its durations when asked for. */
  async getRunnerMetrics(
    ns: string,
    runner: string,
    query: RunnerMetricsQuery,
  ): Promise<RunnerMetricsRead> {
    const range = this.#clampMetricsQuery(query);

    if (!range) {
      return { runs: [] };
    }

    await this.connect();

    return await this.#readRunner(
      ns,
      this.#runnerId(runner),
      range,
      query.durations === true,
    );
  }

  /**
   * Every runner with something to report in range, each row exactly
   * `runnerTotalsOf` of its own read.
   *
   * **Two round trips, however many runners**: one `ZRANGE … BYSCORE` on the
   * namespace's runner index, then every hash of every runner it names sent
   * together (`runs`, plus `rdur` when durations were asked for, one `HGETALL`
   * per group each) — the client pipelines them onto one connection. With a
   * `runners` filter the filter *is* the candidate list and the index is not
   * read, so it is one.
   */
  async getRunnerMetricsTotals(
    ns: string,
    query: RunnerMetricsTotalsQuery,
  ): Promise<RunnerMetricsTotals[]> {
    const range = this.#clampMetricsQuery(query);

    // An empty filter answers nothing, never "no filter".
    if (!range || query.runners?.length === 0) {
      return [];
    }

    await this.connect();

    const named =
      query.runners === undefined
        ? this.#runnerNames(
            (await this.#indexed(ns, "runners", range.from)).map(runnerKey),
          )
        : this.#runnerNames(query.runners);

    const reads = await Promise.all(
      [...named].map(
        async ([id, runner]) =>
          [
            runner,
            await this.#readRunner(ns, id, range, query.durations === true),
          ] as const,
      ),
    );

    const rows: RunnerMetricsTotals[] = [];

    for (const [runner, read] of reads) {
      const totals = runnerTotalsOf(read);
      if (totals) {
        rows.push({ runner, ...totals });
      }
    }

    return rows;
  }

  /**
   * Named runners' series, each exactly its own `getRunnerMetrics` — one round
   * trip for the whole batch, every hash of every runner sent together.
   */
  async getRunnerMetricsMany(
    ns: string,
    runners: readonly string[],
    query: RunnerMetricsQuery,
  ): Promise<RunnerMetricsSeries[]> {
    const range = this.#clampMetricsQuery(query);
    const named = this.#runnerNames(runners);

    if (!range || named.size === 0) {
      return [];
    }

    await this.connect();

    const reads = await Promise.all(
      [...named].map(
        async ([id, runner]) =>
          [
            runner,
            await this.#readRunner(ns, id, range, query.durations === true),
          ] as const,
      ),
    );

    return reads
      .filter(([, read]) => hasMetricBuckets(read.runs, read.durations))
      .map(([runner, read]) => ({ runner, ...read }));
  }

  /** One queue's throughput at either width. */
  async getQueueMetrics(
    q: QueueRef,
    query: MetricsQuery,
  ): Promise<CounterBucket<JobCounters>[]> {
    // The minute is the shipped `tp:` layout, read by the shipped script, so
    // this and `getThroughput` can never answer differently.
    if (query.interval === MINUTE_BUCKET_MS) {
      return await this.getThroughput(q, { from: query.from, to: query.to });
    }

    const range = this.#clampMetricsQuery(query);

    if (!range) {
      return [];
    }

    await this.connect();

    return mergeCounterBuckets(
      await this.#readRows(
        this.keys.queue(q).metricsPrefix,
        "jobs",
        undefined,
        range,
      ),
      range,
      JOB_COUNTERS,
    );
  }

  /** Counts jobs one worker finished, keyed by its stable `WorkerInfo.key`. */
  async countWorkerJobs(
    q: QueueRef,
    key: string,
    at: number,
    counts: Partial<JobCounters>,
  ): Promise<void> {
    if (!this.#metrics.workers) {
      return;
    }

    this.#workerJobs.count(q.ns, workerEntity(q.queue, key), at, counts);
  }

  /** Records one heartbeat's busyness sample for a worker. */
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
      addBusynessSample(stats, at, sample);
      this.#busyness.add({
        ns: q.ns,
        entity: workerEntity(q.queue, key),
        at: bucketStart(at, interval),
        interval,
        stats,
      });
    }
  }

  /** One worker's buckets: the jobs it finished, and its busyness when asked for. */
  async getWorkerMetrics(
    q: QueueRef,
    key: string,
    query: WorkerMetricsQuery,
  ): Promise<WorkerMetricsRead> {
    const range = this.#clampMetricsQuery(query);

    if (!range || !this.#metrics.workers) {
      return { jobs: [] };
    }

    await this.connect();

    return await this.#readWorker(q, key, range, query.busyness === true);
  }

  /**
   * Every worker key with something to report in range, each row exactly
   * `workerTotalsOf` of its own read.
   *
   * **Two round trips, however many workers**: one `ZRANGE … BYSCORE` on the
   * namespace's worker index, then every hash of every worker it names sent
   * together. The `queues` filter is applied to what the index names — a
   * worker's queue is the first part of its member — so it costs nothing extra
   * and reads nothing it will not answer.
   */
  async getWorkerMetricsTotals(
    ns: string,
    query: WorkerMetricsTotalsQuery,
  ): Promise<WorkerMetricsTotals[]> {
    const range = this.#clampMetricsQuery(query);

    // An empty filter answers nothing, never "no filter".
    if (!range || !this.#metrics.workers || query.queues?.length === 0) {
      return [];
    }

    await this.connect();

    const queues =
      query.queues === undefined ? undefined : new Set(query.queues);
    const refs: WorkerMetricsRef[] = [];

    for (const member of await this.#indexed(ns, "workers", range.from)) {
      // The roll-up is never indexed; were it, it splits to nothing.
      const ref = splitWorkerMetricsEntity(member);
      if (ref && (!queues || queues.has(ref.queue))) {
        refs.push(ref);
      }
    }

    const reads = await Promise.all(
      refs.map(
        async (ref) =>
          [
            ref,
            await this.#readWorker(
              { ns, queue: ref.queue },
              ref.key,
              range,
              query.busyness === true,
            ),
          ] as const,
      ),
    );

    const rows: WorkerMetricsTotals[] = [];

    for (const [ref, read] of reads) {
      const totals = workerTotalsOf(read);
      if (totals) {
        rows.push({ ...ref, ...totals });
      }
    }

    return rows;
  }

  /**
   * Named worker keys' series, each exactly its own `getWorkerMetrics` — one
   * round trip for the whole batch.
   */
  async getWorkerMetricsMany(
    ns: string,
    workers: readonly WorkerMetricsRef[],
    query: WorkerMetricsQuery,
  ): Promise<WorkerMetricsSeries[]> {
    const range = this.#clampMetricsQuery(query);
    const refs = uniqueWorkerRefs(workers);

    if (!range || !this.#metrics.workers || refs.length === 0) {
      return [];
    }

    await this.connect();

    const reads = await Promise.all(
      refs.map(
        async (ref) =>
          [
            ref,
            await this.#readWorker(
              { ns, queue: ref.queue },
              ref.key,
              range,
              query.busyness === true,
            ),
          ] as const,
      ),
    );

    return reads
      .filter(([, read]) => hasMetricBuckets(read.jobs, read.busyness))
      .map(([ref, read]) => ({ ...ref, ...read }));
  }

  /** The namespace's own roll-up buckets, for the kinds asked for. */
  async getNamespaceMetrics(
    ns: string,
    query: NamespaceMetricsQuery,
  ): Promise<NamespaceMetricsRead> {
    const range = this.#clampMetricsQuery(query);

    if (!range) {
      return {};
    }

    await this.connect();

    const prefix = this.keys.namespaceMetrics(ns);
    const read: NamespaceMetricsRead = {};

    if (query.kinds.includes("jobs")) {
      read.jobs = mergeCounterBuckets(
        await this.#readRows(prefix, "jobs", undefined, range),
        range,
        JOB_COUNTERS,
      );
    }

    if (query.kinds.includes("runs") && this.#metrics.runners) {
      read.runs = mergeCounterBuckets(
        await this.#readRows(prefix, "runs", undefined, range),
        range,
        RUNNER_RUN_COUNTERS,
      );
    }

    if (query.kinds.includes("workerJobs") && this.#metrics.workers) {
      read.workerJobs = mergeCounterBuckets(
        await this.#readRows(prefix, "wjobs", undefined, range),
        range,
        JOB_COUNTERS,
      );
    }

    return read;
  }

  async removeJob(q: QueueRef, id: string): Promise<boolean> {
    await this.connect();
    const removed = await this.#runQueue(q, scripts.REMOVE_JOB, [id]);
    return Number(removed) === 1;
  }

  async retryJob(
    q: QueueRef,
    id: string,
    resetAttempts: boolean,
    now: number,
  ): Promise<boolean> {
    await this.connect();

    const retried = await this.#runQueue(q, scripts.RETRY_JOB, [
      id,
      String(now),
      resetAttempts ? "1" : "0",
    ]);

    return Number(retried) === 1;
  }

  async promoteJob(q: QueueRef, id: string, now: number): Promise<boolean> {
    await this.connect();
    const promoted = await this.#runQueue(q, scripts.PROMOTE_JOB, [
      id,
      String(now),
    ]);
    return Number(promoted) === 1;
  }

  async promoteDelayed(
    q: QueueRef,
    now: number,
    limit: number,
  ): Promise<number> {
    await this.connect();

    const moved = await this.#runQueue(q, scripts.PROMOTE_DELAYED, [
      String(now),
      String(Math.max(1, Math.floor(limit))),
    ]);

    return Number(moved ?? 0);
  }

  async recoverStalled(
    q: QueueRef,
    now: number,
    maxStalledCount: number,
    limit: number,
  ): Promise<{ requeued: string[]; dead: string[] }> {
    await this.connect();

    const result = (await this.#runQueue(q, this.#scripts.RECOVER_STALLED, [
      String(now),
      String(maxStalledCount),
      String(Math.max(1, Math.floor(limit))),
    ])) as [number, ...string[]] | null;

    // Lua cannot return nested tables, so the reply leads with how many of
    // the ids after it were requeued; the rest were buried. It used to be a
    // '|' marker between the lists, but '|' is a legal job id, and one such
    // job requeued was read as the marker and the real marker as a burial.
    const [count, ...ids] = result ?? [0];
    const split = Math.max(0, Math.min(ids.length, Number(count) || 0));
    const requeued = ids.slice(0, split).map(String);
    const dead = ids.slice(split).map(String);

    // One failure per burial, as the script counted one per burial.
    this.#nsJobs.count(q.ns, NAMESPACE_ENTITY, now, { failed: dead.length });

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
    await this.connect();

    // Each call examines a bounded stretch and says where it stopped (-1 at
    // the end of the set), so no one script holds the server for long — see
    // `CLEAN`. Every call either removes something or moves the offset on,
    // so this ends.
    const want = Math.max(1, Math.floor(limit));
    const removed: string[] = [];
    let offset = 0;

    while (removed.length < want) {
      const reply = (await this.#runQueue(q, scripts.CLEAN, [
        state,
        String(now - olderThanMs),
        String(want - removed.length),
        String(offset),
        String(scripts.CLEAN_SCAN_BUDGET),
      ])) as (number | string)[] | null;

      const [next, ...ids] = reply ?? [-1];
      for (const id of ids) {
        removed.push(String(id));
      }
      if (Number(next) < 0) {
        break;
      }
      offset = Number(next);
    }

    return removed;
  }

  async pruneExpired(q: QueueRef, now: number, limit: number): Promise<number> {
    await this.connect();

    const removed = await this.#runQueue(q, scripts.PRUNE_EXPIRED, [
      String(now),
      String(Math.max(1, Math.floor(limit))),
    ]);

    return Number(removed ?? 0);
  }

  async drainQueue(q: QueueRef, includeDelayed: boolean): Promise<number> {
    await this.connect();

    // A bounded batch per call, until nothing pending remains — see `DRAIN`.
    // Capped at what the first call found still pending (plus one), so a
    // producer adding as fast as this removes cannot keep it going for good.
    let total = 0;
    let calls = Number.POSITIVE_INFINITY;

    while (calls-- > 0) {
      const [removed, remaining] = ((await this.#runQueue(q, scripts.DRAIN, [
        includeDelayed ? "1" : "0",
        String(scripts.DRAIN_BATCH),
      ])) as [number, number] | null) ?? [0, 0];

      total += Number(removed);

      if (Number(remaining) === 0 || Number(removed) === 0) {
        break;
      }
      if (calls === Number.POSITIVE_INFINITY) {
        calls = Math.ceil(Number(remaining) / scripts.DRAIN_BATCH) + 1;
      }
    }

    return total;
  }

  /* --- queue: state ----------------------------------------------------- */

  async getQueueState(
    q: QueueRef,
    name: string,
  ): Promise<QueueStateEntry | null> {
    await this.connect();

    // One read for both fields, so the value and its version always match.
    const [version, value] = await this.#client.hmget(
      `${this.keys.queue(q).statePrefix}${name}`,
      ["version", "value"],
    );

    return version === null || version === undefined
      ? null
      : {
          value: safeJsonParse<unknown>(value ?? undefined, null),
          version: Number(version),
        };
  }

  async setQueueState(
    q: QueueRef,
    name: string,
    value: unknown,
    expected: number | null,
    options?: { internal?: symbol },
  ): Promise<number | null> {
    assertWritableStateName(name, options);

    await this.connect();

    const keys = this.keys.queue(q);
    const version = await this.#run(
      scripts.SET_QUEUE_STATE,
      [`${keys.statePrefix}${name}`, keys.stateNames],
      [
        expected === null ? "" : String(expected),
        value === null ? "1" : "0",
        value === null ? "" : (JSON.stringify(value) ?? "null"),
        name,
      ],
    );

    return version === null || version === undefined ? null : Number(version);
  }

  async listQueueState(
    q: QueueRef,
    options: { prefix: string; after?: string; limit: number },
  ): Promise<string[]> {
    const limit = Math.floor(options.limit);

    // Redis reads a negative LIMIT count as "no limit", so answer here.
    if (!(limit > 0)) {
      return [];
    }

    await this.connect();

    const { prefix, after } = options;

    // Start at whichever is later: just past `after`, or the prefix itself.
    // An `after` that sorts below the prefix would otherwise start the range
    // among names that do not match, and the cut below would stop at once.
    // Compared as bytes, because that is how BYLEX compares.
    const start =
      after !== undefined &&
      Buffer.compare(Buffer.from(after), Buffer.from(prefix)) >= 0
        ? `(${after}`
        : `[${prefix}`;

    // Every member has score 0, so BYLEX orders them by their UTF-8 bytes.
    // For ASCII — and any names without characters above U+FFFF — that is the
    // JavaScript code-unit order the contract sorts by. Names mixing
    // characters above U+FFFF with ones in U+E000–U+FFFF can order
    // differently: UTF-16 puts the surrogate pair first, UTF-8 puts it last.
    const members = (await this.#client.send("ZRANGE", [
      this.keys.queue(q).stateNames,
      start,
      "+",
      "BYLEX",
      "LIMIT",
      "0",
      String(limit),
    ])) as string[] | null;

    // Names sharing a prefix are contiguous from the start, so the first one
    // that does not begin with it ends the matches. Cutting after LIMIT still
    // honours `limit`: every match is ahead of every non-match in the page.
    const names: string[] = [];

    for (const member of members ?? []) {
      if (!member.startsWith(prefix)) {
        break;
      }
      names.push(member);
    }

    return names;
  }

  async pauseQueue(q: QueueRef): Promise<void> {
    await this.connect();
    await this.#client.hset(this.keys.queue(q).meta, "paused", "1");
  }

  async resumeQueue(q: QueueRef): Promise<void> {
    await this.connect();
    const keys = this.keys.queue(q);

    await this.#client.hset(keys.meta, "paused", "0");
    // Wake whoever is blocked, so resuming takes effect at once.
    await this.#client.lpush(keys.wake, "1");
  }

  async isQueuePaused(q: QueueRef): Promise<boolean> {
    await this.connect();
    return (await this.#client.hget(this.keys.queue(q).meta, "paused")) === "1";
  }

  /* --- queue: repeats ---------------------------------------------------- */

  async upsertRepeat(q: QueueRef, def: RepeatRecord): Promise<void> {
    await this.connect();
    await this.#client.hset(
      this.keys.queue(q).repeats,
      def.key,
      JSON.stringify(def),
    );
  }

  async getRepeat(q: QueueRef, key: string): Promise<RepeatRecord | null> {
    await this.connect();
    const stored = await this.#client.hget(this.keys.queue(q).repeats, key);
    return stored ? safeJsonParse<RepeatRecord | null>(stored, null) : null;
  }

  async listRepeats(q: QueueRef): Promise<RepeatRecord[]> {
    await this.connect();

    const stored = (await this.#client.hgetall(
      this.keys.queue(q).repeats,
    )) as Record<string, string> | null;

    return Object.values(stored ?? {})
      .map((entry) => safeJsonParse<RepeatRecord | null>(entry, null))
      .filter((record): record is RepeatRecord => record !== null);
  }

  async removeRepeat(q: QueueRef, key: string): Promise<boolean> {
    await this.connect();
    const removed = await this.#client.send("HDEL", [
      this.keys.queue(q).repeats,
      key,
    ]);
    return Number(removed) > 0;
  }

  /* --- queue: waiting and events ------------------------------------------ */

  async nextDelayedAt(q: QueueRef): Promise<number | null> {
    await this.connect();
    const keys = this.keys.queue(q);
    let earliest: number | null = null;

    for (const set of [keys.delayed, keys.failed]) {
      const head = await this.#client.send("ZRANGE", [
        set,
        "0",
        "0",
        "WITHSCORES",
      ]);

      const score = firstScore(head);
      if (score !== null && (earliest === null || score < earliest)) {
        earliest = score;
      }
    }

    return earliest;
  }

  /**
   * Waits for a wake token on the queue's wake list, or the timeout.
   *
   * **One blocking pop serves every queue this driver waits on.** It used to
   * be one `BLPOP` per key on a single blocking connection, and Redis serves a
   * connection's commands in order, so a second queue's pop queued behind the
   * first one's: a wake on queue B pushed at 100 ms was noticed at 3,050 ms,
   * and up to `maxBlock` in production. Now the pop names every key being
   * waited on (`BLPOP k1 k2 … control`), and the reply says which key the
   * token came from. When a wait adds a key the pop in flight does not name,
   * one push to the group's private control list ends it and it is issued
   * again over the new set — a push, not `CLIENT UNBLOCK`, because a list
   * keeps the push if the pop has not reached the server yet, so there is no
   * window in which the new key is missed.
   *
   * In Cluster a multi-key pop must stay in one slot, so there is one group —
   * one connection — per queue name (the hash tag), each with a control list
   * carrying that tag.
   *
   * The signal cannot interrupt a blocking call, so the wait is bounded by the
   * timeout the caller asked for and checked again on the way out. The
   * caller's signal outlives this wait — a worker passes the same one to every
   * wait it makes — so nothing may be left listening on it when the pop wins,
   * which on a busy queue is every job. See `waitForAny`.
   */
  async waitForJob(
    q: QueueRef,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.connect();

    if (signal?.aborted || timeoutMs <= 0) {
      return;
    }

    const key = this.keys.queue(q).wake;

    // A wake that landed while nobody was listening goes to the next waiter.
    // Without this the token a pop took just after its caller gave up was
    // simply lost, and the job that sent it waited out the next full period.
    if (this.#missed.delete(key)) {
      return;
    }

    // `maxBlockSeconds` bounds every wait, as it bounded the per-key pop the
    // shared one replaced: a caller asking for longer comes back and asks
    // again. Each wait ends on its own timer, so a shorter one joining a pop
    // parked for longer still returns on time.
    const waitMs = Math.min(timeoutMs, this.#maxBlock * 1000);
    const deadline = { at: Date.now() + waitMs };

    this.#waiters.set(key, (this.#waiters.get(key) ?? 0) + 1);
    let group: WakeGroup | undefined;

    try {
      const wake = this.#wakeFor(q, key, deadline);
      group = wake.group;
      // A blocking connection that cannot be made is an error, as it always
      // was — not a wait that returns at once and invites a hot loop.
      await wake.ready;
      await waitForAny(waitMs, { signal, others: [wake.woken] });
    } finally {
      group?.deadlines.delete(deadline);
      this.#waiters.set(key, Math.max(0, (this.#waiters.get(key) ?? 1) - 1));
    }
  }

  async publish(event: DriverEvent): Promise<void> {
    await this.connect();

    await this.#client.publish(
      this.keys.channel(event.ns, event.kind, event.target),
      JSON.stringify(event),
    );
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

    await this.connect();

    const channel = this.keys.channel(ns, kind, target);
    const subscriber = await this.#subscriberClient();

    let listeners = this.#channels.get(channel);

    if (!listeners) {
      listeners = new Set();
      this.#channels.set(channel, listeners);

      // One subscription per channel, however many listeners it has.
      await subscriber.subscribe(channel, (message: string) => {
        const event = safeJsonParse<DriverEvent | null>(message, null);
        if (!event) {
          return;
        }

        for (const each of this.#channels.get(channel) ?? []) {
          each(event);
        }
      });
    }

    listeners.add(deliver);

    return async () => {
      const current = this.#channels.get(channel);
      current?.delete(deliver);

      if (current && current.size === 0) {
        this.#channels.delete(channel);
        await subscriber.unsubscribe(channel).catch(() => {});
      }
    };
  }

  /* --- internals ------------------------------------------------------------ */

  /** The runner id inside a `r:<id>` key. */
  #runnerId(key: string): string {
    return key.replace(/^r:/, "");
  }

  /**
   * The promise a wait on `key` is released by, with its group's pop started
   * or re-issued as needed so that the pop names `key`.
   *
   * The hot path — a key the pop in flight already names — is two `Map`
   * lookups and no Redis command at all.
   */
  #wakeFor(
    q: QueueRef,
    key: string,
    deadline: { at: number },
  ): { woken: Promise<void>; ready: Promise<RedisClient>; group: WakeGroup } {
    let wake = this.#wakes.get(key);
    if (!wake) {
      wake = Promise.withResolvers<void>();
      this.#wakes.set(key, wake);
    }

    const id = this.keys.cluster ? q.queue : "";
    let group = this.#wakeGroups.get(id);

    if (!group) {
      group = {
        // Memoised as a promise, so concurrent first waits share one
        // connection. `??=` on an awaited value checked, awaited and then
        // assigned, so two first waits opened two and leaked one.
        client: this.#client.duplicate(),
        control: this.keys.wakeControl(this.#wakeOwner, q.queue),
        keys: new Set(),
        deadlines: new Set(),
        parkedUntil: 0,
        running: false,
        parked: null,
        nudged: false,
      };
      // A failed connection is reported by the wait awaiting it; this only
      // keeps the rejection from counting as unhandled when none does.
      group.client.catch(() => {});
      this.#wakeGroups.set(id, group);
    }

    group.keys.add(key);
    group.deadlines.add(deadline);

    if (!group.running) {
      void this.#serveWakes(id, group);
    } else if (
      group.parked &&
      !group.nudged &&
      (!group.parked.has(key) || deadline.at > group.parkedUntil + 50)
    ) {
      // The pop in flight does not name this key, or ends well before this
      // wait does: end it, so it is issued again over the current set and
      // for the current longest wait. Once per pop, however many join.
      group.nudged = true;
      void this.#nudge(group);
    }

    return { woken: wake.promise, ready: group.client, group };
  }

  /**
   * One group's pop loop: `BLPOP` over every key with a waiter, plus the
   * control list, for as long as any key has one.
   */
  async #serveWakes(id: string, group: WakeGroup): Promise<void> {
    group.running = true;

    try {
      const client = await group.client;

      while (this.#wakeGroups.get(id) === group) {
        // Bun does not reconnect a client that exhausted its retries on its
        // own; this is a no-op on a live connection. Before the keys are
        // read: a key added while this awaited must be in the pop below.
        await client.connect();

        const keys: string[] = [];
        for (const key of group.keys) {
          if ((this.#waiters.get(key) ?? 0) > 0) {
            keys.push(key);
          } else {
            // Nobody waits on it any more, so nobody awaits its promise.
            group.keys.delete(key);
            this.#wakes.delete(key);
          }
        }

        if (keys.length === 0) {
          break;
        }

        // As long as the longest current wait has left, and never past
        // `maxBlockSeconds`: a pop outliving every wait would only park the
        // connection for nobody. Shorter waits end on their own timers.
        let until = 0;
        for (const deadline of group.deadlines) {
          until = Math.max(until, deadline.at);
        }
        const seconds = Math.min(
          this.#maxBlock,
          Math.max(0.01, (until - Date.now()) / 1000),
        );

        group.parked = new Set(keys);
        group.parkedUntil = Date.now() + seconds * 1000;
        group.nudged = false;
        let reply: unknown;

        try {
          reply = await client.send("BLPOP", [
            ...keys,
            group.control,
            String(Number(seconds.toFixed(3))),
          ]);
        } finally {
          group.parked = null;
        }

        if (Array.isArray(reply) && reply[0] !== group.control) {
          this.#deliverWake(String(reply[0]));
        }
      }
    } catch {
      // The connection failed or was closed. Release this group's waiters, as
      // a failed pop always did, and let the next wait start afresh.
      if (this.#wakeGroups.get(id) === group) {
        this.#wakeGroups.delete(id);
        void group.client.then((client) => client.close()).catch(() => {});
      }
      for (const key of group.keys) {
        this.#wakes.get(key)?.resolve();
        this.#wakes.delete(key);
      }
      group.keys.clear();
    } finally {
      group.running = false;
    }
  }

  /** Hands a token the pop took to that key's waiters, or keeps it for the next. */
  #deliverWake(key: string): void {
    const wake = this.#wakes.get(key);
    this.#wakes.delete(key);

    // Resolved before any waiter has stopped awaiting it, so this count still
    // includes them — nobody left means every caller gave up, and `BLPOP` is
    // a destructive read: the token would otherwise be gone for everyone.
    if (wake && (this.#waiters.get(key) ?? 0) > 0) {
      wake.resolve();
    } else {
      this.#missed.add(key);
    }
  }

  /**
   * Ends a group's pop in flight so it is issued again over the current keys.
   * The control list expires on its own, so a process that dies between the
   * push and the pop leaves nothing behind for long.
   */
  async #nudge(group: WakeGroup): Promise<void> {
    try {
      await Promise.all([
        this.#client.lpush(group.control, "1"),
        this.#client.pexpire(group.control, WAKE_CONTROL_TTL_MS),
      ]);
    } catch {
      // The pop ends at its own timeout instead, as it always did.
    }
  }

  /** The connection reserved for pub/sub, made on first use. */
  async #subscriberClient(): Promise<RedisClient> {
    // A promise, so two first subscriptions share one connection — the old
    // `??= await` opened one each and leaked the first.
    this.#subscriber ??= this.#client.duplicate();
    try {
      const subscriber = await this.#subscriber;
      await subscriber.connect();
      return subscriber;
    } catch (error) {
      this.#subscriber = undefined;
      throw error;
    }
  }

  /**
   * Runs a script, sending its source only when the server has forgotten it.
   *
   * `EVALSHA` keeps the script off the wire on every call after the first;
   * `NOSCRIPT` means the server was restarted or its cache flushed, and the
   * answer is simply to send the source again.
   */
  async #run(source: string, keys: string[], args: string[]): Promise<unknown> {
    const sha = this.#shas.get(source);

    if (sha) {
      try {
        return await this.#client.evalsha(sha, keys.length, ...keys, ...args);
      } catch (error) {
        if (!/NOSCRIPT/i.test((error as Error).message)) {
          throw new DriverError("redis", "evalsha", error);
        }
        this.#shas.delete(source);
      }
    }

    try {
      const result = await this.#client.eval(
        source,
        keys.length,
        ...keys,
        ...args,
      );

      // Cache the digest for next time, but never let that failure matter.
      void this.#client
        .script("LOAD", source)
        .then((loaded) => {
          if (typeof loaded === "string") {
            this.#shas.set(source, loaded);
          }
        })
        .catch(() => {});

      return result;
    } catch (error) {
      throw new DriverError("redis", "eval", error);
    }
  }

  /** Runs a queue script with that queue's keys and prefix. */
  async #runQueue(
    q: QueueRef,
    source: string,
    args: string[],
  ): Promise<unknown> {
    return await this.#run(source, this.keys.queueScriptKeys(q), [
      this.keys.queue(q).jobPrefix,
      ...args,
    ]);
  }

  /* --- analytics: the machinery under the six methods above ------------- */

  /**
   * A metrics query cut to what this driver can actually hold, or `null` when
   * that is nothing.
   *
   * A width it does not record answers empty rather than throwing, as the
   * contract says; and `from` is pulled forward to the oldest bucket retention
   * can still keep, so a careless range cannot make a read walk years of
   * expired groups.
   */
  #clampMetricsQuery(
    query: MetricsQuery,
  ): { from: number; to: number; interval: number } | null {
    const { interval } = query;

    if (interval !== SECOND_BUCKET_MS && interval !== MINUTE_BUCKET_MS) {
      return null;
    }

    const retention = metricsRetentionFor(this.#metrics, interval);

    if (retention <= 0) {
      return null;
    }

    const to = bucketStart(query.to, interval);
    const from = Math.max(
      bucketStart(query.from, interval),
      bucketStart(to - retention, interval),
    );

    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      return null;
    }

    return { from, to, interval };
  }

  /**
   * When a hash's group stops being worth keeping: the end of the group, plus
   * that width's retention.
   *
   * The whole group shares one expiry, so its oldest bucket is kept exactly as
   * long as retention asks and its newest for up to one group longer. Erring
   * that way is deliberate — a read clamps to retention anyway, and the
   * alternative would drop buckets a query is still entitled to.
   */
  #metricsExpireAt(interval: number, at: number): number {
    return (
      metricsGroupStart(at, interval) +
      metricsGroupSpan(interval) +
      metricsRetentionFor(this.#metrics, interval)
    );
  }

  /** Where one buffered worker row goes: the queue's hash, or the namespace's. */
  #workerSeriesKey(
    series: MetricsSeries,
    row: { ns: string; entity: string; interval: number; at: number },
  ): string {
    if (row.entity === NAMESPACE_ENTITY) {
      return this.#namespaceSeriesKey(series, row);
    }

    const { queue, key } = splitWorkerEntity(row.entity);

    return this.keys.metricsKey(
      this.keys.queue({ ns: row.ns, queue }).metricsPrefix,
      series,
      row.interval,
      row.at,
      key,
    );
  }

  /** Where a namespace roll-up row goes. */
  #namespaceSeriesKey(
    series: MetricsSeries,
    row: { ns: string; interval: number; at: number },
  ): string {
    return this.keys.metricsKey(
      this.keys.namespaceMetrics(row.ns),
      series,
      row.interval,
      row.at,
    );
  }

  /** Where one buffered runner row goes: the runner's hash, or the namespace's. */
  #runnerSeriesKey(
    series: MetricsSeries,
    row: { ns: string; entity: string; interval: number; at: number },
  ): string {
    if (row.entity === NAMESPACE_ENTITY) {
      return this.#namespaceSeriesKey(series, row);
    }

    return this.keys.metricsKey(
      this.keys.runner(row.ns, row.entity).metricsPrefix,
      series,
      row.interval,
      row.at,
    );
  }

  /**
   * Writes one batch of counter rows: one script call per hash, however many
   * buckets and counters of it the batch touched.
   *
   * A hash whose call failed is answered as unwritten and tried again on the
   * next tick — only that hash, never the whole batch, because the calls are
   * separate and putting a landed one back would count it twice.
   */
  async #writeCounts<C extends Record<keyof C, number>>(
    batch: PendingMetric<C>[],
    counters: readonly (keyof C & string)[],
    keyOf: (row: PendingMetric<C>) => string,
    /** Where each row's entity is indexed; omitted for the roll-up's own buffer. */
    indexOf?: (row: IndexedRow) => IndexEntry | undefined,
  ): Promise<BufferWriteResult<PendingMetric<C>>> {
    await this.connect();

    // The index first, and nothing else if it fails: a hash written without
    // its entity indexed would be invisible to the grouped read, while an
    // entity indexed without its hash is only an empty read.
    if (indexOf) {
      try {
        await this.#writeIndex(batch, indexOf);
      } catch (caught) {
        return { unwritten: batch, error: caught };
      }
    }

    const byKey = new Map<string, PendingMetric<C>[]>();

    for (const row of batch) {
      const key = keyOf(row);
      const held = byKey.get(key);
      if (held) {
        held.push(row);
      } else {
        byKey.set(key, [row]);
      }
    }

    const unwritten: PendingMetric<C>[] = [];
    let error: unknown;

    await Promise.all(
      [...byKey].map(async ([key, rows]) => {
        const args = [
          String(this.#metricsExpireAt(rows[0]!.interval, rows[0]!.at)),
        ];

        for (const row of rows) {
          const offset = this.#offsetOf(row.at, row.interval);
          for (const counter of counters) {
            const delta = row.counts[counter] ?? 0;
            if (delta !== 0) {
              args.push(metricsField(offset, counter), String(delta));
            }
          }
        }

        if (args.length === 1) {
          return;
        }

        try {
          await this.#run(scripts.METRIC_COUNT, [key], args);
        } catch (caught) {
          unwritten.push(...rows);
          error ??= caught;
        }
      }),
    );

    return error === undefined ? { unwritten } : { unwritten, error };
  }

  /** Writes one batch of duration rows: one script call per hash. */
  async #writeDurations(
    batch: PendingStats<DurationStats>[],
  ): Promise<BufferWriteResult<PendingStats<DurationStats>>> {
    return await this.#writeStats(
      batch,
      "rdur",
      scripts.METRIC_DURATION,
      (row) => {
        const offset = this.#offsetOf(row.at, row.interval);
        const args = [
          String(offset),
          String(row.stats.count),
          String(row.stats.sumMs),
          String(row.stats.minMs),
          String(row.stats.maxMs),
        ];
        const bins: string[] = [];

        // Only the bins that counted something: a run's duration lands in one of
        // them, so a second's worth is one or two rather than 25 zeros.
        for (let bin = 0; bin < DURATION_HISTOGRAM_SIZE; bin++) {
          const count = row.stats.histogram[bin] ?? 0;
          if (count > 0) {
            bins.push(String(bin), String(count));
          }
        }

        args.push(String(bins.length / 2), ...bins);
        return args;
      },
    );
  }

  /** Writes one batch of busyness rows: one script call per hash. */
  async #writeBusyness(
    batch: PendingStats<BusynessStats>[],
  ): Promise<BufferWriteResult<PendingStats<BusynessStats>>> {
    return await this.#writeStats(
      batch,
      "wbusy",
      scripts.METRIC_BUSYNESS,
      (row) => [
        String(this.#offsetOf(row.at, row.interval)),
        String(row.stats.samples),
        String(row.stats.activeSum),
        String(row.stats.activeMax),
        String(row.stats.concurrency),
        String(row.stats.lastAt),
      ],
    );
  }

  /** What {@link RedisDriver.#writeCounts} is for the two statistics series. */
  async #writeStats<TStats>(
    batch: PendingStats<TStats>[],
    series: MetricsSeries,
    source: string,
    argsOf: (row: PendingStats<TStats>) => string[],
  ): Promise<BufferWriteResult<PendingStats<TStats>>> {
    await this.connect();

    // The index first, for the reason `#writeCounts` gives.
    try {
      await this.#writeIndex(
        batch,
        series === "rdur"
          ? (row) => this.#runnerIndexEntry(row)
          : (row) => this.#workerIndexEntry(row),
      );
    } catch (caught) {
      return { unwritten: batch, error: caught };
    }

    const byKey = new Map<string, PendingStats<TStats>[]>();

    for (const row of batch) {
      const key =
        series === "rdur"
          ? this.#runnerSeriesKey(series, row)
          : this.#workerSeriesKey(series, row);
      const held = byKey.get(key);
      if (held) {
        held.push(row);
      } else {
        byKey.set(key, [row]);
      }
    }

    const unwritten: PendingStats<TStats>[] = [];
    let error: unknown;

    await Promise.all(
      [...byKey].map(async ([key, rows]) => {
        const args = [
          String(this.#metricsExpireAt(rows[0]!.interval, rows[0]!.at)),
        ];

        for (const row of rows) {
          args.push(...argsOf(row));
        }

        try {
          await this.#run(source, [key], args);
        } catch (caught) {
          unwritten.push(...rows);
          error ??= caught;
        }
      }),
    );

    return error === undefined ? { unwritten } : { unwritten, error };
  }

  /** Which of a hash's sixty buckets an instant is. */
  #offsetOf(at: number, interval: number): number {
    return Math.floor((at - metricsGroupStart(at, interval)) / interval);
  }

  /**
   * The buckets of one series in range, as each bucket's fields.
   *
   * One `HGETALL` per group hash, sent together — which is the layout's whole
   * point: a minute at one second is two of them, and a day at one minute is
   * twenty-four.
   */
  async #readBuckets(
    prefix: string,
    series: MetricsSeries,
    entity: string | undefined,
    range: { from: number; to: number; interval: number },
  ): Promise<Map<number, Record<string, string>>> {
    const span = metricsGroupSpan(range.interval);
    const groups: number[] = [];

    for (
      let group = metricsGroupStart(range.from, range.interval);
      group <= metricsGroupStart(range.to, range.interval);
      group += span
    ) {
      groups.push(group);
    }

    const replies = await Promise.all(
      groups.map(
        async (group) =>
          await this.#client.hgetall(
            this.keys.metricsKey(prefix, series, range.interval, group, entity),
          ),
      ),
    );

    const buckets = new Map<number, Record<string, string>>();

    groups.forEach((group, index) => {
      const fields = this.#toObject(replies[index]);

      if (!fields) {
        return;
      }

      for (const [field, value] of Object.entries(fields)) {
        const parsed = parseMetricsField(field);

        if (!parsed) {
          continue;
        }

        const at = group + parsed.offset * range.interval;

        if (at < range.from || at > range.to) {
          continue;
        }

        const bucket = buckets.get(at) ?? {};
        bucket[parsed.name] = value;
        buckets.set(at, bucket);
      }
    });

    return buckets;
  }

  /** {@link RedisDriver.#readBuckets} as the rows a counter merge takes. */
  async #readRows(
    prefix: string,
    series: MetricsSeries,
    entity: string | undefined,
    range: { from: number; to: number; interval: number },
  ): Promise<{ at: number; [field: string]: unknown }[]> {
    const buckets = await this.#readBuckets(prefix, series, entity, range);

    return [...buckets].map(([at, fields]) => ({ ...fields, at }));
  }

  /** Stored duration fields as the buckets a reader merges. */
  #toDurationBuckets(
    buckets: Map<number, Record<string, string>>,
    range: { from: number; to: number },
  ): RawDurationBucket[] {
    return mergeDurationBuckets(
      [...buckets].map(([at, fields]) => ({
        at,
        count: Number(fields.count ?? 0),
        sumMs: Number(fields.sumMs ?? 0),
        minMs: Number(fields.minMs ?? 0),
        maxMs: Number(fields.maxMs ?? 0),
        histogram: Array.from(
          { length: DURATION_HISTOGRAM_SIZE },
          (_unused, bin) => Number(fields[`b${bin}`] ?? 0),
        ),
      })),
      range,
    );
  }

  /**
   * One runner's read over a clamped range: its outcomes, and its durations
   * when asked for and recorded.
   *
   * Every hash of both series is requested before any reply is awaited, so a
   * read is one round trip — and a batch of them, started together, is still
   * one.
   */
  async #readRunner(
    ns: string,
    id: string,
    range: { from: number; to: number; interval: number },
    durations: boolean,
  ): Promise<RunnerMetricsRead> {
    const prefix = this.keys.runner(ns, id).metricsPrefix;
    const [runs, timed] = await Promise.all([
      this.#readRows(prefix, "runs", undefined, range),
      durations && this.#metrics.durations
        ? this.#readBuckets(prefix, "rdur", undefined, range)
        : undefined,
    ]);
    const read: RunnerMetricsRead = {
      runs: mergeCounterBuckets(runs, range, RUNNER_RUN_COUNTERS),
    };

    if (timed) {
      read.durations = this.#toDurationBuckets(timed, range);
    }

    return read;
  }

  /**
   * One worker key's read over a clamped range: the jobs it finished, and its
   * busyness when asked for. One round trip, as {@link RedisDriver.#readRunner}.
   */
  async #readWorker(
    q: QueueRef,
    key: string,
    range: { from: number; to: number; interval: number },
    busyness: boolean,
  ): Promise<WorkerMetricsRead> {
    const prefix = this.keys.queue(q).metricsPrefix;
    const [jobs, sampled] = await Promise.all([
      this.#readRows(prefix, "wjobs", key, range),
      busyness ? this.#readBuckets(prefix, "wbusy", key, range) : undefined,
    ]);
    const read: WorkerMetricsRead = {
      jobs: mergeCounterBuckets(jobs, range, JOB_COUNTERS),
    };

    if (sampled) {
      read.busyness = mergeBusynessBuckets(
        [...sampled].map(([at, fields]) => ({
          at,
          samples: Number(fields.samples ?? 0),
          activeSum: Number(fields.activeSum ?? 0),
          activeMax: Number(fields.activeMax ?? 0),
          concurrency: Number(fields.concurrency ?? 0),
          lastAt: Number(fields.lastAt ?? 0),
        })),
        range,
      ) satisfies RawBusynessBucket[];
    }

    return read;
  }

  /**
   * Runner names as the runner ids they are stored under, each answered once
   * under the first name it was asked by.
   *
   * An id of `""` is dropped: that is the namespace roll-up's entity, never a
   * runner, however it was spelled (`""` or a bare `r:`).
   */
  #runnerNames(names: Iterable<string>): Map<string, string> {
    const byId = new Map<string, string>();

    for (const name of names) {
      const id = this.#runnerId(name);
      if (id !== NAMESPACE_ENTITY && !byId.has(id)) {
        byId.set(id, name);
      }
    }

    return byId;
  }

  /**
   * The members of one metrics index that may have recorded anything at or
   * after `from` — one `ZRANGE … BYSCORE`, never a scan of the keyspace.
   *
   * A member's score is an upper bound on its latest recorded instant, so this
   * errs towards naming an entity whose data turns out to lie after the range
   * (its read comes back empty and it is left out), never towards missing one.
   */
  async #indexed(
    ns: string,
    kind: "runners" | "workers",
    from: number,
  ): Promise<string[]> {
    const members = (await this.#client.send("ZRANGE", [
      this.keys.metricsIndex(ns, kind),
      String(from),
      "+inf",
      "BYSCORE",
    ])) as string[] | null;

    return (members ?? []).filter((member) => member !== NAMESPACE_ENTITY);
  }

  /** Where a buffered runner row is indexed — nowhere, for the roll-up. */
  #runnerIndexEntry(row: IndexedRow): IndexEntry | undefined {
    if (row.entity === NAMESPACE_ENTITY) {
      return undefined;
    }

    return {
      key: this.keys.metricsIndex(row.ns, "runners"),
      member: row.entity,
    };
  }

  /** Where a buffered worker row is indexed — nowhere, for the roll-up. */
  #workerIndexEntry(row: IndexedRow): IndexEntry | undefined {
    if (row.entity === NAMESPACE_ENTITY) {
      return undefined;
    }

    const { queue, key } = splitWorkerEntity(row.entity);

    return {
      key: this.keys.metricsIndex(row.ns, "workers"),
      member: workerMetricsEntity(queue, key),
    };
  }

  /**
   * Names a batch's entities in their namespaces' indexes: one `METRIC_INDEX`
   * call per index touched, sent together.
   *
   * A member's score is the **end** of the latest bucket it wrote, not the
   * start: a minute-wide row for an event late in its minute must not rank the
   * entity below a second-wide read's `from`. Members whose score is older
   * than the longest any bucket lives are trimmed on the same call, and the
   * set expires with the newest hash the batch wrote.
   *
   * Throws when any call fails; the caller then writes none of the hashes, so
   * a counted point is never missing from the index.
   */
  async #writeIndex(
    batch: readonly IndexedRow[],
    entryOf: (row: IndexedRow) => IndexEntry | undefined,
  ): Promise<void> {
    const byKey = new Map<
      string,
      { scores: Map<string, number>; expireAt: number }
    >();

    for (const row of batch) {
      const entry = entryOf(row);

      if (!entry) {
        continue;
      }

      const held = byKey.get(entry.key) ?? {
        scores: new Map<string, number>(),
        expireAt: 0,
      };
      const score = row.at + row.interval - 1;

      held.scores.set(
        entry.member,
        Math.max(held.scores.get(entry.member) ?? score, score),
      );
      held.expireAt = Math.max(
        held.expireAt,
        this.#metricsExpireAt(row.interval, row.at),
      );
      byKey.set(entry.key, held);
    }

    if (byKey.size === 0) {
      return;
    }

    const now = Date.now();
    const trimBefore = String(now - this.#indexHorizon());

    await Promise.all(
      [...byKey].map(async ([key, { scores, expireAt }]) => {
        const args = [String(now), trimBefore, String(expireAt)];

        for (const [member, score] of scores) {
          args.push(member, String(score));
        }

        await this.#run(scripts.METRIC_INDEX, [key], args);
      }),
    );
  }

  /**
   * How long after an entity's last recorded instant any of its buckets can
   * still exist: the widest group plus its retention, over the widths this
   * driver records. An index member older than this points at nothing.
   */
  #indexHorizon(): number {
    let horizon = 0;

    for (const interval of this.#metrics.intervals) {
      horizon = Math.max(
        horizon,
        metricsGroupSpan(interval) +
          metricsRetentionFor(this.#metrics, interval),
      );
    }

    return horizon;
  }

  /** Retention as the three arguments the scripts read. */
  #retention(retention: Retention): {
    mode: string;
    count: string;
    ttl: string;
  } {
    if (retention === true) {
      return { mode: "remove", count: "0", ttl: "0" };
    }

    if (typeof retention === "number") {
      return { mode: "cap", count: String(retention), ttl: "0" };
    }

    if (retention && typeof retention === "object") {
      return {
        mode: retention.count === undefined ? "keep" : "cap",
        count: String(retention.count ?? 0),
        ttl: String(retention.ttl ?? 0),
      };
    }

    return { mode: "keep", count: "0", ttl: "0" };
  }

  /**
   * A job record as the values the add scripts take, in `JOB_FIELDS` order.
   *
   * Values only — the field names live in the script as a constant table, so
   * they are interned once when it is cached rather than once per job. That
   * halves the ARGV entries, and every entry is a string the Lua VM has to
   * intern on the way in: 10 for a fresh job where the name/value shape sent
   * 22.
   *
   * Written out in order rather than built and filtered. The obvious shape —
   * all twenty-two, then drop the ones a fresh job does not need — costs four
   * `JSON.stringify` calls whose results are discarded, a `Set` allocated per
   * job, and three more arrays from `entries`/`filter`/`flat`. Measured against
   * bee-queue's single `toData()`, that was 4.50µs a job to its 0.26µs, all of
   * it on the enqueue critical path.
   */
  #toValues(job: JobRecord): string[] {
    // The first FRESH_JOB_FIELD_COUNT of JOB_FIELDS, in that order. `blob`
    // carries the four fields no script ever touches, in one value — see
    // `JOB_FIELDS`. It is also one `JSON.stringify` where `data` and `opts`
    // were two.
    const values: string[] = [
      job.id,
      job.state,
      String(job.priority),
      String(job.runAt),
      String(job.createdAt),
      // `opts` ahead of `data`, so a script can decode a job's options
      // without parsing its payload — see `JOB_HEAD_PRELUDE`. The order costs
      // nothing: it is the same one `JSON.stringify`, and the mask rides in
      // `opts` (`opts.explicit`), so the add path carries no field for it.
      JSON.stringify({
        name: job.name,
        maxAttempts: job.maxAttempts,
        opts: job.opts,
        data: job.data ?? null,
      }),
    ];

    // Only `addJob` and `addJobs` call this, both writing a hash that does not
    // exist yet, so stopping here simply leaves the rest absent — and the
    // reader treats absent and default alike. For a brand-new job that is
    // every remaining field: each an empty string, a "null" or a zero.
    if (this.#isFreshJob(job)) {
      return values;
    }

    // The rest of JOB_FIELDS, in that order.
    values.push(
      job.processedOn === null ? "" : String(job.processedOn),
      job.finishedOn === null ? "" : String(job.finishedOn),
      job.expiresAt === null ? "" : String(job.expiresAt),
      String(job.attemptsMade),
      String(job.stalledCount),
      job.lockToken ?? "",
      job.lockExpiresAt === null ? "" : String(job.lockExpiresAt),
      job.workerId ?? "",
      job.repeatKey ?? "",
      JSON.stringify(job.progress ?? null),
      JSON.stringify(job.returnValue ?? null),
      JSON.stringify(job.failedReason ?? null),
      JSON.stringify(job.stacktrace ?? []),
    );

    // A job in no flow stops here, and the script writes none of the flow
    // fields; the reader takes their absence as `flow: null`.
    if (!job.flow) {
      if (job.processedBy) {
        // A restored record's stamp rides the name/value pairs after the named
        // fields, so it has to send the three flow fields first — empty, which
        // the reader and every script take as "in no flow". Only a record
        // added already stamped pays those few bytes; a claim writes the
        // stamp itself.
        values.push("", "", "", STAMP_FIELD, packStamp(job.processedBy));
      }
      return values;
    }

    const { parent, children, pending, recorded } = job.flow;
    values.push(
      // Each reference rebuilt with its keys in one fixed order, which is
      // what lets `RECORD_CHILD` find a child by substring — see
      // `flowRefJson`. Written by hand, so the order is not the caller's.
      `{"parent":${parent ? flowRefJson(parent) : "null"},"children":[${children
        .map((ref) => flowRefJson(ref))
        .join(",")}]}`,
      String(pending),
      recorded ? "1" : "0",
    );

    // Outcomes a record arrives with, as name/value pairs after the named
    // fields — the same one field per child that `RECORD_CHILD` writes.
    for (const [key, value] of Object.entries(job.flow.values)) {
      values.push(
        `${scripts.FLOW_VALUE_PREFIX}${key}`,
        JSON.stringify(value ?? null),
      );
    }
    for (const [key, error] of Object.entries(job.flow.failures)) {
      values.push(
        `${scripts.FLOW_FAILURE_PREFIX}${key}`,
        JSON.stringify(error),
      );
    }

    if (job.processedBy) {
      values.push(STAMP_FIELD, packStamp(job.processedBy));
    }

    return values;
  }

  /**
   * Whether a record carries nothing beyond what a brand-new job carries.
   *
   * `maxAttempts` is deliberately not omittable: an absent numeric field reads
   * back as zero, and zero is not this one's default.
   */
  #isFreshJob(job: JobRecord): boolean {
    return (
      // A job in a flow carries it from the start, so it is never "fresh".
      !job.flow &&
      job.processedOn === null &&
      job.finishedOn === null &&
      job.expiresAt === null &&
      job.lockToken === null &&
      job.lockExpiresAt === null &&
      job.workerId === null &&
      // A restored stamp must be written, and only the full shape carries it.
      job.processedBy == null &&
      job.repeatKey === null &&
      job.attemptsMade === 0 &&
      job.stalledCount === 0 &&
      job.progress === null &&
      job.returnValue === null &&
      job.failedReason === null &&
      (job.stacktrace?.length ?? 0) === 0
    );
  }

  /**
   * A name as `FIND_JOBS` tags it: `j` then a JSON string literal, `r` then
   * the name itself, or `-` (answered `null`) for a job whose hash has gone.
   * A literal that does not parse — which the script's cut never produces —
   * reads as `null` too, rather than matching on a mangled name.
   */
  #decodeName(tagged: string): string | null {
    const tag = tagged[0];

    if (tag === "r") {
      return tagged.slice(1);
    }

    if (tag === "j") {
      const name = safeJsonParse<unknown>(tagged.slice(1), null);
      return typeof name === "string" ? name : null;
    }

    return null;
  }

  /** A flat `HGETALL` reply as an object, or `null` when the job is gone. */
  #toObject(reply: unknown): Record<string, string> | null {
    if (!reply) {
      return null;
    }

    // A script returns HGETALL as a flat array; the client returns an object.
    if (Array.isArray(reply)) {
      if (reply.length === 0) {
        return null;
      }

      const fields: Record<string, string> = {};
      for (let index = 0; index < reply.length; index += 2) {
        fields[String(reply[index])] = String(reply[index + 1]);
      }
      return fields;
    }

    const fields = reply as Record<string, string>;
    return Object.keys(fields).length > 0 ? fields : null;
  }

  /**
   * Stored fields as a job record.
   *
   * `claimedBy` is the ref a claim just stamped the job with. It is what the
   * stamp field would decode to, so a claim passes it rather than paying to
   * parse the string it wrote a moment ago — the top Redis item of this
   * round's roundtrip regression.
   */
  #toRecord(
    fields: Record<string, string>,
    claimedBy?: JobWorkerRef,
  ): JobRecord {
    const number = (name: string): number => Number(fields[name] ?? 0);
    const nullable = (name: string): number | null =>
      fields[name] === undefined || fields[name] === ""
        ? null
        : Number(fields[name]);
    const text = (name: string): string | null =>
      fields[name] === undefined || fields[name] === "" ? null : fields[name];
    const json = <T>(name: JsonField, fallback: T): T =>
      safeJsonParse<T>(fields[name], fallback);

    // `blob` holds `name`, `maxAttempts`, `opts` and `data` together. A record
    // written before it existed has them as four separate fields instead, and
    // both have to read back the same — nothing migrates a hash in place.
    const blob = safeJsonParse<{
      name?: string;
      maxAttempts?: number;
      data?: unknown;
      opts?: StoredJobOptions;
    }>(fields.blob, {});

    // `updateJob` never rewrites the blob — see `UPDATE_JOB` — so a patched
    // payload sits in `data`, a patched priority in `optsPriority` and the
    // mask it marks in `xmask`, and each wins over the blob's copy. A record
    // from before the blob keeps its payload in `data` too, so one rule reads
    // both shapes. A rewrite with a queue's defaults writes `o:<option>`
    // fields beside the blob the same way (`REWRITE_PENDING`).
    const opts = this.#overlayOptions(
      blob.opts ?? json<StoredJobOptions>("opts", {} as StoredJobOptions),
      fields,
    );
    const optsPriority = nullable("optsPriority");
    const rewrittenMax = nullable(scripts.MAX_ATTEMPTS_FIELD);
    // Who claimed the current or last attempt. Absent — not `null` — on a job
    // never claimed since attribution existed, so such a record reads back
    // exactly as it was added.
    const processedBy = claimedBy
      ? stampedRef(claimedBy)
      : unpackStamp(fields[STAMP_FIELD]);

    return {
      id: fields.id,
      name: blob.name ?? fields.name,
      data:
        fields.data !== undefined
          ? json<unknown>("data", null)
          : (blob.data ?? null),
      opts: optsPriority === null ? opts : { ...opts, priority: optsPriority },
      state: fields.state as JobState,
      priority: number("priority"),
      runAt: number("runAt"),
      createdAt: number("createdAt"),
      processedOn: nullable("processedOn"),
      finishedOn: nullable("finishedOn"),
      expiresAt: nullable("expiresAt"),
      attemptsMade: number("attemptsMade"),
      maxAttempts: rewrittenMax ?? blob.maxAttempts ?? number("maxAttempts"),
      stalledCount: number("stalledCount"),
      progress: json<unknown>("progress", null),
      returnValue: json<unknown>("returnValue", null),
      failedReason: json<SerializedError | null>("failedReason", null),
      stacktrace: json<SerializedError[]>("stacktrace", []),
      lockToken: text("lockToken"),
      lockExpiresAt: nullable("lockExpiresAt"),
      // The holder: the claim sets it and every settle clears it, so it is
      // stored holder-only and needs no masking by state. The stamp is apart.
      workerId: text("workerId"),
      ...(processedBy ? { processedBy } : {}),
      repeatKey: text("repeatKey"),
      flow: this.#toFlow(fields),
    };
  }

  /**
   * `opts` with the fields written beside the blob laid over it: each
   * `o:<option>` a rewrite wrote, and the `xmask` a priority update wrote.
   * Returned as it is when there are none — the usual case, and the reason a
   * job untouched since its add reads back exactly as it was added.
   * `optsPriority` is laid over by the caller, as it always was.
   */
  #overlayOptions(
    opts: StoredJobOptions,
    fields: Record<string, string>,
  ): StoredJobOptions {
    let next: StoredJobOptions | undefined;

    for (const key of JOB_DEFAULT_KEYS) {
      const stored = fields[`${scripts.OPTION_FIELD_PREFIX}${key}`];

      if (stored !== undefined) {
        next ??= { ...opts };
        (next as unknown as Record<string, unknown>)[key] =
          safeJsonParse<unknown>(stored, undefined);
      }
    }

    const mask = fields[scripts.EXPLICIT_MASK_FIELD];

    if (mask !== undefined && mask !== "") {
      next ??= { ...opts };
      next.explicit = Number(mask);
    }

    return next ?? opts;
  }

  /**
   * A job's flow, assembled from the fields that hold it, or `null` for a job
   * in none — including every hash written before flows existed.
   *
   * `flow` holds the parent and children, `flowPending` and `flowRecorded` the
   * two parts scripts change, and each child outcome has a field of its own.
   * A job with only `flowRecorded` was marked by `markChildRecorded` without
   * ever being in a flow, and reads as an empty one.
   */
  #toFlow(fields: Record<string, string>): JobFlow | null {
    const skeleton = safeJsonParse<Pick<JobFlow, "parent" | "children"> | null>(
      fields.flow,
      null,
    );

    if (!skeleton && fields.flowRecorded !== "1") {
      return null;
    }

    const values: Record<string, unknown> = {};
    const failures: Record<string, SerializedError> = {};

    for (const [field, stored] of Object.entries(fields)) {
      if (field.startsWith(scripts.FLOW_VALUE_PREFIX)) {
        values[field.slice(scripts.FLOW_VALUE_PREFIX.length)] =
          safeJsonParse<unknown>(stored, null);
      } else if (field.startsWith(scripts.FLOW_FAILURE_PREFIX)) {
        const error = safeJsonParse<SerializedError | null>(stored, null);
        if (error) {
          failures[field.slice(scripts.FLOW_FAILURE_PREFIX.length)] = error;
        }
      }
    }

    return {
      parent: skeleton?.parent ?? null,
      children: skeleton?.children ?? [],
      pending: Number(fields.flowPending ?? 0) || 0,
      values,
      failures,
      recorded: fields.flowRecorded === "1",
    };
  }
}
