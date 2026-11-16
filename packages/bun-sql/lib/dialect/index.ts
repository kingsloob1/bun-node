/**
 * What differs between the SQL engines: `@kingsleyweb/bun-sql/dialect`.
 *
 * ```ts
 * const dialect = dialectFor(detectAdapter(url));
 * await sql.unsafe(dialect.upsert("kv", ["k", "v"], ["k"], ["v"]), ["a", "1"]);
 * ```
 */
export { declaredCollation, detectAdapter, dialectFor } from "./dialect";
export type {
  AlterColumn,
  KeysetCursor,
  SqlAdapter,
  SqlDialect,
} from "./types";
