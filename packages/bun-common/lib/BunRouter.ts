import { Router, type Route, type matchedRoute } from '@routejs/router';
import type {
  NextFunction,
  RouterErrorMiddlewareHandler,
  RouterMiddlewareHandler,
} from './types/general';
import { flatten, isFunction, isNull, isObject, isUndefined } from 'lodash-es';

export class BunRouter extends Router {
  private _globalMiddlewares: Route[] = [];
  private _hasSetGlobalMiddlewares = false;

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

    let matchedRouteInfo!: matchedRoute;

    if (!this._hasSetGlobalMiddlewares) {
      const handlers = routes.filter(
        (route) => isUndefined(route.method) && isUndefined(route.path),
      );

      this._globalMiddlewares = handlers;
      this._hasSetGlobalMiddlewares = true;
    }

    const matchedRoute = routes.find((route) => {
      if (!(isUndefined(route.path) && isUndefined(route.method))) {
        matchedRouteInfo = route.match({
          host: requestHost,
          method: requestMethod,
          path: requestPath,
        }) as matchedRoute;

        return isObject(matchedRouteInfo);
      }

      return false;
    });

    if (!matchedRoute) {
      return undefined;
    } else {
      request.params = matchedRouteInfo.params;
      request.subdomains = matchedRouteInfo.subdomains;

      let continueProcessingHandlers = true;
      let callFinalHandler = true;

      const nextFnGenerator = (
        ...args: Parameters<ConstructorParameters<typeof Promise>[0]>
      ) => {
        const [resolve, reject] = args;
        return ((err: unknown) => {
          if (!(isUndefined(err) || isNull(err))) {
            if (err === 'next') {
              continueProcessingHandlers = true;
              callFinalHandler = true;
            } else {
              if (err === 'skip') {
                continueProcessingHandlers = false;
              } else {
                callFinalHandler = false;
                reject(err);
                return;
              }
            }
          }

          resolve(continueProcessingHandlers);
        }) as NextFunction;
      };

      const matchedGlobalMiddlewares = this._globalMiddlewares
        .map(
          (route) =>
            route.match({
              host: requestHost,
              method: requestMethod,
              path: requestPath,
            }) as matchedRoute,
        )
        .filter((match) => isObject(match));

      try {
        //Process global middlewares
        const matchedGlobalCallbacks = flatten(
          matchedGlobalMiddlewares.map(
            (route) => route.callbacks as RouterMiddlewareHandler[],
          ),
        ).filter((callback) => callback.length <= 3);

        for await (const handler of matchedGlobalCallbacks) {
          if (!continueProcessingHandlers) {
            break;
          }

          await new Promise(async (resolve, reject) => {
            try {
              if (!isFunction(handler)) {
                throw new TypeError(
                  'callback argument only accepts function as an argument',
                );
              }

              const resp = await (handler as RouterMiddlewareHandler)(
                request,
                response,
                nextFnGenerator(resolve, reject),
              );

              resolve(!!resp);
            } catch (err) {
              reject(err);
            }
          });
        }

        if (callFinalHandler) {
          //Process local handlers
          for await (const handler of matchedRouteInfo.callbacks) {
            if (!callFinalHandler) {
              break;
            }

            await new Promise(async (resolve, reject) => {
              try {
                if (!isFunction(handler)) {
                  throw new TypeError(
                    'callback argument only accepts function as an argument',
                  );
                }

                const resp = await (handler as RouterMiddlewareHandler)(
                  request,
                  response,
                  nextFnGenerator(resolve, reject),
                );

                callFinalHandler = !!resp;
                resolve(callFinalHandler);
              } catch (err) {
                reject(err);
              }
            });
          }
        }
      } catch (err) {
        const matchedGlobalErrorCallbacks = flatten(
          matchedGlobalMiddlewares.map(
            (route) => route.callbacks as RouterErrorMiddlewareHandler[],
          ),
        ).filter((callback) => callback.length > 3);

        if (matchedGlobalErrorCallbacks.length) {
          let continueProcessingHandlers = true;
          const next: NextFunction = (err) => {
            if (!(isUndefined(err) || isNull(err))) {
              continueProcessingHandlers = false;
            }
          };

          for await (const handler of matchedGlobalErrorCallbacks) {
            if (!continueProcessingHandlers) {
              break;
            }

            const resp = await handler(err, request, response, next);
            continueProcessingHandlers = !!resp;
          }

          if (continueProcessingHandlers) {
            throw err;
          }
        }
      }
    }

    return matchedRouteInfo;
  }
}
