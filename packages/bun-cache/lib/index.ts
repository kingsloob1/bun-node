/**
 * `@kingsleyweb/bun-cache`: caching over pluggable drivers (plan
 * `docs/plans/bun-cache/`). The core, the memory, file and SQLite drivers and
 * the conformance kit (`@kingsleyweb/bun-cache/testing`) have landed; the
 * SQL, MongoDB, Redis and S3 drivers follow the plan's order.
 *
 * ```ts
 * import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
 *
 * const cache = createCache({ driver: memoryDriver(), ttl: 60_000 });
 * await cache.set("user:42", user, { tags: ["users"] });
 * const report = await cache.getOrSet("report:q3", () => buildReport(), {
 *   staleWhileRevalidate: 60_000,
 * });
 * ```
 */
export { createCache } from "./core/cache";
export {
  CacheDriverError,
  CircuitOpenError,
  EntryTooLargeError,
  LoaderTimeoutError,
  UnsupportedOperationError,
} from "./core/errors";
export { fromSimpleDriver } from "./core/simple";
export type {
  BusMessage,
  Cache,
  CacheCounterKeys,
  CacheDriver,
  CacheDriverCapabilities,
  CacheEntry,
  CacheErrorPhase,
  CacheEvent,
  CacheEventMap,
  CacheLoader,
  CacheLoaderContext,
  CacheLoadDurations,
  CacheLockOptions,
  CachePatternKey,
  CacheSchema,
  CacheSchemaFrom,
  CacheStats,
  Codec,
  CompressOptions,
  CreateCacheOptions,
  GetOrSetOptions,
  JsonifySchema,
  SchemaChange,
  SchemaSyncOptions,
  SetOptions,
  SimpleCacheDriver,
  StoredEntry,
  TagFence,
} from "./core/types";
export { memoryDriver } from "./drivers/memory";
export type { MemoryDriverOptions } from "./drivers/memory";
export { fileDriver } from "./drivers/file";
export type { FileDriverOptions } from "./drivers/file";
export { sqliteDriver } from "./drivers/sqlite";
export type { SqliteDriverOptions } from "./drivers/sqlite";
