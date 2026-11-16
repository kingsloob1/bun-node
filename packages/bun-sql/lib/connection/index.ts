/**
 * Connecting: `@kingsleyweb/bun-sql/connection`.
 *
 * ```ts
 * const sql = openSqlClient("mysql", { url }, "The audit store", { max: 10 });
 * await withLockRetry(() => sql.unsafe("UPDATE …"));
 * ```
 */
export {
  databaseFromUrl,
  isPublicKeyRetrievalRefusal,
  isTransientLockError,
  openSqlClient,
  resolveConnectionUrl,
  sqlClientOptions,
  takeBooleanParam,
  toConnectionUrl,
  withLockRetry,
} from "./connection";
export type {
  ConnectionInput,
  SqlClientLimits,
  SqlConnectionOptions,
  UrlDefaults,
} from "./connection";
