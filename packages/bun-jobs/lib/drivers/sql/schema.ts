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

/** Statements creating everything, each safe to run repeatedly. */
export function createSchema(
  tables: { jobs: string; locks: string; kv: string; events: string },
  dialect: SqlDialect,
): string[] {
  const { jobs, locks, kv, events } = tables;
  const { idType, jsonType, timeType, serialType } = dialect;

  // Index names have to be unique within a schema, so they are derived from
  // the table they belong to rather than from a prefix that may not exist.
  const prefix = jobs.replace(/\W/g, "_");

  return [
    `CREATE TABLE IF NOT EXISTS ${jobs} (
      ns ${idType} NOT NULL,
      queue ${idType} NOT NULL,
      id ${idType} NOT NULL,
      name TEXT NOT NULL,
      state ${idType} NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      run_at ${timeType} NOT NULL,
      created_at ${timeType} NOT NULL,
      processed_on ${timeType},
      finished_on ${timeType},
      expires_at ${timeType},
      attempts_made INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      stalled_count INTEGER NOT NULL DEFAULT 0,
      data ${jsonType},
      opts ${jsonType},
      progress ${jsonType},
      return_value ${jsonType},
      failed_reason ${jsonType},
      stacktrace ${jsonType},
      lock_token ${idType},
      lock_expires_at ${timeType},
      worker_id ${idType},
      repeat_key ${idType},
      PRIMARY KEY (ns, queue, id)
    )`,
    // Claim order: the queue's due, waiting jobs, cheapest first.
    `CREATE INDEX IF NOT EXISTS ix_${prefix}_claim ON ${jobs} (ns, queue, state, priority, created_at)`,
    // Promotion: what is due but not yet claimable.
    `CREATE INDEX IF NOT EXISTS ix_${prefix}_due ON ${jobs} (ns, queue, state, run_at)`,
    // Stalled recovery: active jobs whose lock has lapsed. Partial where the
    // engine allows, because a job that has never been claimed has no lock and
    // has no business in here.
    `CREATE INDEX IF NOT EXISTS ix_${prefix}_lock ON ${jobs} (ns, queue, state, lock_expires_at)${dialect.partialIndex(
      "lock_expires_at IS NOT NULL",
    )}`,
    // Retention: whatever has expired, across queues. Partial for the same
    // reason — most jobs never have an expiry set at all.
    `CREATE INDEX IF NOT EXISTS ix_${prefix}_exp ON ${jobs} (expires_at)${dialect.partialIndex(
      "expires_at IS NOT NULL",
    )}`,

    // There is deliberately no index on `finished_on`. Cleaning reads
    // `COALESCE(finished_on, created_at) <= $cutoff`, which no index can
    // satisfy — it is applied as a filter either way — so the only part of
    // such an index the planner can use is the `(ns, queue, state)` prefix,
    // which `ix_..._claim` already provides. Verified on 200,000 rows: with
    // the index the plan is an index scan on it, without the index it is an
    // index scan on `ix_..._claim` with the identical index condition, the
    // same three buffers and a cost of 340.70 against 334.50. It only ever
    // cost a write per insert.

    `CREATE TABLE IF NOT EXISTS ${locks} (
      ns ${idType} NOT NULL,
      lock_key ${idType} NOT NULL,
      token ${idType} NOT NULL,
      expires_at ${timeType} NOT NULL,
      PRIMARY KEY (ns, lock_key)
    )`,

    `CREATE TABLE IF NOT EXISTS ${kv} (
      ns ${idType} NOT NULL,
      kv_key ${idType} NOT NULL,
      value ${jsonType},
      updated_at ${timeType} NOT NULL,
      PRIMARY KEY (ns, kv_key)
    )`,

    `CREATE TABLE IF NOT EXISTS ${events} (
      seq ${serialType},
      ns ${idType} NOT NULL,
      channel ${idType} NOT NULL,
      payload ${jsonType},
      created_at ${timeType} NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ix_${prefix}_events ON ${events} (ns, channel, seq)`,
  ];
}
