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
    // Stalled recovery: active jobs whose lock has lapsed.
    `CREATE INDEX IF NOT EXISTS ix_${prefix}_lock ON ${jobs} (ns, queue, state, lock_expires_at)`,
    // Cleaning: finished jobs, oldest first.
    `CREATE INDEX IF NOT EXISTS ix_${prefix}_done ON ${jobs} (ns, queue, state, finished_on)`,
    // Retention: whatever has expired, across queues.
    `CREATE INDEX IF NOT EXISTS ix_${prefix}_exp ON ${jobs} (expires_at)`,

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
