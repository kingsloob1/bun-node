import type { LogLevel, SerializedError } from "@kingsleyweb/bun-common";
import type { SQL } from "bun";
import type {
  ConnectionInput,
  ConnectionOptions,
  UrlDefaults,
} from "../../shared/connection";
import type { RunLogStream } from "../../shared/constants";
import type {
  AddedRange,
  ChildOutcome,
  ChildRecordResult,
  ClaimOptions,
  ClearJobLogsResult,
  DriverCapabilities,
  DriverEvent,
  EditableJobOptionKey,
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
  PromoteDelayedResult,
  QueuedTrigger,
  QueueRef,
  QueueStateEntry,
  RepeatRecord,
  ResolvedJobOptions,
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
import type { PendingThroughput, ThroughputWriteResult } from "../readApis";
import type { SchemaChange, SchemaSyncOptions } from "../schemaSync";
import type {
  ClaimCursor,
  ClaimStatementOptions,
  SqlAdapter,
  SqlDialect,
} from "./dialect";
import type { SchemaTableNames } from "./schema";
import { jsonClone, sleep } from "@kingsleyweb/bun-common";
import { SQL as BunSQL } from "bun";
import {
  assertRewriteRequest,
  decodeRewriteCursor,
  emptyRewriteResult,
  encodeRewriteCursor,
  JOB_OPTION_BITS,
  planPendingRewrite,
  tallyRewrite,
} from "../../queue/jobDefaults";
import { assertWritableStateName } from "../../queue/windows";
import {
  resolveConnectionUrl,
  resolveNames,
  takeBooleanParam,
} from "../../shared/connection";
import { ConfigError, DriverError } from "../../shared/errors";
import { EventRetention } from "../../shared/eventRetention";
import { fitName } from "../../shared/fit";
import { newId } from "../../shared/ids";
import { PauseCache } from "../../shared/pauseCache";
import {
  emptyAddedCounts,
  rangeMatchesNothing,
  sortsByCreated,
} from "../added";
import {
  attributionFilter,
  FINISHED_STATES,
  hasRange,
  matchesNothing,
} from "../attribution";
import { BURIABLE_STATES, canBury } from "../bury";
import { claimByLoop } from "../claimBatch";
import { EventGaps } from "../eventGaps";
import {
  awaitsDelivery,
  flowKey,
  listsChild,
  unsettledChildren,
} from "../flow";
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
  splitWorkerMetricsEntity,
  uniqueWorkerRefs,
  workerMetricsEntity,
} from "../metrics";
import {
  emptyCounts,
  escapeLike,
  orderByIds,
  sortWorkers,
  sumBuckets,
  THROUGHPUT_RETENTION_MS,
  throughputBucket,
  ThroughputBuffer,
} from "../readApis";
import { emptyRunLog, runLogBytes } from "../runLogs";
import { resolveSyncOptions } from "../schemaSync";
import { Arrivals } from "./arrivals";
import { detectAdapter, dialectFor, withLockRetry } from "./dialect";
import {
  BUSYNESS_COLUMNS,
  claimIndexName,
  createSchema,
  DURATION_BIN_COLUMNS,
  DURATION_STAT_COLUMNS,
  FRESH_JOB_COLUMNS,
  insertColumns,
  JOB_COLUMNS,
  jobColumnTypes,
  METRIC_KEY_COLUMNS,
  schemaDefinition,
  STAMP_COLUMNS,
} from "./schema";
import { syncSqlSchema } from "./sync";

/**
 * A driver backed by a SQL database.
 *
 * The one backend most services already have. Exclusivity comes from the
 * database's own concurrency control rather than anything invented here: a
 * claim is a single conditional `UPDATE`, so whichever transaction commits it
 * owns the job and the other sees zero rows affected.
 *
 * Four engines, three claim strategies, one driver: Postgres and MySQL pick a
 * row with `FOR UPDATE SKIP LOCKED`, SQLite takes the database's write lock
 * with `BEGIN IMMEDIATE`, and MariaDB re-selects because its `UPDATE` cannot
 * return rows. What differs lives in `dialect.ts`; everything below is
 * written once.
 */

/** How often a polling wait re-checks, in milliseconds. */
const POLL_MS = 50;

/**
 * How many jobs go into one multi-row insert.
 *
 * Postgres caps a statement at 65,535 parameters and a job is 24 columns, so
 * the ceiling is about 2,700 rows; 500 leaves room under every engine's limit
 * and keeps a single statement short enough to plan quickly.
 */
const INSERT_CHUNK = 500;

/**
 * The fewest rows that may be written before statistics are refreshed.
 *
 * The same heuristic autovacuum uses — a threshold on rows changed, plus a
 * share of the table — applied promptly rather than on a 60-second nap. A
 * queue table earns it: measured on Postgres, the claim statement cost 25.9ms
 * with stale statistics and 0.668ms with fresh ones, the same plan either way.
 */
const ANALYZE_MIN_ROWS = 2_000;

/**
 * The share of the table that must change before re-analysing it.
 *
 * Autovacuum's `autovacuum_analyze_scale_factor`, and it exists because
 * `ANALYZE` is linear in table size: 11.3ms at 5,000 rows, 77.8ms at 50,000.
 * A fixed threshold would re-analyse a large table every few inserts, so the
 * threshold grows with the table and the cost per row written stays flat.
 */
const ANALYZE_SCALE_FACTOR = 0.1;

/**
 * Where each column of a subset sits in the full value list, resolved once.
 *
 * {@link SqlDriver.#toRow} and {@link SqlDriver.#toDocument} lay a job out in
 * {@link JOB_COLUMNS} order and then pick the columns a given statement names.
 * That mapping depends only on the column list, so it is loop-invariant across
 * a chunk — and doing it per job is expensive: building the lookup 5,000 times
 * cost 7.47ms against 0.73ms for this, measured on a 5,000-job batch.
 *
 * Keyed on the array itself, which is why the callers pass the module
 * constants rather than copies of them.
 */
const COLUMN_INDICES = new WeakMap<readonly string[], readonly number[]>();

/** The index list for `columns`, computed on first use and then reused. */
function columnIndices(columns: readonly string[]): readonly number[] {
  const cached = COLUMN_INDICES.get(columns);

  if (cached) {
    return cached;
  }

  const indices = columns.map((column) =>
    JOB_COLUMNS.indexOf(column as (typeof JOB_COLUMNS)[number]),
  );
  COLUMN_INDICES.set(columns, indices);

  return indices;
}

/** Every job state, in the order `countJobs` reports them. */
const STATES: JobState[] = [
  "waiting",
  "delayed",
  "active",
  "completed",
  "failed",
  "dead",
  "waiting-children",
];

/** States holding a job that is due later. */
const SCHEDULED: JobState[] = ["delayed", "failed"];

/** States whose due time `updateJob` may move. */
const PENDING: JobState[] = ["waiting", "delayed"];

/**
 * How many jobs one transaction of `rewritePendingOptions` reads, locks and
 * writes, per engine.
 *
 * On Postgres, MySQL and MariaDB the batch holds row locks, which a claim
 * skips (`SKIP LOCKED`) rather than waits on, so a larger batch costs nothing
 * but a transient reorder. SQLite's transaction is the database's only write
 * lock — every claim waits for it — so its batch is kept to what writes in a
 * few milliseconds.
 */
const REWRITE_BATCH: Record<SqlAdapter, number> = {
  postgres: 500,
  mysql: 500,
  mariadb: 500,
  sqlite: 200,
};

/** The key a rewrite cursor carries: claim order, `(priority, created_at, id)`. */
const REWRITE_CURSOR_KEY = ["number", "number", "string"] as const;

/** The columns of a pending job the rewrite reads. */
/** One column a {@link SqlDriver} point update sets, as its match read checks it. */
interface MatchedAssignment {
  /** The column written. */
  column: string;
  /** The value bound for it, already encoded (`jsonIn` for a JSON column). */
  value: unknown;
  /**
   * Whether the column holds JSON, so MySQL's match read compares it as JSON
   * rather than as text. MariaDB stores JSON as text and compares it so.
   * Default `false`.
   */
  json?: boolean;
}

interface RewriteRow {
  /** The job's id. */
  id: string;
  /** Its `priority` column, as the engine returns an integer. */
  priority: number | string;
  /** Its `created_at`, likewise. */
  created_at: number | string;
  /** Its `max_attempts`, likewise. */
  max_attempts: number | string;
  /** Its `attempts_made`, likewise. */
  attempts_made: number | string;
  /** Its `opts` document, as the client returned it. */
  opts: unknown;
}

/**
 * How long the orphaned-log sweep rests after a full pass over a queue.
 *
 * Orphans only make lines nobody can read take up disk — every read already
 * ignores them — so there is no hurry. Resting keeps an idle queue's
 * maintenance tick from paying a query every second for nothing.
 */
const LOG_SWEEP_INTERVAL_MS = 30_000;

/**
 * How long a claim cursor lives without being used.
 *
 * A cursor is keyed by the set of names a claim skipped, and the set changes as
 * limits fill and drain, so each one that is no longer asked for is dropped
 * rather than kept for the life of the process. Losing one costs nothing but a
 * pass from the head.
 */
const CLAIM_CURSOR_IDLE_MS = 60_000;

/**
 * The exclusive upper bound of every string that begins with `value`, in
 * code-point order: `value` with its last code point incremented.
 *
 * What lets a literal prefix match be a plain range, so a `%` or `_` in the
 * prefix is just a character. A trailing U+10FFFF has no successor and is
 * dropped first; an increment into the surrogate block skips past it, since a
 * lone surrogate is not a character an engine would store. Callers pass a
 * non-empty key base, so there is always a code point left to increment.
 */
function prefixSuccessor(value: string): string {
  const points = Array.from(value);

  while (points.length > 0) {
    const last = points.pop()!.codePointAt(0)!;
    if (last < 0x10ffff) {
      const next = last + 1 === 0xd800 ? 0xe000 : last + 1;
      return points.join("") + String.fromCodePoint(next);
    }
  }

  return value;
}

/**
 * The statement listing a queue's state names: a range scan over its
 * `q:<queue>:state:` keys, never a `LIKE` on the name. The contract wants the
 * prefix taken literally, and a half-open range `[base + prefix, successor)`
 * has no wildcards to escape.
 *
 * Every comparison and the sort are made in code-point order, because that is
 * what the contract's "ascending name order" means and what `after` pages by —
 * a sweep that compared one way and sorted another could skip or repeat
 * entries at a page boundary.
 *
 * SQLite's `BINARY`, and the binary collation `kv_key` has on MySQL and
 * MariaDB, already are that order, so the primary key serves the range and the
 * sort as it is. Postgres' key is in the database's locale, where `en_US` puts
 * `a` before `B`: there every comparison is made `COLLATE "C"` (byte order,
 * which for UTF-8 is code-point order), and the `(ns, kv_key COLLATE "C")`
 * index is what serves it — without that index only the `ns` equality narrows
 * the scan.
 *
 * Exported so a test can `EXPLAIN` exactly what the driver runs.
 */
export function queueStateListStatement(
  dialect: SqlDialect,
  table: string,
  bind: (value: unknown) => string,
  options: {
    /** The namespace. */
    ns: string;
    /** The queue's state key prefix, `q:<queue>:state:`. */
    base: string;
    /** The name prefix to match literally; `""` for every name. */
    prefix: string;
    /** List only names after this one, when given. */
    after?: string;
    /** The most names to return; a positive integer. */
    limit: number;
  },
): string {
  const collate = dialect.codePointCollation
    ? ` COLLATE ${dialect.codePointCollation}`
    : "";
  const key = `kv_key${collate}`;
  const param = (value: string) => `${bind(value)}${collate}`;
  const low = options.base + options.prefix;

  // Built in the order the clauses appear in the statement: MySQL's `?`
  // placeholders are positional, so a value bound out of text order would land
  // on another clause's placeholder. Postgres's numbered `$n` hide that.
  const where = [
    `ns = ${bind(options.ns)}`,
    `${key} >= ${param(low)}`,
    `${key} < ${param(prefixSuccessor(low))}`,
  ];
  if (options.after !== undefined) {
    where.push(`${key} > ${param(options.base + options.after)}`);
  }

  return `SELECT kv_key FROM ${table}
        WHERE ${where.join(" AND ")}
        ORDER BY ${key}
        LIMIT ${Math.floor(options.limit)}`;
}

/**
 * The `ORDER BY` of `sort: "createdAt"`: `created_at`, then the id in
 * code-point order, both ascending or both descending — `desc` reverses the
 * tie-break too, as `compareCreated` in `added.ts` defines it.
 *
 * The id is compared in code point order whatever the column's collation, so
 * `tie-B` comes before `tie-a`:
 *
 * - **Postgres** declares ids in the database's collation, which in
 *   `en_US.utf8` puts `a` before `B`; `COLLATE "C"` is byte order, which for
 *   UTF-8 is code-point order.
 * - **MySQL and MariaDB** declare ids in a binary collation today
 *   ({@link SqlDialect.idType}), but a table created before that keeps a case-
 *   insensitive one until a sync with `alterColumns` rewrites it. Comparing
 *   the bytes (`CAST(id AS BINARY)`) is right under either, and under any
 *   character set whose bytes sort as its code points do (utf8mb4, utf8mb3).
 * - **SQLite**'s default `BINARY` collation already is code-point order.
 *
 * No index serves this order (the claim index has `priority` ahead of
 * `created_at`), so a page is a top-N sort over the matching rows, and the
 * expression on `id` costs no index use.
 *
 * Exported so a test can `EXPLAIN` exactly what the driver runs.
 */
export function createdAtOrder(
  dialect: SqlDialect,
  order: "asc" | "desc",
): string {
  const direction = order === "desc" ? "DESC" : "ASC";
  const id = dialect.codePointCollation
    ? `id COLLATE ${dialect.codePointCollation}`
    : dialect.name === "mysql" || dialect.name === "mariadb"
      ? "CAST(id AS BINARY)"
      : "id";

  return `created_at ${direction}, ${id} ${direction}`;
}

/**
 * The statement counting a namespace's jobs added in `[from, to)` by queue and
 * state — or one queue's, when `queue` is given: what `countAddedJobs` runs.
 *
 * Every column it reads is in the claim index `(ns, queue, state, priority,
 * created_at[, id])`, so it can be answered from that index alone: a covering
 * scan of the `ns` (or `ns, queue`) prefix with `created_at` as a filter, the
 * same work as the `countJobsByQueue` the overview already runs. Two engines
 * need steering there, each measured on 200,000 jobs:
 *
 * - **MySQL** (8.4) costs a lookup of `ix_..._due` — which lacks `created_at`,
 *   so it reads every row — below the covering scan, and took 440ms where the
 *   claim index takes 60ms. An optimizer hint names the claim index
 *   ({@link claimIndexName}). A hint, not `FORCE INDEX`: one naming an index
 *   that is not there is ignored with a warning rather than failing the
 *   statement. MariaDB picks the claim index unaided and gets no hint.
 * - **SQLite** otherwise skip-scans the claim index for the `created_at`
 *   range, or with a queue named reads `ix_..._due` and every row: fast for a
 *   narrow range, 4x slower than the plain covering scan for a day's. `+`
 *   keeps `created_at` out of the index search, so the cost is the prefix's
 *   size whatever the range — 20ms for a day's range over the namespace
 *   against 85ms, 15ms for one queue against 47ms, 11ms for an hour's against
 *   2ms.
 *
 * Postgres plans an index-only scan of the claim index once `ns` narrows the
 * table, and a sequential scan when one namespace is most of it, as it does for
 * the overview's count.
 *
 * Exported so a test can `EXPLAIN` exactly what the driver runs.
 */
export function countAddedStatement(
  dialect: SqlDialect,
  table: string,
  bind: (value: unknown) => string,
  options: {
    /** The namespace. */
    ns: string;
    /** Only this queue, when given; every queue of the namespace otherwise. */
    queue?: string;
    /** The range's start, epoch ms, inclusive. */
    from: number;
    /** The range's end, epoch ms, exclusive. */
    to: number;
  },
): string {
  const created = dialect.name === "sqlite" ? "+created_at" : "created_at";
  const hint =
    dialect.name === "mysql"
      ? ` /*+ INDEX(added ${claimIndexName(table)}) */`
      : "";

  // Bound in text order: MySQL's `?` placeholders are positional.
  const where = [
    `ns = ${bind(options.ns)}`,
    ...(options.queue === undefined ? [] : [`queue = ${bind(options.queue)}`]),
    `${created} >= ${bind(options.from)}`,
    `${created} < ${bind(options.to)}`,
  ];

  return `SELECT${hint} queue, state, COUNT(*) AS total FROM ${table} added
        WHERE ${where.join(" AND ")}
        GROUP BY queue, state`;
}

/**
 * One page of the pending-options rewrite's walk: at most `limit` jobs of
 * `state` in claim order, `(priority, created_at, id)`, after `after` when
 * given — a range on the claim index `(ns, queue, state, priority,
 * created_at[, id])` on every engine.
 *
 * - **Postgres**: an index scan on the claim index bounded by the two-column
 *   row comparison, then an incremental sort on `id` within each
 *   `(priority, created_at)` group — `id` is not in the index there — and
 *   `LockRows` under the `LIMIT`, so a row that left the state while it was
 *   waited on is dropped and the next one read.
 * - **MySQL / MariaDB**: pinned to the claim index with
 *   {@link SqlDialect.indexHint} (`hinted`), which keeps each page a `range`
 *   rather than a `ref` over the whole state; the claim index names `id` on
 *   MySQL, and MariaDB reads it from the primary-key suffix, so neither sorts.
 * - **SQLite**: a search on the claim index with the row-value bound, and a
 *   sort of only the last `ORDER BY` term within each group.
 *
 * `lock` appends `FOR UPDATE` (never on SQLite, whose transaction is the
 * lock, nor on a dry run). Exported so a test can `EXPLAIN` exactly what the
 * driver runs.
 */
export function rewritePageStatement(
  dialect: SqlDialect,
  table: string,
  bind: (value: unknown) => string,
  options: {
    /** The namespace. */
    ns: string;
    /** The queue. */
    queue: string;
    /** The state being walked. */
    state: JobState;
    /** The claim-order key of the last job already examined, or `null` to start. */
    after: ClaimCursor | null;
    /** Most rows to read. */
    limit: number;
    /** Whether to lock the rows read (`FOR UPDATE`). */
    lock: boolean;
    /** Whether to pin the read to the claim index where the engine takes a hint. */
    hinted: boolean;
  },
): string {
  // Bound in text order: MySQL's and SQLite's `?` placeholders are positional.
  return `SELECT id, priority, created_at, max_attempts, attempts_made, opts
       FROM ${table}${options.hinted ? dialect.indexHint(claimIndexName(table)) : ""}
      WHERE ns = ${bind(options.ns)} AND queue = ${bind(options.queue)}
        AND state = ${bind(options.state)}${
          options.after
            ? `
        AND ${dialect.claimOrderAfter(bind, options.after)}`
            : ""
        }
      ORDER BY priority ASC, created_at ASC, id ASC
      LIMIT ${Math.max(0, Math.floor(options.limit))}${options.lock ? " FOR UPDATE" : ""}`;
}

/**
 * Whether an error is Bun's MySQL client refusing to fetch the server's RSA
 * key: MySQL 8's `caching_sha2_password` asked for it over a connection
 * without TLS, and `allowPublicKeyRetrieval` was not set. Read through the
 * `cause` chain, since it may arrive wrapped.
 */
function isPublicKeyRetrievalRefusal(error: unknown): boolean {
  for (let at = error, depth = 0; at != null && depth < 5; depth++) {
    if (typeof at !== "object") {
      break;
    }
    if (
      (at as { code?: unknown }).code ===
      "ERR_MYSQL_PUBLIC_KEY_RETRIEVAL_NOT_ALLOWED"
    ) {
      return true;
    }
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Whether an error is the engine saying the `log_key` column does not exist.
 *
 * Each engine words it differently — Postgres "column … does not exist",
 * MySQL and MariaDB "Unknown column", SQLite "no such column" — and the
 * engine's error sits one or more `cause` links below the driver's wrapper,
 * so the whole chain is read.
 */
function isMissingLogKey(error: unknown): boolean {
  return isMissingColumn(error, "log_key");
}

/**
 * Whether an error is the engine saying `column` does not exist on a table.
 *
 * Postgres says "column … does not exist", MySQL and MariaDB "Unknown column",
 * and SQLite "no such column" on a read but "has no column named" on an
 * insert. The engine's error sits one or more `cause` links below the
 * driver's wrapper, so the whole chain is read.
 */
/**
 * One `run_logs` row as the contract's line.
 *
 * `line_no` becomes `seq`: the run's own numbering is what the contract
 * exposes, and the table's `seq` is insertion order the caller never sees.
 * The optional fields are rebuilt as *absent* rather than null or false, so a
 * line reads back identically here and on the backends that simply store
 * nothing for them.
 */
function toRunLogLine(row: Record<string, unknown>): RunLogLine {
  const level = row.level == null ? undefined : (String(row.level) as LogLevel);

  return {
    seq: Number(row.line_no),
    stream: String(row.stream) as RunLogStream,
    at: Number(row.at),
    text: String(row.message),
    ...(level === undefined ? {} : { level }),
    ...(Number(row.truncated) === 1 ? { truncated: true as const } : {}),
  };
}

function isMissingColumn(error: unknown, column: string): boolean {
  const named = new RegExp(`\\b${column}\\b`);

  for (let at = error, depth = 0; at != null && depth < 5; depth++) {
    if (typeof at !== "object") {
      break;
    }

    const message = String((at as { message?: unknown }).message ?? "");

    if (
      named.test(message) &&
      /does not exist|unknown column|no such column|has no column named/i.test(
        message,
      )
    ) {
      return true;
    }

    at = (at as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * How long a table seen without the `flow` column is trusted to still lack
 * it. Another process may sync the schema; after this, a read asks again.
 */
const FLOW_COLUMN_RECHECK_MS = 60_000;

/**
 * The most jobs one count-retention sweep removes. Past it, the next sweep
 * takes the rest; {@link RETENTION_MAX_STRIDE} keeps that from falling behind.
 */
const RETENTION_SWEEP_LIMIT = 1000;

/**
 * The share of a retention `count` that may pile up before a settle sweeps
 * again: a tenth, so `removeOnComplete: 1000` keeps at most 1,099 per process.
 */
const RETENTION_SLACK = 0.1;

/**
 * The most settles between count sweeps, whatever the `count`. Half of
 * {@link RETENTION_SWEEP_LIMIT}, so one sweep always clears what built up.
 */
const RETENTION_MAX_STRIDE = RETENTION_SWEEP_LIMIT / 2;

/**
 * The most pages one sweep reads past flow children it has to keep. A page of
 * nothing but held children is rare — they wait on a parent that records
 * them within moments — so this only bounds a pathological queue.
 */
const SWEEP_MAX_PAGES = 8;

/**
 * Rows one event poll reads per channel it follows — what each subscription's
 * own poll read before they shared one — up to {@link EVENT_FEED_MAX_PAGE}.
 */
const EVENT_PAGE_PER_CHANNEL = 200;

/** The most rows one namespace's event poll reads at once. */
const EVENT_FEED_MAX_PAGE = 1000;

/** One subscription on a namespace's event feed (`SqlDriver.subscribe`). */
interface EventFeedListener {
  /** Hands the subscriber one event. */
  readonly deliver: (event: DriverEvent) => void;
  /** The sequence it starts after: its channel's latest when it subscribed. */
  readonly after: number;
}

/** One namespace's shared event poll, and who it delivers to. */
interface EventFeed {
  /** What the poll has read and passed over, across all its channels. */
  readonly gaps: EventGaps;
  /** Listeners by channel. A channel goes when its last listener does. */
  readonly channels: Map<string, Set<EventFeedListener>>;
  /** The poll's timer, cleared when the last channel goes. */
  readonly timer: ReturnType<typeof setInterval>;
  /** Whether a poll is running, so ticks do not pile up behind a slow one. */
  polling: boolean;
}

/**
 * How long a table seen without the attribution stamp's columns
 * (`processed_by_id`, `_key`, `_host`, `_pid`) is trusted to still lack them.
 * The same reasoning, and the same minute, as {@link FLOW_COLUMN_RECHECK_MS}.
 */
const STAMP_COLUMNS_RECHECK_MS = 60_000;

/**
 * Whether an error is the engine saying one of the attribution stamp's
 * columns does not exist — a table from before attribution, not yet synced.
 */
function isMissingStampColumn(error: unknown): boolean {
  return STAMP_COLUMNS.some((column) => isMissingColumn(error, column));
}

/** Whether a record carries an attribution stamp, and so needs its columns. */
function carriesStamp(job: JobRecord): boolean {
  return job.processedBy != null;
}

/**
 * How many counter rows a Postgres driver spreads its counted statements over.
 *
 * Statements a driver has in flight at once — one worker's completions and its
 * failures run side by side — each take the next row in turn, so they share a
 * row only when more than this many are in flight, and then wait only for the
 * other's commit. The cost is up to this many rows per process, per queue, per
 * minute.
 */
const METRICS_SHARDS = 8;

/**
 * Dialects whose id columns are bounded, and by how many characters.
 *
 * Postgres and SQLite store ids as `TEXT` and need no guard. MySQL and MariaDB
 * use `VARCHAR(191)` — itself the widest a `utf8mb4` id can be while the
 * composite claim index stays inside InnoDB's 3,072-byte key limit.
 */
const BOUNDED_ID_LENGTH: Partial<Record<SqlAdapter, number>> = {
  mysql: 191,
  mariadb: 191,
};

/**
 * How many runs one `keepRuns` eviction may drop the logs of.
 *
 * `LIMIT` is there only because `OFFSET` needs one — every engine here refuses
 * an offset without it. Eviction runs on every append, so in practice it finds
 * one run to drop, or none; the bound is generous enough that it never becomes
 * the reason a log survived.
 */
const MAX_EVICTED_RUN_LOGS = 1000;

/** The tables this driver uses. */
export const SQL_TABLES = [
  "jobs",
  "locks",
  "kv",
  "events",
  "logs",
  "run_logs",
  "workers",
  "metrics",
  "queue_metrics",
  "worker_metrics",
  "runner_metrics",
] as const;

/**
 * The three analytics tables, in the order a sweep visits them.
 *
 * All-lowercase names, like `run_logs` and for the same reason: `resolveNames`
 * turns a key into a table name, Postgres folds an unquoted mixed-case
 * identifier to lowercase, and `describeIndexes` would then match nothing —
 * so the sync would propose creating this table's indexes on every run,
 * forever.
 */
const ANALYTICS_TABLES = [
  "queue_metrics",
  "worker_metrics",
  "runner_metrics",
] as const satisfies readonly SqlTable[];

/**
 * How many analytics rows go into one upsert.
 *
 * The point of a batch here is the statement *rate*: every engine but
 * Postgres buffers every count, and one statement per row would be two per
 * entity per second. The widest of these rows is `runner_metrics` at 39
 * columns, so 200 rows is 7,800 parameters — inside every engine's limit,
 * SQLite's 32,766 included.
 */
const METRIC_CHUNK = 200;

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
 *
 * The namespace roll-up keeps `NAMESPACE_ENTITY` — the empty name — unchanged,
 * so it is an entity like any other and nothing downstream needs a second
 * code path.
 */
function workerEntity(q: QueueRef, key: string): string {
  return workerMetricsEntity(q.queue, key);
}

/**
 * How many entity names one batch read binds into its `IN (...)` at most.
 *
 * The route caps a batch at `MAX_ANALYTICS_SERIES` (20), so in practice a
 * batch is one statement; this is the driver's own bound, so a direct caller
 * naming thousands still stays inside every engine's parameter limit.
 */
const METRIC_READ_CHUNK = 500;

/** The range a metrics read covers, already cut to what the driver holds. */
interface MetricReadRange {
  /** The first bucket's start, epoch ms. */
  from: number;
  /** The last bucket's start, epoch ms. */
  to: number;
  /** The bucket width, ms. */
  interval: number;
}

/**
 * Stored counter rows as sparse buckets, oldest first — the one reading of a
 * counter row, shared by the per-entity and the batch reads so the two cannot
 * disagree.
 */
function counterBucketsOf<K extends string>(
  /** Rows carrying `bucket` and each counter column. */
  rows: readonly Record<string, unknown>[],
  /** The buckets wanted. */
  range: MetricReadRange,
  /** The counter columns. */
  keys: readonly K[],
): CounterBucket<Record<K, number>>[] {
  return mergeCounterBuckets(
    rows.map((row) => {
      const bucket: Record<string, number> = { at: Number(row.bucket) };
      for (const key of keys) {
        bucket[key] = Number(row[key]) || 0;
      }
      return bucket as { at: number } & Record<K, number>;
    }),
    range,
    keys,
  );
}

/** Stored duration rows as sparse buckets, histogram included. */
function durationBucketsOf(
  /** Rows carrying `bucket`, the duration statistics and the 25 bins. */
  rows: readonly Record<string, unknown>[],
  /** The buckets wanted. */
  range: MetricReadRange,
): RawDurationBucket[] {
  return mergeDurationBuckets(
    rows.map((row) => ({
      at: Number(row.bucket),
      ...durationStatsOf(row),
    })),
    range,
  );
}

/**
 * One row's duration statistics, whether a stored bucket or a grouped sum.
 *
 * Every figure through `Number`: Postgres answers a `SUM` over integers as
 * `numeric`, which arrives as a string — and `"3" + "4"` is `"34"`.
 */
function durationStatsOf(row: Record<string, unknown>): DurationStats {
  return {
    count: Number(row.dur_count) || 0,
    sumMs: Number(row.dur_sum_ms) || 0,
    minMs: Number(row.dur_min_ms) || 0,
    maxMs: Number(row.dur_max_ms) || 0,
    // Read back in `durationBin`'s own order: `h07` is `histogram[7]`.
    histogram: DURATION_BIN_COLUMNS.map((column) => Number(row[column]) || 0),
  };
}

/** Stored busyness rows as sparse buckets. */
function busynessBucketsOf(
  /** Rows carrying `bucket` and the busyness columns. */
  rows: readonly Record<string, unknown>[],
  /** The buckets wanted. */
  range: MetricReadRange,
): RawBusynessBucket[] {
  return mergeBusynessBuckets(
    rows.map((row) => ({ at: Number(row.bucket), ...busynessStatsOf(row) })),
    range,
  );
}

/** One row's busyness statistics, whether a stored bucket or a grouped sum. */
function busynessStatsOf(row: Record<string, unknown>): BusynessStats {
  return {
    samples: Number(row.samples) || 0,
    activeSum: Number(row.active_sum) || 0,
    activeMax: Number(row.active_max) || 0,
    concurrency: Number(row.concurrency) || 0,
    lastAt: Number(row.last_at) || 0,
  };
}

/** Rows grouped by their `entity` column, each group in the order it came. */
function rowsByEntity(
  rows: readonly Record<string, unknown>[],
): Map<string, Record<string, unknown>[]> {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const entity = String(row.entity);
    let group = grouped.get(entity);
    if (!group) {
      group = [];
      grouped.set(entity, group);
    }
    group.push(row);
  }
  return grouped;
}

/** One writer's duration statistics for a bucket, waiting to be written. */
interface PendingDuration {
  /** The namespace. */
  ns: string;
  /** The runner key. */
  entity: string;
  /** The bucket's start, epoch ms. */
  at: number;
  /** The bucket's width, ms. */
  interval: number;
  /** What was measured, merged in memory before it is written. */
  stats: DurationStats;
}

/** One worker's busyness samples for a bucket, waiting to be written. */
interface PendingBusyness {
  /** The namespace. */
  ns: string;
  /** The worker's series, as {@link workerEntity} spells it. */
  entity: string;
  /** The bucket's start, epoch ms. */
  at: number;
  /** The bucket's width, ms. */
  interval: number;
  /** What was sampled, merged in memory before it is written. */
  stats: BusynessStats;
}

/** One of the tables this driver uses. */
export type SqlTable = (typeof SQL_TABLES)[number];

/** Options for {@link SqlDriver}. */
export interface SqlDriverOptions extends ConnectionInput {
  /**
   * A connection string. Its scheme picks the engine unless `adapter` says
   * otherwise, and it wins over `connection` when both are given.
   */
  url?: string;
  /**
   * The connection as fields, for when a URL is not what you have. The engine
   * then comes from `adapter`, which is required.
   */
  connection?: ConnectionOptions;
  /** Overrides the engine detected from the URL. */
  adapter?: SqlAdapter;
  /**
   * What to record into the analytics tables, and for how long. Everything,
   * at one-second resolution, by default.
   *
   * Recording is what costs here, not reading: per-second bucketing is
   * O(entities), not O(jobs), so it is the retention and the fleet size that
   * decide the bill. `workers: false` is the first lever to pull on a large
   * one, and `resolution: "minute"` turns the per-second buckets off
   * altogether.
   */
  metrics?: MetricsOptions;
  /**
   * Announce new jobs over Postgres `LISTEN`/`NOTIFY` as well as polling.
   *
   * On by default where the engine supports it. Set `false` to poll only —
   * worth doing if the extra listening connection is unwelcome, or through a
   * pooler that cannot pin a session.
   */
  notify?: boolean;
  /**
   * Bring an existing database in line with the schema this version expects,
   * on connect.
   *
   * Off by default. `createSchema` is all `IF NOT EXISTS`, so a table created
   * by an earlier version keeps its original shape forever — which means the
   * schema improvements that come with an upgrade reach new installs only.
   * This is how an existing deployment gets them.
   *
   * `true` does everything that cannot stall a running queue: adds columns and
   * indexes that are missing, drops indexes this driver no longer defines, and
   * rebuilds one whose predicate has changed. On Postgres the index work is
   * `CONCURRENTLY`, so writes continue throughout.
   *
   * **Changing a column's type is not included**, because it rewrites the
   * table under a lock that blocks every reader and writer until it finishes.
   * Ask for it by name, in a window where that is acceptable:
   *
   * ```ts
   * new SqlDriver({ url, syncSchema: { alterColumns: true } })
   * ```
   *
   * {@link SqlDriver.syncSchema} is the same thing as a method, including a
   * `dryRun` that reports what would change and applies none of it.
   */
  syncSchema?: boolean | SchemaSyncOptions;
  /**
   * Prepended to every table name. Defaults to `bun_jobs_`, which keeps this
   * driver's tables together in a database it shares with an application.
   */
  tablePrefix?: string;
  /**
   * Exact table names, for an existing schema that was not named here. Given
   * as-is, so a name set this way ignores `tablePrefix`.
   */
  tables?: Partial<Record<SqlTable, string>>;
  /** An already-open `Bun.SQL`, when the application has one to share. */
  sql?: SQL;
  /** How often a wait re-checks for work. Defaults to 50ms. */
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

/** Default port per engine, for building a URL from connection fields. */
const DEFAULT_PORTS: Record<SqlAdapter, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  sqlite: 0,
};

export class SqlDriver implements JobsDriver {
  /** Identifies the implementation in errors and capability checks. */
  readonly name = "sql";
  /** Decides when this driver should prune its stored events. */
  readonly #eventRetention: EventRetention;

  /** Which engine this instance talks to. */
  readonly adapter: SqlAdapter;
  /** What that engine does its own way. */
  readonly dialect: SqlDialect;

  /**
   * A server database is reachable from anywhere, and its concurrency control
   * is what makes claiming safe. Waiting is polled: `LISTEN/NOTIFY` exists on
   * Postgres but not the others, so the contract stays the same everywhere.
   *
   * `multiHost` is the one that varies by engine, and SQLite is the exception:
   * it is a file, so processes on the same machine can share it but another
   * host cannot. Assigned in the constructor rather than here, because a class
   * field initialiser runs *before* the constructor body and would read
   * {@link SqlDriver.adapter} as `undefined`.
   */
  readonly capabilities: DriverCapabilities;

  /**
   * The resolved table names, one per entry of `SQL_TABLES`.
   *
   * Also typed as every name the schema reads, which is the compile-time half
   * of the guard in `schemaDefinition`: a key added to `SchemaTableNames` but
   * not to `SQL_TABLES` makes the `resolveNames` assignment in the constructor
   * a type error, instead of a table created as `undefined`.
   */
  readonly #tables: Record<SqlTable, string> & Required<SchemaTableNames>;

  /** The connection. */
  readonly #sql: SQL;
  /** Whether this driver opened the connection and must close it. */
  readonly #ownsConnection: boolean;
  /** How often a wait re-checks. */
  readonly #poll: number;
  /** Resolves once the schema exists. */
  #ready: Promise<void> | undefined;
  /** Whether new jobs are announced as well as polled for. */
  readonly #notify: boolean;
  /** What to reconcile on connect, if anything. */
  readonly #syncOnConnect: boolean | SchemaSyncOptions;
  /** Arrival notifications, where the engine can push them. */
  readonly #arrivals: Arrivals;
  /** Rows written since the planner's statistics were last refreshed. */
  #writtenSinceAnalyze = 0;
  /** Rows that must be written before the next refresh; grows with the table. */
  #analyzeThreshold = ANALYZE_MIN_ROWS;
  /** Whether the threshold has been sized against the real table yet. */
  #thresholdMeasured = false;
  /** The refresh currently running, so only one runs and `close` can wait. */
  #analyzing: Promise<void> | undefined;
  /** Pause flags, so a claim does not read one per call. */
  readonly #pauseCache = new PauseCache();
  /** Active event subscriptions, so `close()` can stop them. */
  readonly #subscriptions = new Set<() => void>();
  /** Each namespace's shared event poll, while it has a subscriber. */
  readonly #eventFeeds = new Map<string, EventFeed>();
  /**
   * Where the orphaned-log sweep has got to in each queue, keyed by
   * `ns` and `queue`.
   *
   * `after` is the last line looked at, or absent at the start of a pass;
   * `notBefore` is when the next page may run, which is only in the future
   * once a pass has finished. In memory, so a restart simply starts a pass
   * over — the sweep is idempotent.
   */
  readonly #logSweeps = new Map<
    string,
    { after?: { logKey: string; seq: string }; notBefore: number }
  >();

  /**
   * Where claims that skip names have got to, keyed by `ns`, `queue` and the
   * sorted names skipped.
   *
   * `after` is the last row of the last full window a claim passed over, and
   * `usedAt` when a claim last read it, for {@link CLAIM_CURSOR_IDLE_MS}. In
   * memory and per driver: another process keeps its own, and a restart starts
   * again from the head, which is only slower.
   */
  readonly #claimCursors = new Map<
    string,
    { after: ClaimCursor; usedAt: number }
  >();

  /** When {@link SqlDriver.#claimCursors} was last swept for idle entries. */
  #claimCursorsSweptAt = 0;

  /**
   * Throughput counted in memory and written once a second: completions and
   * failures on every engine but Postgres, which counts those inside the
   * statement, and burials by the stalled sweep or by a failed child on every
   * engine, since those run in maintenance rather than per job. Made on first
   * use, so a driver that never counts anything never has one.
   */
  #throughputBuffer: ThroughputBuffer | undefined;

  /**
   * Who this driver's throughput rows belong to, so two processes writing the
   * same minute never contend for one row.
   */
  readonly #metricsShard = newId();

  /**
   * The counter rows Postgres statements take in turn: {@link METRICS_SHARDS}
   * of them, this driver's shard with an index each. See
   * {@link SqlDriver.#countedStatement} for why a set rather than one row.
   */
  readonly #metricsShards = Array.from(
    { length: METRICS_SHARDS },
    (_, index) => `${this.#metricsShard}:${index}`,
  );

  /** Which of {@link SqlDriver.#metricsShards} the next counted statement takes. */
  #nextMetricsShard = 0;

  /**
   * The latest minute each queue's old throughput was pruned for, keyed by
   * `ns` and `queue`, so the retention delete runs once a minute per queue
   * rather than once per job.
   */
  readonly #metricsPrunedFor = new Map<string, number>();

  /** Retention deletes still in flight, awaited by reads and by `close()`. */
  readonly #metricsPrunes = new Set<Promise<void>>();

  /** What is recorded into the analytics tables, and for how long. */
  readonly #analytics: ResolvedMetricsOptions;

  /**
   * When the analytics tables were last swept. Once a minute per process,
   * whatever the write rate — the sweep is a delete per table per width, so
   * paying it per count would be paying it thousands of times a second.
   */
  readonly #analyticsPrune = new MetricsPruneClock();

  /**
   * The namespaces this instance has written analytics for, which is what the
   * sweep covers.
   *
   * By range over a namespace and never per entity: a worker that stopped
   * reporting writes nothing, so a prune driven by an entity's own writes
   * never reaches its buckets — §9.13's whole point. Scoped to a namespace
   * rather than the whole table because these tables are shared: one
   * deployment's sweep has no business deleting another's rows, and the
   * contract suite deliberately drives the clock from a bucket in the future.
   */
  readonly #analyticsNamespaces = new Set<string>();

  /** A queue's completions and failures, counted once a second. */
  readonly #queueJobs: MetricsBuffer<JobCounters>;

  /** What each worker finished itself, counted once a second. */
  readonly #workerJobs: MetricsBuffer<JobCounters>;

  /** How busy each worker's heartbeats said it was, written once a second. */
  readonly #workerBusyness: PendingBuffer<PendingBusyness>;

  /** How each runner's runs ended, counted once a second. */
  readonly #runnerRuns: MetricsBuffer<RunnerRunCounters>;

  /** How long each runner's runs took, written once a second. */
  readonly #runnerDurations: PendingBuffer<PendingDuration>;

  /**
   * Whether the `jobs` table was last seen without its `log_key` column — an
   * install from before job logs that has not been synced.
   *
   * Lets removal and maintenance skip log housekeeping without sending a
   * statement that is known to fail. Cleared by a sync, and by any log call
   * that succeeds, since another process may have run the sync.
   */
  #logKeyMissing = false;

  /**
   * When the `jobs` table was last seen without its `flow` column, or
   * `undefined` when it was not. Retention and retry read `flow` to leave an
   * unrecorded flow child alone; on a table that predates flows no job can be
   * in one, so they fall back to statements that do not name the column
   * rather than failing. Cleared by a sync, and trusted for
   * {@link FLOW_COLUMN_RECHECK_MS}, since another process may sync.
   */
  #flowMissingAt: number | undefined;
  /**
   * Settles since the last count-retention sweep, per queue and state, in this
   * process: what spaces those sweeps out (`#retentionDue`).
   */
  readonly #retentionSettles = new Map<string, number>();
  /**
   * Whether the pending-options rewrite found the claim index missing when it
   * named it in an index hint (MySQL and MariaDB's `FORCE INDEX`), and so
   * walks unhinted from then on. `false` until that happens; never set on an
   * engine without hints.
   */
  #claimIndexMissing = false;

  /**
   * When the `jobs` table was last seen without the attribution stamp's
   * columns, or `undefined` when it was not. The claim stamps a worker's key,
   * host and pid there; on a table that predates them it falls back to the
   * statement without them rather than failing every claim, and so does an
   * insert of a stamped record. Cleared by a sync, and trusted for
   * {@link STAMP_COLUMNS_RECHECK_MS}, since another process may sync.
   */
  #stampMissingAt: number | undefined;

  /**
   * Whether the `jobs` table was last seen *with* the stamp's columns — by the
   * probe connect runs, a sync's re-probe, or a stamped claim or insert that
   * succeeded. `false` until one has, so `capabilities.jobAttribution` reads
   * `false` before connect: unknown is not "yes".
   */
  #stampConfirmed = false;

  /**
   * Bumped by every sync, so a probe that started before it cannot record an
   * answer about the table as it was: only a probe of the current epoch
   * writes {@link SqlDriver.#stampConfirmed} and
   * {@link SqlDriver.#stampMissingAt}.
   */
  #stampEpoch = 0;

  /** A re-probe for the stamp's columns in flight, so reads never start two. */
  #stampProbe: Promise<void> | undefined;

  constructor(options: SqlDriverOptions) {
    // A URL names its engine; fields do not, so `adapter` is required there.
    if (!options.adapter && !options.url && options.connection) {
      throw new ConfigError(
        "A SQL connection given as fields needs an explicit adapter",
        { connection: Object.keys(options.connection) },
      );
    }

    this.adapter = options.adapter ?? detectAdapter(options.url);
    this.dialect = dialectFor(this.adapter);

    this.capabilities = {
      blockingWait: false,
      events: "poll",
      multiProcess: true,
      // SQLite is a local file; every other engine is reached over a socket.
      multiHost: this.adapter !== "sqlite",
    };
    // Live, not fixed: a jobs table from before attribution has no stamp
    // columns until a sync adds them, and until then no claim stamps and no
    // worker filter can be answered, so declaring it would promise what the
    // table cannot keep. Read on every access (`/meta` asks per request), and
    // `false` until connecting has confirmed the columns.
    Object.defineProperty(this.capabilities, "jobAttribution", {
      enumerable: true,
      get: () => this.#stampColumnsReady(),
    });

    this.#tables = resolveNames(SQL_TABLES, {
      prefix: options.tablePrefix,
      overrides: options.tables,
      defaultPrefix: "bun_jobs_",
    });

    this.#poll = options.pollInterval ?? POLL_MS;
    this.#ownsConnection = !options.sql;

    this.#sql = options.sql ?? this.#openClient(options);

    this.#notify = this.dialect.supportsListen && options.notify !== false;
    this.#syncOnConnect = options.syncSchema ?? false;
    this.#eventRetention = new EventRetention(options.eventRetentionMs);
    this.#arrivals = new Arrivals(this.#sql, this.#notify);

    // No `MetricsLimits`: a row per entity per second is what every engine
    // here is for, and §4a's shared row is what keeps it that cheap.
    this.#analytics = resolveMetricsOptions(options.metrics);
    const intervals = this.#analytics.intervals;

    this.#queueJobs = new MetricsBuffer<JobCounters>({
      keys: JOB_COUNTERS,
      intervals,
      write: async (batch) =>
        await this.#writeCounters("queue_metrics", batch, JOB_COUNTERS),
    });
    this.#workerJobs = new MetricsBuffer<JobCounters>({
      keys: JOB_COUNTERS,
      intervals,
      write: async (batch) =>
        await this.#writeCounters("worker_metrics", batch, JOB_COUNTERS),
    });
    this.#runnerRuns = new MetricsBuffer<RunnerRunCounters>({
      keys: RUNNER_RUN_COUNTERS,
      intervals,
      write: async (batch) =>
        await this.#writeCounters("runner_metrics", batch, RUNNER_RUN_COUNTERS),
    });

    // Durations and busyness have no namespace roll-up — nothing in
    // `NamespaceMetricsRead` carries them — so they ride the plain buffer
    // rather than `MetricsBuffer`, merged by the shared helpers.
    this.#runnerDurations = new PendingBuffer<PendingDuration>({
      key: (entry) =>
        `${entry.ns}\n${entry.entity}\n${entry.interval}\n${entry.at}`,
      merge: (into, from) => mergeDurationStats(into.stats, from.stats),
      ns: (entry) => entry.ns,
      write: async (batch) => await this.#writeDurations(batch),
    });
    this.#workerBusyness = new PendingBuffer<PendingBusyness>({
      key: (entry) =>
        `${entry.ns}\n${entry.entity}\n${entry.interval}\n${entry.at}`,
      merge: (into, from) => mergeBusynessStats(into.stats, from.stats),
      ns: (entry) => entry.ns,
      write: async (batch) => await this.#writeBusyness(batch),
    });
  }

  /**
   * Opens the client this driver owns.
   *
   * On MySQL and MariaDB, `allowPublicKeyRetrieval` comes from the URL's query
   * parameter or, for a connection given as fields, from that field — the URL
   * wins, as it does for everything else. Bun's client ignores the parameter
   * in a URL, so it is taken out and passed as the client option it has to be.
   * Every other parameter, `ssl`/`tls`/`sslmode` included, stays in the URL for
   * the client to read.
   */
  #openClient(options: SqlDriverOptions): SQL {
    const resolved = resolveConnectionUrl(
      options,
      this.#urlDefaults(),
      "The SQL driver",
    );

    if (this.adapter !== "mysql" && this.adapter !== "mariadb") {
      return new BunSQL({ url: resolved });
    }

    const { url, value } = takeBooleanParam(
      resolved,
      "allowPublicKeyRetrieval",
    );
    const allowPublicKeyRetrieval =
      value ??
      (options.url ? undefined : options.connection?.allowPublicKeyRetrieval);

    return new BunSQL({
      url,
      ...(allowPublicKeyRetrieval === undefined
        ? {}
        : { allowPublicKeyRetrieval }),
    });
  }

  /** How a connection given as fields becomes a URL for this engine. */
  #urlDefaults(): UrlDefaults {
    return {
      scheme: this.adapter,
      host: "127.0.0.1",
      port: DEFAULT_PORTS[this.adapter] || undefined,
    };
  }

  /* --- lifecycle ---------------------------------------------------- */

  async connect(): Promise<void> {
    // One migration per instance, shared by every concurrent caller.
    this.#ready ??= this.#migrate();
    await this.#ready;
  }

  async close(): Promise<void> {
    // A statistics refresh runs unawaited, so it can still be in flight here.
    // Letting it finish keeps it off a closing connection; it cannot fail the
    // close, because a failed refresh is already tolerated.
    await this.#analyzing?.catch(() => undefined);
    // Counts gathered since the last write, before the connection goes.
    await this.#throughputBuffer?.close();
    for (const buffer of this.#analyticsBuffers()) {
      await buffer.close().catch(() => undefined);
    }
    await Promise.allSettled([...this.#metricsPrunes]);
    await this.#arrivals.close();

    for (const stop of this.#subscriptions) {
      stop();
    }
    this.#subscriptions.clear();
    for (const feed of this.#eventFeeds.values()) {
      clearInterval(feed.timer);
    }
    this.#eventFeeds.clear();

    if (this.#ownsConnection) {
      await this.#sql.close();
    }
  }

  /**
   * Reconciles the database with the schema this version of the driver
   * expects, and reports every difference it found.
   *
   * Safe by default: adds missing columns and indexes, drops indexes this
   * driver no longer defines, and rebuilds one whose predicate has changed.
   * None of that can stall a running queue — on Postgres the index work is
   * `CONCURRENTLY`. Changing a column's type rewrites the table under a lock
   * that blocks everything, so it is reported but not applied unless
   * `alterColumns` says to.
   *
   * The returned list includes changes it declined to make, each carrying
   * `applied` and `blocking`, so a caller can see what a fuller sync would do:
   *
   * ```ts
   * const pending = await driver.syncSchema({ dryRun: true });
   * for (const change of pending) {
   *   console.log(change.blocking ? "needs a window" : "safe", change.reason);
   * }
   * ```
   *
   * Only ever touches indexes whose names this driver generates, so one added
   * by hand is never dropped.
   */
  async syncSchema(options: SchemaSyncOptions = {}): Promise<SchemaChange[]> {
    await this.connect();
    const changes = await this.#syncSchema(options);
    // The sync may have added the stamp's columns (or, dry, not): asked now,
    // so `capabilities.jobAttribution` answers for the table as it is.
    await this.#probeStampColumns();
    return changes;
  }

  /**
   * The sync itself, without connecting first.
   *
   * Separate from the public method because the migration calls it, and the
   * migration *is* what `connect()` awaits: connecting from in there would
   * wait on the promise it is running inside.
   */
  async #syncSchema(options: SchemaSyncOptions): Promise<SchemaChange[]> {
    // A sync may be what adds `log_key` or `flow`, so both are asked again.
    this.#logKeyMissing = false;
    this.#flowMissingAt = undefined;
    this.#stampMissingAt = undefined;
    // Unknown until asked again: connect's probe or the public method's.
    this.#stampConfirmed = false;
    this.#stampEpoch++;

    return await syncSqlSchema(
      {
        all: async (text, params) => await this.#all(text, params),
        run: async (text) => await this.#sql.unsafe(text),
      },
      this.dialect,
      schemaDefinition(this.#tables, this.dialect),
      resolveSyncOptions(options),
    );
  }

  async ping(): Promise<boolean> {
    try {
      await this.#sql.unsafe("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async purge(ns: string): Promise<void> {
    await this.connect();

    // Counts not yet written would otherwise bring the namespace back, and so
    // would a write already in flight landing after the deletes: forget what
    // is pending, then wait that write out.
    this.#throughputBuffer?.forget(ns);
    await this.#throughputBuffer?.flush().catch(() => undefined);
    for (const buffer of this.#analyticsBuffers()) {
      buffer.forget(ns);
      await buffer.flush().catch(() => undefined);
    }
    this.#analyticsNamespaces.delete(ns);
    await Promise.allSettled([...this.#metricsPrunes]);

    for (const table of Object.values(this.#tables)) {
      const { bind, values } = this.#binder();
      await this.#run(`DELETE FROM ${table} WHERE ns = ${bind(ns)}`, values);
    }
  }

  async listRunners(ns: string): Promise<string[]> {
    await this.connect();

    // A runner shows up as soon as it exists at all: it may have written
    // state, or it may only ever have taken its lock.
    const stateQuery = this.#binder();
    const lockQuery = this.#binder();

    const [state, locks] = await Promise.all([
      this.#all<{ kv_key: string }>(
        `SELECT kv_key FROM ${this.#tables.kv}
          WHERE ns = ${stateQuery.bind(ns)}
            AND kv_key LIKE ${stateQuery.bind("r:%:state")}`,
        stateQuery.values,
      ),
      this.#all<{ lock_key: string }>(
        `SELECT lock_key FROM ${this.#tables.locks}
          WHERE ns = ${lockQuery.bind(ns)}
            AND lock_key LIKE ${lockQuery.bind("r:%")}`,
        lockQuery.values,
      ),
    ]);

    const ids = new Set<string>();
    for (const row of state) {
      ids.add(row.kv_key.slice(2, -":state".length));
    }
    for (const row of locks) {
      ids.add(row.lock_key.slice(2));
    }

    return [...ids];
  }

  async listQueues(ns: string): Promise<string[]> {
    await this.connect();

    const jobsQuery = this.#binder();
    const metaQuery = this.#binder();

    const [jobs, meta] = await Promise.all([
      this.#all<{ queue: string }>(
        `SELECT DISTINCT queue FROM ${this.#tables.jobs}
          WHERE ns = ${jobsQuery.bind(ns)}`,
        jobsQuery.values,
      ),
      // Queue-state entries share the `q:` prefix, and one named `meta` (or
      // ending in `:meta`) would otherwise surface as a queue called
      // `<queue>:state`. The key alone cannot tell that apart from a queue
      // whose own name contains `:state:`; such a queue still appears through
      // its jobs, and only an empty one is hidden.
      this.#all<{ kv_key: string }>(
        `SELECT kv_key FROM ${this.#tables.kv}
          WHERE ns = ${metaQuery.bind(ns)} AND kv_key LIKE ${metaQuery.bind("q:%:meta")}
            AND kv_key NOT LIKE ${metaQuery.bind("q:%:state:%")}`,
        metaQuery.values,
      ),
    ]);

    const names = new Set(jobs.map((row) => row.queue));
    for (const row of meta) {
      names.add(row.kv_key.slice(2, -5));
    }

    return [...names];
  }

  /* --- runner: locks -------------------------------------------------- */

  async acquireLock(
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    await this.connect();
    const expiresAt = now + ttlMs;

    // Take it outright when nobody holds it.
    const inserted = await this.#runPoint(
      this.dialect.insertIgnore(this.#tables.locks, [
        "ns",
        "lock_key",
        "token",
        "expires_at",
      ]),
      [ns, key, token, expiresAt],
    );

    if (inserted > 0) {
      return true;
    }

    // Otherwise take it only if it is ours or has lapsed — one conditional
    // update, so two contenders cannot both succeed.
    // A holder re-acquiring to the expiry it already has changes nothing,
    // which MySQL and MariaDB count as 0 — see #updateMatched.
    const taken = await this.#updateMatched(
      this.#tables.locks,
      [
        { column: "token", value: token },
        { column: "expires_at", value: expiresAt },
      ],
      (bind) =>
        `ns = ${bind(ns)} AND lock_key = ${bind(key)}
         AND (expires_at <= ${bind(now)} OR token = ${bind(token)})`,
    );

    return taken > 0;
  }

  async renewLock(
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    await this.connect();

    // Renewed twice in one millisecond, the second writes what is there.
    const renewed = await this.#updateMatched(
      this.#tables.locks,
      [{ column: "expires_at", value: now + ttlMs }],
      (bind) =>
        `ns = ${bind(ns)} AND lock_key = ${bind(key)}
         AND token = ${bind(token)} AND expires_at > ${bind(now)}`,
    );

    return renewed > 0;
  }

  async releaseLock(ns: string, key: string, token: string): Promise<boolean> {
    await this.connect();

    const { bind, values } = this.#binder();
    const released = await this.#runPoint(
      `DELETE FROM ${this.#tables.locks}
        WHERE ns = ${bind(ns)} AND lock_key = ${bind(key)} AND token = ${bind(token)}`,
      values,
    );

    return released > 0;
  }

  async getLock(
    ns: string,
    key: string,
    now: number,
  ): Promise<LockInfo | null> {
    await this.connect();

    const { bind, values } = this.#binder();
    const row = await this.#one<{ token: string; expires_at: number }>(
      `SELECT token, expires_at FROM ${this.#tables.locks}
        WHERE ns = ${bind(ns)} AND lock_key = ${bind(key)}
          AND expires_at > ${bind(now)}`,
      values,
    );

    return row ? { token: row.token, expiresAt: Number(row.expires_at) } : null;
  }

  /* --- runner: state -------------------------------------------------- */

  async getState(ns: string, key: string): Promise<Record<string, string>> {
    return (await this.#readState(ns, key)).fields;
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
    const { history } = await this.#readState(ns, key);
    return limit && limit > 0 ? history.slice(0, limit) : history;
  }

  async clearHistory(ns: string, key: string): Promise<void> {
    await this.#mutateState(ns, key, (state) => {
      state.history = [];
    });
    // A run the history no longer names cannot be asked about, so its lines
    // would be rows nothing could ever reach or collect.
    await this.clearRunLogs(ns, key);
  }

  /**
   * Appends captured output to one run's log.
   *
   * Two statements, not one: the run's next line number is read, then the
   * batch goes in with the numbers computed from it. A single statement
   * computing `MAX(line_no) + 1` per row is not portable — MySQL will not read
   * the table an `INSERT` targets in its own subquery without a derived table,
   * and the derived table is materialised once, so every row of a batch would
   * get the same number.
   *
   * One writer per run, which is what makes the read-then-write safe: capture
   * lives in the process running the run and flushes on one timer.
   */
  async appendRunLog(
    ns: string,
    key: string,
    runId: string,
    lines: RunLogInput[],
    caps: RunLogCaps,
  ): Promise<RunLogAppendResult> {
    await this.connect();

    const table = this.#tables.run_logs;
    const bounds = await this.#runLogBounds(ns, key, runId);
    let seq = bounds.lastSeq;

    if (lines.length > 0) {
      const { bind, values } = this.#binder();
      const rows = lines.map((line) => {
        const truncated = line.truncated ? 1 : 0;
        return `(${bind(ns)}, ${bind(key)}, ${bind(runId)}, ${bind(++seq)}, ${bind(line.stream)}, ${bind(line.at)}, ${bind(runLogBytes(line.text))}, ${bind(line.level ?? null)}, ${bind(truncated)}, ${bind(line.text)})`;
      });

      await this.#run(
        `INSERT INTO ${table}
           (ns, runner_key, run_id, line_no, stream, at, bytes, level, truncated, message)
         VALUES ${rows.join(", ")}`,
        values,
      );
    }

    const dropped = await this.#trimRunLog(ns, key, runId, caps, seq);

    // `keepRuns` on the write path too, so nothing has to sweep.
    if (caps.keepRuns > 0) {
      await this.#evictRunLogs(ns, key, caps.keepRuns);
    }

    return {
      count: seq - dropped,
      dropped,
      lastSeq: seq,
    };
  }

  async getRunLog(
    ns: string,
    key: string,
    runId: string,
    opts: RunLogQuery,
  ): Promise<RunLogPage> {
    await this.connect();

    const { lastSeq, firstSeq } = await this.#runLogBounds(ns, key, runId);

    if (lastSeq === 0) {
      return emptyRunLog();
    }

    const totals = { dropped: firstSeq - 1, lastSeq };
    const limit = Math.max(0, Math.floor(opts.limit));

    /** The run's lines, narrowed by whichever filters the query set. */
    const where = (bind: (value: unknown) => string): string => {
      const clauses = [
        `ns = ${bind(ns)}`,
        `runner_key = ${bind(key)}`,
        `run_id = ${bind(runId)}`,
      ];

      if (opts.since !== undefined) {
        clauses.push(`line_no > ${bind(opts.since)}`);
      }
      if (opts.stream !== undefined) {
        clauses.push(`stream = ${bind(opts.stream)}`);
      }

      return clauses.join(" AND ");
    };

    const counted = this.#binder();
    const count = Number(
      (
        await this.#one<{ total: number | string }>(
          `SELECT COUNT(*) AS total FROM ${this.#tables.run_logs}
            WHERE ${where(counted.bind)}`,
          counted.values,
        )
      )?.total ?? 0,
    );

    if (limit === 0 || count === 0) {
      return { lines: [], count, ...totals };
    }

    const page = this.#binder();
    const rows = await this.#all<Record<string, unknown>>(
      `SELECT line_no, stream, at, level, truncated, message
         FROM ${this.#tables.run_logs}
        WHERE ${where(page.bind)}
        ORDER BY line_no ${opts.order === "desc" ? "DESC" : "ASC"}
        LIMIT ${page.bind(limit)} OFFSET ${page.bind(Math.max(0, Math.floor(opts.offset)))}`,
      page.values,
    );

    return { lines: rows.map((row) => toRunLogLine(row)), count, ...totals };
  }

  async clearRunLogs(ns: string, key: string, runId?: string): Promise<void> {
    await this.connect();

    const { bind, values } = this.#binder();
    await this.#run(
      `DELETE FROM ${this.#tables.run_logs}
        WHERE ns = ${bind(ns)} AND runner_key = ${bind(key)}${
          runId === undefined ? "" : ` AND run_id = ${bind(runId)}`
        }`,
      values,
    );
  }

  /**
   * Removes exactly the named runs: their history records and their log
   * lines, and nothing else of the runner's.
   *
   * The history lives in the runner's state document, so its part is one
   * locked read-modify-write through `#mutateState`, and the lifetime
   * counters, lock, queued triggers and the rest of the document are written
   * back as read. It is read first, as a pop does: a mutation creates the
   * runner's row, and removing from a runner nobody knows must not bring it
   * into being. The logs are one `DELETE … IN (…)` per chunk of names, and go
   * whether or not a record still names them.
   */
  async removeRuns(
    ns: string,
    key: string,
    runIds: readonly string[],
  ): Promise<number> {
    if (runIds.length === 0) {
      return 0;
    }

    await this.connect();

    const named = new Set(runIds);
    let removed = 0;

    // Only a shortcut: the decision is the filter inside the transaction.
    const { history } = await this.#readState(ns, key);
    if (history.some((entry) => named.has(entry.runId))) {
      await this.#mutateState(ns, key, (state) => {
        const before = state.history.length;
        state.history = state.history.filter(
          (entry) => !named.has(entry.runId),
        );
        removed = before - state.history.length;

        if (removed === 0) {
          return false;
        }
      });
    }

    const ids = [...named];
    for (let start = 0; start < ids.length; start += INSERT_CHUNK) {
      const chunk = ids.slice(start, start + INSERT_CHUNK);
      const { bind, values } = this.#binder();
      await this.#run(
        `DELETE FROM ${this.#tables.run_logs}
          WHERE ns = ${bind(ns)} AND runner_key = ${bind(key)}
            AND run_id IN (${chunk.map((runId) => bind(runId)).join(", ")})`,
        values,
      );
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
    // Read first: a mutation creates the runner's row, and asking an unknown
    // runner whether it has anything queued must not bring it into being.
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
    // A plain SELECT, the same on every dialect: nothing is taken, and an
    // unknown runner gets no row.
    return (await this.#readState(ns, key)).queued[0] ?? null;
  }

  async popQueuedTriggerIf(
    ns: string,
    key: string,
    expectedId: string,
  ): Promise<QueuedTrigger | null> {
    // Read first, as a pop does: a mutation creates the runner's row, and a
    // runner nobody pushed to must not come into being. This read is only a
    // shortcut — the decision is the re-check inside the transaction below.
    if ((await this.#readState(ns, key)).queued[0]?.id !== expectedId) {
      return null;
    }

    let trigger: QueuedTrigger | null = null;

    // The transaction every pop and push takes: `SELECT ... FOR UPDATE` on
    // Postgres, MySQL and MariaDB, `BEGIN IMMEDIATE` on SQLite. The row is
    // held from the read to the write, so the head checked is the head taken.
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

  /* --- queue: jobs ------------------------------------------------------ */

  async ensureQueue(q: QueueRef): Promise<void> {
    await this.connect();
    // Named first, so a name too wide for the columns is reported as the name
    // it is rather than as the `kv` key it would have made.
    this.#assertFits(q.ns, "namespace");
    this.#assertFits(q.queue, "queue name");
    // The schema is shared; a queue exists as soon as something references it.
    await this.#writeKv(q.ns, `q:${q.queue}:meta`, { paused: false }, false);
  }

  async addJob(
    q: QueueRef,
    job: JobRecord,
  ): Promise<{ job: JobRecord; added: boolean }> {
    await this.connect();

    // The `NOTIFY` rides inside the insert rather than following it, so a
    // producer pays nothing for a consumer that may not exist.
    // `flow` is named only for a job in one, and the stamp's columns only
    // for a record carrying a stamp, so everything else still inserts into a
    // table that predates them — see `FLOWLESS_JOB_COLUMNS`.
    const write = async (stamped: boolean) => {
      const columns = insertColumns(job.flow !== null, stamped);
      const plain = this.dialect.insertIgnore(this.#tables.jobs, [...columns]);
      const insert = this.#notify
        ? this.dialect.notifyingInsert(plain, this.#arrivals.channel(q))
        : plain;
      const row = this.#toRow(q, job, columns);
      return this.#notify
        ? (await this.#all<{ id: string }>(insert, row)).length
        : await this.#runPoint(insert, row);
    };
    const added = await this.#requireFlowColumn(
      job.flow !== null,
      async () =>
        await this.#withStampColumns(
          carriesStamp(job),
          async () => await write(true),
          async () => await write(false),
        ),
    );

    if (added > 0) {
      return { job: jsonClone(job), added: true };
    }

    const existing = await this.getJob(q, job.id);
    return { job: existing ?? jsonClone(job), added: false };
  }

  /**
   * Adds many jobs with one statement per chunk.
   *
   * The common case — every id new — costs a single round trip per chunk,
   * because an engine that can `RETURNING` tells us which rows it took, and one
   * that cannot is asked only whether it took all of them. Only a chunk that
   * actually collided pays for a second look.
   *
   * Per-id idempotency is unchanged: a duplicate is ignored, not overwritten,
   * and comes back with `added: false` and whatever is stored. Repeat
   * scheduling depends on exactly that.
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

    const results: { job: JobRecord; added: boolean }[] = [];

    for (let start = 0; start < jobs.length; start += INSERT_CHUNK) {
      const chunk = jobs.slice(start, start + INSERT_CHUNK);
      results.push(...(await this.#insertChunk(q, chunk)));
    }

    await this.#refreshStatistics(jobs.length);
    return results;
  }

  /**
   * Refreshes the planner's statistics once enough rows have been written.
   *
   * **Awaited, and it has to be.** Letting it run in the background instead
   * looks obviously better — the producer that crosses the threshold is not
   * the one that benefits, a claim is — but it measures worse, badly: drain
   * fell from 8,558/s to 5,527/s over three runs each. An `ANALYZE` running
   * alongside inserts that are still arriving samples a table in flight and
   * produces worse statistics than one run after them, and a claim planned
   * against those takes 25.9ms where a fresh one takes 0.668ms. Deferring the
   * wait to the claim path does not rescue it either (5,519/s): by then the
   * refresh has finished, and finished badly.
   *
   * So the writer waits. It costs enqueue about 9%, which is the cheaper side
   * of that trade by a wide margin, and {@link ANALYZE_SCALE_FACTOR} is what
   * keeps the cost per row written flat as the table grows.
   *
   * Best-effort in every other sense: one runs at a time, a failure costs a
   * slower plan rather than a lost job, and the counter resets either way so a
   * permanently failing `ANALYZE` cannot turn into a retry on every insert.
   */
  async #refreshStatistics(written: number): Promise<void> {
    this.#writtenSinceAnalyze += written;

    // Already running: let it finish and let the counter keep climbing, so a
    // burst of inserts cannot queue a refresh behind every chunk.
    if (this.#writtenSinceAnalyze < this.#analyzeThreshold || this.#analyzing) {
      return;
    }

    // The threshold starts at the floor, which is only right for a table that
    // starts empty. A driver attached to an existing queue would otherwise
    // analyse it after ANALYZE_MIN_ROWS however large it is — measured, that
    // is a 78MB table analysed after 2,000 writes, and bulk enqueue fell from
    // 19,969/s to 7,708/s. So the first time the floor is crossed, ask the
    // table how big it is and re-decide against the real threshold.
    if (!this.#thresholdMeasured) {
      this.#thresholdMeasured = true;
      this.#analyzeThreshold = await this.#nextAnalyzeThreshold();

      if (this.#writtenSinceAnalyze < this.#analyzeThreshold) {
        return;
      }
    }

    const statement = this.dialect.analyze(this.#tables.jobs);

    if (!statement) {
      return;
    }

    this.#writtenSinceAnalyze = 0;
    this.#analyzing = this.#analyzeNow(statement).finally(() => {
      this.#analyzing = undefined;
    });

    await this.#analyzing;
  }

  /** Runs one refresh and re-sizes the threshold from what it learns. */
  async #analyzeNow(statement: string): Promise<void> {
    try {
      await this.#sql.unsafe(statement);
      this.#analyzeThreshold = await this.#nextAnalyzeThreshold();
    } catch {
      // A refresh is an optimisation. Losing one costs a slower plan until the
      // next write crosses the threshold again, or until autovacuum notices.
    }
  }

  /**
   * How many rows to wait for before the next refresh.
   *
   * Autovacuum's own rule, `threshold + scale_factor * rows`, so the cost of
   * analysing stays a fixed share of the writes that made it necessary rather
   * than growing with the table.
   */
  async #nextAnalyzeThreshold(): Promise<number> {
    const query = this.dialect.estimatedRows(this.#tables.jobs);

    if (!query) {
      return ANALYZE_MIN_ROWS;
    }

    const rows = await this.#all<{ n: number | string }>(query, []);
    // Negative means the engine has no estimate yet, which `ANALYZE` having
    // just run makes unlikely — but a floor is the safe reading either way.
    const estimated = Math.max(0, Number(rows[0]?.n ?? 0));

    return Math.max(
      ANALYZE_MIN_ROWS,
      Math.round(estimated * ANALYZE_SCALE_FACTOR),
    );
  }

  /**
   * Whether a record carries nothing beyond what a brand-new job carries.
   *
   * A job added in any other shape — restored from elsewhere, added already
   * finished, mid-retry — has to name every column, because the ones it would
   * otherwise skip are exactly the ones holding its state.
   */
  #isFreshJob(job: JobRecord): boolean {
    return (
      job.processedOn === null &&
      job.finishedOn === null &&
      job.expiresAt === null &&
      job.lockToken === null &&
      job.lockExpiresAt === null &&
      job.workerId === null &&
      // A stamp lives in the stamp's columns, which the fresh list leaves out.
      (job.processedBy ?? null) === null &&
      job.repeatKey === null &&
      job.attemptsMade === 0 &&
      job.stalledCount === 0 &&
      job.progress === null &&
      job.returnValue === null &&
      job.failedReason === null &&
      (job.stacktrace?.length ?? 0) === 0 &&
      // A job in a flow carries its parent or children in `flow`, which the
      // fresh column list leaves to the table's default of null.
      (job.flow ?? null) === null
    );
  }

  /**
   * Writes one set of rows, and says which ids went in.
   *
   * `tolerateConflicts` picks between the plain insert and the one that skips
   * a row whose id is taken. The plain form is what the caller wants once it
   * has established the ids are free, because the conflict clause is the
   * single most expensive part of the statement; the tolerant form is the
   * fallback for when that turns out to have been raced.
   *
   * The returned set is only meaningful for the tolerant form on an engine
   * that can report what it wrote — otherwise the caller already knows,
   * because it chose the rows.
   */
  async #insertRows(
    q: QueueRef,
    rows: JobRecord[],
    columns: readonly string[],
    types: readonly string[],
    tolerateConflicts: boolean,
  ): Promise<Set<string>> {
    // One JSON document beats a parameter per column per row where the engine
    // can expand it: 500 jobs is one bind parameter this way and 12,000 as a
    // multi-row `VALUES`.
    const fromJson = tolerateConflicts
      ? this.dialect.insertIgnoreFromJson
      : (this.dialect.insertFromJson ?? this.dialect.insertIgnoreFromJson);

    const statement = fromJson
      ? fromJson(this.#tables.jobs, columns, types)
      : tolerateConflicts
        ? this.dialect.insertIgnoreMany(this.#tables.jobs, columns, rows.length)
        : this.dialect.insertMany(this.#tables.jobs, columns, rows.length);

    const params = fromJson
      ? [JSON.stringify(rows.map((job) => this.#toDocument(q, job, columns)))]
      : rows.flatMap((job) => this.#toRow(q, job, columns));

    // A notification rides inside the insert rather than following it, so it
    // costs no extra round trip — see `DriverConfig.notify`.
    const announced = this.#notify
      ? this.dialect.notifyingInsert(statement, this.#arrivals.channel(q))
      : this.dialect.supportsReturning
        ? `${statement} RETURNING id`
        : statement;

    if (!this.dialect.supportsReturning && !this.#notify) {
      await this.#run(statement, params);
      return new Set(rows.map((job) => job.id));
    }

    const written = await this.#all<{ id: string }>(announced, params);
    return new Set(written.map((row) => String(row.id)));
  }

  /**
   * Which of `ids` are already in the queue.
   *
   * One statement for the whole chunk, so this is a round trip rather than a
   * read per job — and an index-only scan on the primary key, which is why it
   * is cheaper than letting the insert discover the same thing through
   * `ON CONFLICT`. See {@link SqlDriver.#insertChunk} for the measurements.
   */
  async #existingIds(q: QueueRef, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) {
      return new Set();
    }

    const { bind, values } = this.#binder();
    const text = `SELECT id FROM ${this.#tables.jobs}
       WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
         AND id IN (${ids.map((id) => bind(id)).join(", ")})`;
    const rows = await this.#all<{ id: string }>(text, values);

    return new Set(rows.map((row) => String(row.id)));
  }

  /**
   * Inserts one chunk and works out which of its rows were new.
   *
   * It asks which ids are taken before writing, rather than letting the engine
   * sort it out with `ON CONFLICT DO NOTHING`. That clause is not free: it
   * makes Postgres insert speculatively — take a token, probe the unique
   * index, and be ready to withdraw the tuple — and measured on 5,000 rows it
   * costs 134ms against 78ms for the same insert without it. That is 43% of
   * the statement, and more than four times what maintaining the primary key
   * costs on its own. A `SELECT` of the chunk's ids is an index-only scan and
   * costs a fraction of it: 90ms end to end against 134ms, a 49% gain.
   *
   * Asking first leaves a window — another producer can take one of those ids
   * between the look and the write — so a unique violation is expected rather
   * than exceptional, and sends the chunk back through the conflict-tolerant
   * statement. Per-id idempotency is unchanged either way: a duplicate is
   * ignored, never overwritten, and comes back with whatever is stored.
   */
  async #insertChunk(
    q: QueueRef,
    chunk: JobRecord[],
  ): Promise<{ job: JobRecord; added: boolean }[]> {
    return await this.#requireFlowColumn(
      chunk.some((job) => job.flow),
      async () =>
        await this.#withStampColumns(
          chunk.some((job) => carriesStamp(job)),
          async () => await this.#insertChunkRows(q, chunk, true),
          async () => await this.#insertChunkRows(q, chunk, false),
        ),
    );
  }

  /** {@link SqlDriver.#insertChunk}, without the missing-column translation. */
  async #insertChunkRows(
    q: QueueRef,
    chunk: JobRecord[],
    stamps: boolean,
  ): Promise<{ job: JobRecord; added: boolean }[]> {
    // A batch of brand-new jobs names only the columns such a job carries; the
    // rest are the table's defaults, and not naming them is worth about 20%.
    // One record in an unusual shape sends the whole batch back to the full
    // list, which keeps this a choice of two statements rather than a shape
    // per batch.
    const allFresh = chunk.every((job) => this.#isFreshJob(job));
    // The module constants themselves, not copies: `columnIndices` memoises on
    // the array's identity, and a fresh copy per chunk would defeat it.
    // Past that, `flow` is named only when some job in the chunk is in one,
    // and the stamp's columns only when some job carries a stamp (and the
    // caller has not found the table without them).
    const columns: readonly string[] = allFresh
      ? FRESH_JOB_COLUMNS
      : insertColumns(
          chunk.some((job) => job.flow),
          stamps && chunk.some((job) => carriesStamp(job)),
        );
    const allTypes = jobColumnTypes(this.dialect);
    const types = columnIndices(columns).map((index) => allTypes[index]!);

    const taken = await this.#existingIds(
      q,
      chunk.map((job) => job.id),
    );
    const novel =
      taken.size === 0 ? chunk : chunk.filter((job) => !taken.has(job.id));
    /** Ids this call actually inserted. */
    let added: Set<string>;

    if (novel.length === 0) {
      // Every id in the chunk was already taken; there is nothing to write.
      added = new Set();
    } else {
      try {
        await this.#insertRows(q, novel, columns, types, false);
        added = new Set(novel.map((job) => job.id));
      } catch (error) {
        if (!this.dialect.isUniqueViolation(error)) {
          throw error;
        }

        // Somebody took one of these ids between the look and the write. The
        // insert is one statement, so none of it landed — send the whole chunk
        // back through the conflict-tolerant form and let the engine sort it.
        if (this.dialect.supportsReturning) {
          added = await this.#insertRows(q, chunk, columns, types, true);
        } else {
          // This engine cannot say what it wrote, and afterwards there is
          // nothing to tell a row it added from one that was already there.
          // So look again first — the earlier look is precisely what turned
          // out to be stale.
          const held = await this.#existingIds(
            q,
            chunk.map((job) => job.id),
          );

          await this.#insertRows(q, chunk, columns, types, true);
          added = new Set(
            chunk.map((job) => job.id).filter((id) => !held.has(id)),
          );
        }
      }
    }

    if (added.size === chunk.length) {
      return chunk.map((job) => ({ job: jsonClone(job), added: true }));
    }

    // Only the collisions need reading back, and only to return what is
    // actually stored rather than what the caller offered.
    const stored = new Map<string, JobRecord>();
    for (const job of chunk) {
      if (!added.has(job.id)) {
        const existing = await this.getJob(q, job.id);
        if (existing) {
          stored.set(job.id, existing);
        }
      }
    }

    return chunk.map((job) => ({
      job: stored.get(job.id) ?? jsonClone(job),
      added: added.has(job.id),
    }));
  }

  async claimJob(q: QueueRef, opts: ClaimOptions): Promise<JobRecord | null> {
    await this.connect();

    if (await this.#pauseCache.read(q, () => this.isQueuePaused(q))) {
      return null;
    }

    // No `promoteDelayed` here.
    //
    // It used to run before every claim, so a queue with nothing delayed still
    // paid for a write — measured, 0.16ms of a 1.16ms claim. Promotion is not
    // what makes a job claimable, it is what keeps the *reported* state
    // honest, and every worker already runs it on a 1Hz promotion timer
    // (`BunQueueWorker.#armMaintenance`) — liveness, which no option turns
    // off. A caller driving the driver directly, with no worker at all,
    // promotes explicitly, which is what the contract suite does.

    // Before the claim, so a job that lands after it looked is known to the
    // wait that follows an empty one (`Arrivals.mark`).
    this.#arrivals.mark(q);

    let job: JobRecord | null;
    if (!opts.excludeNames || opts.excludeNames.length === 0) {
      job = await this.#claimOne(q, opts, null);
    } else {
      [job = null] = await this.#claimPastExclusions(
        q,
        opts,
        1,
        async (after) => {
          const claimed = await this.#claimOne(q, opts, after);
          return claimed ? [claimed] : [];
        },
      );
    }

    if (job) {
      this.#arrivals.unmark(q);
    }
    return job;
  }

  /**
   * Claims one job, from the head of the queue or, for a claim that skips
   * names, from `after`.
   */
  async #claimOne(
    q: QueueRef,
    opts: ClaimOptions,
    after: ClaimCursor | null,
  ): Promise<JobRecord | null> {
    return await this.#withClaimStamp(
      opts,
      async (worker) => await this.#claimOneStamped(q, opts, after, worker),
    );
  }

  /** {@link SqlDriver.#claimOne}, stamping `worker` as the dialect takes it. */
  async #claimOneStamped(
    q: QueueRef,
    opts: ClaimOptions,
    after: ClaimCursor | null,
    worker: ClaimStatementOptions["worker"],
  ): Promise<JobRecord | null> {
    // Every engine claims differently — a CTE, a joined derived table, a
    // scalar subquery under a write lock — so the statement comes from the
    // dialect. What they share is the guarantee: at most one row, taken by
    // exactly one caller.
    const { bind, values } = this.#binder();

    const returning = this.dialect.claim({
      table: this.#tables.jobs,
      bind,
      ns: q.ns,
      queue: q.queue,
      now: opts.now,
      token: opts.token,
      workerId: opts.workerId,
      worker,
      lockMs: opts.lockMs,
      excludeNames: opts.excludeNames,
      after,
    });

    /** The claim, given whichever connection it should run on. */
    const claim = async (tx: SQL): Promise<JobRecord | null> => {
      if (this.dialect.supportsReturning) {
        const rows = await this.#all<Record<string, unknown>>(
          returning,
          values,
          tx,
        );
        return rows[0] ? this.#toRecord(rows[0]) : null;
      }

      // MariaDB cannot return the row it updated, so the claim is three
      // statements: pick an id, take that id, read it back.
      //
      // Reading back by lock token instead looks simpler and is wrong: a
      // worker uses one token for its whole life, so with any concurrency
      // above one the read returns a job it already holds — and that job is
      // then processed a second time. Measured, six of forty jobs ran twice.
      const pick = this.#binder();
      const candidate = await this.#one<{ id: string }>(
        this.dialect.claimCandidate({
          table: this.#tables.jobs,
          bind: pick.bind,
          ns: q.ns,
          queue: q.queue,
          now: opts.now,
          token: opts.token,
          workerId: opts.workerId,
          lockMs: opts.lockMs,
          // Excluded names are filtered here, at the pick. The take below needs
          // no filter of its own: it names this id, and a job's name never
          // changes between the two.
          excludeNames: opts.excludeNames,
          after,
        }),
        pick.values,
        tx,
      );

      if (!candidate) {
        return null;
      }

      const take = this.#binder();
      const claimed = await this.#run(
        this.dialect.claimById(
          {
            table: this.#tables.jobs,
            bind: take.bind,
            ns: q.ns,
            queue: q.queue,
            now: opts.now,
            token: opts.token,
            workerId: opts.workerId,
            worker,
            lockMs: opts.lockMs,
          },
          candidate.id,
        ),
        take.values,
        tx,
      );

      // Someone else took it between the pick and the update.
      if (claimed === 0) {
        return null;
      }

      const read = this.#binder();
      const row = await this.#one<Record<string, unknown>>(
        `SELECT * FROM ${this.#tables.jobs}
          WHERE ns = ${read.bind(q.ns)} AND queue = ${read.bind(q.queue)}
            AND id = ${read.bind(candidate.id)}`,
        read.values,
        tx,
      );

      return row ? this.#toRecord(row) : null;
    };

    // Postgres skips the transaction: its CTE is already atomic, and the
    // wrapper is a third of the claim's cost.
    return this.dialect.claimNeedsTransaction
      ? await this.dialect.transaction(this.#sql, claim)
      : await claim(this.#sql);
  }

  /**
   * Claims several jobs in one statement, where the engine can.
   *
   * Only offered for engines that can return the rows they updated. MySQL and
   * MariaDB cannot, so their claim is already a pick-then-take-then-read
   * sequence per job, and looping it — which is what `claimJobBatch` falls back
   * to — costs the same as a plural version would while holding far fewer row
   * locks. SQLite is left out for a different reason: its claim is a scalar
   * subquery, and widening it to `IN (… LIMIT n)` re-opens exactly the
   * re-evaluation hazard that once made Postgres claim two rows and return one.
   */
  async claimJobs(
    q: QueueRef,
    opts: ClaimOptions,
    limit: number,
  ): Promise<JobRecord[]> {
    if (!this.dialect.supportsReturning || this.dialect.claimNeedsTransaction) {
      return await claimByLoop(async () => await this.claimJob(q, opts), limit);
    }

    await this.connect();

    if (await this.#pauseCache.read(q, () => this.isQueuePaused(q))) {
      return [];
    }

    // As in `claimJob`: the wait after an empty claim judges by this.
    this.#arrivals.mark(q);

    const jobs =
      !opts.excludeNames || opts.excludeNames.length === 0
        ? await this.#claimMany(q, opts, limit, null)
        : await this.#claimPastExclusions(
            q,
            opts,
            limit,
            async (after, wanted) =>
              await this.#claimMany(q, opts, wanted, after),
          );

    if (jobs.length > 0) {
      this.#arrivals.unmark(q);
    }
    return jobs;
  }

  /**
   * `claimJobs`' single statement, from the head of the queue or, for a claim
   * that skips names, from `after`.
   */
  async #claimMany(
    q: QueueRef,
    opts: ClaimOptions,
    limit: number,
    after: ClaimCursor | null,
  ): Promise<JobRecord[]> {
    return await this.#withClaimStamp(
      opts,
      async (worker) =>
        await this.#claimManyStamped(q, opts, limit, after, worker),
    );
  }

  /** {@link SqlDriver.#claimMany}, stamping `worker` as the dialect takes it. */
  async #claimManyStamped(
    q: QueueRef,
    opts: ClaimOptions,
    limit: number,
    after: ClaimCursor | null,
    worker: ClaimStatementOptions["worker"],
  ): Promise<JobRecord[]> {
    const { bind, values } = this.#binder();
    const statement = this.dialect.claim({
      table: this.#tables.jobs,
      bind,
      ns: q.ns,
      queue: q.queue,
      now: opts.now,
      token: opts.token,
      workerId: opts.workerId,
      worker,
      lockMs: opts.lockMs,
      limit,
      excludeNames: opts.excludeNames,
      after,
    });

    const rows = await this.#all<Record<string, unknown>>(statement, values);

    // `RETURNING` has no defined row order — the CTE orders the *pick*, not the
    // result — so claim order is restored here rather than left to the planner.
    return rows
      .map((row) => this.#toRecord(row))
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          a.createdAt - b.createdAt ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
  }

  /**
   * Runs a claim that skips names over two bounded windows of the queue.
   *
   * Each claim statement looks at no more than `CLAIM_WINDOW` waiting rows, so
   * a job behind a longer run of skipped ones is out of its sight. The head
   * window goes first, so a job that arrives at the front is taken on the very
   * next claim however far back the cursor is; only when that falls short does
   * the window at the cursor run. When the last window looked at was full and
   * still fell short, everything in it was skipped or gone, so the cursor moves
   * to its end; when it was not full it reached the end of the queue, and the
   * cursor is dropped to start over from the head.
   *
   * `claim` runs one windowed claim for up to `wanted` jobs.
   */
  async #claimPastExclusions(
    q: QueueRef,
    opts: ClaimOptions,
    limit: number,
    claim: (after: ClaimCursor | null, wanted: number) => Promise<JobRecord[]>,
  ): Promise<JobRecord[]> {
    const usedAt = Date.now();
    this.#sweepClaimCursors(usedAt);

    const key = JSON.stringify([
      q.ns,
      q.queue,
      [...new Set(opts.excludeNames)].sort(),
    ]);
    const cursor = this.#claimCursors.get(key);
    if (cursor) {
      cursor.usedAt = usedAt;
    }

    const claimed = await claim(null, limit);
    if (claimed.length >= limit) {
      return claimed;
    }

    // Without a cursor the window at it *is* the head window, which has just
    // fallen short; running it again would find the same nothing.
    const from = cursor?.after ?? null;
    if (from) {
      claimed.push(...(await claim(from, limit - claimed.length)));
      if (claimed.length >= limit) {
        return claimed;
      }
    }

    const end = await this.#claimWindowEnd(q, opts, from);
    if (end) {
      this.#claimCursors.set(key, { after: end, usedAt });
    } else {
      this.#claimCursors.delete(key);
    }

    return claimed;
  }

  /** The last row of the window at `after`, or `null` when it is not full. */
  async #claimWindowEnd(
    q: QueueRef,
    opts: ClaimOptions,
    after: ClaimCursor | null,
  ): Promise<ClaimCursor | null> {
    const { bind, values } = this.#binder();
    const row = await this.#one<{
      priority: number | string;
      created_at: number | string | bigint;
      id: string;
    }>(
      this.dialect.claimWindowEnd({
        table: this.#tables.jobs,
        bind,
        ns: q.ns,
        queue: q.queue,
        now: opts.now,
        token: opts.token,
        workerId: opts.workerId,
        lockMs: opts.lockMs,
        excludeNames: opts.excludeNames,
        after,
      }),
      values,
    );

    // Engines hand a `BIGINT` back as a number, a string or a bigint; an epoch
    // millisecond is exact as a number whichever arrives.
    return row
      ? {
          priority: Number(row.priority),
          createdAt: Number(row.created_at),
          id: String(row.id),
        }
      : null;
  }

  /** Drops claim cursors unused for {@link CLAIM_CURSOR_IDLE_MS}. */
  #sweepClaimCursors(now: number): void {
    if (now - this.#claimCursorsSweptAt < CLAIM_CURSOR_IDLE_MS) {
      return;
    }

    this.#claimCursorsSweptAt = now;
    for (const [key, cursor] of this.#claimCursors) {
      if (now - cursor.usedAt > CLAIM_CURSOR_IDLE_MS) {
        this.#claimCursors.delete(key);
      }
    }
  }

  async extendJobLock(
    q: QueueRef,
    id: string,
    token: string,
    lockMs: number,
    now: number,
  ): Promise<boolean> {
    await this.connect();

    // `touch()`, `extendLock()` and the heartbeat all land here, and two in
    // one millisecond write the same expiry — see #updateMatched.
    const extended = await this.#updateMatched(
      this.#tables.jobs,
      [{ column: "lock_expires_at", value: now + lockMs }],
      (bind) =>
        `ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}
          AND state = 'active' AND lock_token = ${bind(token)}`,
    );

    return extended > 0;
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

    const expiresAt =
      typeof retention === "object" && retention?.ttl && retention.ttl > 0
        ? now + retention.ttl
        : null;

    // `removeOnComplete: true` is the common configuration for a queue that
    // does not read results back, and it used to cost two round trips: an
    // UPDATE that wrote the result and the finished state, then a DELETE of
    // the row it had just written. One conditional DELETE does the same job,
    // keeps the same holder check, and skips serialising a result nothing will
    // ever read.
    if (retention === true) {
      const { bind, values } = this.#binder();
      const removed = await this.#settle(
        q,
        now,
        "completed",
        `DELETE FROM ${this.#tables.jobs}
          WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}
            AND state = 'active' AND lock_token = ${bind(token)}`,
        bind,
        values,
      );

      return removed > 0;
    }

    // `worker_id` is the holder and goes with the lock, here and in every
    // other settle. The attribution stamp's `processed_by*` columns are not
    // named by any settle, so the stamp outlives the attempt.
    const { bind, values } = this.#binder();
    const completed = await this.#settle(
      q,
      now,
      "completed",
      `UPDATE ${this.#tables.jobs}
          SET state = 'completed', finished_on = ${bind(now)},
              return_value = ${bind(this.dialect.jsonIn(result ?? null))},
              expires_at = ${bind(expiresAt)},
              lock_token = NULL, lock_expires_at = NULL, worker_id = NULL
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}
          AND state = 'active' AND lock_token = ${bind(token)}`,
      bind,
      values,
    );

    if (completed === 0) {
      return false;
    }

    await this.#applyRetention(q, id, "completed", retention, now);
    return true;
  }

  /**
   * Completes a set of jobs held under one token.
   *
   * Two statements at most, whatever the size of the set: the ones being
   * removed are one `DELETE … id = ANY`, and the ones being kept are one
   * `UPDATE … FROM json_to_recordset`, because each of those carries its own
   * result and expiry and so cannot share a single `SET`.
   *
   * Both keep the holder check the singular form has — `state = 'active' AND
   * lock_token = ?` — so a job whose lock lapsed is left alone and reported as
   * unsettled rather than silently overwritten.
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

    // The batched statements below are Postgres-only — `json_to_recordset` has
    // no portable equivalent — so every other engine takes the singular path,
    // which is what it did before this existed.
    if (!this.dialect.insertIgnoreFromJson) {
      const settledOneByOne: string[] = [];
      for (const one of completions) {
        if (
          await this.completeJob(
            q,
            one.id,
            token,
            one.result,
            one.retention,
            now,
          )
        ) {
          settledOneByOne.push(one.id);
        }
      }
      return settledOneByOne;
    }

    const settled: string[] = [];
    const removing = completions.filter((one) => one.retention === true);
    const keeping = completions.filter((one) => one.retention !== true);

    if (removing.length > 0) {
      const { bind, values } = this.#binder();
      const ids = removing.map((one) => one.id);
      // Postgres only, here: the counter rides in the same statement.
      const rows = await this.#all<{ id: string }>(
        this.#countedStatement(
          q,
          now,
          "completed",
          this.#takeMetricsShard(),
          `DELETE FROM ${this.#tables.jobs}
          WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
            AND state = 'active' AND lock_token = ${bind(token)}
            AND id IN (${ids.map((id) => bind(id)).join(", ")})
        RETURNING id`,
          bind,
        ),
        values,
      );
      settled.push(...rows.map((row) => String(row.id)));
      this.#afterCounted(q, now);
      this.#countQueueJobs(q, now, rows.length, 0);
    }

    // Anything with a count-based retention still needs the per-state sweep the
    // singular path does, so it takes that path rather than being half-batched
    // — `{ count, ttl }` included, which has a TTL but must still be capped.
    const batchable = keeping.filter(
      (one) =>
        one.retention === false ||
        (this.#ttlOf(one.retention) !== null && !this.#hasCount(one.retention)),
    );
    const individual = keeping.filter((one) => !batchable.includes(one));

    if (batchable.length > 0) {
      const { bind, values } = this.#binder();
      const document = JSON.stringify(
        batchable.map((one) => ({
          id: one.id,
          // Embedded, not bound: see "JSON columns" in `dialect.ts`.
          return_value: this.dialect.jsonEmbed(one.result),
          expires_at:
            this.#ttlOf(one.retention) === null
              ? null
              : now + this.#ttlOf(one.retention)!,
        })),
      );

      const rows = await this.#all<{ id: string }>(
        this.#countedStatement(
          q,
          now,
          "completed",
          this.#takeMetricsShard(),
          `UPDATE ${this.#tables.jobs} AS jobs
            SET state = 'completed', finished_on = ${bind(now)},
                return_value = document.return_value,
                expires_at = document.expires_at,
                lock_token = NULL, lock_expires_at = NULL, worker_id = NULL
           FROM json_to_recordset(${bind(document)}::text::json)
             AS document (id ${this.dialect.idType}, return_value json, expires_at ${this.dialect.timeType})
          WHERE jobs.ns = ${bind(q.ns)} AND jobs.queue = ${bind(q.queue)}
            AND jobs.id = document.id
            AND jobs.state = 'active' AND jobs.lock_token = ${bind(token)}
        RETURNING jobs.id`,
          bind,
        ),
        values,
      );
      settled.push(...rows.map((row) => String(row.id)));
      this.#afterCounted(q, now);
      this.#countQueueJobs(q, now, rows.length, 0);
    }

    for (const one of individual) {
      if (
        await this.completeJob(q, one.id, token, one.result, one.retention, now)
      ) {
        settled.push(one.id);
      }
    }

    return settled;
  }

  /** The TTL a retention asks for, or `null` when it names none. */
  /** Whether a retention caps how many finished jobs are kept. */
  #hasCount(retention: Retention): boolean {
    return (
      typeof retention === "number" ||
      (typeof retention === "object" &&
        retention !== null &&
        retention.count !== undefined)
    );
  }

  #ttlOf(retention: Retention): number | null {
    return typeof retention === "object" && retention?.ttl && retention.ttl > 0
      ? retention.ttl
      : null;
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
    if (
      !existing ||
      existing.state !== "active" ||
      existing.lockToken !== token
    ) {
      return false;
    }

    const stacktrace = [error, ...existing.stacktrace].slice(
      0,
      Math.max(0, keepStacktraces),
    );

    const retention = outcome.retry ? false : outcome.retention;
    const expiresAt =
      !outcome.retry &&
      typeof retention === "object" &&
      retention?.ttl &&
      retention.ttl > 0
        ? now + retention.ttl
        : null;

    const { bind, values } = this.#binder();
    const updated = await this.#settle(
      q,
      now,
      "failed",
      `UPDATE ${this.#tables.jobs}
          SET state = ${bind(outcome.retry ? "failed" : "dead")},
              run_at = ${bind(outcome.retry ? outcome.runAt : existing.runAt)},
              finished_on = ${bind(outcome.retry ? null : now)},
              expires_at = ${bind(expiresAt)},
              failed_reason = ${bind(this.dialect.jsonIn(error))},
              stacktrace = ${bind(this.dialect.jsonIn(stacktrace))},
              lock_token = NULL, lock_expires_at = NULL, worker_id = NULL
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}
          AND state = 'active' AND lock_token = ${bind(token)}`,
      bind,
      values,
    );

    if (updated === 0) {
      return false;
    }

    if (!outcome.retry) {
      await this.#applyRetention(q, id, "dead", outcome.retention, now);
    }

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
    if (!existing || !canBury(existing, opts.token)) {
      return null;
    }

    // Built from the read, as `failJob` builds it; the statement's own
    // condition is what decides whether the job is buried.
    const stacktrace = [error, ...existing.stacktrace].slice(
      0,
      Math.max(0, opts.keepStacktraces),
    );
    const ttl = this.#ttlOf(opts.retention);
    const expiresAt = ttl === null ? null : now + ttl;

    const { bind, values } = this.#binder();
    const token = opts.token;
    // Bound where they appear, after the `SET` list: a positional placeholder
    // takes its value by order.
    const waiting = () =>
      BURIABLE_STATES.map((state) => bind(state)).join(", ");
    const active = () =>
      token === undefined
        ? ""
        : ` OR (state = 'active' AND lock_token = ${bind(token)})`;

    const updated = await this.#settle(
      q,
      now,
      "failed",
      `UPDATE ${this.#tables.jobs}
          SET state = 'dead',
              finished_on = ${bind(now)},
              expires_at = ${bind(expiresAt)},
              failed_reason = ${bind(this.dialect.jsonIn(error))},
              stacktrace = ${bind(this.dialect.jsonIn(stacktrace))},
              lock_token = NULL, lock_expires_at = NULL, worker_id = NULL
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}
          AND (state IN (${waiting()})${active()})`,
      bind,
      values,
    );

    if (updated === 0) {
      return null;
    }

    await this.#applyRetention(q, id, "dead", opts.retention, now);

    // Read back, unless retention removed it: then as it was buried.
    return (
      (await this.getJob(q, id)) ?? {
        ...existing,
        state: "dead",
        finishedOn: now,
        expiresAt,
        failedReason: error,
        stacktrace,
        lockToken: null,
        lockExpiresAt: null,
        workerId: null,
      }
    );
  }

  async updateProgress(
    q: QueueRef,
    id: string,
    progress: unknown,
  ): Promise<boolean> {
    await this.connect();

    // The same progress twice changes nothing — see #updateMatched.
    const updated = await this.#updateMatched(
      this.#tables.jobs,
      [
        {
          column: "progress",
          value: this.dialect.jsonIn(progress),
          json: true,
        },
      ],
      (bind) =>
        `ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}`,
    );

    return updated > 0;
  }

  /**
   * Changes a job's data, priority or due time in one conditional write.
   *
   * The state a new `runAt` leads to depends only on `runAt` and `now`, both
   * known here, so it is decided before the statement rather than in it — and
   * that lets every rule the patch has become a state condition in the
   * `WHERE`. A job claimed a moment before this runs no longer matches, which
   * is what makes `onlyIn` safe against a worker claiming concurrently.
   */
  async updateJob(
    q: QueueRef,
    id: string,
    patch: JobPatch,
    now: number,
  ): Promise<JobRecord | null> {
    await this.connect();

    // `runAt` narrows the job to the states that have a due time to move, and
    // `onlyIn` narrows it further. `null` is no condition at all.
    let allowed: JobState[] | null = patch.onlyIn ? [...patch.onlyIn] : null;

    if (patch.runAt !== undefined) {
      allowed = (allowed ?? PENDING).filter((state) => PENDING.includes(state));
    }

    if (allowed?.length === 0) {
      return null;
    }

    const table = this.#tables.jobs;

    /** The `SET` list, bound in statement order by whichever binder runs it. */
    const assignments = (bind: (value: unknown) => string): string[] => {
      const set: string[] = [];

      if (patch.data !== undefined) {
        set.push(`data = ${bind(this.dialect.jsonIn(patch.data))}`);
      }

      // The column is what claiming orders by and what a record reads back;
      // the copy in `opts` is kept in step so the two never disagree. An
      // operator's per-job priority is explicit, so the priority bit is OR-ed
      // into `opts.explicit` in the same write — even when the value is
      // unchanged, since choosing it is what pins it — but only where a mask
      // is stored: an older job without one stays without one.
      if (patch.priority !== undefined) {
        set.push(`priority = ${bind(patch.priority)}`);
        set.push(
          `opts = ${this.dialect.jsonSetInteger(
            this.dialect.jsonOrBit(
              "opts",
              "explicit",
              JOB_OPTION_BITS.priority,
            ),
            "priority",
            bind(patch.priority),
          )}`,
        );
      }

      if (patch.runAt !== undefined) {
        set.push(`run_at = ${bind(patch.runAt)}`);
        set.push(`state = ${bind(patch.runAt > now ? "delayed" : "waiting")}`);
      }

      return set;
    };

    /** Which job, and in which states it may be changed. */
    const where = (bind: (value: unknown) => string): string =>
      `ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}${
        allowed
          ? ` AND state IN (${allowed.map((state) => bind(state)).join(", ")})`
          : ""
      }`;

    // Nothing to write: the answer is the job, if it is in a state allowed.
    if (assignments(() => "?").length === 0) {
      const read = this.#binder();
      const row = await this.#one<Record<string, unknown>>(
        `SELECT * FROM ${table} WHERE ${where(read.bind)}`,
        read.values,
      );
      return row ? this.#toRecord(row) : null;
    }

    if (this.dialect.supportsReturning) {
      const { bind, values } = this.#binder();
      const set = assignments(bind).join(", ");
      const rows = await this.#all<Record<string, unknown>>(
        `UPDATE ${table} SET ${set} WHERE ${where(bind)} RETURNING *`,
        values,
      );
      return rows[0] ? this.#toRecord(rows[0]) : null;
    }

    // MySQL and MariaDB cannot return the row, and their affected-row count is
    // rows *changed*, not rows matched — a patch that sets what is already
    // stored reports zero. So the row is locked in the allowed state first,
    // which is the check, and then written and read back under that lock.
    return await this.dialect.transaction(this.#sql, async (tx) => {
      const lock = this.#binder();
      const held = await this.#one<{ id: string }>(
        `SELECT id FROM ${table} WHERE ${where(lock.bind)} FOR UPDATE`,
        lock.values,
        tx,
      );

      if (!held) {
        return null;
      }

      const write = this.#binder();
      const set = assignments(write.bind).join(", ");
      await this.#all(
        `UPDATE ${table} SET ${set}
          WHERE ns = ${write.bind(q.ns)} AND queue = ${write.bind(q.queue)}
            AND id = ${write.bind(id)}`,
        write.values,
        tx,
      );

      const read = this.#binder();
      const row = await this.#one<Record<string, unknown>>(
        `SELECT * FROM ${table}
          WHERE ns = ${read.bind(q.ns)} AND queue = ${read.bind(q.queue)}
            AND id = ${read.bind(id)}`,
        read.values,
        tx,
      );

      return row ? this.#toRecord(row) : null;
    });
  }

  /**
   * Writes a queue's stored defaults over its pending jobs' options: a keyset
   * walk over each requested state in claim order, `(priority, created_at,
   * id)`, on the claim index, one transaction per batch.
   *
   * Each batch reads its jobs `FOR UPDATE` (on SQLite, under the transaction's
   * write lock), decides every job with `planPendingRewrite` — the rule every
   * backend shares, computed here in JavaScript because an option value is
   * compared as JSON, whatever its key order, which no engine spells alike —
   * and then writes the rewritten ones with one `UPDATE` per distinct set of
   * changing keys: `opts` through {@link SqlDialect.jsonSetValues}, plus
   * `max_attempts` for `attempts` and the `priority` column for `priority`,
   * in the statement that re-checks `state`. So a job's options, attempts
   * and priority change together or not at all, and one a claim took first
   * is not in the batch: a claim locks with `SKIP LOCKED` and moves the row
   * out of `waiting` before this lock is granted, and the re-evaluated
   * `state` drops it. `moved` is therefore always 0 here.
   *
   * Plain `FOR UPDATE` rather than `SKIP LOCKED`: skipping a row some other
   * writer holds for a moment (an `updateJob`) would skip a job that is still
   * pending, which the walk promises never to do. The wait is one statement's.
   *
   * A priority change moves a row within the claim index, and so within the
   * walk: behind the cursor it is not met again; ahead of it, it is met again
   * and counts `unchanged` — the same keyset rule the memory driver follows.
   * A dry run reads without locks or a transaction, and writes nothing.
   */
  async rewritePendingOptions(
    q: QueueRef,
    request: PendingOptionsRewrite,
  ): Promise<PendingOptionsRewriteResult> {
    assertRewriteRequest(request);
    await this.connect();

    const result = emptyRewriteResult();
    const { states } = request;
    const batchSize = REWRITE_BATCH[this.adapter];

    let from = 0;
    let after: ClaimCursor | null = null;
    /** The last job examined in this call, which the next call resumes after. */
    let last: { state: JobState; key: ClaimCursor } | undefined;
    /**
     * The jobs this call has rewritten. One whose new priority moved it ahead
     * of the walk is met again further on; within the call it is passed over
     * uncounted, as a walk over the jobs as they stood when the call began
     * would (the memory driver's), so a dry run — which moves nothing —
     * counts exactly what the real call does. A later call meets it again and
     * counts it `unchanged`.
     */
    const rewritten = new Set<string>();

    if (request.cursor !== null) {
      const cursor = decodeRewriteCursor(
        request.cursor,
        states,
        REWRITE_CURSOR_KEY,
      );
      const [priority, createdAt, id] = cursor.key as [number, number, string];
      from = states.indexOf(cursor.state);
      after = { priority, createdAt, id };
    }

    for (let index = from; index < states.length; index++) {
      const state = states[index]!;
      let floor = after;
      after = null;

      for (;;) {
        const room = request.limit - result.examined;

        if (room <= 0 && last) {
          // Resume after the last job examined — but only when there *is*
          // something after it, so a walk ending exactly at the limit answers
          // `next: null` rather than costing the caller one empty call more.
          if (await this.#rewriteRemains(q, states.slice(index), floor)) {
            result.next = encodeRewriteCursor(last.state, [
              last.key.priority,
              last.key.createdAt,
              last.key.id,
            ]);
          }
          return result;
        }

        const batch = await this.#rewriteBatch(
          q,
          state,
          floor,
          Math.min(batchSize, room),
          request,
          rewritten,
        );

        for (const key of [
          "examined",
          "rewritten",
          "unchanged",
          "skippedExplicit",
          "skippedUnmarked",
          "moved",
          "exhausted",
        ] as const) {
          result[key] += batch.tally[key];
        }

        // Only an empty batch ends a state. A short one would too, on a
        // snapshot, but under locks a row re-evaluated after a wait can drop
        // out of the page, and a short page must not be mistaken for the end.
        if (!batch.last) {
          break;
        }

        floor = batch.last;
        last = { state, key: batch.last };
      }
    }

    return result;
  }

  /**
   * One batch of {@link SqlDriver.rewritePendingOptions}: at most `take` jobs
   * of `state` after `floor` in claim order, planned and — unless a dry run —
   * written in one transaction. A job in `rewritten` (this call's own work,
   * met again after its priority moved it) is passed over uncounted; every
   * job written is added to it once the transaction commits. Answers the
   * counts, and the claim-order key of the last job read (`null` when there
   * was none).
   */
  async #rewriteBatch(
    q: QueueRef,
    state: JobState,
    floor: ClaimCursor | null,
    take: number,
    request: PendingOptionsRewrite,
    rewritten: Set<string>,
  ): Promise<{
    /** What this batch counted. */
    tally: PendingOptionsRewriteResult;
    /** The last job read, in claim order, or `null` when none was. */
    last: ClaimCursor | null;
  }> {
    const table = this.#tables.jobs;

    const work = async (tx?: SQL) => {
      /** The page, pinned to the claim index where the engine takes a hint. */
      const page = async (hinted: boolean) => {
        const read = this.#binder();
        return await this.#all<RewriteRow>(
          rewritePageStatement(this.dialect, table, read.bind, {
            ns: q.ns,
            queue: q.queue,
            state,
            after: floor,
            limit: take,
            lock: !request.dryRun && this.adapter !== "sqlite",
            hinted,
          }),
          read.values,
          tx,
        );
      };

      let rows: RewriteRow[];

      try {
        rows = await page(!this.#claimIndexMissing);
      } catch (error) {
        // A table whose claim index is gone (dropped by hand) still walks,
        // unhinted; MySQL rolls back only the failed statement, so the
        // transaction carries on.
        if (
          this.#claimIndexMissing ||
          !this.dialect.isMissingHintedIndex(error)
        ) {
          throw error;
        }
        this.#claimIndexMissing = true;
        rows = await page(false);
      }

      const tally = emptyRewriteResult();
      /** The rewritten ids, by the keys that change on them. */
      const groups = new Map<
        string,
        { keys: EditableJobOptionKey[]; ids: string[] }
      >();

      for (const row of rows) {
        if (rewritten.has(String(row.id))) {
          continue;
        }

        const plan = planPendingRewrite(
          {
            opts: this.dialect.jsonOut<StoredJobOptions>(
              row.opts,
              {} as StoredJobOptions,
            ),
            priority: Number(row.priority),
            maxAttempts: Number(row.max_attempts),
            attemptsMade: Number(row.attempts_made),
          },
          request.values,
          request.includeUnmarked,
        );
        tallyRewrite(tally, plan);

        if (plan.outcome === "rewritten") {
          const signature = plan.keys.join(",");
          const group = groups.get(signature);

          if (group) {
            group.ids.push(String(row.id));
          } else {
            groups.set(signature, { keys: plan.keys, ids: [String(row.id)] });
          }
        }
      }

      if (!request.dryRun) {
        for (const { keys, ids } of groups.values()) {
          await this.#rewriteGroup(q, state, keys, ids, request.values, tx);
        }
      }

      const tail = rows.at(-1);

      return {
        tally,
        written: request.dryRun
          ? []
          : [...groups.values()].flatMap((group) => group.ids),
        last: tail
          ? {
              priority: Number(tail.priority),
              createdAt: Number(tail.created_at),
              id: String(tail.id),
            }
          : null,
      };
    };

    // Postgres's transaction does not retry a deadlock by itself (MySQL's,
    // MariaDB's and SQLite's do); a batch read and planned again from scratch
    // is safe to repeat, and its counts are only taken once it commits.
    const transaction = async () =>
      await this.dialect.transaction(this.#sql, async (tx) => await work(tx));

    const batch = request.dryRun
      ? await work()
      : this.adapter === "postgres"
        ? await withLockRetry(transaction)
        : await transaction();

    for (const id of batch.written) {
      rewritten.add(id);
    }

    return { tally: batch.tally, last: batch.last };
  }

  /**
   * Writes `keys` of `values` over the jobs `ids` of `state`, in one
   * statement that re-checks the state: `opts` through
   * {@link SqlDialect.jsonSetValues}, `max_attempts` with `attempts`, and the
   * `priority` column with `priority` — which moves each row in the claim
   * index, keeping `created_at` and so its FIFO place among equals.
   */
  async #rewriteGroup(
    q: QueueRef,
    state: JobState,
    keys: EditableJobOptionKey[],
    ids: string[],
    values: PendingOptionsRewrite["values"],
    tx: SQL | undefined,
  ): Promise<void> {
    const { bind, values: params } = this.#binder();
    const opts = this.dialect.jsonSetValues(
      "opts",
      keys.map((key) => [key, bind(JSON.stringify(values[key]))] as const),
    );
    const attempts = keys.includes("attempts")
      ? `, max_attempts = ${bind(values.attempts)}`
      : "";
    const priority = keys.includes("priority")
      ? `, priority = ${bind(values.priority)}`
      : "";
    const where = `ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
        AND state = ${bind(state)} AND id IN (${ids.map((id) => bind(id)).join(", ")})`;

    await this.#run(
      `UPDATE ${this.#tables.jobs} SET opts = ${opts}${attempts}${priority}
        WHERE ${where}`,
      params,
      tx,
    );
  }

  /**
   * Whether the rewrite walk has anything left from `states[0]` after
   * `floor`, or in any later state — each an index probe for one row.
   */
  async #rewriteRemains(
    q: QueueRef,
    states: JobState[],
    floor: ClaimCursor | null,
  ): Promise<boolean> {
    for (const [index, state] of states.entries()) {
      const { bind, values } = this.#binder();
      const after = index === 0 ? floor : null;
      const row = await this.#one<{ id: string }>(
        `SELECT id FROM ${this.#tables.jobs}
          WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
            AND state = ${bind(state)}${
              after ? ` AND ${this.dialect.claimOrderAfter(bind, after)}` : ""
            }
          LIMIT 1`,
        values,
      );

      if (row) {
        return true;
      }
    }

    return false;
  }

  /**
   * Appends a line to a job's log.
   *
   * Lines belong to a job through its `log_key`, a random token the job is
   * given the first time it logs anything. An id repeats, and so does a
   * `created_at` — a job completed with `removeOnComplete` and re-added under
   * its id lands in the same millisecond most of the time — but a re-added job
   * starts with no key, so none of the old lines are its.
   */
  async addJobLog(
    q: QueueRef,
    id: string,
    line: string,
    keep: number,
  ): Promise<number> {
    await this.connect();

    return await this.#requireLogKey(async () => {
      // Every line after the first: the job has its key, and the insert reads
      // it in the same statement, so `jobs` is not written to at all.
      const added = await this.#insertLogLine(q, id, line);

      if (added === 0) {
        // Either the job's first line, or no such job. Stamping answers both.
        const key = await this.#stampLogKey(q, id);

        if (key === null) {
          return 0;
        }

        const { bind, values } = this.#binder();
        await this.#runPoint(
          `INSERT INTO ${this.#tables.logs} (ns, queue, job_id, log_key, message)
           VALUES (${bind(q.ns)}, ${bind(q.queue)}, ${bind(id)}, ${bind(key)}, ${bind(line)})`,
          values,
        );
      }

      if (keep > 0) {
        await this.#trimJobLog(q, id, keep);
      }

      return await this.#countJobLogs(q, id);
    });
  }

  async getJobLogs(
    q: QueueRef,
    id: string,
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<{ logs: string[]; count: number }> {
    await this.connect();

    return await this.#requireLogKey(async () => {
      const page = this.#binder();
      const [rows, count] = await Promise.all([
        this.#all<{ message: string }>(
          `SELECT l.message ${this.#logsOfJob(q, id, page.bind)}
            ORDER BY l.seq ${opts.order === "desc" ? "DESC" : "ASC"}
            LIMIT ${page.bind(opts.limit)} OFFSET ${page.bind(opts.offset)}`,
          page.values,
        ),
        this.#countJobLogs(q, id),
      ]);

      return { logs: rows.map((row) => String(row.message)), count };
    });
  }

  /**
   * Empties a job's log, refusing an active job.
   *
   * One transaction that holds the job's row from the state check to the
   * write — `FOR UPDATE` on Postgres, MySQL and MariaDB, the database's write
   * lock (`BEGIN IMMEDIATE`) on SQLite — so a claim landing mid-clear waits
   * behind it, and a job claimed first answers `active` with nothing removed.
   *
   * The key is rotated as well as its lines deleted. Nulling `log_key` is what
   * makes the next line count from one: it is stamped a fresh key, exactly as
   * a job that never logged is. The delete is what makes the lines really go,
   * and what `removed` counts. A line a concurrent append wrote under the old
   * key after the delete belongs to no job's key any more, so no read counts
   * it and the orphan sweep collects it, as it does a removed job's.
   */
  async clearJobLogs(q: QueueRef, id: string): Promise<ClearJobLogsResult> {
    await this.connect();

    return await this.#requireLogKey(
      async () =>
        await this.dialect.transaction(
          this.#sql,
          async (tx): Promise<ClearJobLogsResult> => {
            const { jobs, logs } = this.#tables;
            const lock = this.adapter === "sqlite" ? "" : " FOR UPDATE";

            const read = this.#binder();
            const job = await this.#one<{
              state: string;
              log_key: string | null;
            }>(
              `SELECT state, log_key FROM ${jobs}
                WHERE ns = ${read.bind(q.ns)} AND queue = ${read.bind(q.queue)}
                  AND id = ${read.bind(id)}${lock}`,
              read.values,
              tx,
            );

            if (!job) {
              return { status: "missing" };
            }
            if (job.state === "active") {
              return { status: "active" };
            }
            // Never logged: nothing to rotate and nothing to delete.
            if (job.log_key == null) {
              return { status: "cleared", removed: 0 };
            }

            const rotate = this.#binder();
            await this.#runPoint(
              `UPDATE ${jobs} SET log_key = NULL
                WHERE ns = ${rotate.bind(q.ns)} AND queue = ${rotate.bind(q.queue)}
                  AND id = ${rotate.bind(id)}`,
              rotate.values,
              tx,
            );

            const drop = this.#binder();
            const removed = await this.#run(
              `DELETE FROM ${logs}
                WHERE ns = ${drop.bind(q.ns)} AND queue = ${drop.bind(q.queue)}
                  AND log_key = ${drop.bind(String(job.log_key))}`,
              drop.values,
              tx,
            );

            return { status: "cleared", removed };
          },
        ),
    );
  }

  async getJob(q: QueueRef, id: string): Promise<JobRecord | null> {
    await this.connect();

    const { bind, values } = this.#binder();
    const row = await this.#one<Record<string, unknown>>(
      `SELECT * FROM ${this.#tables.jobs}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}`,
      values,
    );

    return row ? this.#toRecord(row) : null;
  }

  /**
   * Records a child's outcome on its parent: one transaction that locks the
   * parent's row, decides from what it holds, and writes the result back.
   *
   * Atomic per engine through {@link SqlDriver.#lockFlow} — a row lock on
   * Postgres, MySQL and MariaDB (READ COMMITTED, retried on a deadlock by the
   * dialect), the write lock on SQLite. A single conditional `UPDATE` cannot
   * express it portably: the repeat check is a key lookup inside a JSON
   * document, and each engine spells that differently.
   *
   * The write is still conditional on `state = 'waiting-children'`, which the
   * lock already guarantees — it keeps a mistake here from moving a job that
   * has already moved on.
   */
  async recordChild(
    q: QueueRef,
    parentId: string,
    child: JobRef,
    outcome: ChildOutcome,
    now: number,
  ): Promise<ChildRecordResult> {
    await this.connect();

    const { result, released } = await this.dialect.transaction(
      this.#sql,
      async (
        tx,
      ): Promise<{ result: ChildRecordResult; released?: JobState }> => {
        const parent = await this.#lockFlow(tx, q, parentId);
        const flow = parent?.flow;

        // A job that does not list this child is not its parent.
        if (!parent || !flow || !listsChild(flow, child)) {
          return { result: "missing" };
        }

        // Repeat-safety: a child already counted off is never counted twice,
        // which is what lets a crash between completing and recording heal by
        // recording again.
        const key = flowKey(child);
        if (
          Object.hasOwn(flow.values, key) ||
          Object.hasOwn(flow.failures, key)
        ) {
          return { result: "already" };
        }

        const settles = outcome.completed || outcome.ignored;

        if (parent.state === "dead") {
          if (!settles) {
            // That child stays unsettled, for a retry of the parent to wait on.
            return { result: "parent-dead" };
          }

          // Kept for a retry of the parent, which then does not wait on it.
          if (outcome.completed) {
            flow.values[key] = outcome.value ?? null;
          } else {
            flow.failures[key] = outcome.error;
          }

          const keep = this.#binder();
          await this.#run(
            `UPDATE ${this.#tables.jobs}
                SET flow = ${keep.bind(this.dialect.jsonIn(flow))}
              WHERE ns = ${keep.bind(q.ns)} AND queue = ${keep.bind(q.queue)}
                AND id = ${keep.bind(parentId)} AND state = 'dead'`,
            keep.values,
            tx,
          );
          return { result: "recorded" };
        }

        if (parent.state !== "waiting-children") {
          return { result: "already" };
        }

        if (!settles) {
          // A failure decided from an earlier view is stale, and must not
          // bury a parent that has been retried since: one already delivered
          // (the child is marked recorded), or one the child has moved past
          // (it was retried itself, which resets `recorded`, so only its
          // state — no longer `dead` — tells it apart). The child's row is
          // read here, inside the transaction holding the parent's, so no
          // retry of the parent can land between this read and the bury: a
          // retry marks the child recorded before it requeues the parent, and
          // the requeue waits on this lock. Read, not locked — locking the
          // child while holding the parent could deadlock against a writer
          // that holds the child and wants the parent. A child with no record
          // at all still buries, as one that failed again does.
          if (await this.#staleFailure(tx, q.ns, child)) {
            return { result: "already" };
          }

          // A child that failed buries its parent, which can then never run.
          // `flow` is left as it is: a retry of the parent keeps the values of
          // the children that did complete.
          const bury = this.#binder();
          await this.#run(
            `UPDATE ${this.#tables.jobs}
                SET state = 'dead', finished_on = ${bury.bind(now)},
                    failed_reason = ${bury.bind(this.dialect.jsonIn(outcome.error))}
              WHERE ns = ${bury.bind(q.ns)} AND queue = ${bury.bind(q.queue)}
                AND id = ${bury.bind(parentId)} AND state = 'waiting-children'`,
            bury.values,
            tx,
          );
          return { result: "buried" };
        }

        if (outcome.completed) {
          flow.values[key] = outcome.value ?? null;
        } else {
          flow.failures[key] = outcome.error;
        }

        flow.pending = Math.max(0, flow.pending - 1);
        const state: JobState =
          flow.pending > 0
            ? "waiting-children"
            : parent.runAt > now
              ? "delayed"
              : "waiting";

        const update = this.#binder();
        await this.#run(
          `UPDATE ${this.#tables.jobs}
              SET state = ${update.bind(state)},
                  flow = ${update.bind(this.dialect.jsonIn(flow))}
            WHERE ns = ${update.bind(q.ns)} AND queue = ${update.bind(q.queue)}
              AND id = ${update.bind(parentId)} AND state = 'waiting-children'`,
          update.values,
          tx,
        );

        return {
          result: state === "waiting-children" ? "recorded" : "released",
          released: state,
        };
      },
    );

    // A parent buried by a failed child is a failure. Counted after the commit,
    // so a transaction that rolled back counts nothing.
    if (result === "buried") {
      this.#throughput().add(q, now, 0, 1);
      this.#countQueueJobs(q, now, 0, 1);
    }

    // After the commit, so a woken worker's claim can see the row.
    if (released === "waiting") {
      await this.#announce(q);
    }

    return result;
  }

  /**
   * Returns a parent buried by a child's failure to `waiting-children`, in
   * one transaction under the same row lock as {@link SqlDriver.recordChild}.
   */
  async requeueParent(q: QueueRef, id: string, now: number): Promise<boolean> {
    await this.connect();

    const moved = await this.dialect.transaction(
      this.#sql,
      async (tx): Promise<JobState | null> => {
        const job = await this.#lockFlow(tx, q, id);

        if (!job || job.state !== "dead" || !job.flow) {
          return null;
        }

        // Counted under the row lock, so an outcome recorded in the meantime
        // is never counted as still to come. `recorded` is cleared as a retry
        // clears it: the outcome this parent ends with next time has not
        // reached its own parent, and without this a nested parent that fails
        // again would have that failure refused as already delivered.
        const flow: JobFlow = {
          ...job.flow,
          pending: unsettledChildren(job.flow),
          recorded: false,
        };
        const state: JobState =
          flow.pending > 0
            ? "waiting-children"
            : job.runAt > now
              ? "delayed"
              : "waiting";

        const { bind, values } = this.#binder();
        await this.#run(
          `UPDATE ${this.#tables.jobs}
              SET state = ${bind(state)},
                  flow = ${bind(this.dialect.jsonIn(flow))},
                  failed_reason = NULL, finished_on = NULL, expires_at = NULL
            WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
              AND id = ${bind(id)} AND state = 'dead'`,
          values,
          tx,
        );

        return state;
      },
    );

    if (moved === "waiting") {
      await this.#announce(q);
    }

    return moved !== null;
  }

  /**
   * Marks a child recorded on its parent, then applies the retention its
   * finishing deferred — the same three effects `completeJob` and `failJob`
   * have: removal, an expiry for a TTL, and the per-state count sweep.
   *
   * The flag and the expiry are one locked read-modify-write; the removal and
   * the sweep follow it, as they follow the finishing write in those methods.
   */
  async markChildRecorded(
    q: QueueRef,
    id: string,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    await this.connect();

    const state = await this.dialect.transaction(
      this.#sql,
      async (tx): Promise<JobState | null> => {
        const job = await this.#lockFlow(tx, q, id);

        if (!job) {
          return null;
        }

        const flow: JobFlow = {
          parent: job.flow?.parent ?? null,
          children: job.flow?.children ?? [],
          pending: job.flow?.pending ?? 0,
          values: job.flow?.values ?? {},
          failures: job.flow?.failures ?? {},
          recorded: true,
        };

        const finished = job.state === "completed" || job.state === "dead";
        const ttl = this.#ttlOf(retention);
        const { bind, values } = this.#binder();
        await this.#run(
          `UPDATE ${this.#tables.jobs}
              SET flow = ${bind(this.dialect.jsonIn(flow))}${
                finished
                  ? `, expires_at = ${bind(ttl === null ? null : now + ttl)}`
                  : ""
              }
            WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}`,
          values,
          tx,
        );

        return job.state;
      },
    );

    if (state === null) {
      return false;
    }

    if (state === "completed" || state === "dead") {
      await this.#applyRetention(q, id, state, retention, now);
    }

    return true;
  }

  async listJobs(
    q: QueueRef,
    states: JobState[],
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<JobRecord[]> {
    await this.connect();

    const { bind, values } = this.#binder();

    // A single state is listed in its own natural order — the one every driver
    // shares, see `JobsDriver.listJobs` — and several states share only
    // creation time. The id breaks ties, so a page boundary is stable.
    const order = this.#listOrder(states, opts.order);

    const rows = await this.#all<Record<string, unknown>>(
      `SELECT * FROM ${this.#tables.jobs}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
          AND state IN (${states.map((state) => bind(state)).join(", ")})
        ORDER BY ${order}
        LIMIT ${bind(opts.limit)} OFFSET ${bind(opts.offset)}`,
      values,
    );

    return rows.map((row) => this.#toRecord(row));
  }

  async countJobs(q: QueueRef): Promise<Record<JobState, number>> {
    await this.connect();

    const { bind, values } = this.#binder();
    const rows = await this.#all<{ state: JobState; total: number | string }>(
      `SELECT state, COUNT(*) AS total FROM ${this.#tables.jobs}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
        GROUP BY state`,
      values,
    );

    const counts = {
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      dead: 0,
      "waiting-children": 0,
    } satisfies Record<JobState, number>;

    for (const row of rows) {
      if (STATES.includes(row.state)) {
        counts[row.state] = Number(row.total);
      }
    }

    return counts;
  }

  /**
   * The `ORDER BY` a listing uses: a single state in its own natural order,
   * several by creation, the id breaking ties so a page boundary is stable.
   * Shared by `listJobs` and `findJobs`, which must agree.
   */
  #listOrder(states: JobState[], order: "asc" | "desc"): string {
    const direction = order === "desc" ? "DESC" : "ASC";
    const single = states.length === 1 ? states[0] : undefined;
    const columns =
      single === "waiting"
        ? ["priority", "created_at"]
        : single === "delayed" || single === "failed"
          ? ["run_at"]
          : single === "active"
            ? ["lock_expires_at"]
            : single === "completed" || single === "dead"
              ? ["finished_on"]
              : ["created_at"];

    return [...columns, "id"]
      .map((column) => `${column} ${direction}`)
      .join(", ");
  }

  /**
   * A filtered page and its total, as two statements at most: the page, and
   * a `COUNT(*)` with the same conditions when a total is asked for.
   *
   * No index serves a name or a substring, so both are conditions applied
   * within the `(ns, queue, state)` range the claim index already reads — rows
   * of those states in that queue are looked at, and nothing else. A search is
   * `LOWER(id) LIKE … OR LOWER(name) LIKE …` with `%`, `_` and the escape
   * character escaped, and never touches `data`.
   */
  async findJobs(q: QueueRef, query: JobQuery): Promise<JobPage> {
    await this.connect();

    const offset = Math.max(0, Math.floor(query.offset));
    const limit = Math.max(0, Math.floor(query.limit));

    const attribution = attributionFilter(query);

    if (
      query.states.length === 0 ||
      query.names?.length === 0 ||
      (attribution !== null && matchesNothing(attribution, query.states))
    ) {
      return query.total ? { jobs: [], total: 0 } : { jobs: [] };
    }

    // A range matches only finished jobs, so the other states are not even
    // looked at. The order stays the one the query's own states give it, as
    // on every backend.
    const range = attribution !== null && hasRange(attribution);
    const states = range
      ? query.states.filter((state) => FINISHED_STATES.includes(state))
      : query.states;
    const workerKeys = query.workerKeys && [...new Set(query.workerKeys)];
    const workerIds = query.workerIds && [...new Set(query.workerIds)];

    const search =
      query.search === undefined || query.search === ""
        ? undefined
        : `%${escapeLike(query.search.toLowerCase())}%`;
    const names =
      query.names === undefined ? undefined : [...new Set(query.names)];

    const where = (bind: (value: unknown) => string): string =>
      [
        `ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}`,
        `state IN (${states.map((state) => bind(state)).join(", ")})`,
        ...(names
          ? [`name IN (${names.map((name) => bind(name)).join(", ")})`]
          : []),
        ...(search
          ? [
              `(LOWER(id) LIKE ${bind(search)} ESCAPE '!' OR LOWER(name) LIKE ${bind(search)} ESCAPE '!')`,
            ]
          : []),
        // The stamp, matched exactly. Its columns outlive the settle, and a
        // job with no stamp (or no key) has NULL there, which `IN` never
        // matches. Not `worker_id`: that is the holder, gone once it settles.
        ...(workerKeys
          ? [
              `processed_by_key IN (${workerKeys.map((key) => bind(key)).join(", ")})`,
            ]
          : []),
        ...(workerIds
          ? [
              `processed_by_id IN (${workerIds.map((id) => bind(id)).join(", ")})`,
            ]
          : []),
        // Spelled out, although each bound implies it: a planner does not
        // infer it from a bound parameter. On SQLite it is what lets the
        // partial index on finished jobs serve the range; that index exists
        // on SQLite only, and Postgres, MySQL and MariaDB serve the range
        // without it, from the (ns, queue, state) prefix of their indexes.
        ...(range ? ["finished_on IS NOT NULL"] : []),
        ...(attribution?.finishedFrom === undefined
          ? []
          : [`finished_on >= ${bind(attribution.finishedFrom)}`]),
        ...(attribution?.finishedTo === undefined
          ? []
          : [`finished_on < ${bind(attribution.finishedTo)}`]),
      ].join(" AND ");

    const page = async (): Promise<JobRecord[]> => {
      if (limit === 0) {
        return [];
      }

      const { bind, values } = this.#binder();
      const rows = await this.#all<Record<string, unknown>>(
        `SELECT * FROM ${this.#tables.jobs}
          WHERE ${where(bind)}
          ORDER BY ${
            sortsByCreated(query)
              ? createdAtOrder(this.dialect, query.order)
              : this.#listOrder(query.states, query.order)
          }
          LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
        values,
      );

      return rows.map((row) => this.#toRecord(row));
    };

    const count = async (): Promise<number> => {
      const { bind, values } = this.#binder();
      const row = await this.#one<{ total: number | string }>(
        `SELECT COUNT(*) AS total FROM ${this.#tables.jobs} WHERE ${where(bind)}`,
        values,
      );
      return Number(row?.total ?? 0);
    };

    const [jobs, total] = await this.#requireStampColumns(
      workerKeys !== undefined || workerIds !== undefined,
      async () =>
        await Promise.all([
          page(),
          query.total ? count() : Promise.resolve(undefined),
        ]),
    );

    return total === undefined ? { jobs } : { jobs, total };
  }

  /** Several jobs by id: one `IN (…)` per 500 distinct ids. */
  async getJobs(q: QueueRef, ids: string[]): Promise<(JobRecord | null)[]> {
    await this.connect();

    const distinct = [...new Set(ids)];
    const found = new Map<string, JobRecord | null>();

    for (let at = 0; at < distinct.length; at += 500) {
      const chunk = distinct.slice(at, at + 500);
      const { bind, values } = this.#binder();
      const rows = await this.#all<Record<string, unknown>>(
        `SELECT * FROM ${this.#tables.jobs}
          WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
            AND id IN (${chunk.map((id) => bind(id)).join(", ")})`,
        values,
      );

      for (const row of rows) {
        const record = this.#toRecord(row);
        found.set(record.id, record);
      }
    }

    return orderByIds(ids, found);
  }

  /** One upsert on the worker's primary key, then a delete of the queue's lapsed records. */
  async registerWorker(q: QueueRef, worker: WorkerInfo): Promise<void> {
    await this.connect();

    await this.#runPoint(
      this.dialect.upsert(
        this.#tables.workers,
        ["ns", "queue", "id", "info", "expires_at"],
        ["ns", "queue", "id"],
        ["info", "expires_at"],
      ),
      [q.ns, q.queue, worker.id, this.dialect.jsonIn(worker), worker.expiresAt],
    );

    // Records lapsed as of this report, so a dead worker's row goes when any
    // live one reports rather than only when somebody lists. A range of the
    // primary key, once per report — never per job.
    const lapsed = this.#binder();
    await this.#run(
      `DELETE FROM ${this.#tables.workers}
        WHERE ns = ${lapsed.bind(q.ns)} AND queue = ${lapsed.bind(q.queue)}
          AND expires_at <= ${lapsed.bind(worker.heartbeatAt)}`,
      lapsed.values,
    );
  }

  async removeWorker(q: QueueRef, id: string): Promise<boolean> {
    await this.connect();

    const { bind, values } = this.#binder();
    return (
      (await this.#runPoint(
        `DELETE FROM ${this.#tables.workers}
          WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}`,
        values,
      )) > 0
    );
  }

  /**
   * The live records, after deleting the queue's lapsed ones. Both statements
   * are ranges of the primary key.
   */
  async listWorkers(q: QueueRef, now: number): Promise<WorkerInfo[]> {
    await this.connect();

    const lapsed = this.#binder();
    await this.#run(
      `DELETE FROM ${this.#tables.workers}
        WHERE ns = ${lapsed.bind(q.ns)} AND queue = ${lapsed.bind(q.queue)}
          AND expires_at <= ${lapsed.bind(now)}`,
      lapsed.values,
    );

    const { bind, values } = this.#binder();
    const rows = await this.#all<{ info: unknown }>(
      `SELECT info FROM ${this.#tables.workers}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
          AND expires_at > ${bind(now)}`,
      values,
    );

    return sortWorkers(
      rows
        .map((row) => this.dialect.jsonOut<WorkerInfo | null>(row.info, null))
        .filter((worker): worker is WorkerInfo => worker !== null),
    );
  }

  /** One `GROUP BY queue, state` over the namespace's rows. */
  async countJobsByQueue(
    ns: string,
  ): Promise<Record<string, Record<JobState, number>>> {
    await this.connect();

    const { bind, values } = this.#binder();
    const rows = await this.#all<{
      queue: string;
      state: JobState;
      total: number | string;
    }>(
      `SELECT queue, state, COUNT(*) AS total FROM ${this.#tables.jobs}
        WHERE ns = ${bind(ns)}
        GROUP BY queue, state`,
      values,
    );

    const result: Record<string, Record<JobState, number>> = {};

    for (const row of rows) {
      const counts = (result[String(row.queue)] ??= emptyCounts());
      if (STATES.includes(row.state)) {
        counts[row.state] = Number(row.total);
      }
    }

    return result;
  }

  /**
   * One `GROUP BY queue, state` over the namespace's rows added in the range
   * ({@link countAddedStatement}); `{}` without a query when `to <= from`.
   * Counts arrive as strings on Postgres and MySQL once they are big, so each
   * is read through `Number()`.
   */
  async countAddedJobs(
    ns: string,
    range: AddedRange,
    queue?: string,
  ): Promise<Record<string, Record<JobState, number>>> {
    if (rangeMatchesNothing(range)) {
      return {};
    }

    await this.connect();

    const { bind, values } = this.#binder();
    const rows = await this.#all<{
      queue: string;
      state: JobState;
      total: number | string;
    }>(
      countAddedStatement(this.dialect, this.#tables.jobs, bind, {
        ns,
        ...(queue === undefined ? {} : { queue }),
        from: range.from,
        to: range.to,
      }),
      values,
    );

    const result: Record<string, Record<JobState, number>> = {};

    for (const row of rows) {
      const counts = (result[String(row.queue)] ??= emptyAddedCounts());
      if (STATES.includes(row.state)) {
        counts[row.state] = Number(row.total);
      }
    }

    return result;
  }

  /**
   * A queue's minutes in range, summed across the rows each minute has — one
   * per counting worker on Postgres, one per process elsewhere. Writes this
   * driver's own pending counts first, so a caller sees its own completions.
   */
  async getThroughput(
    q: QueueRef,
    range: { from: number; to: number },
  ): Promise<ThroughputBucket[]> {
    await this.connect();
    await this.#throughputBuffer?.flush();
    await Promise.allSettled([...this.#metricsPrunes]);

    const { bind, values } = this.#binder();
    const rows = await this.#all<{
      bucket: number | string;
      completed: number | string;
      failed: number | string;
    }>(
      `SELECT bucket, SUM(completed) AS completed, SUM(failed) AS failed
         FROM ${this.#tables.metrics}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
          AND bucket >= ${bind(range.from)} AND bucket <= ${bind(range.to)}
        GROUP BY bucket`,
      values,
    );

    return sumBuckets(
      rows.map((row) => ({
        at: Number(row.bucket),
        completed: Number(row.completed),
        failed: Number(row.failed),
      })),
      range,
    );
  }

  /**
   * Runs a completion or failure statement and counts it in the queue's
   * throughput, answering how many jobs it settled.
   *
   * On Postgres the count is part of the statement — see
   * {@link SqlDriver.#countedStatement} — so a job pays one extra row write
   * inside the round trip it was already making, and nothing more. Elsewhere
   * no single statement can both change a job and bump a counter in another
   * table, so the count goes to the in-memory buffer, which writes once a
   * second: a `Map` update per job and no I/O.
   *
   * `statement` must bind with `bind`, whose values are `values`.
   */
  async #settle(
    q: QueueRef,
    now: number,
    kind: "completed" | "failed",
    statement: string,
    bind: (value: unknown) => string,
    values: unknown[],
  ): Promise<number> {
    if (this.adapter === "postgres") {
      const rows = await this.#all(
        this.#countedStatement(
          q,
          now,
          kind,
          this.#takeMetricsShard(),
          `${statement} RETURNING id`,
          bind,
        ),
        values,
      );

      if (rows.length > 0) {
        this.#afterCounted(q, now);
        this.#countQueueJobs(
          q,
          now,
          kind === "completed" ? rows.length : 0,
          kind === "failed" ? rows.length : 0,
        );
      }

      return rows.length;
    }

    const settled = await this.#runPoint(statement, values);

    if (settled > 0) {
      this.#throughput().add(
        q,
        now,
        kind === "completed" ? settled : 0,
        kind === "failed" ? settled : 0,
      );
      this.#countQueueJobs(
        q,
        now,
        kind === "completed" ? settled : 0,
        kind === "failed" ? settled : 0,
      );
    }

    return settled;
  }

  /**
   * Wraps a Postgres statement ending in `RETURNING id` so the same statement
   * adds the rows it changed to the minute's counter, and answers with those
   * ids.
   *
   * A data-modifying CTE runs exactly once whether the outer query reads it or
   * not, and `HAVING COUNT(*) > 0` means a statement that changed nothing —
   * a lost lock — writes no counter row at all. The counter columns are not
   * indexed, so the update is a HOT update.
   *
   * `shard` is one of this driver's {@link METRICS_SHARDS} counter rows, taken
   * in turn per statement. It used to be the lock token, on the reasoning that
   * a worker's completion batcher serialises its writes — but only completions
   * are batched. A worker's failures run beside them and beside each other,
   * and under one token they all queued on one row lock, each behind the whole
   * of the statement ahead of it: measured, a failure waited 1,421ms behind a
   * held counter row, against 2ms with the row free. Taking rows in turn,
   * statements in flight together land on different rows unless more than
   * {@link METRICS_SHARDS} are.
   */
  #countedStatement(
    q: QueueRef,
    now: number,
    kind: "completed" | "failed",
    shard: string,
    inner: string,
    bind: (value: unknown) => string,
  ): string {
    if (this.adapter !== "postgres") {
      throw new DriverError(
        "sql",
        "countedStatement",
        new Error("counting inside a statement is Postgres-only"),
        { adapter: this.adapter },
      );
    }

    const counted = "COUNT(*)";

    return `WITH done AS (${inner}),
      counted AS (
        INSERT INTO ${this.#tables.metrics} AS metrics
          (ns, queue, bucket, shard, completed, failed)
        SELECT ${bind(q.ns)}::text, ${bind(q.queue)}::text,
               ${bind(throughputBucket(now))}::bigint, ${bind(shard)}::text,
               ${kind === "completed" ? counted : "0"},
               ${kind === "failed" ? counted : "0"}
          FROM done
        HAVING COUNT(*) > 0
        ON CONFLICT (ns, queue, bucket, shard) DO UPDATE
          SET completed = metrics.completed + EXCLUDED.completed,
              failed = metrics.failed + EXCLUDED.failed
      )
      SELECT id FROM done`;
  }

  /** The counter row the next counted statement takes, in turn. */
  #takeMetricsShard(): string {
    const shard = this.#metricsShards[this.#nextMetricsShard]!;
    this.#nextMetricsShard = (this.#nextMetricsShard + 1) % METRICS_SHARDS;
    return shard;
  }

  /**
   * After a Postgres statement counted, removes the queue's minutes past the
   * retention — once per queue per minute in this process, and unawaited, so
   * the completion that triggered it does not wait for it.
   */
  #afterCounted(q: QueueRef, now: number): void {
    const bucket = throughputBucket(now);
    const key = `${q.ns}\n${q.queue}`;

    if (
      (this.#metricsPrunedFor.get(key) ?? Number.NEGATIVE_INFINITY) >= bucket
    ) {
      return;
    }

    this.#metricsPrunedFor.set(key, bucket);

    const prune: Promise<void> = this.#pruneMetrics(q, bucket)
      .catch(() => undefined)
      .finally(() => this.#metricsPrunes.delete(prune));
    this.#metricsPrunes.add(prune);
  }

  /** Deletes a queue's minutes older than the retention before `latest`. */
  async #pruneMetrics(q: QueueRef, latest: number): Promise<void> {
    const { bind, values } = this.#binder();
    await this.#run(
      `DELETE FROM ${this.#tables.metrics}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
          AND bucket < ${bind(latest - THROUGHPUT_RETENTION_MS)}`,
      values,
    );
  }

  /** The throughput buffer, made on first use. */
  #throughput(): ThroughputBuffer {
    this.#throughputBuffer ??= new ThroughputBuffer(
      async (batch) => await this.#writeThroughput(batch),
    );
    return this.#throughputBuffer;
  }

  /**
   * Writes one second's gathered counts, and answers with the ones that did
   * not land: an additive upsert per queue and minute, under this driver's own
   * shard so no other process contends for the row, then the retention delete
   * for each queue whose latest minute moved on.
   *
   * Each upsert stands alone, so one that fails is reported on its own and the
   * rest are never written twice by a retry. The retention delete is
   * best-effort: counts that landed stay landed whatever it does, and a delete
   * that failed is tried again on the next write.
   */
  async #writeThroughput(
    batch: PendingThroughput[],
  ): Promise<ThroughputWriteResult> {
    const table = this.#tables.metrics;
    // Postgres needs the existing row's columns qualified — unqualified they
    // are ambiguous beside `EXCLUDED` — and takes an alias for it; SQLite reads
    // them unqualified, and MySQL and MariaDB have a clause of their own.
    const into = this.adapter === "postgres" ? `${table} AS metrics` : table;
    const onConflict =
      this.adapter === "mysql" || this.adapter === "mariadb"
        ? "ON DUPLICATE KEY UPDATE completed = completed + VALUES(completed), failed = failed + VALUES(failed)"
        : this.adapter === "postgres"
          ? "ON CONFLICT (ns, queue, bucket, shard) DO UPDATE SET completed = metrics.completed + EXCLUDED.completed, failed = metrics.failed + EXCLUDED.failed"
          : "ON CONFLICT (ns, queue, bucket, shard) DO UPDATE SET completed = completed + excluded.completed, failed = failed + excluded.failed";
    const latest = new Map<string, { q: QueueRef; at: number }>();
    const unwritten: PendingThroughput[] = [];
    let failure: unknown;

    for (const entry of batch) {
      const { bind, values } = this.#binder();

      try {
        await this.#runPoint(
          `INSERT INTO ${into} (ns, queue, bucket, shard, completed, failed)
           VALUES (${bind(entry.q.ns)}, ${bind(entry.q.queue)}, ${bind(entry.at)},
                   ${bind(this.#metricsShard)}, ${bind(entry.completed)}, ${bind(entry.failed)})
           ${onConflict}`,
          values,
        );
      } catch (error) {
        unwritten.push(entry);
        failure ??= error;
        continue;
      }

      const key = `${entry.q.ns}\n${entry.q.queue}`;
      const seen = latest.get(key);
      if (!seen || seen.at < entry.at) {
        latest.set(key, { q: entry.q, at: entry.at });
      }
    }

    for (const [key, { q, at }] of latest) {
      if ((this.#metricsPrunedFor.get(key) ?? Number.NEGATIVE_INFINITY) >= at) {
        continue;
      }

      try {
        await this.#pruneMetrics(q, at);
        this.#metricsPrunedFor.set(key, at);
      } catch {
        // Left unmarked, so the next write for this queue tries again.
      }
    }

    return failure === undefined
      ? { unwritten }
      : { unwritten, error: failure };
  }

  /**
   * Writes the counts gathered in memory and not yet written, and waits out
   * any retention delete still running. See the contract for who calls it.
   */
  async flushThroughput(): Promise<void> {
    await this.#throughputBuffer?.flush();
    await Promise.allSettled([...this.#metricsPrunes]);
  }

  /* --- analytics ---------------------------------------------------- */

  /**
   * The analytics buckets, in three tables of their own.
   *
   * ```
   * <prefix>queue_metrics    (ns, entity, interval_ms, bucket)  completed, failed
   * <prefix>worker_metrics   (ns, entity, interval_ms, bucket)  completed, failed + busyness
   * <prefix>runner_metrics   (ns, entity, interval_ms, bucket)  six outcomes + durations
   * ```
   *
   * `entity` is the queue, a worker's `<queue>:<key>` or the runner's key, and
   * the empty entity is that kind's **namespace roll-up** — which is what
   * makes an overview three reads whatever the fleet size, and what keeps the
   * prune and `purge` free of a special case.
   *
   * Three things about this layout are load-bearing:
   *
   * - **One shared row per `(ns, entity, bucket, interval)`, and none of the
   *   shipped `metrics` table's shard fan-out.** Those eight shards per
   *   process exist because a *per-job* statement contends on one row — 1,421
   *   ms against 2 ms, measured. Nothing here is per job: every count goes
   *   through a buffer that writes once a second, so each process touches each
   *   row once a second and that contention cannot arise. Fanning out anyway
   *   would turn a mid-sized namespace's 19.5 K rows into 1.25 M, churning
   *   completely every retention window.
   * - **Second and minute are a dual write**, not a roll-up job: one count
   *   bumps both, so nothing needs a leader and no minute is lost when one
   *   dies.
   * - **The prune is by range**, on a clock, once a minute per process — never
   *   per entity, because a worker that stopped reporting writes nothing and
   *   an entity-driven prune would never reach its buckets again.
   *
   * Every count is buffered on every engine, Postgres included: this is the
   * one thing that deliberately does **not** ride the counted statement.
   */

  /** What this driver records and serves, for `/meta` and range resolution. */
  getMetricsSupport(): MetricsSupport {
    return metricsSupportOf(this.#analytics);
  }

  /**
   * Writes every analytics count gathered in memory and not yet sent.
   *
   * A count here is a `Map` update, so a caller that wrote one and reads it
   * back in the same tick has to ask for this first — every read below flushes
   * its own buffer, so in practice only a caller reading through another
   * process needs it.
   */
  async flushMetrics(): Promise<void> {
    const settled = await Promise.allSettled(
      this.#analyticsBuffers().map(async (buffer) => await buffer.flush()),
    );
    const failed = settled.find((result) => result.status === "rejected");

    if (failed) {
      throw failed.reason;
    }
  }

  async getQueueMetrics(
    q: QueueRef,
    query: MetricsQuery,
  ): Promise<CounterBucket<JobCounters>[]> {
    return await this.#readCounters(
      "queue_metrics",
      q.ns,
      q.queue,
      query,
      JOB_COUNTERS,
      this.#queueJobs,
    );
  }

  /**
   * Counts jobs one worker finished, keyed by its stable `WorkerInfo.key`.
   *
   * The worker counts its own and reports once a second: the driver knows the
   * lock token, not the worker, so attributing inside the completion
   * statement would push per-worker cardinality into the hot path.
   */
  async countWorkerJobs(
    q: QueueRef,
    key: string,
    at: number,
    counts: Partial<JobCounters>,
  ): Promise<void> {
    if (!this.#analytics.workers) {
      return;
    }

    this.#analyticsNamespaces.add(q.ns);
    this.#workerJobs.count(q.ns, workerEntity(q, key), at, counts);
  }

  /**
   * Records one heartbeat's view of how busy a worker is.
   *
   * Sampled at the heartbeat's own interval rather than once a second: the
   * heartbeat is the only source, and a second timer would have an idle worker
   * writing forever — the one cost here not bounded by activity.
   */
  async sampleWorkerBusyness(
    q: QueueRef,
    key: string,
    at: number,
    sample: BusynessSample,
  ): Promise<void> {
    if (!this.#analytics.workers) {
      return;
    }

    this.#analyticsNamespaces.add(q.ns);
    const entity = workerEntity(q, key);

    for (const interval of this.#analytics.intervals) {
      const stats = emptyBusynessStats();
      // `at` itself, not the bucket's start: which sample is the latest is
      // what makes a merged bucket's `concurrency` well defined.
      addBusynessSample(stats, at, sample);
      this.#workerBusyness.add({
        ns: q.ns,
        entity,
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
    const entity = workerEntity(q, key);
    const read: WorkerMetricsRead = {
      jobs: await this.#readCounters(
        "worker_metrics",
        q.ns,
        entity,
        query,
        JOB_COUNTERS,
        this.#workerJobs,
      ),
    };

    if (query.busyness && this.#analytics.workers) {
      read.busyness = await this.#readBusyness(q.ns, entity, query);
    }

    return read;
  }

  /**
   * Counts how one run ended, with its duration riding the same call.
   *
   * One call per run event and no second write for the histogram: the bins are
   * columns of the same row, so they cost nothing beyond the statement the
   * outcome was already going to be part of.
   */
  async countRunnerRun(
    ns: string,
    runner: string,
    at: number,
    counts: RunnerRunDelta,
  ): Promise<void> {
    if (!this.#analytics.runners) {
      return;
    }

    this.#analyticsNamespaces.add(ns);
    this.#runnerRuns.count(ns, runner, at, counts);

    if (this.#analytics.durations && counts.durationMs !== undefined) {
      for (const interval of this.#analytics.intervals) {
        const stats = emptyDurationStats();
        addDuration(stats, counts.durationMs);
        this.#runnerDurations.add({
          ns,
          entity: runner,
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
    const read: RunnerMetricsRead = {
      runs: await this.#readCounters(
        "runner_metrics",
        ns,
        runner,
        query,
        RUNNER_RUN_COUNTERS,
        this.#runnerRuns,
      ),
    };

    if (query.durations && this.#analytics.durations) {
      read.durations = await this.#readDurations(ns, runner, query);
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
      read.jobs = await this.#readCounters(
        "queue_metrics",
        ns,
        NAMESPACE_ENTITY,
        query,
        JOB_COUNTERS,
        this.#queueJobs,
      );
    }
    if (query.kinds.includes("runs") && this.#analytics.runners) {
      read.runs = await this.#readCounters(
        "runner_metrics",
        ns,
        NAMESPACE_ENTITY,
        query,
        RUNNER_RUN_COUNTERS,
        this.#runnerRuns,
      );
    }
    if (query.kinds.includes("workerJobs") && this.#analytics.workers) {
      read.workerJobs = await this.#readCounters(
        "worker_metrics",
        ns,
        NAMESPACE_ENTITY,
        query,
        JOB_COUNTERS,
        this.#workerJobs,
      );
    }

    return read;
  }

  /* --- analytics: grouped reads ------------------------------------- */

  /**
   * Every runner's totals over a range, in **one statement**: a `GROUP BY
   * entity` over the `(ns, interval_ms, bucket)` range the prune index
   * already serves, summing in the engine — the histogram's 25 columns
   * included — so the cost is one round trip whatever the fleet size.
   *
   * ```sql
   * SELECT entity, SUM(started) AS started, …                -- six outcomes
   *        [, SUM(dur_count), SUM(dur_sum_ms),
   *           MIN(CASE WHEN dur_count > 0 THEN dur_min_ms END),
   *           MAX(CASE WHEN dur_count > 0 THEN dur_max_ms END),
   *           SUM(h00) … SUM(h24)]                              -- durations asked
   *   FROM runner_metrics
   *  WHERE ns = ? AND interval_ms = ? AND bucket >= ? AND bucket <= ?
   *    AND entity <> ''                                         -- never the roll-up
   *    [AND entity IN (…)]                                      -- the filter
   *  GROUP BY entity
   * HAVING SUM(started) > 0 OR … [OR SUM(dur_count) > 0]
   * ```
   *
   * The extremes skip rows with no duration in them: a row the outcome
   * counters wrote alone has `dur_min_ms = 0`, which would otherwise report
   * the runner's fastest run as instant. `HAVING` is the presence rule — a
   * runner with nothing to report in range is absent, never a row of zeros.
   */
  async getRunnerMetricsTotals(
    ns: string,
    query: RunnerMetricsTotalsQuery,
  ): Promise<RunnerMetricsTotals[]> {
    const range = this.#analyticsRange(query);
    const runners =
      query.runners === undefined ? undefined : [...new Set(query.runners)];

    // An empty filter is "none of them", never "no filter".
    if (!range || runners?.length === 0) {
      return [];
    }

    const durations = query.durations === true && this.#analytics.durations;

    await this.#runnerRuns.flush();
    if (durations) {
      await this.#runnerDurations.flush();
    }
    await this.connect();

    const { bind, values } = this.#binder();
    const sums = [
      ...RUNNER_RUN_COUNTERS.map((key) => `SUM(${key}) AS ${key}`),
      ...(durations
        ? [
            "SUM(dur_count) AS dur_count",
            "SUM(dur_sum_ms) AS dur_sum_ms",
            "MIN(CASE WHEN dur_count > 0 THEN dur_min_ms END) AS dur_min_ms",
            "MAX(CASE WHEN dur_count > 0 THEN dur_max_ms END) AS dur_max_ms",
            ...DURATION_BIN_COLUMNS.map(
              (column) => `SUM(${column}) AS ${column}`,
            ),
          ]
        : []),
    ];
    const present = [
      ...RUNNER_RUN_COUNTERS.map((key) => `SUM(${key}) > 0`),
      ...(durations ? ["SUM(dur_count) > 0"] : []),
    ];
    const where = [
      this.#groupedRange(bind, ns, range),
      ...(runners
        ? [`entity IN (${runners.map((runner) => bind(runner)).join(", ")})`]
        : []),
    ].join(" AND ");

    const rows = await this.#all<Record<string, unknown>>(
      `SELECT entity, ${sums.join(", ")} FROM ${this.#tables.runner_metrics}
        WHERE ${where}
        GROUP BY entity
       HAVING ${present.join(" OR ")}`,
      values,
    );

    return rows.map((row) => {
      const runs = {} as RunnerRunCounters;
      for (const key of RUNNER_RUN_COUNTERS) {
        runs[key] = Number(row[key]) || 0;
      }
      const runner = String(row.entity);
      return durations
        ? { runner, runs, durations: durationStatsOf(row) }
        : { runner, runs };
    });
  }

  /**
   * A batch of runners' series in **one statement** (per
   * {@link METRIC_READ_CHUNK} names), each entry exactly what
   * {@link SqlDriver.getRunnerMetrics} answers for it.
   *
   * ```sql
   * SELECT entity, bucket, started, … [, dur_min_ms, …, h24]
   *   FROM runner_metrics
   *  WHERE ns = ? AND entity <> '' AND entity IN (…)
   *    AND interval_ms = ? AND bucket >= ? AND bucket <= ?
   * ```
   *
   * The rows are grouped by entity here and merged by the very helpers the
   * one-runner read uses, so the two cannot disagree.
   */
  async getRunnerMetricsMany(
    ns: string,
    runners: readonly string[],
    query: RunnerMetricsQuery,
  ): Promise<RunnerMetricsSeries[]> {
    const range = this.#analyticsRange(query);
    const named = [...new Set(runners)].filter(
      (runner) => runner !== NAMESPACE_ENTITY,
    );

    if (!range || named.length === 0) {
      return [];
    }

    const durations = query.durations === true && this.#analytics.durations;

    await this.#runnerRuns.flush();
    if (durations) {
      await this.#runnerDurations.flush();
    }

    const rows = await this.#readManyMetricRows(
      "runner_metrics",
      ns,
      named,
      range,
      [
        ...RUNNER_RUN_COUNTERS,
        ...(durations
          ? [...DURATION_STAT_COLUMNS, ...DURATION_BIN_COLUMNS]
          : []),
      ],
    );

    const series: RunnerMetricsSeries[] = [];
    for (const [runner, group] of rowsByEntity(rows)) {
      const entry: RunnerMetricsSeries = {
        runner,
        runs: counterBucketsOf(group, range, RUNNER_RUN_COUNTERS),
      };
      if (durations) {
        entry.durations = durationBucketsOf(group, range);
      }
      if (hasMetricBuckets(entry.runs, entry.durations)) {
        series.push(entry);
      }
    }
    return series;
  }

  /**
   * Every worker key's totals over a range, in **one statement**, split back
   * into `(queue, key)` with the shared {@link splitWorkerMetricsEntity}.
   *
   * Busyness shares `worker_metrics` rows with the job counters, so the
   * presence rule has to be a `HAVING` on the counters — plus the samples
   * only when busyness was asked for. Without it a worker that only
   * heartbeated would come back as a row of zero jobs; with the samples in it
   * unconditionally, it would come back when busyness was never asked.
   *
   * ```sql
   * SELECT entity, SUM(completed) AS completed, SUM(failed) AS failed
   *   FROM worker_metrics
   *  WHERE ns = ? AND interval_ms = ? AND bucket >= ? AND bucket <= ?
   *    AND entity <> '' [AND (SUBSTR(entity, 1, n) = 'queue:' OR …)]
   *  GROUP BY entity
   * HAVING SUM(completed) > 0 OR SUM(failed) > 0
   * ```
   *
   * With busyness asked, the same over a derived table that carries each
   * entity's latest sample time (`MAX(…) OVER (PARTITION BY entity)`), so the
   * outer `GROUP BY` can take that sample's `concurrency` — a sample's
   * `last_at` lies inside its own bucket, so it is unique within one width —
   * and `OR SUM(samples) > 0` joins the `HAVING`.
   *
   * The queue filter is an exact prefix comparison rather than a `LIKE`:
   * `_` is legal in a queue name and a `LIKE` wildcard, and SQLite's `LIKE`
   * ignores ASCII case.
   */
  async getWorkerMetricsTotals(
    ns: string,
    query: WorkerMetricsTotalsQuery,
  ): Promise<WorkerMetricsTotals[]> {
    const range = this.#analyticsRange(query);
    // A queue name cannot hold a colon, so a filter entry with one names no
    // queue — and as a prefix it would match another queue's keys.
    const queues =
      query.queues === undefined
        ? undefined
        : [...new Set(query.queues)].filter(
            (queue) => queue !== "" && !queue.includes(":"),
          );

    if (!range || queues?.length === 0) {
      return [];
    }

    const busyness = query.busyness === true && this.#analytics.workers;

    await this.#workerJobs.flush();
    if (busyness) {
      await this.#workerBusyness.flush();
    }
    await this.connect();

    const { bind, values } = this.#binder();
    const where = [
      this.#groupedRange(bind, ns, range),
      ...(queues
        ? [
            `(${queues
              .map(
                (queue) =>
                  `SUBSTR(entity, 1, ${[...queue].length + 1}) = ${bind(`${queue}:`)}`,
              )
              .join(" OR ")})`,
          ]
        : []),
    ].join(" AND ");
    const table = this.#tables.worker_metrics;
    const counters = JOB_COUNTERS.map((key) => `SUM(${key}) AS ${key}`);
    const present = JOB_COUNTERS.map((key) => `SUM(${key}) > 0`);

    const text = busyness
      ? `SELECT entity, ${[
          ...counters,
          "SUM(samples) AS samples",
          "SUM(active_sum) AS active_sum",
          "MAX(CASE WHEN samples > 0 THEN active_max END) AS active_max",
          "MAX(CASE WHEN samples > 0 THEN last_at END) AS last_at",
          "MAX(CASE WHEN samples > 0 AND last_at = latest_at THEN concurrency END) AS concurrency",
        ].join(", ")}
          FROM (
            SELECT entity, ${JOB_COUNTERS.join(", ")}, ${BUSYNESS_COLUMNS.join(", ")},
                   MAX(CASE WHEN samples > 0 THEN last_at END) OVER (PARTITION BY entity) AS latest_at
              FROM ${table}
             WHERE ${where}
          ) scoped
         GROUP BY entity
        HAVING ${[...present, "SUM(samples) > 0"].join(" OR ")}`
      : `SELECT entity, ${counters.join(", ")} FROM ${table}
          WHERE ${where}
          GROUP BY entity
         HAVING ${present.join(" OR ")}`;

    const rows = await this.#all<Record<string, unknown>>(text, values);

    const totals: WorkerMetricsTotals[] = [];
    for (const row of rows) {
      const ref = splitWorkerMetricsEntity(String(row.entity));
      if (!ref) {
        continue;
      }
      const jobs = {} as JobCounters;
      for (const key of JOB_COUNTERS) {
        jobs[key] = Number(row[key]) || 0;
      }
      totals.push(
        busyness
          ? { ...ref, jobs, busyness: busynessStatsOf(row) }
          : { ...ref, jobs },
      );
    }
    return totals;
  }

  /**
   * A batch of worker keys' series in **one statement** (per
   * {@link METRIC_READ_CHUNK} names), each entry exactly what
   * {@link SqlDriver.getWorkerMetrics} answers for it — the job counters and,
   * when asked for, the busyness columns of the same rows.
   */
  async getWorkerMetricsMany(
    ns: string,
    workers: readonly WorkerMetricsRef[],
    query: WorkerMetricsQuery,
  ): Promise<WorkerMetricsSeries[]> {
    const range = this.#analyticsRange(query);
    const refs = uniqueWorkerRefs(workers);

    if (!range || refs.length === 0) {
      return [];
    }

    const busyness = query.busyness === true && this.#analytics.workers;

    await this.#workerJobs.flush();
    if (busyness) {
      await this.#workerBusyness.flush();
    }

    const rows = await this.#readManyMetricRows(
      "worker_metrics",
      ns,
      refs.map((ref) => workerMetricsEntity(ref.queue, ref.key)),
      range,
      [...JOB_COUNTERS, ...(busyness ? BUSYNESS_COLUMNS : [])],
    );

    const series: WorkerMetricsSeries[] = [];
    for (const [entity, group] of rowsByEntity(rows)) {
      const ref = splitWorkerMetricsEntity(entity);
      if (!ref) {
        continue;
      }
      const entry: WorkerMetricsSeries = {
        ...ref,
        jobs: counterBucketsOf(group, range, JOB_COUNTERS),
      };
      if (busyness) {
        entry.busyness = busynessBucketsOf(group, range);
      }
      if (hasMetricBuckets(entry.jobs, entry.busyness)) {
        series.push(entry);
      }
    }
    return series;
  }

  /**
   * The conditions every grouped read starts from: one namespace, one width,
   * a bucket range — the prune index's own columns, in its order — and never
   * the namespace roll-up.
   */
  #groupedRange(
    bind: (value: unknown) => string,
    ns: string,
    range: MetricReadRange,
  ): string {
    return (
      `ns = ${bind(ns)} AND interval_ms = ${bind(range.interval)}` +
      ` AND bucket >= ${bind(range.from)} AND bucket <= ${bind(range.to)}` +
      ` AND entity <> ${bind(NAMESPACE_ENTITY)}`
    );
  }

  /**
   * Named entities' stored buckets at one width, one statement per
   * {@link METRIC_READ_CHUNK} names, every row carrying its `entity`.
   */
  async #readManyMetricRows(
    table: SqlTable,
    ns: string,
    entities: readonly string[],
    range: MetricReadRange,
    columns: readonly string[],
  ): Promise<Record<string, unknown>[]> {
    await this.connect();

    const rows: Record<string, unknown>[] = [];
    for (let start = 0; start < entities.length; start += METRIC_READ_CHUNK) {
      const chunk = entities.slice(start, start + METRIC_READ_CHUNK);
      const { bind, values } = this.#binder();
      // Written in the primary key's order, `(ns, entity, interval_ms,
      // bucket)`: a handful of key ranges, one per name.
      rows.push(
        ...(await this.#all<Record<string, unknown>>(
          `SELECT entity, bucket, ${columns.join(", ")} FROM ${this.#tables[table]}
            WHERE ns = ${bind(ns)} AND entity <> ${bind(NAMESPACE_ENTITY)}
              AND entity IN (${chunk.map((entity) => bind(entity)).join(", ")})
              AND interval_ms = ${bind(range.interval)}
              AND bucket >= ${bind(range.from)} AND bucket <= ${bind(range.to)}`,
          values,
        )),
      );
    }
    return rows;
  }

  /**
   * Counts a queue's settled jobs into its analytics series and the
   * namespace's.
   *
   * Called at every site that already counts throughput — both Postgres
   * counted-CTE branches, the buffered branch, a parent buried by a failed
   * child and the stalled sweep's burials — so the two can never disagree
   * about an event. It is a `Map` update and no I/O, whatever the engine.
   */
  #countQueueJobs(
    q: QueueRef,
    now: number,
    completed: number,
    failed: number,
  ): void {
    this.#analyticsNamespaces.add(q.ns);
    this.#queueJobs.count(q.ns, q.queue, now, { completed, failed });
  }

  /** Every analytics buffer, for flushing, forgetting and closing as one. */
  #analyticsBuffers(): {
    /** Writes what it holds. */
    flush: () => Promise<void>;
    /** Stops its timer and writes what is left. */
    close: () => Promise<void>;
    /** Drops what it holds for one namespace. */
    forget: (ns: string) => void;
  }[] {
    return [
      this.#queueJobs,
      this.#workerJobs,
      this.#workerBusyness,
      this.#runnerRuns,
      this.#runnerDurations,
    ];
  }

  /**
   * A query cut to what this driver actually holds, or `null` when that is
   * nothing.
   *
   * A width it does not record answers empty rather than throwing, as the
   * contract says. `from` is **not** pulled forward to the retention: unlike a
   * store that expires keys itself, these tables keep a bucket until the sweep
   * runs, and answering with what is there is honest about that.
   */
  #analyticsRange(
    query: MetricsQuery,
  ): { from: number; to: number; interval: number } | null {
    const { interval } = query;

    if (!this.#analytics.intervals.includes(interval)) {
      return null;
    }

    const from = bucketStart(query.from, interval);
    const to = bucketStart(query.to, interval);

    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      return null;
    }

    return { from, to, interval };
  }

  /** One entity's stored buckets at one width, as rows the merges take. */
  async #readMetricRows(
    table: SqlTable,
    ns: string,
    entity: string,
    range: { from: number; to: number; interval: number },
    columns: readonly string[],
  ): Promise<Record<string, unknown>[]> {
    await this.connect();

    const { bind, values } = this.#binder();
    // A range of the primary key: `(ns, entity, interval_ms, bucket)` is in
    // exactly this order for this read.
    return await this.#all<Record<string, unknown>>(
      `SELECT bucket, ${columns.join(", ")} FROM ${this.#tables[table]}
        WHERE ns = ${bind(ns)} AND entity = ${bind(entity)}
          AND interval_ms = ${bind(range.interval)}
          AND bucket >= ${bind(range.from)} AND bucket <= ${bind(range.to)}`,
      values,
    );
  }

  /** One entity's counters in range, sparse and oldest first. */
  async #readCounters<K extends string>(
    table: SqlTable,
    ns: string,
    entity: string,
    query: MetricsQuery,
    keys: readonly K[],
    buffer: { flush: () => Promise<void> },
  ): Promise<CounterBucket<Record<K, number>>[]> {
    const range = this.#analyticsRange(query);

    if (!range) {
      return [];
    }

    // This process's own counts first, so a caller sees what it just counted.
    await buffer.flush();

    const rows = await this.#readMetricRows(table, ns, entity, range, keys);

    return counterBucketsOf(rows, range, keys);
  }

  /** One runner's duration buckets in range, histogram included. */
  async #readDurations(
    ns: string,
    runner: string,
    query: MetricsQuery,
  ): Promise<RawDurationBucket[]> {
    const range = this.#analyticsRange(query);

    if (!range) {
      return [];
    }

    await this.#runnerDurations.flush();

    const rows = await this.#readMetricRows(
      "runner_metrics",
      ns,
      runner,
      range,
      [...DURATION_STAT_COLUMNS, ...DURATION_BIN_COLUMNS],
    );

    return durationBucketsOf(rows, range);
  }

  /** One worker's busyness buckets in range. */
  async #readBusyness(
    ns: string,
    entity: string,
    query: MetricsQuery,
  ): Promise<RawBusynessBucket[]> {
    const range = this.#analyticsRange(query);

    if (!range) {
      return [];
    }

    await this.#workerBusyness.flush();

    const rows = await this.#readMetricRows(
      "worker_metrics",
      ns,
      entity,
      range,
      BUSYNESS_COLUMNS,
    );

    return busynessBucketsOf(rows, range);
  }

  /** One buffer's worth of counters, added into whatever is already stored. */
  async #writeCounters<C extends Record<keyof C, number>>(
    table: SqlTable,
    batch: PendingMetric<C>[],
    keys: readonly (keyof C & string)[],
  ): Promise<BufferWriteResult<PendingMetric<C>>> {
    return await this.#writeMetricBatch(
      table,
      keys,
      batch,
      (entry) => [
        entry.ns,
        entry.entity,
        entry.interval,
        entry.at,
        ...keys.map((key) => entry.counts[key] ?? 0),
      ],
      (stored, incoming) =>
        keys.map((key) => `${key} = ${stored(key)} + ${incoming(key)}`),
    );
  }

  /**
   * One buffer's worth of durations, merged into whatever is already stored.
   *
   * The extremes are guarded by the counts rather than taken blindly: a row
   * written by the outcome counters alone has `dur_count = 0` and a `dur_min_ms`
   * of zero, and `LEAST` against that would report every runner's fastest run
   * as instant.
   */
  async #writeDurations(
    batch: PendingDuration[],
  ): Promise<BufferWriteResult<PendingDuration>> {
    const { greatest, least } = this.dialect;

    return await this.#writeMetricBatch(
      "runner_metrics",
      [...DURATION_STAT_COLUMNS, ...DURATION_BIN_COLUMNS],
      batch,
      (entry) => [
        entry.ns,
        entry.entity,
        entry.interval,
        entry.at,
        entry.stats.minMs,
        entry.stats.maxMs,
        entry.stats.count,
        entry.stats.sumMs,
        ...entry.stats.histogram,
      ],
      (stored, incoming) => [
        `dur_min_ms = CASE WHEN ${incoming("dur_count")} = 0 THEN ${stored("dur_min_ms")}` +
          ` WHEN ${stored("dur_count")} = 0 THEN ${incoming("dur_min_ms")}` +
          ` ELSE ${least(stored("dur_min_ms"), incoming("dur_min_ms"))} END`,
        `dur_max_ms = CASE WHEN ${incoming("dur_count")} = 0 THEN ${stored("dur_max_ms")}` +
          ` WHEN ${stored("dur_count")} = 0 THEN ${incoming("dur_max_ms")}` +
          ` ELSE ${greatest(stored("dur_max_ms"), incoming("dur_max_ms"))} END`,
        `dur_count = ${stored("dur_count")} + ${incoming("dur_count")}`,
        `dur_sum_ms = ${stored("dur_sum_ms")} + ${incoming("dur_sum_ms")}`,
        ...DURATION_BIN_COLUMNS.map(
          (column) => `${column} = ${stored(column)} + ${incoming(column)}`,
        ),
      ],
    );
  }

  /**
   * One buffer's worth of busyness samples, merged into whatever is stored.
   *
   * `concurrency` is the latest sample's, which is what `lastAt` is kept for:
   * once a bucket holds two writers' samples, "the concurrency as of the last
   * one" is otherwise undefined.
   */
  async #writeBusyness(
    batch: PendingBusyness[],
  ): Promise<BufferWriteResult<PendingBusyness>> {
    const { greatest } = this.dialect;

    return await this.#writeMetricBatch(
      "worker_metrics",
      BUSYNESS_COLUMNS,
      batch,
      (entry) => [
        entry.ns,
        entry.entity,
        entry.interval,
        entry.at,
        entry.stats.concurrency,
        entry.stats.lastAt,
        entry.stats.samples,
        entry.stats.activeSum,
        entry.stats.activeMax,
      ],
      (stored, incoming) => [
        `concurrency = CASE WHEN ${incoming("samples")} = 0 THEN ${stored("concurrency")}` +
          ` WHEN ${stored("samples")} = 0 OR ${incoming("last_at")} >= ${stored("last_at")}` +
          ` THEN ${incoming("concurrency")} ELSE ${stored("concurrency")} END`,
        `last_at = ${greatest(stored("last_at"), incoming("last_at"))}`,
        `samples = ${stored("samples")} + ${incoming("samples")}`,
        `active_sum = ${stored("active_sum")} + ${incoming("active_sum")}`,
        `active_max = ${greatest(stored("active_max"), incoming("active_max"))}`,
      ],
    );
  }

  /**
   * Writes one buffer's batch as **one upsert per chunk**, and answers with
   * the entries that did not land.
   *
   * Batched rather than a statement apiece because on every engine but
   * Postgres every count is buffered, and a statement per row would be two per
   * entity per second — the statement *rate*, not the row count, is what this
   * is about. A chunk is one statement, so it lands whole or not at all and a
   * retry can never double-count part of it. The buffer merges by
   * `(ns, entity, interval, at)`, so no chunk can hold the same key twice —
   * which is what Postgres refuses with "cannot affect row a second time".
   */
  async #writeMetricBatch<TEntry extends { at: number }>(
    table: SqlTable,
    columns: readonly string[],
    batch: TEntry[],
    row: (entry: TEntry) => unknown[],
    assignments: (
      stored: (column: string) => string,
      incoming: (column: string) => string,
    ) => string[],
  ): Promise<BufferWriteResult<TEntry>> {
    await this.connect();

    const alias = this.dialect.upsertAlias;
    const stored = (column: string): string =>
      alias ? `${alias}.${column}` : column;
    const incoming = (column: string): string =>
      this.dialect.upsertIncoming(column);
    const all = [...METRIC_KEY_COLUMNS, ...columns].join(", ");
    const merge = `${this.dialect.upsertOnConflict(METRIC_KEY_COLUMNS)} ${assignments(
      stored,
      incoming,
    ).join(", ")}`;

    const unwritten: TEntry[] = [];
    let failure: unknown;
    let latest = 0;

    for (let start = 0; start < batch.length; start += METRIC_CHUNK) {
      const chunk = batch.slice(start, start + METRIC_CHUNK);
      const { bind, values } = this.#binder();
      const tuples = chunk
        .map((entry) => `(${row(entry).map(bind).join(", ")})`)
        .join(", ");

      try {
        // `#all`, not `#run`: nothing here wants the affected-row count, and
        // asking for it costs a transaction per statement on MySQL and
        // MariaDB, which is the round trip this batching exists to avoid.
        await this.#all(
          `INSERT INTO ${this.#tables[table]}${alias ? ` AS ${alias}` : ""} (${all})
             VALUES ${tuples}
             ${merge}`,
          values,
        );
      } catch (error) {
        unwritten.push(...chunk);
        failure ??= error;
        continue;
      }

      for (const entry of chunk) {
        latest = Math.max(latest, entry.at);
      }
    }

    // Best-effort and never thrown from here: counts that landed stay landed
    // whatever the sweep does, and a sweep that failed is tried again on the
    // next write. Throwing would put the whole batch back and count it twice.
    await this.#pruneAnalytics(latest).catch(() => undefined);

    return failure === undefined
      ? { unwritten }
      : { unwritten, error: failure };
  }

  /**
   * Drops every analytics bucket past its width's retention, once a minute per
   * process.
   *
   * **By range, never per entity.** A prune driven by new writes to a series
   * never reaches a series nobody writes to any more — a worker that died
   * leaves its buckets behind for good — so it is one
   * `DELETE … WHERE bucket < cutoff` per table per width, over the namespaces
   * this instance writes to.
   *
   * `at` is the latest bucket the batch carried, and the later of it and the
   * wall clock drives the clock — so a caller that passes times in, as the
   * contract suite does, can step the sweep forward instead of waiting a
   * minute for it.
   */
  async #pruneAnalytics(at: number): Promise<void> {
    const now = Math.max(Date.now(), at);

    if (!this.#analyticsPrune.due(now)) {
      return;
    }

    for (const ns of this.#analyticsNamespaces) {
      for (const interval of this.#analytics.intervals) {
        const cutoff = metricsPruneCutoff(this.#analytics, interval, now);

        for (const table of ANALYTICS_TABLES) {
          const { bind, values } = this.#binder();
          // A range of `ix_..._prune`, which is `(ns, interval_ms, bucket)`:
          // the primary key has `entity` second and could only scan.
          await this.#all(
            `DELETE FROM ${this.#tables[table]}
              WHERE ns = ${bind(ns)} AND interval_ms = ${bind(interval)}
                AND bucket < ${bind(cutoff)}`,
            values,
          );
        }
      }
    }
  }

  async removeJob(q: QueueRef, id: string): Promise<boolean> {
    await this.connect();

    // Its log first, while the job's key can still be read — on the same
    // condition as the removal, so an active job keeps its log. A line written
    // between the two statements is left for the sweep.
    await this.#forgetLogs(q, [id], true);

    const { bind, values } = this.#binder();
    const removed = await this.#runPoint(
      `DELETE FROM ${this.#tables.jobs}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}
          AND state <> 'active'`,
      values,
    );

    return removed > 0;
  }

  async retryJob(
    q: QueueRef,
    id: string,
    resetAttempts: boolean,
    now: number,
  ): Promise<boolean> {
    await this.connect();

    /** The retry itself, with `flow` rewritten only when given one. */
    const retry = async (flow: JobFlow | null, tx?: SQL) => {
      const { bind, values } = this.#binder();
      return await this.#runPoint(
        `UPDATE ${this.#tables.jobs}
            SET state = 'waiting', run_at = ${bind(now)}, finished_on = NULL,
                expires_at = NULL${resetAttempts ? ", attempts_made = 0, stalled_count = 0" : ""}${
                  flow ? `, flow = ${bind(this.dialect.jsonIn(flow))}` : ""
                }
          WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}
            AND state NOT IN ('active', 'waiting', 'waiting-children')`,
        values,
        tx,
      );
    };

    const retried = await this.#withFlowColumn(
      // A flow child's next outcome has not reached its parent, so the flag
      // is cleared with the move — read and written under the row lock.
      async () =>
        await this.dialect.transaction(this.#sql, async (tx) => {
          const job = await this.#lockFlow(tx, q, id);
          if (!job) {
            return 0;
          }
          return await retry(
            job.flow?.recorded ? { ...job.flow, recorded: false } : null,
            tx,
          );
        }),
      async () => await retry(null),
    );

    return retried > 0;
  }

  async promoteJob(q: QueueRef, id: string, now: number): Promise<boolean> {
    await this.connect();

    const { bind, values } = this.#binder();
    const promoted = await this.#runPoint(
      `UPDATE ${this.#tables.jobs} SET state = 'waiting', run_at = ${bind(now)}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}
          AND state IN ('delayed', 'failed')`,
      values,
    );

    return promoted > 0;
  }

  /**
   * Promotes what has come due and reports the next due time, in as few
   * statements as the engine allows.
   *
   * - **Postgres**: one statement. A data-modifying CTE does the promotion,
   *   and the outer `SELECT` reads the count and the earliest `run_at` left.
   *   The outer query sees the table as it was *before* the CTE's update, so
   *   the rows just moved are excluded by id; each side is an ordered probe
   *   of `ix_…_due` that skips at most `limit` entries.
   * - **SQLite, MySQL, MariaDB**: the earliest due time first — the read
   *   `nextDelayedAt` makes, one index probe — and the promotion only when
   *   that says something is due. An idle pass is then one read-only
   *   statement: no write lock on SQLite, and on MySQL/MariaDB none of the
   *   transaction a ranged write is wrapped in (reserve, isolation, begin,
   *   write, count, commit). SQLite cannot put an `UPDATE` in a CTE, so this
   *   is its shortest form too. A pass that does promote reads the next due
   *   time again afterwards.
   */
  async promoteDelayed(
    q: QueueRef,
    now: number,
    limit: number,
  ): Promise<PromoteDelayedResult> {
    await this.connect();

    const batch = Math.max(1, Math.floor(limit));

    if (this.adapter === "postgres") {
      const { bind, values } = this.#binder();
      const earliest = (state: string) =>
        `(SELECT run_at FROM ${this.#tables.jobs}
           WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
             AND state = '${state}' AND id NOT IN (SELECT id FROM moved)
           ORDER BY run_at ASC LIMIT 1)`;
      const row = await this.#one<{
        promoted: number | string;
        next: number | string | null;
      }>(
        `WITH moved AS (
           UPDATE ${this.#tables.jobs} SET state = 'waiting'
            WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
              AND state IN ('delayed', 'failed')
              AND id IN (
                SELECT id FROM ${this.#tables.jobs}
                 WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
                   AND state IN ('delayed', 'failed') AND run_at <= ${bind(now)}
                 ORDER BY run_at ASC
                 LIMIT ${batch})
           RETURNING id)
         SELECT (SELECT COUNT(*) FROM moved) AS promoted,
                LEAST(${earliest("delayed")}, ${earliest("failed")}) AS next`,
        values,
      );

      return {
        promoted: Number(row?.promoted ?? 0),
        nextDueAt:
          row?.next === null || row?.next === undefined
            ? null
            : Number(row.next),
      };
    }

    const due = await this.nextDelayedAt(q);
    if (due === null || due > now) {
      return { promoted: 0, nextDueAt: due };
    }

    const { bind, values } = this.#binder();
    const promoted = await this.#run(
      `UPDATE ${this.#tables.jobs} SET state = 'waiting'
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
          AND state IN ('delayed', 'failed')
          AND id IN (${this.dialect.limitedIdSubquery(
            `SELECT id FROM ${this.#tables.jobs}
              WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
                AND state IN ('delayed', 'failed') AND run_at <= ${bind(now)}
              ORDER BY run_at ASC
              LIMIT ${batch}`,
          )})`,
      values,
    );

    return { promoted, nextDueAt: await this.nextDelayedAt(q) };
  }

  async recoverStalled(
    q: QueueRef,
    now: number,
    maxStalledCount: number,
    limit: number,
  ): Promise<{ requeued: string[]; dead: string[] }> {
    await this.connect();

    const scan = this.#binder();
    const stalled = await this.#all<{ id: string; stalled_count: number }>(
      `SELECT id, stalled_count FROM ${this.#tables.jobs}
        WHERE ns = ${scan.bind(q.ns)} AND queue = ${scan.bind(q.queue)}
          AND state = 'active' AND lock_expires_at <= ${scan.bind(now)}
        ORDER BY lock_expires_at ASC
        LIMIT ${Math.max(1, Math.floor(limit))}`,
      scan.values,
    );

    const requeued: string[] = [];
    const dead: string[] = [];

    for (const row of stalled) {
      const count = Number(row.stalled_count) + 1;
      const buried = count > maxStalledCount;

      // Conditional on still being stalled, so a worker that recovered in the
      // meantime is not stolen from.
      const { bind, values } = this.#binder();
      const moved = await this.#run(
        `UPDATE ${this.#tables.jobs}
            SET state = ${bind(buried ? "dead" : "waiting")},
                stalled_count = ${bind(count)},
                run_at = ${bind(now)}, finished_on = ${bind(buried ? now : null)},
                lock_token = NULL, lock_expires_at = NULL, worker_id = NULL
          WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(row.id)}
            AND state = 'active' AND lock_expires_at <= ${bind(now)}`,
        values,
      );

      if (moved > 0) {
        (buried ? dead : requeued).push(row.id);
      }
    }

    // A burial is a failure. It happens in maintenance rather than per job, so
    // it goes to the once-a-second write on every engine, Postgres included.
    if (dead.length > 0) {
      this.#throughput().add(q, now, 0, dead.length);
      this.#countQueueJobs(q, now, 0, dead.length);
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
    await this.connect();
    const cutoff = now - olderThanMs;

    const scan = this.#binder();
    const rows = await this.#all<{ id: string }>(
      `SELECT id FROM ${this.#tables.jobs}
        WHERE ns = ${scan.bind(q.ns)} AND queue = ${scan.bind(q.queue)}
          AND state = ${scan.bind(state)}
          AND COALESCE(finished_on, created_at) <= ${scan.bind(cutoff)}
        LIMIT ${Math.max(1, Math.floor(limit))}`,
      scan.values,
    );

    // Before the jobs go, while their keys can still be read.
    await this.#forgetLogs(
      q,
      rows.map((row) => row.id),
    );

    for (const row of rows) {
      await this.#deleteJob(q, row.id);
    }

    return rows.map((row) => row.id);
  }

  async pruneExpired(q: QueueRef, now: number, limit: number): Promise<number> {
    await this.connect();

    const expired = (bind: (value: unknown) => string) =>
      `ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
          AND expires_at IS NOT NULL AND expires_at <= ${bind(now)}`;
    const removed = await this.#sweep(
      expired,
      "",
      Math.max(1, Math.floor(limit)),
      0,
      async (ids) => {
        // Before the jobs go, while their keys can still be read.
        await this.#forgetLogs(q, ids);
        return await this.#deleteJobs(ids, expired);
      },
    );

    // The maintenance tick is where lines orphaned by the paths that cannot
    // afford to delete them — completion and failure with retention — go.
    await this.#sweepOrphanLogs(q, now, limit);

    return removed;
  }

  async drainQueue(q: QueueRef, includeDelayed: boolean): Promise<number> {
    await this.connect();

    // A parent waiting on children is pending work as much as a waiting job
    // is, so a drain takes it too.
    const states = includeDelayed
      ? ["waiting", "waiting-children", ...SCHEDULED]
      : ["waiting", "waiting-children"];

    // The lines of the jobs about to go, found through those jobs' keys rather
    // than by scanning the queue's whole log, so the cost follows what is
    // drained. Before the drain, because afterwards the keys are gone too.
    await this.#ifLogKey(async () => {
      const logs = this.#binder();
      await this.#run(
        `DELETE FROM ${this.#tables.logs}
          WHERE ns = ${logs.bind(q.ns)} AND queue = ${logs.bind(q.queue)}
            AND log_key IN (
              SELECT log_key FROM ${this.#tables.jobs}
               WHERE ns = ${logs.bind(q.ns)} AND queue = ${logs.bind(q.queue)}
                 AND state IN (${states.map((state) => logs.bind(state)).join(", ")})
            )`,
        logs.values,
      );
    });

    const { bind, values } = this.#binder();

    return await this.#run(
      `DELETE FROM ${this.#tables.jobs}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
          AND state IN (${states.map((state) => bind(state)).join(", ")})`,
      values,
    );
  }

  async getQueueState(
    q: QueueRef,
    name: string,
  ): Promise<QueueStateEntry | null> {
    const entry = await this.#readKv<QueueStateEntry>(
      q.ns,
      this.#queueStateKey(q, name),
    );

    return entry ? { value: entry.value, version: entry.version } : null;
  }

  /**
   * A compare-and-set on one `kv` row, as a single conditional statement.
   *
   * The version lives inside the stored document, `{ version, value }`, rather
   * than in a column of its own: `kv` is shared with runner state and queue
   * metadata, and a column only this uses would need a schema sync on every
   * existing install to buy nothing a `WHERE` on the extracted field does not.
   * The next version is computed here, not in SQL — the statement only matches
   * a row still at `expected`, so `expected + 1` is exactly what it would say.
   *
   * No transaction and no read first. Each engine already re-checks an
   * `UPDATE`'s condition against the row it waited for — Postgres re-evaluates
   * it on the newer tuple, InnoDB reads the latest committed version under the
   * row lock, SQLite has one writer — so of several callers naming one version
   * exactly one matches, and the others affect nothing.
   */
  async setQueueState(
    q: QueueRef,
    name: string,
    value: unknown,
    expected: number | null,
    options?: { internal?: symbol },
  ): Promise<number | null> {
    assertWritableStateName(name, options);
    this.#assertFits(q.ns, "namespace");

    await this.connect();

    const { dialect } = this;
    const table = this.#tables.kv;
    const key = this.#queueStateKey(q, name);
    const version = dialect.jsonInteger("value", "version");
    const { bind, values } = this.#binder();

    if (expected === null) {
      // Deleting an entry only if there is none: nothing to write, just a
      // question to answer, and a read is as atomic as that needs.
      if (value === null) {
        return (await this.getQueueState(q, name)) ? null : 0;
      }

      // Created only when absent. A re-created entry starts again from 1, which
      // the contract allows: whoever held the old version saw the delete fail
      // their compare-and-set already, or has yet to read the new entry.
      const created = await this.#conditionalWrite(
        dialect.insertIgnore(
          table,
          ["ns", "kv_key", "value", "updated_at"],
          [
            bind(q.ns),
            bind(key),
            dialect.jsonParameter(bind(dialect.jsonIn({ version: 1, value }))),
            bind(Date.now()),
          ],
        ),
        values,
      );

      return created ? 1 : null;
    }

    if (value === null) {
      const deleted = await this.#conditionalWrite(
        `DELETE FROM ${table}
          WHERE ns = ${bind(q.ns)} AND kv_key = ${bind(key)}
            AND ${version} = ${bind(expected)}`,
        values,
      );

      return deleted ? 0 : null;
    }

    const next = expected + 1;
    const updated = await this.#conditionalWrite(
      `UPDATE ${table}
          SET value = ${dialect.jsonParameter(bind(dialect.jsonIn({ version: next, value })))},
              updated_at = ${bind(Date.now())}
        WHERE ns = ${bind(q.ns)} AND kv_key = ${bind(key)}
          AND ${version} = ${bind(expected)}`,
      values,
    );

    return updated ? next : null;
  }

  /** See {@link queueStateListStatement}. */
  async listQueueState(
    q: QueueRef,
    options: { prefix: string; after?: string; limit: number },
  ): Promise<string[]> {
    const limit = Math.floor(options.limit);
    if (!(limit > 0)) {
      return [];
    }

    await this.connect();

    const base = this.#queueStateKey(q, "");
    const { bind, values } = this.#binder();

    const rows = await this.#all<{ kv_key: string }>(
      queueStateListStatement(this.dialect, this.#tables.kv, bind, {
        ns: q.ns,
        base,
        prefix: options.prefix,
        after: options.after,
        limit,
      }),
      values,
    );

    return rows.map((row) => String(row.kv_key).slice(base.length));
  }

  async pauseQueue(q: QueueRef): Promise<void> {
    await this.#writeKv(q.ns, `q:${q.queue}:meta`, { paused: true }, true);
    this.#pauseCache.write(q, true);
  }

  async resumeQueue(q: QueueRef): Promise<void> {
    await this.#writeKv(q.ns, `q:${q.queue}:meta`, { paused: false }, true);
    this.#pauseCache.write(q, false);
  }

  async isQueuePaused(q: QueueRef): Promise<boolean> {
    const meta = await this.#readKv<{ paused?: boolean }>(
      q.ns,
      `q:${q.queue}:meta`,
    );
    return meta?.paused === true;
  }

  /* --- queue: repeats ---------------------------------------------------- */

  async upsertRepeat(q: QueueRef, def: RepeatRecord): Promise<void> {
    await this.#writeKv(
      q.ns,
      this.#queueKvKey(q, "repeat", def.key),
      def,
      true,
    );
  }

  async getRepeat(q: QueueRef, key: string): Promise<RepeatRecord | null> {
    return await this.#readKv<RepeatRecord>(
      q.ns,
      this.#queueKvKey(q, "repeat", key),
    );
  }

  async listRepeats(q: QueueRef): Promise<RepeatRecord[]> {
    await this.connect();

    const { bind, values } = this.#binder();
    const rows = await this.#all<{ value: unknown }>(
      `SELECT value FROM ${this.#tables.kv}
        WHERE ns = ${bind(q.ns)} AND kv_key LIKE ${bind(`q:${q.queue}:repeat:%`)}`,
      values,
    );

    return rows
      .map((row) => this.dialect.jsonOut<RepeatRecord | null>(row.value, null))
      .filter((record): record is RepeatRecord => record !== null);
  }

  async removeRepeat(q: QueueRef, key: string): Promise<boolean> {
    await this.connect();

    const { bind, values } = this.#binder();
    const removed = await this.#runPoint(
      `DELETE FROM ${this.#tables.kv}
        WHERE ns = ${bind(q.ns)} AND kv_key = ${bind(this.#queueKvKey(q, "repeat", key))}`,
      values,
    );

    return removed > 0;
  }

  /* --- queue: waiting and events ------------------------------------------ */

  async nextDelayedAt(q: QueueRef): Promise<number | null> {
    await this.connect();

    // One `MIN` per state rather than one over `state IN (…)`, on the server
    // engines. Each is then a one-entry probe of `ix_…_due`'s `(ns, queue,
    // state, run_at)`; over the `IN` list the engine read every delayed and
    // failed row of the queue and aggregated them, on every idle pass.
    // Measured with 50,000 scheduled jobs: Postgres 31ms to 0.27ms, MySQL
    // 54ms to 0.33ms, MariaDB 27ms to 0.19ms, and no slower with five.
    // SQLite already answers the `IN` form from the index, and pays a little
    // for the subqueries, so it keeps it.
    //
    // Postgres's `LEAST` ignores a NULL argument. MySQL's is NULL when either
    // is, so there each side falls back to the other; the derived table binds
    // each subquery once, since `?` placeholders are positional.
    const { bind, values } = this.#binder();
    const earliest = (state: string) =>
      `(SELECT MIN(run_at) FROM ${this.#tables.jobs}
         WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
           AND state = '${state}')`;
    let text: string;
    if (this.adapter === "sqlite") {
      text = `SELECT MIN(run_at) AS next FROM ${this.#tables.jobs}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
          AND state IN ('delayed', 'failed')`;
    } else {
      const both = `(SELECT ${earliest("delayed")} AS d, ${earliest("failed")} AS f) AS earliest`;
      text =
        this.adapter === "postgres"
          ? `SELECT LEAST(d, f) AS next FROM ${both}`
          : `SELECT ${this.dialect.least("COALESCE(d, f)", "COALESCE(f, d)")} AS next FROM ${both}`;
    }
    const row = await this.#one<{ next: number | string | null }>(text, values);

    return row?.next === null || row?.next === undefined
      ? null
      : Number(row.next);
  }

  async waitForJob(
    q: QueueRef,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    // Where the engine can push, a notification ends the wait the moment a job
    // lands rather than at the next poll. Polling still runs alongside it as
    // the correctness floor: a notification can be missed while a listener
    // reconnects, and a job promoted by another process's maintenance sweep is
    // never announced at all.
    if (this.#notify) {
      // Whichever finishes first ends the other. The caller's signal outlives
      // this wait — a worker passes the same one to every wait — so the two
      // listen on a controller of their own, linked to it by one listener that
      // goes when the race settles. Otherwise the loser kept going until its
      // deadline: a poll loop still querying, or a notification waiter still
      // registered, and a listener left on the caller's signal each time.
      //
      // A notification that landed since the last claim began has already
      // been missed by any waiter — there was none — so it ends the wait
      // here, without a statement. Otherwise the poll still opens at once:
      // skipping that one statement when the channel is known to have stayed
      // quiet saved about one poll in a hundred per idle pass, and measured
      // no difference.
      const mark = this.#arrivals.take(q);
      if (mark.state === "moved") {
        return;
      }

      const local = new AbortController();
      const onAbort = () => local.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        await Promise.race([
          this.#arrivals.wait(q, timeoutMs, local.signal, mark.since),
          this.#pollForJob(q, deadline, local.signal),
        ]);
      } finally {
        signal?.removeEventListener("abort", onAbort);
        local.abort();
      }
      return;
    }

    await this.#pollForJob(q, deadline, signal);
  }

  /**
   * Polls until a claimable job exists, the deadline passes, or the wait is
   * aborted. Resolves `true` only when it saw one.
   *
   * The gap between polls grows from a millisecond up to the configured
   * interval rather than being flat. On an engine with no push channel this
   * loop is the only thing that notices a new job, and a flat interval makes a
   * job arriving just after a poll wait the whole of it — a tail, not an
   * average. Measured on Postgres before this: p50 2.9ms against p99 53ms with
   * a 50ms interval. It also got *worse* as claiming got faster, because a
   * quicker empty pass puts the worker to sleep sooner and so more often just
   * ahead of the next arrival.
   *
   * A job is far likelier to arrive just after a queue drains than a second
   * later, so the early polls are the ones worth paying for; backing off keeps
   * an idle worker's cost roughly where it was.
   */
  async #pollForJob(
    q: QueueRef,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let wait = 1;

    while (Date.now() < deadline && !signal?.aborted) {
      // Whether one exists, not how many: a `COUNT` walked every due waiting
      // row, which is all of them when they are held back (names skipped by
      // limits, a paused peer), up to twenty times a second per worker —
      // measured with 50,000 of them, 13ms to 0.2ms on Postgres, 59ms to
      // 0.5ms on MySQL. Ordered by `run_at` so the plan is a walk of
      // `ix_…_due` stopping at its first entry: unordered, Postgres chose a
      // sequential scan that read 50,305 rows to find one.
      const { bind, values } = this.#binder();
      const row = await this.#one<{ found: number | string }>(
        `SELECT 1 AS found FROM ${this.#tables.jobs}
          WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
            AND state = 'waiting' AND run_at <= ${bind(Date.now())}
          ORDER BY run_at
          LIMIT 1`,
        values,
      );

      // Only a *claimable* job ends the wait; a paused queue has none.
      if (
        row !== null &&
        !(await this.#pauseCache.read(q, () => this.isQueuePaused(q)))
      ) {
        return true;
      }

      // With the signal, so a wait that is called off stops polling now rather
      // than after one more query.
      await sleep(Math.min(wait, Math.max(1, deadline - Date.now())), {
        signal,
        unref: true,
      }).catch(() => {});

      wait = Math.min(this.#poll, wait * 2);
    }

    return false;
  }

  async publish(event: DriverEvent): Promise<void> {
    await this.connect();
    this.#pruneEvents(event.ns);

    const { bind, values } = this.#binder();
    await this.#runPoint(
      `INSERT INTO ${this.#tables.events} (ns, channel, payload, created_at)
       VALUES (${bind(event.ns)}, ${bind(`${event.kind}:${event.target}`)},
               ${bind(this.dialect.jsonIn(event))}, ${bind(event.at)})`,
      values,
    );
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

  async cleanEvents(ns: string, before: number): Promise<number> {
    await this.connect();

    const { bind, values } = this.#binder();

    return await this.#run(
      `DELETE FROM ${this.#tables.events}
        WHERE ns = ${bind(ns)} AND created_at < ${bind(before)}`,
      values,
    );
  }

  /**
   * Follows `kind:target` in `ns`, through that namespace's shared feed.
   *
   * One poll per namespace per driver, not one per subscription: it asks for
   * every followed channel at once and hands each row to that channel's
   * listeners. Each subscription used to run its own `setInterval` query, so
   * a process following thirty channels — the API socket, `BunQueue`
   * subscriptions, worker control — sent thirty queries every poll interval
   * while nothing happened at all.
   *
   * What a subscriber sees is unchanged: it starts after the channel's latest
   * event when it subscribes (`after`), and is told what lands next, in `seq`
   * order, late commits included (`EventGaps`, now kept once for the feed).
   */
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
    const channel = `${kind}:${target}`;

    // Start from the present: a subscriber is told what happens next, not the
    // history it was not there for.
    const head = this.#binder();
    const latest = await this.#one<{ seq: number | string | null }>(
      `SELECT MAX(seq) AS seq FROM ${this.#tables.events}
        WHERE ns = ${head.bind(ns)} AND channel = ${head.bind(channel)}`,
      head.values,
    );
    const after = Number(latest?.seq ?? 0);

    // No await between here and registering: two first subscriptions to a
    // namespace must find, or make, the same feed.
    const feed = this.#eventFeed(ns, after);
    const entry: EventFeedListener = { deliver, after };
    let listeners = feed.channels.get(channel);
    if (!listeners) {
      listeners = new Set();
      feed.channels.set(channel, listeners);
    }
    listeners.add(entry);

    let stopped = false;
    const stop = () => {
      if (stopped) {
        return;
      }
      stopped = true;

      const set = feed.channels.get(channel);
      set?.delete(entry);
      if (set?.size === 0) {
        feed.channels.delete(channel);
      }
      if (feed.channels.size === 0) {
        clearInterval(feed.timer);
        if (this.#eventFeeds.get(ns) === feed) {
          this.#eventFeeds.delete(ns);
        }
      }
    };

    this.#subscriptions.add(stop);

    return async () => {
      stop();
      this.#subscriptions.delete(stop);
    };
  }

  /**
   * The namespace's event feed, started at `after` if it has to be made: a
   * first subscriber's own starting point, so nothing it is owed is passed
   * over before it could be delivered.
   */
  #eventFeed(ns: string, after: number): EventFeed {
    const existing = this.#eventFeeds.get(ns);
    if (existing) {
      return existing;
    }

    const feed: EventFeed = {
      gaps: new EventGaps(after),
      channels: new Map(),
      polling: false,
      timer: setInterval(() => {
        if (feed.polling || feed.channels.size === 0) {
          return;
        }
        feed.polling = true;
        void this.#pollEventFeed(ns, feed)
          .catch(() => {
            // A failed poll is retried on the next tick.
          })
          .finally(() => {
            feed.polling = false;
          });
      }, this.#poll),
    };
    feed.timer.unref?.();
    this.#eventFeeds.set(ns, feed);
    return feed;
  }

  /** One poll of a feed: every followed channel at once, dispatched by channel. */
  async #pollEventFeed(ns: string, feed: EventFeed): Promise<void> {
    const channels = [...feed.channels.keys()];
    const now = Date.now();
    const page = this.#binder();
    // Bound in statement order: `?` placeholders are positional.
    const where = `ns = ${page.bind(ns)}
            AND channel IN (${channels.map((channel) => page.bind(channel)).join(", ")})`;
    const retry = feed.gaps.retry(now);
    const rows = await this.#all<{
      seq: number | string;
      channel: string;
      payload: unknown;
    }>(
      `SELECT seq, channel, payload FROM ${this.#tables.events}
        WHERE ${where}
          AND (seq > ${page.bind(feed.gaps.cursor)}${
            retry.length > 0
              ? ` OR seq IN (${retry.map((seq) => page.bind(seq)).join(", ")})`
              : ""
          })
        ORDER BY seq ASC LIMIT ${Math.min(
          EVENT_FEED_MAX_PAGE,
          EVENT_PAGE_PER_CHANNEL * channels.length,
        )}`,
      page.values,
    );

    for (const row of rows) {
      const seq = Number(row.seq);
      if (!feed.gaps.accept(seq, now)) {
        continue;
      }

      const listeners = feed.channels.get(String(row.channel));
      if (!listeners) {
        continue;
      }

      for (const listener of [...listeners]) {
        if (seq <= listener.after) {
          continue;
        }
        // Decoded per listener, so one that mutates its event cannot change
        // what the next is given.
        const event = this.dialect.jsonOut<DriverEvent | null>(
          row.payload,
          null,
        );
        if (event) {
          listener.deliver(event);
        }
      }
    }
  }

  /* --- internals ------------------------------------------------------------ */

  /**
   * The schema's tables that already exist, asked of the engine's own column
   * listing — the one `syncSchema` reads — so a table with no columns
   * reported is one to create.
   *
   * A process that starts beside another may see a table the other has just
   * created and so leave its indexes to that one. Should that one then fail
   * before creating them, they are missing until a sync, which reports them.
   */
  async #existingTables(): Promise<Set<string>> {
    const existing = new Set<string>();

    for (const table of schemaDefinition(this.#tables, this.dialect).tables) {
      const columns = await withLockRetry(
        async () =>
          await this.#sql.unsafe(this.dialect.describeColumns(table.name), [
            table.name,
          ]),
      );

      if ((columns as unknown[]).length > 0) {
        existing.add(table.name);
      }
    }

    return existing;
  }

  /** Creates the schema and applies any connection pragmas. */
  async #migrate(): Promise<void> {
    try {
      for (const statement of this.dialect.pragmas) {
        // Best-effort: `journal_mode` wants a moment's exclusive access, and
        // another process may already have set what this one is asking for.
        await withLockRetry(async () => {
          await this.#sql.unsafe(statement);
        }).catch(() => {});
      }

      // Indexes are created only with the table they belong to. On a table
      // that was already there, a newly defined index is `syncSchema`'s to
      // build — reported, and `CONCURRENTLY` on Postgres — rather than a plain
      // `CREATE INDEX` here, which would block every write to a live jobs
      // table for the length of the build. See `createSchema`.
      const existing = await this.#existingTables();

      // Two processes starting together both create the schema, and one is
      // told the database is busy. Every statement is `IF NOT EXISTS`, so
      // waiting and repeating is exactly the right answer.
      for (const statement of createSchema(
        this.#tables,
        this.dialect,
        existing,
      )) {
        await withLockRetry(async () => {
          try {
            await this.#sql.unsafe(statement);
          } catch (error) {
            // An index that already exists, on an engine whose `CREATE INDEX`
            // cannot say `IF NOT EXISTS` (MySQL). Exactly what the clause
            // would have made a no-op.
            if (!this.dialect.isDuplicateIndex(error)) {
              throw error;
            }
          }
        });
      }

      // After the tables exist, not instead of creating them: a sync compares
      // against what is there and has nothing to say about what is not.
      if (this.#syncOnConnect !== false) {
        await this.#syncSchema(
          typeof this.#syncOnConnect === "object" ? this.#syncOnConnect : {},
        );
      }

      // Whether the table the claims will write has the stamp's columns, so
      // `capabilities.jobAttribution` is true from connect rather than after
      // the first claim fails over to the unstamped statement.
      await this.#probeStampColumns();
    } catch (error) {
      // A failed migration must not be remembered as done.
      this.#ready = undefined;

      // The client's own wording names a client option the caller never sees
      // and says nothing of the URL, so the driver says what to change.
      if (isPublicKeyRetrievalRefusal(error)) {
        throw new ConfigError(
          `${this.adapter === "mariadb" ? "MariaDB" : "MySQL"} asked for its RSA public key to authenticate over a connection without TLS, which is refused by default. Either connect over TLS (add ?ssl=true to the URL, or tls: true to the connection), or allow the key to be fetched: add ?allowPublicKeyRetrieval=true to the URL, or allowPublicKeyRetrieval: true to the connection. Only do the latter on a trusted network, since the key is not authenticated.`,
          {
            adapter: this.adapter,
            code: "ERR_MYSQL_PUBLIC_KEY_RETRIEVAL_NOT_ALLOWED",
          },
        );
      }

      throw new DriverError("sql", "migrate", error, { adapter: this.adapter });
    }
  }

  /**
   * Starts a statement's parameter list.
   *
   * `bind(value)` appends the value and returns its placeholder, so the
   * parameters are always in the order they appear and always the same count.
   * Numbering placeholders by hand looks equivalent but is not: `$2` twice is
   * one value on Postgres and two on MySQL and SQLite, where `?` consumes the
   * next parameter each time. Binding as you write removes the question.
   */
  #binder(): { bind: (value: unknown) => string; values: unknown[] } {
    const values: unknown[] = [];
    const dialect = this.dialect;

    return {
      values,
      bind: (value: unknown) => {
        values.push(value);
        return dialect.placeholder(values.length);
      },
    };
  }

  /**
   * Runs a statement, returning how many rows it affected.
   *
   * The count is what every conditional write here is judged by — "did this
   * update find the row in the state I required?" — so getting it wrong makes
   * every such write silently report failure. Every engine reports it on the
   * result (`SqlDialect.affectedRows`).
   *
   * On MySQL and MariaDB a write outside a transaction still gets one of its
   * own, for the READ COMMITTED it sets: a range under REPEATABLE READ takes
   * next-key locks, and the promote sweep's deadlocked against claims (see the
   * dialect's `transaction`). A write naming its row by primary key takes a
   * record lock under either level, so {@link SqlDriver.#runPoint} skips that
   * transaction.
   */
  async #run(
    text: string,
    params: unknown[],
    tx?: SQL,
    point = false,
  ): Promise<number> {
    if (this.dialect.rangedWritesNeedTransaction && !tx && !point) {
      return await this.dialect.transaction(
        this.#sql,
        async (connection) => await this.#run(text, params, connection),
      );
    }

    const connection = tx ?? this.#sql;

    try {
      return await this.#contended(tx, async () => {
        const result = await connection.unsafe(text, params as never);
        return await this.dialect.affectedRows(result, connection);
      });
    } catch (error) {
      throw new DriverError("sql", "run", error, { text });
    }
  }

  /**
   * {@link SqlDriver.#run} for a write that selects its rows by primary key
   * (`ns, queue, id`, or a table's own key) and nothing wider: one round trip
   * on every engine. On MySQL and MariaDB that was five — reserve, set the
   * isolation level, start, the write, `ROW_COUNT()`, commit — while the
   * record lock such a write takes is the same under any isolation level.
   */
  async #runPoint(text: string, params: unknown[], tx?: SQL): Promise<number> {
    return await this.#run(text, params, tx, true);
  }

  /**
   * A point `UPDATE` of `table` that may legitimately leave its row as it was,
   * answering how many rows it *matched*: 1 or 0.
   *
   * MySQL and MariaDB count rows changed, so a lock renewed to the expiry it
   * already holds — a `touch()` and an `extendLock()`, or either and the
   * heartbeat, in one millisecond — counts 0, and was answered "lock lost".
   * There, and only when the write counted 0, one point read asks whether the
   * row matches `where` *and* already holds every assigned value. If so, the
   * write was a no-op, and answering 1 is exactly as if it ran at that read.
   * A write that changed its row stays one round trip.
   *
   * `where` is called once per statement, with that statement's binder, so it
   * must bind its values in the order they appear in the text.
   */
  async #updateMatched(
    table: string,
    assignments: readonly MatchedAssignment[],
    where: (bind: (value: unknown) => string) => string,
  ): Promise<number> {
    const write = this.#binder();
    const set = assignments
      .map(({ column, value }) => `${column} = ${write.bind(value)}`)
      .join(", ");
    const changed = await this.#runPoint(
      `UPDATE ${table} SET ${set} WHERE ${where(write.bind)}`,
      write.values,
    );

    if (changed > 0 || !this.dialect.countsChangedRows) {
      return changed;
    }

    // Placeholders are positional here, so the condition binds first.
    const read = this.#binder();
    const condition = where(read.bind);
    const holds = assignments
      .map(({ column, value, json }) => {
        const placeholder = read.bind(value);
        return `${column} <=> ${
          json && this.adapter === "mysql"
            ? `CAST(${placeholder} AS JSON)`
            : placeholder
        }`;
      })
      .join(" AND ");
    const row = await this.#one<{ hit: unknown }>(
      `SELECT 1 AS hit FROM ${table} WHERE ${condition} AND ${holds} LIMIT 1`,
      read.values,
    );

    return row ? 1 : 0;
  }

  /**
   * Retries a statement the database refused because someone else held the
   * row or the file, unless it is already inside a transaction.
   *
   * Inside one, a retry is pointless: the transaction is the unit the engine
   * aborted, and repeating one statement of it cannot succeed. Those callers
   * are covered by the retry the dialect wraps around the whole transaction.
   */
  async #contended<T>(tx: SQL | undefined, work: () => Promise<T>): Promise<T> {
    return tx ? await work() : await withLockRetry(work);
  }

  /** Runs a query, returning its rows. */
  async #all<T>(text: string, params: unknown[], tx?: SQL): Promise<T[]> {
    try {
      return await this.#contended(tx, async () => {
        const result = await (tx ?? this.#sql).unsafe(text, params as never);
        return (Array.isArray(result) ? result : []) as T[];
      });
    } catch (error) {
      throw new DriverError("sql", "query", error, { text });
    }
  }

  /** Runs a query, returning its first row. */
  async #one<T>(text: string, params: unknown[], tx?: SQL): Promise<T | null> {
    const rows = await this.#all<T>(text, params, tx);
    return rows[0] ?? null;
  }

  /**
   * Refuses a value too wide for a bounded id column, rather than letting the
   * engine quietly cut it down.
   *
   * MySQL and MariaDB **truncate** past `VARCHAR(191)`. Two ids sharing a
   * 191-character prefix therefore became one row: the second add answered
   * `wasAdded: false`, the first job's data survived under a truncated id, and
   * afterwards *neither* id resolved through `getJob`. That is silent data
   * loss, and a forgery vector — so it is worth an error even though callers'
   * ids are already capped before they reach a driver.
   *
   * It also catches a namespace or queue name of 192–200 characters, which
   * passes the shared segment check (its cap is 200) but overflows these
   * columns, and a `kv` key that a long queue name or runner id pushes past
   * the column. Those are a `ConfigError`: the name is configuration, and no
   * retry will make it fit. A job id too wide is a `DriverError`, since a
   * caller's id is capped and this package fits the ids it builds, so one
   * reaching here is a bug.
   */
  #assertFits(value: string, what: string): void {
    const limit = BOUNDED_ID_LENGTH[this.adapter];

    if (limit === undefined || value.length <= limit) {
      return;
    }

    if (what === "namespace" || what === "queue name" || what === "kv key") {
      throw new ConfigError(
        `the ${what} "${value}" is ${value.length} characters, and ${this.adapter} stores it in a column of ${limit}; use a shorter one`,
        {
          [what]: value,
          length: value.length,
          max: limit,
          adapter: this.adapter,
        },
      );
    }

    throw new DriverError(
      "sql",
      "addJob",
      new Error(
        `${what} is ${value.length} characters and ${this.adapter} stores it in a column of ${limit}; writing it would truncate it and merge it with another row`,
      ),
      {
        [what]: value,
        length: value.length,
        max: limit,
        adapter: this.adapter,
      },
    );
  }

  /** A job record as the columns the insert binds, in `JOB_COLUMNS` order. */
  #toRow(
    q: QueueRef,
    job: JobRecord,
    columns: readonly string[] = JOB_COLUMNS,
  ): unknown[] {
    this.#assertFits(q.ns, "namespace");
    this.#assertFits(q.queue, "queue name");
    this.#assertFits(job.id, "job id");

    const json = (value: unknown) => this.dialect.jsonIn(value);

    const values: unknown[] = [
      q.ns,
      q.queue,
      job.id,
      job.name,
      job.state,
      job.priority,
      job.runAt,
      job.createdAt,
      job.processedOn,
      job.finishedOn,
      job.expiresAt,
      job.attemptsMade,
      job.maxAttempts,
      job.stalledCount,
      json(job.data),
      json(job.opts),
      json(job.progress),
      json(job.returnValue),
      json(job.failedReason),
      json(job.stacktrace),
      job.lockToken,
      job.lockExpiresAt,
      job.workerId,
      job.repeatKey,
      // SQL NULL rather than the JSON text `null`, so "in no flow" reads the
      // same whether the column was named or left to its default.
      job.flow ? json(job.flow) : null,
      job.processedBy?.id ?? null,
      job.processedBy?.key ?? null,
      job.processedBy?.host ?? null,
      job.processedBy?.pid ?? null,
    ];

    // The caller may have asked for a subset — a batch of brand-new jobs names
    // only the columns such a job carries — so the values follow the same list
    // rather than the full one.
    if (columns === JOB_COLUMNS || columns.length === JOB_COLUMNS.length) {
      return values;
    }

    const indices = columnIndices(columns);

    return indices.map((index) => values[index]);
  }

  /**
   * A job as an object keyed by column name, for the JSON insert path.
   *
   * Unlike {@link SqlDriver.#toRow} the JSON columns are not stringified: they
   * are about to be embedded in a document that is itself serialised once.
   * They go through `jsonEmbed` instead, which on Postgres wraps a string in
   * the envelope a bound `jsonIn` would have given it — embedded bare, the
   * string `"warm"` was read back as `null` and `"42"` as `42`. See "JSON
   * columns" in `dialect.ts`.
   */
  #toDocument(
    q: QueueRef,
    job: JobRecord,
    columns: readonly string[] = JOB_COLUMNS,
  ): Record<string, unknown> {
    this.#assertFits(q.ns, "namespace");
    this.#assertFits(q.queue, "queue name");
    this.#assertFits(job.id, "job id");

    const json = (value: unknown) => this.dialect.jsonEmbed(value);
    const values = [
      q.ns,
      q.queue,
      job.id,
      job.name,
      job.state,
      job.priority,
      job.runAt,
      job.createdAt,
      job.processedOn,
      job.finishedOn,
      job.expiresAt,
      job.attemptsMade,
      job.maxAttempts,
      job.stalledCount,
      json(job.data),
      json(job.opts),
      json(job.progress),
      json(job.returnValue),
      json(job.failedReason),
      json(job.stacktrace),
      job.lockToken,
      job.lockExpiresAt,
      job.workerId,
      job.repeatKey,
      json(job.flow),
      job.processedBy?.id ?? null,
      job.processedBy?.key ?? null,
      job.processedBy?.host ?? null,
      job.processedBy?.pid ?? null,
    ];

    const indices = columnIndices(columns);
    const document: Record<string, unknown> = {};

    // A plain loop rather than `Object.fromEntries(columns.map(...))`: this
    // runs once per job, and the tuple array that builds is pure garbage.
    for (let position = 0; position < indices.length; position++) {
      document[columns[position]!] = values[indices[position]!];
    }

    return document;
  }

  /** A row as a job record, decoding JSON columns and numeric strings. */
  #toRecord(row: Record<string, unknown>): JobRecord {
    const number = (value: unknown): number => Number(value);
    const nullableNumber = (value: unknown): number | null =>
      value === null || value === undefined ? null : Number(value);
    const processedBy = this.#decodeStamp(row);

    return {
      id: String(row.id),
      name: String(row.name),
      data: this.dialect.jsonOut<unknown>(row.data, null),
      opts: this.dialect.jsonOut<ResolvedJobOptions>(
        row.opts,
        {} as ResolvedJobOptions,
      ),
      state: row.state as JobState,
      priority: number(row.priority),
      runAt: number(row.run_at),
      createdAt: number(row.created_at),
      processedOn: nullableNumber(row.processed_on),
      finishedOn: nullableNumber(row.finished_on),
      expiresAt: nullableNumber(row.expires_at),
      attemptsMade: number(row.attempts_made),
      maxAttempts: number(row.max_attempts),
      stalledCount: number(row.stalled_count),
      progress: this.dialect.jsonOut<unknown>(row.progress, null),
      returnValue: this.dialect.jsonOut<unknown>(row.return_value, null),
      failedReason: this.dialect.jsonOut<SerializedError | null>(
        row.failed_reason,
        null,
      ),
      stacktrace: this.dialect.jsonOut<SerializedError[]>(row.stacktrace, []),
      lockToken: (row.lock_token as string | null) ?? null,
      lockExpiresAt: nullableNumber(row.lock_expires_at),
      workerId: (row.worker_id as string | null) ?? null,
      repeatKey: (row.repeat_key as string | null) ?? null,
      // Absent on a table not yet synced, which reads as a job in no flow.
      flow: this.#decodeFlow(row.flow),
      // Left off rather than `null` for a job never claimed, as a record
      // added without one reads back on every backend that stores it whole.
      ...(processedBy ? { processedBy } : {}),
    };
  }

  /**
   * The attribution stamp a row carries: `processed_by_id` as its id, and
   * the key, host and pid where the claim recorded them — each absent rather
   * than `null` when it did not. `null` for a job never claimed, and for every
   * row of a table not yet synced, which has no such columns: such a job reads
   * as unattributed rather than as its holder.
   *
   * `processed_by_pid` goes through `Number()`, since an engine may hand back
   * an integer as a string.
   */
  #decodeStamp(row: Record<string, unknown>): JobWorkerRef | null {
    if (row.processed_by_id == null) {
      return null;
    }

    return {
      id: String(row.processed_by_id),
      ...(row.processed_by_key == null
        ? {}
        : { key: String(row.processed_by_key) }),
      ...(row.processed_by_host == null
        ? {}
        : { host: String(row.processed_by_host) }),
      ...(row.processed_by_pid == null
        ? {}
        : { pid: Number(row.processed_by_pid) }),
    };
  }

  /**
   * A stored `flow` document as a {@link JobFlow}, or `null` for none.
   *
   * Every part is defaulted, so a document missing a field — hand-written, or
   * from a later version that dropped one — still gives the flow paths the
   * plain objects and arrays they index into.
   */
  #decodeFlow(value: unknown): JobFlow | null {
    const stored = this.dialect.jsonOut<Partial<JobFlow> | null>(value, null);

    if (!stored || typeof stored !== "object") {
      return null;
    }

    return {
      parent: stored.parent ?? null,
      children: stored.children ?? [],
      pending: Number(stored.pending ?? 0),
      values: stored.values ?? {},
      failures: stored.failures ?? {},
      recorded: stored.recorded === true,
    };
  }

  /**
   * Reads one job's state, due time and flow inside `tx`, holding its row.
   *
   * `FOR UPDATE` on every engine that has it, so a concurrent recording on the
   * same parent waits here and then reads what the first one wrote. SQLite has
   * no row locks and needs none: {@link SqlDialect.transaction} runs it under
   * `BEGIN IMMEDIATE`, which already holds the database's only write lock.
   */
  async #lockFlow(
    tx: SQL,
    q: QueueRef,
    id: string,
  ): Promise<{ state: JobState; runAt: number; flow: JobFlow | null } | null> {
    const lock = this.adapter === "sqlite" ? "" : " FOR UPDATE";
    const { bind, values } = this.#binder();
    const row = await this.#one<{
      state: string;
      run_at: number | string;
      flow: unknown;
    }>(
      `SELECT state, run_at, flow FROM ${this.#tables.jobs}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}${lock}`,
      values,
      tx,
    );

    return row
      ? {
          state: row.state as JobState,
          runAt: Number(row.run_at),
          flow: this.#decodeFlow(row.flow),
        }
      : null;
  }

  /**
   * Whether a failure delivery from `child` is stale, judged by the child's
   * own row read inside `tx`: the row exists and either its outcome has
   * already been delivered (`flow.recorded`) or it is no longer `dead` — it
   * was retried after the failure being delivered. A child with no row is
   * not stale: its failure still buries.
   */
  async #staleFailure(tx: SQL, ns: string, child: JobRef): Promise<boolean> {
    const { bind, values } = this.#binder();
    const row = await this.#one<{ state: string; flow: unknown }>(
      `SELECT state, flow FROM ${this.#tables.jobs}
        WHERE ns = ${bind(ns)} AND queue = ${bind(child.queue)} AND id = ${bind(child.id)}`,
      values,
      tx,
    );

    return (
      row !== null &&
      (row.state !== "dead" || this.#decodeFlow(row.flow)?.recorded === true)
    );
  }

  /**
   * Tells waiting workers that `q` has a job ready, where the engine can.
   *
   * The same `pg_notify` an insert carries, sent on its own because a released
   * parent arrives by an update rather than an insert. Best-effort, as every
   * notification is: polling finds the job regardless.
   */
  async #announce(q: QueueRef): Promise<void> {
    if (!this.#notify) {
      return;
    }

    await this.#all(
      `SELECT pg_notify('${this.#arrivals.channel(q)}', '')`,
      [],
    ).catch(() => undefined);
  }

  /** Removes one job by id, returning how many rows went. */
  async #deleteJob(q: QueueRef, id: string): Promise<number> {
    const { bind, values } = this.#binder();
    return await this.#runPoint(
      `DELETE FROM ${this.#tables.jobs}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}`,
      values,
    );
  }

  /* --- run logs ------------------------------------------------------- */

  /**
   * The lowest and highest line number one run's log still holds, or zeroes
   * when it holds nothing.
   *
   * These two numbers are the whole of a run log's bookkeeping. Trimming only
   * ever deletes from the front, so `firstSeq - 1` is exactly how many lines a
   * cap dropped — no counter to keep, and nothing that can disagree with the
   * rows.
   */
  async #runLogBounds(
    ns: string,
    key: string,
    runId: string,
  ): Promise<{ firstSeq: number; lastSeq: number }> {
    const { bind, values } = this.#binder();
    const row = await this.#one<{
      lowest: number | string | null;
      highest: number | string | null;
    }>(
      `SELECT MIN(line_no) AS lowest, MAX(line_no) AS highest
         FROM ${this.#tables.run_logs}
        WHERE ns = ${bind(ns)} AND runner_key = ${bind(key)}
          AND run_id = ${bind(runId)}`,
      values,
    );

    return {
      firstSeq: Number(row?.lowest ?? 0),
      lastSeq: Number(row?.highest ?? 0),
    };
  }

  /**
   * Applies the per-run caps, and answers how many lines the run has lost in
   * total.
   *
   * The line cap is one `DELETE` on a computed bound. The byte cap cannot be:
   * it needs a running total from the newest line backwards, and the window
   * function that would express it is not available on every engine this
   * driver supports. The sizes are read instead and accumulated here — bounded
   * by the line cap, so at most `maxLines` small rows, and only when the log is
   * actually over its byte cap.
   */
  async #trimRunLog(
    ns: string,
    key: string,
    runId: string,
    caps: RunLogCaps,
    lastSeq: number,
  ): Promise<number> {
    if (caps.maxLines > 0) {
      await this.#dropRunLogBelow(ns, key, runId, lastSeq - caps.maxLines + 1);
    }

    if (caps.maxBytes > 0) {
      const { bind, values } = this.#binder();
      const rows = await this.#all<{
        line_no: number | string;
        bytes: number | string;
      }>(
        `SELECT line_no, bytes FROM ${this.#tables.run_logs}
          WHERE ns = ${bind(ns)} AND runner_key = ${bind(key)}
            AND run_id = ${bind(runId)}
          ORDER BY line_no DESC`,
        values,
      );

      let total = 0;
      let keepFrom: number | undefined;

      for (const row of rows) {
        total += Number(row.bytes);
        // One line always survives, however long: an empty log says less
        // than an over-long one.
        if (total > caps.maxBytes && keepFrom !== undefined) {
          break;
        }
        keepFrom = Number(row.line_no);
      }

      if (keepFrom !== undefined) {
        await this.#dropRunLogBelow(ns, key, runId, keepFrom);
      }
    }

    return (await this.#runLogBounds(ns, key, runId)).firstSeq - 1;
  }

  /** Deletes a run's lines numbered below `keepFrom`. */
  async #dropRunLogBelow(
    ns: string,
    key: string,
    runId: string,
    keepFrom: number,
  ): Promise<void> {
    if (keepFrom <= 1) {
      return;
    }

    const { bind, values } = this.#binder();
    await this.#run(
      `DELETE FROM ${this.#tables.run_logs}
        WHERE ns = ${bind(ns)} AND runner_key = ${bind(key)}
          AND run_id = ${bind(runId)} AND line_no < ${bind(keepFrom)}`,
      values,
    );
  }

  /**
   * Drops the logs of every run but this runner's `keepRuns` most recent.
   *
   * Run order is `MIN(seq)`, the insertion order of a run's first line — not
   * `at`, which capture stamps and a clock could disagree about, and not
   * `line_no`, which restarts at 1 for every run.
   *
   * The derived table is for MySQL, which refuses to read the table a `DELETE`
   * is deleting from any other way; the others do not mind it.
   */
  async #evictRunLogs(
    ns: string,
    key: string,
    keepRuns: number,
  ): Promise<void> {
    const table = this.#tables.run_logs;
    const { bind, values } = this.#binder();

    await this.#run(
      `DELETE FROM ${table}
        WHERE ns = ${bind(ns)} AND runner_key = ${bind(key)}
          AND run_id IN (
            SELECT run_id FROM (
              SELECT run_id FROM ${table}
               WHERE ns = ${bind(ns)} AND runner_key = ${bind(key)}
               GROUP BY run_id
               ORDER BY MIN(seq) DESC
               LIMIT ${MAX_EVICTED_RUN_LOGS} OFFSET ${Math.max(0, Math.floor(keepRuns))}
            ) AS stale
          )`,
      values,
    );
  }

  /**
   * `FROM … WHERE …` selecting one job's log lines, as `l`.
   *
   * Starts from the job, by primary key, and joins its lines on `log_key`. A
   * job that has never logged has a null key, which joins nothing — so a job
   * re-added under a reused id sees none of the lines of the one it replaced.
   */
  #logsOfJob(
    q: QueueRef,
    id: string,
    bind: (value: unknown) => string,
  ): string {
    const { jobs, logs } = this.#tables;

    return `FROM ${jobs} JOIN ${logs} l
        ON l.ns = ${jobs}.ns AND l.queue = ${jobs}.queue
       AND l.log_key = ${jobs}.log_key
     WHERE ${jobs}.ns = ${bind(q.ns)} AND ${jobs}.queue = ${bind(q.queue)}
       AND ${jobs}.id = ${bind(id)}`;
  }

  /** How many lines a job's log holds, counting only the current job's. */
  async #countJobLogs(q: QueueRef, id: string): Promise<number> {
    const { bind, values } = this.#binder();
    const row = await this.#one<{ total: number | string }>(
      `SELECT COUNT(*) AS total ${this.#logsOfJob(q, id, bind)}`,
      values,
    );

    return Number(row?.total ?? 0);
  }

  /**
   * Appends a line under the key the job already has, reading it in the same
   * statement. Returns how many rows went in: none for a job without a key
   * yet, and none for no job at all.
   */
  async #insertLogLine(q: QueueRef, id: string, line: string): Promise<number> {
    const { jobs, logs } = this.#tables;
    const { bind, values } = this.#binder();

    const statement = `INSERT INTO ${logs} (ns, queue, job_id, log_key, message)
       SELECT ns, queue, id, log_key, ${bind(line)} FROM ${jobs}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
          AND id = ${bind(id)} AND log_key IS NOT NULL`;

    // Counted from `RETURNING` where the engine has it. Bun's SQLite client
    // reports a count of 0 for an `INSERT … SELECT` that did insert a row, so
    // the affected-row count would say every job is missing.
    return this.dialect.supportsReturning
      ? (
          await this.#all<{ seq: unknown }>(
            `${statement} RETURNING seq`,
            values,
          )
        ).length
      : await this.#runPoint(statement, values);
  }

  /**
   * Gives a job its log key if it has none, and answers with the key it has —
   * or `null` when there is no such job.
   *
   * `COALESCE` makes it one atomic step: two first lines racing both write,
   * and the second writes back the key the first chose.
   */
  async #stampLogKey(q: QueueRef, id: string): Promise<string | null> {
    const jobs = this.#tables.jobs;
    const token = newId();

    /** The update, bound in statement order by whichever binder runs it. */
    const stamp = (bind: (value: unknown) => string): string =>
      `UPDATE ${jobs} SET log_key = COALESCE(log_key, ${bind(token)})
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}`;

    if (this.dialect.supportsReturning) {
      const { bind, values } = this.#binder();
      const row = await this.#one<{ log_key: string | null }>(
        `${stamp(bind)} RETURNING log_key`,
        values,
      );
      return row?.log_key == null ? null : String(row.log_key);
    }

    // MySQL and MariaDB cannot return it, and their affected-row count cannot
    // tell "no job" from "already had a key". Reading it back on the same
    // connection, inside the transaction, sees exactly what the update left.
    return await this.dialect.transaction(this.#sql, async (tx) => {
      const write = this.#binder();
      await this.#all(stamp(write.bind), write.values, tx);

      const read = this.#binder();
      const row = await this.#one<{ log_key: string | null }>(
        `SELECT log_key FROM ${jobs}
          WHERE ns = ${read.bind(q.ns)} AND queue = ${read.bind(q.queue)}
            AND id = ${read.bind(id)}`,
        read.values,
        tx,
      );
      return row?.log_key == null ? null : String(row.log_key);
    });
  }

  /** Drops a job's log lines beyond its `keep` most recent. */
  async #trimJobLog(q: QueueRef, id: string, keep: number): Promise<void> {
    const { jobs, logs } = this.#tables;
    const { bind, values } = this.#binder();

    // The derived table is for MySQL, which will not read the table a `DELETE`
    // is deleting from any other way; the others do not mind it.
    await this.#run(
      `DELETE FROM ${logs}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
          AND log_key = (
            SELECT log_key FROM ${jobs}
             WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}
          )
          AND seq < (
            SELECT seq FROM (
              SELECT l.seq ${this.#logsOfJob(q, id, bind)}
               ORDER BY l.seq DESC
               LIMIT 1 OFFSET ${Math.max(0, Math.floor(keep) - 1)}
            ) AS newest
          )`,
      values,
    );
  }

  /**
   * Deletes the log lines of jobs about to be removed, through their keys.
   *
   * Called before the removal, while the keys can still be read. `idle` limits
   * it to jobs that are not active, for a removal that will skip those.
   */
  async #forgetLogs(q: QueueRef, ids: string[], idle = false): Promise<void> {
    await this.#ifLogKey(async () => {
      const { logs, jobs } = this.#tables;

      for (let start = 0; start < ids.length; start += INSERT_CHUNK) {
        const chunk = ids.slice(start, start + INSERT_CHUNK);
        const { bind, values } = this.#binder();

        await this.#run(
          `DELETE FROM ${logs}
            WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
              AND log_key IN (
                SELECT log_key FROM ${jobs}
                 WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
                   AND id IN (${chunk.map((id) => bind(id)).join(", ")})${
                     idle ? " AND state <> 'active'" : ""
                   }
              )`,
          values,
        );
      }
    });
  }

  /**
   * Deletes log lines whose job is gone, one bounded page at a time.
   *
   * These come from the removals that deliberately do not touch the log:
   * completion with `removeOnComplete: true` is one `DELETE` on the hot path,
   * and adding a second statement there to tidy a table most queues never
   * write to would charge every job for it. Nothing reads an orphan — every
   * read goes through the key of a job that exists — so they only cost disk
   * until here.
   *
   * A line is an orphan when no job has its key. Each call looks at no more
   * than `limit` lines, walking the queue's log in `(log_key, seq)` order from
   * where the last call stopped, and checks each line's job by primary key, so
   * the cost of a call does not grow with the log. A finished pass rests for
   * {@link LOG_SWEEP_INTERVAL_MS}.
   */
  async #sweepOrphanLogs(
    q: QueueRef,
    now: number,
    limit: number,
  ): Promise<void> {
    // Encoded rather than joined, so no pair of names can produce another's key.
    const key = JSON.stringify([q.ns, q.queue]);
    const sweep = this.#logSweeps.get(key) ?? { notBefore: 0 };

    if (now < sweep.notBefore) {
      return;
    }

    await this.#ifLogKey(async () => {
      const { logs, jobs } = this.#tables;
      const size = Math.max(1, Math.floor(limit));

      const scan = this.#binder();
      const after = sweep.after;
      const rows = await this.#all<{
        seq: number | string;
        log_key: string;
        live: string | null;
      }>(
        `SELECT l.seq, l.log_key, ${jobs}.id AS live
           FROM ${logs} l LEFT JOIN ${jobs}
             ON ${jobs}.ns = l.ns AND ${jobs}.queue = l.queue
            AND ${jobs}.id = l.job_id AND ${jobs}.log_key = l.log_key
          WHERE l.ns = ${scan.bind(q.ns)} AND l.queue = ${scan.bind(q.queue)}${
            after
              ? ` AND (l.log_key > ${scan.bind(after.logKey)}
                   OR (l.log_key = ${scan.bind(after.logKey)} AND l.seq > ${scan.bind(after.seq)}))`
              : ""
          }
          ORDER BY l.log_key ASC, l.seq ASC
          LIMIT ${size}`,
        scan.values,
      );

      const orphans = rows.filter((row) => row.live === null);

      if (orphans.length > 0) {
        const { bind, values } = this.#binder();
        await this.#run(
          `DELETE FROM ${logs}
            WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
              AND seq IN (${orphans.map((row) => bind(row.seq)).join(", ")})`,
          values,
        );
      }

      const last = rows.at(-1);

      // A short page is the end of the log: rest, then start over.
      this.#logSweeps.set(
        key,
        rows.length < size || !last
          ? { notBefore: now + LOG_SWEEP_INTERVAL_MS }
          : {
              after: { logKey: String(last.log_key), seq: String(last.seq) },
              notBefore: 0,
            },
      );
    });
  }

  /**
   * Runs log work that a caller asked for, translating a missing `log_key`
   * column into an error that says what to do about it.
   *
   * `CREATE TABLE IF NOT EXISTS` gives a new install the column, but an
   * install created before job logs existed keeps its old `jobs` table until a
   * sync adds it — and the engine's own "unknown column" names neither the
   * feature nor the fix.
   */
  async #requireLogKey<T>(work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      this.#logKeyMissing = false;
      return result;
    } catch (error) {
      if (!isMissingLogKey(error)) {
        throw error;
      }

      this.#logKeyMissing = true;
      throw new ConfigError(
        `Job logs need the log_key column on ${this.#tables.jobs}, which this database does not have yet. Run driver.syncSchema(), or construct the driver with syncSchema: true, to add it.`,
        { table: this.#tables.jobs, column: "log_key" },
      );
    }
  }

  /**
   * Runs log housekeeping on a removal or maintenance path, skipping it where
   * the `log_key` column does not exist.
   *
   * Without the column no job can have logged anything, so there is nothing
   * to tidy — and failing a `removeJob` or the worker's maintenance tick over
   * a feature the application may not use would break an install that worked
   * before the upgrade. Once seen missing it is not asked about again until a
   * sync, or a log call that succeeds, says otherwise.
   */
  async #ifLogKey(work: () => Promise<void>): Promise<void> {
    if (this.#logKeyMissing) {
      return;
    }

    try {
      await work();
    } catch (error) {
      if (!isMissingLogKey(error)) {
        throw error;
      }

      this.#logKeyMissing = true;
    }
  }

  /**
   * The `kv` key a queue-state entry lives under.
   *
   * Under the queue's own `q:<queue>:` prefix, so `purge(ns)` removes it with
   * everything else and `listRunners`' `r:%` never sees it. `listQueues`
   * matches `q:%:meta`, which a state *named* `meta` would also match, and so
   * excludes this prefix explicitly.
   */
  #queueStateKey(q: QueueRef, name: string): string {
    return this.#queueKvKey(q, "state", name);
  }

  /**
   * The `kv` key of a named entry under a queue — a state entry or a repeat
   * definition — fitted to the column.
   *
   * On MySQL and MariaDB `kv_key` is `VARCHAR(191)`, and the queue name is part
   * of the key, so a name that fits on its own (a 191-character series key, a
   * window pointer for a 186-character id) overflows it. Such a name is
   * shortened deterministically with a hash of the whole, so it stays distinct
   * and every lookup of it reaches one row; a fitted name fits, so handing it
   * back — as `listQueueState` does — reaches the same row too. A repeat is
   * listed from the stored record, so its fitting is invisible; a state entry
   * with a name that long is listed under its fitted spelling.
   *
   * Refused with a `ConfigError` only when the queue name leaves no room at
   * all, which no name can fix.
   */
  #queueKvKey(q: QueueRef, kind: "state" | "repeat", name: string): string {
    const base = `q:${q.queue}:${kind}:`;
    const limit = BOUNDED_ID_LENGTH[this.adapter];

    if (limit === undefined) {
      return `${base}${name}`;
    }

    this.#assertFits(q.queue, "queue name");

    try {
      return `${base}${fitName(name, { maxLength: limit - base.length })}`;
    } catch (error) {
      if (!(error instanceof RangeError)) {
        throw error;
      }

      throw new ConfigError(
        `the queue name "${q.queue}" is too long for ${this.adapter} to store its ${kind} entries: their keys are limited to ${limit} characters`,
        { queue: q.queue, length: q.queue.length, max: limit, kind },
      );
    }
  }

  /**
   * Runs a conditional write and answers whether it matched a row.
   *
   * Judged by the most reliable count each engine offers. Where there is
   * `RETURNING`, a returned row is the proof: Bun's SQLite client does not
   * report an affected-row count that can be trusted. MySQL and MariaDB use
   * the result's `affectedRows`, which, like `ROW_COUNT()`, counts *changed*
   * rows rather than matched ones — safe for every caller
   * here, because each write either removes the row or bumps the version it
   * holds, and so never leaves a matched row unchanged.
   */
  async #conditionalWrite(text: string, params: unknown[]): Promise<boolean> {
    if (this.dialect.supportsReturning) {
      const rows = await this.#all(`${text} RETURNING kv_key`, params);
      return rows.length > 0;
    }

    return (await this.#runPoint(text, params)) > 0;
  }

  /** Reads one key/value document. */
  async #readKv<T>(ns: string, key: string): Promise<T | null> {
    await this.connect();

    const { bind, values } = this.#binder();
    const row = await this.#one<{ value: unknown }>(
      `SELECT value FROM ${this.#tables.kv}
        WHERE ns = ${bind(ns)} AND kv_key = ${bind(key)}`,
      values,
    );

    return row ? this.dialect.jsonOut<T | null>(row.value, null) : null;
  }

  /** Writes one key/value document, optionally overwriting an existing one. */
  async #writeKv(
    ns: string,
    key: string,
    value: unknown,
    overwrite: boolean,
  ): Promise<void> {
    await this.connect();
    // Refused rather than truncated: a cut key would merge two entries.
    this.#assertFits(ns, "namespace");
    this.#assertFits(key, "kv key");

    const columns = ["ns", "kv_key", "value", "updated_at"];
    const encoded = this.dialect.jsonIn(value);

    // Insert-if-absent first, then update. A bare upsert is enough on
    // Postgres and SQLite, but concurrent `ON DUPLICATE KEY UPDATE` on one
    // key deadlocks in InnoDB; this shape does not.
    await this.#runPoint(this.dialect.insertIgnore(this.#tables.kv, columns), [
      ns,
      key,
      encoded,
      Date.now(),
    ]);

    if (!overwrite) {
      return;
    }

    const { bind, values } = this.#binder();
    await this.#runPoint(
      `UPDATE ${this.#tables.kv}
          SET value = ${bind(encoded)}, updated_at = ${bind(Date.now())}
        WHERE ns = ${bind(ns)} AND kv_key = ${bind(key)}`,
      values,
    );
  }

  /** A runner's stored state, with defaults for a first read. */
  async #readState(
    ns: string,
    key: string,
  ): Promise<{
    fields: Record<string, string>;
    history: RunRecord[];
    queued: QueuedTrigger[];
  }> {
    const state = await this.#readKv<{
      fields?: Record<string, string>;
      history?: RunRecord[];
      queued?: QueuedTrigger[];
    }>(ns, `${key}:state`);

    return {
      fields: state?.fields ?? {},
      history: state?.history ?? [],
      queued: state?.queued ?? [],
    };
  }

  /**
   * Read-modify-writes a runner's state inside a transaction, so two
   * processes cannot both read, both modify, and both write.
   *
   * `mutate` returning `false` means it changed nothing: the transaction then
   * ends without the UPDATE, so the row (and its `updated_at`) stays as it was.
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
    await this.connect();
    const kvKey = `${key}:state`;
    // Before the row is created, and refused rather than truncated.
    this.#assertFits(ns, "namespace");
    this.#assertFits(kvKey, "kv key");

    // Create the row first, outside the transaction.
    //
    // `SELECT ... FOR UPDATE` on a row that does not exist takes a *gap* lock
    // in InnoDB, so two processes arriving together both hold one and both
    // then try to insert, which deadlocks. With the row already present the
    // lock is an ordinary record lock and the transaction only ever updates.
    await this.#runPoint(
      this.dialect.insertIgnore(this.#tables.kv, [
        "ns",
        "kv_key",
        "value",
        "updated_at",
      ]),
      [
        ns,
        kvKey,
        this.dialect.jsonIn({ fields: {}, history: [], queued: [] }),
        Date.now(),
      ],
    );

    await this.dialect.transaction(this.#sql, async (tx) => {
      const locked = this.dialect.supportsSkipLocked ? " FOR UPDATE" : "";
      const read = this.#binder();
      const row = await this.#one<{ value: unknown }>(
        `SELECT value FROM ${this.#tables.kv}
          WHERE ns = ${read.bind(ns)} AND kv_key = ${read.bind(kvKey)}${locked}`,
        read.values,
        tx,
      );

      const current = row
        ? this.dialect.jsonOut<{
            fields?: Record<string, string>;
            history?: RunRecord[];
            queued?: QueuedTrigger[];
          } | null>(row.value, null)
        : null;

      const state = {
        fields: current?.fields ?? {},
        history: current?.history ?? [],
        queued: current?.queued ?? [],
      };

      if (mutate(state) === false) {
        return;
      }

      // A plain update: the row is known to exist, and inserting here is what
      // caused the deadlock this method now avoids.
      const write = this.#binder();
      await this.#run(
        `UPDATE ${this.#tables.kv}
            SET value = ${write.bind(this.dialect.jsonIn(state))},
                updated_at = ${write.bind(Date.now())}
          WHERE ns = ${write.bind(ns)} AND kv_key = ${write.bind(kvKey)}`,
        write.values,
        tx,
      );
    });
  }

  /** Enforces a retention count by removing the oldest beyond the cap. */
  async #applyRetention(
    q: QueueRef,
    id: string,
    state: JobState,
    retention: Retention,
    _now: number,
  ): Promise<void> {
    if (retention === true) {
      await this.#deleteJob(q, id);
      return;
    }

    const count =
      typeof retention === "number"
        ? retention
        : retention && typeof retention === "object"
          ? retention.count
          : undefined;

    if (count === undefined || count < 0) {
      return;
    }

    if (!this.#retentionDue(q, state, count)) {
      return;
    }

    const inState = (bind: (value: unknown) => string) =>
      `ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND state = ${bind(state)}`;
    await this.#sweep(
      inState,
      "ORDER BY COALESCE(finished_on, created_at) DESC",
      RETENTION_SWEEP_LIMIT,
      Math.max(0, Math.floor(count)),
      async (ids) => await this.#deleteJobs(ids, inState),
    );
  }

  /**
   * Whether this settle should run the count sweep for `state`, or leave it
   * to a later one.
   *
   * The sweep reads every kept row of the state in order to find the ones past
   * `count` — there is no index its order can walk on most engines — so run
   * on every settle it made each completion cost O(kept): measured, with
   * 10,000 kept that was most of a completion. One sweep in every
   * {@link RETENTION_SLACK} of `count` settles (in this process, per queue and
   * state) removes everything past `count` at once, which amortises it to a
   * constant. The price is that up to that many extra jobs (at most
   * {@link RETENTION_MAX_STRIDE}) can be kept between one process's sweeps; a
   * `count` under 20 is swept on every settle, exactly as before. The first
   * settle after a start always sweeps, so what an earlier process left over
   * goes at once.
   */
  #retentionDue(q: QueueRef, state: JobState, count: number): boolean {
    const every = Math.min(
      RETENTION_MAX_STRIDE,
      Math.max(1, Math.floor(count * RETENTION_SLACK)),
    );

    if (every === 1) {
      return true;
    }

    const key = `${q.ns}\n${q.queue}\n${state}`;
    const since = (this.#retentionSettles.get(key) ?? every - 1) + 1;

    if (since >= every) {
      this.#retentionSettles.set(key, 0);
      return true;
    }

    this.#retentionSettles.set(key, since);
    return false;
  }

  /**
   * Removes up to `limit` jobs matching `filter`, in `order` from `offset`,
   * less any flow child whose parent has not recorded its outcome; answers how
   * many `remove` took.
   *
   * The flow check is made in JS on the rows the page already chose, from
   * `flow` fetched alongside the id, rather than as a JSON predicate in SQL:
   * the engines spell JSON extraction differently, and Postgres stores a
   * document bound as text as a JSON *string*, which no path expression
   * reaches into. A job in no flow has `flow` NULL, so the page stays as cheap
   * as it was — one more column of NULL per selected row. On a table not yet
   * synced there is no `flow`, no job can be in a flow, and every row goes.
   *
   * It pages. A page used to be the whole sweep, and the `LIMIT` was applied
   * before the check, so a page of held children removed nothing and hid every
   * removable job behind them: the worker's prune reads a short batch as "the
   * backlog is gone" and stops, and the count sweep kept everything past them.
   * Now each page's removable jobs go through `remove` at once — so the
   * positions past `offset` move up — and the held ones are excluded from the
   * next page, until `limit` jobs went, a page comes back short, or
   * {@link SWEEP_MAX_PAGES} pages passed. With no held child on a page, which
   * is every sweep of a queue with no flows, that is one read as before.
   */
  async #sweep(
    filter: (bind: (value: unknown) => string) => string,
    order: string,
    limit: number,
    offset: number,
    remove: (ids: string[]) => Promise<number>,
  ): Promise<number> {
    let removed = 0;
    const held: string[] = [];

    for (let page = 0; page < SWEEP_MAX_PAGES && removed < limit; page++) {
      const wanted = limit - removed;
      const rows = await this.#sweepPage(filter, order, wanted, offset, held);

      const removable: string[] = [];
      let newlyHeld = 0;
      for (const row of rows) {
        if (awaitsDelivery({ flow: this.#decodeFlow(row.flow) })) {
          held.push(row.id);
          newlyHeld++;
        } else {
          removable.push(row.id);
        }
      }

      if (removable.length > 0) {
        removed += await remove(removable);
      }

      // Short: nothing more matches. None held: `removable` was the page, and
      // either `limit` is reached or the page was short.
      if (rows.length < wanted || newlyHeld === 0) {
        break;
      }
    }

    return removed;
  }

  /**
   * One page of {@link SqlDriver.#sweep}: ids and `flow` of the jobs matching
   * `filter`, past `offset` in `order`, leaving out the `held` ids earlier
   * pages kept back. `flow` is `null` on a table without the column.
   */
  async #sweepPage(
    filter: (bind: (value: unknown) => string) => string,
    order: string,
    limit: number,
    offset: number,
    held: string[],
  ): Promise<{ id: string; flow: unknown }[]> {
    const statement = (columns: string) => {
      const { bind, values } = this.#binder();
      // Bound in statement order: `?` placeholders are positional.
      const where = filter(bind);
      const excluded =
        held.length === 0
          ? ""
          : ` AND id NOT IN (${held.map((id) => bind(id)).join(", ")})`;
      return {
        text: `SELECT ${columns} FROM ${this.#tables.jobs}
          WHERE ${where}${excluded}
          ${order}
          LIMIT ${limit}${offset > 0 ? ` OFFSET ${offset}` : ""}`,
        values,
      };
    };

    return await this.#withFlowColumn(
      async () => {
        const { text, values } = statement("id, flow");
        return await this.#all<{ id: string; flow: unknown }>(text, values);
      },
      async () => {
        const { text, values } = statement("id");
        const rows = await this.#all<{ id: string }>(text, values);
        return rows.map((row) => ({ id: row.id, flow: null }));
      },
    );
  }

  /**
   * Deletes the jobs `ids` of `q` that still match `filter` — a sweep's own
   * condition, so a job that left the swept state since the page was read
   * stays — in statements of at most {@link INSERT_CHUNK} ids; answers how
   * many went.
   */
  async #deleteJobs(
    ids: string[],
    filter: (bind: (value: unknown) => string) => string,
  ): Promise<number> {
    let removed = 0;

    for (let start = 0; start < ids.length; start += INSERT_CHUNK) {
      const chunk = ids.slice(start, start + INSERT_CHUNK);
      const { bind, values } = this.#binder();
      removed += await this.#run(
        `DELETE FROM ${this.#tables.jobs}
          WHERE ${filter(bind)}
            AND id IN (${chunk.map((id) => bind(id)).join(", ")})`,
        values,
      );
    }

    return removed;
  }

  /**
   * Runs `withFlow`, which names the `flow` column, or `without` where the
   * table does not have it yet — remembered for
   * {@link FLOW_COLUMN_RECHECK_MS}, so an unsynced install pays for the
   * failed statement once a minute rather than on every call.
   */
  async #withFlowColumn<T>(
    withFlow: () => Promise<T>,
    without: () => Promise<T>,
  ): Promise<T> {
    if (
      this.#flowMissingAt !== undefined &&
      Date.now() - this.#flowMissingAt < FLOW_COLUMN_RECHECK_MS
    ) {
      return await without();
    }

    try {
      const result = await withFlow();
      this.#flowMissingAt = undefined;
      return result;
    } catch (error) {
      if (!isMissingColumn(error, "flow")) {
        throw error;
      }
      this.#flowMissingAt = Date.now();
      return await without();
    }
  }

  /**
   * Runs `withStamp`, which names the attribution stamp's columns, or
   * `without` where the table does not have them yet — remembered for
   * {@link STAMP_COLUMNS_RECHECK_MS}, as {@link SqlDriver.#withFlowColumn}
   * remembers `flow`. `named` is whether the work would name them at all; one
   * that would not runs `without` directly.
   *
   * This is what keeps an upgraded install that has not synced working: the
   * claim names the columns, and failing it would fail every claim. Until a
   * sync adds them, a claim records no stamp — `worker_id` still names the
   * holder while the job is active, as before — and a stamped record is
   * inserted without its stamp, as an older version would insert it.
   */
  async #withStampColumns<T>(
    named: boolean,
    withStamp: () => Promise<T>,
    without: () => Promise<T>,
  ): Promise<T> {
    if (
      !named ||
      (this.#stampMissingAt !== undefined &&
        Date.now() - this.#stampMissingAt < STAMP_COLUMNS_RECHECK_MS)
    ) {
      return await without();
    }

    try {
      const result = await withStamp();
      this.#stampMissingAt = undefined;
      this.#stampConfirmed = true;
      return result;
    } catch (error) {
      if (!isMissingStampColumn(error)) {
        throw error;
      }
      this.#stampMissingAt = Date.now();
      this.#stampConfirmed = false;
      return await without();
    }
  }

  /**
   * Asks the engine whether the jobs table has the stamp's columns, with a
   * statement that reads no row, and records the answer where the claim's
   * fallback keeps it. Any other failure propagates.
   */
  async #probeStampColumns(): Promise<void> {
    const epoch = this.#stampEpoch;
    try {
      await withLockRetry(
        async () =>
          await this.#sql.unsafe(
            `SELECT processed_by_id, processed_by_key, processed_by_host, processed_by_pid FROM ${this.#tables.jobs} WHERE 1 = 0`,
          ),
      );
      if (epoch === this.#stampEpoch) {
        this.#stampMissingAt = undefined;
        this.#stampConfirmed = true;
      }
    } catch (error) {
      if (!isMissingStampColumn(error)) {
        throw error;
      }
      if (epoch === this.#stampEpoch) {
        this.#stampMissingAt = Date.now();
        this.#stampConfirmed = false;
      }
    }
  }

  /**
   * `capabilities.jobAttribution`: whether the jobs table was last seen with
   * the stamp's columns — at connect, by a claim or insert, or by a sync.
   * `false` until something has confirmed them, so before connect it is
   * `false`: connecting settles it.
   *
   * Once connecting has begun, an unconfirmed answer is asked again in the
   * background: at once when nothing has been seen (a probe whose answer a
   * sync overtook, or one that failed), and once a "missing" answer is older
   * than {@link STAMP_COLUMNS_RECHECK_MS}, so a process that never claims
   * (one serving only the API) still notices a sync another process ran. This
   * read reports the old answer until that probe lands.
   */
  #stampColumnsReady(): boolean {
    if (this.#stampConfirmed) {
      return true;
    }

    const missingAt = this.#stampMissingAt;
    if (
      this.#ready !== undefined &&
      this.#stampProbe === undefined &&
      (missingAt === undefined ||
        Date.now() - missingAt >= STAMP_COLUMNS_RECHECK_MS)
    ) {
      this.#stampProbe = this.#probeStampColumns()
        .catch(() => {})
        .finally(() => {
          this.#stampProbe = undefined;
        });
    }

    return false;
  }

  /**
   * Runs a claim with the stamp its options ask for: the worker's id with its
   * key, host and pid, or with `null` for them to clear an earlier claim's —
   * or, on a table without the stamp's columns, a claim naming none of them.
   */
  async #withClaimStamp<T>(
    opts: ClaimOptions,
    claim: (worker: ClaimStatementOptions["worker"]) => Promise<T>,
  ): Promise<T> {
    return await this.#withStampColumns(
      true,
      async () => await claim(opts.worker ?? null),
      async () => await claim(undefined),
    );
  }

  /**
   * Runs a read that filters on the stamp's key or id, translating a missing
   * stamp column into an error that says what to do about it. There is no
   * answer to give without the columns — no job on such a table has a stamp —
   * and an empty page would read as "this worker ran nothing".
   */
  async #requireStampColumns<T>(
    names: boolean,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!names) {
      return await work();
    }

    try {
      return await work();
    } catch (error) {
      if (!isMissingStampColumn(error)) {
        throw error;
      }

      this.#stampMissingAt = Date.now();
      this.#stampConfirmed = false;
      throw new ConfigError(
        `Filtering jobs by worker needs the attribution columns (processed_by_id, processed_by_key, processed_by_host, processed_by_pid) on ${this.#tables.jobs}, which this database does not have yet. Run driver.syncSchema(), or construct the driver with syncSchema: true, to add them.`,
        { table: this.#tables.jobs, columns: STAMP_COLUMNS },
      );
    }
  }

  /**
   * Runs a write that puts a job in a flow, translating a missing `flow`
   * column into an error that says what to do about it.
   *
   * `CREATE TABLE IF NOT EXISTS` gives a new install the column, but a table
   * created before flows keeps its old shape until a sync adds it, and the
   * engine's own "unknown column" names neither the feature nor the fix.
   * `names` is whether the write names the column at all; one that does not
   * cannot fail this way, and runs as it is.
   */
  async #requireFlowColumn<T>(
    names: boolean,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!names) {
      return await work();
    }

    try {
      return await work();
    } catch (error) {
      if (!isMissingColumn(error, "flow")) {
        throw error;
      }

      throw new ConfigError(
        `Flows need the flow column on ${this.#tables.jobs}, which this database does not have yet. Run driver.syncSchema(), or construct the driver with syncSchema: true, to add it.`,
        { table: this.#tables.jobs, column: "flow" },
      );
    }
  }
}
