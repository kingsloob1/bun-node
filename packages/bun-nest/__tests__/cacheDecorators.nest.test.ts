/**
 * `@kingsleyweb/bun-nest/cache`: `@Cacheable`, `@CacheEvict` and `@CachePut`
 * on services (plan §10.2), through real Nest application contexts over real
 * `createCache` caches on the memory driver — keys, conditions, `unless`, the
 * single-flight, errors and `undefined`, eviction timing, named caches, how
 * a method finds its cache (and the `CacheNotReadyError`s when it cannot),
 * scoped providers, and two applications in one process.
 *
 * Method decorators are written with `@`, as an application would (this
 * directory's tsconfig enables `experimentalDecorators`); constructor
 * parameter decorators are applied by call (oven-sh/bun#28605).
 */
import type { Cache, CreateCacheOptions } from "@kingsleyweb/bun-cache";
import type { FakeClock } from "@kingsleyweb/bun-cache/testing";
import type { INestApplicationContext } from "@nestjs/common";
import { memoryDriver } from "@kingsleyweb/bun-cache";
import { fakeClock } from "@kingsleyweb/bun-cache/testing";
import { Injectable, Module, Scope, SetMetadata } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BUN_CACHE,
  BunCacheModule,
  Cacheable,
  CacheEvict,
  CacheNotReadyError,
  CachePut,
  getCacheToken,
} from "../lib/cache/index";
import "reflect-metadata";

/** Contexts to close after each test. */
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A user, as the services below load it. */
interface User {
  id: number;
  name: string;
}

/** Calls per method name, shared by a test's service. */
type Calls = Record<string, number>;

/**
 * An application context importing `BunCacheModule` (the default cache, on a
 * fake clock, plus any named ones) and providing `providers`.
 */
async function start(
  providers: (new (...args: never[]) => unknown)[],
  options: {
    names?: string[];
    cache?: Omit<CreateCacheOptions, "driver">;
    close?: boolean;
  } = {},
): Promise<{ app: INestApplicationContext; cache: Cache; clock: FakeClock }> {
  const clock = fakeClock();
  class AppModule {}
  Module({
    imports: [
      BunCacheModule.forRoot({
        driver: memoryDriver({ now: clock.now }),
        now: clock.now,
        sweepInterval: 0,
        ...options.cache,
      }),
      ...(options.names ?? []).map((name) =>
        BunCacheModule.forRoot({ name, driver: memoryDriver() }),
      ),
    ],
    providers,
  })(AppModule);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  if (options.close !== false) {
    cleanups.push(async () => {
      await app.close();
    });
  }
  return { app, cache: app.get<Cache>(BUN_CACHE), clock };
}

/** A user service whose methods count their runs. */
function usersService() {
  const calls: Calls = {};
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  class Users {
    /** The store behind the service, mutated by the update methods. */
    readonly db = new Map<number, User>([
      [1, { id: 1, name: "Ada" }],
      [2, { id: 2, name: "Bo" }],
    ]);

    @Cacheable({
      key: (id: number) => `user:${id}`,
      ttl: 60_000,
      tags: (id) => [`user:${id}`],
    })
    async find(id: number): Promise<User | undefined> {
      count("find");
      await Bun.sleep(5);
      return this.db.get(id);
    }

    @Cacheable({ key: "page:{0}:{1.size}" })
    async page(n: number, q: { size: number }): Promise<string> {
      count("page");
      return `page ${n} of ${q.size}`;
    }

    @Cacheable()
    async byDefaultKey(filter: { a: number; b: number }): Promise<number> {
      count("byDefaultKey");
      return filter.a + filter.b;
    }

    @CacheEvict({ tags: (id: number) => [`user:${id}`] })
    async rename(id: number, name: string): Promise<User> {
      count("rename");
      const user = { id, name };
      this.db.set(id, user);
      return user;
    }

    @CacheEvict({ key: (id: number) => `user:${id}` })
    async renameOrFail(id: number, name: string): Promise<void> {
      count("renameOrFail");
      this.db.set(id, { id, name });
      throw new Error("write failed after the change");
    }

    @CacheEvict({ key: "user:{0}", beforeInvocation: true })
    async evictFirst(id: number): Promise<void> {
      count("evictFirst");
      throw new Error(`failed ${id}`);
    }

    @CacheEvict({ all: true })
    async reset(): Promise<void> {
      count("reset");
    }

    @CachePut({
      key: (u: User) => `user:${u.id}`,
      tags: (u) => [`user:${u.id}`],
    })
    async save(u: User): Promise<User> {
      count("save");
      this.db.set(u.id, u);
      return { ...u };
    }
  }
  Injectable()(Users);
  return { Users, calls };
}

describe("@Cacheable", () => {
  it("caches by the key function, so a second call is a hit", async () => {
    const { Users, calls } = usersService();
    const { app, cache } = await start([Users]);
    const users = app.get(Users);
    expect(await users.find(1)).toEqual({ id: 1, name: "Ada" });
    expect(await users.find(1)).toEqual({ id: 1, name: "Ada" });
    expect(calls.find).toBe(1);
    expect(await cache.get("user:1")).toEqual({ id: 1, name: "Ada" });
    // Another key is another entry.
    expect(await users.find(2)).toEqual({ id: 2, name: "Bo" });
    expect(calls.find).toBe(2);
  });

  it("honours the ttl", async () => {
    const { Users, calls } = usersService();
    const { app, clock } = await start([Users]);
    const users = app.get(Users);
    await users.find(1);
    clock.advance(59_000);
    await users.find(1);
    expect(calls.find).toBe(1);
    clock.advance(2_000);
    await users.find(1);
    expect(calls.find).toBe(2);
  });

  it("shares one run among concurrent calls with the same key (single-flight)", async () => {
    const { Users, calls } = usersService();
    const { app } = await start([Users]);
    const users = app.get(Users);
    const results = await Promise.all(
      Array.from({ length: 20 }, async () => users.find(1)),
    );
    expect(calls.find).toBe(1);
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("builds keys from a positional template", async () => {
    const { Users, calls } = usersService();
    const { app, cache } = await start([Users]);
    const users = app.get(Users);
    expect(await users.page(3, { size: 20 })).toBe("page 3 of 20");
    expect(await users.page(3, { size: 20 })).toBe("page 3 of 20");
    expect(calls.page).toBe(1);
    expect(await cache.get("page:3:20")).toBe("page 3 of 20");
  });

  it("defaults the key to ClassName.method plus a stable hash of the arguments", async () => {
    const { Users, calls } = usersService();
    const { app } = await start([Users]);
    const users = app.get(Users);
    expect(await users.byDefaultKey({ a: 1, b: 2 })).toBe(3);
    // The same object with its keys in another order is the same key.
    expect(await users.byDefaultKey({ b: 2, a: 1 })).toBe(3);
    expect(calls.byDefaultKey).toBe(1);
    expect(await users.byDefaultKey({ a: 1, b: 3 })).toBe(4);
    expect(calls.byDefaultKey).toBe(2);
  });

  it("keeps `this`, and the method's name", async () => {
    const { Users } = usersService();
    const { app } = await start([Users]);
    const users = app.get(Users);
    users.db.set(9, { id: 9, name: "Nine" });
    expect(await users.find(9)).toEqual({ id: 9, name: "Nine" });
    expect(users.find.name).toBe("find");
  });

  it("with condition false, calls the method alone and stores nothing", async () => {
    let runs = 0;
    class Svc {
      @Cacheable({
        key: (n: number) => `n:${n}`,
        condition: (n) => n > 0,
      })
      async square(n: number): Promise<number> {
        runs++;
        return n * n;
      }
    }
    Injectable()(Svc);
    const { app, cache } = await start([Svc]);
    const svc = app.get(Svc);
    expect(await svc.square(-2)).toBe(4);
    expect(await svc.square(-2)).toBe(4);
    expect(runs).toBe(2);
    expect(await cache.has("n:-2")).toBe(false);
    expect(await svc.square(3)).toBe(9);
    expect(await svc.square(3)).toBe(9);
    expect(runs).toBe(3);
  });

  it("with unless true, returns the result to every caller sharing the run and stores nothing", async () => {
    let runs = 0;
    class Svc {
      @Cacheable({
        key: (q: string) => `search:${q}`,
        unless: (result: string[]) => result.length === 0,
      })
      async search(q: string): Promise<string[]> {
        runs++;
        await Bun.sleep(5);
        return q === "none" ? [] : [q];
      }
    }
    Injectable()(Svc);
    const { app, cache } = await start([Svc]);
    const svc = app.get(Svc);
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => svc.search("none")),
    );
    expect(runs).toBe(1);
    expect(results).toEqual(Array.from({ length: 5 }, () => []));
    expect(await cache.has("search:none")).toBe(false);
    expect(cache.stats().sets).toBe(0);
    // Not stored, so the next call runs again; a result `unless` accepts is stored.
    await svc.search("none");
    expect(runs).toBe(2);
    expect(await svc.search("x")).toEqual(["x"]);
    expect(await cache.get("search:x")).toEqual(["x"]);
  });

  it("rejects every caller sharing a failed run with its error, caches nothing, and runs again next time", async () => {
    let runs = 0;
    const boom = new Error("boom");
    class Svc {
      @Cacheable({ key: "flaky" })
      async flaky(): Promise<string> {
        runs++;
        await Bun.sleep(5);
        if (runs === 1) {
          throw boom;
        }
        return "ok";
      }
    }
    Injectable()(Svc);
    const { app, cache } = await start([Svc]);
    const svc = app.get(Svc);
    const outcomes = await Promise.allSettled([svc.flaky(), svc.flaky()]);
    expect(runs).toBe(1);
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"]);
    expect((outcomes[0] as PromiseRejectedResult).reason).toBe(boom);
    expect(await cache.has("flaky")).toBe(false);
    expect(await svc.flaky()).toBe("ok");
    expect(runs).toBe(2);
  });

  it("serves the stale value when the method fails inside staleIfError", async () => {
    let fail = false;
    class Svc {
      @Cacheable({ key: "rate", ttl: 1_000, staleIfError: 60_000 })
      async rate(): Promise<number> {
        if (fail) {
          throw new Error("upstream down");
        }
        return 42;
      }
    }
    Injectable()(Svc);
    const { app, clock } = await start([Svc]);
    const svc = app.get(Svc);
    expect(await svc.rate()).toBe(42);
    clock.advance(5_000);
    fail = true;
    expect(await svc.rate()).toBe(42);
  });

  it("does not cache undefined, unless cacheUndefined; null is a value", async () => {
    const runs = { missing: 0, negative: 0, nil: 0 };
    class Svc {
      @Cacheable({ key: "missing" })
      async missing(): Promise<string | undefined> {
        runs.missing++;
        return undefined;
      }

      @Cacheable({ key: "negative", cacheUndefined: true })
      async negative(): Promise<string | undefined> {
        runs.negative++;
        return undefined;
      }

      @Cacheable({ key: "nil" })
      async nil(): Promise<string | null> {
        runs.nil++;
        return null;
      }
    }
    Injectable()(Svc);
    const { app } = await start([Svc]);
    const svc = app.get(Svc);
    for (let i = 0; i < 2; i++) {
      expect(await svc.missing()).toBeUndefined();
      expect(await svc.negative()).toBeUndefined();
      expect(await svc.nil()).toBe(null);
    }
    expect(runs).toEqual({ missing: 2, negative: 1, nil: 1 });
  });

  it("uses the named cache given as `cache`", async () => {
    let runs = 0;
    class Svc {
      @Cacheable({ key: "report", cache: "reports" })
      async report(): Promise<string> {
        runs++;
        return "q3";
      }
    }
    Injectable()(Svc);
    const { app, cache } = await start([Svc], { names: ["reports"] });
    const svc = app.get(Svc);
    await svc.report();
    await svc.report();
    expect(runs).toBe(1);
    expect(await app.get<Cache>(getCacheToken("reports")).get("report")).toBe(
      "q3",
    );
    expect(await cache.has("report")).toBe(false);
  });

  it("copies the metadata of decorators applied before it", async () => {
    class Svc {
      @Cacheable({ key: "m" })
      @SetMetadata("role", "admin")
      async m(): Promise<number> {
        return 1;
      }
    }
    Injectable()(Svc);
    const handler = Object.getOwnPropertyDescriptor(Svc.prototype, "m")!
      .value as object;
    expect(Reflect.getMetadata("role", handler)).toBe("admin");
  });

  it("wraps a method that does not return a Promise, whose callers then get one", async () => {
    let runs = 0;
    class Svc {
      // Untyped on purpose: a sync method is a type error (plan §10.2).
      @(Cacheable({ key: "sync" }) as MethodDecorator)
      sync(): number {
        runs++;
        return 7;
      }
    }
    Injectable()(Svc);
    const { app } = await start([Svc]);
    const svc = app.get(Svc);
    const first: unknown = svc.sync();
    expect(first).toBeInstanceOf(Promise);
    expect(await first).toBe(7);
    expect(await (svc.sync() as unknown as Promise<number>)).toBe(7);
    expect(runs).toBe(1);
  });
});

describe("@CacheEvict", () => {
  it("invalidates tags after the method succeeded", async () => {
    const { Users, calls } = usersService();
    const { app } = await start([Users]);
    const users = app.get(Users);
    await users.find(1);
    await users.rename(1, "Ada L.");
    expect(await users.find(1)).toEqual({ id: 1, name: "Ada L." });
    expect(calls.find).toBe(2);
  });

  it("does not evict when the method throws", async () => {
    const { Users } = usersService();
    const { app, cache } = await start([Users]);
    const users = app.get(Users);
    await users.find(1);
    await expect(users.renameOrFail(1, "X")).rejects.toThrow(
      "write failed after the change",
    );
    expect(await cache.get("user:1")).toEqual({ id: 1, name: "Ada" });
  });

  it("with beforeInvocation, evicts before the method runs, so a throw still evicted", async () => {
    const { Users, calls } = usersService();
    const { app, cache } = await start([Users]);
    const users = app.get(Users);
    await users.find(1);
    await expect(users.evictFirst(1)).rejects.toThrow("failed 1");
    expect(calls.evictFirst).toBe(1);
    expect(await cache.has("user:1")).toBe(false);
  });

  it("with all, clears the cache's namespace", async () => {
    const { Users } = usersService();
    const { app, cache } = await start([Users]);
    const users = app.get(Users);
    await users.find(1);
    await users.page(1, { size: 5 });
    await users.reset();
    expect(await cache.has("user:1")).toBe(false);
    expect(await cache.has("page:1:5")).toBe(false);
  });

  it("with condition false, evicts nothing", async () => {
    class Svc {
      @CacheEvict({ key: "k", condition: (really: boolean) => really })
      async drop(_really: boolean): Promise<void> {}
    }
    Injectable()(Svc);
    const { app, cache } = await start([Svc]);
    await cache.set("k", 1);
    await app.get(Svc).drop(false);
    expect(await cache.get("k")).toBe(1);
    await app.get(Svc).drop(true);
    expect(await cache.has("k")).toBe(false);
  });

  it("refuses to decorate with neither key, tags nor all", () => {
    expect(() => CacheEvict({})).toThrow(/needs `key`, `tags` or `all: true`/);
  });
});

describe("@CachePut", () => {
  it("always runs the method and stores its result, with tags", async () => {
    const { Users, calls } = usersService();
    const { app, cache } = await start([Users]);
    const users = app.get(Users);
    await users.save({ id: 3, name: "Cy" });
    await users.save({ id: 3, name: "Cy" });
    expect(calls.save).toBe(2);
    expect(await cache.get("user:3")).toEqual({ id: 3, name: "Cy" });
    // A @Cacheable read of the same key is now a hit.
    expect(await users.find(3)).toEqual({ id: 3, name: "Cy" });
    expect(calls.find).toBeUndefined();
    // Its tags were stored: the eviction by tag removes it.
    await users.rename(3, "Cyd");
    expect(await cache.has("user:3")).toBe(false);
  });

  it("computes the key after the method ran, so it sees an argument the method filled in", async () => {
    class Svc {
      private next = 100;

      @CachePut({ key: (u: { id?: number; name: string }) => `user:${u.id}` })
      async create(u: { id?: number; name: string }): Promise<User> {
        u.id = this.next++;
        return { id: u.id, name: u.name };
      }
    }
    Injectable()(Svc);
    const { app, cache } = await start([Svc]);
    await app.get(Svc).create({ name: "New" });
    expect(await cache.get("user:100")).toEqual({ id: 100, name: "New" });
    expect(await cache.has("user:undefined")).toBe(false);
  });

  it("deletes the key when the method returns undefined, and leaves it when unless says so", async () => {
    class Svc {
      @CachePut({ key: "k" })
      async clearIt(): Promise<string | undefined> {
        return undefined;
      }

      @CachePut({ key: "k", unless: (r: string) => r === "draft" })
      async write(value: string): Promise<string> {
        return value;
      }
    }
    Injectable()(Svc);
    const { app, cache } = await start([Svc]);
    const svc = app.get(Svc);
    await svc.write("v1");
    expect(await cache.get("k")).toBe("v1");
    await svc.write("draft");
    expect(await cache.get("k")).toBe("v1");
    await svc.clearIt();
    expect(await cache.has("k")).toBe(false);
  });

  it("stores nothing when the method throws", async () => {
    class Svc {
      @CachePut({ key: "k" })
      async fail(): Promise<string> {
        throw new Error("nope");
      }
    }
    Injectable()(Svc);
    const { app, cache } = await start([Svc]);
    await expect(app.get(Svc).fail()).rejects.toThrow("nope");
    expect(await cache.has("k")).toBe(false);
  });
});

describe("finding the cache", () => {
  /** A service with one cached method. */
  function counter() {
    class Counter {
      runs = 0;

      @Cacheable({ key: "count" })
      async count(): Promise<number> {
        return ++this.runs;
      }

      @Cacheable({ key: "named", cache: "missing" })
      async named(): Promise<number> {
        return 1;
      }
    }
    Injectable()(Counter);
    return Counter;
  }

  it("throws CacheNotReadyError on an instance no application created", async () => {
    const Counter = counter();
    await start([Counter]);
    const error = await new Counter().count().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CacheNotReadyError);
    expect((error as CacheNotReadyError).cacheName).toBeUndefined();
    expect((error as CacheNotReadyError).method).toBe("Counter.count");
    expect((error as Error).message).toContain(
      "no initialised application created this instance",
    );
  });

  it("throws CacheNotReadyError naming a cache no module registered", async () => {
    const Counter = counter();
    const { app } = await start([Counter]);
    const error = await app
      .get(Counter)
      .named()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CacheNotReadyError);
    expect((error as CacheNotReadyError).cacheName).toBe("missing");
    expect((error as Error).message).toContain(
      'registers no cache named "missing"',
    );
  });

  it("throws CacheNotReadyError when called before the application initialised", async () => {
    const Counter = counter();
    class Warm {}
    class AppModule {}
    Module({
      imports: [BunCacheModule.forRoot({ driver: memoryDriver() })],
      providers: [
        Counter,
        {
          provide: Warm,
          inject: [Counter],
          // A factory runs while the container is built, before any hook.
          useFactory: async (c: InstanceType<typeof Counter>) => {
            await c.count();
            return new Warm();
          },
        },
      ],
    })(AppModule);
    const error = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CacheNotReadyError);
    expect((error as Error).message).toContain(
      "not from a constructor or a provider factory",
    );
  });

  it("throws CacheNotReadyError after the application closed", async () => {
    const Counter = counter();
    const { app } = await start([Counter], { close: false });
    const svc = app.get(Counter);
    expect(await svc.count()).toBe(1);
    await app.close();
    await expect(svc.count()).rejects.toThrow(CacheNotReadyError);
  });

  it("throws CacheNotReadyError for a call without its instance", async () => {
    const Counter = counter();
    const { app } = await start([Counter]);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- detached on purpose: the case under test
    const { count } = app.get(Counter);
    await expect(count()).rejects.toThrow(/called without its instance/);
  });

  it("keeps two applications' caches apart, even for one class", async () => {
    const Counter = counter();
    const first = await start([Counter]);
    const second = await start([Counter]);
    const a = first.app.get(Counter);
    const b = second.app.get(Counter);
    expect(await a.count()).toBe(1);
    expect(await a.count()).toBe(1);
    // The second application's instance runs against its own, empty cache.
    expect(await b.count()).toBe(1);
    expect(b.runs).toBe(1);
    expect(await first.cache.get("count")).toBe(1);
    expect(await second.cache.get("count")).toBe(1);
    expect(first.cache).not.toBe(second.cache);
  });

  it("finds the cache for a request-scoped provider by its class", async () => {
    let runs = 0;
    class Scoped {
      @Cacheable({ key: "scoped" })
      async value(): Promise<number> {
        return ++runs;
      }
    }
    Injectable({ scope: Scope.REQUEST })(Scoped);
    const { app, cache } = await start([Scoped]);
    const one = await app.resolve(Scoped);
    const two = await app.resolve(Scoped);
    expect(one).not.toBe(two);
    expect(await one.value()).toBe(1);
    expect(await two.value()).toBe(1);
    expect(runs).toBe(1);
    expect(await cache.get("scoped")).toBe(1);
  });

  it("refuses a request-scoped class two live applications register", async () => {
    class Scoped {
      @Cacheable({ key: "scoped" })
      async value(): Promise<number> {
        return 1;
      }
    }
    Injectable({ scope: Scope.REQUEST })(Scoped);
    const first = await start([Scoped]);
    await start([Scoped]);
    const instance = await first.app.resolve(Scoped);
    await expect(instance.value()).rejects.toThrow(
      /2 live applications register Scoped .* ambiguous/,
    );
  });

  it("refuses a static method at class definition", () => {
    expect(() => {
      class Svc {
        @Cacheable({ key: "s" })
        static async s(): Promise<number> {
          return 1;
        }
      }
      return Svc;
    }).toThrow(/only instance methods can be cached/);
  });
});
