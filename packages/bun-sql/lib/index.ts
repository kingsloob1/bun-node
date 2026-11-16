/**
 * `@kingsleyweb/bun-sql`: the SQL layer bun-jobs, bun-cache and bun-security
 * share (bun-security plan, storage.md §4). Every area is also its own
 * subpath — `./dialect`, `./schema`, `./sync`, `./cursor`, `./connection`,
 * `./mongo` — so a service imports only what it uses; the MongoDB client is
 * loaded only by `./mongo`'s `loadMongoClient`, on first call.
 *
 * Bun only: the connection helpers open `bun`'s `SQL` client.
 */
export * from "./connection/index";
export * from "./cursor/index";
export * from "./dialect/index";
export { defaultConfigError } from "./errors";
export type { SqlConfigError, SqlErrorOptions } from "./errors";
export * from "./mongo/index";
export * from "./schema/index";
export * from "./sync/index";
