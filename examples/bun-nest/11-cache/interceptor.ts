/**
 * `BunCacheInterceptor` and its decorators from `@kingsleyweb/bun-nest/cache`,
 * asserted: a cached `GET` (`MISS` then `HIT`, the handler run once, an
 * `ETag` and a `304`, a `POST` dropping the entry), a route behind a guard,
 * `@CacheKey`, `@CacheTags` with `cache.invalidateTags()`, `@NoCache`, a
 * named cache with `varyBy` through `BunCacheInterceptor.with()`, the TTL
 * fallback, exceptions never stored, and stale-while-revalidate.
 *
 * ```bash
 * cd examples/bun-nest && bun 11-cache/interceptor.ts
 * ```
 *
 * Worth knowing:
 *
 * - **It runs after the guards.** Router middleware (`cacheResponse()` on the
 *   adapter) runs before Nest's guards, so a cached answer could reach a
 *   caller the guard would refuse. The interceptor runs after them: a refused
 *   request gets its 403 whether or not the route is cached.
 * - **A hit skips the handler**, the pipes, and any interceptor inside this
 *   one. It is the same cache as on a router, so `X-Cache`, `Age`, `ETag`
 *   and the `304` are `cacheResponse()`'s.
 * - **The write is not waited for.** A miss answers first and stores
 *   afterwards, so each check below awaits the cache's `set` event before the
 *   request that should hit.
 * - **The lifetime.** `@CacheTTL(ms)` wins over every freshness header.
 *   Without it the response's own `Cache-Control`/`Expires` lifetime is used,
 *   else the cache's own `ttl`. `private` and `no-store` are never stored,
 *   and neither is anything but a 200, 203 or 204, so no exception's answer.
 * - **Only `GET`** is cached. A `POST` that answers 2xx drops its path.
 * - Method decorators are written with `@`, which needs the working
 *   directory's `tsconfig.json` (Bun reads the decorator options from it,
 *   oven-sh/bun#28605): run this from `examples/bun-nest`. No top-level
 *   `await` sits between the classes' decorators: the one before them (the
 *   optional `@nestjs/cache-manager` import) finishes first.
 * - `@nestjs/cache-manager`'s own `@CacheKey()` and `@CacheTTL()` are read
 *   too when ours are absent. That package is not a dependency of this
 *   repository, so those checks run only where it resolves, and print a line
 *   starting `skipped:` where it does not.
 *
 * Each check below is asserted with `shared/check.ts`; a failed one fails the
 * script.
 */
import type { Cache } from "@kingsleyweb/bun-cache";
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from "@nestjs/common";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  BUN_CACHE,
  BunCacheInterceptor,
  BunCacheModule,
  CacheKey,
  CacheTags,
  CacheTTL,
  getCacheToken,
  NoCache,
} from "@kingsleyweb/bun-nest/cache";
import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Injectable,
  Module,
  NotFoundException,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

/**
 * `@nestjs/cache-manager`, where it resolves. Imported through a variable so
 * the type checker does not need it installed.
 */
const CACHE_MANAGER = "@nestjs/cache-manager";
const cacheManager = (await import(CACHE_MANAGER).catch(() => undefined)) as
  | {
      /** Its `@CacheKey()`. */
      CacheKey: (key: string) => MethodDecorator;
      /** Its `@CacheTTL()`, in ms. */
      CacheTTL: (ttl: number) => MethodDecorator;
    }
  | undefined;

/** Applies `@nestjs/cache-manager`'s decorator when there is one, else nothing. */
const fromCacheManager = (
  make: (lib: NonNullable<typeof cacheManager>) => MethodDecorator,
): MethodDecorator =>
  cacheManager === undefined ? () => undefined : make(cacheManager);

/** Handler runs per route, to see what the cache saved. */
const runs: Record<string, number> = {};

/** Counts a run of `name` and answers the count. */
function run(name: string): number {
  runs[name] = (runs[name] ?? 0) + 1;
  return runs[name];
}

/** The header the guard wants; a request without it is refused. */
const TOKEN = "let-me-in";

/** Lets a request through only when it sends `x-token: let-me-in`. */
@Injectable()
class TokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      /** The request's headers, lower-cased. */
      headers: Record<string, string | undefined>;
    }>();
    if (req.headers["x-token"] !== TOKEN) {
      throw new ForbiddenException("no token");
    }
    return true;
  }
}

/** Every route here is cached by the interceptor, applied to the class. */
@Controller("posts")
@UseInterceptors(BunCacheInterceptor)
@CacheTTL(30_000)
class PostsController {
  /** Cached under the URL: the query is part of the key. */
  @Get()
  list(@Query("page") page?: string) {
    return { run: run("list"), page: page ?? null };
  }

  /** Stored under its own key, and under the tag `posts` as well. */
  @Get("tagged")
  @CacheTags("posts")
  tagged() {
    return { run: run("tagged") };
  }

  /** One key for every query string: `@CacheKey` replaces the URL. */
  @Get("one-key")
  @CacheKey("posts:one-key")
  oneKey(@Query("n") n?: string) {
    return { run: run("oneKey"), n: n ?? null };
  }

  /** Left out of the interceptor: no read, no store, no `X-Cache`. */
  @Get("live")
  @NoCache()
  live() {
    return { run: run("live") };
  }

  /** Drops the path `POST /posts` was sent to, i.e. `list`'s. */
  @Post()
  create() {
    return { created: true };
  }

  /** An exception: the 404 is answered, never stored. */
  @Get("missing")
  missing() {
    run("missing");
    throw new NotFoundException("no such post");
  }
}

/** Behind a guard, and cached: the guard runs first. */
@Controller("private-posts")
@UseGuards(TokenGuard)
@UseInterceptors(BunCacheInterceptor)
@CacheTTL(30_000)
class GuardedController {
  /** Cached after the guard let a request through. */
  @Get()
  list() {
    return { run: run("guarded") };
  }
}

/** The cache's own `ttl` is 400 ms; routes say nothing, or say something. */
@Controller("ttl")
@UseInterceptors(BunCacheInterceptor)
class TtlController {
  /** No `@CacheTTL`, no `Cache-Control`: the cache's own `ttl` applies. */
  @Get("bare")
  bare() {
    return { run: run("bare") };
  }

  /** The response's own lifetime (60 s) wins over the cache's 400 ms. */
  @Get("declared")
  @Header("Cache-Control", "max-age=60")
  declared() {
    return { run: run("declared") };
  }

  /** `private` is refused for a shared cache, whatever the cache's `ttl`. */
  @Get("private")
  @Header("Cache-Control", "private, max-age=60")
  privateRoute() {
    return { run: run("private") };
  }

  /** `@nestjs/cache-manager`'s key and TTL (100 ms), when it resolves. */
  @Get("cache-manager")
  @fromCacheManager((lib) => lib.CacheKey("cm-key"))
  @fromCacheManager((lib) => lib.CacheTTL(100))
  fromCacheManager(@Query("n") n?: string) {
    return { run: run("cacheManager"), n: n ?? null };
  }
}

/** A named cache, `varyBy` the language: the interceptor made with `with()`. */
@Controller("pages")
@UseInterceptors(
  BunCacheInterceptor.with({ cache: "pages", varyBy: ["accept-language"] }),
)
@CacheTTL(30_000)
class PagesController {
  /** One entry per `Accept-Language`. */
  @Get()
  home() {
    return { run: run("pages") };
  }
}

/** A short `@CacheTTL` (300 ms), and a stale answer allowed while a replay refreshes it. */
@Controller("news")
@UseInterceptors(BunCacheInterceptor.with({ staleWhileRevalidate: 60_000 }))
@CacheTTL(300)
class NewsController {
  /** Fresh for 300 ms, then `STALE` while the adapter replays it. */
  @Get()
  latest() {
    return { run: run("news") };
  }
}

/** The caches the application registers, kept to count their writes. */
const defaultCache = createCache({
  driver: memoryDriver(),
  ttl: 400,
  sweepInterval: 0,
});
/** How many entries the default cache has stored, to see what a named cache kept off it. */
let defaultSets = 0;
defaultCache.on("set", () => {
  defaultSets++;
});
const pagesCache = createCache({
  driver: memoryDriver(),
  sweepInterval: 0,
});

@Module({
  imports: [
    // A cache made here is passed in, so the module never closes it.
    BunCacheModule.forRoot({ cache: defaultCache, isGlobal: true }),
    BunCacheModule.forRoot({ name: "pages", cache: pagesCache }),
  ],
  controllers: [
    PostsController,
    GuardedController,
    TtlController,
    PagesController,
    NewsController,
  ],
})
class AppModule {}

/** One answer: status, `X-Cache`, and the JSON body. */
interface Answer {
  /** The status. */
  status: number;
  /** The `X-Cache` header, or `null` when there is none. */
  xCache: string | null;
  /** The parsed body. */
  body: unknown;
  /** The response's headers. */
  headers: Headers;
}

title("BunCacheInterceptor and its decorators");

const app: INestApplication = await NestFactory.create(
  AppModule,
  new BunHttpAdapter(0),
  { logger: false },
);
await app.listen(0);
const base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
show("listening on", base);
check(
  "the default cache is the one registered",
  app.get<Cache>(BUN_CACHE) === defaultCache &&
    app.get<Cache>(getCacheToken("pages")) === pagesCache,
);

/** Calls the served application. */
async function call(path: string, init?: RequestInit): Promise<Answer> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: keep the text.
  }
  return {
    status: response.status,
    xCache: response.headers.get("x-cache"),
    body,
    headers: response.headers,
  };
}

/** Resolves with the next `set` on `cache`: a miss answers before it stores. */
function nextSet(cache: Cache): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = cache.on("set", () => {
      clearTimeout(timer);
      off();
      resolve();
    });
    timer = setTimeout(() => {
      off();
      reject(new Error("Timed out waiting for the cache to store an entry"));
    }, 2000);
  });
}

/** Calls `path`, waiting for the write a miss makes before answering. */
async function callStored(
  cache: Cache,
  path: string,
  init?: RequestInit,
): Promise<Answer> {
  const written = nextSet(cache);
  const answer = await call(path, init);
  if (answer.xCache === "MISS") {
    await written;
  } else {
    // Nothing is stored: stop the listener (it rejects, unhandled otherwise).
    written.catch(() => undefined);
  }
  return answer;
}

/* ------------------------------------------------------------------ */
step("A cached GET: MISS, then HIT with the handler run once");

const first = await callStored(defaultCache, "/posts");
show("first", first.body);
checkEqual("the first is a MISS", first.xCache, "MISS");
const second = await call("/posts");
checkEqual("the second is a HIT", second.xCache, "HIT");
checkEqual("with the stored body", second.body, { run: 1, page: null });
checkEqual("the handler ran once", runs.list, 1);
check("a HIT carries an Age", second.headers.get("age") !== null);

const other = await callStored(defaultCache, "/posts?page=2");
checkEqual("another query string is another entry", other.xCache, "MISS");

/* ------------------------------------------------------------------ */
step("ETag and 304");

const etag = second.headers.get("etag");
check("the stored answer has an ETag", etag !== null && etag !== "", etag);
const notModified = await call("/posts", {
  headers: { "if-none-match": etag ?? "" },
});
checkEqual("If-None-Match answers 304", notModified.status, 304);
checkEqual("without running the handler", runs.list, 2);

/* ------------------------------------------------------------------ */
step("A POST drops the cached GET of its path");

const created = await call("/posts", { method: "POST" });
checkEqual("the POST answers 201", created.status, 201);
// Measured: a GET sent at once after the POST misses and its entry is not
// kept (the write lands in the invalidation's own moment and is fenced out),
// so a few ms pass first. A real client's next request is never that close.
await Bun.sleep(20);
const afterPost = await callStored(defaultCache, "/posts");
checkEqual("the next GET is a MISS", afterPost.xCache, "MISS");
checkEqual("and ran the handler again", runs.list, 3);

/* ------------------------------------------------------------------ */
step("@CacheKey: one entry for every query string");

const k1 = await callStored(defaultCache, "/posts/one-key?n=1");
checkEqual("first", k1.xCache, "MISS");
const k2 = await call("/posts/one-key?n=2");
checkEqual("another query string is a HIT", k2.xCache, "HIT");
checkEqual("and holds the first answer", k2.body, { run: 1, n: "1" });

/* ------------------------------------------------------------------ */
step("@CacheTags: cache.invalidateTags() drops the route");

await callStored(defaultCache, "/posts/tagged");
checkEqual("stored", (await call("/posts/tagged")).xCache, "HIT");
await defaultCache.invalidateTags(["posts"]);
// As after the POST above: a few ms, so the next entry is not fenced out.
await Bun.sleep(20);
const afterTag = await callStored(defaultCache, "/posts/tagged");
checkEqual("after invalidateTags(['posts']): MISS", afterTag.xCache, "MISS");
checkEqual("and the handler ran again", runs.tagged, 2);
check(
  "a route without the tag was not dropped",
  (await call("/posts/one-key?n=3")).xCache === "HIT",
);

/* ------------------------------------------------------------------ */
step("@NoCache: one route of a cached controller left out");

const live1 = await call("/posts/live");
const live2 = await call("/posts/live");
checkEqual("no X-Cache header", [live1.xCache, live2.xCache], [null, null]);
checkEqual("the handler ran every time", runs.live, 2);

/* ------------------------------------------------------------------ */
step("Exceptions are never stored");

const missing1 = await call("/posts/missing");
const missing2 = await call("/posts/missing");
checkEqual("a 404 both times", [missing1.status, missing2.status], [404, 404]);
check(
  "neither is a HIT",
  missing1.xCache !== "HIT" && missing2.xCache !== "HIT",
  [missing1.xCache, missing2.xCache],
);
checkEqual("the handler ran both times", runs.missing, 2);

/* ------------------------------------------------------------------ */
step("A guard in front: it runs before the interceptor");

const refused = await call("/private-posts");
checkEqual("without the token: 403", refused.status, 403);
const allowed = await callStored(defaultCache, "/private-posts", {
  headers: { "x-token": TOKEN },
});
checkEqual(
  "with the token: a MISS",
  [allowed.status, allowed.xCache],
  [200, "MISS"],
);
checkEqual(
  "with the token again: a HIT",
  (await call("/private-posts", { headers: { "x-token": TOKEN } })).xCache,
  "HIT",
);
const refusedAgain = await call("/private-posts");
checkEqual(
  "the entry is stored, yet a request without the token is still 403",
  refusedAgain.status,
  403,
);
checkEqual("the handler ran once", runs.guarded, 1);

/* ------------------------------------------------------------------ */
step("No @CacheTTL: the response's lifetime, else the cache's ttl (400 ms)");

await callStored(defaultCache, "/ttl/bare");
await callStored(defaultCache, "/ttl/declared");
checkEqual(
  "both are HITs while fresh",
  [(await call("/ttl/bare")).xCache, (await call("/ttl/declared")).xCache],
  ["HIT", "HIT"],
);
await Bun.sleep(600);
const bareLater = await callStored(defaultCache, "/ttl/bare");
const declaredLater = await call("/ttl/declared");
checkEqual(
  "after 600 ms the bare route (cache ttl 400 ms) is a MISS",
  bareLater.xCache,
  "MISS",
);
checkEqual(
  "and the one with max-age=60 is still a HIT",
  declaredLater.xCache,
  "HIT",
);
const private1 = await call("/ttl/private");
const private2 = await call("/ttl/private");
check(
  "private is never stored",
  private1.xCache !== "HIT" && private2.xCache !== "HIT",
  [private1.xCache, private2.xCache],
);
checkEqual("so the handler ran every time", runs.private, 2);

/* ------------------------------------------------------------------ */
step("@nestjs/cache-manager's @CacheKey and @CacheTTL");

if (cacheManager === undefined) {
  show(
    "skipped: @nestjs/cache-manager is not installed; 3 checks skipped (its key and TTL on a route this interceptor caches)",
  );
} else {
  await callStored(defaultCache, "/ttl/cache-manager?n=1");
  const sameKey = await call("/ttl/cache-manager?n=2");
  checkEqual(
    "its @CacheKey is the key: another query string is a HIT",
    sameKey.xCache,
    "HIT",
  );
  checkEqual("with the first answer", sameKey.body, { run: 1, n: "1" });
  await Bun.sleep(300);
  checkEqual(
    "its @CacheTTL (100 ms) has expired the entry",
    (await call("/ttl/cache-manager?n=3")).xCache,
    "MISS",
  );
}

/* ------------------------------------------------------------------ */
step("A named cache, varyBy accept-language");

const defaultSetsBefore = defaultSets;
const en = await callStored(pagesCache, "/pages", {
  headers: { "accept-language": "en" },
});
const fr = await callStored(pagesCache, "/pages", {
  headers: { "accept-language": "fr" },
});
checkEqual(
  "each language is its own MISS",
  [en.xCache, fr.xCache],
  ["MISS", "MISS"],
);
const enAgain = await call("/pages", { headers: { "accept-language": "en" } });
checkEqual(
  "English again: a HIT with its own body",
  [enAgain.xCache, enAgain.body],
  ["HIT", { run: 1 }],
);
checkEqual("two runs for two languages", runs.pages, 2);
checkEqual(
  "the default cache stored nothing of it",
  defaultSets,
  defaultSetsBefore,
);

/* ------------------------------------------------------------------ */
step("staleWhileRevalidate with a short @CacheTTL: STALE, then refreshed");

await callStored(defaultCache, "/news");
await Bun.sleep(400);
const refreshedWrite = nextSet(defaultCache);
const stale = await call("/news");
checkEqual("past the TTL the stored answer is STALE", stale.xCache, "STALE");
checkEqual("it is the old body", stale.body, { run: 1 });
await refreshedWrite;
const refreshed = await call("/news");
check(
  "a replay refreshed it: the next answer is the new body",
  JSON.stringify(refreshed.body) === JSON.stringify({ run: 2 }) &&
    refreshed.xCache === "HIT",
  refreshed,
);
checkEqual("the handler ran twice in all", runs.news, 2);

await app.close();
await defaultCache.close();
await pagesCache.close();

summary();
