/**
 * Identifiers for bun-auth's SQL adapter: quoting, and the names of the
 * indexes it creates.
 *
 * better-auth's names need quoting on every engine: its columns are camelCase
 * (`emailVerified`, which Postgres folds to `emailverified` unquoted), its
 * main table is `user` (reserved on Postgres) and plugins add columns such as
 * `key` (reserved on MySQL). bun-sql's schema sync binds table and column
 * names as catalog parameters and splices the same strings into its DDL, so
 * it is given the raw names and every statement this adapter runs is
 * rendered here with quoted ones (see `schema.ts`).
 */
import type { SqlAdapter } from "@kingsleyweb/bun-sql/dialect";

/**
 * Quotes one identifier for `engine`: backticks on MySQL and MariaDB, double
 * quotes on Postgres and SQLite, with the quote character doubled inside.
 */
export function quoteIdentifier(engine: SqlAdapter, name: string): string {
  if (engine === "mysql" || engine === "mariadb") {
    return `\`${name.replaceAll("`", "``")}\``;
  }
  return `"${name.replaceAll('"', '""')}"`;
}

/** The longest index name every engine takes: Postgres's 63 bytes (MySQL allows 64). */
const MAX_INDEX_NAME = 63;

/** A short, stable FNV-1a hash of `value`, as 8 hex digits. */
function hash(value: string): string {
  let h = 2166136261;
  for (let at = 0; at < value.length; at++) {
    h ^= value.charCodeAt(at);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The name of an index this adapter defines on `table` over `columns`.
 *
 * `ix_` for a plain index, which bun-sql's sync manages (it drops an `ix_`
 * index the definition no longer has, and never touches another name), and
 * `ux_` for a unique one, which the adapter creates itself and never drops.
 * Index names are global to a schema on Postgres and SQLite, so the table's
 * name (prefix included) is part of it. Lowercased, with anything other than
 * a letter, digit or underscore replaced, so it needs no quoting; a name over
 * 63 bytes is cut and ends in a hash of the whole, so it stays unique.
 */
export function indexName(
  kind: "ix" | "ux",
  table: string,
  columns: readonly string[],
): string {
  const full = `${kind}_${table}_${columns.join("_")}`;
  const safe = full.toLowerCase().replaceAll(/\W/g, "_");
  if (safe.length <= MAX_INDEX_NAME && safe === full.toLowerCase()) {
    return safe;
  }
  const suffix = `_${hash(full)}`;
  return `${safe.slice(0, MAX_INDEX_NAME - suffix.length)}${suffix}`;
}
