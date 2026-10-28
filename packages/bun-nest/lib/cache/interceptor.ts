/**
 * `BunCacheInterceptor` and its decorators: response caching for Nest
 * routes (plan `docs/plans/bun-cache/` §10.3, §10.4).
 *
 * The interceptor runs `@kingsleyweb/bun-cache/http`'s `cacheResponse()`
 * from inside Nest's pipeline, on the request and response the route already
 * has (bun-common's `BunRequest` and `BunResponse`), so it is the **same
 * cache** as on a router — keys, `Vary` variants, the refuse-to-store rules,
 * `ETag` and `304`, `Age`, `X-Cache`, coalescing, hit-for-miss,
 * stale-while-revalidate, stale-if-error, streams, `HEAD` and the
 * invalidation of unsafe methods — not a second implementation of it:
 *
 * - **A miss**: the middleware hands on (its `next`), and the interceptor
 *   returns `next.handle()`. Whatever answers on the response — Nest's
 *   `reply()`, an exception filter's, a `@Res()` handler's own — is
 *   captured by the middleware's response transform and stored when it may
 *   be.
 * - **A hit**: the middleware answers on the response itself, and the
 *   interceptor returns `of(undefined)`. Nest's `reply()` then finds the
 *   response sent, and bun-common's `send()` leaves it as it is.
 *
 * Why the public middleware rather than its internals: they are not
 * exported, and the state they share — a background replay waiting for its
 * request, an invalidation a `GET` must wait for — lives in the middleware's
 * closure. Calling the middleware keeps one implementation and one place to
 * fix.
 *
 * It runs **after Nest's guards**, which no router middleware does: that is
 * why a cached route behind a guard caches here, not with `cacheResponse()`
 * on the adapter.
 */
import type { Cache } from "@kingsleyweb/bun-cache";
import type {
  CacheResponseMiddleware,
  CacheResponseOptions,
} from "@kingsleyweb/bun-cache/http";
import type {
  BunRequest,
  BunResponse,
  NextFunction,
} from "@kingsleyweb/bun-common";
import type {
  CallHandler,
  CustomDecorator,
  ExecutionContext,
  NestInterceptor,
  Type,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import type { BunBeforeWriteContext } from "../BunHttpAdapter";
import { cacheResponse } from "@kingsleyweb/bun-cache/http";
import { Inject, Injectable, mixin, SetMetadata } from "@nestjs/common";
import { HttpAdapterHost, ModuleRef } from "@nestjs/core";
import { of } from "rxjs";
import { CacheNotReadyError } from "./errors";
import { getCacheToken } from "./tokens";

/* ------------------------------------------------------------------ *
 * Metadata
 * ------------------------------------------------------------------ */

/** `@CacheKey()`'s metadata key. */
const KEY_METADATA = "@kingsleyweb/bun-nest/cache:key";
/** `@CacheTTL()`'s metadata key. */
const TTL_METADATA = "@kingsleyweb/bun-nest/cache:ttl";
/** `@CacheTags()`'s metadata key. */
const TAGS_METADATA = "@kingsleyweb/bun-nest/cache:tags";
/** `@NoCache()`'s metadata key. */
const NO_CACHE_METADATA = "@kingsleyweb/bun-nest/cache:no-cache";

/**
 * `@nestjs/cache-manager`'s `CACHE_KEY_METADATA` and `CACHE_TTL_METADATA`
 * (`cache.constants.ts`, 3.x), read as a fallback so its `@CacheKey()` and
 * `@CacheTTL()` keep working on a route this interceptor caches (§10.4).
 * Pinned by a test that sets them by their strings: if Nest renames them,
 * the fallback stops silently.
 */
const NEST_CACHE_MANAGER_METADATA = {
  /** `@nestjs/cache-manager`'s `@CacheKey()`. */
  key: "cache_module:cache_key",
  /** `@nestjs/cache-manager`'s `@CacheTTL()`. */
  ttl: "cache_module:cache_ttl",
} as const;

/** `@nestjs/core`'s `@Sse()` marker on a handler (`SSE_METADATA`). */
const SSE_METADATA = "__sse__";

/** A key: fixed, or computed from the request's execution context. */
type CacheKeyValue = string | ((context: ExecutionContext) => string);

/** A TTL in ms, or computed (sync or async) from the request's execution context. */
type CacheTtlValue =
  number | ((context: ExecutionContext) => number | Promise<number>);

/** Tags: a list, or computed from the request's execution context. */
type CacheTagsValue =
  readonly string[] | ((context: ExecutionContext) => readonly string[]);

/**
 * The route's cache key, in place of the method, path, query and `varyBy`
 * headers (the response's own `Vary` still applies): a string, or a
 * function of the request's `ExecutionContext`. It is taken to include the
 * requester's identity, so a request with `Authorization` is cached under it
 * too (bun-cache/http's rule for a `key` function) — include the user in a
 * key on a per-user route. Only `GET` (and `HEAD`, from `GET`'s entry) is
 * ever cached. On a handler or a controller; the handler's wins.
 */
export function CacheKey(key: CacheKeyValue): CustomDecorator<string> {
  if ((typeof key !== "string" || key === "") && typeof key !== "function") {
    throw new TypeError(
      "@CacheKey(): the key must be a non-empty string or a function of the ExecutionContext",
    );
  }
  return SetMetadata(KEY_METADATA, key);
}

/**
 * How long the route's responses stay fresh, in **ms**: a number, or a
 * function of the request's `ExecutionContext` (sync or async). It overrides
 * every freshness header (not the refusals: `no-store`, `private` and the
 * rest still apply). Without it, the interceptor's `ttl` applies: by default
 * `"headers-or-cache"` — the response's own `Cache-Control`/`Expires`
 * lifetime, else the cache's own TTL (as `@nestjs/cache-manager` falls back
 * to its store's). `0` stores nothing (a response with no lifetime is not
 * stored). On a handler or a controller; the handler's wins.
 */
export function CacheTTL(ttl: CacheTtlValue): CustomDecorator<string> {
  if (typeof ttl !== "function") {
    checkTtl("@CacheTTL()", ttl);
  }
  return SetMetadata(TTL_METADATA, ttl);
}

/**
 * Tags for every response the route stores, besides the path's own tag and
 * any `addCacheTags(res, …)` (`@kingsleyweb/bun-cache/http`) the handler
 * adds: strings, or one function of the request's `ExecutionContext`.
 * `cache.invalidateTags([tag])` drops them. On a handler or a controller;
 * the handler's wins.
 */
export function CacheTags(...tags: string[]): CustomDecorator<string>;
export function CacheTags(
  tags: (context: ExecutionContext) => readonly string[],
): CustomDecorator<string>;
export function CacheTags(
  ...tags: (string | ((context: ExecutionContext) => readonly string[]))[]
): CustomDecorator<string> {
  if (tags.length === 1 && typeof tags[0] === "function") {
    return SetMetadata(TAGS_METADATA, tags[0]);
  }
  if (tags.some((tag) => typeof tag !== "string" || tag === "")) {
    throw new TypeError(
      "@CacheTags(): pass non-empty strings, or one function of the ExecutionContext",
    );
  }
  return SetMetadata(TAGS_METADATA, Object.freeze([...tags]));
}

/**
 * Leaves the route out of the interceptor: no read, no store, no
 * invalidation, no `X-Cache`. For one route of a controller whose interceptor
 * is applied to the class (or globally). On a handler or a controller.
 */
export function NoCache(): CustomDecorator<string> {
  return SetMetadata(NO_CACHE_METADATA, true);
}

/** Checks a TTL: a finite number of ms, `0` or more. */
function checkTtl(where: string, ttl: unknown): number {
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl < 0) {
    throw new RangeError(
      `${where}: the TTL must be a finite number of ms, 0 or more (got ${String(ttl)})`,
    );
  }
  return ttl;
}

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

/**
 * `BunCacheInterceptor.with()`'s options: `cacheResponse()`'s
 * (`@kingsleyweb/bun-cache/http`), less the three the decorators set per
 * route (`key` is `@CacheKey`, `tags` is `@CacheTags`), plus which cache.
 */
export interface BunCacheInterceptorOptions extends Omit<
  CacheResponseOptions,
  "key" | "tags" | "revalidate" | "statuses"
> {
  /** The cache, by the `name` given to `BunCacheModule.forRoot`; the default (unnamed) cache when omitted. */
  cache?: string;
  /**
   * How long a stored answer stays fresh when the route has no `@CacheTTL`:
   * a number of ms (over every freshness header), `"headers"` (the
   * response's own lifetime, or not stored), or `"headers-or-cache"` (the
   * response's own lifetime, else the cache's TTL — `createCache`'s `ttl`).
   * Defaults to `"headers-or-cache"`; the refusals (`no-store`, `private`,
   * a cookie, `statuses`, …) apply whichever.
   */
  ttl?: CacheResponseOptions["ttl"];
  /**
   * The statuses that are stored. Defaults to `[200, 203, 204]`: a route's
   * successful answers, so an exception a filter answers (a `404` from
   * `NotFoundException` too) is never stored. `cacheResponse()`'s own
   * default is RFC 9110's heuristically cacheable set, 404 included.
   */
  statuses?: readonly number[];
  /**
   * What a stale-while-revalidate refresh replays the request through.
   * Defaults to the application's HTTP adapter (`HttpAdapterHost`), whose
   * `fetch()` runs Nest's whole pipeline without a socket — guards included,
   * and the replay carries only the headers the key reads, so behind a
   * guard that needs credentials the replay is refused and the entry is
   * refreshed by the first request after its window instead. `false`: no
   * replay; a stale entry is answered once and the next request refreshes it.
   */
  revalidate?: CacheResponseOptions["revalidate"] | false;
}

/** The statuses the interceptor stores by default: 2xx answers only. */
const DEFAULT_STATUSES: readonly number[] = [200, 203, 204];

/** The most middleware instances one interceptor keeps per cache (one per distinct TTL and key kind). */
const MAX_INSTANCES = 32;

/** The options each interceptor class was made with (`with()`); the base class's are `{}`. */
const classOptions = new WeakMap<object, BunCacheInterceptorOptions>();

/** A probe standing in for a cache while `with()` checks options: `cacheResponse()` reads none of it then. */
const NO_CACHE_YET = new Proxy(
  {},
  {
    get() {
      throw new Error(
        "BunCacheInterceptor: the cache was read while checking options",
      );
    },
  },
) as Cache;

/* ------------------------------------------------------------------ *
 * The interceptor
 * ------------------------------------------------------------------ */

/** What the interceptor knows about one request it is caching. */
interface RequestState {
  /** The request's execution context, for `@CacheKey` and `@CacheTags` functions. */
  context: ExecutionContext;
  /** The route's `@CacheKey`, if any. */
  key: CacheKeyValue | undefined;
  /** The route's `@CacheTags`, if any. */
  tags: CacheTagsValue | undefined;
  /** The middleware the request ran through. */
  middleware: CacheResponseMiddleware;
}

/** Whether `res` is bun-common's `BunResponse` (bun-nest's adapter's response), structurally. */
function isBunResponse(res: unknown): res is BunResponse {
  return (
    typeof res === "object" &&
    res !== null &&
    typeof (res as { addResponseTransform?: unknown }).addResponseTransform ===
      "function"
  );
}

/** `ClassName.method` of a context's route, for messages. */
function routeName(context: ExecutionContext): string {
  return `${context.getClass().name}.${context.getHandler().name}`;
}

/**
 * Caches a route's responses (plan §10.3) through `cacheResponse()`: apply
 * it with `@UseInterceptors(BunCacheInterceptor)` on a handler or a
 * controller, or globally (`APP_INTERCEPTOR`); configure it per route with
 * `@CacheKey`, `@CacheTTL`, `@CacheTags` and `@NoCache`, and for the whole
 * interceptor with `BunCacheInterceptor.with(options)`.
 *
 * ```ts
 * @UseInterceptors(BunCacheInterceptor)
 * @CacheTTL(30_000)
 * @CacheTags("posts")
 * @Get("posts")
 * list() { … }
 * ```
 *
 * - **What is cached** is the response — status, headers, bytes — as the
 *   router middleware stores it, so a hit answers without running the
 *   handler, the pipes, or any interceptor inside this one. Interceptors
 *   outside it see `undefined` on a hit (the response is already sent).
 * - **Only `GET`** (and `HEAD`, from `GET`'s entry); a `POST`, `PUT`,
 *   `PATCH` or `DELETE` it sees that answers 2xx or 3xx invalidates its path
 *   (RFC 9111 §4.4). Only HTTP: other contexts pass through.
 * - **Never cached**: `@Sse()` routes (passed through untouched), streamed
 *   answers (a `StreamableFile` included) unless `streams` says so, statuses
 *   outside `statuses` (by default anything but 200, 203 and 204, so no
 *   exception's answer), and anything the response's own `Cache-Control`
 *   refuses. A request with `Authorization` is stored only under a
 *   `@CacheKey` or a response that allows it (`public`, `s-maxage`).
 * - **`@nestjs/cache-manager`'s** `@CacheKey()` and `@CacheTTL()` are read
 *   too, when ours are absent.
 * - **Needs bun-nest's adapter**: it throws on another platform's response.
 */
export class BunCacheInterceptor implements NestInterceptor {
  /**
   * An interceptor class with these options, for `@UseInterceptors()` or
   * `APP_INTERCEPTOR`. The options are checked here, so a bad one fails when
   * the class is defined.
   *
   * ```ts
   * @UseInterceptors(BunCacheInterceptor.with({ cache: "pages", varyBy: ["accept-language"] }))
   * ```
   */
  static with(options: BunCacheInterceptorOptions): Type<NestInterceptor> {
    checkOptions(options);
    class ConfiguredCacheInterceptor extends BunCacheInterceptor {}
    classOptions.set(ConfiguredCacheInterceptor, { ...options });
    Injectable()(ConfiguredCacheInterceptor);
    Inject(ModuleRef)(ConfiguredCacheInterceptor, undefined, 0);
    return mixin(ConfiguredCacheInterceptor);
  }

  /** This interceptor's options. */
  readonly #options: BunCacheInterceptorOptions;
  /** The cache, once resolved. */
  #cache: Cache | undefined = undefined;
  /** The middlewares, by TTL and key kind. */
  readonly #instances = new Map<string, CacheResponseMiddleware>();
  /** The requests being cached, for the per-request `key` and `tags` and the refusal hook. */
  readonly #requests = new WeakMap<BunRequest, RequestState>();
  /** Whether the before-write hook is registered (or the adapter takes none). */
  #hooked = false;

  constructor(
    /** Resolves the cache, by its token, anywhere in the application, and the HTTP adapter. */
    private readonly moduleRef: ModuleRef,
  ) {
    this.#options = classOptions.get(new.target) ?? {};
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() !== "http") {
      return next.handle();
    }
    const handler = context.getHandler();
    const classRef = context.getClass();
    const read = <T>(key: string): T | undefined =>
      (Reflect.getMetadata(key, handler) ??
        Reflect.getMetadata(key, classRef)) as T | undefined;
    if (
      read<boolean>(NO_CACHE_METADATA) === true ||
      Reflect.getMetadata(SSE_METADATA, handler) === true
    ) {
      return next.handle();
    }
    const http = context.switchToHttp();
    const req = http.getRequest<BunRequest>();
    const res = http.getResponse<unknown>();
    if (!isBunResponse(res)) {
      throw new TypeError(
        `BunCacheInterceptor (${routeName(context)}) needs @kingsleyweb/bun-nest's BunHttpAdapter: the response is not a BunResponse`,
      );
    }
    const cache = this.#resolveCache(context);
    this.#hook();

    const key =
      read<CacheKeyValue>(KEY_METADATA) ??
      read<string>(NEST_CACHE_MANAGER_METADATA.key);
    const tags = read<CacheTagsValue>(TAGS_METADATA);
    const method = req.method;
    const safe = method === "GET" || method === "HEAD";

    if (!safe) {
      // Every instance tracks the invalidation it starts, which a `GET`
      // through it waits for: run the request through each.
      const ttl = await this.#ttl(context, read);
      const own = this.#middleware(cache, ttl, key !== undefined);
      const noop: NextFunction = () => undefined;
      // The state first: a middleware reads `key` and `tags` through it.
      this.#requests.set(req, { context, key, tags, middleware: own });
      for (const middleware of new Set([own, ...this.#instances.values()])) {
        void middleware(req, res, noop);
      }
      return next.handle();
    }

    const ttl = await this.#ttl(context, read);
    const middleware = this.#middleware(cache, ttl, key !== undefined);
    let handOn!: () => void;
    const handedOn = new Promise<"next">((resolve) => {
      handOn = () => resolve("next");
    });
    // The state first: the middleware reads `key` and `tags` through it.
    this.#requests.set(req, { context, key, tags, middleware });
    const done = Promise.resolve(
      middleware(req, res, () => {
        handOn();
      }),
    );
    const outcome = await Promise.race([
      handedOn,
      done.then(() => "answered" as const),
    ]);
    if (outcome === "next" || !res.headersSent) {
      return next.handle();
    }
    // Answered from the cache: Nest's `reply()` finds the response sent.
    return of(undefined);
  }

  /** The route's TTL: `@CacheTTL`, else `@nestjs/cache-manager`'s, else the interceptor's `ttl`. */
  async #ttl(
    context: ExecutionContext,
    read: <T>(key: string) => T | undefined,
  ): Promise<number | "headers" | "headers-or-cache"> {
    const value =
      read<CacheTtlValue>(TTL_METADATA) ??
      read<CacheTtlValue>(NEST_CACHE_MANAGER_METADATA.ttl);
    if (value === undefined || value === null) {
      return this.#options.ttl ?? "headers-or-cache";
    }
    const ttl = typeof value === "function" ? await value(context) : value;
    return checkTtl(`@CacheTTL() on ${routeName(context)}`, ttl);
  }

  /** The cache, resolved once by its token anywhere in the application. */
  #resolveCache(context: ExecutionContext): Cache {
    if (this.#cache !== undefined) {
      return this.#cache;
    }
    const name = this.#options.cache;
    let cache: Cache | undefined;
    try {
      cache = this.moduleRef.get<Cache>(getCacheToken(name), {
        strict: false,
      });
    } catch {
      cache = undefined;
    }
    if (cache === undefined || cache === null) {
      throw new CacheNotReadyError(
        name,
        routeName(context),
        name === undefined
          ? "its application registers no default cache; import `BunCacheModule.forRoot()` without a `name`"
          : `its application registers no cache named "${name}"; import \`BunCacheModule.forRoot({ name: "${name}", … })\``,
      );
    }
    this.#cache = cache;
    return cache;
  }

  /** The middleware for a TTL and key kind, built on first use. */
  #middleware(
    cache: Cache,
    ttl: number | "headers" | "headers-or-cache",
    keyed: boolean,
  ): CacheResponseMiddleware {
    const id = `${keyed ? "key" : "url"}:${ttl}`;
    const existing = this.#instances.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const { cache: _name, revalidate, statuses, ...rest } = this.#options;
    const options: CacheResponseOptions = {
      ...rest,
      ttl,
      statuses: statuses ?? DEFAULT_STATUSES,
      tags: (req) => this.#tagsOf(req),
    };
    const target = revalidate === undefined ? this.#adapterFetch() : revalidate;
    if (target !== false && target !== undefined) {
      options.revalidate = target;
    }
    if (keyed) {
      options.key = (req) => this.#keyOf(req);
    }
    const middleware = cacheResponse(cache, options);
    if (this.#instances.size >= MAX_INSTANCES) {
      // A TTL function answering ever new values: drop the oldest.
      const oldest = this.#instances.keys().next().value;
      if (oldest !== undefined) {
        this.#instances.delete(oldest);
      }
    }
    this.#instances.set(id, middleware);
    return middleware;
  }

  /** The application's adapter as a replay target, when it has `fetch()`. */
  #adapterFetch(): CacheResponseOptions["revalidate"] {
    let host: HttpAdapterHost | undefined;
    try {
      host = this.moduleRef.get(HttpAdapterHost, { strict: false });
    } catch {
      return undefined;
    }
    const adapter = host?.httpAdapter as
      { fetch?: (request: Request) => Promise<Response> } | undefined;
    if (typeof adapter?.fetch !== "function") {
      return undefined;
    }
    return { fetch: (request) => adapter.fetch!(request) };
  }

  /** A keyed request's key, from its `@CacheKey`. */
  #keyOf(req: BunRequest): string {
    const state = this.#requests.get(req);
    const key = state?.key;
    if (key === undefined) {
      // Cannot happen: a keyed middleware only sees keyed requests.
      throw new Error("BunCacheInterceptor: a keyed request has no key");
    }
    const value = typeof key === "function" ? key(state!.context) : key;
    if (typeof value !== "string" || value === "") {
      throw new TypeError(
        `@CacheKey() on ${routeName(state!.context)} must give a non-empty string (got ${String(value)})`,
      );
    }
    return value;
  }

  /** A request's `@CacheTags`. */
  #tagsOf(req: BunRequest): readonly string[] {
    const state = this.#requests.get(req);
    const tags = state?.tags;
    if (tags === undefined) {
      return [];
    }
    return typeof tags === "function" ? tags(state!.context) : tags;
  }

  /**
   * Registers, once, a before-write hook on the adapter (bun-nest's
   * `addBeforeWriteHook`): a response the middleware captured — and may be
   * storing — can still be refused by a later hook (`@Validate` on a
   * `@Res()` route, an application's own), and is then answered afresh with
   * an error. The refusal's answer reaches the hooks in phase `"error"`;
   * for a request this interceptor cached, its path's entries are dropped
   * through the middleware's `invalidate()`, which drops them again once
   * the writes it has in flight for the path have settled — so the refused
   * answer is never served from the cache, however late its write lands.
   */
  #hook(): void {
    if (this.#hooked) {
      return;
    }
    this.#hooked = true;
    let host: HttpAdapterHost | undefined;
    try {
      host = this.moduleRef.get(HttpAdapterHost, { strict: false });
    } catch {
      return;
    }
    const adapter = host?.httpAdapter as
      | {
          addBeforeWriteHook?: (
            hook: (write: BunBeforeWriteContext) => void,
          ) => () => void;
        }
      | undefined;
    if (typeof adapter?.addBeforeWriteHook !== "function") {
      return;
    }
    adapter.addBeforeWriteHook((write) => {
      if (write.phase !== "error") {
        return;
      }
      const state = this.#requests.get(write.request);
      if (state === undefined) {
        return;
      }
      this.#requests.delete(write.request);
      void state.middleware.invalidate(write.request).catch(() => {});
    });
  }
}

// `@Injectable()` and `@Inject(ModuleRef)` on the constructor's parameter,
// by call: Bun reads the decorator options from the working directory's
// tsconfig (oven-sh/bun#28605), and the call behaves the same under either
// decorator semantics (validation.ts has the same pattern).
Injectable()(BunCacheInterceptor);
Inject(ModuleRef)(BunCacheInterceptor, undefined, 0);

/** Checks `with()`'s options: ours here, `cacheResponse()`'s by building one (it reads no cache until a request). */
function checkOptions(options: BunCacheInterceptorOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new TypeError(
      "BunCacheInterceptor.with(): options must be an object",
    );
  }
  if (
    options.cache !== undefined &&
    (typeof options.cache !== "string" || options.cache === "")
  ) {
    throw new TypeError(
      "BunCacheInterceptor.with(): `cache` must be a cache's non-empty name, or omitted for the default cache",
    );
  }
  const { cache: _name, revalidate, ...rest } = options;
  cacheResponse(NO_CACHE_YET, {
    ...rest,
    ...(revalidate === false || revalidate === undefined ? {} : { revalidate }),
  });
}
