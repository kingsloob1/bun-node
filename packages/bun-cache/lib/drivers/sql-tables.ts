/**
 * Table names for the SQL-family drivers (SQLite, Postgres, MySQL, MariaDB):
 * a `prefix` for all of them, or exact names per table through `tables`, as
 * bun-jobs' SQL driver takes them (`tablePrefix` and `tables` there). A name
 * given in `tables` is used as-is and ignores the prefix; every other table
 * keeps `<prefix><table>`.
 *
 * Every name is an SQL identifier (letters, digits and `_`, not starting with
 * a digit, at most 63 characters — Postgres's limit, one under MySQL's), so
 * it can be written into a statement without quoting rules of its own, and
 * no two tables may share one. Index names are derived from their table's
 * name (`ix_<table>_<suffix>`), shortened with a hash of the table name when
 * that would pass 63 characters, so they stay unique and legal on every
 * engine.
 */

/** The tables a SQL-family cache driver keeps. `bus` exists on the polled-bus engines only (SQLite, MySQL, MariaDB). */
export const SQL_CACHE_TABLES = [
  "entries",
  "tags",
  "stamps",
  "locks",
  "bus",
] as const;

/** One of the SQL-family drivers' tables, as the `tables` option names it. */
export type SqlCacheTable = (typeof SQL_CACHE_TABLES)[number];

/** The longest identifier accepted: Postgres's 63 bytes (MySQL allows 64). */
export const MAX_SQL_IDENTIFIER_LENGTH = 63;

/** An identifier the drivers write unquoted. */
const IDENTIFIER = /^[a-z_]\w*$/i;

/**
 * Resolves the table names: `tables[name]` when given, else
 * `<prefix><name>`. Throws a `TypeError` (naming `what`) for an unknown table
 * key, a key `allowed` does not include (Postgres has no `bus` table), a name
 * that is not an SQL identifier or is longer than 63 characters, or two
 * tables sharing a name. The prefix is validated by the caller.
 */
export function resolveSqlCacheTables(
  what: string,
  prefix: string,
  tables: Partial<Record<string, string>> | undefined,
  allowed: readonly SqlCacheTable[] = SQL_CACHE_TABLES,
): Record<SqlCacheTable, string> {
  for (const key of Object.keys(tables ?? {})) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new TypeError(
        (SQL_CACHE_TABLES as readonly string[]).includes(key)
          ? `${what}: tables.${key} is not a table this driver has (${allowed.join(", ")})`
          : `${what}: tables.${key} is not a table name (${allowed.join(", ")})`,
      );
    }
  }
  const resolved = {} as Record<SqlCacheTable, string>;
  const seen = new Map<string, SqlCacheTable>();
  for (const table of SQL_CACHE_TABLES) {
    const given = tables?.[table];
    const name = given ?? `${prefix}${table}`;
    if (
      given !== undefined &&
      (typeof given !== "string" ||
        !IDENTIFIER.test(given) ||
        given.length > MAX_SQL_IDENTIFIER_LENGTH)
    ) {
      throw new TypeError(
        `${what}: tables.${table} must be an SQL identifier (letters, digits and _, not starting with a digit, at most ${MAX_SQL_IDENTIFIER_LENGTH} characters); got ${JSON.stringify(given)}`,
      );
    }
    // Only the tables this driver has can clash (Postgres never makes `bus`).
    if (allowed.includes(table)) {
      const clash = seen.get(name.toLowerCase());
      if (clash !== undefined) {
        throw new TypeError(
          `${what}: tables ${clash} and ${table} would both be ${JSON.stringify(name)}`,
        );
      }
      seen.set(name.toLowerCase(), table);
    }
    resolved[table] = name;
  }
  return resolved;
}

/**
 * An index's name for `table`: `ix_<table>_<suffix>`, or, when that would
 * pass 63 characters, the table name cut short plus 8 hex characters of its
 * hash — still unique per table, and within every engine's limit.
 */
export function sqlCacheIndexName(table: string, suffix: string): string {
  const name = `ix_${table}_${suffix}`;
  if (name.length <= MAX_SQL_IDENTIFIER_LENGTH) {
    return name;
  }
  const hash = Bun.hash(table).toString(16).padStart(16, "0").slice(0, 8);
  const room = MAX_SQL_IDENTIFIER_LENGTH - `ix__${hash}_${suffix}`.length;
  return `ix_${table.slice(0, room)}_${hash}_${suffix}`;
}

/**
 * What identifies one store across processes, for the names derived from it
 * (Postgres's `LISTEN` channel and advisory-lock keys): its entries, tags,
 * stamps and locks tables. Two drivers on the same tables agree on it; two
 * on different tables never collide on it.
 */
export function sqlCacheStoreKey(
  tables: Record<SqlCacheTable, string>,
): string {
  return [tables.entries, tables.tags, tables.stamps, tables.locks].join(",");
}
