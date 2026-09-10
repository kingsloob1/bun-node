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
  /** Runs `fn` inside a transaction. */
  transaction: <T>(sql: SQL, fn: (tx: SQL) => Promise<T>) => Promise<T>;
  /** Parses a JSON column, which some engines return already decoded. */
  jsonOut: <T>(value: unknown, fallback: T) => T;
  /** Encodes a value for a JSON column. */
  jsonIn: (value: unknown) => string;
  /** Statements run once when the connection opens. */
  readonly pragmas: string[];
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
  upsert: (table, columns, conflict, update) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
      .map((_column, index) => `$${index + 1}`)
      .join(", ")}) ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ${update
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(", ")}`,
  transaction: async (sql, fn) => (await sql.begin(fn as never)) as never,
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
  upsert: (table, columns, _conflict, update) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
      .map(() => "?")
      .join(", ")}) ON DUPLICATE KEY UPDATE ${update
      .map((column) => `${column} = VALUES(${column})`)
      .join(", ")}`,
  // "You can't specify target table for update in FROM clause" without this.
  limitedIdSubquery: (select) => `SELECT id FROM (${select}) AS picked`,
  transaction: async (sql, fn) => (await sql.begin(fn as never)) as never,
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
  upsert: (table, columns, conflict, update) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
      .map(() => "?")
      .join(", ")}) ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ${update
      .map((column) => `${column} = excluded.${column}`)
      .join(", ")}`,
  transaction: async (sql, fn) =>
    await sqliteWriteLock.runExclusive(async () => {
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
  pragmas: [
    // WAL lets a reader work while a writer holds the lock, and the timeout
    // is what makes a second process wait rather than fail outright.
    "PRAGMA journal_mode=WAL",
    "PRAGMA busy_timeout=5000",
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
