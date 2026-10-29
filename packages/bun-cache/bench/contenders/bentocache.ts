import type { BentoStore } from "bentocache";
import type {
  Backend,
  CacheContender,
  CacheHandle,
  Scenario,
  SetupContext,
  TierHandle,
} from "../lib/types";
import { join } from "node:path";
import { BentoCache, bentostore } from "bentocache";
import { fileDriver } from "bentocache/drivers/file";
import { knexDriver } from "bentocache/drivers/knex";
import { memoryDriver } from "bentocache/drivers/memory";
import { redisBusDriver, redisDriver } from "bentocache/drivers/redis";
import { Redis } from "ioredis";
import knex from "knex";
import { BACKEND_ENV_VAR, backendUrl, splitMysqlUrl } from "../lib/env";
import { deleteRedisPrefix, dropSqlTables } from "../lib/cleanup";

/**
 * BentoCache 1.6.1, the multi-tier cache bun-cache's design is closest to:
 * single-flight `getOrSet`, tags, and an L1 kept coherent by a Redis bus.
 *
 * Outside the tier scenarios it runs on its L2 alone, as bun-cache runs on its
 * driver alone, so the two are compared layer for layer; on the memory
 * backend its store is the L1 memory driver. Its SQL drivers go through Knex
 * (`pg`, `mysql2`), the one database adapter of its three that needs no ORM.
 */

/** What BentoCache answers outside the tier scenarios. */
const CORE: readonly Scenario[] = ["stampede", "tags-set", "tags-invalidate"];

/** The backends BentoCache has a driver for here. */
const BACKENDS: readonly Backend[] = [
  "memory",
  "file",
  "redis",
  "postgres",
  "mysql",
  "mariadb",
];

/** Something a run opened and must close, after BentoCache's own `disconnect()`. */
type Closer = () => void | Promise<void>;

/** The run's Redis key prefix and SQL table. */
function namesOf(ctx: SetupContext): { prefix: string; table: string } {
  return { prefix: `bento-${ctx.run}`, table: `bento_${ctx.run}` };
}

/** BentoCache's L2 layer on one backend, and how to close what it opened. */
function l2For(
  backend: Backend,
  ctx: SetupContext,
  closers: Closer[],
):
  | ReturnType<typeof redisDriver>
  | ReturnType<typeof knexDriver>
  | ReturnType<typeof fileDriver> {
  const { prefix, table } = namesOf(ctx);
  switch (backend) {
    case "redis": {
      const connection = new Redis(ctx.url);
      closers.push(() => {
        connection.disconnect();
      });
      return redisDriver({ connection, prefix });
    }
    case "file":
      return fileDriver({ directory: join(ctx.scratch, "bento"), prefix });
    case "postgres":
    case "mysql":
    case "mariadb": {
      const db = knex(
        backend === "postgres"
          ? { client: "pg", connection: ctx.url }
          : {
              client: "mysql2",
              connection: splitMysqlUrl(ctx.url).url.replace(
                /^mariadb:/,
                "mysql:",
              ),
            },
      );
      closers.push(async () => {
        await db.destroy();
      });
      return knexDriver({ connection: db, tableName: table, prefix });
    }
    default:
      throw new Error(`BentoCache has no L2 for ${backend} here`);
  }
}

/** A BentoCache with one store, `bench`, and how to close and clean up after it. */
function makeBento(
  store: BentoStore,
  closers: Closer[],
  cleanup: Closer,
): { bento: BentoCache<{ bench: BentoStore }>; close: () => Promise<void> } {
  const bento = new BentoCache({
    default: "bench",
    stores: { bench: store },
    ttl: "10m",
  });
  return {
    bento,
    close: async () => {
      await bento.disconnect();
      for (const close of closers) {
        await Promise.resolve()
          .then(close)
          .catch(() => undefined);
      }
      await cleanup();
    },
  };
}

/** Deletes what a run created on the backend (the file driver's goes with the scratch directory). */
async function dropRunData(backend: Backend, ctx: SetupContext): Promise<void> {
  const { prefix, table } = namesOf(ctx);
  if (backend === "redis") {
    await deleteRedisPrefix(ctx.url, prefix);
  } else if (
    backend === "postgres" ||
    backend === "mysql" ||
    backend === "mariadb"
  ) {
    await dropSqlTables(ctx.url, [table]);
  }
}

/**
 * The Redis server BentoCache's bus runs on, on every tier backend: it has no
 * Postgres bus, so on Postgres its L2 is the database and its bus Redis.
 */
function busUrl(): string {
  return backendUrl("redis");
}

/** Builds the BentoCache contender for one backend. */
function contender(backend: Backend): CacheContender {
  const tiered = backend === "redis" || backend === "postgres";
  return {
    id: `bentocache-${backend}`,
    label: `BentoCache (${backend})`,
    backend,
    scenarios: [
      ...CORE,
      ...(tiered ? (["tier-hit", "tier-invalidate"] as const) : []),
    ],
    note:
      backend === "postgres"
        ? `BentoCache has no Postgres bus: in the tier scenarios its bus is Redis (${BACKEND_ENV_VAR.redis} or the default).`
        : undefined,
    setup: (ctx): CacheHandle => {
      const closers: Closer[] = [];
      const store =
        backend === "memory"
          ? bentostore().useL1Layer(memoryDriver({ maxItems: 100_000 }))
          : bentostore().useL2Layer(l2For(backend, ctx, closers));
      const { bento, close } = makeBento(store, closers, () =>
        dropRunData(backend, ctx),
      );
      return {
        get: (key) => bento.get({ key }),
        set: async (key, value, tags) => {
          await bento.set({ key, value, tags: tags ? [...tags] : undefined });
        },
        getOrSet: (key, loader) => bento.getOrSet({ key, factory: loader }),
        invalidateTags: async (tags) => {
          await bento.deleteByTag({ tags: [...tags] });
        },
        close,
      };
    },
    tier: (ctx, role): TierHandle => {
      const closers: Closer[] = [];
      const busConnection = new Redis(busUrl());
      closers.push(() => {
        busConnection.disconnect();
      });
      const store = bentostore()
        .useL1Layer(memoryDriver({ maxItems: 100_000 }))
        .useL2Layer(l2For(backend, ctx, closers))
        .useBus(redisBusDriver({ connection: busConnection.options }));
      const { bento, close } = makeBento(store, closers, () =>
        role === "writer" ? dropRunData(backend, ctx) : Promise.resolve(),
      );
      return {
        get: (key) => bento.get({ key }),
        set: async (key, value) => {
          await bento.set({ key, value });
        },
        close,
      };
    },
  };
}

/** Every BentoCache contender. */
export function bentoContenders(): CacheContender[] {
  return BACKENDS.map((backend) => contender(backend));
}
