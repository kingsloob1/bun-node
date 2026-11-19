/**
 * bun-cache's SQL tables as bun-sql definitions, and its schema sync on
 * bun-sql's (`@kingsleyweb/bun-sql/sync`, PR-D0c).
 *
 * The drivers still create their tables with their own hand-written DDL
 * (`ddl()` in `postgres.ts` and `mysql.ts`, `schema` in `sqlite.ts` and
 * `cloudflare-d1.ts`), byte for byte as before. What this module adds is the
 * same tables described as data, which bun-sql's `syncSqlSchema` compares
 * against what the database has: a missing column or one of the driver's
 * `ix_…` indexes is reported, and repaired unless `dryRun`; an index the
 * driver no longer defines is dropped (only an `ix_…` name, so an index added
 * by hand is never touched); a column of another type is reported and never
 * rewritten (`alterColumns` stays off). A schema the driver created answers
 * `[]`. The definitions are proved to match the DDL on every engine by
 * `__tests__/drivers/sql-schema.test.ts`: a freshly created schema reports no
 * change.
 *
 * Each of bun-sql's changes is reported in bun-cache's public shape,
 * `SchemaChange { description, applied, blocking }` (plan §17.16, decision
 * 2): see {@link describeChange}.
 */
import type {
  SchemaChange as SharedSchemaChange,
  SyncBackend,
} from "@kingsleyweb/bun-sql/sync";
import type {
  ColumnDefinition,
  IndexDefinition,
  SchemaDefinition,
  TableDefinition,
} from "@kingsleyweb/bun-sql/schema";
import type { SchemaChange, SchemaSyncOptions } from "../core/types";
import type { SqlCacheTable } from "./sql-tables";
import { dialectFor } from "@kingsleyweb/bun-sql/dialect";
import { resolveSyncOptions, syncSqlSchema } from "@kingsleyweb/bun-sql/sync";
import { CACHE_SQL } from "./sql-seam";
import { sqlCacheIndexName } from "./sql-tables";

/** The engines bun-cache syncs: its three server drivers and SQLite (`bun:sqlite` and Cloudflare D1). */
export type SqlCacheSchemaEngine = "postgres" | "mysql" | "mariadb" | "sqlite";

/** Each MySQL-family engine's exact (binary, `NO PAD`) collation, as `mysql.ts` declares it. */
const COLLATION = {
  mysql: "utf8mb4_0900_bin",
  mariadb: "utf8mb4_nopad_bin",
} as const;

/** Each engine's column types, as its DDL spells them. */
interface ColumnTypes {
  /** A name column: namespace, key, tag, lock owner. */
  readonly name: string;
  /** The entry's bytes. */
  readonly bytes: string;
  /** A 64-bit integer: counters, times. */
  readonly integer: string;
  /** Text without a bound: the entry's tags, a bus message. */
  readonly text: string;
  /** Whether the engine has partial indexes (the `exp IS NOT NULL` one). */
  readonly partial: boolean;
}

/** The column types per engine. */
function columnTypes(engine: SqlCacheSchemaEngine): ColumnTypes {
  switch (engine) {
    case "postgres":
      return {
        name: "TEXT",
        bytes: "BYTEA",
        integer: "BIGINT",
        text: "TEXT",
        partial: true,
      };
    case "mysql":
    case "mariadb":
      return {
        name: `VARCHAR(255) CHARACTER SET utf8mb4 COLLATE ${COLLATION[engine]}`,
        bytes: "LONGBLOB",
        integer: "BIGINT",
        text: "LONGTEXT",
        partial: false,
      };
    case "sqlite":
      return {
        name: "TEXT",
        bytes: "BLOB",
        integer: "INTEGER",
        text: "TEXT",
        partial: true,
      };
  }
}

/** One column. */
function column(name: string, type: string, suffix?: string): ColumnDefinition {
  return suffix === undefined ? { name, type } : { name, type, suffix };
}

/**
 * The tables the driver for `engine` creates, and their `ix_…` indexes, as
 * bun-sql definitions: column for column what its DDL creates. `tables` are
 * the resolved names (`resolveSqlCacheTables`); a table the engine does not
 * have (Postgres's `bus`, and D1's, which `withBus: false` leaves out) is
 * left out.
 */
export function sqlCacheSchema(
  /** The engine whose DDL the definitions follow. */
  engine: SqlCacheSchemaEngine,
  /** The resolved table names. */
  tables: Record<SqlCacheTable, string>,
  /** Whether the engine has the bus table: MySQL, MariaDB and `bun:sqlite` do; Postgres and D1 do not. */
  withBus: boolean,
): SchemaDefinition {
  const type = columnTypes(engine);
  const notNull = "NOT NULL";
  // The server engines write `NULL` for a nullable column; SQLite leaves it bare.
  const nullable =
    engine === "mysql" || engine === "mariadb" ? "NULL" : undefined;
  const sqlite = engine === "sqlite";

  const entries: TableDefinition = {
    name: tables.entries,
    columns: [
      column("ns", type.name, notNull),
      column("k", type.name, notNull),
      column("v", type.bytes, nullable),
      column("n", type.integer, nullable),
      column("exp", type.integer, nullable),
      // SQLite's `ca` is nullable; the servers' is not.
      column("ca", type.integer, sqlite ? undefined : notNull),
      column("tg", type.text, nullable),
    ],
    primaryKey: ["ns", "k"],
  };
  const tags: TableDefinition = {
    name: tables.tags,
    columns: [
      column("ns", type.name, notNull),
      column("tag", type.name, notNull),
      column("k", type.name, notNull),
    ],
    primaryKey: ["ns", "tag", "k"],
  };
  const stamps: TableDefinition = {
    name: tables.stamps,
    columns: [
      column("ns", type.name, notNull),
      column("tag", type.name, notNull),
      column("at", type.integer, notNull),
      column("exp", type.integer, notNull),
    ],
    primaryKey: ["ns", "tag"],
  };
  const locks: TableDefinition = {
    name: tables.locks,
    columns: [
      column("ns", type.name, notNull),
      column("k", type.name, notNull),
      column("owner", type.name, notNull),
      column("exp", type.integer, notNull),
    ],
    primaryKey: ["ns", "k"],
  };
  const bus: TableDefinition = sqlite
    ? {
        name: tables.bus,
        columns: [
          column("seq", "INTEGER", "PRIMARY KEY AUTOINCREMENT"),
          column("at", "INTEGER", notNull),
          column("msg", "TEXT", notNull),
        ],
        primaryKey: [],
      }
    : {
        name: tables.bus,
        columns: [
          column("seq", "BIGINT", "NOT NULL AUTO_INCREMENT"),
          column("at", "BIGINT", notNull),
          column("msg", "LONGTEXT", notNull),
        ],
        primaryKey: ["seq"],
      };

  const indexes: IndexDefinition[] = [
    {
      name: sqlCacheIndexName(tables.entries, "exp"),
      table: tables.entries,
      columns: ["exp"],
      ...(type.partial ? { predicate: "exp IS NOT NULL" } : {}),
    },
    {
      name: sqlCacheIndexName(tables.tags, "key"),
      table: tables.tags,
      columns: ["ns", "k"],
    },
  ];
  if (withBus && !sqlite) {
    // MySQL and MariaDB index the bus by time, for the retention prune.
    indexes.push({
      name: sqlCacheIndexName(tables.bus, "at"),
      table: tables.bus,
      columns: ["at"],
    });
  }

  return {
    tables: withBus
      ? [entries, tags, stamps, locks, bus]
      : [entries, tags, stamps, locks],
    indexes,
  };
}

/**
 * A bun-sql change as bun-cache's public `SchemaChange.description`:
 * `"<kind> <table>.<target>: <reason>"`, for instance
 * `"create-index bun_cache_tags.ix_bun_cache_tags_key: the driver defines it and the table does not have it"`.
 * The kinds are bun-sql's: `add-column`, `alter-column`, `create-index`,
 * `drop-index`.
 */
export function describeChange(change: SharedSchemaChange): string {
  return `${change.kind} ${change.table}.${change.target}: ${change.reason}`;
}

/** A bun-sql change in bun-cache's public shape. */
export function toCacheChange(change: SharedSchemaChange): SchemaChange {
  return {
    description: describeChange(change),
    applied: change.applied,
    blocking: change.blocking,
  };
}

/**
 * Syncs `engine`'s tables over `backend` with bun-sql's engine and reports
 * every change in bun-cache's shape. `options.dryRun` reports without
 * applying; otherwise it adds what is missing and reconciles the driver's own
 * `ix_…` indexes, and never rewrites a column (`alterColumns` off). On SQLite
 * an index build blocks writers while it runs, so its changes say
 * `blocking: true`.
 */
export async function syncCacheSchema(
  /** Reads the catalog and runs the repairs. */
  backend: SyncBackend,
  /** The engine. */
  engine: SqlCacheSchemaEngine,
  /** The tables and indexes to compare against. */
  definition: SchemaDefinition,
  /** bun-cache's options: `dryRun` only. */
  options: SchemaSyncOptions,
): Promise<SchemaChange[]> {
  const changes = await syncSqlSchema(
    backend,
    dialectFor(engine, CACHE_SQL),
    definition,
    resolveSyncOptions({
      dryRun: options.dryRun ?? false,
      alterColumns: false,
    }),
  );
  return changes.map(toCacheChange);
}
