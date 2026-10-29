import type { Cache as CacheManager } from "cache-manager";
import type { KeyvStoreAdapter } from "keyv";
import type { Cache, CacheDriver } from "../../lib/index";
import type { BunCacheKeyvStore } from "../../lib/keyv/index";
import type { KeyvMajor } from "./harness";
import "reflect-metadata";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { CACHE_MANAGER, CacheModule } from "@nestjs/cache-manager";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, describe, expect, test } from "bun:test";
import {
  createCache,
  memoryDriver,
  postgresDriver,
  redisDriver,
  sqliteDriver,
} from "../../lib/index";
import { SQL_CACHE_TABLES } from "../../lib/drivers/sql-tables";
import { toKeyvStore } from "../../lib/keyv/index";
import { faulty } from "../../lib/testing/index";
import { deleteRedisPrefix, dropSqlTables } from "../lib/cleanup";
import { describeKeyvCompat } from "./contract";
import { cacheManagerOver, KEYV_VERSION, keyvOver, recording } from "./harness";

/**
 * `toKeyvStore` (PR-K1, plan §10.4) through the real cache-manager 7.2.9
 * over Keyv 5.6.0 and Keyv 6.1.0: the contract on memory, on a SQLite file,
 * on Postgres and on Redis (`BUN_CACHE_BENCH_POSTGRES_URL`,
 * `BUN_CACHE_BENCH_REDIS_URL`; unset, each skips by name), then what each
 * major hands the adapter, checked against what bun-cache stored, and
 * `@nestjs/cache-manager` 12.0.1's `CacheModule` over it. Run with
 * `bun run compat` in this directory.
 */

/**
 * The adapter is a Keyv 5 store by type too: `@nestjs/cache-manager`'s
 * `stores` option names Keyv 5's `KeyvStoreAdapter` (the `register` calls
 * below compile against it as well).
 */
export const isKeyv5Store: BunCacheKeyvStore extends KeyvStoreAdapter
  ? true
  : never = true;

const RUN = `${process.pid}_${Date.now().toString(36)}`;
const scratch = mkdtempSync(join(tmpdir(), "bun-cache-keyv-compat-"));
const POSTGRES_URL = process.env.BUN_CACHE_BENCH_POSTGRES_URL || undefined;
const REDIS_URL = process.env.BUN_CACHE_BENCH_REDIS_URL || undefined;
/** The Postgres tables this run creates, dropped by their exact names at the end. */
const PG_PREFIX = `bck1_${RUN}_`;
/** The Redis key prefix this run writes under, deleted (that prefix and its separator only) at the end. */
const REDIS_PREFIX = `bck1-${RUN}`;
let caseNumber = 0;

afterAll(async () => {
  rmSync(scratch, { recursive: true, force: true });
  if (POSTGRES_URL !== undefined) {
    await dropSqlTables(
      POSTGRES_URL,
      SQL_CACHE_TABLES.filter((table) => table !== "bus").map(
        (table) => `${PG_PREFIX}${table}`,
      ),
    );
  }
  if (REDIS_URL !== undefined) {
    await deleteRedisPrefix(REDIS_URL, REDIS_PREFIX);
  }
});

/** A cache in a namespace of its own (one per case), the sweeper off. */
function cacheOn(driver: CacheDriver): Cache {
  caseNumber++;
  return createCache({
    driver,
    namespace: `k1-${RUN}-${caseNumber}`,
    sweepInterval: 0,
  });
}

describeKeyvCompat("toKeyvStore over memory", () => {
  const cache = cacheOn(memoryDriver());
  return { store: () => toKeyvStore(cache), close: async () => cache.close() };
});

describeKeyvCompat("toKeyvStore over a SQLite file", () => {
  const cache = cacheOn(
    sqliteDriver({ path: join(scratch, `sqlite-${caseNumber}.db`) }),
  );
  return { store: () => toKeyvStore(cache), close: async () => cache.close() };
});

if (POSTGRES_URL === undefined) {
  describe.skip("toKeyvStore over Postgres: BUN_CACHE_BENCH_POSTGRES_URL is not set", () => {
    test("skipped", () => {});
  });
} else {
  const url = POSTGRES_URL;
  describeKeyvCompat("toKeyvStore over Postgres", () => {
    const cache = cacheOn(postgresDriver({ url, prefix: PG_PREFIX }));
    return {
      store: () => toKeyvStore(cache),
      close: async () => cache.close(),
    };
  });
}

if (REDIS_URL === undefined) {
  describe.skip("toKeyvStore over Redis: BUN_CACHE_BENCH_REDIS_URL is not set", () => {
    test("skipped", () => {});
  });
} else {
  const url = REDIS_URL;
  describeKeyvCompat("toKeyvStore over Redis", () => {
    const cache = cacheOn(redisDriver({ url, prefix: REDIS_PREFIX }));
    return {
      store: () => toKeyvStore(cache),
      close: async () => cache.close(),
    };
  });
}

/** A memory cache and an adapter over it, closed by the test. */
function memoryStore(): {
  cache: Cache;
  store: ReturnType<typeof toKeyvStore>;
} {
  const cache = cacheOn(memoryDriver());
  return { cache, store: toKeyvStore(cache) };
}

for (const major of [5, 6] as const satisfies readonly KeyvMajor[]) {
  describe(`toKeyvStore under Keyv ${KEYV_VERSION[major]}: what the adapter receives and stores`, () => {
    test("one serialisation: bun-cache stores Keyv's own string, read back byte for byte", async () => {
      const { cache, store } = memoryStore();
      const { store: recorded, calls } = recording(store);
      const keyv = keyvOver(major, recorded, { namespace: "app" });
      await keyv.set("k", { d: new Date(0), n: 1 });
      const set = calls.find((call) => call.method === "set")!;
      const sent = set.args[1];
      expect(typeof sent).toBe("string");
      // Keyv 5 prefixes the key itself; Keyv 6 hands the store the bare key.
      const key = major === 5 ? "app:k" : "k";
      expect(set.args[0]).toBe(key);
      expect(await cache.namespace("app").get(key)).toBe(sent as string);
      expect(await keyv.get<unknown>("k")).toEqual({
        d: "1970-01-01T00:00:00.000Z",
        n: 1,
      });
      await cache.close();
    });

    test(
      major === 5
        ? "a relative TTL in ms"
        : "an absolute expiry in epoch ms, without Keyv's bridge",
      async () => {
        const { cache, store } = memoryStore();
        const { store: recorded, calls } = recording(store);
        const keyv = keyvOver(major, recorded);
        const before = Date.now();
        await keyv.set("k", 1, 60_000);
        const sent = calls.find((call) => call.method === "set")!.args[2];
        if (major === 5) {
          expect(sent).toBe(60_000);
        } else {
          expect(sent as number).toBeGreaterThanOrEqual(before + 60_000);
          expect(sent as number).toBeLessThanOrEqual(Date.now() + 60_000);
          // Keyv 6 uses the store itself when it declares `expires`.
          expect((keyv as unknown as { store: unknown }).store).toBe(recorded);
        }
        // Keyv 5's default namespace "keyv" is a namespace view, its key prefixed.
        const entry =
          major === 5
            ? await cache.namespace("keyv").getEntry("keyv:k")
            : await cache.getEntry("k");
        expect(entry!.expiresAt! - before).toBeGreaterThan(59_000);
        expect(entry!.expiresAt! - before).toBeLessThanOrEqual(61_000);
        await cache.close();
      },
    );

    test("no TTL never expires, whatever the cache's default ttl", async () => {
      caseNumber++;
      const cache = createCache({
        driver: memoryDriver(),
        namespace: `k1-${RUN}-${caseNumber}`,
        ttl: 30,
        sweepInterval: 0,
      });
      const keyv = keyvOver(major, toKeyvStore(cache));
      await keyv.set("k", "v");
      await Bun.sleep(60);
      expect(await keyv.get<unknown>("k")).toBe("v");
      await cache.close();
    });

    test("the namespace Keyv sets after construction scopes clear()", async () => {
      const { cache, store } = memoryStore();
      const keyv = keyvOver(major, store);
      await keyv.set("before", 1);
      keyv.namespace = "late";
      await keyv.set("after", 2);
      expect(store.namespace).toBe("late");
      await keyv.clear();
      expect(await keyv.get<unknown>("after")).toBeUndefined();
      keyv.namespace = major === 5 ? "keyv" : undefined;
      expect(await keyv.get<unknown>("before")).toBe(1);
      await cache.close();
    });

    test("clear() with no namespace clears the store's own entries, never the cache's", async () => {
      const { cache } = memoryStore();
      await cache.set("mine", "kept");
      const keyv = keyvOver(
        major,
        toKeyvStore(cache, { namespace: "keyv-store" }),
        {
          namespace: undefined,
        },
      );
      await keyv.set("k", 1);
      await keyv.clear();
      expect(await keyv.get<unknown>("k")).toBeUndefined();
      expect(await cache.get("mine")).toBe("kept");
      await cache.close();
    });

    test("serialisation off: Keyv's envelope object is stored with the cache's codec, so a Date survives", async () => {
      const { cache, store } = memoryStore();
      const keyv =
        major === 5
          ? keyvOver(5, store, { serialize: undefined, deserialize: undefined })
          : keyvOver(6, store, { serialization: false });
      await keyv.set("k", { at: new Date(0) });
      expect(await keyv.get<unknown>("k")).toEqual({ at: new Date(0) });
      await cache.close();
    });

    test("a driver failure is an `error` event on Keyv and a miss, never a throw", async () => {
      caseNumber++;
      const driver = faulty(memoryDriver(), { failOn: ["get", "set"] });
      const cache = createCache({
        driver,
        namespace: `k1-${RUN}-${caseNumber}`,
        sweepInterval: 0,
      });
      const keyv = keyvOver(major, toKeyvStore(cache));
      const errors: unknown[] = [];
      keyv.on("error", (error: unknown) => errors.push(error));
      expect(await keyv.set("k", 1)).toBe(false);
      expect(await keyv.get<unknown>("k")).toBeUndefined();
      expect(errors.length).toBeGreaterThanOrEqual(2);
      await cache.close();
    });

    test("with no `error` listener on Keyv, a failure is still a miss, never a throw", async () => {
      for (const strict of [false, true]) {
        caseNumber++;
        const cache = createCache({
          driver: faulty(memoryDriver(), { failOn: ["get"] }),
          namespace: `k1-${RUN}-${caseNumber}`,
          sweepInterval: 0,
          strict,
        });
        expect(
          await keyvOver(major, toKeyvStore(cache)).get<unknown>("k"),
        ).toBeUndefined();
        await cache.close();
      }
    });

    test("cache-manager's mset/mget/mdel and ttl() through the adapter", async () => {
      const { cache, store } = memoryStore();
      const { cache: manager } = cacheManagerOver(major, store, {
        ttl: 60_000,
      });
      await manager.mset([
        { key: "a", value: 1 },
        { key: "b", value: 2, ttl: 1_000 },
      ]);
      expect(await manager.mget<unknown>(["a", "b"])).toEqual([1, 2]);
      const expires = await manager.ttl("a");
      if (major === 5) {
        expect(expires).toBeGreaterThan(Date.now() + 59_000);
      } else {
        // cache-manager 7.2.9 reads `expires` Keyv 6 no longer answers (§10.4).
        expect(expires).toBeUndefined();
      }
      await manager.mdel(["a", "b"]);
      expect(await manager.mget<unknown>(["a", "b"])).toEqual([
        undefined,
        undefined,
      ]);
      await cache.close();
    });

    test("disconnect() closes the cache", async () => {
      const { cache, store } = memoryStore();
      const keyv = keyvOver(major, store);
      await keyv.set("k", 1);
      await keyv.disconnect();
      // A closed memory cache drops what it held.
      expect(await cache.get("k")).toBeUndefined();
    });
  });
}

/**
 * `@nestjs/cache-manager` 12.0.1 builds `new Keyv({ store, ttl, namespace })`
 * from a bare store with its own `keyv` import, Keyv 5.6.0 here, as in an app
 * that follows the README's pin. No decorator syntax: `Module()` is called as
 * a function, so nothing depends on the compiler's decorator options.
 */
describe("@nestjs/cache-manager 12.0.1: CacheModule.register({ stores: [toKeyvStore(cache)] })", () => {
  /** A Nest application context with `CacheModule` over `store`. */
  async function nestApp(
    store: ReturnType<typeof toKeyvStore>,
    options: { namespace?: string } = {},
  ) {
    class AppModule {}
    Module({
      imports: [
        CacheModule.register({ stores: [store], ttl: 60_000, ...options }),
      ],
    })(AppModule);
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    return { app, manager: app.get<CacheManager>(CACHE_MANAGER) };
  }

  test("CACHE_MANAGER round-trips through bun-cache, Keyv's string stored as it is", async () => {
    const { cache, store } = memoryStore();
    const { app, manager } = await nestApp(store);
    await manager.set("user:1", { name: "Ada" });
    expect(await manager.get<unknown>("user:1")).toEqual({ name: "Ada" });
    // No module namespace: Keyv 5 gets an explicit `namespace: undefined`,
    // so the key is bare and lands in the cache's own namespace.
    expect(store.namespace).toBeUndefined();
    const stored = await cache.get("user:1");
    expect(typeof stored).toBe("string");
    expect(JSON.parse(stored as string)).toMatchObject({
      value: { name: "Ada" },
    });
    await app.close();
  });

  test("the module's namespace scopes the keys and clear()", async () => {
    const { cache, store } = memoryStore();
    await cache.set("outside", 1);
    const { app, manager } = await nestApp(store, { namespace: "nest" });
    await manager.set("k", 1);
    expect(await cache.namespace("nest").get("nest:k")).toBeDefined();
    await manager.clear();
    expect(await manager.get<unknown>("k")).toBeUndefined();
    expect(await cache.get("outside")).toBe(1);
    await app.close();
  });

  test("wrap() runs the loader once, and ttl() answers the absolute expiry", async () => {
    const { store } = memoryStore();
    const { app, manager } = await nestApp(store);
    let runs = 0;
    const loader = async () => {
      runs++;
      await Bun.sleep(5);
      return { a: 1 };
    };
    await Promise.all([
      manager.wrap("w", loader),
      manager.wrap("w", loader),
      manager.wrap("w", loader),
    ]);
    expect(runs).toBe(1);
    const expires = await manager.ttl("w");
    expect(expires).toBeGreaterThan(Date.now() + 59_000);
    await app.close();
  });

  test("closing the application disconnects the store, which closes the cache", async () => {
    const { cache, store } = memoryStore();
    const { app, manager } = await nestApp(store);
    await manager.set("k", 1);
    await app.close();
    expect(await cache.get("k")).toBeUndefined();
  });
});
