import type { WebSocketHandler } from "bun";
import type { BunRequest } from "./BunRequest";
import type { BunResponse } from "./BunResponse";
import type { BunWebSocket, WebSocketClientData } from "./BunWebSocket";
import type { Logger, NextFunction, RouterHandler } from "./types/general";
import path, { join } from "node:path";
import process from "node:process";
import { type matchedRoute, type Route, Router } from "@routejs/router";
import isNumeric from "fast-isnumeric";
import {
  get,
  isArray,
  isBoolean,
  isError,
  isFunction,
  isNull,
  isObject,
  isString,
  isUndefined,
  keys,
  lastIndexOf,
  orderBy,
  pick,
} from "lodash-es";

export interface RouteMatchMethodOptionType {
  requestHost: string;
  requestMethod: string;
  requestUrl: string;
}

export interface CachedRouteMatch {
  route: Route;
  callbacks: RouterHandler[];
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
  private _globalMiddlewares: Map<string, Route> = new Map();
  private _hasSetGlobalMiddlewares = false;
  private routeCacheRouteMiddlewares = new Map<
    string,
    {
      routeIndex: string;
      callbackIndexes: string[];
    }[]
  >();

  private routeCacheGlobalMiddlewares = new Map<
    string,
    {
      routeIndex: string;
      callbackIndexes: string[];
    }[]
  >();

  private routeCacheRouteHandlers = new Map<string, string[]>();

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

  get logger() {
    if (this._logger) {
      return this._logger;
    }

    if (this.localOptions?.logger) {
      return this.localOptions.logger;
    }

    return this.logger;
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
    this.routes().push(route);
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
        return this.all(path, ...callbacks);
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
    this._globalMiddlewares.clear();
    this._hasSetGlobalMiddlewares = false;
    this.routeCacheGlobalMiddlewares.clear();
    this.routeCacheRouteHandlers.clear();

    return this;
  }

  getGlobalMiddlewares() {
    // Build global middlewares
    if (!this._hasSetGlobalMiddlewares) {
      this.routes().forEach((route, index) => {
        const isGlobalMiddleware =
          (isUndefined(route.method) || isNull(route.method)) &&
          (isUndefined(route.path) || isNull(route.path));

        if (isGlobalMiddleware) {
          const routeIndex = String(index);
          this._globalMiddlewares.set(routeIndex, route);
        }
      });
      this._hasSetGlobalMiddlewares = true;
    }

    return Array.from(this._globalMiddlewares.keys())
      .map((routeIndex) => {
        const route = this._globalMiddlewares.get(routeIndex);

        if (route) {
          const callbacks = route.callbacks as RouterHandler[];

          if (callbacks.length) {
            return {
              routeIndex,
              route,
              callbacks,
            };
          }
        }

        return undefined;
      })
      .filter((routeResp) => !!routeResp);
  }

  getMatchedGlobalMiddlewares(
    options: RouteMatchMethodOptionType,
  ): CachedRouteMatch[] {
    const requestPath = this.getRequestPathFromRequestURL(options.requestUrl);
    const cacheKey = this.getCacheKey(options);
    const globalMiddlewares = this.getGlobalMiddlewares();

    let matchedGlobalMiddlewares =
      this.routeCacheGlobalMiddlewares.get(cacheKey);

    if (!(matchedGlobalMiddlewares && isArray(matchedGlobalMiddlewares))) {
      matchedGlobalMiddlewares = [];
      globalMiddlewares.forEach((routeResp) => {
        const match = routeResp.route.match({
          host: options.requestHost,
          method: options.requestMethod,
          path: requestPath,
        }) as matchedRoute;

        const isAMatch = isObject(match);

        if (!isAMatch) {
          return;
        }

        const callbacks = routeResp.callbacks || [];
        const callbackIndexes: string[] = callbacks.reduce(
          (list, _, callbackIndex) => {
            const indexStr = String(callbackIndex);
            if (!list.includes(indexStr)) {
              list.push(indexStr);
            }

            return list;
          },
          [] as string[],
        );

        matchedGlobalMiddlewares?.push({
          routeIndex: routeResp.routeIndex,
          callbackIndexes,
        });
      });

      this.routeCacheGlobalMiddlewares.set(cacheKey, matchedGlobalMiddlewares);
    }

    const routes = this.routes();
    return matchedGlobalMiddlewares
      .map((record) => {
        const route = get(routes, record.routeIndex) as Route | undefined;
        if (route) {
          const callbacks = route.callbacks.filter((_, index) =>
            record.callbackIndexes.includes(String(index)),
          ) as RouterHandler[];

          if (callbacks.length) {
            return {
              route,
              callbacks,
            };
          }
        }

        return undefined;
      })
      .filter((route) => !!route);
  }

  getMatchedRouteMiddlewares(
    options: RouteMatchMethodOptionType,
  ): CachedRouteMatch[] {
    const requestPath = this.getRequestPathFromRequestURL(options.requestUrl);
    const cacheKey = this.getCacheKey(options);
    const routes = this.routes();

    let matchedRouteMiddlewares = this.routeCacheRouteMiddlewares.get(cacheKey);
    if (!(matchedRouteMiddlewares && isArray(matchedRouteMiddlewares))) {
      matchedRouteMiddlewares = [];
      routes.forEach((route, routeIndex) => {
        if (
          isString(route.path) &&
          (isUndefined(route.method) || isNull(route.path))
        ) {
          const match = route.match({
            host: options.requestHost,
            method: options.requestMethod,
            path: requestPath,
          }) as matchedRoute;

          if (isObject(match)) {
            const callbackIndexes: string[] = [];
            const callbacks = match.callbacks || [];

            callbacks.forEach((_, callbackIndex) => {
              callbackIndexes.push(String(callbackIndex));
            });

            matchedRouteMiddlewares?.push({
              routeIndex: String(routeIndex),
              callbackIndexes,
            });
          }
        }
      });

      this.routeCacheRouteMiddlewares.set(
        cacheKey,
        matchedRouteMiddlewares as {
          routeIndex: string;
          callbackIndexes: string[];
        }[],
      );
    }

    return matchedRouteMiddlewares
      .map((record) => {
        const route = get(routes, record.routeIndex) as Route | undefined;
        if (route) {
          const callbacks = route.callbacks.filter((_, index) =>
            record.callbackIndexes.includes(String(index)),
          ) as RouterHandler[];

          if (callbacks.length) {
            return {
              route,
              callbacks,
            };
          }
        }

        return undefined;
      })
      .filter((route) => !!route);
  }

  getMatchedRouteHandlers(
    options: RouteMatchMethodOptionType,
  ): CachedRouteMatch[] {
    const requestPath = this.getRequestPathFromRequestURL(options.requestUrl);
    const cacheKey = this.getCacheKey(options);
    const routes = this.routes();

    let matchedRouteHandlers = this.routeCacheRouteHandlers.get(cacheKey);
    if (!(matchedRouteHandlers && isArray(matchedRouteHandlers))) {
      matchedRouteHandlers = [];

      let matchedRoutes: {
        matched: matchedRoute;
        route: Route;
        routeIndex: number;
      }[] = [];

      routes.forEach((route, routeIndex) => {
        if (isString(route.path) && isString(route.method)) {
          const match = route.match({
            host: options.requestHost,
            method: options.requestMethod,
            path: requestPath,
          }) as matchedRoute;

          if (isObject(match)) {
            matchedRoutes.push({
              matched: match,
              route,
              routeIndex,
            });
            // const callbacks = route.callbacks || [];
            // callbacks.forEach((callback, callbackIndex) => {
            //   matchedRouteMiddlewares?.push(`${routeIndex}.${callbackIndex}`);
            // });
          }
        }
      });

      if (matchedRoutes.length) {
        matchedRoutes = orderBy(
          matchedRoutes,
          [
            // Sort by host specificity. Less means better match
            ({ matched }) => {
              if (
                isString(matched.host) &&
                String(matched.host).toLowerCase() ===
                  String(options.requestHost).toLowerCase()
              ) {
                return 0;
              }

              return 1;
            },
            // Sort by defined host. More means better
            ({ route }) => {
              return String(route.host || "").length;
            },
            // Sort by method specificity. Less means better match
            ({ matched }) => {
              if (
                matched.method.toLowerCase() ===
                String(options.requestMethod).toLowerCase()
              ) {
                return 0;
              }

              return 1;
            },
            // Sort by the most specific path match. Less means more specific
            ({ route }) => {
              return route.params.length;
            },
            // Prioritize routes with more named path params. More is better
            ({ matched }) => {
              const namedParamsLength = keys(matched.params || {}).filter(
                (paramKey) => !isNumeric(paramKey),
              ).length;

              return namedParamsLength;
            },
            // Prioritize routes with named path and more regexp definitions. More is better
            ({ matched }) => {
              let path = String(matched.path || "");
              if (!path.startsWith("/")) {
                path = `/${path}`;
              }

              const splits = path.split("/:");
              const paramsWithRegexp = splits.filter((part) => {
                const startBracketIndex = String(part).indexOf("(", 0);
                const closeBracketIndex = lastIndexOf(String(part), ")");

                return (
                  startBracketIndex > -1 &&
                  closeBracketIndex > startBracketIndex
                );
              });

              return paramsWithRegexp.length;
            },
          ],
          ["asc", "desc", "asc", "asc", "desc", "desc"],
        );

        matchedRoutes.forEach(({ matched, routeIndex }) => {
          if (isObject(matched)) {
            matchedRouteHandlers?.push(String(routeIndex));
          }
        });
      }

      this.routeCacheRouteHandlers.set(
        cacheKey,
        matchedRouteHandlers as string[],
      );
    }

    return matchedRouteHandlers
      .map((routeIndex) => {
        const route = get(routes, routeIndex) as Route | undefined;
        if (route) {
          const callbacks = route.callbacks as RouterHandler[];

          if (callbacks.length) {
            return {
              route,
              callbacks,
            };
          }
        }

        return undefined;
      })
      .filter((route) => !!route);
  }

  getMatchedRoutes(options: RouteMatchMethodOptionType) {
    return {
      middlewares: {
        global: this.getMatchedGlobalMiddlewares(options),
        route: this.getMatchedRouteMiddlewares(options),
      },
      handlers: this.getMatchedRouteHandlers(options),
    };
  }

  // setName(name: string): this;
  // override route(name: string, params?: object): string | null;

  override async handle(options: {
    requestHost: string;
    requestMethod: string;
    requestUrl: string;
    request: BunRequest;
    response: BunResponse;
  }): Promise<matchedRoute | true | undefined> {
    const { response, request } = options;
    const requestPath = this.getRequestPathFromRequestURL(options.requestUrl);

    // Get matched middlewares and route handlers
    const {
      handlers: matchedRouteHandlers,
      middlewares: {
        global: matchedGlobalMiddlewares,
        route: matchedRouteMiddlewares,
      },
    } = this.getMatchedRoutes(options);

    // Process matched global middlewares, route middlewares and then route handlers
    {
      let errorThrown: Error | unknown | undefined;
      let continueProcessingRouteHandlers = true;
      let continueProcessingMiddlewares = true;
      let route: Route | undefined;
      let matchedRoute: matchedRoute | undefined;

      const skipMiddleWareArr = ["next", "route", "router", "skip"];

      const nextFnGenerator = <T, E>(
        successHandler: (
          param: "next" | "route" | "router" | "skip" | true | false | Error,
        ) => Promise<T> | T,
        failureHandler: (err: unknown) => Promise<E> | E,
      ) => {
        const obj = {
          handler(
            param: "next" | "route" | "router" | "skip" | true | false | Error,
          ) {
            obj.callsCount += 1;

            switch (true) {
              case isString(param) && skipMiddleWareArr.includes(param):
              case isBoolean(param): {
                successHandler(continueProcessingMiddlewares);
                return;
              }

              case !param: {
                successHandler("next");
                return;
              }

              // At this point it is an error
              default: {
                if (isError(param)) {
                  errorThrown = param as Error;
                } else {
                  const err = new Error(String(param));
                  errorThrown = err;
                }

                continueProcessingRouteHandlers = false;
                continueProcessingMiddlewares = false;
                failureHandler(errorThrown);
              }
            }
          },
          callsCount: 0,
          get hasBeenCalled() {
            return obj.callsCount > 0;
          },
        } as {
          handler: NextFunction;
          callsCount: number;
          hasBeenCalled: boolean;
        };

        return obj;
      };

      // No matched route handler.. Maybe a middleware can be the handler so process middlewares
      if (!(matchedRouteHandlers && matchedRouteHandlers.length)) {
        // Process Middlewares

        // Process Global Middlewares
        if (matchedGlobalMiddlewares && matchedGlobalMiddlewares.length) {
          globalMiddlewareIterator: for await (const matchedMiddleware of matchedGlobalMiddlewares) {
            if (!continueProcessingMiddlewares) {
              break;
            }

            const route = matchedMiddleware.route;
            if (!route) {
              continue globalMiddlewareIterator;
            }

            middleWareCallbackIterator: for await (const callback of matchedMiddleware.callbacks) {
              if (!isFunction(callback)) {
                continue;
              }

              try {
                type StackToContinueType =
                  | "middleWareCallbackIterator"
                  | "breakGlobalMiddlewareIterator"
                  | "globalMiddlewareIterator";

                let stackToContinue: StackToContinueType =
                  "middleWareCallbackIterator";
                const nextFunctionGenResp = nextFnGenerator(
                  (passedResp) => {
                    switch (true) {
                      case !passedResp: {
                        stackToContinue = "middleWareCallbackIterator";
                        break;
                      }

                      case response.headersSent: {
                        stackToContinue = "breakGlobalMiddlewareIterator";
                        break;
                      }

                      case isError(passedResp): {
                        errorThrown = passedResp;
                        stackToContinue = "breakGlobalMiddlewareIterator";
                        break;
                      }

                      case isString(passedResp) &&
                        ["route", "router", "skip"].includes(
                          passedResp as string,
                        ):
                      case isBoolean(passedResp) && !passedResp: {
                        continueProcessingMiddlewares = false;
                        stackToContinue = "globalMiddlewareIterator";
                        break;
                      }

                      default: {
                        stackToContinue = "middleWareCallbackIterator";
                        break;
                      }
                    }
                  },
                  (err) => {
                    errorThrown = err;
                    stackToContinue = "breakGlobalMiddlewareIterator";
                  },
                );

                const resp = await (callback as RouterHandler)(
                  request,
                  response,
                  nextFunctionGenResp.handler,
                );

                if (response.headersSent) {
                  stackToContinue = "breakGlobalMiddlewareIterator";
                }

                if (
                  !response.headersSent &&
                  (!!resp || !nextFunctionGenResp.hasBeenCalled)
                ) {
                  await response.status(response.statusCode || 200).end(resp);
                  stackToContinue = "breakGlobalMiddlewareIterator";
                }

                if (this.localOptions?.debug) {
                  this.logger.log({
                    state: "global_general_middleware",
                    hasSentHeaders: response.headersSent,
                    nextFnCalled: nextFunctionGenResp.hasBeenCalled,
                    sentResp: !!resp,
                    callback: callback.toString(),
                    stackToContinue,
                  });
                }

                switch (stackToContinue as StackToContinueType) {
                  case "breakGlobalMiddlewareIterator": {
                    continueProcessingRouteHandlers = false;
                    continueProcessingMiddlewares = false;
                    break globalMiddlewareIterator;
                  }

                  case "globalMiddlewareIterator": {
                    break;
                  }

                  case "middleWareCallbackIterator": {
                    continue middleWareCallbackIterator;
                  }
                }
              } catch (err) {
                errorThrown = err;
                break globalMiddlewareIterator;
              }
            }
          }
        }

        // if terminated by error or response sent then stop process
        if (errorThrown || response.headersSent) {
          continueProcessingMiddlewares = false;
          continueProcessingRouteHandlers = false;
        }

        // Process Route Middlewares// Process Global Middlewares
        if (matchedRouteMiddlewares && matchedRouteMiddlewares.length) {
          routeMiddlewareIterator: for await (const matchedMiddleware of matchedRouteMiddlewares) {
            if (!continueProcessingMiddlewares) {
              break;
            }

            const route = matchedMiddleware.route;
            if (!route) {
              continue routeMiddlewareIterator;
            }

            middleWareCallbackIterator: for await (const callback of matchedMiddleware.callbacks) {
              if (!isFunction(callback)) {
                continue;
              }

              type StackToContinueType =
                | "middleWareCallbackIterator"
                | "breakRouteMiddlewareIterator"
                | "routeMiddlewareIterator";

              try {
                let stackToContinue: StackToContinueType =
                  "middleWareCallbackIterator";

                const nextFunctionGenResp = nextFnGenerator(
                  (passedResp) => {
                    switch (true) {
                      case !passedResp: {
                        stackToContinue = "middleWareCallbackIterator";
                        break;
                      }

                      case response.headersSent: {
                        stackToContinue = "breakRouteMiddlewareIterator";
                        break;
                      }

                      case isError(passedResp): {
                        errorThrown = passedResp as unknown as Error;
                        stackToContinue = "breakRouteMiddlewareIterator";
                        break;
                      }

                      case isString(passedResp) &&
                        ["route", "router", "skip"].includes(
                          passedResp as string,
                        ):
                      case isBoolean(passedResp) && !passedResp: {
                        continueProcessingMiddlewares = false;
                        stackToContinue = "routeMiddlewareIterator";
                        break;
                      }

                      default: {
                        stackToContinue = "middleWareCallbackIterator";
                        break;
                      }
                    }
                  },
                  (err) => {
                    errorThrown = err;
                    stackToContinue = "breakRouteMiddlewareIterator";
                  },
                );

                const resp = await (callback as RouterHandler)(
                  request,
                  response,
                  nextFunctionGenResp.handler,
                );

                if (response.headersSent) {
                  stackToContinue = "breakRouteMiddlewareIterator";
                }

                if (
                  !response.headersSent &&
                  (!!resp || !nextFunctionGenResp.hasBeenCalled)
                ) {
                  await response.status(response.statusCode || 200).end(resp);
                  stackToContinue = "breakRouteMiddlewareIterator";
                }

                if (this.localOptions?.debug) {
                  this.logger.log({
                    state: "route_general_middleware",
                    hasSentHeaders: response.headersSent,
                    nextFnCalled: nextFunctionGenResp.hasBeenCalled,
                    sentResp: !!resp,
                    callback: callback.toString(),
                    stackToContinue,
                  });
                }

                switch (stackToContinue as StackToContinueType) {
                  case "breakRouteMiddlewareIterator": {
                    continueProcessingRouteHandlers = false;
                    continueProcessingMiddlewares = false;
                    break routeMiddlewareIterator;
                  }

                  case "routeMiddlewareIterator": {
                    continue routeMiddlewareIterator;
                  }

                  case "middleWareCallbackIterator": {
                    continue middleWareCallbackIterator;
                  }
                }
              } catch (err) {
                errorThrown = err;
                break routeMiddlewareIterator;
              }
            }
          }
        }
      }

      // Process matched route handlers
      handleIterator: for await (const routeHandler of matchedRouteHandlers) {
        // if terminated by error or response sent then stop process
        if (errorThrown || response.headersSent) {
          continueProcessingMiddlewares = false;
          continueProcessingRouteHandlers = false;
          break handleIterator;
        }

        if (!continueProcessingRouteHandlers) {
          break handleIterator;
        }

        route = routeHandler.route;

        if (!route) {
          continue;
        }

        const match = route.match({
          host: options.requestHost,
          method: options.requestMethod,
          path: requestPath,
        }) as matchedRoute;

        if (!match) {
          continue;
        }

        const isLastHandler =
          routeHandler ===
          matchedRouteHandlers[matchedRouteHandlers.length - 1];

        matchedRoute = match;
        if (matchedRoute && isObject(matchedRoute)) {
          request.params = matchedRoute.params as Record<string, string>;
          request.subdomains = matchedRoute.subdomains as string[];
        }

        // Process Middlewares
        // Process Global Middlewares
        if (matchedGlobalMiddlewares && matchedGlobalMiddlewares.length) {
          globalMiddlewareIterator: for await (const matchedMiddleware of matchedGlobalMiddlewares) {
            if (!continueProcessingMiddlewares) {
              break;
            }

            const route = matchedMiddleware.route;
            if (!route) {
              continue globalMiddlewareIterator;
            }

            middleWareCallbackIterator: for await (const callback of matchedMiddleware.callbacks) {
              if (!isFunction(callback)) {
                continue;
              }

              type StackToContinueType =
                | "middleWareCallbackIterator"
                | "breakHandleIterator"
                | "globalMiddlewareIterator";

              try {
                let stackToContinue: StackToContinueType =
                  "middleWareCallbackIterator";

                const nextFunctionGenResp = nextFnGenerator(
                  (passedResp) => {
                    switch (true) {
                      case !passedResp: {
                        stackToContinue = "middleWareCallbackIterator";
                        break;
                      }

                      case response.headersSent: {
                        stackToContinue = "breakHandleIterator";
                        break;
                      }

                      case isError(passedResp): {
                        errorThrown = passedResp as unknown as Error;
                        stackToContinue = "breakHandleIterator";
                        break;
                      }

                      case isString(passedResp) &&
                        ["route", "router", "skip"].includes(
                          passedResp as string,
                        ):
                      case isBoolean(passedResp) && !passedResp: {
                        continueProcessingMiddlewares = false;
                        stackToContinue = "globalMiddlewareIterator";
                        break;
                      }

                      default: {
                        stackToContinue = "middleWareCallbackIterator";
                        break;
                      }
                    }
                  },
                  (err) => {
                    errorThrown = err;
                    stackToContinue = "breakHandleIterator";
                  },
                );

                const resp = await (callback as RouterHandler)(
                  request,
                  response,
                  nextFunctionGenResp.handler,
                );

                if (response.headersSent) {
                  stackToContinue = "breakHandleIterator";
                }

                if (
                  !response.headersSent &&
                  (!!resp || !nextFunctionGenResp.hasBeenCalled)
                ) {
                  await response.status(response.statusCode || 200).end(resp);
                  stackToContinue = "breakHandleIterator";
                }

                if (this.localOptions?.debug) {
                  this.logger.log({
                    state: "global_handler_middleware",
                    path: matchedRoute.path,
                    hasSentHeaders: response.headersSent,
                    nextFnCalled: nextFunctionGenResp.hasBeenCalled,
                    sentResp: !!resp,
                    callback: callback.toString(),
                    stackToContinue,
                  });
                }

                switch (stackToContinue as StackToContinueType) {
                  case "breakHandleIterator": {
                    break handleIterator;
                  }

                  case "globalMiddlewareIterator": {
                    continue globalMiddlewareIterator;
                  }

                  case "middleWareCallbackIterator": {
                    continue middleWareCallbackIterator;
                  }
                }
              } catch (err) {
                errorThrown = err;
                break handleIterator;
              }
            }
          }
        }

        // if terminated by error or response sent then stop process
        if (errorThrown || response.headersSent) {
          break handleIterator;
        }

        // Process Route Middlewares
        if (matchedRouteMiddlewares && matchedRouteMiddlewares.length) {
          routeMiddlewareIterator: for await (const matchedMiddleware of matchedRouteMiddlewares) {
            if (!continueProcessingMiddlewares) {
              break;
            }

            const route = matchedMiddleware.route;
            if (!route) {
              continue routeMiddlewareIterator;
            }

            middleWareCallbackIterator: for await (const callback of matchedMiddleware.callbacks) {
              if (!isFunction(callback)) {
                continue;
              }

              type StackToContinueType =
                | "middleWareCallbackIterator"
                | "breakHandleIterator"
                | "routeMiddlewareIterator";

              try {
                let stackToContinue: StackToContinueType =
                  "middleWareCallbackIterator";

                const nextFunctionGenResp = nextFnGenerator(
                  (passedResp) => {
                    switch (true) {
                      case !passedResp: {
                        stackToContinue = "middleWareCallbackIterator";
                        break;
                      }

                      case response.headersSent: {
                        stackToContinue = "breakHandleIterator";
                        break;
                      }

                      case isError(passedResp): {
                        errorThrown = passedResp as unknown as Error;
                        stackToContinue = "breakHandleIterator";
                        break;
                      }

                      case isString(passedResp) &&
                        ["route", "router", "skip"].includes(
                          passedResp as string,
                        ):
                      case isBoolean(passedResp) && !passedResp: {
                        continueProcessingMiddlewares = false;
                        stackToContinue = "routeMiddlewareIterator";
                        break;
                      }

                      default: {
                        stackToContinue = "middleWareCallbackIterator";
                        break;
                      }
                    }
                  },
                  (err) => {
                    errorThrown = err;
                    stackToContinue = "breakHandleIterator";
                  },
                );

                const resp = await (callback as RouterHandler)(
                  request,
                  response,
                  nextFunctionGenResp.handler,
                );

                if (response.headersSent) {
                  stackToContinue = "breakHandleIterator";
                }

                if (this.localOptions?.debug) {
                  this.logger.log({
                    state: "route_handler_middleware",
                    path: matchedRoute.path,
                    hasSentHeaders: response.headersSent,
                    nextFnCalled: nextFunctionGenResp.hasBeenCalled,
                    sentResp: !!resp,
                    callback: callback.toString(),
                    stackToContinue,
                  });
                }

                if (
                  !response.headersSent &&
                  (!!resp || !nextFunctionGenResp.hasBeenCalled)
                ) {
                  await response.status(response.statusCode || 200).end(resp);
                  stackToContinue = "breakHandleIterator";
                }

                switch (stackToContinue as StackToContinueType) {
                  case "breakHandleIterator": {
                    break handleIterator;
                  }

                  case "routeMiddlewareIterator": {
                    continue routeMiddlewareIterator;
                  }

                  case "middleWareCallbackIterator": {
                    continue middleWareCallbackIterator;
                  }
                }
              } catch (err) {
                errorThrown = err;
                break handleIterator;
              }
            }
          }
        }

        // if terminated by error or response sent then stop process
        if (errorThrown || response.headersSent) {
          break handleIterator;
        }

        if (!isArray(matchedRoute.callbacks)) {
          matchedRoute.callbacks = [];
        }

        // Process Route Handlers
        handleCallbackIterator: for await (const callback of matchedRoute.callbacks) {
          if (!continueProcessingRouteHandlers) {
            break handleIterator;
          }

          const isLastCallback =
            matchedRoute.callbacks[matchedRoute.callbacks.length - 1] ===
            callback;

          if (!isFunction(callback)) {
            if (isLastHandler && isLastCallback) {
              return matchedRoute;
            }

            continue;
          }

          type StackToContinueType =
            | "handleCallbackIterator"
            | "breakHandleIterator";

          try {
            let stackToContinue: StackToContinueType = "handleCallbackIterator";

            const nextFunctionGenResp = nextFnGenerator(
              (passedResp) => {
                switch (true) {
                  case !passedResp: {
                    stackToContinue = "handleCallbackIterator";
                    break;
                  }

                  case response.headersSent: {
                    stackToContinue = "breakHandleIterator";
                    break;
                  }

                  case isError(passedResp): {
                    errorThrown = passedResp as unknown as Error;
                    stackToContinue = "breakHandleIterator";
                    break;
                  }

                  case isString(passedResp) &&
                    ["route", "router", "skip"].includes(passedResp as string):
                  case isBoolean(passedResp) && !passedResp: {
                    continueProcessingMiddlewares = false;
                    stackToContinue = "handleCallbackIterator";
                    break;
                  }

                  default: {
                    stackToContinue = "handleCallbackIterator";
                    break;
                  }
                }
              },
              (err) => {
                errorThrown = err;
                stackToContinue = "breakHandleIterator";
              },
            );

            const resp = await (callback as RouterHandler)(
              request,
              response,
              nextFunctionGenResp.handler,
            );

            if (this.localOptions?.debug) {
              this.logger.log({
                state: "handler",
                path: matchedRoute.path,
                params: request.params,
                hasSentHeaders: response.headersSent,
                nextFnCalled: nextFunctionGenResp.hasBeenCalled,
                sentResp: !!resp,
                callback: callback.toString(),
                stackToContinue,
              });
            }

            if (response.headersSent) {
              break handleIterator;
            }

            if (
              !response.headersSent &&
              (!!resp || !nextFunctionGenResp.hasBeenCalled)
            ) {
              await response.status(response.statusCode || 200).end(resp);
              break handleIterator;
            }

            switch (stackToContinue as StackToContinueType) {
              case "breakHandleIterator": {
                break handleIterator;
              }

              case "handleCallbackIterator": {
                continue handleCallbackIterator;
              }
            }
          } catch (err) {
            errorThrown = err;
            break handleIterator;
          }
        }
      }

      // Handle error if thrown
      if (errorThrown) {
        this.throwError(errorThrown);
      }

      if (matchedRoute || response.headersSent) {
        return matchedRoute || true;
      }

      return undefined;
    }
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
