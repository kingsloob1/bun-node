import type { SqlDialect } from "./dialect";

/**
 * The tables, and the indexes that make the hot paths cheap.
 *
 * Four tables rather than one per concern: `jobs`, `locks`, `kv` (runner
 * state, queue metadata and repeat definitions) and `events`. Every table
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
] as const;

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
  const { idType, timeType } = dialect;

  return [
    idType,
    idType,
    idType,
    "TEXT",

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
  ];
}

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

/** One index the driver maintains. */
export interface IndexDefinition {
  /** The index's name, unique within the schema. */
  name: string;
  /** The table it is on. */
  table: string;
  /** The columns it covers, in order. */
  columns: string[];
  /** A partial-index predicate, where the engine has them. */
  predicate?: string;
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
 * Every table and index the driver owns, described rather than spelled out.
 *
 * `createSchema` renders this into DDL, and `syncSchema` compares it against
 * what the database actually has. One definition means the two can never
 * disagree about what the schema is supposed to be — which matters, because
 * the whole point of a sync is to answer that question.
 */
export function schemaDefinition(
  tables: { jobs: string; locks: string; kv: string; events: string },
  dialect: SqlDialect,
): { tables: TableDefinition[]; indexes: IndexDefinition[] } {
  const { jobs, locks, kv, events } = tables;
  const { idType, jsonType, timeType, serialType } = dialect;

  // Index names have to be unique within a schema, so they are derived from
  // the table they belong to rather than from a prefix that may not exist.
  const prefix = jobs.replace(/\W/g, "_");

  return {
    tables: [
      {
        name: jobs,
        primaryKey: ["ns", "queue", "id"],
        columns: [
          { name: "ns", type: idType, suffix: "NOT NULL" },
          { name: "queue", type: idType, suffix: "NOT NULL" },
          { name: "id", type: idType, suffix: "NOT NULL" },
          { name: "name", type: "TEXT", suffix: "NOT NULL" },
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
    ],
    indexes: [
      // Claim order: the queue's due, waiting jobs, cheapest first.
      {
        name: `ix_${prefix}_claim`,
        table: jobs,
        columns: ["ns", "queue", "state", "priority", "created_at"],
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

      // There is deliberately no index on `finished_on`. Cleaning reads
      // `COALESCE(finished_on, created_at) <= $cutoff`, which no index can
      // satisfy — it is applied as a filter either way — so the only part of
      // such an index the planner can use is the `(ns, queue, state)` prefix,
      // which `ix_..._claim` already provides. Verified on 200,000 rows: with
      // the index the plan is an index scan on it, without the index it is an
      // index scan on `ix_..._claim` with the identical index condition, the
      // same three buffers and a cost of 340.70 against 334.50. It only ever
      // cost a write per insert.

      {
        name: `ix_${prefix}_events`,
        table: events,
        columns: ["ns", "channel", "seq"],
      },
    ],
  };
}

/** One column, as it appears inside a `CREATE TABLE`. */
export function renderColumn(column: ColumnDefinition): string {
  return `${column.name} ${column.type}${column.suffix ? ` ${column.suffix}` : ""}`;
}

/** The `CREATE INDEX` for one index definition. */
export function renderIndex(
  index: IndexDefinition,
  dialect: SqlDialect,
  concurrently = false,
): string {
  const where = index.predicate ? dialect.partialIndex(index.predicate) : "";
  const how = concurrently ? dialect.concurrentIndex : "";

  return `CREATE INDEX ${how}IF NOT EXISTS ${index.name} ON ${index.table} (${index.columns.join(", ")})${where}`;
}

/** Statements creating everything, each safe to run repeatedly. */
export function createSchema(
  tables: { jobs: string; locks: string; kv: string; events: string },
  dialect: SqlDialect,
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
    ...indexes.map((index) => renderIndex(index, dialect)),
  ];
}
