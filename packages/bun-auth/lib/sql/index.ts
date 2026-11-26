/**
 * `@kingsleyweb/bun-auth/sql`: better-auth's database adapter on bun-sql,
 * for Postgres, MySQL, MariaDB and SQLite through Bun's own `SQL` client
 * (`docs/plans/bun-auth/sql-adapter.md`).
 *
 * ```ts
 * import { betterAuth } from "better-auth";
 * import { bunSqlAdapter } from "@kingsleyweb/bun-auth/sql";
 *
 * export const auth = betterAuth({
 *   database: bunSqlAdapter({ url: process.env.DATABASE_URL, syncSchema: true }),
 * });
 * ```
 *
 * Bun only. Needs `better-auth` (`better-auth/adapters`, `better-auth/db`)
 * and `@kingsleyweb/bun-sql`.
 */
export { bunSqlAdapter } from "./adapter";
export type { BunSqlAdapter, BunSqlAdapterOptions } from "./adapter";
export type { AuthSchemaChange } from "./sync";
