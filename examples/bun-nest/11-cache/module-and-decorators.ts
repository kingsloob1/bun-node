/**
 * `BunCacheModule` and the caching decorators from `@kingsleyweb/bun-nest/cache`,
 * asserted: two caches in one application, `@Cacheable` (one run for many
 * callers), `@CacheEvict` by tag, `@CachePut` keyed by an id the method
 * assigns, `unless`, a template key, `CacheNotReadyError`, and who closes
 * which cache at shutdown.
 *
 * ```bash
 * cd examples/bun-nest && bun 11-cache/module-and-decorators.ts
 * ```
 *
 * Worth knowing:
 *
 * - **The cache is found through the application.** A decorated method
 *   looks its cache up from `this`, so it works only on an instance Nest
 *   created, after the application initialised. Anywhere else it throws
 *   `CacheNotReadyError`.
 * - **A module owns the cache it creates.** `forRoot({ driver, ... })` builds
 *   the cache and closes it at `onApplicationShutdown`; `{ cache }` is a
 *   cache made elsewhere, and is never closed by the module.
 * - **Keys.** A `key` function is checked against the method's parameters;
 *   a template (`"page:{0}:{1.size}"`) reads positional arguments; with
 *   neither, the key is `ClassName.method:` and a hash of the arguments.
 * - Constructor parameter decorators (`@InjectCache()`) need
 *   `emitDecoratorMetadata`, which Bun reads from the **working directory's**
 *   `tsconfig.json` (oven-sh/bun#28605): run this from `examples/bun-nest`.
 * - The classes are declared before the first top-level `await`, so no
 *   `await` sits between decorator evaluations.
 *
 * Each check below is asserted with `shared/check.ts`; a failed one fails the
 * script.
 */
import type { Cache, CacheDriver } from "@kingsleyweb/bun-cache";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import {
  BUN_CACHE,
  BunCacheModule,
  Cacheable,
  CacheEvict,
  CacheNotReadyError,
  CachePut,
  getCacheToken,
  InjectCache,
} from "@kingsleyweb/bun-nest/cache";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title } from "../shared/console";
import "reflect-metadata";

/** A user, as the service's pretend database keeps it. */
interface User {
  /** The id the database assigned. */
  id: number;
  /** The user's name. */
  name: string;
}

/** A user not yet saved: `create` fills in its `id`. */
interface Draft {
  /** Assigned by `create`; absent until then. */
  id?: number;
  /** The user's name. */
  name: string;
}

/** A driver and how many times it was closed. */
interface CountedDriver {
  /** The memory driver, with `close` counting its calls. */
  driver: CacheDriver;
  /** How many times `driver.close()` has been called. */
  closes: () => number;
}

/** A memory driver whose `close` calls are counted, to see who closes what. */
function countedDriver(): CountedDriver {
  const driver = memoryDriver();
  const realClose = driver.close.bind(driver);
  let closes = 0;
  driver.close = async () => {
    closes++;
    await realClose();
  };
  return { driver, closes: () => closes };
}

/** What the reports cache's factory reads, injected into `useFactory`. */
@Injectable()
class ReportsConfig {
  /** How long a report stays cached, in milliseconds. */
  readonly ttl = 30_000;
}

/** Provides {@link ReportsConfig} to the module that builds the reports cache. */
@Module({ providers: [ReportsConfig], exports: [ReportsConfig] })
class ConfigModule {}

/** The drivers behind the two caches, so the shutdown check can count closes. */
const owned = countedDriver();
const external = countedDriver();

/** The cache the reports module is handed: made here, so the module never owns it. */
let externalCache: Cache | undefined;

/** Every call the pretend database served, to see what the cache saved. */
const calls = { find: 0, search: 0, page: 0 };

/** A service whose methods are cached. It has no constructor: it uses the default cache. */
@Injectable()
class UsersService {
  /** The pretend database. */
  readonly db = new Map<number, User>([[1, { id: 1, name: "Ada" }]]);
  /** The last id handed out. */
  private lastId = 1;

  /** Cached by user, tagged by user so an update can drop it. */
  @Cacheable({
    key: (id: number) => `user:${id}`,
    tags: (id) => [`user:${id}`],
  })
  async findUser(id: number): Promise<User> {
    calls.find++;
    await Bun.sleep(20);
    const user = this.db.get(id);
    if (!user) {
      throw new Error(`no user ${id}`);
    }
    return { ...user };
  }

  /** Changes the user, then drops every entry tagged with it. */
  @CacheEvict({ tags: (id: number) => [`user:${id}`] })
  updateUser(id: number, name: string): Promise<User> {
    const user = this.db.get(id);
    if (!user) {
      return Promise.reject(new Error(`no user ${id}`));
    }
    user.name = name;
    return Promise.resolve({ ...user });
  }

  /** Always runs; stores the result under the id it just assigned. */
  @CachePut({
    key: (draft: Draft) => `user:${draft.id}`,
    tags: (draft) => [`user:${draft.id}`],
  })
  create(draft: Draft): Promise<User> {
    this.lastId++;
    draft.id = this.lastId;
    const user = { id: this.lastId, name: draft.name };
    this.db.set(user.id, user);
    return Promise.resolve({ ...user });
  }

  /** An empty result is returned but not stored. */
  @Cacheable({
    key: (term: string) => `search:${term}`,
    unless: (found: string[]) => found.length === 0,
  })
  search(term: string): Promise<string[]> {
    calls.search++;
    return Promise.resolve(term === "none" ? [] : [term, `${term}!`]);
  }

  /** A template key: `{0}` is the page, `{1.size}` the options' `size`. */
  @Cacheable({ key: "page:{0}:{1.size}" })
  page(n: number, options: { size: number }): Promise<string> {
    calls.page++;
    return Promise.resolve(`page ${n} of ${options.size}`);
  }
}

/** A provider that injects both caches by decorator. */
@Injectable()
class ReportsService {
  constructor(
    /** The default (unnamed) cache. */
    @InjectCache() readonly main: Cache,
    /** The cache registered as "reports". */
    @InjectCache("reports") readonly reports: Cache,
  ) {}
}

@Module({
  imports: [
    // Global, so UsersService and ReportsService inject it without importing.
    // The module creates this cache from the options, so it owns it.
    BunCacheModule.forRoot({
      driver: owned.driver,
      ttl: 60_000,
      isGlobal: true,
    }),
    // A named cache from a factory with injection. It returns `{ cache }`,
    // a cache made here, which the module never closes.
    BunCacheModule.forRootAsync({
      name: "reports",
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ReportsConfig],
      useFactory: (config: ReportsConfig) => {
        externalCache = createCache({
          driver: external.driver,
          ttl: config.ttl,
        });
        return { cache: externalCache };
      },
    }),
  ],
  providers: [UsersService, ReportsService],
})
class AppModule {}

title("BunCacheModule and the caching decorators");

/* ------------------------------------------------------------------ */
step("Before the application starts: a decorated method has no cache");

await checkRejects(
  "new UsersService().findUser(1)",
  () => new UsersService().findUser(1),
  { name: "CacheNotReadyError" },
).then((error) => {
  check(
    "the error names the default cache (cacheName undefined) and the method",
    error instanceof CacheNotReadyError &&
      error.cacheName === undefined &&
      error.method === "UsersService.findUser",
    error,
  );
});

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: false,
});
const users = app.get(UsersService);
const reports = app.get(ReportsService);
const main = app.get<Cache>(BUN_CACHE);

/* ------------------------------------------------------------------ */
step("Two caches, injected by name");

check(
  "@InjectCache() and @InjectCache('reports') are different caches",
  reports.main !== reports.reports,
);
check("@InjectCache() is the BUN_CACHE one", reports.main === main);
check(
  "app.get(getCacheToken('reports')) is the second",
  app.get(getCacheToken("reports")) === reports.reports,
);
check(
  "the reports cache is the one the factory made",
  reports.reports === externalCache,
);
await main.set("shared", 1);
checkEqual(
  "a key set in one is absent from the other",
  [await reports.main.has("shared"), await reports.reports.has("shared")],
  [true, false],
);

/* ------------------------------------------------------------------ */
step("@Cacheable: one run for repeated and for concurrent calls");

await users.findUser(1);
await users.findUser(1);
checkEqual("two sequential calls ran the method once", calls.find, 1);

await users.updateUser(1, "Ada L.");
calls.find = 0;
const crowd = await Promise.all(
  Array.from({ length: 10 }, () => users.findUser(1)),
);
checkEqual("ten concurrent calls ran the method once", calls.find, 1);
check(
  "every caller got the same value",
  crowd.every((user) => user.name === "Ada L."),
  crowd,
);

/* ------------------------------------------------------------------ */
step("@CacheEvict by tag: the next read runs the method again");

calls.find = 0;
await users.updateUser(1, "Ada Lovelace");
check("the eviction dropped the entry", !(await main.has("user:1")));
const afterUpdate = await users.findUser(1);
checkEqual("the next find ran the method", calls.find, 1);
checkEqual("and saw the new value", afterUpdate.name, "Ada Lovelace");

/* ------------------------------------------------------------------ */
step("@CachePut: keyed by an id the method assigns");

calls.find = 0;
const draft: Draft = { name: "Grace" };
const created = await users.create(draft);
checkEqual("create assigned an id", created.id, 2);
check("the entry is stored under that id", await main.has("user:2"));
const found = await users.findUser(2);
checkEqual("a following find is a hit (the method did not run)", calls.find, 0);
checkEqual("and holds the created user", found, { id: 2, name: "Grace" });

/* ------------------------------------------------------------------ */
step("unless: returned, not stored");

const empty = await users.search("none");
checkEqual("the empty result is returned", empty, []);
check("but not stored", !(await main.has("search:none")));
await users.search("ada");
check("a non-empty result is stored", await main.has("search:ada"));
await users.search("none");
checkEqual(
  "the refused one ran again, the stored one did not",
  calls.search,
  3,
);

/* ------------------------------------------------------------------ */
step("A template key");

await users.page(3, { size: 20 });
await users.page(3, { size: 20 });
checkEqual("the second call was a hit", calls.page, 1);
checkEqual(
  "cache.get('page:3:20') holds the value",
  await main.get("page:3:20"),
  "page 3 of 20",
);

/* ------------------------------------------------------------------ */
step("Shutdown: the owned cache closes, the passed-in one does not");

checkEqual(
  "nothing is closed while the application runs",
  [owned.closes(), external.closes()],
  [0, 0],
);
await app.close();
checkEqual(
  "after close(): the module's own cache closed once, the passed-in one never",
  [owned.closes(), external.closes()],
  [1, 0],
);
await externalCache?.set("after-close", "still works");
checkEqual(
  "the passed-in cache is still usable",
  await externalCache?.get("after-close"),
  "still works",
);
await externalCache?.close();
checkEqual("its maker closes it", external.closes(), 1);

await checkRejects("a call after close", () => users.findUser(1), {
  name: "CacheNotReadyError",
});

summary();
