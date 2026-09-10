import type { SerializedError } from "@kingsleyweb/bun-common";
import type { SQL } from "bun";
import type {
  ClaimOptions,
  DriverCapabilities,
  DriverEvent,
  FailOutcome,
  JobRecord,
  JobsDriver,
  JobState,
  LockInfo,
  QueuedTrigger,
  QueueRef,
  RepeatRecord,
  ResolvedJobOptions,
  Retention,
  RunRecord,
} from "../driver";
import type { SqlAdapter, SqlDialect } from "./dialect";
import { jsonClone, sleep } from "@kingsleyweb/bun-common";
import { SQL as BunSQL } from "bun";
import { DriverError } from "../../shared/errors";
import { detectAdapter, dialectFor } from "./dialect";
import { createSchema, JOB_COLUMNS } from "./schema";

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

/** Every job state, in the order `countJobs` reports them. */
const STATES: JobState[] = [
  "waiting",
  "delayed",
  "active",
  "completed",
  "failed",
  "dead",
];

/** States holding a job that is due later. */
const SCHEDULED: JobState[] = ["delayed", "failed"];

/** Options for {@link SqlDriver}. */
export interface SqlDriverOptions {
  /** Connection string. Its scheme picks the engine unless `adapter` says. */
  url?: string;
  /** Overrides the engine detected from `url`. */
  adapter?: SqlAdapter;
  /** Prefix for every table name. Defaults to `bun_jobs_`. */
  tablePrefix?: string;
  /** An already-open `Bun.SQL`, when the application has one to share. */
  sql?: SQL;
  /** How often a wait re-checks for work. Defaults to 50ms. */
  pollInterval?: number;
}

export class SqlDriver implements JobsDriver {
  /** Identifies the implementation in errors and capability checks. */
  readonly name = "sql";

  /** Which engine this instance talks to. */
  readonly adapter: SqlAdapter;
  /** What that engine does its own way. */
  readonly dialect: SqlDialect;

  /**
   * A database is reachable from anywhere, and its concurrency control is
   * what makes claiming safe. Waiting is polled: `LISTEN/NOTIFY` exists on
   * Postgres but not the others, so the contract stays the same everywhere.
   */
  readonly capabilities: DriverCapabilities = {
    blockingWait: false,
    events: "poll",
    multiProcess: true,
    multiHost: true,
  };

  /** Table names, prefix already applied. */
  readonly #tables: {
    jobs: string;
    locks: string;
    kv: string;
    events: string;
  };

  /** The connection. */
  readonly #sql: SQL;
  /** Whether this driver opened the connection and must close it. */
  readonly #ownsConnection: boolean;
  /** How often a wait re-checks. */
  readonly #poll: number;
  /** Resolves once the schema exists. */
  #ready: Promise<void> | undefined;
  /** Active event subscriptions, so `close()` can stop them. */
  readonly #subscriptions = new Set<() => void>();

  constructor(options: SqlDriverOptions) {
    this.adapter = options.adapter ?? detectAdapter(options.url);
    this.dialect = dialectFor(this.adapter);

    const prefix = options.tablePrefix ?? "bun_jobs_";
    this.#tables = {
      jobs: `${prefix}jobs`,
      locks: `${prefix}locks`,
      kv: `${prefix}kv`,
      events: `${prefix}events`,
    };

    this.#poll = options.pollInterval ?? POLL_MS;
    this.#ownsConnection = !options.sql;
    this.#sql = options.sql ?? new BunSQL({ url: options.url });
  }

  /* --- lifecycle ---------------------------------------------------- */

  async connect(): Promise<void> {
    // One migration per instance, shared by every concurrent caller.
    this.#ready ??= this.#migrate();
    await this.#ready;
  }

  async close(): Promise<void> {
    for (const stop of this.#subscriptions) {
      stop();
    }
    this.#subscriptions.clear();

    if (this.#ownsConnection) {
      await this.#sql.close();
    }
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
      this.#all<{ kv_key: string }>(
        `SELECT kv_key FROM ${this.#tables.kv}
          WHERE ns = ${metaQuery.bind(ns)} AND kv_key LIKE ${metaQuery.bind("q:%:meta")}`,
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
    const inserted = await this.#run(
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
    const { bind, values } = this.#binder();
    const taken = await this.#run(
      `UPDATE ${this.#tables.locks}
         SET token = ${bind(token)}, expires_at = ${bind(expiresAt)}
       WHERE ns = ${bind(ns)} AND lock_key = ${bind(key)}
         AND (expires_at <= ${bind(now)} OR token = ${bind(token)})`,
      values,
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

    const { bind, values } = this.#binder();
    const renewed = await this.#run(
      `UPDATE ${this.#tables.locks}
         SET expires_at = ${bind(now + ttlMs)}
       WHERE ns = ${bind(ns)} AND lock_key = ${bind(key)}
         AND token = ${bind(token)} AND expires_at > ${bind(now)}`,
      values,
    );

    return renewed > 0;
  }

  async releaseLock(ns: string, key: string, token: string): Promise<boolean> {
    await this.connect();

    const { bind, values } = this.#binder();
    const released = await this.#run(
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
    let trigger: QueuedTrigger | null = null;

    await this.#mutateState(ns, key, (state) => {
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
    // The schema is shared; a queue exists as soon as something references it.
    await this.#writeKv(q.ns, `q:${q.queue}:meta`, { paused: false }, false);
  }

  async addJob(
    q: QueueRef,
    job: JobRecord,
  ): Promise<{ job: JobRecord; added: boolean }> {
    await this.connect();

    const added = await this.#run(
      this.dialect.insertIgnore(this.#tables.jobs, [...JOB_COLUMNS]),
      this.#toRow(q, job),
    );

    if (added > 0) {
      return { job: jsonClone(job), added: true };
    }

    const existing = await this.getJob(q, job.id);
    return { job: existing ?? jsonClone(job), added: false };
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
    await this.connect();

    if (await this.isQueuePaused(q)) {
      return null;
    }

    await this.promoteDelayed(q, opts.now, 1000);

    // The claim is one conditional UPDATE: whichever transaction commits it
    // owns the job, and every other sees zero rows affected.
    const { bind, values } = this.#binder();

    const update = `UPDATE ${this.#tables.jobs}
         SET state = 'active',
             attempts_made = attempts_made + 1,
             processed_on = ${bind(opts.now)},
             lock_token = ${bind(opts.token)},
             lock_expires_at = ${bind(opts.now + opts.lockMs)},
             worker_id = ${bind(opts.workerId)}
       WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
         AND state = 'waiting'
         AND id IN (${this.dialect.limitedIdSubquery(
           `SELECT id FROM ${this.#tables.jobs}
             WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
               AND state = 'waiting' AND run_at <= ${bind(opts.now)}
             ORDER BY priority ASC, created_at ASC, id ASC
             LIMIT 1${this.dialect.supportsSkipLocked ? " FOR UPDATE SKIP LOCKED" : ""}`,
         )})`;

    return await this.dialect.transaction(this.#sql, async (tx) => {
      if (this.dialect.supportsReturning) {
        const rows = await this.#all<Record<string, unknown>>(
          `${update} RETURNING *`,
          values,
          tx,
        );
        return rows[0] ? this.#toRecord(rows[0]) : null;
      }

      // MariaDB cannot return the updated row, so it is read back by the
      // token only this claim used.
      const claimed = await this.#run(update, values, tx);
      if (claimed === 0) {
        return null;
      }

      const read = this.#binder();
      const row = await this.#one<Record<string, unknown>>(
        `SELECT * FROM ${this.#tables.jobs}
          WHERE ns = ${read.bind(q.ns)} AND queue = ${read.bind(q.queue)}
            AND lock_token = ${read.bind(opts.token)}`,
        read.values,
        tx,
      );

      return row ? this.#toRecord(row) : null;
    });
  }

  async extendJobLock(
    q: QueueRef,
    id: string,
    token: string,
    lockMs: number,
    now: number,
  ): Promise<boolean> {
    await this.connect();

    const { bind, values } = this.#binder();
    const extended = await this.#run(
      `UPDATE ${this.#tables.jobs} SET lock_expires_at = ${bind(now + lockMs)}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}
          AND state = 'active' AND lock_token = ${bind(token)}`,
      values,
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

    const { bind, values } = this.#binder();
    const completed = await this.#run(
      `UPDATE ${this.#tables.jobs}
          SET state = 'completed', finished_on = ${bind(now)},
              return_value = ${bind(this.dialect.jsonIn(result ?? null))},
              expires_at = ${bind(expiresAt)},
              lock_token = NULL, lock_expires_at = NULL, worker_id = NULL
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}
          AND state = 'active' AND lock_token = ${bind(token)}`,
      values,
    );

    if (completed === 0) {
      return false;
    }

    await this.#applyRetention(q, id, "completed", retention, now);
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
    const updated = await this.#run(
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

  async updateProgress(
    q: QueueRef,
    id: string,
    progress: unknown,
  ): Promise<boolean> {
    await this.connect();

    const { bind, values } = this.#binder();
    const updated = await this.#run(
      `UPDATE ${this.#tables.jobs} SET progress = ${bind(this.dialect.jsonIn(progress))}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}`,
      values,
    );

    return updated > 0;
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

  async listJobs(
    q: QueueRef,
    states: JobState[],
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<JobRecord[]> {
    await this.connect();

    const { bind, values } = this.#binder();

    // A single state is listed in its own natural order; several states share
    // only creation time.
    const order =
      states.length === 1 && states[0] === "waiting"
        ? `priority ${opts.order}, created_at ${opts.order}, id ${opts.order}`
        : `created_at ${opts.order}, id ${opts.order}`;

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
    } satisfies Record<JobState, number>;

    for (const row of rows) {
      if (STATES.includes(row.state)) {
        counts[row.state] = Number(row.total);
      }
    }

    return counts;
  }

  async removeJob(q: QueueRef, id: string): Promise<boolean> {
    await this.connect();

    const { bind, values } = this.#binder();
    const removed = await this.#run(
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

    const { bind, values } = this.#binder();
    const retried = await this.#run(
      `UPDATE ${this.#tables.jobs}
          SET state = 'waiting', run_at = ${bind(now)}, finished_on = NULL,
              expires_at = NULL${resetAttempts ? ", attempts_made = 0, stalled_count = 0" : ""}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}
          AND state NOT IN ('active', 'waiting')`,
      values,
    );

    return retried > 0;
  }

  async promoteJob(q: QueueRef, id: string, now: number): Promise<boolean> {
    await this.connect();

    const { bind, values } = this.#binder();
    const promoted = await this.#run(
      `UPDATE ${this.#tables.jobs} SET state = 'waiting', run_at = ${bind(now)}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}
          AND state IN ('delayed', 'failed')`,
      values,
    );

    return promoted > 0;
  }

  async promoteDelayed(
    q: QueueRef,
    now: number,
    limit: number,
  ): Promise<number> {
    await this.connect();

    const { bind, values } = this.#binder();

    return await this.#run(
      `UPDATE ${this.#tables.jobs} SET state = 'waiting'
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
          AND state IN ('delayed', 'failed')
          AND id IN (${this.dialect.limitedIdSubquery(
            `SELECT id FROM ${this.#tables.jobs}
              WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
                AND state IN ('delayed', 'failed') AND run_at <= ${bind(now)}
              ORDER BY run_at ASC
              LIMIT ${Math.max(1, Math.floor(limit))}`,
          )})`,
      values,
    );
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

    return { requeued, dead };
  }

  async cleanJobs(
    q: QueueRef,
    state: "completed" | "failed" | "dead" | "waiting" | "delayed",
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

    for (const row of rows) {
      await this.#deleteJob(q, row.id);
    }

    return rows.map((row) => row.id);
  }

  async pruneExpired(q: QueueRef, now: number, limit: number): Promise<number> {
    await this.connect();

    const scan = this.#binder();
    const rows = await this.#all<{ id: string }>(
      `SELECT id FROM ${this.#tables.jobs}
        WHERE ns = ${scan.bind(q.ns)} AND queue = ${scan.bind(q.queue)}
          AND expires_at IS NOT NULL AND expires_at <= ${scan.bind(now)}
        LIMIT ${Math.max(1, Math.floor(limit))}`,
      scan.values,
    );

    let removed = 0;
    for (const row of rows) {
      removed += await this.#deleteJob(q, row.id);
    }

    return removed;
  }

  async drainQueue(q: QueueRef, includeDelayed: boolean): Promise<number> {
    await this.connect();

    const states = includeDelayed ? ["waiting", ...SCHEDULED] : ["waiting"];
    const { bind, values } = this.#binder();

    return await this.#run(
      `DELETE FROM ${this.#tables.jobs}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
          AND state IN (${states.map((state) => bind(state)).join(", ")})`,
      values,
    );
  }

  async pauseQueue(q: QueueRef): Promise<void> {
    await this.#writeKv(q.ns, `q:${q.queue}:meta`, { paused: true }, true);
  }

  async resumeQueue(q: QueueRef): Promise<void> {
    await this.#writeKv(q.ns, `q:${q.queue}:meta`, { paused: false }, true);
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
    await this.#writeKv(q.ns, `q:${q.queue}:repeat:${def.key}`, def, true);
  }

  async getRepeat(q: QueueRef, key: string): Promise<RepeatRecord | null> {
    return await this.#readKv<RepeatRecord>(q.ns, `q:${q.queue}:repeat:${key}`);
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
    const removed = await this.#run(
      `DELETE FROM ${this.#tables.kv}
        WHERE ns = ${bind(q.ns)} AND kv_key = ${bind(`q:${q.queue}:repeat:${key}`)}`,
      values,
    );

    return removed > 0;
  }

  /* --- queue: waiting and events ------------------------------------------ */

  async nextDelayedAt(q: QueueRef): Promise<number | null> {
    await this.connect();

    const { bind, values } = this.#binder();
    const row = await this.#one<{ next: number | string | null }>(
      `SELECT MIN(run_at) AS next FROM ${this.#tables.jobs}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
          AND state IN ('delayed', 'failed')`,
      values,
    );

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

    while (Date.now() < deadline && !signal?.aborted) {
      const { bind, values } = this.#binder();
      const row = await this.#one<{ total: number | string }>(
        `SELECT COUNT(*) AS total FROM ${this.#tables.jobs}
          WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
            AND state = 'waiting' AND run_at <= ${bind(Date.now())}`,
        values,
      );

      // Only a *claimable* job ends the wait; a paused queue has none.
      if (Number(row?.total ?? 0) > 0 && !(await this.isQueuePaused(q))) {
        return;
      }

      await sleep(Math.min(this.#poll, Math.max(1, deadline - Date.now())), {
        unref: true,
      }).catch(() => {});
    }
  }

  async publish(event: DriverEvent): Promise<void> {
    await this.connect();

    const { bind, values } = this.#binder();
    await this.#run(
      `INSERT INTO ${this.#tables.events} (ns, channel, payload, created_at)
       VALUES (${bind(event.ns)}, ${bind(`${event.kind}:${event.target}`)},
               ${bind(this.dialect.jsonIn(event))}, ${bind(event.at)})`,
      values,
    );
  }

  async subscribe(
    ns: string,
    kind: "queue" | "runner",
    target: string,
    listener: (event: DriverEvent) => void,
  ): Promise<() => Promise<void>> {
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

    let cursor = Number(latest?.seq ?? 0);
    let stopped = false;

    const timer = setInterval(() => {
      void (async () => {
        if (stopped) {
          return;
        }

        const page = this.#binder();
        const rows = await this.#all<{
          seq: number | string;
          payload: unknown;
        }>(
          `SELECT seq, payload FROM ${this.#tables.events}
            WHERE ns = ${page.bind(ns)} AND channel = ${page.bind(channel)}
              AND seq > ${page.bind(cursor)}
            ORDER BY seq ASC LIMIT 200`,
          page.values,
        );

        for (const row of rows) {
          cursor = Math.max(cursor, Number(row.seq));
          const event = this.dialect.jsonOut<DriverEvent | null>(
            row.payload,
            null,
          );
          if (event) {
            listener(event);
          }
        }
      })().catch(() => {
        // A failed poll is retried on the next tick.
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

  /* --- internals ------------------------------------------------------------ */

  /** Creates the schema and applies any connection pragmas. */
  async #migrate(): Promise<void> {
    try {
      for (const statement of this.dialect.pragmas) {
        await this.#sql.unsafe(statement);
      }

      for (const statement of createSchema(
        this.#tables.jobs.replace(/jobs$/, ""),
        this.dialect,
      )) {
        await this.#sql.unsafe(statement);
      }
    } catch (error) {
      // A failed migration must not be remembered as done.
      this.#ready = undefined;
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

  /** Runs a statement, returning how many rows it affected. */
  async #run(text: string, params: unknown[], tx?: SQL): Promise<number> {
    try {
      const result = await (tx ?? this.#sql).unsafe(text, params as never);
      const count = (result as unknown as { count?: number }).count;
      return typeof count === "number"
        ? count
        : Array.isArray(result)
          ? result.length
          : 0;
    } catch (error) {
      throw new DriverError("sql", "run", error, { text });
    }
  }

  /** Runs a query, returning its rows. */
  async #all<T>(text: string, params: unknown[], tx?: SQL): Promise<T[]> {
    try {
      const result = await (tx ?? this.#sql).unsafe(text, params as never);
      return (Array.isArray(result) ? result : []) as T[];
    } catch (error) {
      throw new DriverError("sql", "query", error, { text });
    }
  }

  /** Runs a query, returning its first row. */
  async #one<T>(text: string, params: unknown[], tx?: SQL): Promise<T | null> {
    const rows = await this.#all<T>(text, params, tx);
    return rows[0] ?? null;
  }

  /** A job record as the columns the insert binds, in `JOB_COLUMNS` order. */
  #toRow(q: QueueRef, job: JobRecord): unknown[] {
    const json = (value: unknown) => this.dialect.jsonIn(value);

    return [
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
    ];
  }

  /** A row as a job record, decoding JSON columns and numeric strings. */
  #toRecord(row: Record<string, unknown>): JobRecord {
    const number = (value: unknown): number => Number(value);
    const nullableNumber = (value: unknown): number | null =>
      value === null || value === undefined ? null : Number(value);

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
    };
  }

  /** Removes one job by id, returning how many rows went. */
  async #deleteJob(q: QueueRef, id: string): Promise<number> {
    const { bind, values } = this.#binder();
    return await this.#run(
      `DELETE FROM ${this.#tables.jobs}
        WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}`,
      values,
    );
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

    const columns = ["ns", "kv_key", "value", "updated_at"];
    const params = [ns, key, this.dialect.jsonIn(value), Date.now()];

    await this.#run(
      overwrite
        ? this.dialect.upsert(
            this.#tables.kv,
            columns,
            ["ns", "kv_key"],
            ["value", "updated_at"],
          )
        : this.dialect.insertIgnore(this.#tables.kv, columns),
      params,
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
   */
  async #mutateState(
    ns: string,
    key: string,
    mutate: (state: {
      fields: Record<string, string>;
      history: RunRecord[];
      queued: QueuedTrigger[];
    }) => void,
  ): Promise<void> {
    await this.connect();
    const kvKey = `${key}:state`;

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

      mutate(state);

      await this.#run(
        this.dialect.upsert(
          this.#tables.kv,
          ["ns", "kv_key", "value", "updated_at"],
          ["ns", "kv_key"],
          ["value", "updated_at"],
        ),
        [ns, kvKey, this.dialect.jsonIn(state), Date.now()],
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

    const scan = this.#binder();
    const stale = await this.#all<{ id: string }>(
      `SELECT id FROM ${this.#tables.jobs}
        WHERE ns = ${scan.bind(q.ns)} AND queue = ${scan.bind(q.queue)}
          AND state = ${scan.bind(state)}
        ORDER BY COALESCE(finished_on, created_at) DESC
        LIMIT 1000 OFFSET ${Math.max(0, Math.floor(count))}`,
      scan.values,
    );

    for (const row of stale) {
      await this.#deleteJob(q, row.id);
    }
  }
}
