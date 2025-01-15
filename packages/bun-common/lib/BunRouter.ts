import type { BunRequest } from "@kingsleyweb/bun-common/lib/BunRequest";
import type { BunResponse } from "@kingsleyweb/bun-common/lib/BunResponse";
import type { WebSocketHandler } from "bun";
import type { BunWebSocket, WebSocketClientData } from "./BunWebSocket";
import type { NextFunction, RouterMiddlewareHandler } from "./types/general";
import path from "node:path";
import process from "node:process";
import { type matchedRoute, type Route, Router } from "@routejs/router";
import isNumeric from "fast-isnumeric";
import {
  get,
  isArray,
  isFunction,
  isNull,
  isObject,
  isString,
  isUndefined,
  keys,
  lastIndexOf,
  omit,
  orderBy,
} from "lodash-es";

export class BunRouter extends Router {
  private _bunWebSocket?: BunWebSocket;
  private _globalMiddlewares: Route[] = [];
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
    private localOptions?: ConstructorParameters<typeof Router>[0] & {
      bunWebsocket: BunWebSocket;
    },
  ) {
    super(omit(localOptions, ["bunWebsocket"]));
  }

  setBunWebSocket(bunWebSocket: BunWebSocket) {
    this._bunWebSocket = bunWebSocket;
  }

  getBunWebsocket() {
    return this._bunWebSocket || this.localOptions?.bunWebsocket;
  }

  setRoute(
    option: Required<Pick<Route, "path" | "callbacks">> &
      Partial<Pick<Route, "group" | "host" | "method" | "name">>,
  ) {
    const routes = this.routes();
    if (option.name) {
      if (routes.find((route) => route.name === option.name)) {
        throw new Error(`Route with name "${option.name}" already exists..`);
      }
    }

    const routeModulePath = path.join(
      path.dirname(Bun.resolveSync("@routejs/router", process.cwd())),
      "./src/route.mjs",
    );
    // eslint-disable-next-line ts/no-require-imports
    const routeModule = require(routeModulePath);

    if (!isFunction(routeModule.default)) {
      throw new Error(
        `Route module cannot be imported... API must have changed. Please create an issue on github`,
      );
    }

    // eslint-disable-next-line new-cap
    const route = new routeModule.default(option);
    this.use(route);
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

  override async handle(
    options: Parameters<Router["handle"]>[0],
  ): Promise<matchedRoute | true | undefined> {
    const { requestHost, requestMethod, requestUrl, request, response } =
      options;

    const routes = this.routes();
    let requestPath = requestUrl;
    if (requestUrl.includes("?")) {
      requestPath = requestUrl.slice(0, requestUrl.indexOf("?"));
    }

    // Build global middlewares
    if (!this._hasSetGlobalMiddlewares) {
      const handlers = routes.filter(
        (route) => isUndefined(route.method) && isUndefined(route.path),
      );

      this._globalMiddlewares = handlers;
      this._hasSetGlobalMiddlewares = true;
    }

    const cacheKey = `host:${options.requestHost || "none"}:path:${options.requestUrl}:method:${options.requestMethod}`;
    let matchedGlobalMiddlewares =
      this.routeCacheGlobalMiddlewares.get(cacheKey);
    if (!isArray(matchedGlobalMiddlewares)) {
      const matchedGlobalMiddlewareIndexes = this._globalMiddlewares.map(
        (route, index) => {
          const match = route.match({
            host: requestHost,
            method: requestMethod,
            path: requestPath,
          }) as matchedRoute;

          if (isObject(match)) {
            return index;
          }

          return undefined;
        },
      );

      matchedGlobalMiddlewares = [];
      (
        matchedGlobalMiddlewareIndexes.filter((index) =>
          isNumeric(index),
        ) as number[]
      ).forEach((globalMiddlewareIndex) => {
        const callbacks =
          this._globalMiddlewares[globalMiddlewareIndex]?.callbacks || [];

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
          routeIndex: String(globalMiddlewareIndex),
          callbackIndexes,
        });
      });

      this.routeCacheGlobalMiddlewares.set(
        cacheKey,
        matchedGlobalMiddlewares as {
          routeIndex: string;
          callbackIndexes: string[];
        }[],
      );
    }

    let matchedRouteMiddlewares = this.routeCacheRouteMiddlewares.get(cacheKey);
    if (!isArray(matchedRouteMiddlewares)) {
      matchedRouteMiddlewares = [];
      routes.forEach((route, routeIndex) => {
        if (isString(route.path) && isUndefined(route.method)) {
          const match = route.match({
            host: requestHost,
            method: requestMethod,
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

    let matchedRouteHandlers = this.routeCacheRouteHandlers.get(cacheKey);
    if (!isArray(matchedRouteHandlers)) {
      matchedRouteHandlers = [];

      let matchedRoutes: {
        matched: matchedRoute;
        route: Route;
        routeIndex: number;
      }[] = [];
      routes.forEach((route, routeIndex) => {
        if (isString(route.path) && isString(route.method)) {
          const match = route.match({
            host: requestHost,
            method: requestMethod,
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

    // Process matched gloval middlewares, route middlewares and then route handlers
    {
      let errorThrown: Error | unknown | undefined;
      let continueProcessingRouteHandlers = true;
      let continueProcessingMiddlewares = true;
      let route: Route | undefined;
      let matchedRoute: matchedRoute | undefined;

      const nextFnGenerator = (
        ...args: Parameters<ConstructorParameters<typeof Promise>[0]>
      ) => {
        const [resolve, reject] = args;
        const obj = {
          handler(err: unknown) {
            obj.callsCount += 1;
            if (!(isUndefined(err) || isNull(err))) {
              if (err === "next") {
                continueProcessingMiddlewares = true;
              } else {
                if (err === "skip") {
                  continueProcessingMiddlewares = false;
                } else {
                  continueProcessingRouteHandlers = false;
                  errorThrown = err;
                  reject(err);
                  return;
                }
              }
            }

            resolve(continueProcessingMiddlewares);
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
      if (!matchedRouteHandlers.length) {
        // Process Middlewares
        // Process Global Middlewares
        globalMiddlewareIterator: for await (const obj of matchedGlobalMiddlewares) {
          if (!continueProcessingMiddlewares) {
            break;
          }

          const route = get(this._globalMiddlewares, obj.routeIndex) as
            | Route
            | undefined;
          if (!route) {
            continue globalMiddlewareIterator;
          }

          middleWareCallbackIterator: for await (const callbackKey of obj.callbackIndexes) {
            const handler = get(route.callbacks, callbackKey);
            if (!isFunction(handler)) {
              continue;
            }

            const promiseResp = await new Promise(async (resolve, reject) => {
              try {
                const nextFunctionGenResp = nextFnGenerator(resolve, reject);
                const resp = await (handler as RouterMiddlewareHandler)(
                  request,
                  response,
                  nextFunctionGenResp.handler,
                );
                const hasResp = !!resp;

                switch (true) {
                  case response.headersSent || hasResp: {
                    if (!response.headersSent && hasResp) {
                      await response.end(resp);
                    }

                    resolve("end-routing");
                    break;
                  }

                  case !nextFunctionGenResp.hasBeenCalled && !hasResp:
                  default: {
                    resolve("normal");
                    break;
                  }
                }
              } catch (err) {
                errorThrown = err;
                resolve("skip-middlewares");
              }
            });

            switch (promiseResp) {
              case "end-routing": {
                continueProcessingMiddlewares = false;
                continueProcessingRouteHandlers = false;
                matchedRoute = route.match({
                  host: requestHost,
                  method: requestMethod,
                  path: requestPath,
                }) as matchedRoute;

                if (matchedRoute && isObject(matchedRoute)) {
                  request.params = matchedRoute.params;
                  request.subdomains = matchedRoute.subdomains;
                }

                break globalMiddlewareIterator;
              }

              case "skip-middlewares": {
                continueProcessingMiddlewares = false;
                break globalMiddlewareIterator;
              }

              default: {
                continue middleWareCallbackIterator;
              }
            }
          }
        }

        if (errorThrown) {
          this.throwError(errorThrown);
        }

        // If response headers sent return matchedRoute
        if (response.headersSent) {
          return matchedRoute || true;
        }

        // Process Route Middlewares
        routeMiddlewareIterator: for await (const obj of matchedRouteMiddlewares) {
          if (!continueProcessingMiddlewares) {
            break;
          }

          const route = get(routes, obj.routeIndex) as Route | undefined;
          if (!route) {
            continue routeMiddlewareIterator;
          }

          middleWareCallbackIterator: for await (const callbackKey of obj.callbackIndexes) {
            const handler = get(route.callbacks, callbackKey);
            if (!isFunction(handler)) {
              continue;
            }

            const promiseResp = await new Promise(async (resolve, reject) => {
              try {
                const nextFunctionGenResp = nextFnGenerator(resolve, reject);
                const resp = await (handler as RouterMiddlewareHandler)(
                  request,
                  response,
                  nextFunctionGenResp.handler,
                );
                const hasResp = !!resp;

                switch (true) {
                  case response.headersSent || hasResp: {
                    if (!response.headersSent && hasResp) {
                      await response.end(resp);
                    }

                    resolve("end-routing");
                    break;
                  }

                  case !nextFunctionGenResp.hasBeenCalled && !hasResp:
                  default: {
                    resolve("normal");
                    break;
                  }
                }
              } catch (err) {
                errorThrown = err;
                resolve("skip-middlewares");
              }
            });

            switch (promiseResp) {
              case "end-routing": {
                continueProcessingMiddlewares = false;
                continueProcessingRouteHandlers = false;
                matchedRoute = route.match({
                  host: requestHost,
                  method: requestMethod,
                  path: requestPath,
                }) as matchedRoute;

                if (matchedRoute && isObject(matchedRoute)) {
                  request.params = matchedRoute.params;
                  request.subdomains = matchedRoute.subdomains;
                }

                break routeMiddlewareIterator;
              }

              case "skip-middlewares": {
                continueProcessingMiddlewares = false;
                break routeMiddlewareIterator;
              }

              default: {
                continue middleWareCallbackIterator;
              }
            }
          }
        }

        if (errorThrown) {
          this.throwError(errorThrown);
        }

        // If response headers sent return matchedRoute
        if (response.headersSent) {
          return matchedRoute || true;
        }

        if (matchedRoute && response.headersSent) {
          return matchedRoute;
        }
      }

      // Process matched route handlers
      const routeHandlerKeys = keys(matchedRouteHandlers).map(
        (routeHandlerKey) => String(routeHandlerKey),
      );
      handleIterator: for await (const routeHandlerKey of routeHandlerKeys) {
        if (errorThrown) {
          this.throwError(errorThrown);
        }

        if (!continueProcessingRouteHandlers) {
          return matchedRoute;
        }

        route = get(
          routes,
          get(matchedRouteHandlers, routeHandlerKey, "-1"),
        ) as Route | undefined;
        if (!route) {
          continue;
        }

        const match = route.match({
          host: requestHost,
          method: requestMethod,
          path: requestPath,
        }) as matchedRoute;

        if (!match) {
          continue;
        }

        const isLastHandler =
          routeHandlerKey === String(matchedRouteHandlers.length - 1);
        matchedRoute = match;

        if (matchedRoute && isObject(matchedRoute)) {
          request.params = matchedRoute.params;
          request.subdomains = matchedRoute.subdomains;
        }

        // Process Middlewares
        // Process Global Middlewares
        globalMiddlewareIterator: for await (const obj of matchedGlobalMiddlewares) {
          if (!continueProcessingMiddlewares) {
            break;
          }

          const route = get(this._globalMiddlewares, obj.routeIndex) as
            | Route
            | undefined;
          if (!route) {
            continue globalMiddlewareIterator;
          }

          middleWareCallbackIterator: for await (const callbackKey of obj.callbackIndexes) {
            const handler = get(route.callbacks, callbackKey);
            if (!isFunction(handler)) {
              continue;
            }

            const promiseResp = await new Promise(async (resolve, reject) => {
              try {
                const nextFunctionGenResp = nextFnGenerator(resolve, reject);
                const resp = await (handler as RouterMiddlewareHandler)(
                  request,
                  response,
                  nextFunctionGenResp.handler,
                );

                switch (true) {
                  case response.headersSent: {
                    resolve("end-routing");
                    break;
                  }

                  case !nextFunctionGenResp.hasBeenCalled && !resp: {
                    resolve("skip-middlewares");
                    break;
                  }

                  default: {
                    resolve("normal");
                    break;
                  }
                }
              } catch (err) {
                errorThrown = err;
                resolve("continue-handlers");
              }
            });

            switch (promiseResp) {
              case "end-routing": {
                continueProcessingMiddlewares = false;
                continueProcessingRouteHandlers = false;
                matchedRoute = route.match({
                  host: requestHost,
                  method: requestMethod,
                  path: requestPath,
                }) as matchedRoute;

                if (matchedRoute && isObject(matchedRoute)) {
                  request.params = matchedRoute.params;
                  request.subdomains = matchedRoute.subdomains;
                }

                break handleIterator;
              }

              case "skip-middlewares": {
                continueProcessingMiddlewares = false;
                break globalMiddlewareIterator;
              }

              case "continue-handlers": {
                continue handleIterator;
              }

              default: {
                continue middleWareCallbackIterator;
              }
            }
          }
        }

        // Process Route Middlewares
        routeMiddlewareIterator: for await (const obj of matchedRouteMiddlewares) {
          if (!continueProcessingMiddlewares) {
            break;
          }

          const route = get(routes, obj.routeIndex) as Route | undefined;
          if (!route) {
            continue routeMiddlewareIterator;
          }

          middleWareCallbackIterator: for await (const callbackKey of obj.callbackIndexes) {
            const handler = get(route.callbacks, callbackKey);
            if (!isFunction(handler)) {
              continue;
            }

            const promiseResp = await new Promise(async (resolve, reject) => {
              try {
                const nextFunctionGenResp = nextFnGenerator(resolve, reject);
                const resp = await (handler as RouterMiddlewareHandler)(
                  request,
                  response,
                  nextFunctionGenResp.handler,
                );

                switch (true) {
                  case response.headersSent: {
                    resolve("end-routing");
                    break;
                  }

                  case !nextFunctionGenResp.hasBeenCalled && !resp: {
                    resolve("skip-middlewares");
                    break;
                  }

                  default: {
                    resolve("normal");
                    break;
                  }
                }
              } catch (err) {
                errorThrown = err;
                resolve("continue-handlers");
              }
            });

            switch (promiseResp) {
              case "end-routing": {
                continueProcessingMiddlewares = false;
                continueProcessingRouteHandlers = false;
                matchedRoute = route.match({
                  host: requestHost,
                  method: requestMethod,
                  path: requestPath,
                }) as matchedRoute;

                if (matchedRoute && isObject(matchedRoute)) {
                  request.params = matchedRoute.params;
                  request.subdomains = matchedRoute.subdomains;
                }

                break handleIterator;
              }

              case "skip-middlewares": {
                continueProcessingMiddlewares = false;
                break routeMiddlewareIterator;
              }

              case "continue-handlers": {
                continue handleIterator;
              }

              default: {
                continue middleWareCallbackIterator;
              }
            }
          }
        }

        // If response headers sent return matchedRoute
        if (response.headersSent) {
          return matchedRoute || true;
        }

        // Process Route Handlers
        const callbackKeys = keys(matchedRoute.callbacks).map((callbackKey) =>
          String(callbackKey),
        );
        handleCallbackIterator: for await (const callbackKey of callbackKeys) {
          if (!continueProcessingRouteHandlers) {
            return matchedRoute;
          }

          const handler = get(matchedRoute.callbacks, callbackKey, undefined);
          const isLastCallback =
            callbackKey === String(matchedRoute.callbacks.length - 1);

          if (!isFunction(handler)) {
            if (isLastHandler && isLastCallback) {
              return matchedRoute;
            }

            continue;
          }

          const promiseResp = await new Promise(async (resolve, reject) => {
            try {
              const nextFunctionGenResp = nextFnGenerator(resolve, reject);
              const resp = await (handler as RouterMiddlewareHandler)(
                request,
                response,
                nextFunctionGenResp.handler,
              );

              switch (true) {
                case response.headersSent:
                case !nextFunctionGenResp.hasBeenCalled && !resp: {
                  resolve("end-routing");
                  break;
                }

                default: {
                  resolve(
                    isLastCallback ? "continue-handler" : "continue-callback",
                  );
                  break;
                }
              }
            } catch (err) {
              errorThrown = err;
              resolve("continue-handler");
            }
          });

          switch (promiseResp) {
            case "end-routing": {
              continueProcessingMiddlewares = false;
              continueProcessingRouteHandlers = false;
              matchedRoute = route.match({
                host: requestHost,
                method: requestMethod,
                path: requestPath,
              }) as matchedRoute;

              if (matchedRoute && isObject(matchedRoute)) {
                request.params = matchedRoute.params;
                request.subdomains = matchedRoute.subdomains;
              }

              break handleIterator;
            }

            case "continue-handlers": {
              continue handleIterator;
            }

            case "continue-callback":
            default: {
              continue handleCallbackIterator;
            }
          }
        }
      }

      if (matchedRoute && response.headersSent) {
        return matchedRoute;
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
