/**
 * `@kingsleyweb/bun-cache`: caching over pluggable drivers (plan
 * `docs/plans/bun-cache/`). The core, the memory, file, SQLite, Postgres,
 * MySQL, MariaDB, Redis, MongoDB, S3, Azure Blob Storage, Cloudflare KV and
 * Cloudflare D1 drivers, the multi-tier L1 with its buses (`redisBus`, `pgBus`), the
 * conformance kit (`@kingsleyweb/bun-cache/testing`) and the Cloudflare
 * drivers' Worker (`@kingsleyweb/bun-cache/cloudflare-worker`) have landed.
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
  CacheDecryptError,
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
  CacheBus,
  CacheCipher,
  CacheCipherContext,
  CacheCompressor,
  CacheCounterKeys,
  CacheDriver,
  CacheDriverCapabilities,
  CacheEncryptOptions,
  CacheEntry,
  CacheErrorPhase,
  CacheEvent,
  CacheEventMap,
  CacheFencedReason,
  CacheKey,
  CacheKeyRing,
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
export { postgresDriver } from "./drivers/postgres";
export type { PostgresDriverOptions } from "./drivers/postgres";
export { mariadbDriver, mysqlDriver } from "./drivers/mysql";
export type { MysqlDriverOptions } from "./drivers/mysql";
export type { SqlCacheDriverOptions } from "./drivers/sql-base";
export type { SqlConnectionOptions } from "./drivers/sql-connection";
export type { SqlCacheTable } from "./drivers/sql-tables";
export { redisDriver } from "./drivers/redis";
export type { RedisDriverOptions } from "./drivers/redis";
export { s3Driver } from "./drivers/s3";
export type { S3DriverOptions } from "./drivers/s3";
export { azureBlobDriver } from "./drivers/azure";
export type {
  AzureBlobConnection,
  AzureBlobDriverOptions,
} from "./drivers/azure";
export { cloudflareKvDriver } from "./drivers/cloudflare-kv";
export type { CloudflareKvDriverOptions } from "./drivers/cloudflare-kv";
export { cloudflareD1Driver } from "./drivers/cloudflare-d1";
export type { CloudflareD1DriverOptions } from "./drivers/cloudflare-d1";
export { pgBus, redisBus } from "./bus/index";
export type { PgBusOptions, RedisBusOptions } from "./bus/index";
export { mongoDriver } from "./drivers/mongo";
export type {
  MongoCacheCollection,
  MongoClientLike,
  MongoDriverOptions,
} from "./drivers/mongo";
