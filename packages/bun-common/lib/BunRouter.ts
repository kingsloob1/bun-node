import { Router, type Route, type matchedRoute } from '@routejs/router';
import type { NextFunction, RouterMiddlewareHandler } from './types/general';
import {
  get,
  isFunction,
  isNull,
  isObject,
  isString,
  isUndefined,
  keys,
  orderBy,
  isArray,
} from 'lodash-es';
import isNumeric from 'fast-isnumeric';

export class BunRouter extends Router {
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

  async handle(
    options: Parameters<Router['handle']>[0],
  ): Promise<matchedRoute | undefined> {
    const { requestHost, requestMethod, requestUrl, request, response } =
      options;

    const routes = this.routes();
    let requestPath = requestUrl;
    if (requestUrl.indexOf('?') >= 0) {
      requestPath = requestUrl.slice(0, requestUrl.indexOf('?'));
    }

    //Build global middlewares
    if (!this._hasSetGlobalMiddlewares) {
      const handlers = routes.filter(
        (route) => isUndefined(route.method) && isUndefined(route.path),
      );

      this._globalMiddlewares = handlers;
      this._hasSetGlobalMiddlewares = true;
    }

    const cacheKey = `host:${options.requestHost || 'none'}:path:${options.requestUrl}:method:${options.requestMethod}`;
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
          this._globalMiddlewares[globalMiddlewareIndex].callbacks || [];
        const callbackIndexes: string[] = [];

        callbacks.forEach((callback, callbackIndex) => {
          callbackIndexes.push(String(callbackIndex));
        });

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

            callbacks.forEach((callback, callbackIndex) => {
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
            ({ matched }) => {
              if (
                matched.method.toLowerCase() ===
                String(options.requestMethod).toLowerCase()
              ) {
                return 0;
              }

              return 1;
            },
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
            ({ route }) => {
              return route.path.length;
            },
            ({ route }) => {
              return String(route.host || '').length;
            },
          ],
          ['asc', 'asc', 'desc', 'desc'],
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

    if (!matchedRouteHandlers?.length) {
      return undefined;
    } else {
      let errorThrown: Error | unknown | undefined = undefined;
      let continueProcessingRouteHandlers = true;
      let continueProcessingMiddlewares = true;
      let route: Route | undefined = undefined;
      let matchedRoute: matchedRoute | undefined = undefined;

      const nextFnGenerator = (
        ...args: Parameters<ConstructorParameters<typeof Promise>[0]>
      ) => {
        const [resolve, reject] = args;
        const obj = {
          handler(err: unknown) {
            obj.callsCount += 1;
            if (!(isUndefined(err) || isNull(err))) {
              if (err === 'next') {
                continueProcessingMiddlewares = true;
              } else {
                if (err === 'skip') {
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

      handleIterator: for await (const routeHandlerKey of keys(
        matchedRouteHandlers,
      ).map((routeHandlerKey) => String(routeHandlerKey))) {
        if (errorThrown) {
          if (errorThrown instanceof Error || isObject(errorThrown)) {
            throw errorThrown;
          } else if (isString(errorThrown) || isNumeric(errorThrown)) {
            throw new Error(String(errorThrown));
          } else {
            throw new Error('An error was triggered in a middleware handler');
          }
        }

        if (!continueProcessingRouteHandlers) {
          return matchedRoute;
        }

        route = get(
          routes,
          get(matchedRouteHandlers, routeHandlerKey, '-1'),
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
        request.params = matchedRoute.params;
        request.subdomains = matchedRoute.subdomains;

        //Process Middlewares
        //Process Global Middlewares
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

                if (!resp) {
                  resolve('skip-middlewares');
                } else {
                  resolve('normal');
                }
              } catch (err) {
                errorThrown = err;
                resolve('continue-handlers');
              }
            });

            if (promiseResp === 'skip-middlewares') {
              continueProcessingMiddlewares = false;
              break globalMiddlewareIterator;
            } else if (promiseResp === 'continue-handlers') {
              continue handleIterator;
            } else {
              continue;
            }
          }
        }

        //Process Route Middlewares
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

                if (!resp) {
                  resolve('skip-middlewares');
                } else {
                  resolve('normal');
                }
              } catch (err) {
                errorThrown = err;
                resolve('continue-handlers');
              }
            });

            if (promiseResp === 'skip-middlewares') {
              continueProcessingMiddlewares = false;
              break routeMiddlewareIterator;
            } else if (promiseResp === 'continue-handlers') {
              continue handleIterator;
            } else {
              continue;
            }
          }
        }

        //Process Route Handlers
        handleCallbackIterator: for await (const callbackKey of keys(
          matchedRoute.callbacks,
        ).map((callbackKey) => String(callbackKey))) {
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

              if (!resp) {
                if (nextFunctionGenResp.hasBeenCalled) {
                  if (!isLastCallback) {
                    resolve('continue-callback');
                    return;
                  } else if (!isLastHandler) {
                    resolve('continue-handler');
                    return;
                  }
                }
              }

              continueProcessingRouteHandlers = false;
              resolve('continue-handler');
            } catch (err) {
              errorThrown = err;
              resolve('continue-handler');
            }
          });

          if (promiseResp === 'continue-handler') {
            continue handleIterator;
          } else {
            continue handleCallbackIterator;
          }
        }
      }

      return matchedRoute;
    }
  }
}
