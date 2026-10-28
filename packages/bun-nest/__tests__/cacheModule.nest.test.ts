/**
 * `@kingsleyweb/bun-nest/cache`: `BunCacheModule` (plan §10.1) — the
 * default and named caches, `forRootAsync` with injection, `isGlobal`, the
 * ownership rule on shutdown, and the misconfigurations it refuses.
 *
 * Applications are `NestFactory.createApplicationContext`s (the repo has no
 * `@nestjs/testing`; a context is what `Test.createTestingModule().compile()`
 * builds), over real `createCache` caches on the memory driver. Constructor
 * parameter decorators are applied by call — Bun reads decorator options from
 * the working directory's tsconfig (oven-sh/bun#28605).
 */
import type { Cache, CacheDriver } from "@kingsleyweb/bun-cache";
import type {
  BeforeApplicationShutdown,
  INestApplicationContext,
  OnModuleDestroy,
} from "@nestjs/common";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { Inject, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BUN_CACHE,
  BUN_CACHE_OPTIONS,
  BunCacheModule,
  getCacheToken,
  InjectCache,
} from "../lib/cache/index";
import "reflect-metadata";

/** Contexts to close after each test. */
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** Creates and initialises an application context, closed after the test. */
async function start(
  moduleClass: new () => unknown,
): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(moduleClass, {
    logger: false,
  });
  cleanups.push(async () => {
    await app.close();
  });
  return app;
}

/** A memory driver whose `close` calls are counted. */
function countingDriver(): { driver: CacheDriver; closes: () => number } {
  const driver = memoryDriver();
  let closes = 0;
  const close = driver.close.bind(driver);
  driver.close = async () => {
    closes++;
    await close();
  };
  return { driver, closes: () => closes };
}

describe("BunCacheModule.forRoot", () => {
  it("provides a working default cache under BUN_CACHE, injected by @InjectCache()", async () => {
    class Probe {
      constructor(readonly cache: Cache) {}
    }
    Injectable()(Probe);
    InjectCache()(Probe, undefined, 0);

    const options = { driver: memoryDriver(), ttl: 60_000 };
    class AppModule {}
    Module({
      imports: [BunCacheModule.forRoot(options)],
      providers: [Probe],
    })(AppModule);

    const app = await start(AppModule);
    const cache = app.get<Cache>(BUN_CACHE);
    expect(app.get(Probe).cache).toBe(cache);
    expect(getCacheToken()).toBe(BUN_CACHE);
    expect(app.get<typeof options>(BUN_CACHE_OPTIONS)).toBe(options);
    expect(await cache.set("k", { n: 1 })).toBe(true);
    expect(await cache.get("k")).toEqual({ n: 1 });
  });

  it("gives each name its own cache and token, beside the default one", async () => {
    class Probe {
      constructor(
        readonly main: Cache,
        readonly reports: Cache,
      ) {}
    }
    Injectable()(Probe);
    InjectCache()(Probe, undefined, 0);
    InjectCache("reports")(Probe, undefined, 1);

    class AppModule {}
    Module({
      imports: [
        BunCacheModule.forRoot({ driver: memoryDriver() }),
        BunCacheModule.forRoot({ name: "reports", driver: memoryDriver() }),
      ],
      providers: [Probe],
    })(AppModule);

    const app = await start(AppModule);
    const probe = app.get(Probe);
    expect(probe.main).toBe(app.get(BUN_CACHE));
    expect(probe.reports).toBe(app.get(getCacheToken("reports")));
    expect(probe.reports).not.toBe(probe.main);
    expect(getCacheToken("reports")).not.toBe(BUN_CACHE);
    // Separate stores: a write to one is not a read in the other.
    await probe.main.set("k", "main");
    expect(await probe.reports.get("k")).toBeUndefined();
  });

  it("accepts a cache made elsewhere, as `{ cache }`", async () => {
    const existing = createCache({ driver: memoryDriver() });
    class AppModule {}
    Module({ imports: [BunCacheModule.forRoot({ cache: existing })] })(
      AppModule,
    );
    const app = await start(AppModule);
    expect(app.get<Cache>(BUN_CACHE)).toBe(existing);
    await existing.close();
  });
});

describe("BunCacheModule.forRootAsync", () => {
  it("builds the options with injected providers from its imports, sync or async", async () => {
    class Config {
      readonly ttl = 1_234;
    }
    class ConfigModule {}
    Module({ providers: [Config], exports: [Config] })(ConfigModule);

    const seen: number[] = [];
    class AppModule {}
    Module({
      imports: [
        BunCacheModule.forRootAsync({
          imports: [ConfigModule],
          inject: [Config],
          useFactory: (config: Config) => {
            seen.push(config.ttl);
            return { driver: memoryDriver(), ttl: config.ttl };
          },
        }),
        BunCacheModule.forRootAsync({
          name: "reports",
          imports: [ConfigModule],
          inject: [Config],
          useFactory: async (config: Config) => {
            await Bun.sleep(1);
            seen.push(config.ttl * 2);
            return { driver: memoryDriver(), ttl: config.ttl * 2 };
          },
        }),
      ],
    })(AppModule);

    const app = await start(AppModule);
    expect(seen.sort()).toEqual([1_234, 2_468]);
    const main = app.get<Cache>(BUN_CACHE);
    const reports = app.get<Cache>(getCacheToken("reports"));
    expect(main).not.toBe(reports);
    expect(app.get(BUN_CACHE_OPTIONS)).toMatchObject({ ttl: 1_234 });
    // The TTL reached createCache: the entry's freshness is ttl long.
    await reports.set("k", 1);
    const entry = await reports.getEntry("k");
    expect(entry!.freshUntil! - entry!.createdAt).toBe(2_468);
  });

  it("accepts `{ cache }` from the factory too, and never closes it", async () => {
    const { driver, closes } = countingDriver();
    const existing = createCache({ driver });
    class AppModule {}
    Module({
      imports: [
        BunCacheModule.forRootAsync({
          useFactory: () => ({ cache: existing }),
        }),
      ],
    })(AppModule);
    const app = await start(AppModule);
    expect(app.get<Cache>(BUN_CACHE)).toBe(existing);
    await app.close();
    expect(closes()).toBe(0);
    await existing.close();
    expect(closes()).toBe(1);
  });
});

describe("isGlobal", () => {
  /** A feature module whose provider injects the default cache, importing nothing. */
  function featureModule() {
    class Consumer {
      constructor(readonly cache: Cache) {}
    }
    Injectable()(Consumer);
    InjectCache()(Consumer, undefined, 0);
    class FeatureModule {}
    Module({ providers: [Consumer] })(FeatureModule);
    return { Consumer, FeatureModule };
  }

  it("makes the cache injectable in modules that do not import it", async () => {
    const { Consumer, FeatureModule } = featureModule();
    class AppModule {}
    Module({
      imports: [
        BunCacheModule.forRoot({ driver: memoryDriver(), isGlobal: true }),
        FeatureModule,
      ],
    })(AppModule);
    const app = await start(AppModule);
    expect(app.get(Consumer).cache).toBe(app.get(BUN_CACHE));
  });

  it("without it, a module that does not import it cannot inject it (the control)", async () => {
    const { FeatureModule } = featureModule();
    class AppModule {}
    Module({
      imports: [
        BunCacheModule.forRoot({ driver: memoryDriver() }),
        FeatureModule,
      ],
    })(AppModule);
    await expect(
      NestFactory.createApplicationContext(AppModule, {
        logger: false,
        abortOnError: false,
      }),
    ).rejects.toThrow(/resolve dependencies of the Consumer/);
  });
});

describe("shutdown: the ownership rule", () => {
  it("closes a cache it created at application shutdown, after the destroy and before-shutdown hooks", async () => {
    const { driver, closes } = countingDriver();
    const seen: string[] = [];
    class Witness implements OnModuleDestroy, BeforeApplicationShutdown {
      constructor(readonly cache: Cache) {}
      async onModuleDestroy() {
        seen.push(`destroy:closes=${closes()}`);
        // Still usable here: the cache closes later.
        seen.push(`destroy:set=${String(await this.cache.set("k", 1))}`);
      }
      beforeApplicationShutdown() {
        seen.push(`before-shutdown:closes=${closes()}`);
      }
    }
    Injectable()(Witness);
    InjectCache()(Witness, undefined, 0);

    class AppModule {}
    Module({
      imports: [BunCacheModule.forRoot({ driver, isGlobal: true })],
      providers: [Witness],
    })(AppModule);
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    await app.close();
    expect(seen).toEqual([
      "destroy:closes=0",
      "destroy:set=true",
      "before-shutdown:closes=0",
    ]);
    expect(closes()).toBe(1);
  });

  it("never closes a cache passed in as `{ cache }`", async () => {
    const { driver, closes } = countingDriver();
    const existing = createCache({ driver });
    class AppModule {}
    Module({ imports: [BunCacheModule.forRoot({ cache: existing })] })(
      AppModule,
    );
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    await app.close();
    expect(closes()).toBe(0);
    // Still the caller's to use and close.
    expect(await existing.set("k", 1)).toBe(true);
    await existing.close();
    expect(closes()).toBe(1);
  });

  it("closes each owned named cache once", async () => {
    const a = countingDriver();
    const b = countingDriver();
    class AppModule {}
    Module({
      imports: [
        BunCacheModule.forRoot({ driver: a.driver }),
        BunCacheModule.forRootAsync({
          name: "b",
          useFactory: () => ({ driver: b.driver }),
        }),
      ],
    })(AppModule);
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    await app.close();
    expect([a.closes(), b.closes()]).toEqual([1, 1]);
  });
});

describe("misconfiguration", () => {
  it("refuses an empty name", () => {
    expect(() =>
      BunCacheModule.forRoot({ name: "", driver: memoryDriver() }),
    ).toThrow(/non-empty string/);
    expect(() =>
      BunCacheModule.forRootAsync({
        name: "",
        useFactory: () => ({ driver: memoryDriver() }),
      }),
    ).toThrow(/non-empty string/);
  });

  it("refuses options with neither a driver nor a cache, and with both", async () => {
    for (const [source, message] of [
      [{}, /need a `driver`/],
      [
        {
          cache: createCache({ driver: memoryDriver() }),
          driver: memoryDriver(),
        },
        /not both/,
      ],
    ] as const) {
      class AppModule {}
      Module({
        imports: [
          BunCacheModule.forRootAsync({
            useFactory: () => source as never,
          }),
        ],
      })(AppModule);
      await expect(
        NestFactory.createApplicationContext(AppModule, {
          logger: false,
          abortOnError: false,
        }),
      ).rejects.toThrow(message);
    }
  });

  it("refuses two caches under one name in one application", async () => {
    class AppModule {}
    Module({
      imports: [
        BunCacheModule.forRoot({ name: "dup", driver: memoryDriver() }),
        BunCacheModule.forRootAsync({
          name: "dup",
          useFactory: () => ({ driver: memoryDriver() }),
        }),
      ],
    })(AppModule);
    await expect(
      NestFactory.createApplicationContext(AppModule, {
        logger: false,
        abortOnError: false,
      }),
    ).rejects.toThrow(/two modules register the "dup" cache/);
  });
});

describe("tokens", () => {
  it("are registered symbols, stable across calls and copies", () => {
    expect(getCacheToken("x")).toBe(getCacheToken("x"));
    expect(getCacheToken("x")).not.toBe(getCacheToken("y"));
    expect(Symbol.keyFor(BUN_CACHE)).toBe("@kingsleyweb/bun-nest/cache");
    expect(Symbol.keyFor(getCacheToken("x"))).toBe(
      "@kingsleyweb/bun-nest/cache:named:x",
    );
  });

  it("are injectable by token, without the decorator", async () => {
    class Probe {
      constructor(readonly reports: Cache) {}
    }
    Injectable()(Probe);
    Inject(getCacheToken("reports"))(Probe, undefined, 0);
    class AppModule {}
    Module({
      imports: [
        BunCacheModule.forRoot({ name: "reports", driver: memoryDriver() }),
      ],
      providers: [Probe],
    })(AppModule);
    const app = await start(AppModule);
    expect(app.get(Probe).reports).toBe(app.get(getCacheToken("reports")));
  });
});
