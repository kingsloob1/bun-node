import type { SQL } from "bun";
import { Mutex } from "@kingsleyweb/bun-common";
import { ConfigError } from "../../shared/errors";

/**
 * What differs between the SQL engines.
 *
 * The driver above is written once; everything an engine does its own way —
 * placeholders, JSON columns, how a row is claimed without two workers taking
 * it — is answered here. Keeping the list explicit is what makes it possible
 * to say honestly which engines are supported and how.
 */

/** The engines the SQL driver can talk to. */
export type SqlAdapter = "postgres" | "mysql" | "mariadb" | "sqlite";

/** One engine's answers. */
export interface SqlDialect {
  /** Which engine this is. */
  readonly name: SqlAdapter;
  /** Renders the 1-based parameter placeholder for a statement. */
  placeholder: (index: number) => string;
  /** Column type for a JSON document. */
  readonly jsonType: string;
  /** Column type for an identifier: bounded on MySQL, whose indexes are. */
  readonly idType: string;
  /** Column type for an epoch-millisecond timestamp. */
  readonly timeType: string;
  /** Column type for an auto-incrementing primary key. */
  readonly serialType: string;
  /** Whether `UPDATE … RETURNING` is available. MariaDB's is not. */
  readonly supportsReturning: boolean;
  /** Whether `FOR UPDATE SKIP LOCKED` is available. */
  readonly supportsSkipLocked: boolean;
  /** An insert that silently does nothing when the row exists. */
  insertIgnore: (table: string, columns: string[]) => string;
  /**
   * An insert that reads its rows out of one JSON document.
   *
   * Optional, because only Postgres has the function for it. Where it exists it
   * replaces a multi-row `VALUES`, and the difference is the parameter count:
   * 500 jobs of 24 columns is 12,000 bind parameters as `VALUES` and exactly
   * one this way. Measured, 20,166/s against 29,525/s for the same rows.
   *
   * `columnTypes` describes the record the document is expanded into, one type
   * per column, in {@link JOB_COLUMNS} order.
   */
  insertIgnoreFromJson?: (
    table: string,
    columns: readonly string[],
    columnTypes: readonly string[],
  ) => string;
  /**
   * The same insert for several rows at once.
   *
   * One statement per batch instead of one per job: adding 5,000 jobs was
   * 5,000 serially awaited inserts, which is the whole of the gap against
   * libraries that write a batch in one go. Parameters are flattened row by
   * row, so the caller passes `rows * columns` values in that order.
   */
  insertIgnoreMany: (
    table: string,
    columns: readonly string[],
    rows: number,
  ) => string;
  /** An upsert that overwrites the named columns when the row exists. */
  upsert: (
    table: string,
    columns: string[],
    conflict: string[],
    update: string[],
  ) => string;
  /**
   * Wraps a subquery selecting ids so it can be used in `IN (…)`. MySQL
   * cannot read the table it is updating without a derived table in between.
   */
  limitedIdSubquery: (select: string) => string;
  /**
   * Builds the statement that claims one job.
   *
   * This is the one query the engines genuinely disagree about, so each
   * writes its own rather than sharing a shape that only looks portable. The
   * requirement is the same everywhere: pick at most one due row, take it,
   * and let a concurrent claimer take a different one.
   */
  claim: (options: ClaimStatementOptions) => string;
  /**
   * The rows a claim may take, as a statement of its own.
   *
   * Needed by engines that cannot return the row they updated: they pick the
   * id first, then update exactly that row. See {@link claimById}.
   */
  claimCandidate: (options: ClaimStatementOptions) => string;
  /** Takes one specific job, for the same engines. */
  claimById: (options: ClaimStatementOptions, id: string) => string;
  /**
   * How many rows a write affected.
   *
   * Not every engine reports it the same way: Postgres and SQLite put it on
   * the result, while MySQL and MariaDB report nothing and have to be asked
   * with `ROW_COUNT()` on the connection the write ran on.
   */
  affectedRows: (result: unknown, connection: SQL) => Promise<number>;
  /**
   * Whether the claim statement needs a transaction wrapped around it.
   *
   * Postgres does not: its data-modifying CTE is atomic on its own, and the
   * wrapper measured 0.31ms of a 1.16ms claim — 27% for nothing. SQLite does,
   * because `BEGIN IMMEDIATE` *is* its exclusivity, and MySQL and MariaDB do,
   * because their claim is more than one statement.
   */
  readonly claimNeedsTransaction: boolean;
  /**
   * Whether the engine can push a notification to a waiting connection.
   *
   * Only Postgres, through `LISTEN`/`NOTIFY`. Everywhere else a worker polls to
   * notice a new job, which is why the poll interval sets the tail of the
   * round-trip latency on those engines and not on this one.
   */
  readonly supportsListen: boolean;
  /**
   * Wraps an insert so it also signals `channel` for the rows it writes.
   *
   * The signal rides along with the write rather than following it. A separate
   * `NOTIFY` is a second round trip charged to every `add()` in order to save
   * latency for a consumer that may not even exist; inside the statement it is
   * free. Postgres collapses repeated notifications carrying the same payload
   * within one transaction, so a 500-row insert still delivers exactly one.
   *
   * Returns the statement unchanged on an engine that cannot do it.
   */
  notifyingInsert: (statement: string, channel: string) => string;
  /**
   * Whether a write needs its own connection so {@link affectedRows} can ask
   * the server what it just did.
   */
  readonly countsNeedSameConnection: boolean;
  /** Runs `fn` inside a transaction. */
  transaction: <T>(sql: SQL, fn: (tx: SQL) => Promise<T>) => Promise<T>;
  /**
   * Refreshes the planner's statistics for a table, or `null` where the engine
   * has no such notion.
   *
   * A queue table is the worst case for a cost-based planner: it goes from
   * empty to thousands of rows in a burst and back again, and autovacuum's
   * defaults are written for tables that change slowly. Measured on Postgres,
   * the claim statement took 25.9ms with stale statistics and 0.668ms with
   * fresh ones — the *same plan* either way, so it is not a plan choice going
   * wrong, and no amount of index work fixes it.
   */
  analyze: (table: string) => string | null;
  /**
   * A query yielding the table's estimated row count as `n`, or `null` where
   * the engine cannot estimate one cheaply.
   *
   * Sizes how often {@link SqlDialect.analyze} is worth running. `ANALYZE` is
   * linear in table size — measured on Postgres, 11.3ms at 5,000 rows and
   * 77.8ms at 50,000 — so a fixed row threshold re-analyses a large table far
   * too often. An *estimate* is the point: this has to be cheap enough to be
   * free, so it reads what the engine already knows rather than counting.
   */
  estimatedRows: (table: string) => string | null;
  /** Parses a JSON column, which some engines return already decoded. */
  jsonOut: <T>(value: unknown, fallback: T) => T;
  /** Encodes a value for a JSON column. */
  jsonIn: (value: unknown) => string;
  /** Statements run once when the connection opens. */
  readonly pragmas: string[];
}

/** What a dialect needs in order to write its claim statement. */
export interface ClaimStatementOptions {
  /** The jobs table. */
  table: string;
  /**
   * Appends a value to the statement's parameters and returns its
   * placeholder. Called in the order the values appear in the statement.
   */
  bind: (value: unknown) => string;
  /** The namespace to claim from. */
  ns: string;
  /** The queue to claim from. */
  queue: string;
  /** The caller's clock. */
  now: number;
  /** The token to stamp on the claimed job. */
  token: string;
  /** The worker doing the claiming. */
  workerId: string;
  /** How long the claim's lock lives. */
  lockMs: number;
  /**
   * How many jobs the statement may take. Defaults to one.
   *
   * A literal, not a bound parameter: it comes from the worker's free slots,
   * never from user input, and every engine here will only plan a `LIMIT` it
   * can see. It is floored at one and rounded down.
   */
  limit?: number;
}

/** `(?, ?, …)` repeated once per row, for the `?`-placeholder engines. */
function anonymousRows(columns: readonly string[], rows: number): string {
  const one = `(${columns.map(() => "?").join(", ")})`;
  return Array.from({ length: rows }).fill(one).join(", ");
}

/** The columns a claim sets, shared by the dialects that write it. */
function claimAssignments(options: ClaimStatementOptions, prefix = ""): string {
  const { bind } = options;

  return [
    `${prefix}state = 'active'`,
    `${prefix}attempts_made = ${prefix}attempts_made + 1`,
    `${prefix}processed_on = ${bind(options.now)}`,
    `${prefix}lock_token = ${bind(options.token)}`,
    `${prefix}lock_expires_at = ${bind(options.now + options.lockMs)}`,
    `${prefix}worker_id = ${bind(options.workerId)}`,
  ].join(", ");
}

/** The rows a claim may take, ordered so the cheapest comes first. */
function claimCandidates(
  options: ClaimStatementOptions,
  locking: string,
): string {
  const { bind } = options;

  const limit = Math.max(1, Math.floor(options.limit ?? 1));

  return `SELECT id FROM ${options.table}
       WHERE ns = ${bind(options.ns)} AND queue = ${bind(options.queue)}
         AND state = 'waiting' AND run_at <= ${bind(options.now)}
       ORDER BY priority ASC, created_at ASC, id ASC
       LIMIT ${limit}${locking}`;
}

/** Picks the id of the row a claim would take. */
function claimCandidateStatement(
  options: ClaimStatementOptions,
  locking: string,
): string {
  return claimCandidates(options, locking);
}

/** Takes one specific job, conditional on it still being claimable. */
function claimByIdStatement(
  options: ClaimStatementOptions,
  id: string,
): string {
  const { bind, table } = options;

  return `UPDATE ${table} SET ${claimAssignments(options)}
     WHERE ns = ${bind(options.ns)} AND queue = ${bind(options.queue)}
       AND id = ${bind(id)} AND state = 'waiting'`;
}

/** Reads an affected-row count off a result, for engines that report one. */
async function countFromResult(result: unknown): Promise<number> {
  const count = (result as { count?: number } | null)?.count;
  return typeof count === "number" ? count : 0;
}

/** How many times a transient lock failure is retried before giving up. */
const LOCK_RETRIES = 12;

/**
 * Whether an error is the database saying "someone else had it, try again".
 *
 * Both engines have one, and both mean the same thing: the statement was
 * fine, the timing was not. InnoDB breaks a lock cycle by aborting one
 * transaction and telling the loser to retry, and SQLite reports
 * `SQLITE_BUSY` when another connection holds the file's single write lock
 * for longer than the busy timeout allows. Neither is a defect in the query.
 */
export function isTransientLockError(error: unknown): boolean {
  const message = (error as Error | null)?.message ?? "";
  const code = (error as { code?: string } | null)?.code ?? "";

  return (
    code === "SQLITE_BUSY" ||
    /deadlock|try restarting transaction|lock wait timeout|database (?:is|table is) locked/i.test(
      message,
    )
  );
}

/**
 * Retries `work` while the database keeps saying it was busy.
 *
 * Everything reached from here is idempotent or conditional, so repeating it
 * is safe; the backoff is jittered so two losers do not collide again.
 */
export async function withLockRetry<T>(work: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= LOCK_RETRIES; attempt++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;

      if (!isTransientLockError(error)) {
        throw error;
      }

      await Bun.sleep(Math.random() * 15 * attempt);
    }
  }

  throw lastError;
}

/** Serialises SQLite writers inside one process; the file lock does the rest. */
const sqliteWriteLock = new Mutex();

/** Parses a JSON column that may arrive as text or already decoded. */
function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  return value as T;
}

/** Shared behaviour, overridden per engine below. */
const base = {
  jsonOut: parseJson,
  jsonIn: (value: unknown) => JSON.stringify(value ?? null),
  limitedIdSubquery: (select: string) => select,
  pragmas: [] as string[],
} satisfies Partial<SqlDialect>;

/** Postgres: `$n` placeholders, JSONB, and `SKIP LOCKED` for claiming. */
const postgres: SqlDialect = {
  ...base,
  name: "postgres",
  placeholder: (index) => `$${index}`,
  jsonType: "JSONB",
  idType: "TEXT",
  timeType: "BIGINT",
  serialType: "BIGSERIAL PRIMARY KEY",
  supportsReturning: true,
  supportsSkipLocked: true,
  insertIgnore: (table, columns) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
      .map((_column, index) => `$${index + 1}`)
      .join(", ")}) ON CONFLICT DO NOTHING`,
  insertIgnoreMany: (table, columns, rows) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${Array.from(
      { length: rows },
      (_row, rowIndex) =>
        `(${columns
          .map((_column, index) => `$${rowIndex * columns.length + index + 1}`)
          .join(", ")})`,
    ).join(", ")} ON CONFLICT DO NOTHING`,
  insertIgnoreFromJson: (table, columns, columnTypes) =>
    // `$1::text::json`, not `$1::json`: the client sends the document as an
    // untyped string, and without the intermediate cast Postgres reads it as a
    // JSON *string* rather than the array it contains.
    `INSERT INTO ${table} (${columns.join(", ")})
     SELECT ${columns.join(", ")}
       FROM json_to_recordset($1::text::json) AS document (${columns
         .map((column, index) => `${column} ${columnTypes[index]}`)
         .join(", ")})
     ON CONFLICT DO NOTHING`,
  upsert: (table, columns, conflict, update) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
      .map((_column, index) => `$${index + 1}`)
      .join(", ")}) ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ${update
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(", ")}`,
  transaction: async (sql, fn) => (await sql.begin(fn as never)) as never,
  /**
   * A CTE, not `IN (SELECT ... LIMIT 1 FOR UPDATE SKIP LOCKED)`.
   *
   * That subquery form looks right and is not: Postgres may re-evaluate the
   * sub-plan, and because `SKIP LOCKED` yields a *different* row each time it
   * is evaluated, the `LIMIT 1` fails to bound the update. Measured, it
   * claimed two jobs and returned one, silently leaving the other `active`
   * with a token nobody held. A data-modifying statement's CTE is evaluated
   * exactly once, so the bound holds.
   */
  claim: (options) => {
    const { bind, table } = options;

    // Built inline, in statement order: `bind` numbers parameters as it is
    // called, so a fragment computed early would be numbered early too.
    return `WITH picked AS (${claimCandidates(options, " FOR UPDATE SKIP LOCKED")})
      UPDATE ${table} SET ${claimAssignments(options)}
        FROM picked
       WHERE ${table}.ns = ${bind(options.ns)}
         AND ${table}.queue = ${bind(options.queue)}
         AND ${table}.id = picked.id
         AND ${table}.state = 'waiting'
      RETURNING ${table}.*`;
  },
  claimCandidate: (options) =>
    claimCandidateStatement(options, " FOR UPDATE SKIP LOCKED"),
  claimById: claimByIdStatement,
  affectedRows: countFromResult,
  claimNeedsTransaction: false,
  analyze: (table) => `ANALYZE ${table}`,
  // `reltuples` is maintained by `ANALYZE` itself, so this is a catalog
  // lookup rather than a scan. It reads -1 on a table that has never been
  // analysed, which the caller treats as having no estimate yet.
  estimatedRows: (table) =>
    `SELECT reltuples::bigint AS n FROM pg_class WHERE oid = '${table}'::regclass`,
  supportsListen: true,
  notifyingInsert: (statement, channel) =>
    `WITH written AS (${statement} RETURNING id)
     SELECT id, pg_notify('${channel}', '') FROM written`,
  countsNeedSameConnection: false,
};

/** MySQL: `?` placeholders, `INSERT IGNORE`, and a derived table for updates. */
const mysql: SqlDialect = {
  ...base,
  name: "mysql",
  placeholder: () => "?",
  jsonType: "JSON",
  // utf8mb4 indexes cap a key at 191 characters, so ids are bounded.
  idType: "VARCHAR(191)",
  timeType: "BIGINT",
  serialType: "BIGINT AUTO_INCREMENT PRIMARY KEY",
  supportsReturning: false,
  supportsSkipLocked: true,
  insertIgnore: (table, columns) =>
    `INSERT IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns
      .map(() => "?")
      .join(", ")})`,
  insertIgnoreMany: (table, columns, rows) =>
    `INSERT IGNORE INTO ${table} (${columns.join(", ")}) VALUES ${anonymousRows(
      columns,
      rows,
    )}`,
  upsert: (table, columns, _conflict, update) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
      .map(() => "?")
      .join(", ")}) ON DUPLICATE KEY UPDATE ${update
      .map((column) => `${column} = VALUES(${column})`)
      .join(", ")}`,
  // "You can't specify target table for update in FROM clause" without this.
  limitedIdSubquery: (select) => `SELECT id FROM (${select}) AS picked`,
  transaction: async (sql, fn) =>
    await withLockRetry(async () => (await sql.begin(fn as never)) as never),
  /**
   * A join against a derived table. MySQL materialises it, so the `LIMIT 1`
   * bounds the update, and it also sidesteps the refusal to read the table
   * being updated from a `WHERE` subquery.
   */
  claim: (options) => {
    const { bind, table } = options;

    // Built inline, in statement order, for the same reason as the others.
    return `UPDATE ${table}
        JOIN (${claimCandidates(options, " FOR UPDATE SKIP LOCKED")}) AS picked
          ON ${table}.id = picked.id
         SET ${claimAssignments(options, `${table}.`)}
       WHERE ${table}.ns = ${bind(options.ns)}
         AND ${table}.queue = ${bind(options.queue)}
         AND ${table}.state = 'waiting'`;
  },
  /**
   * MySQL and MariaDB report nothing about a write through this client, so
   * the count has to be asked for, and `ROW_COUNT()` answers only about the
   * connection it runs on: that is why these writes take a transaction.
   */
  claimCandidate: (options) =>
    claimCandidateStatement(options, " FOR UPDATE SKIP LOCKED"),
  claimById: claimByIdStatement,
  affectedRows: async (_result, connection) => {
    const rows = (await connection.unsafe("SELECT ROW_COUNT() AS n")) as {
      n: number | string;
    }[];
    return Math.max(0, Number(rows[0]?.n ?? 0));
  },
  claimNeedsTransaction: true,
  analyze: (table) => `ANALYZE TABLE ${table}`,
  estimatedRows: () => null,
  supportsListen: false,
  notifyingInsert: (statement) => statement,
  countsNeedSameConnection: true,
};

/** MariaDB: MySQL, minus `UPDATE … RETURNING`. */
const mariadb: SqlDialect = {
  ...mysql,
  name: "mariadb",
  supportsReturning: false,
};

/**
 * SQLite: one writer at a time.
 *
 * There is no `SKIP LOCKED` because there is no row locking to skip — the
 * whole database takes one write lock. `BEGIN IMMEDIATE` takes it up front,
 * a process-local mutex keeps this process from queueing against itself, and
 * WAL plus a busy timeout handles other processes.
 */
const sqlite: SqlDialect = {
  ...base,
  name: "sqlite",
  placeholder: () => "?",
  jsonType: "TEXT",
  idType: "TEXT",
  timeType: "INTEGER",
  serialType: "INTEGER PRIMARY KEY AUTOINCREMENT",
  supportsReturning: true,
  supportsSkipLocked: false,
  insertIgnore: (table, columns) =>
    `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns
      .map(() => "?")
      .join(", ")})`,
  insertIgnoreMany: (table, columns, rows) =>
    `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES ${anonymousRows(
      columns,
      rows,
    )}`,
  upsert: (table, columns, conflict, update) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
      .map(() => "?")
      .join(", ")}) ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ${update
      .map((column) => `${column} = excluded.${column}`)
      .join(", ")}`,
  /**
   * A scalar subquery under the database's write lock. There is no
   * `SKIP LOCKED` because there is nothing to skip: `BEGIN IMMEDIATE` makes
   * this connection the only writer, so the row it picks is its own.
   */
  claim: (options) => {
    const { bind, table } = options;

    // Every fragment is built inline, at the position it occupies in the
    // statement: `bind` numbers parameters in call order, so anything
    // computed ahead of time would be numbered ahead of where it appears.
    return `UPDATE ${table} SET ${claimAssignments(options)}
       WHERE ns = ${bind(options.ns)} AND queue = ${bind(options.queue)}
         AND state = 'waiting'
         AND id = (${claimCandidates(options, "")})
      RETURNING *`;
  },
  claimCandidate: (options) => claimCandidateStatement(options, ""),
  claimById: claimByIdStatement,
  affectedRows: countFromResult,
  claimNeedsTransaction: true,
  analyze: (table) => `ANALYZE ${table}`,
  estimatedRows: () => null,
  supportsListen: false,
  notifyingInsert: (statement) => statement,
  countsNeedSameConnection: false,
  transaction: async (sql, fn) =>
    // The mutex serialises writers inside this process; the retry handles the
    // ones in other processes, which contend for the file's single write lock.
    await sqliteWriteLock.runExclusive(async () =>
      withLockRetry(async () => {
        await sql.unsafe("BEGIN IMMEDIATE");
        try {
          const result = await fn(sql);
          await sql.unsafe("COMMIT");
          return result;
        } catch (error) {
          await sql.unsafe("ROLLBACK").catch(() => {});
          throw error;
        }
      }),
    ),
  pragmas: [
    // WAL lets a reader work while a writer holds the lock.
    "PRAGMA journal_mode=WAL",
    // Deliberately small, and smaller is better here. SQLite's busy handler
    // sleeps in the calling thread, so a connection waiting on a lock blocks
    // the very event loop that has to run the holder's COMMIT. Two connections
    // in one process therefore deadlock for the whole timeout: measured, a
    // 5000ms timeout turned a 300ms wait into a 3015ms one, where 50ms plus
    // the retry below finished in 349ms. The waiting is done in JavaScript by
    // `withLockRetry`, which yields between attempts; this value only covers
    // the microseconds a genuinely concurrent writer needs.
    "PRAGMA busy_timeout=50",
    "PRAGMA synchronous=NORMAL",
  ],
};

/** Every dialect, by name. */
const DIALECTS: Record<SqlAdapter, SqlDialect> = {
  postgres,
  mysql,
  mariadb,
  sqlite,
};

/** The dialect for an adapter name. */
export function dialectFor(adapter: SqlAdapter): SqlDialect {
  const dialect = DIALECTS[adapter];
  if (!dialect) {
    throw new ConfigError(`Unsupported SQL adapter "${adapter}"`, { adapter });
  }
  return dialect;
}

/**
 * Works out which engine a URL points at, so a caller need not repeat what
 * the connection string already says.
 */
export function detectAdapter(url: string | undefined): SqlAdapter {
  if (!url) {
    throw new ConfigError(
      "A SQL driver needs a url, or an explicit adapter with connection options",
    );
  }

  const scheme = url.slice(0, url.indexOf(":")).toLowerCase();

  switch (scheme) {
    case "postgres":
    case "postgresql":
      return "postgres";
    case "mysql":
      return "mysql";
    case "mariadb":
      return "mariadb";
    case "sqlite":
    case "file":
      return "sqlite";
    default:
      // A bare path or ":memory:" is SQLite; anything else is unrecognised.
      if (url === ":memory:" || url.startsWith("/") || url.startsWith("./")) {
        return "sqlite";
      }
      throw new ConfigError(`Cannot tell which SQL engine "${url}" is`, {
        url,
      });
  }
}
