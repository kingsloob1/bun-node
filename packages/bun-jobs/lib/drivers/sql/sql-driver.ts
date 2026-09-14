import type { SerializedError } from "@kingsleyweb/bun-common";
import type { SQL } from "bun";
import type {
  ConnectionInput,
  ConnectionOptions,
  UrlDefaults,
} from "../../shared/connection";
import type {
  ClaimOptions,
  DriverCapabilities,
  DriverEvent,
  EventKind,
  EventOfKind,
  FailOutcome,
  JobPatch,
  JobRecord,
  JobsDriver,
  JobState,
  LockInfo,
  QueuedTrigger,
  QueueRef,
  QueueStateEntry,
  RepeatRecord,
  ResolvedJobOptions,
  Retention,
  RunRecord,
} from "../driver";
import type { SchemaChange, SchemaSyncOptions } from "../schemaSync";
import type { ClaimCursor, SqlAdapter, SqlDialect } from "./dialect";
import { jsonClone, sleep } from "@kingsleyweb/bun-common";
import { SQL as BunSQL } from "bun";
import { resolveConnectionUrl, resolveNames } from "../../shared/connection";
import { ConfigError, DriverError } from "../../shared/errors";
import { EventRetention } from "../../shared/eventRetention";
import { newId } from "../../shared/ids";
import { PauseCache } from "../../shared/pauseCache";
import { claimByLoop } from "../claimBatch";
import { resolveSyncOptions } from "../schemaSync";
import { Arrivals } from "./arrivals";
import { detectAdapter, dialectFor, withLockRetry } from "./dialect";
import {
  createSchema,
  FRESH_JOB_COLUMNS,
  JOB_COLUMNS,
  jobColumnTypes,
  schemaDefinition,
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
];

/** States holding a job that is due later. */
const SCHEDULED: JobState[] = ["delayed", "failed"];

/** States whose due time `updateJob` may move. */
const PENDING: JobState[] = ["waiting", "delayed"];

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
 * Whether an error is the engine saying the `log_key` column does not exist.
 *
 * Each engine words it differently — Postgres "column … does not exist",
 * MySQL and MariaDB "Unknown column", SQLite "no such column" — and the
 * engine's error sits one or more `cause` links below the driver's wrapper,
 * so the whole chain is read.
 */
function isMissingLogKey(error: unknown): boolean {
  for (let at = error, depth = 0; at != null && depth < 5; depth++) {
    if (typeof at !== "object") {
      break;
    }

    const message = String((at as { message?: unknown }).message ?? "");

    if (
      /log_key/.test(message) &&
      /does not exist|unknown column|no such column/i.test(message)
    ) {
      return true;
    }

    at = (at as { cause?: unknown }).cause;
  }

  return false;
}

/** The tables this driver uses. */
export const SQL_TABLES = ["jobs", "locks", "kv", "events", "logs"] as const;

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

  /** The resolved table names. */
  readonly #tables: Record<SqlTable, string>;

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
   * Whether the `jobs` table was last seen without its `log_key` column — an
   * install from before job logs that has not been synced.
   *
   * Lets removal and maintenance skip log housekeeping without sending a
   * statement that is known to fail. Cleared by a sync, and by any log call
   * that succeeds, since another process may have run the sync.
   */
  #logKeyMissing = false;

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

    this.#tables = resolveNames(SQL_TABLES, {
      prefix: options.tablePrefix,
      overrides: options.tables,
      defaultPrefix: "bun_jobs_",
    });

    this.#poll = options.pollInterval ?? POLL_MS;
    this.#ownsConnection = !options.sql;

    this.#sql =
      options.sql ??
      new BunSQL({
        url: resolveConnectionUrl(
          options,
          this.#urlDefaults(),
          "The SQL driver",
        ),
      });

    this.#notify = this.dialect.supportsListen && options.notify !== false;
    this.#syncOnConnect = options.syncSchema ?? false;
    this.#eventRetention = new EventRetention(options.eventRetentionMs);
    this.#arrivals = new Arrivals(this.#sql, this.#notify);
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
    await this.#arrivals.close();

    for (const stop of this.#subscriptions) {
      stop();
    }
    this.#subscriptions.clear();

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
    return await this.#syncSchema(options);
  }

  /**
   * The sync itself, without connecting first.
   *
   * Separate from the public method because the migration calls it, and the
   * migration *is* what `connect()` awaits: connecting from in there would
   * wait on the promise it is running inside.
   */
  async #syncSchema(options: SchemaSyncOptions): Promise<SchemaChange[]> {
    // A sync may be what adds `log_key`, so log housekeeping asks again.
    this.#logKeyMissing = false;

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

    // The `NOTIFY` rides inside the insert rather than following it, so a
    // producer pays nothing for a consumer that may not exist.
    const plain = this.dialect.insertIgnore(this.#tables.jobs, [
      ...JOB_COLUMNS,
    ]);
    const insert = this.#notify
      ? this.dialect.notifyingInsert(plain, this.#arrivals.channel(q))
      : plain;
    const added = this.#notify
      ? (await this.#all<{ id: string }>(insert, this.#toRow(q, job))).length
      : await this.#run(insert, this.#toRow(q, job));

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
    // A batch of brand-new jobs names only the columns such a job carries; the
    // rest are the table's defaults, and not naming them is worth about 20%.
    // One record in an unusual shape sends the whole batch back to the full
    // list, which keeps this a choice of two statements rather than a shape
    // per batch.
    const allFresh = chunk.every((job) => this.#isFreshJob(job));
    // The module constants themselves, not copies: `columnIndices` memoises on
    // the array's identity, and a fresh copy per chunk would defeat it.
    const columns: readonly string[] = allFresh
      ? FRESH_JOB_COLUMNS
      : JOB_COLUMNS;
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
    // honest, and the worker already runs it on a 1Hz maintenance timer
    // (`BunQueueWorker.#armMaintenance`). A caller driving the driver directly
    // with `maintenance: false` promotes explicitly, which is what the
    // contract suite does.

    if (!opts.excludeNames || opts.excludeNames.length === 0) {
      return await this.#claimOne(q, opts, null);
    }

    const [job] = await this.#claimPastExclusions(q, opts, 1, async (after) => {
      const claimed = await this.#claimOne(q, opts, after);
      return claimed ? [claimed] : [];
    });

    return job ?? null;
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

    if (!opts.excludeNames || opts.excludeNames.length === 0) {
      return await this.#claimMany(q, opts, limit, null);
    }

    return await this.#claimPastExclusions(
      q,
      opts,
      limit,
      async (after, wanted) => await this.#claimMany(q, opts, wanted, after),
    );
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
    const { bind, values } = this.#binder();
    const statement = this.dialect.claim({
      table: this.#tables.jobs,
      bind,
      ns: q.ns,
      queue: q.queue,
      now: opts.now,
      token: opts.token,
      workerId: opts.workerId,
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

    // `removeOnComplete: true` is the common configuration for a queue that
    // does not read results back, and it used to cost two round trips: an
    // UPDATE that wrote the result and the finished state, then a DELETE of
    // the row it had just written. One conditional DELETE does the same job,
    // keeps the same holder check, and skips serialising a result nothing will
    // ever read.
    if (retention === true) {
      const { bind, values } = this.#binder();
      const removed = await this.#run(
        `DELETE FROM ${this.#tables.jobs}
          WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)} AND id = ${bind(id)}
            AND state = 'active' AND lock_token = ${bind(token)}`,
        values,
      );

      return removed > 0;
    }

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
      const rows = await this.#all<{ id: string }>(
        `DELETE FROM ${this.#tables.jobs}
          WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
            AND state = 'active' AND lock_token = ${bind(token)}
            AND id IN (${ids.map((id) => bind(id)).join(", ")})
        RETURNING id`,
        values,
      );
      settled.push(...rows.map((row) => String(row.id)));
    }

    // Anything with a count-based retention still needs the per-state sweep the
    // singular path does, so it takes that path rather than being half-batched.
    const batchable = keeping.filter(
      (one) => one.retention === false || this.#ttlOf(one.retention) !== null,
    );
    const individual = keeping.filter((one) => !batchable.includes(one));

    if (batchable.length > 0) {
      const { bind, values } = this.#binder();
      const document = JSON.stringify(
        batchable.map((one) => ({
          id: one.id,
          return_value: one.result ?? null,
          expires_at:
            this.#ttlOf(one.retention) === null
              ? null
              : now + this.#ttlOf(one.retention)!,
        })),
      );

      const rows = await this.#all<{ id: string }>(
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
        values,
      );
      settled.push(...rows.map((row) => String(row.id)));
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
      // the copy in `opts` is kept in step so the two never disagree.
      if (patch.priority !== undefined) {
        set.push(`priority = ${bind(patch.priority)}`);
        set.push(
          `opts = ${this.dialect.jsonSetInteger("opts", "priority", bind(patch.priority))}`,
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
        await this.#run(
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

    // Its log first, while the job's key can still be read — on the same
    // condition as the removal, so an active job keeps its log. A line written
    // between the two statements is left for the sweep.
    await this.#forgetLogs(q, [id], true);

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

    const scan = this.#binder();
    const rows = await this.#all<{ id: string }>(
      `SELECT id FROM ${this.#tables.jobs}
        WHERE ns = ${scan.bind(q.ns)} AND queue = ${scan.bind(q.queue)}
          AND expires_at IS NOT NULL AND expires_at <= ${scan.bind(now)}
        LIMIT ${Math.max(1, Math.floor(limit))}`,
      scan.values,
    );

    // Before the jobs go, while their keys can still be read.
    await this.#forgetLogs(
      q,
      rows.map((row) => row.id),
    );

    let removed = 0;
    for (const row of rows) {
      removed += await this.#deleteJob(q, row.id);
    }

    // The maintenance tick is where lines orphaned by the paths that cannot
    // afford to delete them — completion and failure with retention — go.
    await this.#sweepOrphanLogs(q, now, limit);

    return removed;
  }

  async drainQueue(q: QueueRef, includeDelayed: boolean): Promise<number> {
    await this.connect();

    const states = includeDelayed ? ["waiting", ...SCHEDULED] : ["waiting"];

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
  ): Promise<number | null> {
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

    // Where the engine can push, a notification ends the wait the moment a job
    // lands rather than at the next poll. Polling still runs alongside it as
    // the correctness floor: a notification can be missed while a listener
    // reconnects, and a job promoted by another process's maintenance sweep is
    // never announced at all.
    if (this.#notify) {
      await Promise.race([
        this.#arrivals.wait(q, timeoutMs, signal),
        this.#pollForJob(q, deadline, signal),
      ]);
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
      const { bind, values } = this.#binder();
      const row = await this.#one<{ total: number | string }>(
        `SELECT COUNT(*) AS total FROM ${this.#tables.jobs}
          WHERE ns = ${bind(q.ns)} AND queue = ${bind(q.queue)}
            AND state = 'waiting' AND run_at <= ${bind(Date.now())}`,
        values,
      );

      // Only a *claimable* job ends the wait; a paused queue has none.
      if (
        Number(row?.total ?? 0) > 0 &&
        !(await this.#pauseCache.read(q, () => this.isQueuePaused(q)))
      ) {
        return true;
      }

      await sleep(Math.min(wait, Math.max(1, deadline - Date.now())), {
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
    await this.#run(
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
            deliver(event);
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
        // Best-effort: `journal_mode` wants a moment's exclusive access, and
        // another process may already have set what this one is asking for.
        await withLockRetry(async () => {
          await this.#sql.unsafe(statement);
        }).catch(() => {});
      }

      // Two processes starting together both create the schema, and one is
      // told the database is busy. Every statement is `IF NOT EXISTS`, so
      // waiting and repeating is exactly the right answer.
      for (const statement of createSchema(this.#tables, this.dialect)) {
        await withLockRetry(async () => {
          await this.#sql.unsafe(statement);
        });
      }

      // After the tables exist, not instead of creating them: a sync compares
      // against what is there and has nothing to say about what is not.
      if (this.#syncOnConnect !== false) {
        await this.#syncSchema(
          typeof this.#syncOnConnect === "object" ? this.#syncOnConnect : {},
        );
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

  /**
   * Runs a statement, returning how many rows it affected.
   *
   * The count is what every conditional write here is judged by — "did this
   * update find the row in the state I required?" — so getting it wrong makes
   * every such write silently report failure. MySQL and MariaDB report
   * nothing through this client and must be asked with `ROW_COUNT()`, which
   * only answers about its own connection: those writes therefore run inside
   * a transaction, unless they are already in one.
   */
  async #run(text: string, params: unknown[], tx?: SQL): Promise<number> {
    if (this.dialect.countsNeedSameConnection && !tx) {
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

  /** A job record as the columns the insert binds, in `JOB_COLUMNS` order. */
  #toRow(
    q: QueueRef,
    job: JobRecord,
    columns: readonly string[] = JOB_COLUMNS,
  ): unknown[] {
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
   * Unlike {@link SqlDriver.#toRow} the JSON columns keep their real values
   * rather than being stringified: they are about to be embedded in a document
   * that is itself serialised once, so pre-encoding them would double-encode.
   */
  #toDocument(
    q: QueueRef,
    job: JobRecord,
    columns: readonly string[] = JOB_COLUMNS,
  ): Record<string, unknown> {
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
      job.data ?? null,
      job.opts ?? null,
      job.progress ?? null,
      job.returnValue ?? null,
      job.failedReason ?? null,
      job.stacktrace ?? null,
      job.lockToken,
      job.lockExpiresAt,
      job.workerId,
      job.repeatKey,
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
      : await this.#run(statement, values);
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
    return `q:${q.queue}:state:${name}`;
  }

  /**
   * Runs a conditional write and answers whether it matched a row.
   *
   * Judged by the most reliable count each engine offers. Where there is
   * `RETURNING`, a returned row is the proof: Bun's SQLite client does not
   * report an affected-row count that can be trusted. MySQL and MariaDB go
   * through {@link SqlDriver.#run}'s same-connection `ROW_COUNT()`, which
   * counts *changed* rows rather than matched ones — safe for every caller
   * here, because each write either removes the row or bumps the version it
   * holds, and so never leaves a matched row unchanged.
   */
  async #conditionalWrite(text: string, params: unknown[]): Promise<boolean> {
    if (this.dialect.supportsReturning) {
      const rows = await this.#all(`${text} RETURNING kv_key`, params);
      return rows.length > 0;
    }

    return (await this.#run(text, params)) > 0;
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
    const encoded = this.dialect.jsonIn(value);

    // Insert-if-absent first, then update. A bare upsert is enough on
    // Postgres and SQLite, but concurrent `ON DUPLICATE KEY UPDATE` on one
    // key deadlocks in InnoDB; this shape does not.
    await this.#run(this.dialect.insertIgnore(this.#tables.kv, columns), [
      ns,
      key,
      encoded,
      Date.now(),
    ]);

    if (!overwrite) {
      return;
    }

    const { bind, values } = this.#binder();
    await this.#run(
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

    // Create the row first, outside the transaction.
    //
    // `SELECT ... FOR UPDATE` on a row that does not exist takes a *gap* lock
    // in InnoDB, so two processes arriving together both hold one and both
    // then try to insert, which deadlocks. With the row already present the
    // lock is an ordinary record lock and the transaction only ever updates.
    await this.#run(
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

      mutate(state);

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
