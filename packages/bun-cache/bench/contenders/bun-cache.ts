import type { Cache, CacheDriver, CreateCacheOptions } from "../../lib/index";
import type {
  Backend,
  CacheContender,
  CacheHandle,
  HttpHandle,
  Scenario,
  SetupContext,
  TierHandle,
} from "../lib/types";
import { join } from "node:path";
import { BunRouter } from "@kingsleyweb/bun-common";
import {
  createCache,
  fileDriver,
  mariadbDriver,
  memoryDriver,
  mongoDriver,
  mysqlDriver,
  postgresDriver,
  redisDriver,
  sqliteDriver,
} from "../../lib/index";
import { cacheResponse } from "../../lib/http/index";
import { MONGO_CACHE_COLLECTIONS } from "../../lib/drivers/mongo";
import { SQL_CACHE_TABLES } from "../../lib/drivers/sql-tables";
import {
  deleteRedisPrefix,
  dropMongoCollections,
  dropSqlTables,
} from "../lib/cleanup";
import { routeBody } from "../lib/payload";

/**
 * `@kingsleyweb/bun-cache` — the library this repository ships, on every
 * backend it has a driver for.
 *
 * Configured as a caller gets it by default: the structured codec, zstd above
 * 16 KiB, the failure policy on. Only the sweeper is off (`sweepInterval: 0`),
 * because a sweep landing inside a measured phase measures the sweep.
 */

/** The driver for one backend, named after the run so its data is the run's own. */
function makeDriver(backend: Backend, ctx: SetupContext): CacheDriver {
  const sqlPrefix = `bcb_${ctx.run}_`;
  switch (backend) {
    case "memory":
      return memoryDriver();
    case "file":
      return fileDriver({ root: join(ctx.scratch, "bun-cache") });
    case "sqlite":
      return sqliteDriver({ path: join(ctx.scratch, "bun-cache.db") });
    case "redis":
      return redisDriver({ url: ctx.url, prefix: `bcb-${ctx.run}` });
    case "postgres":
      return postgresDriver({ url: ctx.url, prefix: sqlPrefix });
    case "mysql":
      return mysqlDriver({ url: ctx.url, prefix: sqlPrefix });
    case "mariadb":
      return mariadbDriver({ url: ctx.url, prefix: sqlPrefix });
    case "mongodb":
      return mongoDriver({ url: ctx.url, prefix: sqlPrefix });
  }
}

/** Deletes what a run's driver created on a networked backend; the in-process ones go with the scratch directory. */
async function dropRunData(backend: Backend, ctx: SetupContext): Promise<void> {
  const sqlPrefix = `bcb_${ctx.run}_`;
  if (backend === "redis") {
    await deleteRedisPrefix(ctx.url, `bcb-${ctx.run}`);
  } else if (
    backend === "postgres" ||
    backend === "mysql" ||
    backend === "mariadb"
  ) {
    await dropSqlTables(
      ctx.url,
      SQL_CACHE_TABLES.map((table) => `${sqlPrefix}${table}`),
    );
  } else if (backend === "mongodb") {
    await dropMongoCollections(
      ctx.url,
      MONGO_CACHE_COLLECTIONS.map((name) => `${sqlPrefix}${name}`),
    );
  }
}

/** A cache on one backend, with the options every scenario shares. */
function makeCache(
  backend: Backend,
  ctx: SetupContext,
  extra: Partial<CreateCacheOptions> = {},
): Cache {
  return createCache({
    driver: makeDriver(backend, ctx),
    namespace: `bench-${ctx.run}`,
    ttl: 600_000,
    sweepInterval: 0,
    ...extra,
  });
}

/** Closes a cache, then deletes the run's data. */
async function closeAndDrop(
  cache: Cache,
  backend: Backend,
  ctx: SetupContext,
): Promise<void> {
  await cache.close();
  await dropRunData(backend, ctx);
}

/** The scenarios every bun-cache contender takes part in. */
const CORE: readonly Scenario[] = [
  "get-hit-100b",
  "get-hit-10kb",
  "get-hit-1mb",
  "get-miss",
  "set-100b",
  "set-10kb",
  "set-1mb",
  "get-many-100",
  "set-many-100",
  "stampede",
  "tags-set",
  "tags-invalidate",
];

/** The backends with a tier contender (§15.1: Postgres and Redis, the two with a push bus). */
const TIERED: ReadonlySet<Backend> = new Set(["redis", "postgres"]);

/** The backends of the HTTP scenarios (§15.1). */
const HTTP: ReadonlySet<Backend> = new Set(["memory", "redis"]);

/** Builds the bun-cache contender for one backend. */
function contender(backend: Backend, label: string): CacheContender {
  return {
    id: `bun-cache-${backend}`,
    label: `bun-cache (${label})`,
    backend,
    ours: true,
    scenarios: [
      ...CORE,
      ...(TIERED.has(backend)
        ? (["tier-hit", "tier-invalidate"] as const)
        : []),
      ...(HTTP.has(backend)
        ? (["http-hit", "http-304", "http-miss", "http-uncached"] as const)
        : []),
    ],
    setup: (ctx): CacheHandle => {
      const cache = makeCache(backend, ctx);
      return {
        get: (key) => cache.get(key),
        set: async (key, value, tags) => {
          await cache.set(key, value, tags ? { tags } : undefined);
        },
        getMany: (keys) => cache.getMany(keys),
        setMany: async (entries) => {
          await cache.setMany(entries.map(([key, value]) => [key, value]));
        },
        getOrSet: (key, loader) => cache.getOrSet(key, loader),
        invalidateTags: (tags) => cache.invalidateTags(tags),
        close: () => closeAndDrop(cache, backend, ctx),
      };
    },
    tier: (ctx, role): TierHandle => {
      // The driver's own bus: LISTEN/NOTIFY on Postgres, pub/sub on Redis.
      const cache = makeCache(backend, ctx, { l1: true });
      return {
        get: (key) => cache.get(key),
        set: async (key, value) => {
          await cache.set(key, value);
        },
        close: () =>
          role === "writer" ? closeAndDrop(cache, backend, ctx) : cache.close(),
      };
    },
    http: (ctx): HttpHandle => {
      const cache = makeCache(backend, ctx);
      const router = new BunRouter();
      // The same handler behind both routes: the uncached one is what the
      // cached one costs without the cache.
      router.get(
        "/cached",
        cacheResponse(cache, { ttl: 600_000 }),
        (_req, res) => {
          res.json(routeBody());
        },
      );
      router.get("/uncached", (_req, res) => {
        res.json(routeBody());
      });
      return {
        fetch: (path, init) => router.fetch(path, init),
        close: () => closeAndDrop(cache, backend, ctx),
      };
    },
  };
}

/** Every bun-cache contender. */
export function bunCacheContenders(): CacheContender[] {
  return [
    contender("memory", "memory"),
    contender("file", "file"),
    contender("sqlite", "SQLite"),
    contender("redis", "Redis"),
    contender("postgres", "Postgres"),
    contender("mysql", "MySQL"),
    contender("mariadb", "MariaDB"),
    contender("mongodb", "MongoDB"),
  ];
}
