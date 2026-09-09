import type { matchedRoute, Route } from "@routejs/router";
import type { WebSocketHandler } from "bun";
import type { BunRequest } from "./BunRequest";
import type { BunResponse } from "./BunResponse";
import type { BunWebSocket, WebSocketClientData } from "./BunWebSocket";
import type {
  Logger,
  NextFunction,
  RouterCallback,
  RouterErrorMiddlewareHandler,
  RouterHandler,
} from "./types/general";
import path, { join } from "node:path";
import process from "node:process";
import { Router } from "@routejs/router";
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

export interface CachedRouteMatch {
  route: Route;
  callbacks: RouterCallback[];
}

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
};

export class BunRouter extends Router {
  public _logger!: Logger;
  private _bunWebSocket?: BunWebSocket;

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

  constructor(
    private localOptions?: {
      bunWebsocket?: BunWebSocket;
      caseSensitive?: boolean;
      host?: string;
      debug?: boolean;
      logger?: Logger;
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

  get logger(): Logger {
    if (this._logger) {
      return this._logger;
    }

    if (this.localOptions?.logger) {
      return this.localOptions.logger;
    }

    // Fall back to the console rather than recursing into this getter.
    return console;
  }

  set logger(logger: Logger) {
    this._logger = logger;
  }

  setLogger(logger: Logger) {
    this.logger = logger;
    return this;
  }

  setBunWebSocket(bunWebSocket: BunWebSocket) {
    this._bunWebSocket = bunWebSocket;
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
    // Idempotent — non-catch-all paths pass through unchanged.
    if (option.path != null) {
      option.path = normalizeCatchAllPath(option.path);
    }
    if (option.group != null) {
      option.group = normalizeCatchAllPath(option.group);
    }

    const routes = this.routes();
    if (option.name) {
      if (routes.find((route) => route.name === option.name)) {
        throw new Error(`Route with name "${option.name}" already exists..`);
      }
    }

    const route = new RouteClass(option) as RouteWithGroup;
    // Stamp the active mount's group id (0 = this router's own routes) so
    // `next('router')` can later identify and skip a whole mounted sub-router.
    route.routerGroupId = this.#activeRouterGroupId;
    // Mark verb/`all` endpoints so specificity ordering and param-binding
    // treat them as route handlers, not `use` middleware.
    route.isEndpoint = isEndpoint;
    routes.push(route);
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
        // flatten so specificity ordering still treats it correctly.
        this.#pendingEndpoint = (route as RouteWithGroup).isEndpoint === true;
        this.setRoute(opts);
      });
    } else if (Array.isArray(option.callbacks)) {
      for (const route of option.callbacks) {
        if (route instanceof RouteClass) {
          const opts = this.getFormattedSetRouteOption(option, route);
          this.#pendingEndpoint = (route as RouteWithGroup).isEndpoint === true;
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

    return this;
  }

  ws(
    path: string,
    handler: WebSocketHandler<WebSocketClientData>,
    customDataToWsClientFn?: (
      req: BunRequest,
      res: BunResponse,
    ) => unknown | Promise<unknown>,
  ): this {
    const bunWebSocket = this.getBunWebsocket();
    if (bunWebSocket) {
      bunWebSocket.setRouteHandler(path, handler, customDataToWsClientFn);
    }

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
  override use(...handlers: (RouterHandler | Router)[]): this;
  override use(path: string, ...handlers: (RouterHandler | Router)[]): this;
  override use(...handlers: RouterErrorMiddlewareHandler[]): this;
  override use(path: string, ...handlers: RouterErrorMiddlewareHandler[]): this;
  override use(...handlers: (RouterCallback | Router)[]): this;
  override use(path: string, ...handlers: (RouterCallback | Router)[]): this;
  override use(
    pathOrHandler?: string | RouterCallback | Router,
    ...rest: (RouterCallback | Router)[]
  ): this {
    let path: string | undefined;
    const items: (RouterCallback | Router)[] = [];

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

  override group(path: string, ...callbacks: [Router]): this;
  override group(path: string, ...callbacks: RouterCallback[]): this;
  override group(
    path: string,
    ...callbacks: [(router: Router) => unknown]
  ): this;
  override group(
    path: string,
    ...callbacks: RouterCallback[] | [Router] | [(router: Router) => unknown]
  ) {
    const [callback] = callbacks;
    if (callback instanceof Router) {
      return this.mergeRoute({ group: path, callbacks: callback });
    }

    if (isFunction(callback)) {
      const handler = callback as (router: Router) => unknown;
      const router = new Router();
      handler(router);
      return this.mergeRoute({ group: path, callbacks: router });
    }

    return this.mergeRoute({
      group: path,
      callbacks: callbacks as RouterCallback[],
    });
  }

  override domain(host: string, ...callbacks: [Router]): this;
  override domain(host: string, ...callbacks: RouterCallback[]): this;
  override domain(
    host: string,
    ...callbacks: [(router: Router) => unknown]
  ): this;
  override domain(
    host: string,
    ...callbacks: RouterCallback[] | [Router] | [(router: Router) => unknown]
  ) {
    const [callback] = callbacks;
    if (callback instanceof Router) {
      return this.mergeRoute({ host, callbacks: callback });
    }

    if (isFunction(callback)) {
      const handler = callback as (router: Router) => unknown;
      const router = new Router();
      handler(router);
      return this.mergeRoute({ host, callbacks: router });
    }

    return this.mergeRoute({
      host,
      callbacks: callbacks as RouterCallback[],
    });
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
            subdomains[name] = decodeURIComponent(value);
          }
        }
      }
    }

    const params: Record<string, string> = {};
    const paramNames = route.params;
    if (pathMatch.length > 1 && paramNames && paramNames.length > 0) {
      for (let i = 1; i < pathMatch.length; i++) {
        const name = paramNames[i - 1];
        const value = pathMatch[i];
        if (name !== undefined && value !== undefined) {
          params[name] = decodeURIComponent(value);
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
    iteratees: ((entry: { route: Route; matched: matchedRoute }) => unknown)[];
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
        const matched = this.matchRoute(
          route,
          options.requestHost,
          options.requestMethod,
          requestPath,
        );

        if (matched === false) {
          return undefined;
        }

        const tagged = route as RouteWithGroup;
        return {
          routeIndex,
          route,
          matched,
          // Verb routes and `all` are route handlers; `use`/`useMethod`
          // middleware is not. The `isEndpoint` tag is the sole source of
          // truth, so method-scoped middleware (`useMethod`) is never treated
          // as a route handler even though it carries an HTTP method.
          isRouteHandler: tagged.isEndpoint === true,
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

    let hasError = false;
    let currentError: unknown;
    let matchedRoute: matchedRoute | undefined;
    // Set when a layer stops without responding or calling next() — the
    // request is then left hanging (see case 7 below).
    let hung = false;
    // Ids of mounted sub-routers exited via next('router'); lazily allocated
    // since next('router') is rare — no cost on the common path.
    let exitedRouters: Set<number> | undefined;

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
        request.params = layer.matched.params as Record<string, string>;
        request.subdomains = layer.matched.subdomains as string[];
        matchedRoute = layer.matched;
      }

      let nextCalled = false;
      let nextArg: unknown;
      const next: NextFunction = (arg) => {
        if (nextCalled) {
          return;
        }
        nextCalled = true;
        nextArg = arg;
      };

      let returned: unknown;
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
        this.logger.log({
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

  private throwError(errorThrown: Error | unknown | undefined) {
    if (errorThrown instanceof Error || isObject(errorThrown)) {
      throw errorThrown;
    } else if (isString(errorThrown) || isNumeric(errorThrown)) {
      throw new Error(String(errorThrown));
    } else {
      throw new Error("An error was triggered in a middleware handler");
    }
  }
}
