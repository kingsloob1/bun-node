import type { SqlDialect } from "./dialect";
import { ConfigError } from "../../shared/errors";
import {
  DURATION_HISTOGRAM_SIZE,
  JOB_COUNTERS,
  RUNNER_RUN_COUNTERS,
} from "../metrics";

/**
 * The tables, and the indexes that make the hot paths cheap.
 *
 * Eleven tables rather than one per concern: `jobs`, `locks`, `kv` (runner
 * state, queue metadata and repeat definitions), `events`, `logs` (each
 * job's log lines), `run_logs` (each runner run's captured output), `workers`
 * (heartbeat records), `metrics` (throughput
 * per minute) and the three analytics tables — `queue_metrics`,
 * `worker_metrics` and `runner_metrics` — described at
 * {@link analyticsTables}. Every table
 * carries `ns`, and every index leads with it, so one namespace's queries
 * never scan another's rows.
 */

/** Column names of the jobs table, in the order the driver binds them. */
export const JOB_COLUMNS = [
  "ns",
  "queue",
  "id",
  "name",
  "state",
  "priority",
  "run_at",
  "created_at",
  "processed_on",
  "finished_on",
  "expires_at",
  "attempts_made",
  "max_attempts",
  "stalled_count",
  "data",
  "opts",
  "progress",
  "return_value",
  "failed_reason",
  "stacktrace",
  "lock_token",
  "lock_expires_at",
  "worker_id",
  "repeat_key",
  "flow",
  "processed_by_id",
  "processed_by_key",
  "processed_by_host",
  "processed_by_pid",
] as const;

/**
 * The attribution stamp's columns (`JobRecord.processedBy`): the id, stable
 * key, host and pid of the worker that claimed the job's current or last
 * attempt. Written by the claim and named by no settle, so the stamp outlives
 * the attempt.
 *
 * Its own columns rather than `worker_id`, which stays the holder alone and is
 * still cleared by every settle: a record carrying a `workerId` and no stamp
 * reads back exactly as it went in, and a settle by a version that predates
 * the stamp leaves it intact.
 *
 * Named by an insert only for a record carrying a stamp, and by a claim only
 * while the table has them, so a table created before they existed keeps
 * accepting jobs and claims until a sync adds them.
 */
export const STAMP_COLUMNS: readonly string[] = [
  "processed_by_id",
  "processed_by_key",
  "processed_by_host",
  "processed_by_pid",
];

/**
 * {@link JOB_COLUMNS} without `flow` or the stamp: what a job in no flow, and
 * carrying no stamp, is inserted with.
 *
 * Such a job's `flow` and stamp columns are their defaults, `NULL`, so naming
 * them adds nothing — and not naming them keeps every such job insertable into
 * a table created before those columns existed and not yet synced. Only a job
 * that really is in a flow needs `syncSchema` to have run. Its own array
 * rather than a copy made per call, because `columnIndices` memoises on
 * identity.
 */
export const FLOWLESS_JOB_COLUMNS: readonly string[] = JOB_COLUMNS.filter(
  (column) => column !== "flow" && !STAMP_COLUMNS.includes(column),
);

/** {@link JOB_COLUMNS} without the stamp: a job in a flow, carrying no stamp. */
export const UNSTAMPED_JOB_COLUMNS: readonly string[] = JOB_COLUMNS.filter(
  (column) => !STAMP_COLUMNS.includes(column),
);

/** {@link JOB_COLUMNS} without `flow`: a job in no flow, carrying a stamp. */
export const STAMPED_FLOWLESS_JOB_COLUMNS: readonly string[] =
  JOB_COLUMNS.filter((column) => column !== "flow");

/**
 * The column list an insert names, given whether any of its jobs is in a flow
 * and whether any carries a stamp. Always one of the module
 * constants, never a copy, for `columnIndices`' sake.
 */
export function insertColumns(
  flow: boolean,
  stamped: boolean,
): readonly string[] {
  if (flow) {
    return stamped ? JOB_COLUMNS : UNSTAMPED_JOB_COLUMNS;
  }

  return stamped ? STAMPED_FLOWLESS_JOB_COLUMNS : FLOWLESS_JOB_COLUMNS;
}

/**
 * The columns a brand-new job actually carries.
 *
 * Everything else in {@link JOB_COLUMNS} is the table's default for a job that
 * has not run yet: no timestamps for work that has not happened, no lock, no
 * result, no error, zero attempts. Naming only these in an insert is worth
 * about 20% — measured, 31,299/s against 37,881/s for the same 5,000 rows —
 * because the cost of this statement is dominated by how much of it there is.
 *
 * Used only when *every* job in a batch matches those defaults; a record that
 * carries any of them, such as one restored from elsewhere or added already
 * finished, falls back to the full column list.
 */
export const FRESH_JOB_COLUMNS = [
  "ns",
  "queue",
  "id",
  "name",
  "state",
  "priority",
  "run_at",
  "created_at",
  "max_attempts",
  "data",
  "opts",
] as const;

/**
 * The type of each column in {@link JOB_COLUMNS}, in the same order.
 *
 * Only needed to describe a `json_to_recordset` column list, which has to name
 * a type per column. JSON columns are always described as `json`, whatever the
 * table stores: reading the input as `json` is text-only, and converting on
 * insert is cheaper than parsing the whole document into binary first —
 * measured, 32,028/s against 27,619/s for the same rows. That still matters
 * for a table created before {@link SqlDialect.jsonType} became `json`, whose
 * columns are `jsonb`.
 */
export function jobColumnTypes(dialect: SqlDialect): string[] {
  const { idType, nameType, timeType, stampType } = dialect;

  return [
    idType,
    idType,
    idType,
    nameType,

    idType,
    "INTEGER",
    timeType,
    timeType,
    timeType,
    timeType,

    timeType,
    "INTEGER",
    "INTEGER",

    "INTEGER",
    "json",
    "json",
    "json",
    "json",
    "json",

    "json",
    idType,
    timeType,
    idType,

    idType,
    // flow
    "json",
    // processed_by_id, processed_by_key, processed_by_host, processed_by_pid
    stampType,
    stampType,
    stampType,
    "INTEGER",
  ];
}

/* ------------------------------------------------------------------ *
 * Analytics (the three metric tables)
 * ------------------------------------------------------------------ */

/**
 * What identifies one analytics bucket, in primary-key order.
 *
 * `entity` is the queue, the `<queue>:<key>` of a worker or the runner's key
 * — or the empty string, which is the namespace roll-up
 * (`NAMESPACE_ENTITY`). Storing the roll-up as an entity like any other is
 * what makes `getNamespaceMetrics` three ordinary reads and keeps the prune
 * and `purge` free of a special case.
 *
 * The order is what a read wants: one entity, one width, a range of buckets,
 * which is then a primary-key range on every engine. `ns` leads, as every
 * index in this file does.
 *
 * `interval_ms` rather than `interval`: `INTERVAL` is a type keyword on
 * Postgres, MySQL and MariaDB, and an unquoted column of that name will not
 * parse.
 */
export const METRIC_KEY_COLUMNS = [
  "ns",
  "entity",
  "interval_ms",
  "bucket",
] as const;

/**
 * The columns one duration histogram bin is kept in, `h00` … `h24`.
 *
 * Twenty-five plain integers rather than one JSON array, which is the one
 * place this driver breaks with "each writer writes its bins wholesale".
 * A bucket takes more than one flush from the same writer — a minute bucket
 * takes sixty — so a stored histogram always has to be merged with one
 * already there, and no portable SQL expression adds two JSON arrays. As
 * columns the existing additive upsert merges them for free, in the one
 * statement that carries the rest of the row, and the single shared row per
 * `(ns, entity, bucket, interval)` stays uniform across all three tables.
 *
 * The bin *layout* is unchanged: the count is {@link DURATION_HISTOGRAM_SIZE}
 * and the index is `durationBin`'s, so `h07` is exactly `histogram[7]`.
 */
export const DURATION_BIN_COLUMNS: readonly string[] = Array.from(
  { length: DURATION_HISTOGRAM_SIZE },
  (_unused, bin) => `h${String(bin).padStart(2, "0")}`,
);

/** The duration statistics that merge by adding, taking a min or taking a max. */
export const DURATION_STAT_COLUMNS = [
  // Before `dur_count`, deliberately: MySQL evaluates `ON DUPLICATE KEY
  // UPDATE` assignments left to right, and both extremes are guarded by the
  // count they would otherwise read after it had already been added to.
  "dur_min_ms",
  "dur_max_ms",
  "dur_count",
  "dur_sum_ms",
] as const;

/**
 * The busyness statistics of one worker's bucket.
 *
 * In merge order for MySQL's left-to-right `ON DUPLICATE KEY UPDATE`:
 * `concurrency` reads both sides' `samples` and `last_at`, so it is assigned
 * before either of them is.
 */
export const BUSYNESS_COLUMNS = [
  "concurrency",
  "last_at",
  "samples",
  "active_sum",
  "active_max",
] as const;

/** One column of a table the driver owns. */
export interface ColumnDefinition {
  /** The column's name. */
  name: string;
  /** Its type, in this dialect's spelling. */
  type: string;
  /** Everything after the type — `NOT NULL`, a default, a serial's keywords. */
  suffix?: string;
  /**
   * Whether a sync may propose changing this column's type. Defaults to true.
   *
   * False for a column whose declared type is not what the engine reports
   * back. A serial is the case: Postgres takes `BIGSERIAL PRIMARY KEY` and
   * reports `bigint`, because `bigserial` is shorthand for a column plus a
   * sequence plus a default rather than a type. Comparing the two strings says
   * "different" every time, forever, and the statement it would generate is
   * nonsense.
   */
  retype?: boolean;
}

/** A column of an index that is ordered in a collation other than its own. */
export interface CollatedIndexColumn {
  /** The column's name. */
  name: string;
  /** The collation, exactly as written after `COLLATE`: `"C"`, quotes included. */
  collation: string;
}

/** One index the driver maintains. */
export interface IndexDefinition {
  /** The index's name, unique within the schema. */
  name: string;
  /** The table it is on. */
  table: string;
  /**
   * The columns it covers, in order: a name, or a name with the collation the
   * index orders it in when that is not the column's own.
   */
  columns: (string | CollatedIndexColumn)[];
  /** A partial-index predicate, where the engine has them. */
  predicate?: string;
}

/**
 * The table names a schema is rendered or compared against.
 *
 * The three analytics tables are optional, and one that is not named is left
 * out of the definition entirely — so a caller that knows only the shipped
 * eight gets exactly those, and adding a table here never breaks one. The
 * driver always names all eleven.
 */
export interface SchemaTableNames {
  /** The jobs table. */
  jobs: string;
  /** The locks table. */
  locks: string;
  /** The key/value table: runner state, queue metadata, repeat definitions. */
  kv: string;
  /** The events table. */
  events: string;
  /** Each job's log lines. */
  logs: string;
  /** Each runner run's captured output. */
  run_logs: string;
  /** Worker heartbeat records. */
  workers: string;
  /** Throughput per queue per minute. */
  metrics: string;
  /** A queue's analytics buckets, and the namespace's jobs roll-up. */
  queue_metrics?: string;
  /** A worker's analytics buckets, and the namespace's worker-jobs roll-up. */
  worker_metrics?: string;
  /** A runner's analytics buckets, and the namespace's runs roll-up. */
  runner_metrics?: string;
}

/** One table the driver owns, as data rather than as a DDL string. */
export interface TableDefinition {
  /** The table's name, already prefixed. */
  name: string;
  /** Its columns, in declaration order. */
  columns: ColumnDefinition[];
  /** The columns of its primary key, or none for a table without one. */
  primaryKey: string[];
}

/**
 * The three analytics tables, and the one index each needs beyond its key.
 *
 * Three rather than one because the three kinds carry different statistics:
 * a queue and a worker count two things, a runner counts six and carries a
 * duration histogram, and a worker also carries busyness. Each table holds
 * its own namespace roll-up under the empty entity, because `MetricsBuffer`
 * emits the entity row and the roll-up row in one batch and they are the same
 * shape.
 *
 * **Not on the shipped `metrics` table, and with none of its `shard` fan-out.**
 * That table's eight shards per process exist because a *per-job* statement
 * contends on one row — 1,421 ms against 2 ms, measured. These are written
 * once per entity per second from a buffer, where that contention cannot
 * arise, and fanning out anyway would turn a mid-sized namespace's 19.5 K rows
 * into 1.25 M.
 *
 * The extra index is for the prune, which names a namespace and a width but no
 * entity: `DELETE … WHERE ns = ? AND interval_ms = ? AND bucket < ?` is a
 * range of it, where the primary key — entity second — could only scan.
 */
function analyticsTables(
  names: { queue: string; worker: string; runner: string },
  dialect: SqlDialect,
  prefix: string,
): { tables: TableDefinition[]; indexes: IndexDefinition[] } {
  const { idType, timeType } = dialect;

  /** A counter or statistic: never null, so a merge is plain arithmetic. */
  const counter = (name: string): ColumnDefinition => ({
    name,
    type: "INTEGER",
    suffix: "NOT NULL DEFAULT 0",
  });

  /** A millisecond figure that can outgrow an integer: a sum of durations. */
  const millis = (name: string): ColumnDefinition => ({
    name,
    type: timeType,
    suffix: "NOT NULL DEFAULT 0",
  });

  /** What identifies a bucket, as columns. */
  const key: ColumnDefinition[] = [
    { name: "ns", type: idType, suffix: "NOT NULL" },
    { name: "entity", type: idType, suffix: "NOT NULL" },
    { name: "interval_ms", type: "INTEGER", suffix: "NOT NULL" },
    { name: "bucket", type: timeType, suffix: "NOT NULL" },
  ];

  /** The prune's index on one of these tables. */
  const pruneIndex = (table: string, label: string): IndexDefinition => ({
    name: `ix_${prefix}_${label}_prune`,
    table,
    columns: ["ns", "interval_ms", "bucket"],
  });

  return {
    tables: [
      // What each queue's backend finished, and — under the empty entity —
      // the namespace's own total, which is what makes an overview three
      // reads whatever the fleet size.
      {
        name: names.queue,
        primaryKey: [...METRIC_KEY_COLUMNS],
        columns: [...key, ...JOB_COUNTERS.map(counter)],
      },
      // What each worker finished itself, keyed by `<queue>:<stable key>` so
      // a rolling redeploy does not shred the series into one per
      // incarnation; and, in the same row, how busy its heartbeats said it
      // was. Two statements write it — the counts and the samples arrive from
      // different places — and each sets only its own columns.
      {
        name: names.worker,
        primaryKey: [...METRIC_KEY_COLUMNS],
        columns: [
          ...key,
          ...JOB_COUNTERS.map(counter),
          ...BUSYNESS_COLUMNS.map((name) =>
            name === "last_at" ? millis(name) : counter(name),
          ),
        ],
      },
      // How each runner's runs ended, and how long they took. The histogram
      // rides the same row: see DURATION_BIN_COLUMNS for why it is columns.
      {
        name: names.runner,
        primaryKey: [...METRIC_KEY_COLUMNS],
        columns: [
          ...key,
          ...RUNNER_RUN_COUNTERS.map(counter),
          ...DURATION_STAT_COLUMNS.map((name) =>
            name === "dur_count" ? counter(name) : millis(name),
          ),
          ...DURATION_BIN_COLUMNS.map(counter),
        ],
      },
    ],
    indexes: [
      pruneIndex(names.queue, "qmx"),
      pruneIndex(names.worker, "wmx"),
      pruneIndex(names.runner, "rmx"),
    ],
  };
}

/**
 * Every key of {@link SchemaTableNames}, and whether a caller must name it.
 *
 * A mapped type rather than two hand-kept lists, so the compiler keeps it
 * honest: add a key to `SchemaTableNames` and this stops compiling until the
 * key is here, with the kind its optionality implies.
 */
const TABLE_KEY_KINDS: {
  [K in keyof SchemaTableNames]-?: undefined extends SchemaTableNames[K]
    ? "analytics"
    : "required";
} = {
  jobs: "required",
  locks: "required",
  kv: "required",
  events: "required",
  logs: "required",
  run_logs: "required",
  workers: "required",
  metrics: "required",
  queue_metrics: "analytics",
  worker_metrics: "analytics",
  runner_metrics: "analytics",
};

/** The keys of {@link TABLE_KEY_KINDS} of one kind. */
function tableKeysOf(
  kind: "required" | "analytics",
): (keyof SchemaTableNames)[] {
  return (Object.keys(TABLE_KEY_KINDS) as (keyof SchemaTableNames)[]).filter(
    (key) => TABLE_KEY_KINDS[key] === kind,
  );
}

/** The tables every schema has, which a caller must always name. */
const REQUIRED_TABLES = tableKeysOf("required");

/** The analytics tables: named all together, or not at all. */
const ANALYTICS_TABLE_KEYS = tableKeysOf("analytics");

/**
 * Refuses table names the schema would render as nonsense.
 *
 * Only runtime can catch this. The types promise every required name, but a
 * key the schema reads and the caller never resolved is `undefined` all the
 * same — and interpolated into DDL that is `CREATE TABLE IF NOT EXISTS
 * undefined`, a real table on a real server, plus indexes named after it. That
 * happened once, while `logs` was in the schema and not yet in `SQL_TABLES`.
 *
 * An analytics name that is absent is not an error: the three are left out
 * together (see {@link SchemaTableNames}). One named while its siblings are
 * not is, since the schema would then drop a table the caller asked for.
 */
function assertTableNames(tables: SchemaTableNames): void {
  const given = tables as Partial<Record<keyof SchemaTableNames, unknown>>;

  /** Throws unless `value` is a usable table name. */
  const check = (key: keyof SchemaTableNames, value: unknown): void => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ConfigError(
        `The SQL schema has no name for its "${key}" table`,
        { table: key, value },
      );
    }
  };

  for (const key of REQUIRED_TABLES) {
    check(key, given[key]);
  }

  const named = ANALYTICS_TABLE_KEYS.filter((key) => given[key] !== undefined);
  if (named.length > 0) {
    for (const key of ANALYTICS_TABLE_KEYS) {
      check(key, given[key]);
    }
  }
}

/**
 * Refuses a definition that names a table it does not define.
 *
 * The inputs are already checked; this is the net under the schema itself,
 * for an index added on a table the definition forgot, or a name built from
 * something that was never set.
 */
function assertDefinition(definition: {
  tables: TableDefinition[];
  indexes: IndexDefinition[];
}): void {
  const defined = new Set<string>();
  for (const table of definition.tables) {
    if (typeof table.name !== "string" || table.name.length === 0) {
      throw new ConfigError("The SQL schema defines a table with no name", {
        columns: table.columns.map((column) => column.name),
      });
    }
    defined.add(table.name);
  }

  for (const index of definition.indexes) {
    if (typeof index.name !== "string" || index.name.length === 0) {
      throw new ConfigError("The SQL schema defines an index with no name", {
        table: index.table,
      });
    }
    if (typeof index.table !== "string" || !defined.has(index.table)) {
      throw new ConfigError(
        `The SQL schema's index "${index.name}" is on a table it does not define`,
        { index: index.name, table: index.table },
      );
    }
  }
}

/**
 * The claim index's name for a jobs table: `ix_<table>_claim`, every non-word
 * character of the table's name made `_`, as every index name is derived.
 * Named here once because a statement hints at it by name (the MySQL count of
 * jobs added in a range), and a hint naming an index the schema no longer
 * builds would be silently ignored.
 */
export function claimIndexName(jobs: string): string {
  return `ix_${jobs.replace(/\W/g, "_")}_claim`;
}

/**
 * Every table and index the driver owns, described rather than spelled out.
 *
 * `createSchema` renders this into DDL, and `syncSchema` compares it against
 * what the database actually has. One definition means the two can never
 * disagree about what the schema is supposed to be — which matters, because
 * the whole point of a sync is to answer that question.
 *
 * Throws `ConfigError`, naming the key, when a table the schema uses has no
 * name — a missing or blank required name, or one analytics name given
 * without the other two — so no statement is ever built around `undefined`.
 */
export function schemaDefinition(
  tables: SchemaTableNames,
  dialect: SqlDialect,
): { tables: TableDefinition[]; indexes: IndexDefinition[] } {
  // Before any name is read: a missing one must fail here, not become a table.
  assertTableNames(tables);

  const definition = buildDefinition(tables, dialect);
  assertDefinition(definition);
  return definition;
}

/** {@link schemaDefinition}, once its names are known to be usable. */
function buildDefinition(
  tables: SchemaTableNames,
  dialect: SqlDialect,
): { tables: TableDefinition[]; indexes: IndexDefinition[] } {
  const {
    jobs,
    locks,
    kv,
    events,
    logs,
    run_logs: runLogs,
    workers,
    metrics,
    queue_metrics: queueMetrics,
    worker_metrics: workerMetrics,
    runner_metrics: runnerMetrics,
  } = tables;
  const {
    idType,
    nameType,
    jsonType,
    timeType,
    serialType,
    longTextType,
    codePointCollation,
    claimIndexNamesId,
    stampType,
  } = dialect;

  // Index names have to be unique within a schema, so they are derived from
  // the table they belong to rather than from a prefix that may not exist.
  const prefix = jobs.replace(/\W/g, "_");

  // The analytics tables, or nothing at all when the caller named none of
  // them — see {@link SchemaTableNames}.
  const analytics =
    queueMetrics && workerMetrics && runnerMetrics
      ? analyticsTables(
          {
            queue: queueMetrics,
            worker: workerMetrics,
            runner: runnerMetrics,
          },
          dialect,
          prefix,
        )
      : { tables: [], indexes: [] };

  return {
    tables: [
      {
        name: jobs,
        primaryKey: ["ns", "queue", "id"],
        columns: [
          { name: "ns", type: idType, suffix: "NOT NULL" },
          { name: "queue", type: idType, suffix: "NOT NULL" },
          { name: "id", type: idType, suffix: "NOT NULL" },
          { name: "name", type: nameType, suffix: "NOT NULL" },
          { name: "state", type: idType, suffix: "NOT NULL" },
          { name: "priority", type: "INTEGER", suffix: "NOT NULL DEFAULT 0" },
          { name: "run_at", type: timeType, suffix: "NOT NULL" },
          { name: "created_at", type: timeType, suffix: "NOT NULL" },
          { name: "processed_on", type: timeType },
          { name: "finished_on", type: timeType },
          { name: "expires_at", type: timeType },
          {
            name: "attempts_made",
            type: "INTEGER",
            suffix: "NOT NULL DEFAULT 0",
          },
          {
            name: "max_attempts",
            type: "INTEGER",
            suffix: "NOT NULL DEFAULT 1",
          },
          {
            name: "stalled_count",
            type: "INTEGER",
            suffix: "NOT NULL DEFAULT 0",
          },
          { name: "data", type: jsonType },
          { name: "opts", type: jsonType },
          { name: "progress", type: jsonType },
          { name: "return_value", type: jsonType },
          { name: "failed_reason", type: jsonType },
          { name: "stacktrace", type: jsonType },
          { name: "lock_token", type: idType },
          { name: "lock_expires_at", type: timeType },
          { name: "worker_id", type: idType },
          { name: "repeat_key", type: idType },
          // Which log lines are this job's: a random token given the first
          // time the job logs anything, and null until then. Nothing on the
          // insert, claim or completion paths names it.
          { name: "log_key", type: idType },
          // A job's place in a flow — its parent, its children, what they
          // returned — as one document, null for a job in no flow. One column
          // rather than one per detail: it is read and written whole, only by
          // the flow paths, and a sync adds a nullable column without a lock.
          { name: "flow", type: jsonType },
          // The attribution stamp, `processedBy`: who claimed the current or
          // last attempt. Written by the claim, in the statement that already
          // sets `worker_id`, and named by no settle, so it outlives the
          // attempt while `worker_id` — the holder — still goes with the lock.
          // Nullable, so a sync adds them without a lock, and a job never
          // claimed has none. Never indexed: a worker filter is a condition
          // within the `(ns, queue, state)` range, like a name filter.
          { name: "processed_by_id", type: stampType },
          { name: "processed_by_key", type: stampType },
          { name: "processed_by_host", type: stampType },
          { name: "processed_by_pid", type: "INTEGER" },
        ],
      },
      {
        name: locks,
        primaryKey: ["ns", "lock_key"],
        columns: [
          { name: "ns", type: idType, suffix: "NOT NULL" },
          { name: "lock_key", type: idType, suffix: "NOT NULL" },
          { name: "token", type: idType, suffix: "NOT NULL" },
          { name: "expires_at", type: timeType, suffix: "NOT NULL" },
        ],
      },
      {
        name: kv,
        primaryKey: ["ns", "kv_key"],
        columns: [
          { name: "ns", type: idType, suffix: "NOT NULL" },
          { name: "kv_key", type: idType, suffix: "NOT NULL" },
          { name: "value", type: jsonType },
          { name: "updated_at", type: timeType, suffix: "NOT NULL" },
        ],
      },
      {
        name: events,
        primaryKey: [],
        columns: [
          { name: "seq", type: serialType, retype: false },
          { name: "ns", type: idType, suffix: "NOT NULL" },
          { name: "channel", type: idType, suffix: "NOT NULL" },
          { name: "payload", type: jsonType },
          { name: "created_at", type: timeType, suffix: "NOT NULL" },
        ],
      },
      // A job's log, one row per line. Not a column on `jobs`: appending to a
      // document means rewriting it whole, and a log is written a line at a
      // time while the job runs.
      //
      // `log_key` is which job the line belongs to, not just which id.
      // Deleting a job does not delete its lines — the delete on completion is
      // a single statement on the hot path, and stays one — so every read
      // matches it against the key of the job row that holds the id now. A
      // job added later under the same id has no key yet, and so starts with
      // an empty log while the old lines wait for the sweep.
      //
      // Not `created_at`, which was the first design: a job completed with
      // `removeOnComplete` and re-added under its id lands in the same
      // millisecond far too often to tell the two apart — measured on SQLite,
      // 2,211 of 3,000 re-adds, each of which read the old job's lines.
      //
      // `job_id` stays so the sweep can find a line's job by primary key.
      {
        name: logs,
        primaryKey: [],
        columns: [
          { name: "seq", type: serialType, retype: false },
          { name: "ns", type: idType, suffix: "NOT NULL" },
          { name: "queue", type: idType, suffix: "NOT NULL" },
          { name: "job_id", type: idType, suffix: "NOT NULL" },
          { name: "log_key", type: idType, suffix: "NOT NULL" },
          { name: "message", type: longTextType, suffix: "NOT NULL" },
        ],
      },
      // A runner's captured run output, one row per line. Not part of the
      // runner's `kv` state row for the same reason a job's log is not a
      // column on `jobs`, only more so: that row holds the whole history and
      // is read-modify-written inside a transaction on every change, so a line
      // arriving every few milliseconds would rewrite the entire history that
      // often and contend with every other writer of it.
      //
      // Two numbers, deliberately. `seq` is the insertion order, which orders
      // the index and breaks ties; `line_no` is the run's own 1-based
      // numbering, which is what the contract exposes as `RunLogLine.seq`. It
      // has to be separate: trimming deletes from the front, so the gap
      // between `line_no` 1 and the lowest one still stored is exactly how
      // many lines a cap dropped, and nothing has to count them.
      //
      // `bytes` is the line's UTF-8 length, computed by the driver rather than
      // by the engine. The byte cap would otherwise need a portable
      // byte-length function, and there is not one: `LENGTH` counts characters
      // on MySQL and MariaDB, and `OCTET_LENGTH` is not in every SQLite build.
      {
        name: runLogs,
        primaryKey: [],
        columns: [
          { name: "seq", type: serialType, retype: false },
          { name: "ns", type: idType, suffix: "NOT NULL" },
          { name: "runner_key", type: idType, suffix: "NOT NULL" },
          { name: "run_id", type: idType, suffix: "NOT NULL" },
          { name: "line_no", type: "INTEGER", suffix: "NOT NULL" },
          { name: "stream", type: idType, suffix: "NOT NULL" },
          { name: "at", type: timeType, suffix: "NOT NULL" },
          { name: "bytes", type: "INTEGER", suffix: "NOT NULL DEFAULT 0" },
          // Null on a `stdout`/`stderr` line, which has no level at all.
          { name: "level", type: idType },
          // 1 when capture cut the line short, 0 otherwise. An integer rather
          // than a boolean: SQLite and MySQL have no real boolean type, and
          // this way every engine stores and compares the same thing.
          { name: "truncated", type: "INTEGER", suffix: "NOT NULL DEFAULT 0" },
          { name: "message", type: longTextType, suffix: "NOT NULL" },
        ],
      },
      // Each worker's heartbeat record: one row per worker, replaced on every
      // report and read by `listWorkers`. Its own table rather than a `kv`
      // entry because a lapsed record is found and removed by `expires_at`,
      // which a JSON value cannot be filtered on portably. The primary key is
      // every index it needs: every read and write names the queue.
      {
        name: workers,
        primaryKey: ["ns", "queue", "id"],
        columns: [
          { name: "ns", type: idType, suffix: "NOT NULL" },
          { name: "queue", type: idType, suffix: "NOT NULL" },
          { name: "id", type: idType, suffix: "NOT NULL" },
          { name: "info", type: jsonType },
          { name: "expires_at", type: timeType, suffix: "NOT NULL" },
        ],
      },
      // Completed jobs and failed attempts per queue per minute. `shard` is
      // who counted: the lock token on Postgres, which counts inside the
      // completion statement, and the driver instance elsewhere, which writes
      // what it gathered once a second. Different writers therefore never
      // contend for a row, and a read sums a minute's rows. The primary key
      // leads with the queue and then the minute, so a range read and the
      // retention delete are both key ranges.
      {
        name: metrics,
        primaryKey: ["ns", "queue", "bucket", "shard"],
        columns: [
          { name: "ns", type: idType, suffix: "NOT NULL" },
          { name: "queue", type: idType, suffix: "NOT NULL" },
          { name: "bucket", type: timeType, suffix: "NOT NULL" },
          { name: "shard", type: idType, suffix: "NOT NULL" },
          { name: "completed", type: "INTEGER", suffix: "NOT NULL DEFAULT 0" },
          { name: "failed", type: "INTEGER", suffix: "NOT NULL DEFAULT 0" },
        ],
      },
      ...analytics.tables,
    ],
    indexes: [
      // Claim order: the queue's due, waiting jobs, cheapest first.
      {
        name: claimIndexName(jobs),
        table: jobs,
        // `id` is the order's last key; named only where the engine will not
        // read it from the primary-key suffix (MySQL, see the dialect).
        columns: [
          "ns",
          "queue",
          "state",
          "priority",
          "created_at",
          ...(claimIndexNamesId ? ["id"] : []),
        ],
      },
      // Promotion: what is due but not yet claimable.
      {
        name: `ix_${prefix}_due`,
        table: jobs,
        columns: ["ns", "queue", "state", "run_at"],
      },
      // Stalled recovery: active jobs whose lock has lapsed. Partial where the
      // engine allows, because a job that has never been claimed has no lock
      // and has no business in here.
      {
        name: `ix_${prefix}_lock`,
        table: jobs,
        columns: ["ns", "queue", "state", "lock_expires_at"],
        predicate: "lock_expires_at IS NOT NULL",
      },
      // Retention: whatever has expired, across queues. Partial for the same
      // reason — most jobs never have an expiry set at all.
      {
        name: `ix_${prefix}_exp`,
        table: jobs,
        columns: ["expires_at"],
        predicate: "expires_at IS NOT NULL",
      },

      // There is deliberately no plain index on `finished_on`. Cleaning reads
      // `COALESCE(finished_on, created_at) <= $cutoff`, which no index can
      // satisfy — it is applied as a filter either way — so the only part of
      // such an index the planner can use is the `(ns, queue, state)` prefix,
      // which `ix_..._claim` already provides. Verified on 200,000 rows: with
      // the index the plan is an index scan on it, without the index it is an
      // index scan on `ix_..._claim` with the identical index condition, the
      // same three buffers and a cost of 340.70 against 334.50. It only ever
      // cost a write per insert.
      //
      // A *partial* one on finished jobs is another matter, and exists on
      // SQLite only. A job enters it once, when it finishes, so an insert or a
      // claim never writes to it; it turns a `finishedOn` range — the job
      // list's date filter — and a finished state's `ORDER BY finished_on`
      // into an index range rather than a sort of every finished row of the
      // queue. Measured with 100,000 finished jobs kept, SQLite paid nothing
      // for it on completion and read about 20x faster.
      //
      // Postgres paid a lot: completions ran 25-35% slower with it (10.5k to
      // 13.8k/s against 16k to 17.7k/s), for a worker-page read of 15-20ms
      // falling to 3-4ms. That is the wrong trade for a queue, so Postgres does
      // not define it, and `syncSchema` drops one an earlier version built
      // (it carries the driver's `ix_` name), `CONCURRENTLY`. On MySQL and
      // MariaDB, without partial indexes, it would be written on every insert
      // and state change, which is the cost above.
      ...(dialect.name !== "sqlite"
        ? []
        : [
            {
              name: `ix_${prefix}_fin`,
              table: jobs,
              columns: ["ns", "queue", "state", "finished_on"],
              predicate: "finished_on IS NOT NULL",
            },
          ]),

      {
        name: `ix_${prefix}_events`,
        table: events,
        columns: ["ns", "channel", "seq"],
      },
      // One job's lines in order, reached through its key; and the orphan
      // sweep's walk through a queue's lines, which pages on `(log_key, seq)`
      // so it never scans past its page. One index serves both, so a line
      // costs a single index write.
      {
        name: `ix_${prefix}_logs`,
        table: logs,
        columns: ["ns", "queue", "log_key", "seq"],
      },
      // One run's lines in order, reached by run id; and, on its `(ns,
      // runner_key)` prefix, the walk `keepRuns` makes over a runner's runs to
      // find the oldest. One index serves both, so a captured line costs a
      // single index write — which matters, because a chatty run writes a lot
      // of them.
      {
        name: `ix_${prefix}_run_logs`,
        table: runLogs,
        columns: ["ns", "runner_key", "run_id", "line_no"],
      },
      // Queue state listed in code-point order, as a range rather than a
      // filter. Only where the primary key cannot serve it: on Postgres the key
      // is in the database's locale, so a `kv_key COLLATE "C"` bound is no
      // bound on it and only `ns` narrows the scan. Everywhere else the key
      // already is code-point order, and a second index would be a write per
      // row for nothing.
      ...(codePointCollation
        ? [
            {
              name: `ix_${prefix}_kv_order`,
              table: kv,
              columns: [
                "ns",
                { name: "kv_key", collation: codePointCollation },
              ],
            },
          ]
        : []),

      ...analytics.indexes,
    ],
  };
}

/** One column, as it appears inside a `CREATE TABLE`. */
export function renderColumn(column: ColumnDefinition): string {
  return `${column.name} ${column.type}${column.suffix ? ` ${column.suffix}` : ""}`;
}

/** One index column as it appears in a `CREATE INDEX`. */
export function renderIndexColumn(
  column: string | CollatedIndexColumn,
): string {
  return typeof column === "string"
    ? column
    : `${column.name} COLLATE ${column.collation}`;
}

/** The `CREATE INDEX` for one index definition. */
export function renderIndex(
  index: IndexDefinition,
  dialect: SqlDialect,
  concurrently = false,
): string {
  const where = index.predicate ? dialect.partialIndex(index.predicate) : "";
  const how = concurrently ? dialect.concurrentIndex : "";

  const ifNotExists = dialect.indexIfNotExists ? "IF NOT EXISTS " : "";

  return `CREATE INDEX ${how}${ifNotExists}${index.name} ON ${index.table} (${index.columns.map(renderIndexColumn).join(", ")})${where}`;
}

/**
 * Statements creating everything, each safe to run repeatedly.
 *
 * `existing` names tables that were already there, whose indexes are left
 * out. An index the driver defines on a table it did not just create is a new
 * index on a table that may be large and busy, and a plain `CREATE INDEX`
 * blocks every write to it for the whole build — on the first process of an
 * upgrade to connect, before anyone asked for it. That belongs to
 * `syncSchema`, which reports it as a `create-index` change and builds it
 * `CONCURRENTLY` on Postgres. Empty by default: everything is created.
 */
export function createSchema(
  tables: SchemaTableNames,
  dialect: SqlDialect,
  existing: ReadonlySet<string> = new Set(),
): string[] {
  const { tables: definitions, indexes } = schemaDefinition(tables, dialect);

  return [
    ...definitions.map((table) => {
      const body = [
        ...table.columns.map(renderColumn),
        ...(table.primaryKey.length > 0
          ? [`PRIMARY KEY (${table.primaryKey.join(", ")})`]
          : []),
      ].join(",\n      ");

      return `CREATE TABLE IF NOT EXISTS ${table.name} (\n      ${body}\n    )`;
    }),
    ...indexes
      .filter((index) => !existing.has(index.table))
      .map((index) => renderIndex(index, dialect)),
  ];
}
