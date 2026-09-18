import type { matchedRoute, Route } from "@routejs/router";
import type { WebSocketHandler } from "bun";
import type { BunRequest } from "./BunRequest";
import type { BunResponse } from "./BunResponse";
import type { ValidatorMiddleware } from "./BunValidate";
import type {
  BunWebSocket,
  WebSocketClientData,
  WebSocketCustomDataFn,
  WebSocketRouteOptions,
} from "./BunWebSocket";
import type { Logger, LoggerLike } from "./logging";
import type {
  BunServer,
  NextFunction,
  RouterCallback,
  RouterErrorMiddlewareHandler,
  RouterHandler,
} from "./types/general";
import type { EmptyShape, MountedHandler } from "./types/routeTyping";
import path, { join } from "node:path";
import process from "node:process";
import { Router } from "@routejs/router";
import { BunRequest as BunRequestClass } from "./BunRequest";
import { BunResponse as BunResponseClass } from "./BunResponse";
import { resolveLogger } from "./logging";
import {
  isArray,
  isError,
  isFunction,
  isNull,
  isNumeric,
  isObject,
  isString,
  isUndefined,
  keys,
  lastIndexOf,
  orderBy,
  pick,
} from "./utils/native";

export type { matchedRoute } from "@routejs/router";

export interface RouteMatchMethodOptionType {
  requestHost: string;
  requestMethod: string;
  requestUrl: string;
}

/** A matched route handler passed to a custom route-specificity comparator. */
export interface RouteSpecificityEntry {
  /** The registered route. */
  route: Route;
  /** The match result (params/subdomains) for the current request. */
  matched: matchedRoute;
}

/**
 * Controls how competing **route handlers** (verb methods and `all`) are
 * ordered when several match the same request. Middleware registered with
 * `use` always keeps its registration order regardless of this option.
 *
 * - `false` (default) — keep registration order, exactly like Express.
 * - `true` — use BunRouter's built-in specificity ranking (static beats
 *   param, fewer params / more regexp constraints win).
 * - a comparator `(a, b) => number` — a custom rule; it is applied with a
 *   stable sort, so handlers it rates equal keep their registration order.
 */
export type RouteSpecificityOption =
  | boolean
  | ((a: RouteSpecificityEntry, b: RouteSpecificityEntry) => number);

/**
 * A route paired with its callbacks.
 *
 * Not used by the router itself: the matched-pipeline cache stores
 * {@link MatchedLayer} arrays instead. It remains exported only so existing
 * imports keep compiling.
 *
 * @deprecated Use {@link MatchedLayer} (what {@link BunRouter.getMatchedLayers}
 *   returns) instead.
 */
export interface CachedRouteMatch {
  /** The registered route. */
  route: Route;
  /** The route's callbacks, in registration order. */
  callbacks: RouterCallback[];
}

/**
 * Thrown inside {@link BunRouter.matchRoute} when a captured path or host value
 * is not valid percent-encoding. Caught by the matcher and turned into an
 * error pipeline entry; never escapes the router.
 */
class ParamDecodeFailure {
  constructor(
    /** The raw, undecodable value. */
    readonly value: string,
  ) {}
}

/**
 * `decodeURIComponent` for a captured param, as Express 5's router does it: an
 * empty value is returned as-is, and a malformed escape raises
 * {@link ParamDecodeFailure} rather than a bare `URIError`.
 */
function decodeParam(value: string): string {
  if (value.length === 0) {
    return value;
  }

  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) {
      throw new ParamDecodeFailure(value);
    }
    throw error;
  }
}

/**
 * The error Express 5 passes to `next()` for a param it cannot decode: a
 * `URIError` whose message names the raw value, with `status: 400`. A fresh
 * instance per request, since error handlers may mutate what they receive.
 */
function createParamDecodeError(value: string): URIError & { status: number } {
  return Object.assign(new URIError(`Failed to decode param '${value}'`), {
    status: 400,
  });
}

/**
 * Whether a `host` option is a literal hostname (optionally with a port), as
 * opposed to a pattern like `:tenant.example.com` or `*.example.com`. Only a
 * literal can serve as the origin {@link BunRouter.fetch} resolves paths against.
 */
const LITERAL_HOST_RE = /^[\w-]+(?:\.[\w-]+)*(?::\d+)?$/;

/**
 * A single executable unit in the request pipeline — one callback of one
 * matched route. Cached per request signature (see {@link BunRouter.getCacheKey}).
 */
export interface MatchedLayerRecord {
  /** Index of the owning route within `routes()`. */
  routeIndex: number;
  /** Index of the callback within the route's `callbacks`. */
  callbackIndex: number;
  /** True when the callback's arity is 4 — an Express-style error handler. */
  isErrorHandler: boolean;
  /** True when the owning route declares an HTTP method (a route handler). */
  isRouteHandler: boolean;
  /**
   * Id of the mounted sub-router this layer belongs to — `0` for the router's
   * own routes, a positive id for each `use(subRouter)` mount. `next('router')`
   * exits a mount by skipping every layer that shares its id.
   */
  routerId: number;
  /** The route match result (params/subdomains) for this request. */
  matched: matchedRoute;
  /**
   * `req.baseUrl` while this layer runs: the part of the request path its
   * mount (a `use(path, …)` prefix or a mounted router's path) matched, without
   * a trailing slash. `""` for a layer outside any mount.
   */
  baseUrl: string;
}

/** A {@link MatchedLayerRecord} resolved against the live callback reference. */
export interface MatchedLayer extends MatchedLayerRecord {
  callback: RouterCallback | RouterErrorMiddlewareHandler;
}

export interface RouteConstructorOption {
  path?: string | null;
  callbacks: RouterCallback[];
  name?: string | null;
  group?: string | null;
  host?: string | null;
  method?: string | string[] | null;
  caseSensitive?: boolean | null;
}

export const routeModulePath = path.join(
  path.dirname(Bun.resolveSync("@routejs/router", process.cwd())),
  "./src/route.mjs",
);

// eslint-disable-next-line ts/no-require-imports
const RouteModule = require(routeModulePath) as {
  default: {
    new (options: RouteConstructorOption): Route;
  };
};

export const RouteClass = RouteModule.default;

/**
 * Matches Express 5 catch-all path syntax — `{*name}`, `*name` (at the start
 * of the path or after a `/`), and the bare `{*}` form. Used to normalise
 * those into the routejs-compatible `*` wildcard.
 */
const EXPRESS5_CATCHALL_RE =
  /\{\*[a-z_$][\w$]*\}|(?<=^|\/)\*[a-z_$][\w$]*|\{\*\}/gi;

/**
 * Express 5 changed catch-all paths from a bare `*` to named wildcards
 * (`*name`, `{*name}`). routejs still expects the bare `*`, so we collapse
 * the Express 5 variants to `*` before registration. Non-catch-all paths
 * (`/users/:id`, `/api/v1`, …) pass through unchanged.
 */
function normalizeCatchAllPath(path: string): string {
  return path.replace(EXPRESS5_CATCHALL_RE, "*");
}

/**
 * A bare regexp group — `(\d+)` not attached to a preceding `:param`.
 * routejs assigns these a numeric param key from the *same* counter it uses
 * for wildcards, so a path containing one makes "nth numeric key" and "nth
 * wildcard" disagree.
 */
const BARE_REGEX_GROUP_RE = /(?:^|[^\w$)])\(/;

/**
 * Extracts the names of Express 5 named wildcards (`*name`, `{*name}`), in the
 * order they appear, so matches can expose `req.params.name` the way Express 5
 * does — routejs only ever produces the positional numeric key.
 *
 * Returns `undefined` when the path has no named wildcards, or when it also
 * contains a bare regexp group. In that second case routejs's numeric counter
 * covers both wildcards and groups, so the nth numeric key is not reliably the
 * nth wildcard; rather than risk binding a name to the wrong capture, the
 * positional keys are left as the only output.
 */
function extractWildcardNames(
  path: string,
): (string | undefined)[] | undefined {
  const matches = path.match(EXPRESS5_CATCHALL_RE);
  if (!matches) {
    return undefined;
  }

  const names = matches.map((token) => {
    const name = token.replace(/^\{?\*/, "").replace(/\}$/, "");
    return name || undefined;
  });

  if (!names.some((name) => name !== undefined)) {
    return undefined;
  }

  return BARE_REGEX_GROUP_RE.test(path) ? undefined : names;
}

/**
 * Default cap on the matched-pipeline cache (`routeCacheMax`).
 *
 * The cache is keyed by *resolved path*, so a route carrying an id consumes one
 * entry per distinct id seen — its size tracks traffic, not the route table.
 * Sized below the live path set, every request both misses and pays eviction,
 * which is strictly worse than no cache at all; the cap is therefore set high
 * enough to cover realistic id cardinality. Entries are small (an array of
 * layer descriptors referencing existing callbacks), so the memory ceiling is
 * modest. Override per adapter, or pass `0` to disable the cache.
 */
export const DEFAULT_ROUTE_CACHE_MAX = 50_000;

/**
 * A `@routejs/router` `Route` tagged with BunRouter metadata:
 * - `routerGroupId` — `undefined`/`0` for the router's own routes, a positive
 *   id for routes flattened in by `use(subRouter)`;
 * - `isEndpoint` — `true` for verb/`all` route handlers (specificity-sortable,
 *   they set `request.params`); `false`/absent for `use` middleware.
 */
type RouteWithGroup = Route & {
  routerGroupId?: number;
  isEndpoint?: boolean;
  /**
   * Names of the Express 5 named wildcards in this path, positionally. Set
   * only when the names can be mapped to routejs's numeric keys unambiguously
   * (see {@link extractWildcardNames}).
   */
  wildcardNames?: (string | undefined)[];
  /**
   * Prefix regex of the route's mount (its `group`), whose match on a request
   * path is `req.baseUrl`. `null` for a route outside any mount.
   */
  baseUrlRegexp?: RegExp | null;
};

/**
 * `regexp` with its case-insensitive flag matching `caseSensitive`: `i` added
 * when matching ignores case, left as it is otherwise. Returns the same
 * instance when nothing needs to change.
 */
function withCaseSensitivity(regexp: RegExp, caseSensitive: boolean): RegExp {
  if (caseSensitive || regexp.flags.includes("i")) {
    return regexp;
  }
  return new RegExp(regexp.source, `${regexp.flags}i`);
}

/** The part of `requestPath` a route's mount matched, as `req.baseUrl`. */
function matchBaseUrl(route: RouteWithGroup, requestPath: string): string {
  const regexp = route.baseUrlRegexp;
  if (!regexp) {
    return "";
  }
  const matched = regexp.exec(requestPath)?.[0] ?? "";
  // Express strips the trailing slash: a router mounted at `/` has baseUrl "".
  return matched.endsWith("/") ? matched.replace(/\/+$/, "") : matched;
}

/**
 * Whether a route being flattened in from another router is a route handler.
 *
 * A BunRouter route carries the answer in `isEndpoint`. A route from a plain
 * `@routejs/router` `Router` does not, so it is inferred the way that router
 * builds them: verb/`all`/`any`/`add` routes have a `path`, while `use`
 * middleware has only a `group` prefix.
 */
function isEndpointRoute(route: Route): boolean {
  const tagged = route as RouteWithGroup;
  return tagged.isEndpoint ?? (route.path !== null && route.path !== undefined);
}

/**
 * A router the untyped `use` overloads accept: a plain `@routejs/router`
 * `Router`, or a `BunRouter` that declared no mount context.
 *
 * A router that *did* declare one must go through the typed `use` overloads,
 * which check the declaration against the path it is actually mounted at.
 * Without this the wide overload would swallow a mismatch silently.
 */
export type UnmountedRouter = Router & {
  readonly __mount?: { path: ""; shape: EmptyShape };
};

/**
 * What {@link BunRouter.fetch} accepts.
 *
 * - a `Request` — used as-is
 * - a `string` or `URL` — a `GET` to that path or URL
 * - a `RequestInit` carrying a `url` — any method, headers and body
 */
/**
 * The callback form of `group()`/`domain()`, as the implementation receives it.
 * Its parameter is `never` so that every overload's callback, whatever mount
 * its router declares, fits; the overloads above it carry the real types.
 */
type GroupCallback = (router: never) => void;

export type FetchInput =
  | string
  | URL
  | Request
  | (RequestInit & { url: string | URL });

/** Origin used when {@link BunRouter.fetch} is given a bare path. */
const FETCH_DEFAULT_ORIGIN = "http://localhost";

/**
 * A stand-in for the `Bun.serve` server that {@link BunRouter.fetch} passes to
 * `BunRequest`. There is no socket, so there is no peer address, and an
 * upgrade cannot succeed — reporting that honestly is better than pretending.
 */
const fetchStubServer: Pick<BunServer, "requestIP" | "upgrade"> = {
  requestIP: () => null,
  upgrade: () => false,
};

export const FETCH_STUB_SERVER = fetchStubServer as Parameters<
  typeof BunRequestClass.init
>[1];

/**
 * Whether `input` is a `Request`, recognised by shape rather than by
 * `instanceof`.
 *
 * `instanceof Request` compares against whatever `globalThis.Request` is at
 * call time. A DOM shim (happy-dom's `GlobalRegistrator`, jsdom) replaces it,
 * after which a native Bun `Request` fails the check and would be taken for a
 * bodiless `GET`. Capturing the native constructor at module load does not
 * fix that either: a shim registered in a test preload is installed before
 * this module loads. A `RequestInit` never has `arrayBuffer`, and a `URL` has
 * neither `method` nor `arrayBuffer`, so the forms cannot be confused.
 */
function isRequestLike(input: unknown): input is Request {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const candidate = input as Partial<Record<keyof Request, unknown>>;
  return (
    typeof candidate.url === "string" &&
    typeof candidate.method === "string" &&
    typeof candidate.arrayBuffer === "function"
  );
}

/** Builds a native `Request` from anything {@link FetchInput} allows. */
export function toNativeRequest(
  input: FetchInput,
  init?: RequestInit,
  origin: string = FETCH_DEFAULT_ORIGIN,
): Request {
  if (isRequestLike(input)) {
    // Already a request: `init` would have to rebuild it (and re-read its
    // body), so it is ignored rather than silently half-applied.
    return input;
  }

  // The init form is the only object form carrying a `url`; any other
  // non-string is a `URL`. Told apart by shape for the same reason as above:
  // a shim may replace `globalThis.URL` too.
  const initForm =
    typeof input === "object" && "url" in input && input.url !== undefined
      ? input
      : undefined;
  const target = initForm ? initForm.url : (input as string | URL);
  const options: RequestInit | undefined = initForm
    ? { ...initForm, ...init }
    : init;

  // `Request` accepts a string or another `Request`, not a `URL`.
  const url = new URL(String(target), origin).href;
  return new Request(url, options);
}

export class BunRouter<
  /**
   * Path this router is mounted at, when it is used as a sub-router. Declared
   * on construction so routes registered here can type the mount's params:
   * `new BunRouter<"/users/:id">()`. Defaults to `""` — an unmounted router,
   * for which the mount contributes nothing.
   */
  TMountPath extends string = "",
  /**
   * Shape validated at the mount point, when a `BunValidate` middleware is
   * registered alongside this router in `use()`. Only its `query` and `body`
   * reach handlers here; see {@link MergeShape}.
   */
  TMountShape = EmptyShape,
  /**
   * Host pattern a `domain()` scoped this router to (`":tenant.example.com"`),
   * whose captures reach `req.params` alongside the path's. Set by the
   * `domain(host, (router) => …)` callback's router, and carried into a
   * `group()` inside it. Defaults to `""` — no host, no host params.
   *
   * The `host` constructor option is deliberately not inferred into it: a
   * `domain()` on such a router overrides that host at runtime, while a
   * `domain()` nested inside another keeps the outer one, and a single type
   * parameter cannot tell those two apart.
   */
  THost extends string = "",
> extends Router {
  /**
   * Phantom record of the declared mount, so `BunRouter<"/users/:id">` and an
   * unmounted `BunRouter` are structurally different types and `use()` can
   * reject a mismatch. `declare` emits no field, so nothing exists at runtime.
   */
  declare readonly __mount?: { path: TMountPath; shape: TMountShape };

  public _logger!: Logger;
  private _bunWebSocket?: BunWebSocket;

  /** Router-wide `101` headers — see {@link webSocketUpgradeHeaders}. */
  #webSocketUpgradeHeaders: Headers | undefined = undefined;

  /** Router-wide `ws.data` base — see {@link webSocketUpgradeData}. */
  #webSocketUpgradeData: Partial<WebSocketClientData> | undefined = undefined;

  /**
   * Upper bound on {@link routeCacheLayers} entries before FIFO eviction.
   * Set via the `routeCacheMax` constructor option; defaults to
   * {@link DEFAULT_ROUTE_CACHE_MAX}. `0` means the cache is disabled and every
   * request matches from scratch.
   */
  private readonly routeCacheMax: number;

  /**
   * Cache of the fully-resolved, request-matched pipeline for a request
   * signature (see {@link getCacheKey}). Each value is the exact array
   * {@link handle} iterates — a cache hit is a single `Map.get` with zero
   * allocation. Bounded with FIFO eviction so high-cardinality paths cannot
   * leak memory; invalidated wholesale by {@link setRoute}/{@link clearRouteCache}.
   */
  private routeCacheLayers = new Map<string, MatchedLayer[]>();

  /** Allocates a fresh group id for the next `use(subRouter)` mount. */
  #nextRouterGroupId = 1;
  /**
   * Group id stamped onto routes created while a `use(subRouter)` mount is in
   * progress. `0` means "the router's own routes" (the default).
   */
  #activeRouterGroupId = 0;

  /**
   * Stamped onto the next route {@link setRoute} creates, marking it a
   * verb/`all` endpoint (vs `use` middleware). Consumed (reset) by `setRoute`.
   */
  #pendingEndpoint = false;

  /** How competing route handlers are ordered — see {@link RouteSpecificityOption}. */
  #routeSpecificity: RouteSpecificityOption;

  /**
   * The route the last verb, `all`, `any` or `add` call registered — what
   * {@link setName} names. `null` after anything else (`use`, `group`,
   * `domain`, a mount), exactly as `@routejs/router` tracks it, so `setName`
   * after middleware throws.
   */
  #lastRoute: Route | null = null;

  constructor(
    private localOptions?: {
      /**
       * The {@link BunWebSocket} that {@link BunRouter.ws} registers WebSocket
       * routes on. {@link BunRouter.setBunWebSocket} takes precedence over it.
       */
      bunWebsocket?: BunWebSocket;
      /**
       * Whether path (and host) matching is case-sensitive: with `true`,
       * `/Users` does not match `/users`. Defaults to `false`, like Express and
       * `@routejs/router`. Applies to every route registered on this router,
       * including routes flattened in by `use(router)`, `group()` and
       * `domain()` — the mounting router's setting wins over the sub-router's.
       */
      caseSensitive?: boolean;
      /**
       * Default host pattern for every route registered on this router, as in
       * `@routejs/router`: with `"api.example.com"`, routes answer only
       * requests for that host. Accepts the same patterns as {@link domain}
       * (`":tenant.example.com"`, `"*.example.com"`), and a route's own host
       * (from `domain()`) overrides it. A literal hostname is also the origin
       * {@link BunRouter.fetch} resolves a bare path against; for a pattern,
       * `fetch()` falls back to `http://localhost`.
       */
      host?: string;
      /**
       * Logs one `debug` record per pipeline layer run. Defaults to `false`;
       * the logger's level must also admit `debug`.
       */
      debug?: boolean;
      /**
       * Logger for router diagnostics. Accepts a {@link Logger} or any
       * supported logging library (pino, winston, consola, log4js, tslog,
       * bunyan, NestJS) — see {@link resolveLogger}. Defaults to a console
       * logger.
       */
      logger?: LoggerLike;
      /**
       * Upper bound on the matched-pipeline cache before FIFO eviction kicks
       * in. Defaults to {@link DEFAULT_ROUTE_CACHE_MAX} (50 000). Pass `0` to
       * disable the cache entirely (every request then matches from scratch);
       * a negative or non-numeric value falls back to the default.
       *
       * The cache is keyed by resolved path, so a route carrying an id needs
       * one entry per distinct id seen. Size this above the number of distinct
       * paths in flight, or set `0` — a value between the two means every
       * request misses *and* pays eviction.
       */
      routeCacheMax?: number;
      /**
       * How competing route handlers are ordered. Defaults to `false` —
       * registration order, like Express. See {@link RouteSpecificityOption}.
       */
      routeSpecificity?: RouteSpecificityOption;
    },
  ) {
    super(pick(localOptions, ["caseSensitive", "host"]));

    // `0` disables the cache; a positive value caps it; anything else
    // (negative, non-numeric, absent) falls back to the default.
    const max = localOptions?.routeCacheMax;
    if (isNumeric(max)) {
      const parsed = Math.floor(Number(max));
      this.routeCacheMax = parsed >= 0 ? parsed : DEFAULT_ROUTE_CACHE_MAX;
    } else {
      this.routeCacheMax = DEFAULT_ROUTE_CACHE_MAX;
    }

    this.#routeSpecificity = localOptions?.routeSpecificity ?? false;
  }

  /**
   * Sets how competing route handlers are ordered (see
   * {@link RouteSpecificityOption}) and drops the matched-pipeline cache so
   * the new ordering takes effect immediately.
   */
  setRouteSpecificity(value: RouteSpecificityOption): this {
    this.#routeSpecificity = value ?? false;
    this.clearRouteCache();
    return this;
  }

  /**
   * The router's logger, resolved once on first use: the constructor option
   * when given (adapted from pino/winston/console/... by
   * {@link resolveLogger}), else a default console logger.
   */
  get logger(): Logger {
    this._logger ??= resolveLogger(this.localOptions?.logger);
    return this._logger;
  }

  /** Replaces the logger. Accepts any {@link LoggerLike}. */
  set logger(logger: LoggerLike) {
    this._logger = resolveLogger(logger);
  }

  /** Replaces the logger and returns the router, for chaining. */
  setLogger(logger: LoggerLike) {
    this.logger = logger;
    return this;
  }

  setBunWebSocket(bunWebSocket: BunWebSocket) {
    this._bunWebSocket = bunWebSocket;
  }

  /**
   * Router-wide headers for the `101` of every WebSocket upgrade this router
   * is the source of defaults for: its own `ws()` routes (wherever the route
   * was registered — see {@link ws}), and a bare `res.upgradeToWebsocket()`
   * in a request this router's {@link handle} runs. The lowest header layer:
   * `res.webSocketUpgradeHeaders`, then the route's `onUpgrade` headers or
   * `upgradeToWebsocket`'s `options.headers`, replace them per header name.
   * Read at upgrade time, so a change applies to the next upgrade.
   * Accepts any `HeadersInit` (copied); reads back as a `Headers`, or
   * `undefined` when none are set (the default). Assign `undefined` to clear.
   */
  get webSocketUpgradeHeaders(): Headers | undefined {
    return this.#webSocketUpgradeHeaders;
  }

  set webSocketUpgradeHeaders(headers: Bun.HeadersInit | undefined) {
    this.#webSocketUpgradeHeaders =
      headers === undefined ? undefined : new Headers(headers);
  }

  /** Sets {@link webSocketUpgradeHeaders} and returns the router, for chaining. */
  setWebSocketUpgradeHeaders(headers: Bun.HeadersInit | undefined): this {
    this.webSocketUpgradeHeaders = headers;
    return this;
  }

  /**
   * Router-wide base for `ws.data`, for the same upgrades as
   * {@link webSocketUpgradeHeaders}: merged shallowly over the data built from
   * the request, then `res.webSocketUpgradeData` over it (later wins per key),
   * then an `onUpgrade` hook's `custom`. Ignored where the data is given
   * outright — `res.upgradeToWebsocket(data)` or a hook's `data`. A `ws()`
   * route's `route`/`params`/`port` always come from its match. `custom` is
   * not type-checked against a route's `TCustom`. Stored as a shallow copy;
   * `undefined` (the default) clears it.
   */
  get webSocketUpgradeData(): Partial<WebSocketClientData> | undefined {
    return this.#webSocketUpgradeData;
  }

  set webSocketUpgradeData(data: Partial<WebSocketClientData> | undefined) {
    this.#webSocketUpgradeData = data === undefined ? undefined : { ...data };
  }

  /** Sets {@link webSocketUpgradeData} and returns the router, for chaining. */
  setWebSocketUpgradeData(
    data: Partial<WebSocketClientData> | undefined,
  ): this {
    this.webSocketUpgradeData = data;
    return this;
  }

  getBunWebsocket() {
    return this._bunWebSocket || this.localOptions?.bunWebsocket;
  }

  setRoute(option: RouteConstructorOption) {
    // Consume the endpoint flag up-front so a thrown duplicate-name error
    // cannot leak it onto the next route registered.
    const isEndpoint = this.#pendingEndpoint;
    this.#pendingEndpoint = false;

    // Express 5 catch-all syntax (`*name` / `{*name}`) → routejs's `*`.
    // Idempotent — non-catch-all paths pass through unchanged. The names are
    // captured first so matches can expose them as Express 5 does.
    let wildcardNames: (string | undefined)[] | undefined;
    if (option.path != null) {
      wildcardNames = extractWildcardNames(option.path);
      option.path = normalizeCatchAllPath(option.path);
    }
    if (option.group != null) {
      wildcardNames ??= extractWildcardNames(option.group);
      option.group = normalizeCatchAllPath(option.group);
    }

    const routes = this.routes();
    if (option.name) {
      if (routes.some((route) => route.name === option.name)) {
        throw new Error(`Route with name "${option.name}" already exists..`);
      }
    }

    // `@routejs/router` applies its `caseSensitive` and `host` config in its
    // own private `#setRoute`, which BunRouter bypasses — so apply them here,
    // the same way: the router's settings, unless the route brings its own.
    const caseSensitive =
      option.caseSensitive ?? this.localOptions?.caseSensitive ?? false;
    const route = new RouteClass({
      ...option,
      host: option.host ?? this.localOptions?.host,
      caseSensitive,
    }) as RouteWithGroup;
    // A route without a `path` is middleware, which routejs compiles as a
    // *prefix* regex — rebuilt from the exact one's `source` with no flags, so
    // the `i` it was compiled with is lost and `use("/Admin")` would refuse
    // `/admin/x` however `caseSensitive` is set. Express 5 applies the setting
    // to `use()` prefixes and routes alike, so restore it.
    if (option.path == null) {
      route.pathRegexp = withCaseSensitivity(route.pathRegexp, caseSensitive);
    }
    // `req.baseUrl` comes from the route's mount prefix. Middleware already
    // compiled `group` as a prefix regex; a route handler compiled its full
    // path instead, so its prefix gets a regex of its own.
    route.baseUrlRegexp =
      option.group == null
        ? null
        : option.path == null
          ? route.pathRegexp
          : withCaseSensitivity(
              new RouteClass({
                group: option.group,
                callbacks: [],
                caseSensitive,
              }).pathRegexp,
              caseSensitive,
            );
    // Stamp the active mount's group id (0 = this router's own routes) so
    // `next('router')` can later identify and skip a whole mounted sub-router.
    route.routerGroupId = this.#activeRouterGroupId;
    // Mark verb/`all` endpoints so specificity ordering and param-binding
    // treat them as route handlers, not `use` middleware.
    route.isEndpoint = isEndpoint;
    route.wildcardNames = wildcardNames;
    routes.push(route);
    // Only a route handler can be named — see `setName`.
    this.#lastRoute = isEndpoint ? route : null;
    // The route table changed — drop the matched-pipeline cache so a route
    // registered after the first request is still picked up.
    if (this.routeCacheLayers.size) {
      this.routeCacheLayers.clear();
    }
    return this;
  }

  private getFormattedSetRouteOption(
    option: Pick<RouteConstructorOption, "host" | "method" | "group"> & {
      callbacks: RouterCallback[] | Router;
    },
    route: Route,
  ) {
    return {
      host: option?.host || route.host,
      method: option?.method || route.method,
      path: option?.group
        ? route.path
          ? join(option.group, route.path)
          : null
        : route.path,
      callbacks: route.callbacks,
      group: option.group ? join(option.group, route.group ?? "") : route.group,
      name: route.name,
    };
  }

  private mergeRoute(option: {
    callbacks: RouterCallback[] | Router;
    group?: string | null;
    host?: string | null;
    method?: string | string[] | null;
  }) {
    if (option.callbacks instanceof Router) {
      option.callbacks.routes().forEach((route) => {
        const opts = this.getFormattedSetRouteOption(option, route);
        // Preserve the source route's verb/`all` endpoint status across the
        // flatten so specificity ordering and param binding still treat it
        // correctly.
        this.#pendingEndpoint = isEndpointRoute(route);
        this.setRoute(opts);
      });
    } else if (Array.isArray(option.callbacks)) {
      for (const route of option.callbacks) {
        if (route instanceof RouteClass) {
          const opts = this.getFormattedSetRouteOption(option, route);
          this.#pendingEndpoint = isEndpointRoute(route);
          this.setRoute(opts);
        } else if (Array.isArray(route) || route instanceof Router) {
          this.mergeRoute({
            ...option,
            callbacks: route,
          });
        } else {
          this.setRoute(option as RouteConstructorOption);
          break;
        }
      }
    } else {
      this.setRoute(option as RouteConstructorOption);
    }

    // As in `@routejs/router`: a merge registers no nameable route, so a
    // following `setName()` throws rather than renaming a flattened route.
    this.#lastRoute = null;
    return this;
  }

  /**
   * Registers a WebSocket route: a `GET` upgrade request for `path` is upgraded
   * and its connection dispatched to `handler`.
   *
   * The route is added through the attached {@link BunWebSocket} (the
   * `bunWebsocket` option, or {@link setBunWebSocket}) — on *its* router,
   * which is not necessarily this one; a {@link BunHttpAdapter} attaches its
   * own. The upgrade route is in place when this returns.
   *
   * `options.onUpgrade` is the route's {@link WebSocketUpgradeHook}: its
   * `custom` becomes `ws.data.custom`, its `headers` go out on the `101`, and
   * its `data` replaces `ws.data` (with `route`/`params`/`port` filled in from
   * the match where it leaves them out). It replaces the `BunWebSocket`'s
   * instance-wide `onUpgrade` for this route.
   *
   * The router-wide {@link webSocketUpgradeHeaders} and
   * {@link webSocketUpgradeData} that apply are **this** router's — the one
   * `ws()` was called on — even when the route lands on another router, or
   * this one is mounted in another with `use()`.
   *
   * `TCustom` is the type of `ws.data.custom`. On a `BunHttpAdapter` it
   * defaults to the adapter's WebSocket data type; on a bare router it is
   * inferred from the hook's `custom`, or given explicitly:
   * `router.ws<{ userId: string }>("/chat", handler, { onUpgrade })`. With
   * neither it stays `unknown`: nothing says what the data holds.
   *
   * @param path Route pattern, e.g. `/rooms/:id`.
   * @param handler Bun's `WebSocketHandler` for the route's connections.
   * @param options Per-route {@link WebSocketRouteOptions}. Default: none.
   * @throws Error when no `BunWebSocket` is attached — registering a route
   *   that could never upgrade would otherwise fail silently.
   * @throws TypeError when `handler` is not a handler object.
   */
  ws<TCustom = unknown>(
    path: string,
    handler: WebSocketHandler<WebSocketClientData<TCustom>>,
    options?: WebSocketRouteOptions<TCustom>,
  ): this;
  /**
   * Registers a WebSocket route whose third argument maps the upgrade request
   * to `ws.data.custom`. The function's result is always `custom`, whatever
   * its shape — `{ data, headers }` included — and `TCustom` is inferred from
   * it.
   *
   * @deprecated Pass `{ onUpgrade }` returning `{ custom }` instead.
   */
  ws<TCustom = unknown>(
    path: string,
    handler: WebSocketHandler<WebSocketClientData<TCustom>>,
    customDataToWsClientFn: WebSocketCustomDataFn<TCustom>,
  ): this;
  ws<TCustom = unknown>(
    path: string,
    handler: WebSocketHandler<WebSocketClientData<TCustom>>,
    fnOrOptions?:
      | WebSocketRouteOptions<TCustom>
      | WebSocketCustomDataFn<TCustom>,
  ): this {
    const bunWebSocket = this.getBunWebsocket() as
      | BunWebSocket<TCustom>
      | undefined;
    if (!bunWebSocket) {
      throw new Error(
        `ws("${path}"): no BunWebSocket is attached to this router. Pass the ` +
          "`bunWebsocket` option or call setBunWebSocket() first, or register " +
          "the route on a BunHttpAdapter.",
      );
    }
    if (!isObject(handler)) {
      throw new TypeError(`ws("${path}"): the handler must be an object.`);
    }

    // `setRouteHandler` is async but registers the route before its first
    // await, so the route exists once this returns. Its promise is still
    // observed, so a failure is logged rather than becoming an unhandled
    // rejection.
    // `this` is where the router-wide upgrade defaults come from, not the
    // socket's router the route is registered on.
    bunWebSocket
      .setRouteHandler(path, handler, fnOrOptions, this)
      .catch((error: unknown) => {
        this.logger.error("ws(): failed to register the WebSocket route", {
          error,
          path,
        });
      });

    return this;
  }

  addRoute(method: string, ...callbacks: RouterHandler[]): this;
  addRoute(method: string, path: string, ...callbacks: RouterHandler[]): this;
  addRoute(method: string, ...callbacks: RouterErrorMiddlewareHandler[]): this;
  addRoute(
    method: string,
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  addRoute(method: string, ...callbacks: RouterCallback[]): this;
  addRoute(method: string, path: string, ...callbacks: RouterCallback[]): this;
  addRoute(
    method: string,
    path?: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ) {
    if (!isString(path) && path) {
      callbacks.unshift(path);
    }

    // A verb route is a route handler — eligible for specificity ordering.
    this.#pendingEndpoint = true;
    return this.setRoute({
      path: isString(path) ? path : undefined,
      method: method.toUpperCase(),
      callbacks,
    });
  }

  /* --- BEGIN generated typed overloads: checkout --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override checkout<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override checkout<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override checkout<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override checkout<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override checkout<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override checkout<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override checkout<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override checkout<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override checkout<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override checkout<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: checkout --- */
  override checkout(path: string, ...callbacks: RouterHandler[]): this;
  override checkout(...callbacks: RouterHandler[]): this;
  override checkout(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override checkout(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override checkout(path: string, ...callbacks: RouterCallback[]): this;
  override checkout(...callbacks: RouterCallback[]): this;
  override checkout(
    path?: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("checkout", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("checkout", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: copy --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: copy --- */
  override copy(path: string, ...callbacks: RouterHandler[]): this;
  override copy(...callbacks: RouterHandler[]): this;
  override copy(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override copy(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override copy(path: string, ...callbacks: RouterCallback[]): this;
  override copy(...callbacks: RouterCallback[]): this;
  override copy(path: string | RouterCallback, ...callbacks: RouterCallback[]) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("copy", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("copy", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: delete --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: delete --- */
  override delete(path: string, ...callbacks: RouterHandler[]): this;
  override delete(...callbacks: RouterHandler[]): this;
  override delete(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override delete(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override delete(path: string, ...callbacks: RouterCallback[]): this;
  override delete(...callbacks: RouterCallback[]): this;
  override delete(
    path: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("delete", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("delete", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: get --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: get --- */
  override get(path: string, ...callbacks: RouterHandler[]): this;
  override get(...callbacks: RouterHandler[]): this;
  override get(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override get(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override get(path: string, ...callbacks: RouterCallback[]): this;
  override get(...callbacks: RouterCallback[]): this;
  override get(
    path: string | RouterCallback,

    ...callbacks: RouterCallback[]
  ): this {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("get", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("get", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: head --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: head --- */
  override head(path: string, ...callbacks: RouterHandler[]): this;
  override head(...callbacks: RouterHandler[]): this;
  override head(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override head(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override head(path: string, ...callbacks: RouterCallback[]): this;
  override head(...callbacks: RouterCallback[]): this;
  override head(path: string | RouterCallback, ...callbacks: RouterCallback[]) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("head", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("head", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: lock --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: lock --- */
  override lock(path: string, ...callbacks: RouterHandler[]): this;
  override lock(...callbacks: RouterHandler[]): this;
  override lock(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override lock(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override lock(path: string, ...callbacks: RouterCallback[]): this;
  override lock(...callbacks: RouterCallback[]): this;
  override lock(path: string | RouterCallback, ...callbacks: RouterCallback[]) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("lock", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("lock", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: merge --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override merge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override merge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override merge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override merge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override merge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override merge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override merge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override merge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override merge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override merge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: merge --- */
  override merge(path: string, ...callbacks: RouterHandler[]): this;
  override merge(...callbacks: RouterHandler[]): this;
  override merge(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override merge(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override merge(path: string, ...callbacks: RouterCallback[]): this;
  override merge(...callbacks: RouterCallback[]): this;
  override merge(
    path: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("merge", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("merge", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: mkactivity --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override mkactivity<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkactivity<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkactivity<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkactivity<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkactivity<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkactivity<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkactivity<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkactivity<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkactivity<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkactivity<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: mkactivity --- */
  override mkactivity(path: string, ...callbacks: RouterHandler[]): this;
  override mkactivity(...callbacks: RouterHandler[]): this;
  override mkactivity(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override mkactivity(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override mkactivity(path: string, ...callbacks: RouterCallback[]): this;
  override mkactivity(...callbacks: RouterCallback[]): this;
  override mkactivity(
    path: string | RouterCallback,

    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("mkactivity", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("mkactivity", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: mkcol --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: mkcol --- */
  override mkcol(path: string, ...callbacks: RouterHandler[]): this;
  override mkcol(...callbacks: RouterHandler[]): this;
  override mkcol(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override mkcol(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override mkcol(path: string, ...callbacks: RouterCallback[]): this;
  override mkcol(...callbacks: RouterCallback[]): this;
  override mkcol(
    path: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("mkcol", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("mkcol", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: move --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: move --- */
  override move(path: string, ...callbacks: RouterHandler[]): this;
  override move(...callbacks: RouterHandler[]): this;
  override move(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override move(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override move(path: string, ...callbacks: RouterCallback[]): this;
  override move(...callbacks: RouterCallback[]): this;
  override move(path: string | RouterCallback, ...callbacks: RouterCallback[]) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("move", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("move", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: notify --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override notify<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override notify<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override notify<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override notify<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override notify<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override notify<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override notify<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override notify<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override notify<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override notify<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: notify --- */
  override notify(path: string, ...callbacks: RouterHandler[]): this;
  override notify(...callbacks: RouterHandler[]): this;
  override notify(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override notify(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override notify(path: string, ...callbacks: RouterCallback[]): this;
  override notify(...callbacks: RouterCallback[]): this;
  override notify(
    path: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("notify", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("notify", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: options --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: options --- */
  override options(path: string, ...callbacks: RouterHandler[]): this;
  override options(...callbacks: RouterHandler[]): this;
  override options(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override options(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override options(path: string, ...callbacks: RouterCallback[]): this;
  override options(...callbacks: RouterCallback[]): this;
  override options(
    path: string | RouterCallback,

    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("options", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("options", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: patch --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: patch --- */
  override patch(path: string, ...callbacks: RouterHandler[]): this;
  override patch(...callbacks: RouterHandler[]): this;
  override patch(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override patch(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override patch(path: string, ...callbacks: RouterCallback[]): this;
  override patch(...callbacks: RouterCallback[]): this;
  override patch(
    path: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("patch", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("patch", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: post --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: post --- */
  override post(path: string, ...callbacks: RouterHandler[]): this;
  override post(...callbacks: RouterHandler[]): this;
  override post(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override post(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override post(path: string, ...callbacks: RouterCallback[]): this;
  override post(...callbacks: RouterCallback[]): this;
  override post(path: string | RouterCallback, ...callbacks: RouterCallback[]) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("post", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("post", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: propfind --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: propfind --- */
  override propfind(path: string, ...callbacks: RouterHandler[]): this;
  override propfind(...callbacks: RouterHandler[]): this;
  override propfind(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override propfind(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override propfind(path: string, ...callbacks: RouterCallback[]): this;
  override propfind(...callbacks: RouterCallback[]): this;
  override propfind(
    path: string | RouterCallback,

    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("propfind", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("propfind", ...callbacks);
  }

  // `@routejs/router` has no `proppatch`; defined here so the NestJS adapter's
  // delegated `proppatch` (a WebDAV verb) resolves to a real method.
  proppatch(path: string, ...callbacks: RouterHandler[]): this;
  proppatch(...callbacks: RouterHandler[]): this;
  proppatch(path: string, ...callbacks: RouterErrorMiddlewareHandler[]): this;
  proppatch(...callbacks: RouterErrorMiddlewareHandler[]): this;
  proppatch(path: string, ...callbacks: RouterCallback[]): this;
  proppatch(...callbacks: RouterCallback[]): this;
  proppatch(path: string | RouterCallback, ...callbacks: RouterCallback[]) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("proppatch", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("proppatch", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: purge --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override purge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override purge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override purge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override purge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override purge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override purge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override purge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override purge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override purge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override purge<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: purge --- */
  override purge(path: string, ...callbacks: RouterHandler[]): this;
  override purge(...callbacks: RouterHandler[]): this;
  override purge(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override purge(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override purge(path: string, ...callbacks: RouterCallback[]): this;
  override purge(...callbacks: RouterCallback[]): this;
  override purge(
    path: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("purge", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("purge", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: put --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: put --- */
  override put(path: string, ...callbacks: RouterHandler[]): this;
  override put(...callbacks: RouterHandler[]): this;
  override put(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override put(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override put(path: string, ...callbacks: RouterCallback[]): this;
  override put(...callbacks: RouterCallback[]): this;
  override put(path: string | RouterCallback, ...callbacks: RouterCallback[]) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("put", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("put", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: report --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override report<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override report<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override report<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override report<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override report<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override report<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override report<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override report<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override report<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override report<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: report --- */
  override report(path: string, ...callbacks: RouterHandler[]): this;
  override report(...callbacks: RouterHandler[]): this;
  override report(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override report(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override report(path: string, ...callbacks: RouterCallback[]): this;
  override report(...callbacks: RouterCallback[]): this;
  override report(
    path: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("report", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("report", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: search --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: search --- */
  override search(path: string, ...callbacks: RouterHandler[]): this;
  override search(...callbacks: RouterHandler[]): this;
  override search(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override search(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override search(path: string, ...callbacks: RouterCallback[]): this;
  override search(...callbacks: RouterCallback[]): this;
  override search(
    path: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("search", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("search", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: subscribe --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override subscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override subscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override subscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override subscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override subscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override subscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override subscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override subscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override subscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override subscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: subscribe --- */
  override subscribe(path: string, ...callbacks: RouterHandler[]): this;
  override subscribe(...callbacks: RouterHandler[]): this;
  override subscribe(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override subscribe(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override subscribe(path: string, ...callbacks: RouterCallback[]): this;
  override subscribe(...callbacks: RouterCallback[]): this;
  override subscribe(
    path: string | RouterCallback,

    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("subscribe", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("subscribe", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: trace --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override trace<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override trace<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override trace<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override trace<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override trace<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override trace<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override trace<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override trace<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override trace<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override trace<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: trace --- */
  override trace(path: string, ...callbacks: RouterHandler[]): this;
  override trace(...callbacks: RouterHandler[]): this;
  override trace(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override trace(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override trace(path: string, ...callbacks: RouterCallback[]): this;
  override trace(...callbacks: RouterCallback[]): this;
  override trace(
    path: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("trace", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("trace", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: unlock --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: unlock --- */
  override unlock(path: string, ...callbacks: RouterHandler[]): this;
  override unlock(...callbacks: RouterHandler[]): this;
  override unlock(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override unlock(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override unlock(path: string, ...callbacks: RouterCallback[]): this;
  override unlock(...callbacks: RouterCallback[]): this;
  override unlock(
    path: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("unlock", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("unlock", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: unsubscribe --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override unsubscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unsubscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unsubscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unsubscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unsubscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unsubscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unsubscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unsubscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unsubscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override unsubscribe<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: unsubscribe --- */
  override unsubscribe(path: string, ...callbacks: RouterHandler[]): this;
  override unsubscribe(...callbacks: RouterHandler[]): this;
  override unsubscribe(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override unsubscribe(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override unsubscribe(path: string, ...callbacks: RouterCallback[]): this;
  override unsubscribe(...callbacks: RouterCallback[]): this;
  override unsubscribe(
    path: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("unsubscribe", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("unsubscribe", ...callbacks);
  }

  /* --- BEGIN generated typed overloads: view --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override view<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override view<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override view<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override view<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override view<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override view<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override view<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override view<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override view<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override view<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: view --- */
  override view(path: string, ...callbacks: RouterHandler[]): this;
  override view(...callbacks: RouterHandler[]): this;
  override view(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override view(...callbacks: RouterErrorMiddlewareHandler[]): this;
  override view(path: string, ...callbacks: RouterCallback[]): this;
  override view(...callbacks: RouterCallback[]): this;
  override view(path: string | RouterCallback, ...callbacks: RouterCallback[]) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("view", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("view", ...callbacks);
  }

  override any(
    methods: string | string[] | RouterCallback,
    ...callbacks: RouterCallback[]
  ): this;
  override any(
    methods: string | string[] | RouterCallback,
    path: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ): this;
  override any(...callbacks: RouterCallback[]): this;
  override any(
    methods?: string | string[] | RouterCallback,
    path?: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ) {
    let pathHandler: RouterCallback | undefined;
    if (!isString(path) && path) {
      pathHandler = path;
    }

    let validatedMethods: string | string[] | undefined;
    if (
      isString(methods) ||
      (isArray(methods) && methods.every((method) => isString(method)))
    ) {
      validatedMethods = methods;

      if (pathHandler) {
        callbacks.unshift(pathHandler);
      }
    } else {
      if (pathHandler) {
        callbacks.unshift(methods as RouterCallback, pathHandler);
      } else {
        callbacks.unshift(methods as RouterCallback);
      }
    }

    // `any` registers a route handler for the given verbs.
    this.#pendingEndpoint = true;
    return this.setRoute({
      method: validatedMethods,
      path: pathHandler ? undefined : (path as string),
      callbacks,
    });
  }

  /* --- BEGIN generated typed overloads: all --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<TMountPath, TMountShape, TPath, TShape, THost>,
  ): this;
  /* --- END generated typed overloads: all --- */
  override all(path: string, ...callbacks: RouterHandler[]): this;
  override all(...handlers: RouterHandler[]): this;
  override all(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override all(...handlers: RouterErrorMiddlewareHandler[]): this;
  override all(path: string, ...callbacks: RouterCallback[]): this;
  override all(...handlers: RouterCallback[]): this;
  override all(path: string | RouterCallback, ...callbacks: RouterCallback[]) {
    if (!isString(path) && path) {
      callbacks.unshift(path);
    }

    // `all` is a method-agnostic route handler — it is specificity-sortable
    // alongside the verb routes, unlike `use` middleware.
    this.#pendingEndpoint = true;
    return this.setRoute({
      path: isString(path) ? path : undefined,
      callbacks,
    });
  }

  override add(method: string, ...callbacks: RouterHandler[]): this;
  override add(
    method: string,
    path: string,
    ...callbacks: RouterHandler[]
  ): this;
  override add(method: string, ...callbacks: RouterCallback[]): this;
  override add(
    method: string,
    path: string,
    ...callbacks: RouterCallback[]
  ): this;
  override add(
    method: string,
    path?: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute(method, path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute(method, ...callbacks);
  }

  // Adjust use to behave like Express 5 `use` — it accepts middleware
  // functions and/or mounted sub-routers, with an optional leading path.
  /* --- typed mount overloads (hand-written; `use` is excluded from the
     generator because it mounts on a path *prefix*) --- */

  /**
   * Mounts a sub-router at `path`, requiring the sub-router to have been
   * declared with the same mount path.
   *
   * `new BunRouter<"/users/:id">()` lets routes registered on the sub-router
   * see `params.id`; this signature is what keeps that declaration honest — a
   * sub-router declaring a different path is not assignable here, so the two
   * cannot drift apart.
   */
  override use<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    // `NoInfer` on the path matters: without it `TPath` also infers from the
    // router, and TypeScript reconciles the two candidates by widening to
    // their union — which both arguments then satisfy, so a mismatched mount
    // slips through.
    //
    // `TShape` is inferred from the router and then required to be empty. Any
    // object is assignable to `EmptyShape`, so asking for that directly would
    // let a sub-router expecting validated `query` mount without the validator
    // that produces it; resolving to `never` rejects it instead.
    router: BunRouter<NoInfer<TPath>, TShape> &
      (keyof TShape extends never ? unknown : never),
  ): this;

  /**
   * Mounts a sub-router behind a validator. The validated `query` and `body`
   * reach the sub-router's handlers, so its declared mount shape must match.
   *
   * Validated `params` are deliberately *not* part of that contract: the
   * pipeline rebinds `req.params` on entering each matched route, so a
   * mount-level params replacement is overwritten before a sub-router handler
   * runs. See {@link MergeShape}.
   */
  override use<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    // Only `query` and `body` reach the sub-router, so only those have to
    // agree. Requiring `params` to match too would force a sub-router to
    // declare a shape it can never actually observe.
    router: BunRouter<NoInfer<TPath>, NoInfer<Omit<TShape, "params">>>,
  ): this;

  override use(...handlers: (RouterHandler | UnmountedRouter)[]): this;
  override use(
    path: string,
    ...handlers: (RouterHandler | UnmountedRouter)[]
  ): this;
  override use(...handlers: RouterErrorMiddlewareHandler[]): this;
  override use(path: string, ...handlers: RouterErrorMiddlewareHandler[]): this;
  override use(...handlers: (RouterCallback | UnmountedRouter)[]): this;
  override use(
    path: string,
    ...handlers: (RouterCallback | UnmountedRouter)[]
  ): this;
  override use(
    pathOrHandler?: string | RouterCallback | Router,
    ...rest: (RouterCallback | UnmountedRouter)[]
  ): this {
    let path: string | undefined;
    const items: (RouterCallback | UnmountedRouter)[] = [];

    if (isString(pathOrHandler)) {
      path = pathOrHandler;
    } else if (pathOrHandler !== undefined) {
      items.push(pathOrHandler);
    }
    items.push(...rest);

    // Buffer consecutive middleware functions into a single route so their
    // registration order relative to any mounted sub-routers is preserved.
    let pending: RouterCallback[] = [];
    const flushPending = () => {
      if (!pending.length) {
        return;
      }
      // Express `use(path, ...)` is a path *prefix* match, not an exact match.
      // Registering with `group` makes `@routejs/router` compile a prefix
      // regex; a bare `use(...)` matches every path.
      this.setRoute(
        path ? { group: path, callbacks: pending } : { callbacks: pending },
      );
      pending = [];
    };

    for (const item of items) {
      if (item instanceof Router) {
        // A mounted sub-router (Express 5 `use(router)` / `use(path, router)`).
        flushPending();
        this.mountRouter(item, path);
      } else {
        pending.push(item);
      }
    }
    flushPending();

    return this;
  }

  /**
   * Flattens a sub-router's routes into this router — Express 5
   * `use(router)` / `use(path, router)`. Every flattened route is tagged with
   * a fresh group id so `next('router')` can later skip the whole mount as a
   * unit and hand off to the next matching router.
   */
  private mountRouter(router: Router, path?: string) {
    const groupId = this.#nextRouterGroupId++;
    const previous = this.#activeRouterGroupId;
    this.#activeRouterGroupId = groupId;
    try {
      this.mergeRoute(
        path ? { group: path, callbacks: router } : { callbacks: router },
      );
    } finally {
      this.#activeRouterGroupId = previous;
    }
  }

  /**
   * Registers **method-scoped middleware** — like {@link use}, but it runs
   * only for a given HTTP method. The route keeps the middleware semantics of
   * `use` (it is **not** an endpoint: `isEndpoint` stays `false`, so it keeps
   * registration order and is never specificity-sorted, exactly like `use`).
   *
   * A falsy method or `"ALL"` makes it method-agnostic, identical to `use`.
   * With a path it is a prefix match, like `use(path, ...)`.
   */
  useMethod(method: string, ...callbacks: RouterHandler[]): this;
  useMethod(method: string, path: string, ...callbacks: RouterHandler[]): this;
  useMethod(method: string, ...callbacks: RouterErrorMiddlewareHandler[]): this;
  useMethod(
    method: string,
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  useMethod(method: string, ...callbacks: RouterCallback[]): this;
  useMethod(method: string, path: string, ...callbacks: RouterCallback[]): this;
  useMethod(
    method: string,
    path?: string | RouterCallback,
    ...callbacks: RouterCallback[]
  ): this {
    if (!isString(path) && path) {
      callbacks.unshift(path);
      path = undefined;
    }

    const normalized = isString(method) ? method.trim().toUpperCase() : "";
    // `setRoute` leaves `#pendingEndpoint` false, so the route is middleware
    // (not a route handler) — it is excluded from specificity ordering.
    this.setRoute({
      method: normalized && normalized !== "ALL" ? normalized : undefined,
      // `group` is a prefix match, mirroring `use(path, ...)`.
      group: isString(path) ? path : undefined,
      callbacks,
    });

    return this;
  }

  /**
   * Registers routes under a path prefix, in one of three forms:
   *
   * - `group(path, router)` — flattens `router`'s routes in, each prefixed.
   * - `group(path, (router) => { ... })` — `@routejs/router`'s callback form:
   *   the callback fills a fresh `BunRouter`, whose routes are then flattened in
   *   the same way. Its route handlers bind `req.params` like any other route.
   * - `group(path, ...callbacks)` — prefix middleware, like `use(path, ...)`.
   *
   * The callback and middleware forms are told apart by arity, since both are
   * functions: a **single** function declaring at most one parameter is the
   * callback form (every function is, to `@routejs/router`); several functions,
   * or one declaring `(req, res)` or more, are middleware. A one-parameter
   * `(req) => ...` handler is therefore read as the callback form — register it
   * with `use(path, handler)` instead.
   *
   * A **lone inline** middleware arrow needs `satisfies RouterHandler` to be
   * typed: TypeScript tries the `(router) => …` overload first, and once that
   * fails on arity it cannot contextually type the arrow's parameters again.
   * Several callbacks, or a declared handler, need nothing.
   *
   * In the callback form the router is typed as mounted at this router's mount
   * path plus `path`, so its routes see the group's params:
   * `group("/users/:id", (r) => r.get("/posts", (req) => req.params.id))`. A
   * callback declared ahead with a plain `(router: BunRouter) => …` still
   * matches, through the untyped overload after it. Inside a `domain()`
   * callback the host carries over, since a group adds no host of its own.
   */
  override group(path: string, router: Router): this;
  override group<TPath extends string>(
    path: TPath,
    callback: (
      router: BunRouter<`${TMountPath}${TPath}`, TMountShape, THost>,
    ) => void,
  ): this;
  override group(path: string, callback: (router: BunRouter) => void): this;
  // `RouterHandler` ahead of the `RouterCallback` union, as for the verbs: a
  // union of arities gives an inline arrow no signature to be typed against.
  // (Named `handlers`, so the verb-overload generator does not take `group`
  // for a verb.)
  override group(path: string, ...handlers: RouterHandler[]): this;
  override group(
    path: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override group(path: string, ...callbacks: RouterCallback[]): this;
  override group(
    path: string,
    ...callbacks: RouterCallback[] | [Router] | [GroupCallback]
  ) {
    const source = this.resolveGroupCallbacks(callbacks);
    return this.mergeRoute({ group: path, callbacks: source });
  }

  /**
   * Registers routes for a host pattern (`"api.example.com"`,
   * `":tenant.example.com"`, `"*.example.com"`), in the same three forms as
   * {@link group}: a router, a `(router) => { ... }` callback, or host-scoped
   * middleware `(...callbacks)`, told apart the same way.
   *
   * Params captured by the host pattern are merged into `req.params` (a path
   * param of the same name wins); `req.subdomains` stays the request's own
   * subdomain list.
   *
   * The callback's router is typed with this router's own mount, since a host
   * adds no path, and with the host pattern, so its handlers see the host's
   * captures next to the path's:
   * `domain(":tenant.example.com", (r) => r.get("/users/:id", (req) => req.params))`
   * gives `{ tenant: string; id: string }`. A `domain()` nested inside another
   * keeps the outer host, as the runtime does — the outer host is applied last
   * when the routes are flattened in.
   */
  override domain(host: string, router: Router): this;
  override domain<THostPattern extends string>(
    host: THostPattern,
    callback: (
      router: BunRouter<
        TMountPath,
        TMountShape,
        THost extends "" ? THostPattern : THost
      >,
    ) => void,
  ): this;
  override domain(host: string, callback: (router: BunRouter) => void): this;
  override domain(host: string, ...callbacks: RouterHandler[]): this;
  override domain(
    host: string,
    ...callbacks: RouterErrorMiddlewareHandler[]
  ): this;
  override domain(host: string, ...callbacks: RouterCallback[]): this;
  override domain(
    host: string,
    ...callbacks: RouterCallback[] | [Router] | [GroupCallback]
  ) {
    const source = this.resolveGroupCallbacks(callbacks);
    return this.mergeRoute({ host, callbacks: source });
  }

  /**
   * Resolves `group()`/`domain()` arguments to what {@link mergeRoute} takes:
   * a router as-is, the callback form run against a fresh `BunRouter`, or the
   * middleware list unchanged. See {@link group} for how the forms are told
   * apart.
   */
  private resolveGroupCallbacks(
    callbacks: RouterCallback[] | [Router] | [GroupCallback],
  ): RouterCallback[] | Router {
    const [first] = callbacks;
    if (first instanceof Router) {
      return first;
    }

    if (callbacks.length === 1 && isFunction(first) && first.length <= 1) {
      // A `BunRouter`, not a plain routejs `Router`, so the routes it collects
      // are tagged as route handlers and bind their params. Its declared mount
      // is a compile-time view; at runtime every router is the same class.
      const router = new BunRouter();
      (first as (router: BunRouter) => void)(router);
      return router;
    }

    return callbacks as RouterCallback[];
  }

  /**
   * Names the route the previous verb, `all`, `any` or `add` call registered,
   * as `@routejs/router` does: `router.get("/users/:id", h).setName("user")`.
   * A named route can be looked up with {@link getRouteByName}, and built into
   * a path with `route(name, params)`.
   *
   * @throws TypeError when the previous registration was not a route handler
   *   (`use`, `group`, `domain`, a mount) — middleware cannot be named.
   * @throws Error when another route already has the name.
   */
  override setName(name: string): this {
    const route = this.#lastRoute;
    if (!route) {
      throw new TypeError("setName can not set name for middleware");
    }

    if (
      name &&
      this.routes().some(
        (existing) => existing !== route && existing.name === name,
      )
    ) {
      throw new Error(`Route with name "${name}" already exists..`);
    }

    route.setName(name);
    return this;
  }

  getRouteByName(name: string): Route | undefined {
    return name
      ? this.routes().find((route) => route?.name === name)
      : undefined;
  }

  protected getRequestPathFromRequestURL(requestUrl: string) {
    let requestPath = requestUrl;
    if (requestUrl.includes("?")) {
      requestPath = requestUrl.slice(0, requestUrl.indexOf("?"));
    }

    return requestPath;
  }

  getCacheKey(options: RouteMatchMethodOptionType) {
    const requestPath = this.getRequestPathFromRequestURL(options.requestUrl);
    return `host:${options.requestHost || "none"}:path:${requestPath}:method:${options.requestMethod}`;
  }

  /**
   * Runs a request through the router and resolves the `Response`, without
   * binding a socket.
   *
   * The same contract as `Bun.serve`'s `fetch` — a `Request` in, a `Response`
   * out — so a test exercises the real pipeline (matching, middleware order,
   * error handling, `next('route')`) rather than a parallel code path. No port
   * is opened, so nothing to clean up and no chance of a port collision.
   *
   * `BunHttpAdapter` overrides this to route through its full request handler,
   * so its not-found and error handlers apply too.
   *
   * @example
   * ```ts
   * await router.fetch("/users/42");                       // GET
   * await router.fetch({ url: "/users", method: "POST", body });
   * await router.fetch(new Request("http://localhost/x")); // full control
   * ```
   *
   * @param input A `Request`, a path/URL (implying `GET`), or a `RequestInit`
   *   carrying a `url`.
   * @param init  Extra `RequestInit` applied when `input` is a path or URL.
   */
  async fetch(input: FetchInput, init?: RequestInit): Promise<Response> {
    const host = this.localOptions?.host;
    const nativeRequest = toNativeRequest(
      input,
      init,
      // A host *pattern* is not an origin; only a literal hostname is.
      host && LITERAL_HOST_RE.test(host) ? `http://${host}` : undefined,
    );

    const created = BunRequestClass.init(nativeRequest, FETCH_STUB_SERVER, {
      parseBody: true,
      parseCookies: true,
      parseQuery: true,
    });
    const request =
      created instanceof BunRequestClass ? created : await created;
    const response = new BunResponseClass(request);

    const handled = await this.handle({
      requestHost: request.host,
      requestMethod: request.method,
      requestUrl: request.originalUrl,
      request,
      response,
    });

    if (response.settledResponse) {
      return response.settledResponse;
    }
    if (handled) {
      return response.getNativeResponse(0);
    }

    // Nothing matched, exactly as the adapter reports when no route claims a
    // request and no not-found handler is registered.
    return new Response(null, { status: 404, statusText: "Not Found" });
  }

  clearRouteCache() {
    this.routeCacheLayers.clear();

    return this;
  }

  /**
   * Matches one route against a request, replacing `@routejs/router`'s
   * `Route.match`.
   *
   * Semantics are identical — same host/method/path rules, same
   * `decodeURIComponent`'d params and subdomains, `false` for no match — but
   * routejs memoizes every `RegExp.exec` in a 250-entry LRU per route, and that
   * LRU costs far more than the regex it caches: measured at 1793ns per call
   * once the path set exceeds its capacity, against 70ns to simply run the
   * regex. Since the number of *distinct paths* in real traffic is unbounded
   * (any route with an id in it), that LRU thrashes permanently in production
   * and turns a sub-microsecond match into a multi-microsecond one.
   *
   * Executing the precompiled regexes directly removes the memoization, and
   * with it the cliff: cost becomes flat in path cardinality.
   *
   * The checks run cheapest-first (method, then path, then host) rather than in
   * routejs's order; every rejection path returns the same `false`, so the
   * reordering is observationally identical while skipping work sooner.
   *
   * Two deliberate departures from routejs, both following Express 5: a
   * captured value that is not valid percent-encoding throws
   * {@link ParamDecodeFailure} (routejs throws a bare `URIError` out of the
   * whole request), and host-pattern captures are merged into `params`.
   */
  private matchRoute(
    route: Route,
    requestHost: string,
    requestMethod: string,
    requestPath: string,
  ): matchedRoute | false {
    const pathRegexp = route.pathRegexp;
    if (pathRegexp === null || pathRegexp === undefined) {
      return false;
    }

    // 1. Method — a string compare, so it rejects non-matching routes first.
    const routeMethod = route.method;
    if (routeMethod) {
      const method = requestMethod.toUpperCase();
      if (isArray(routeMethod)) {
        if (!routeMethod.includes(method)) {
          return false;
        }
      } else if (method !== routeMethod) {
        return false;
      }
    }

    // 2. Path.
    const pathMatch = pathRegexp.exec(requestPath);
    if (pathMatch === null) {
      return false;
    }

    // 3. Host — only routes that declare one pay for this.
    let subdomains: Record<string, string> = {};
    const params: Record<string, string> = {};
    const hostRegexp = route.hostRegexp;
    if (hostRegexp) {
      const hostMatch = hostRegexp.exec(requestHost);
      if (hostMatch === null) {
        return false;
      }

      const subdomainNames = route.subdomains;
      if (hostMatch.length > 1 && subdomainNames && subdomainNames.length > 0) {
        subdomains = {};
        for (let i = 1; i < hostMatch.length; i++) {
          const name = subdomainNames[i - 1];
          const value = hostMatch[i];
          if (name !== undefined && value !== undefined) {
            const decoded = decodeParam(value);
            subdomains[name] = decoded;
            // Host params reach handlers through `req.params`; the path's
            // params are assigned below and win on a shared name.
            params[name] = decoded;
          }
        }
      }
    }

    const paramNames = route.params;
    if (pathMatch.length > 1 && paramNames && paramNames.length > 0) {
      // Names of this route's Express 5 named wildcards, positionally.
      const wildcardNames = (route as RouteWithGroup).wildcardNames;
      let wildcardOrdinal = 0;

      for (let i = 1; i < pathMatch.length; i++) {
        const name = paramNames[i - 1];
        const value = pathMatch[i];
        if (name === undefined || value === undefined) {
          continue;
        }

        const decoded = decodeParam(value);
        params[name] = decoded;

        // routejs keys wildcards positionally (`"0"`, `"1"`, …). Express 5
        // exposes `*name` as `req.params.name`, so publish that alias too,
        // keeping the positional key for backwards compatibility.
        if (wildcardNames !== undefined && isNumeric(name)) {
          const wildcardName = wildcardNames[wildcardOrdinal++];
          if (wildcardName !== undefined) {
            params[wildcardName] = decoded;
          }
        }
      }
    }

    // Mirrors routejs: the returned descriptor carries the *route's* own host,
    // method and path, not the request's.
    return {
      host: route.host,
      method: route.method,
      path: route.path,
      callbacks: route.callbacks,
      params,
      subdomains,
    } as matchedRoute;
  }

  /**
   * BunRouter's built-in specificity ranking — the comparators used when the
   * `routeSpecificity` option is `true`. Orders matched route handlers most
   * specific first; middleware ordering is untouched.
   */
  private routeSpecificityIteratees(options: RouteMatchMethodOptionType): {
    iteratees: ((entry: RouteSpecificityEntry) => number)[];
    orders: ("asc" | "desc")[];
  } {
    return {
      iteratees: [
        // Exact host match beats a non-match (lower is better).
        ({ matched }) =>
          isString(matched.host) &&
          String(matched.host).toLowerCase() ===
            String(options.requestHost).toLowerCase()
            ? 0
            : 1,
        // A more specific (longer) declared host wins.
        ({ route }) => String(route.host || "").length,
        // Exact method match beats a wildcard (lower is better).
        ({ matched }) =>
          String(matched.method).toLowerCase() ===
          String(options.requestMethod).toLowerCase()
            ? 0
            : 1,
        // Fewer path params means a more specific (more static) path.
        ({ route }) => (route.params || []).length,
        // More named params wins over numeric/anonymous ones.
        ({ matched }) =>
          keys(matched.params || {}).filter((key) => !isNumeric(key)).length,
        // More regexp-constrained params wins.
        ({ matched }) => {
          let path = String(matched.path || "");
          if (!path.startsWith("/")) {
            path = `/${path}`;
          }
          return path.split("/:").filter((part) => {
            const open = String(part).indexOf("(", 0);
            const close = lastIndexOf(String(part), ")");
            return open > -1 && close > open;
          }).length;
        },
      ],
      orders: ["asc", "desc", "asc", "asc", "desc", "desc"],
    };
  }

  /**
   * Resolves the ordered list of pipeline layers (every callback of every
   * matched route) for a request. Middleware keeps registration order
   * (Express semantics); competing route handlers (verb methods + `all`) are
   * reordered only when the `routeSpecificity` option is enabled.
   *
   * The result is cached per request signature: a cache hit returns the exact
   * cached array with zero allocation. The returned array and its layers must
   * be treated as read-only.
   */
  getMatchedLayers(options: RouteMatchMethodOptionType): MatchedLayer[] {
    const cache = this.routeCacheLayers;
    // `routeCacheMax: 0` disables the cache outright — skip building the key so
    // a disabled cache costs nothing, not even its string concatenation.
    const cacheEnabled = this.routeCacheMax > 0;
    const cacheKey = cacheEnabled ? this.getCacheKey(options) : "";

    if (cacheEnabled) {
      // Fast path: a single `Map.get`, no allocation, no bookkeeping.
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const requestPath =
      this.getRequestPathFromRequestURL(options.requestUrl) || "/";
    const routes = this.routes();

    // 1. Match every route, preserving registration order.
    const entries = routes
      .map((route, routeIndex) => {
        let matched: matchedRoute | false;
        // Set when the route matched but a captured value would not decode.
        let decodeFailure: string | undefined;
        try {
          matched = this.matchRoute(
            route,
            options.requestHost,
            options.requestMethod,
            requestPath,
          );
        } catch (error) {
          if (!(error instanceof ParamDecodeFailure)) {
            throw error;
          }
          // Express 5: the layer whose params cannot be decoded is not run;
          // a 400 `URIError` enters the pipeline at its position instead, so
          // earlier layers still run and error handlers after it see it.
          decodeFailure = error.value;
          matched = {
            host: route.host,
            method: route.method,
            path: route.path,
            callbacks: route.callbacks,
            params: {},
            subdomains: {},
          } as matchedRoute;
        }

        if (matched === false) {
          return undefined;
        }

        const tagged = route as RouteWithGroup;
        return {
          routeIndex,
          route,
          matched,
          decodeFailure,
          baseUrl: matchBaseUrl(tagged, requestPath),
          // Verb routes and `all` are route handlers; `use`/`useMethod`
          // middleware is not. The `isEndpoint` tag is the sole source of
          // truth, so method-scoped middleware (`useMethod`) is never treated
          // as a route handler even though it carries an HTTP method. A route
          // that failed to decode is neither: it only raises its error, from
          // its registration slot.
          isRouteHandler:
            tagged.isEndpoint === true && decodeFailure === undefined,
          // 0 = this router's own routes; > 0 = a mounted sub-router.
          routerId: tagged.routerGroupId ?? 0,
        };
      })
      .filter((entry) => !!entry);

    // 2. Order the matched route handlers (verb methods + `all`). Middleware
    //    registered via `use` always keeps its registration order; route
    //    handlers are reordered only when the `routeSpecificity` option is
    //    set (default: registration order, like Express).
    const specificity = this.#routeSpecificity;
    let orderedEntries = entries;
    if (specificity) {
      const routeHandlers = entries.filter((entry) => entry.isRouteHandler);
      let ordered: typeof routeHandlers;
      if (typeof specificity === "function") {
        // Custom comparator — `Array.prototype.sort` is stable, so handlers
        // it rates equal keep their registration order.
        ordered = routeHandlers.sort(specificity);
      } else {
        // `true` → BunRouter's built-in specificity ranking (`orderBy` is a
        // stable sort, so equally-specific handlers keep registration order).
        const { iteratees, orders } = this.routeSpecificityIteratees(options);
        ordered = orderBy(routeHandlers, iteratees, orders);
      }

      // 3. Rebuild: middleware entries keep their slot; route-handler slots
      //    are filled from the ordered list.
      let handlerCursor = 0;
      orderedEntries = entries.map((entry) =>
        entry.isRouteHandler ? ordered[handlerCursor++] : entry,
      );
    }

    // 4. Flatten each route's callbacks into fully-resolved layers.
    const layers: MatchedLayer[] = [];
    for (const entry of orderedEntries) {
      const failedValue = entry.decodeFailure;
      if (failedValue !== undefined) {
        // One layer standing in for the whole route, raising a fresh error per
        // request (this array is cached and shared).
        const raiseDecodeError: RouterHandler = (_req, _res, next) =>
          next(createParamDecodeError(failedValue));
        layers.push({
          routeIndex: entry.routeIndex,
          callbackIndex: 0,
          isErrorHandler: false,
          isRouteHandler: false,
          routerId: entry.routerId,
          matched: entry.matched,
          baseUrl: entry.baseUrl,
          callback: raiseDecodeError,
        });
        continue;
      }

      const callbacks = (entry.route.callbacks || []) as RouterCallback[];
      for (
        let callbackIndex = 0;
        callbackIndex < callbacks.length;
        callbackIndex++
      ) {
        const callback = callbacks[callbackIndex];
        if (!isFunction(callback)) {
          continue;
        }

        layers.push({
          routeIndex: entry.routeIndex,
          callbackIndex,
          // Express identifies error handlers purely by arity (4 params).
          isErrorHandler: callback.length === 4,
          isRouteHandler: entry.isRouteHandler,
          routerId: entry.routerId,
          matched: entry.matched,
          baseUrl: entry.baseUrl,
          callback,
        });
      }
    }

    // 5. Cache, evicting the oldest entry when full. Skipped entirely when the
    //    cache is disabled (`routeCacheMax: 0`).
    if (cacheEnabled) {
      if (cache.size >= this.routeCacheMax) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }
      cache.set(cacheKey, layers);
    }

    return layers;
  }

  /**
   * Runs the request through the matched pipeline using Express 5 semantics:
   *
   * - middleware and route handlers run in registration order;
   * - a callback with 4 parameters is an **error handler**;
   * - a thrown error, a rejected promise, or `next(err)` switches the pipeline
   *   into *error mode* — regular middleware/handlers are skipped and only
   *   error handlers run (invoked as `(err, req, res, next)`);
   * - an error handler that calls `next()` with no argument clears the error
   *   and resumes normal processing; `next(err)` keeps propagating;
   * - `next('route')` skips the rest of the current route's callbacks;
   * - `next('router')` exits the current mounted sub-router and hands off to
   *   the next matching router (a sibling mount, or the parent's own routes);
   *   from the router's own routes it abandons the whole pipeline;
   * - `next()` is the **only** way to advance the pipeline (Express/Fastify
   *   semantics): a middleware or verb/`all` handler that neither sends a
   *   response nor calls `next()` leaves the request **hanging** until its
   *   timeout fires — it is not auto-responded, does not fall through, and is
   *   not turned into a 404. A handler's return value is ignored;
   * - an unhandled error is re-thrown for the adapter's final error handler.
   */
  override async handle(options: {
    requestHost: string;
    requestMethod: string;
    requestUrl: string;
    request: BunRequest;
    response: BunResponse;
  }): Promise<matchedRoute | true | undefined> {
    const { request, response } = options;
    const layers = this.getMatchedLayers(options);
    // Where a bare `res.upgradeToWebsocket()` reads router-wide upgrade
    // defaults: the outermost router running the request.
    response.webSocketUpgradeDefaults ??= this;

    let hasError = false;
    let currentError: unknown;
    let matchedRoute: matchedRoute | undefined;
    // Set when a layer stops without responding or calling next() — the
    // request is then left hanging (see case 7 below).
    let hung = false;
    // Ids of mounted sub-routers exited via next('router'); lazily allocated
    // since next('router') is rare — no cost on the common path.
    let exitedRouters: Set<number> | undefined;
    // Index of the route whose params are currently bound to the request, so
    // params are rebound when the pipeline moves to a different route and not
    // between callbacks of the same one. `-1` means nothing is bound yet.
    let paramsBoundToRoute = -1;

    for (let index = 0; index < layers.length; index++) {
      if (response.headersSent) {
        break;
      }

      const layer = layers[index];

      // A sub-router exited via next('router') is fully skipped — including
      // its error handlers — wherever specificity ordering placed its layers.
      if (exitedRouters !== undefined && exitedRouters.has(layer.routerId)) {
        continue;
      }

      // Error-mode gate: regular layers run only when there is no active
      // error; error handlers run only when there is one.
      if (hasError !== layer.isErrorHandler) {
        continue;
      }

      if (layer.isRouteHandler) {
        // Bind params once per *route*, not once per callback. Express sets
        // them when a route is entered and lets that route's callbacks share
        // them, so a middleware may replace `req.params` for the handlers that
        // follow it in the same route — re-binding on every callback would
        // silently undo that.
        //
        // Note the bound object comes from the matched-pipeline cache and is
        // therefore shared by every request with the same signature: replace
        // `req.params` wholesale, never mutate it in place.
        if (layer.routeIndex !== paramsBoundToRoute) {
          request.params = layer.matched.params as Record<string, string>;
          // Express sets `req.route` on entering a route. `req.subdomains` is
          // left alone: it is the request's subdomain list (a `string[]`),
          // while a `domain()` pattern's captures are already in `params`.
          request.route = layer.matched;
          paramsBoundToRoute = layer.routeIndex;
        }
        matchedRoute = layer.matched;
      }

      let nextCalled = false;
      let nextArg: Parameters<NextFunction>[0];
      const next: NextFunction = (arg) => {
        if (nextCalled) {
          return;
        }
        nextCalled = true;
        nextArg = arg;
      };

      // Express sets both on entering each layer: `baseUrl` to the layer's
      // mount (restored to `""` outside it), and `next` so response helpers
      // such as `res.format()` can hand an error to the pipeline.
      request.baseUrl = layer.baseUrl;
      request.next = next;

      // A handler's return value is ignored, so it stays opaque.
      let returned: unknown;
      // Anything can be thrown.
      let thrownError: unknown;
      let didThrow = false;
      try {
        const invoked = layer.isErrorHandler
          ? (layer.callback as RouterErrorMiddlewareHandler)(
              currentError,
              request,
              response,
              next,
            )
          : (layer.callback as RouterHandler)(request, response, next);
        // Only pay a microtask hop when the handler is genuinely async; a
        // synchronous handler resolves the layer without one.
        returned =
          invoked != null &&
          typeof (invoked as { then?: unknown }).then === "function"
            ? await (invoked as Promise<unknown>)
            : invoked;
      } catch (error) {
        didThrow = true;
        thrownError = error;
      }

      if (this.localOptions?.debug) {
        this.logger.debug("pipeline layer executed", {
          state: layer.isErrorHandler
            ? "error_handler"
            : layer.isRouteHandler
              ? "route_handler"
              : "middleware",
          path: matchedRoute?.path,
          hasSentHeaders: response.headersSent,
          nextFnCalled: nextCalled,
          sentResp: !!returned,
        });
      }

      // 1. A synchronous throw or a rejected promise enters error mode.
      if (didThrow) {
        hasError = true;
        currentError = thrownError;
        continue;
      }

      // 2. The layer produced the response itself.
      if (response.headersSent) {
        break;
      }

      // 3. next('router') — exit the current router. From a mounted
      //    sub-router (routerId > 0) this skips every remaining layer of that
      //    mount and hands off to the next matching router / the parent's own
      //    routes. From the router's own routes (routerId 0) it abandons the
      //    whole pipeline, exactly like Express.
      if (nextArg === "router") {
        if (layer.routerId === 0) {
          break;
        }
        (exitedRouters ??= new Set<number>()).add(layer.routerId);
        continue;
      }

      // 4. next('route') — skip the remaining callbacks of the current route.
      if (nextArg === "route") {
        hasError = false;
        const { routeIndex } = layer;
        while (
          index + 1 < layers.length &&
          layers[index + 1].routeIndex === routeIndex
        ) {
          index++;
        }
        continue;
      }

      // 5. next(err) — an explicit error; hand off to error handlers.
      if (
        nextCalled &&
        !isUndefined(nextArg) &&
        !isNull(nextArg) &&
        nextArg !== "skip"
      ) {
        hasError = true;
        currentError = isError(nextArg) ? nextArg : new Error(String(nextArg));
        continue;
      }

      // 6. next() / next('skip') — clear any active error and continue.
      if (nextCalled) {
        hasError = false;
        continue;
      }

      // 7. The handler neither sent a response nor called next(). Express /
      //    Fastify semantics: `next()` is the *only* way to advance the
      //    pipeline, so the request is left hanging — no auto-response, no
      //    fall-through, no 404. It resolves only when the request timeout
      //    fires. The handler's return value is intentionally ignored.
      hung = true;
      break;
    }

    if (response.headersSent) {
      return matchedRoute ?? true;
    }

    if (hasError) {
      this.throwError(currentError);
    }

    if (hung) {
      // A handler stopped without responding or calling next(). Return a
      // truthy result so the adapter keeps awaiting the (never-produced)
      // response instead of 404ing — the request hangs until it times out.
      return matchedRoute ?? true;
    }

    // The pipeline ran to exhaustion via next() (or nothing matched): the
    // request is genuinely unhandled — the adapter turns this into a 404.
    return undefined;
  }

  /** Re-throws a pipeline error, wrapping a primitive in an `Error`. */
  private throwError(errorThrown: unknown): never {
    if (errorThrown instanceof Error || isObject(errorThrown)) {
      throw errorThrown;
    } else if (isString(errorThrown) || isNumeric(errorThrown)) {
      throw new Error(String(errorThrown));
    } else {
      throw new Error("An error was triggered in a middleware handler");
    }
  }
}
