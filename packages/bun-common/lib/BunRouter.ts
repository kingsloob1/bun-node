import type { matchedRoute, Route } from "@routejs/router";
import type { WebSocketHandler } from "bun";
import type { BunRequest } from "./BunRequest";
import type { BunResponse } from "./BunResponse";
import type { BunWebSocket, WebSocketClientData } from "./BunWebSocket";
import type {
  Logger,
  NextFunction,
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

export interface CachedRouteMatch {
  route: Route;
  callbacks: RouterHandler[];
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
  /** The route match result (params/subdomains) for this request. */
  matched: matchedRoute;
}

/** A {@link MatchedLayerRecord} resolved against the live callback reference. */
export interface MatchedLayer extends MatchedLayerRecord {
  callback: RouterHandler | RouterErrorMiddlewareHandler;
}

export interface RouteConstructorOption {
  path?: string | null;
  callbacks: RouterHandler[];
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

export class BunRouter extends Router {
  public _logger!: Logger;
  private _bunWebSocket?: BunWebSocket;

  /** Upper bound on {@link routeCacheLayers} entries (FIFO eviction). */
  private static readonly ROUTE_CACHE_MAX = 1000;

  /**
   * Cache of the fully-resolved, request-matched pipeline for a request
   * signature (see {@link getCacheKey}). Each value is the exact array
   * {@link handle} iterates — a cache hit is a single `Map.get` with zero
   * allocation. Bounded with FIFO eviction so high-cardinality paths cannot
   * leak memory; invalidated wholesale by {@link setRoute}/{@link clearRouteCache}.
   */
  private routeCacheLayers = new Map<string, MatchedLayer[]>();

  constructor(
    private localOptions?: {
      bunWebsocket?: BunWebSocket;
      caseSensitive?: boolean;
      host?: string;
      debug?: boolean;
      logger?: Logger;
    },
  ) {
    super(pick(localOptions, ["caseSensitive", "host"]));
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
    const routes = this.routes();
    if (option.name) {
      if (routes.find((route) => route.name === option.name)) {
        throw new Error(`Route with name "${option.name}" already exists..`);
      }
    }

    const route = new RouteClass(option) as Route;
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
      callbacks: RouterHandler[] | Router;
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
    callbacks: RouterHandler[] | Router;
    group?: string | null;
    host?: string | null;
    method?: string | string[] | null;
  }) {
    if (option.callbacks instanceof Router) {
      option.callbacks.routes().forEach((route) => {
        const opts = this.getFormattedSetRouteOption(option, route);
        this.setRoute(opts);
      });
    } else if (Array.isArray(option.callbacks)) {
      for (const route of option.callbacks) {
        if (route instanceof RouteClass) {
          const opts = this.getFormattedSetRouteOption(option, route);
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
  addRoute(
    method: string,
    path?: string | RouterHandler,
    ...callbacks: RouterHandler[]
  ) {
    if (!isString(path) && path) {
      callbacks.unshift(path);
    }

    return this.setRoute({
      path: isString(path) ? path : undefined,
      method: method.toUpperCase(),
      callbacks,
    });
  }

  override checkout(path: string, ...callbacks: RouterHandler[]): this;
  override checkout(...callbacks: RouterHandler[]): this;
  override checkout(
    path?: string | RouterHandler,
    ...callbacks: RouterHandler[]
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
  override copy(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
  override delete(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
    path: string | RouterHandler,

    ...callbacks: RouterHandler[]
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
  override head(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
  override lock(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
  override merge(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
    path: string | RouterHandler,

    ...callbacks: RouterHandler[]
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
  override mkcol(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
  override move(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
  override notify(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
    path: string | RouterHandler,

    ...callbacks: RouterHandler[]
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
  override patch(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
  override post(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
    path: string | RouterHandler,

    ...callbacks: RouterHandler[]
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
  proppatch(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
  override purge(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
  override put(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
  override report(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
  override search(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
    path: string | RouterHandler,

    ...callbacks: RouterHandler[]
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
  override trace(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
  override unlock(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
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
    path: string | RouterHandler,
    ...callbacks: RouterHandler[]
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
  override view(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute("view", path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute("view", ...callbacks);
  }

  override any(
    methods: string | string[] | RouterHandler,
    ...callbacks: RouterHandler[]
  ): this;
  override any(
    methods: string | string[] | RouterHandler,
    path: string | RouterHandler,
    ...callbacks: RouterHandler[]
  ): this;
  override any(...callbacks: RouterHandler[]): this;
  override any(
    methods?: string | string[] | RouterHandler,
    path?: string | RouterHandler,
    ...callbacks: RouterHandler[]
  ) {
    let pathHandler: RouterHandler | undefined;
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
        callbacks.unshift(methods as RouterHandler, pathHandler);
      } else {
        callbacks.unshift(methods as RouterHandler);
      }
    }

    return this.setRoute({
      method: validatedMethods,
      path: pathHandler ? undefined : (path as string),
      callbacks,
    });
  }

  override all(path: string, ...callbacks: RouterHandler[]): this;
  override all(...handlers: RouterHandler[]): this;
  override all(path: string | RouterHandler, ...callbacks: RouterHandler[]) {
    if (!isString(path) && path) {
      callbacks.unshift(path);
    }

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
  override add(
    method: string,
    path?: string | RouterHandler,
    ...callbacks: RouterHandler[]
  ) {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        return this.addRoute(method, path, ...callbacks);
      }

      callbacks.unshift(path);
    }

    return this.addRoute(method, ...callbacks);
  }

  // Adjust use to behave like express use
  override use(...callbacks: RouterHandler[]): this;
  override use(path: string, ...callbacks: RouterHandler[]): this;
  override use(
    path?: string | RouterHandler,
    ...callbacks: RouterHandler[]
  ): this {
    if (isString(path) || isFunction(path)) {
      if (isString(path)) {
        // Express `use(path, ...)` is a path *prefix* match, not an exact
        // match. Registering with `group` (instead of `path`) makes
        // `@routejs/router` compile a prefix regex for the middleware.
        this.setRoute({
          group: path,
          callbacks,
        });

        return this;
      }

      callbacks.unshift(path);
    }

    this.setRoute({
      callbacks,
    });

    return this;
  }

  override group(path: string, ...callbacks: [Router]): this;
  override group(path: string, ...callbacks: RouterHandler[]): this;
  override group(
    path: string,
    ...callbacks: [(router: Router) => unknown]
  ): this;
  override group(
    path: string,
    ...callbacks: RouterHandler[] | [Router] | [(router: Router) => unknown]
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
      callbacks: callbacks as RouterHandler[],
    });
  }

  override domain(host: string, ...callbacks: [Router]): this;
  override domain(host: string, ...callbacks: RouterHandler[]): this;
  override domain(
    host: string,
    ...callbacks: [(router: Router) => unknown]
  ): this;
  override domain(
    host: string,
    ...callbacks: RouterHandler[] | [Router] | [(router: Router) => unknown]
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
      callbacks: callbacks as RouterHandler[],
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
   * Specificity comparators for matched route handlers, applied (most specific
   * first) when several routes match the same request. Middleware ordering is
   * untouched — only the relative order of competing route handlers changes.
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
   * matched route) for a request. Middleware/error handlers keep
   * route-registration order (Express semantics); when several route handlers
   * match, they are ordered by specificity.
   *
   * The result is cached per request signature: a cache hit returns the exact
   * cached array with zero allocation. The returned array and its layers must
   * be treated as read-only.
   */
  getMatchedLayers(options: RouteMatchMethodOptionType): MatchedLayer[] {
    const cacheKey = this.getCacheKey(options);
    const cache = this.routeCacheLayers;

    // Fast path: a single `Map.get`, no allocation, no bookkeeping.
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const requestPath =
      this.getRequestPathFromRequestURL(options.requestUrl) || "/";
    const routes = this.routes();

    // 1. Match every route, preserving registration order.
    const entries = routes
      .map((route, routeIndex) => {
        const matched = route.match({
          host: options.requestHost,
          method: options.requestMethod,
          path: requestPath,
        }) as matchedRoute;

        if (!isObject(matched)) {
          return undefined;
        }

        return {
          routeIndex,
          route,
          matched,
          isRouteHandler: isString(route.method) || isArray(route.method),
        };
      })
      .filter((entry) => !!entry);

    // 2. Order the matched route handlers by specificity; `orderBy` is a
    //    stable sort, so equally-specific handlers keep registration order.
    const { iteratees, orders } = this.routeSpecificityIteratees(options);
    const orderedHandlers = orderBy(
      entries.filter((entry) => entry.isRouteHandler),
      iteratees,
      orders,
    );

    // 3. Rebuild: middleware entries keep their slot; route-handler slots
    //    are filled from the specificity-ordered list.
    let handlerCursor = 0;
    const orderedEntries = entries.map((entry) =>
      entry.isRouteHandler ? orderedHandlers[handlerCursor++] : entry,
    );

    // 4. Flatten each route's callbacks into fully-resolved layers.
    const layers: MatchedLayer[] = [];
    for (const entry of orderedEntries) {
      const callbacks = (entry.route.callbacks || []) as RouterHandler[];
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
          matched: entry.matched,
          callback,
        });
      }
    }

    // 5. Cache, evicting the least-recently-used entry when full.
    if (cache.size >= BunRouter.ROUTE_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    cache.set(cacheKey, layers);

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
   *   `next('router')` abandons the router;
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

    for (let index = 0; index < layers.length; index++) {
      if (response.headersSent) {
        break;
      }

      const layer = layers[index];

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

      // 3. next('router') — abandon the entire router.
      if (nextArg === "router") {
        break;
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

      // 7. The layer neither responded nor called next(): treat its return
      //    value as the response body.
      hasError = false;
      await response.status(response.statusCode || 200).end(returned as never);
      break;
    }

    if (response.headersSent) {
      return matchedRoute ?? true;
    }

    if (hasError) {
      this.throwError(currentError);
    }

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
