/**
 * The `maxEntries` sweeper for the SQL-family drivers (plan §3.9, the SQL
 * row): the statements that pick which entries go when a table holds more
 * than its cap. Written for SQLite first and shaped so the Postgres, MySQL
 * and MariaDB drivers can use it unchanged, with their own placeholder.
 *
 * **The pattern**, in one transaction, after the sweep's expired delete:
 *
 * 1. `count` the entries — rows with `n IS NULL`. Counters are not entries:
 *    evicting one would silently reset a rate-limit window (§3.8), and the
 *    memory driver's cap counts entries only. Locks, stamps and bus rows live
 *    in other tables.
 * 2. Evict `min(count - maxEntries, limit)` rows, **nearest to expiry
 *    first**: `withExpiry` (ascending `exp`), then, if still over,
 *    `withoutExpiry` (oldest write first, by `ca`). Ties break on `(ns, k)`,
 *    so the choice is deterministic.
 * 3. Delete each victim by its key, with its tag-index rows, and report it
 *    through `onEviction` once the transaction has committed.
 *
 * **Why select-then-delete** rather than one `DELETE … WHERE (ns, k) IN
 * (SELECT … ORDER BY … LIMIT n) RETURNING …`: MySQL refuses `LIMIT` inside an
 * `IN` subquery and a subquery on the table being deleted from, and has no
 * `DELETE … RETURNING` (MariaDB has it from 10.5). Inside the transaction —
 * `BEGIN IMMEDIATE` on SQLite, `SELECT … FOR UPDATE` on the others — the
 * selected rows cannot change before their delete.
 *
 * **Dialect notes** for the drivers that copy it:
 *
 * - Postgres sorts `NULL` last in ascending order where SQLite and MySQL sort
 *   it first; the statements never sort a `NULL` (`ca` is always written,
 *   and the two phases split on `exp IS NULL`), so the order is the same on
 *   all four. Postgres takes `$1` as the placeholder; append `FOR UPDATE` on
 *   Postgres, MySQL and MariaDB.
 * - `COUNT(*)` is answered as a `bigint`: Postgres returns it as a string
 *   through Bun's `SQL`. `Number(...)` it.
 */

/** The statements one driver's cap sweep runs. */
export interface EntryCapStatements {
  /** Counts the entries (not counters): one row, column `c`. */
  count: string;
  /** Up to `limit` entries with an expiry, soonest first: columns `ns`, `k`, `tg`. One parameter: the limit. */
  withExpiry: string;
  /** Up to `limit` entries without an expiry, oldest write first: columns `ns`, `k`, `tg`. One parameter: the limit. */
  withoutExpiry: string;
}

/**
 * Builds the cap sweep's statements for an entries table (§3.9).
 *
 * @param entries The entries table, quoted as the dialect needs.
 * @param limitParam The dialect's spelling of the one parameter, the limit (`"?"`, `"?1"`, `"$1"`).
 * @param suffix Appended to each victim query: `""` on SQLite, `" FOR UPDATE"` on the others.
 */
export function entryCapStatements(
  entries: string,
  limitParam: string,
  suffix = "",
): EntryCapStatements {
  return {
    count: `SELECT COUNT(*) AS c FROM ${entries} WHERE n IS NULL`,
    withExpiry: `SELECT ns, k, tg FROM ${entries} WHERE n IS NULL AND exp IS NOT NULL ORDER BY exp, ca, ns, k LIMIT ${limitParam}${suffix}`,
    withoutExpiry: `SELECT ns, k, tg FROM ${entries} WHERE n IS NULL AND exp IS NULL ORDER BY ca, ns, k LIMIT ${limitParam}${suffix}`,
  };
}

/** How many entries a cap sweep evicts: the excess over `maxEntries`, bounded by the sweep's `limit`. */
export function entryCapExcess(
  count: number,
  maxEntries: number,
  limit: number,
): number {
  return Math.max(0, Math.min(count - maxEntries, limit));
}
