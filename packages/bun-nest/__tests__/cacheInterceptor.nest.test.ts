/**
 * `@kingsleyweb/bun-nest/cache`'s `BunCacheInterceptor` (plan
 * `docs/plans/bun-cache/` §10.3, §10.4) through real Nest applications on
 * bun-nest's adapter, answered by its socket-free `fetch()` (the production
 * path), over real `createCache` caches on the memory driver.
 *
 * Covered: hits and misses (the handler, pipes and inner interceptors not run
 * on a hit; `X-Cache`), the decorators (`@CacheKey`, `@CacheTTL` fixed and
 * computed, `@CacheTags`, `@NoCache`, controller-level), `@nestjs/cache-manager`'s
 * metadata keys, guards (a hit only behind a passing guard), exceptions
 * (never stored; stale-if-error through a filter's 5xx), `Authorization`,
 * ETag and `304`, `Vary`, `HEAD`, unsafe-method invalidation, `@Res()`,
 * `StreamableFile` and `@Sse()`, `@Validate` on either side of it, a
 * before-write hook refusing a stored answer, stale-while-revalidate through
 * the adapter, named caches and `with()`'s options, and the errors.
 *
 * Method decorators are written with `@`, as an application would (this
 * directory's tsconfig enables `experimentalDecorators`); constructor
 * parameter decorators are applied by call (oven-sh/bun#28605).
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type {
  Cache,
  CacheDriver,
  CreateCacheOptions,
} from "@kingsleyweb/bun-cache";
import type {
  ArgumentsHost,
  CallHandler,
  ExceptionFilter,
  CanActivate,
  ExecutionContext,
  INestApplication,
  MessageEvent,
  NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryDriver } from "@kingsleyweb/bun-cache";
import { addCacheTags } from "@kingsleyweb/bun-cache/http";
import {
  Controller,
  Get,
  Header,
  HttpException,
  Injectable,
  Module,
  NotFoundException,
  Post,
  Query,
  Res,
  SetMetadata,
  Sse,
  StreamableFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import {
  APP_INTERCEPTOR,
  BaseExceptionFilter,
  NestFactory,
} from "@nestjs/core";
import { afterEach, describe, expect, it } from "bun:test";
import { of, tap } from "rxjs";
import { z } from "zod";
import { BunHttpAdapter, Validate } from "../lib";
import {
  BunCacheInterceptor,
  BunCacheModule,
  CacheKey,
  CacheNotReadyError,
  CacheTags,
  CacheTTL,
  getCacheToken,
  NoCache,
} from "../lib/cache/index";
import "reflect-metadata";

/** Applications to close after each test. */
const apps: INestApplication[] = [];

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) {
    await app.close();
  }
});

/** Calls per route, reset per test. */
let calls: Record<string, number> = {};

/** Counts a call of `name`, answering the count. */
function count(name: string): number {
  calls[name] = (calls[name] ?? 0) + 1;
  return calls[name];
}

/**
 * An application of `controllers` over a default cache (and any named
 * ones), served by `fetch()`; `providers` and a `setup` step optional.
 */
async function boot(
  controllers: (new (...args: never[]) => unknown)[],
  options: {
    cache?: Omit<CreateCacheOptions, "driver">;
    driver?: CacheDriver;
    names?: string[];
    providers?: unknown[];
    setup?: (app: INestApplication, adapter: BunHttpAdapter) => void;
    noCacheModule?: boolean;
  } = {},
): Promise<{ adapter: BunHttpAdapter; app: INestApplication; cache: Cache }> {
  calls = {};
  class AppModule {}
  Module({
    imports: options.noCacheModule
      ? []
      : [
          BunCacheModule.forRoot({
            driver: options.driver ?? memoryDriver(),
            sweepInterval: 0,
            ...options.cache,
          }),
          ...(options.names ?? []).map((name) =>
            BunCacheModule.forRoot({ name, driver: memoryDriver() }),
          ),
        ],
    controllers,
    providers: (options.providers ?? []) as never[],
  })(AppModule);
  const adapter = new BunHttpAdapter(0);
  const app = await NestFactory.create(AppModule, adapter, {
    logger: process.env.DBG ? undefined : false,
  });
  options.setup?.(app, adapter);
  await app.init();
  apps.push(app);
  const cache = options.noCacheModule
    ? (undefined as unknown as Cache)
    : app.get<Cache>(getCacheToken());
  return { adapter, app, cache };
}

/** `GET path` through the adapter, answering status, `X-Cache`, body and headers. */
async function get(
  adapter: BunHttpAdapter,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{
  status: number;
  xCache: string | null;
  body: string;
  headers: Headers;
}> {
  const response = await adapter.fetch(`http://localhost${path}`, {
    method,
    headers,
  });
  return {
    status: response.status,
    xCache: response.headers.get("x-cache"),
    body: await response.text(),
    headers: response.headers,
  };
}

/** Waits a few macrotasks, for a write the response did not wait for. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/* ---- basics ----------------------------------------------------------- */

/** An interceptor inside the cache one, counting its runs. */
@Injectable()
class InnerInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    count("inner");
    return next.handle();
  }
}

/** An interceptor outside the cache one, recording what it sees. */
const outerSeen: unknown[] = [];
@Injectable()
class OuterInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(tap((value) => outerSeen.push(value)));
  }
}

@Controller("basic")
class BasicController {
  @UseInterceptors(OuterInterceptor, BunCacheInterceptor, InnerInterceptor)
  @CacheTTL(60_000)
  @Get("list")
  list(@Query("page") page?: string) {
    return { n: count("list"), page: page ?? null };
  }

  @UseInterceptors(BunCacheInterceptor)
  @Get("headers")
  headers() {
    // No @CacheTTL and no freshness header: the cache's own TTL.
    return { n: count("headers") };
  }

  @UseInterceptors(BunCacheInterceptor)
  @Header("Cache-Control", "private")
  @Get("private")
  privateRoute() {
    return { n: count("private") };
  }

  @UseInterceptors(BunCacheInterceptor.with({ ttl: "headers" }))
  @Get("headers-only")
  headersOnly() {
    return { n: count("headersOnly") };
  }

  @UseInterceptors(BunCacheInterceptor)
  @CacheTTL(20)
  @Get("short")
  short() {
    return { n: count("short") };
  }

  @UseInterceptors(BunCacheInterceptor)
  @Header("Cache-Control", "max-age=60")
  @Get("declared")
  declared() {
    return { n: count("declared") };
  }
}

describe("BunCacheInterceptor: hits and misses", () => {
  it("answers a repeat from the cache, without the handler or the interceptors inside it", async () => {
    outerSeen.length = 0;
    const { adapter } = await boot([BasicController], {
      providers: [InnerInterceptor, OuterInterceptor],
    });
    const first = await get(adapter, "/basic/list");
    expect(first).toMatchObject({ status: 200, xCache: "MISS" });
    expect(JSON.parse(first.body)).toEqual({ n: 1, page: null });
    await settle();
    const second = await get(adapter, "/basic/list");
    expect(second).toMatchObject({ status: 200, xCache: "HIT" });
    expect(JSON.parse(second.body)).toEqual({ n: 1, page: null });
    expect(second.headers.get("content-type")).toContain("application/json");
    expect(second.headers.get("age")).not.toBeNull();
    expect(calls).toEqual({ list: 1, inner: 1 });
    // The outer interceptor saw the value, then `undefined` on the hit.
    expect(outerSeen).toEqual([{ n: 1, page: null }, undefined]);
  });

  it("keys the query: another page is a miss of its own", async () => {
    const { adapter } = await boot([BasicController], {
      providers: [InnerInterceptor, OuterInterceptor],
    });
    await get(adapter, "/basic/list?page=1");
    await settle();
    const two = await get(adapter, "/basic/list?page=2");
    expect(two.xCache).toBe("MISS");
    expect(JSON.parse(two.body)).toEqual({ n: 2, page: "2" });
    await settle();
    expect((await get(adapter, "/basic/list?page=1")).xCache).toBe("HIT");
  });

  it("without @CacheTTL, falls back to the cache's own TTL when the response gives no lifetime", async () => {
    // The cache's TTL is 20 ms.
    const { adapter } = await boot([BasicController], { cache: { ttl: 20 } });
    expect((await get(adapter, "/basic/headers")).xCache).toBe("MISS");
    await settle();
    expect((await get(adapter, "/basic/headers")).xCache).toBe("HIT");
    await Bun.sleep(40);
    expect((await get(adapter, "/basic/headers")).xCache).toBe("MISS");
    expect(calls.headers).toBe(2);
  });

  it("the response's own lifetime wins over the cache's TTL", async () => {
    const { adapter } = await boot([BasicController], { cache: { ttl: 20 } });
    expect((await get(adapter, "/basic/declared")).xCache).toBe("MISS");
    await settle();
    await Bun.sleep(40);
    // max-age=60 s, not the cache's 20 ms.
    expect((await get(adapter, "/basic/declared")).xCache).toBe("HIT");
    expect(calls.declared).toBe(1);
  });

  it("the refusals still apply under the fallback: private is not stored", async () => {
    const { adapter } = await boot([BasicController], {
      cache: { ttl: 60_000 },
    });
    expect((await get(adapter, "/basic/private")).xCache).toBe("UNCACHEABLE");
    await settle();
    expect((await get(adapter, "/basic/private")).xCache).toBe("UNCACHEABLE");
    expect(calls.private).toBe(2);
  });

  it("@CacheTTL overrides the cache's TTL", async () => {
    const { adapter } = await boot([BasicController], {
      cache: { ttl: 60_000 },
    });
    await get(adapter, "/basic/short");
    await settle();
    await Bun.sleep(40);
    expect((await get(adapter, "/basic/short")).xCache).toBe("MISS");
  });

  it('with({ ttl: "headers" }): no freshness header, nothing stored', async () => {
    const { adapter } = await boot([BasicController], {
      cache: { ttl: 60_000 },
    });
    expect((await get(adapter, "/basic/headers-only")).xCache).toBe(
      "UNCACHEABLE",
    );
    await settle();
    expect((await get(adapter, "/basic/headers-only")).xCache).toBe(
      "UNCACHEABLE",
    );
    expect(calls.headersOnly).toBe(2);
  });
});

@CacheTTL(60_000)
@Controller("global")
class GlobalController {
  @Get()
  index() {
    return { n: count("index") };
  }

  @NoCache()
  @Get("live")
  live() {
    return { n: count("live") };
  }
}

describe("BunCacheInterceptor: applied globally", () => {
  it("works as APP_INTERCEPTOR, with @NoCache to opt a route out", async () => {
    const { adapter } = await boot([GlobalController], {
      providers: [{ provide: APP_INTERCEPTOR, useClass: BunCacheInterceptor }],
    });
    await get(adapter, "/global");
    await get(adapter, "/global/live");
    await settle();
    expect((await get(adapter, "/global")).xCache).toBe("HIT");
    expect((await get(adapter, "/global/live")).xCache).toBeNull();
    expect(calls).toEqual({ index: 1, live: 2 });
  });
});

/* ---- the decorators ----------------------------------------------------- */

@UseInterceptors(BunCacheInterceptor)
@CacheTTL(60_000)
@Controller("deco")
class DecoratedController {
  @CacheKey("deco:fixed")
  @Get("fixed")
  fixed(@Query("q") q?: string) {
    return { n: count("fixed"), q: q ?? null };
  }

  @CacheKey((context) => {
    const req = context.switchToHttp().getRequest<{ query: { id?: string } }>();
    return `deco:id:${req.query.id ?? "none"}`;
  })
  @Get("computed")
  computed(@Query("id") id?: string, @Query("noise") noise?: string) {
    return { n: count("computed"), id: id ?? null, noise: noise ?? null };
  }

  @CacheTTL(async (context) => {
    await Promise.resolve();
    const req = context
      .switchToHttp()
      .getRequest<{ query: { short?: string } }>();
    return req.query.short === "1" ? 20 : 60_000;
  })
  @Get("ttl")
  ttl() {
    return { n: count("ttl") };
  }

  @CacheTTL(0)
  @Get("zero")
  zero() {
    return { n: count("zero") };
  }

  @CacheTags("posts")
  @Get("tagged")
  tagged() {
    return { n: count("tagged") };
  }

  @CacheTags((context) => [`post:${context.getHandler().name}`])
  @Get("tagged-fn")
  taggedFn() {
    return { n: count("taggedFn") };
  }

  @Get("handler-tags")
  handlerTags(@Res() res: { json: (body: unknown) => unknown }) {
    addCacheTags(res as never, "from-handler");
    res.json({ n: count("handlerTags") });
  }

  @NoCache()
  @Get("never")
  never() {
    return { n: count("never") };
  }

  @Post("fixed")
  write() {
    return { ok: count("write") };
  }
}

describe("BunCacheInterceptor: the decorators", () => {
  it("@CacheKey with a string: one entry for every query", async () => {
    const { adapter } = await boot([DecoratedController]);
    await get(adapter, "/deco/fixed?q=a");
    await settle();
    const other = await get(adapter, "/deco/fixed?q=b");
    expect(other.xCache).toBe("HIT");
    expect(JSON.parse(other.body)).toEqual({ n: 1, q: "a" });
  });

  it("@CacheKey with a function of the ExecutionContext", async () => {
    const { adapter } = await boot([DecoratedController]);
    await get(adapter, "/deco/computed?id=1&noise=a");
    await settle();
    expect((await get(adapter, "/deco/computed?id=1&noise=b")).xCache).toBe(
      "HIT",
    );
    expect((await get(adapter, "/deco/computed?id=2&noise=a")).xCache).toBe(
      "MISS",
    );
    expect(calls.computed).toBe(2);
  });

  it("@CacheTTL on the class, overridden by an async function on the handler", async () => {
    const { adapter } = await boot([DecoratedController]);
    await get(adapter, "/deco/ttl?short=1");
    await settle();
    await Bun.sleep(40);
    // 20 ms: expired, so run again.
    expect((await get(adapter, "/deco/ttl?short=1")).xCache).toBe("MISS");
    await get(adapter, "/deco/ttl");
    await settle();
    await Bun.sleep(40);
    expect((await get(adapter, "/deco/ttl")).xCache).toBe("HIT");
  });

  it("@CacheTTL(0) stores nothing", async () => {
    const { adapter } = await boot([DecoratedController]);
    expect((await get(adapter, "/deco/zero")).xCache).toBe("UNCACHEABLE");
    await settle();
    expect((await get(adapter, "/deco/zero")).body).toBe('{"n":2}');
  });

  it("@CacheTags (strings and a function) and addCacheTags() in the handler: invalidateTags drops them", async () => {
    const { adapter, cache } = await boot([DecoratedController]);
    for (const path of [
      "/deco/tagged",
      "/deco/tagged-fn",
      "/deco/handler-tags",
    ]) {
      await get(adapter, path);
      await settle();
      expect((await get(adapter, path)).xCache).toBe("HIT");
    }
    await cache.invalidateTags(["posts", "post:taggedFn", "from-handler"]);
    for (const path of [
      "/deco/tagged",
      "/deco/tagged-fn",
      "/deco/handler-tags",
    ]) {
      expect((await get(adapter, path)).xCache).toBe("MISS");
    }
  });

  it("@NoCache leaves a route of a cached controller alone", async () => {
    const { adapter } = await boot([DecoratedController]);
    const first = await get(adapter, "/deco/never");
    await settle();
    const second = await get(adapter, "/deco/never");
    expect(first.xCache).toBeNull();
    expect(second.xCache).toBeNull();
    expect(JSON.parse(second.body)).toEqual({ n: 2 });
  });

  it("an unsafe method's 2xx invalidates the path's GET entries", async () => {
    const { adapter } = await boot([DecoratedController]);
    // `/deco/fixed` is keyed by @CacheKey, but carries its path's tag too.
    await get(adapter, "/deco/fixed");
    await settle();
    expect((await get(adapter, "/deco/fixed")).xCache).toBe("HIT");
    expect((await get(adapter, "/deco/fixed", {}, "POST")).status).toBe(201);
    expect((await get(adapter, "/deco/fixed")).xCache).toBe("MISS");
  });

  it("checks its arguments when the decorator is applied", () => {
    expect(() => CacheKey("")).toThrow(TypeError);
    expect(() => CacheKey(7 as unknown as string)).toThrow(TypeError);
    expect(() => CacheTTL(-1)).toThrow(RangeError);
    expect(() => CacheTTL(Number.NaN)).toThrow(RangeError);
    expect(() => CacheTags("a", "")).toThrow(TypeError);
  });
});

/* ---- @nestjs/cache-manager's metadata ----------------------------------- */

@UseInterceptors(BunCacheInterceptor)
@Controller("compat")
class CompatController {
  // What @nestjs/cache-manager's `@CacheKey("compat")` and `@CacheTTL(60000)` set.
  @SetMetadata("cache_module:cache_key", "compat:key")
  @SetMetadata("cache_module:cache_ttl", 60_000)
  @Get("a")
  a(@Query("q") q?: string) {
    return { n: count("a"), q: q ?? null };
  }

  // Its function form of `@CacheTTL`, and our key winning over its key.
  @SetMetadata("cache_module:cache_ttl", () => 60_000)
  @SetMetadata("cache_module:cache_key", "compat:shared")
  @CacheKey("compat:own")
  @Get("b")
  b() {
    return { n: count("b") };
  }

  @CacheKey("compat:shared")
  @CacheTTL(60_000)
  @Get("shared")
  shared() {
    return { n: count("shared") };
  }
}

describe("BunCacheInterceptor: @nestjs/cache-manager's metadata", () => {
  // The strings are the pin: @nestjs/cache-manager 3.x's CACHE_KEY_METADATA
  // and CACHE_TTL_METADATA, set here by hand.
  it("reads its key and TTL when ours are absent, and ours first", async () => {
    const { adapter } = await boot([CompatController]);
    await get(adapter, "/compat/a?q=1");
    await settle();
    // Its key: one entry whatever the query.
    expect((await get(adapter, "/compat/a?q=2")).xCache).toBe("HIT");
    await get(adapter, "/compat/shared");
    await settle();
    // `b` carries its key "compat:shared" too, but ours, "compat:own", wins.
    expect((await get(adapter, "/compat/b")).xCache).toBe("MISS");
    await settle();
    expect((await get(adapter, "/compat/b")).xCache).toBe("HIT");
    expect(calls).toEqual({ a: 1, shared: 1, b: 1 });
  });
});

/* ---- guards, exceptions, Authorization ---------------------------------- */

/** Lets a request through only with `x-pass: 1`. */
@Injectable()
class PassGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    return req.headers["x-pass"] === "1";
  }
}

/** What `/sie/flaky` does next. */
let flaky: "ok" | "500" | "404" = "ok";

@UseInterceptors(BunCacheInterceptor)
@CacheTTL(60_000)
@Controller("errors")
class ErrorsController {
  @UseGuards(PassGuard)
  @Get("guarded")
  guarded() {
    return { n: count("guarded") };
  }

  @Get("missing")
  missing() {
    count("missing");
    throw new NotFoundException("no such thing");
  }

  @Get("boom")
  boom() {
    count("boom");
    throw new Error("boom");
  }

  @Get("private")
  privateRoute() {
    return { n: count("private") };
  }

  @CacheKey("errors:shared-for-all-users")
  @Get("keyed-private")
  keyedPrivate() {
    return { n: count("keyedPrivate") };
  }
}

describe("BunCacheInterceptor: guards, exceptions and Authorization", () => {
  it("runs after guards: a cached route still refuses what its guard refuses", async () => {
    const { adapter } = await boot([ErrorsController], {
      providers: [PassGuard],
    });
    await get(adapter, "/errors/guarded", { "x-pass": "1" });
    await settle();
    expect(
      (await get(adapter, "/errors/guarded", { "x-pass": "1" })).xCache,
    ).toBe("HIT");
    const refused = await get(adapter, "/errors/guarded");
    expect(refused.status).toBe(403);
    expect(refused.body).not.toContain('"n"');
    expect(calls.guarded).toBe(1);
  });

  it("never stores an exception's answer (a 404 nor a 500)", async () => {
    const { adapter } = await boot([ErrorsController]);
    for (const path of ["/errors/missing", "/errors/boom"]) {
      const first = await get(adapter, path);
      await settle();
      const second = await get(adapter, path);
      expect(first.xCache).toBe("UNCACHEABLE");
      expect(second.xCache).toBe("UNCACHEABLE");
      expect(second.status).toBe(first.status);
    }
    expect(calls).toEqual({ missing: 2, boom: 2 });
  });

  it("does not store an answer to a request with Authorization, unless @CacheKey says the key covers it", async () => {
    const { adapter } = await boot([ErrorsController]);
    const auth = { authorization: "Bearer one" };
    await get(adapter, "/errors/private", auth);
    await settle();
    expect((await get(adapter, "/errors/private", auth)).xCache).toBe(
      "UNCACHEABLE",
    );
    expect(calls.private).toBe(2);
    await get(adapter, "/errors/keyed-private", auth);
    await settle();
    expect(
      (
        await get(adapter, "/errors/keyed-private", {
          authorization: "Bearer two",
        })
      ).xCache,
    ).toBe("HIT");
    expect(calls.keyedPrivate).toBe(1);
  });
});

@UseInterceptors(BunCacheInterceptor.with({ staleIfError: 60_000 }))
@CacheTTL(20)
@Controller("sie")
class StaleIfErrorController {
  @Get("flaky")
  flakyRoute() {
    const n = count("flaky");
    if (flaky !== "ok") {
      throw new HttpException("upstream down", flaky === "500" ? 503 : 404);
    }
    return { n };
  }
}

/** The same, without @CacheTTL: the cache's own TTL (20 ms in its test) decides the freshness. */
@UseInterceptors(BunCacheInterceptor.with({ staleIfError: 60_000 }))
@Controller("sie-cache-ttl")
class CacheTtlStaleIfErrorController {
  @Get("flaky")
  async flakyRoute() {
    const n = count("flaky");
    if (flaky !== "ok") {
      await Bun.sleep(20);
      throw new HttpException("upstream down", 503);
    }
    return { n };
  }
}

describe("BunCacheInterceptor: stale-if-error", () => {
  it("under the cache's own TTL, coalesced misses of a failing leader all read STALE", async () => {
    flaky = "ok";
    const { adapter } = await boot([CacheTtlStaleIfErrorController], {
      cache: { ttl: 20 },
    });
    await get(adapter, "/sie-cache-ttl/flaky");
    await settle();
    await Bun.sleep(40);
    flaky = "500";
    const answers = await Promise.all(
      Array.from({ length: 4 }, async () =>
        get(adapter, "/sie-cache-ttl/flaky"),
      ),
    );
    flaky = "ok";
    for (const answer of answers) {
      expect(answer).toMatchObject({
        status: 200,
        xCache: "STALE",
        body: '{"n":1}',
      });
    }
    expect(calls.flaky).toBe(2);
  });

  it("answers the stale entry for a 5xx an exception filter produced, and keeps it", async () => {
    flaky = "ok";
    const { adapter } = await boot([StaleIfErrorController]);
    expect(JSON.parse((await get(adapter, "/sie/flaky")).body)).toEqual({
      n: 1,
    });
    await settle();
    await Bun.sleep(40);
    flaky = "500";
    const stale = await get(adapter, "/sie/flaky");
    expect(stale.status).toBe(200);
    expect(stale.xCache).toBe("STALE");
    expect(JSON.parse(stale.body)).toEqual({ n: 1 });
    // A 4xx is the origin's answer, not a failure: it is passed on.
    flaky = "404";
    expect((await get(adapter, "/sie/flaky")).status).toBe(404);
    flaky = "ok";
    expect(JSON.parse((await get(adapter, "/sie/flaky")).body)).toEqual({
      n: 4,
    });
  });
});

/* ---- HTTP: ETag, Vary, HEAD, coalescing ------------------------------- */

@UseInterceptors(BunCacheInterceptor)
@CacheTTL(60_000)
@Controller("http")
class HttpController {
  @Get("etag")
  etag() {
    return { n: count("etag") };
  }

  @Header("Vary", "Accept-Language")
  @Get("vary")
  vary() {
    return { n: count("vary") };
  }

  @Get("slow")
  async slow() {
    const n = count("slow");
    await Bun.sleep(30);
    return { n };
  }
}

describe("BunCacheInterceptor: ETag, Vary, HEAD, coalescing", () => {
  it("gives a stored answer an ETag, and answers a matching If-None-Match with 304", async () => {
    const { adapter } = await boot([HttpController]);
    const first = await get(adapter, "/http/etag");
    const tag = first.headers.get("etag");
    expect(tag).not.toBeNull();
    await settle();
    const conditional = await get(adapter, "/http/etag", {
      "if-none-match": tag!,
    });
    expect(conditional.status).toBe(304);
    expect(conditional.body).toBe("");
    // A conditional miss stores the full answer and still answers 304.
    const { adapter: fresh } = await boot([HttpController]);
    expect(
      (await get(fresh, "/http/etag", { "if-none-match": tag! })).status,
    ).toBe(304);
    await settle();
    expect((await get(fresh, "/http/etag")).body).toBe('{"n":1}');
  });

  it("learns the response's Vary: one entry per Accept-Language", async () => {
    const { adapter } = await boot([HttpController]);
    await get(adapter, "/http/vary", { "accept-language": "en" });
    await settle();
    expect(
      (await get(adapter, "/http/vary", { "accept-language": "fr" })).xCache,
    ).toBe("MISS");
    await settle();
    expect(
      (await get(adapter, "/http/vary", { "accept-language": "en" })).body,
    ).toBe('{"n":1}');
    expect(
      (await get(adapter, "/http/vary", { "accept-language": "fr" })).body,
    ).toBe('{"n":2}');
  });

  it("answers HEAD from GET's entry, without a body", async () => {
    const { adapter } = await boot([HttpController]);
    await get(adapter, "/http/etag");
    await settle();
    const head = await get(adapter, "/http/etag", {}, "HEAD");
    expect(head).toMatchObject({ status: 200, xCache: "HIT", body: "" });
    expect(calls.etag).toBe(1);
  });

  it("coalesces concurrent identical misses into one handler run", async () => {
    const { adapter } = await boot([HttpController]);
    const answers = await Promise.all(
      Array.from({ length: 5 }, async () => get(adapter, "/http/slow")),
    );
    expect(calls.slow).toBe(1);
    expect(answers.map((answer) => answer.body)).toEqual(
      Array.from({ length: 5 }, () => '{"n":1}'),
    );
    expect(answers.filter((answer) => answer.xCache === "MISS")).toHaveLength(
      1,
    );
  });
});

/* ---- @Res(), StreamableFile, @Sse() ------------------------------------ */

@UseInterceptors(BunCacheInterceptor)
@CacheTTL(60_000)
@Controller("kinds")
class KindsController {
  @Get("res")
  res(@Res() res: { json: (body: unknown) => unknown }) {
    res.json({ n: count("res") });
  }

  @Get("file")
  file() {
    count("file");
    return new StreamableFile(new TextEncoder().encode("file-bytes"), {
      type: "text/plain",
    });
  }

  @Sse("events")
  events(): Observable<MessageEvent> {
    count("events");
    return of({ data: "one" }, { data: "two" });
  }
}

@UseInterceptors(BunCacheInterceptor.with({ streams: { buffer: 1024 } }))
@CacheTTL(60_000)
@Controller("buffered")
class BufferedController {
  @Get("file")
  file() {
    count("file");
    return new StreamableFile(new TextEncoder().encode("file-bytes"), {
      type: "text/plain",
    });
  }
}

describe("BunCacheInterceptor: @Res(), StreamableFile, @Sse()", () => {
  it("caches what a @Res() handler sends itself, and does not call it on a hit", async () => {
    const { adapter } = await boot([KindsController]);
    await get(adapter, "/kinds/res");
    await settle();
    const hit = await get(adapter, "/kinds/res");
    expect(hit).toMatchObject({ xCache: "HIT", body: '{"n":1}' });
    expect(calls.res).toBe(1);
  });

  it("does not store a StreamableFile by default (a stream), and does with `streams`", async () => {
    const { adapter } = await boot([KindsController, BufferedController]);
    const first = await get(adapter, "/kinds/file");
    expect(first).toMatchObject({
      status: 200,
      body: "file-bytes",
      xCache: "UNCACHEABLE",
    });
    await settle();
    expect((await get(adapter, "/kinds/file")).xCache).toBe("UNCACHEABLE");
    expect((await get(adapter, "/buffered/file")).body).toBe("file-bytes");
    await settle();
    const hit = await get(adapter, "/buffered/file");
    expect(hit).toMatchObject({ xCache: "HIT", body: "file-bytes" });
    expect(hit.headers.get("content-type")).toContain("text/plain");
    expect(calls.file).toBe(3);
  });

  it("passes an @Sse() route through untouched", async () => {
    const { adapter } = await boot([KindsController]);
    const first = await get(adapter, "/kinds/events");
    await settle();
    const second = await get(adapter, "/kinds/events");
    expect(first.xCache).toBeNull();
    expect(second.xCache).toBeNull();
    expect(second.body).toContain("data: two");
    expect(calls.events).toBe(2);
  });
});

/* ---- @Validate ---------------------------------------------------------- */

/** A catch-all exception filter recording what reaches it, answering as Nest's base filter does. */
function recordingFilter(
  caught: unknown[],
  app: INestApplication,
): ExceptionFilter {
  class RecordingFilter extends BaseExceptionFilter {
    override catch(exception: unknown, host: ArgumentsHost): void {
      caught.push(exception);
      super.catch(exception, host);
    }
  }
  return new RecordingFilter(app.getHttpAdapter());
}

const Page = z.object({ page: z.coerce.number().int().min(1) });
const Listing = z.object({ n: z.number(), page: z.number() });

@Controller("validated")
class ValidatedController {
  // Decorators apply bottom-up and each `@UseInterceptors` appends, so the
  // one written on top runs innermost. Here @Validate is the outer one:
  // request checks run on every request, and its response check sees
  // `undefined` on a hit.
  @UseInterceptors(BunCacheInterceptor)
  @Validate({
    query: Page,
    responses: { 200: Listing },
    responseValidation: "error",
  })
  @CacheTTL(60_000)
  @Get("validate-outside")
  validateOutside(@Query() query: { page: number }) {
    return { n: count("validate-outside"), page: query.page };
  }

  // Here the cache is the outer one: a hit skips @Validate altogether.
  @Validate({
    query: Page,
    responses: { 200: Listing },
    responseValidation: "error",
  })
  @UseInterceptors(BunCacheInterceptor)
  @CacheTTL(60_000)
  @Get("validate-inside")
  validateInside(@Query() query: { page: number }) {
    return { n: count("validate-inside"), page: query.page };
  }

  @UseInterceptors(BunCacheInterceptor)
  @Validate({ responses: { 200: Listing }, responseValidation: "error" })
  @CacheTTL(60_000)
  @Get("bad")
  bad() {
    count("bad");
    return { n: "not a number", page: 1 };
  }
}

describe("BunCacheInterceptor: with @Validate", () => {
  for (const route of ["validate-outside", "validate-inside"]) {
    it(`serves a hit, ${route.replace("-", " ")} the cache`, async () => {
      const caught: unknown[] = [];
      const { adapter } = await boot([ValidatedController], {
        setup: (app) => app.useGlobalFilters(recordingFilter(caught, app)),
      });
      const first = await get(adapter, `/validated/${route}?page=2`);
      expect(first).toMatchObject({ status: 200, xCache: "MISS" });
      await settle();
      const hit = await get(adapter, `/validated/${route}?page=2`);
      expect(hit).toMatchObject({
        status: 200,
        xCache: "HIT",
        body: '{"n":1,"page":2}',
      });
      // An invalid query is refused, and never stored.
      expect((await get(adapter, `/validated/${route}?page=0`)).status).toBe(
        400,
      );
      await settle();
      expect((await get(adapter, `/validated/${route}?page=0`)).status).toBe(
        400,
      );
      expect(calls[route]).toBe(1);
      // Nothing but the two 400s reached the exception filters: the hit's
      // `undefined` was not refused behind the client's back.
      expect(
        caught.map((error) => (error as HttpException).getStatus?.()),
      ).toEqual([400, 400]);
    });
  }

  it("never stores a response @Validate refused", async () => {
    const { adapter } = await boot([ValidatedController]);
    expect((await get(adapter, "/validated/bad")).status).toBe(500);
    await settle();
    expect((await get(adapter, "/validated/bad")).status).toBe(500);
    expect(calls.bad).toBe(2);
  });
});

/* ---- a before-write hook refusing a stored answer ---------------------- */

@UseInterceptors(BunCacheInterceptor)
@CacheTTL(60_000)
@Controller("hooked")
class HookedController {
  @Get("res")
  res(@Res() res: { json: (body: unknown) => unknown }) {
    res.json({ n: count("res") });
  }

  @Get("plain")
  plain() {
    return { n: count("plain") };
  }
}

/** A file big enough that reading it back for the store takes a while. */
const LATE_FILE = join(tmpdir(), `bun-nest-cache-late-${process.pid}.bin`);

/** A memory driver whose writes take `lagMs`, as a networked one's do (reads are not delayed). */
function slowWriteDriver(lagMs: number): CacheDriver {
  const inner = memoryDriver();
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === "set" && typeof value === "function") {
        return async (...args: Parameters<CacheDriver["set"]>) => {
          await Bun.sleep(lagMs);
          return await inner.set(...args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A route whose stored write lands late: uncoalesced, a sent file's body read back after the commit, and slow writes. */
@UseInterceptors(
  BunCacheInterceptor.with({ coalesce: false, streams: { buffer: 1024 } }),
)
@CacheTTL(60_000)
@Controller("late")
class LateWriteController {
  @Get("file")
  async file(@Res() res: { sendFile: (path: string) => Promise<unknown> }) {
    count("file");
    await res.sendFile(LATE_FILE);
  }
}

describe("BunCacheInterceptor: a before-write hook's refusal", () => {
  // The capture reads a sent file back after the hooks ran, so its `set` is
  // issued after the refusal's drop, and no fence covers it: the drop must
  // run again once the write has landed (bun-cache/http's in-flight writes).
  it("drops a sent file's entry whose read and write land after the refusal", async () => {
    await Bun.write(LATE_FILE, new Uint8Array(3 * 1024 * 1024).fill(97));
    try {
      let refuse = true;
      const { adapter } = await boot([LateWriteController], {
        driver: slowWriteDriver(30),
        setup: (_app, bunAdapter) => {
          bunAdapter.addBeforeWriteHook((write) => {
            if (write.phase === "response" && refuse && write.status === 200) {
              refuse = false;
              throw new HttpException("refused by a hook", 502);
            }
          });
        },
      });
      expect((await get(adapter, "/late/file")).status).toBe(502);
      await Bun.sleep(200);
      const next = await get(adapter, "/late/file");
      expect(next.xCache).toBe("MISS");
      expect(calls.file).toBe(2);
    } finally {
      await Bun.file(LATE_FILE).delete();
    }
  });

  for (const route of ["res", "plain"]) {
    it(`drops what it stored when a later hook refuses the answer (${route})`, async () => {
      let refuse = true;
      const { adapter } = await boot([HookedController], {
        setup: (_app, bunAdapter) => {
          bunAdapter.addBeforeWriteHook((write) => {
            if (write.phase === "response" && refuse && write.status === 200) {
              refuse = false;
              throw new HttpException("refused by a hook", 502);
            }
          });
        },
      });
      // The capture saw (and began storing) the 200; the hook refused it.
      expect((await get(adapter, `/hooked/${route}`)).status).toBe(502);
      await settle();
      const next = await get(adapter, `/hooked/${route}`);
      expect(next.xCache).toBe("MISS");
      expect(next.body).toBe('{"n":2}');
      await settle();
      expect((await get(adapter, `/hooked/${route}`)).xCache).toBe("HIT");
    });
  }
});

/* ---- stale-while-revalidate, named caches, with() ---------------------- */

@UseInterceptors(BunCacheInterceptor.with({ staleWhileRevalidate: 60_000 }))
@CacheTTL(20)
@Controller("swr")
class SwrController {
  @Get("feed")
  feed() {
    return { n: count("feed") };
  }
}

@UseInterceptors(
  BunCacheInterceptor.with({ staleWhileRevalidate: 60_000, revalidate: false }),
)
@CacheTTL(20)
@Controller("swr-no-replay")
class SwrNoReplayController {
  @Get("feed")
  feed() {
    return { n: count("feed") };
  }
}

describe("BunCacheInterceptor: stale-while-revalidate", () => {
  it("answers STALE and refreshes in the background through the application's adapter", async () => {
    const { adapter } = await boot([SwrController]);
    await get(adapter, "/swr/feed");
    await settle();
    await Bun.sleep(40);
    const stale = await get(adapter, "/swr/feed");
    expect(stale).toMatchObject({ xCache: "STALE", body: '{"n":1}' });
    for (let i = 0; i < 50 && calls.feed !== 2; i++) {
      await Bun.sleep(5);
    }
    await settle();
    expect(calls.feed).toBe(2);
    expect((await get(adapter, "/swr/feed")).body).toBe('{"n":2}');
  });

  it("with `revalidate: false`, answers stale once and lets the next request refresh", async () => {
    const { adapter } = await boot([SwrNoReplayController]);
    await get(adapter, "/swr-no-replay/feed");
    await settle();
    await Bun.sleep(40);
    expect((await get(adapter, "/swr-no-replay/feed")).xCache).toBe("STALE");
    await Bun.sleep(20);
    expect(calls.feed).toBe(1);
    expect((await get(adapter, "/swr-no-replay/feed")).body).toBe('{"n":2}');
  });
});

@UseInterceptors(
  BunCacheInterceptor.with({ cache: "pages", statusHeader: "X-Page-Cache" }),
)
@CacheTTL(60_000)
@Controller("named")
class NamedController {
  @Get()
  index() {
    return { n: count("index") };
  }
}

@UseInterceptors(BunCacheInterceptor.with({ cache: "nowhere" }))
@CacheTTL(60_000)
@Controller("unnamed")
class MissingCacheController {
  @Get()
  index() {
    return { n: count("index") };
  }
}

describe("BunCacheInterceptor.with()", () => {
  it("uses the named cache, with cacheResponse()'s options", async () => {
    const { adapter, app, cache } = await boot([NamedController], {
      names: ["pages"],
    });
    const pages = app.get<Cache>(getCacheToken("pages"));
    const first = await adapter.fetch("http://localhost/named");
    expect(first.headers.get("x-page-cache")).toBe("MISS");
    expect(first.headers.get("x-cache")).toBeNull();
    await settle();
    expect((await pages.stats()).sets).toBe(1);
    expect((await cache.stats()).sets).toBe(0);
  });

  it("throws CacheNotReadyError for a cache no module registers", async () => {
    const caught: unknown[] = [];
    const { adapter } = await boot([MissingCacheController], {
      setup: (app) => app.useGlobalFilters(recordingFilter(caught, app)),
    });
    expect((await get(adapter, "/unnamed")).status).toBe(500);
    expect(caught[0]).toBeInstanceOf(CacheNotReadyError);
    expect(caught[0]).toMatchObject({
      cacheName: "nowhere",
      method: "MissingCacheController.index",
    });
    expect(calls.index).toBeUndefined();
  });

  it("checks its options when the class is made", () => {
    expect(() => BunCacheInterceptor.with({ cache: "" })).toThrow(TypeError);
    expect(() => BunCacheInterceptor.with({ ttl: -1 })).toThrow(RangeError);
    expect(() => BunCacheInterceptor.with({ streams: { buffer: 0 } })).toThrow(
      TypeError,
    );
    expect(BunCacheInterceptor.with({ varyBy: ["accept-language"] })).not.toBe(
      BunCacheInterceptor.with({ varyBy: ["accept-language"] }),
    );
  });
});

/* ---- outside an HTTP route on bun-nest's adapter ----------------------- */

describe("BunCacheInterceptor: other contexts", () => {
  /** An interceptor made by hand, with a ModuleRef that must not be reached. */
  const interceptor = new BunCacheInterceptor({
    get: () => {
      throw new Error("not reached");
    },
  } as never);

  /** A context of `type` whose response is `res`. */
  function contextOf(type: string, res: unknown): ExecutionContext {
    class SomeController {
      route(this: void) {}
    }
    return {
      getType: () => type,
      getHandler: () => SomeController.prototype.route,
      getClass: () => SomeController,
      switchToHttp: () => ({
        getRequest: () => ({ method: "GET" }),
        getResponse: () => res,
      }),
    } as unknown as ExecutionContext;
  }

  it("passes a non-HTTP context through", async () => {
    const handled = of("value");
    const out = await interceptor.intercept(contextOf("rpc", {}), {
      handle: () => handled,
    });
    expect(out).toBe(handled);
  });

  it("throws on a response that is not bun-nest's", async () => {
    let message = "";
    try {
      await interceptor.intercept(contextOf("http", { json() {} }), {
        handle: () => of(undefined),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("needs @kingsleyweb/bun-nest's BunHttpAdapter");
    expect(message).toContain("SomeController.route");
  });
});
