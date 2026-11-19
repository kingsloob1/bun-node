/**
 * Connection plumbing for the SQL drivers. Since PR-D0c it is bun-sql's
 * (`@kingsleyweb/bun-sql/connection`, the bun-security plan's storage.md
 * §4): the helpers are re-exported, and the ones that can refuse an argument
 * are thin wrappers passing bun-cache's error seam (`./sql-seam`), so a
 * malformed connection is still a `TypeError` with the same message, and
 * every signature is the one bun-cache had. `__tests__/drivers/sql-connection.test.ts`
 * still compares them with bun-jobs' own handling: behaviour, not text.
 */
import type { SQL } from "bun";
import type {
  ConnectionInput,
  UrlDefaults,
} from "@kingsleyweb/bun-sql/connection";
import {
  openSqlClient as openSharedSqlClient,
  resolveConnectionUrl as resolveSharedConnectionUrl,
  sqlClientOptions as sharedSqlClientOptions,
  takeBooleanParam as takeSharedBooleanParam,
} from "@kingsleyweb/bun-sql/connection";
import { CACHE_SQL } from "./sql-seam";

export {
  isPublicKeyRetrievalRefusal,
  isTransientLockError,
  toConnectionUrl,
  withLockRetry,
} from "@kingsleyweb/bun-sql/connection";
export type {
  ConnectionInput,
  SqlConnectionOptions,
  UrlDefaults,
} from "@kingsleyweb/bun-sql/connection";

/** The engines the SQL drivers speak. */
export type SqlCacheAdapter = "postgres" | "mysql" | "mariadb";

/**
 * Resolves either form into a URL: bun-sql's `resolveConnectionUrl`
 * through bun-cache's seam, so it throws a `TypeError` where bun-jobs throws
 * its `ConfigError`.
 *
 * A URL wins when both are given, so an environment variable can override a
 * config file without the config having to be rewritten.
 */
export function resolveConnectionUrl(
  input: ConnectionInput,
  defaults: UrlDefaults,
  what: string,
): string {
  return resolveSharedConnectionUrl(input, defaults, what, CACHE_SQL);
}

/**
 * Takes a boolean query parameter out of a connection URL: bun-sql's
 * `takeBooleanParam` through bun-cache's seam, so it throws a `TypeError`
 * where bun-jobs throws its `ConfigError`.
 *
 * Returns the URL without it, and its value: `true` for `true`/`1`/`yes`,
 * `false` for `false`/`0`/`no`, `undefined` when absent. For a parameter the
 * driver understands and the client does not — the client would ignore it, so
 * a URL carrying it would connect as though it were not there. Every other
 * parameter, `sslmode` and `tls` included, is left exactly as written. The
 * query is edited as text, so the rest of the URL (a password with escapes, a
 * host list) is never reparsed or re-encoded.
 */
export function takeBooleanParam(
  url: string,
  name: string,
): { url: string; value: boolean | undefined } {
  return takeSharedBooleanParam(url, name, CACHE_SQL);
}

/**
 * What `new SQL(...)` receives for a connection: the URL, and on MySQL and
 * MariaDB the `allowPublicKeyRetrieval` option taken out of it. Pure, so the
 * drift test can compare it with bun-jobs' handling without a server.
 *
 * On MySQL and MariaDB, `allowPublicKeyRetrieval` comes from the URL's query
 * parameter or, for a connection given as fields, from that field — the URL
 * wins, as it does for everything else. Bun's client ignores the parameter in
 * a URL, so it is taken out and passed as the client option it has to be.
 * Every other parameter, `ssl`/`tls`/`sslmode` included, stays in the URL for
 * the client to read.
 */
export function sqlClientOptions(
  adapter: SqlCacheAdapter,
  input: ConnectionInput,
  what: string,
): { url: string; allowPublicKeyRetrieval?: boolean } {
  return sharedSqlClientOptions(adapter, input, what, CACHE_SQL);
}

/** Opens a client for a connection, with `max` connections in its pool when given. */
export function openSqlClient(
  adapter: SqlCacheAdapter,
  input: ConnectionInput,
  what: string,
  max: number | undefined,
): SQL {
  return openSharedSqlClient(adapter, input, what, { max }, CACHE_SQL);
}
