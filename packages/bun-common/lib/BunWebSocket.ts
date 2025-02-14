/* eslint-disable perfectionist/sort-imports */
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type TypedEventEmitter from "typed-emitter";
import type {
  BunRouter,
  BunServeNormalOptions,
  BunServeNormalTlsOptions,
  matchedRoute,
  NextFunction,
} from "./index";
import { EventEmitter } from "node:stream";
import isNumeric from "fast-isnumeric";
import { get, isArray, isFunction, isObject, set } from "lodash-es";
import { BunRequest, BunResponse } from "./index";
import type { BunRequestOptions } from "./BunHttpAdapter";

export interface WebSocketClientData<CustomData = unknown> {
  path: string;
  headers: Headers;
  user?: Record<string, unknown>;
  custom: CustomData;
}

export type BunWebsocketHandlerFor<
  MethodName extends keyof WebSocketHandler,
  customDataType = unknown,
> = WebSocketHandler<WebSocketClientData<customDataType>>[MethodName];

export type WebSocketClient = ServerWebSocket<WebSocketClientData>;

export interface BunWebSocketGeneralOptions {
  wsOptions?: Omit<
    WebSocketHandler<WebSocketClientData>,
    "open" | "close" | "message" | "drain" | "ping" | "pong"
  >;
  router?: BunRouter;
  newInstance: boolean;
  customDataToWsClientFn?: (
    req: BunRequest,
    res: BunResponse,
  ) => unknown | Promise<unknown>;
}

export interface BunWebSocketCreateServerOptions
  extends Omit<BunWebSocketGeneralOptions, "server"> {
  newInstance: true;
  listen: {
    host?: string;
    port: number;
  };
  serverOptions?: BunServeNormalOptions | BunServeNormalTlsOptions;
  request?: BunRequest;
  response?: BunResponse;
  bunRequestOpts?: BunRequestOptions;
}

export interface BunWebSocketNormalOptions extends BunWebSocketGeneralOptions {
  newInstance: false;
  getServer: () => Server | undefined;
}

export type BunWebSocketOptions =
  | BunWebSocketNormalOptions
  | BunWebSocketCreateServerOptions;

export class BunWebSocket extends (EventEmitter as new () => TypedEventEmitter<{
  connect: NonNullable<WebSocketHandler<WebSocketClientData>["open"]>;
  open: NonNullable<WebSocketHandler<WebSocketClientData>["open"]>;
  message: NonNullable<WebSocketHandler<WebSocketClientData>["message"]>;
  disconnect: NonNullable<WebSocketHandler<WebSocketClientData>["close"]>;
  close: NonNullable<WebSocketHandler<WebSocketClientData>["close"]>;
  ping: NonNullable<WebSocketHandler<WebSocketClientData>["ping"]>;
  pong: NonNullable<WebSocketHandler<WebSocketClientData>["pong"]>;
  drain: NonNullable<WebSocketHandler<WebSocketClientData>["drain"]>;
}>) {
  private _wsServers = new Map<number, Server>();
  private _serverInstance?: Server;
  private _getServerInstance?: () => Server | undefined;
  private _routerInstance!: BunRouter;
  private _wsHandler!: WebSocketHandler<WebSocketClientData>;
  private _routeHandlers = new Map<
    string,
    WebSocketHandler<WebSocketClientData>[]
  >();

  private _customDataToWsClientFn: BunWebSocketGeneralOptions["customDataToWsClientFn"] =
    undefined;

  constructor(private options: BunWebSocketOptions) {
    super();

    this._wsHandler = {
      perMessageDeflate: true,
      idleTimeout: 30, // 30 seconds
      maxPayloadLength: 1024 * 1024, // 1 MB
      ...(options?.wsOptions || {}),
      open: async (...args) => {
        this.emit("connect", ...args);
        this.emit("open", ...args);
        await this.processRegisteredRouteHandlerFor("open", ...args);
      },
      message: async (...args) => {
        this.emit("message", ...args);
        await this.processRegisteredRouteHandlerFor("message", ...args);
      },
      close: async (...args) => {
        this.emit("disconnect", ...args);
        this.emit("close", ...args);
        await this.processRegisteredRouteHandlerFor("close", ...args);
      },
      ping: async (...args) => {
        this.emit("ping", ...args);
        await this.processRegisteredRouteHandlerFor("ping", ...args);
      },
      pong: async (...args) => {
        this.emit("pong", ...args);
        await this.processRegisteredRouteHandlerFor("pong", ...args);
      },
      drain: async (...args) => {
        this.emit("drain", ...args);
        await this.processRegisteredRouteHandlerFor("drain", ...args);
      },
    } as WebSocketHandler<WebSocketClientData>;

    if (options.router) {
      this.router = options.router;
    }

    if (options.newInstance) {
      if (!(options?.listen.port && isNumeric(options.listen.port))) {
        throw new Error("Ooops.. Port is required to start server");
      }

      this._serverInstance = this.getOrCreateWebsocketServer(
        options.listen.port,
      );
    } else {
      this._getServerInstance = options?.getServer;
    }

    if (options.customDataToWsClientFn) {
      this._customDataToWsClientFn = options.customDataToWsClientFn;
    }
  }

  public getOrCreateWebsocketServer(port: number) {
    let server = this.getServer();
    if (server && String(server?.port) === String(port)) {
      this._wsServers.set(port, server);
      return server;
    }

    server = this._wsServers.get(port);
    if (server) {
      return server;
    }

    const options = this.options;
    if (options.newInstance) {
      server = Bun.serve({
        ...(options?.serverOptions || {}),
        port,
        hostname: options?.listen?.host,
        development: Bun.env.NODE_ENV !== "production",
        fetch: async (nativeRequest: Request, server) => {
          const req =
            options.request ||
            (await BunRequest.init(
              nativeRequest,
              server,
              options.bunRequestOpts || {
                parseBody: true,
                parseCookies: true,
                parseQuery: true,
              },
            ));

          const res = options.response || new BunResponse(req);
          let routeUsed: matchedRoute | true | undefined;

          try {
            routeUsed = await this._routerInstance?.handle({
              requestHost: req.host,
              requestMethod: req.method,
              response: res,
              request: req,
              requestUrl: req.originalUrl,
            });
          } catch (e) {
            let err = e;
            if (!isObject(err)) {
              err = new Error(String(e));
            }

            set(err as unknown as Record<string, unknown>, "req", req);
            throw err;
          }

          let hasNativeResponse = false;
          if (routeUsed) {
            hasNativeResponse = true;
          }

          if (hasNativeResponse) {
            if (res.upgradeToWsData) {
              const success = server.upgrade(nativeRequest, {
                data: res.upgradeToWsData,
              });
              if (success) {
                return undefined;
              }

              let response = new Response(
                "An error occurred while upgrading websocket",
                {
                  status: 400,
                },
              );
              try {
                response = await res.getNativeResponse(100);
              } catch {
                //
              }

              return response;
            }

            const nativeResponse = await res.getNativeResponse(
              (options?.wsOptions?.idleTimeout || 60) * 1000,
            );
            return nativeResponse;
          }

          return new Response(undefined, {
            status: 404,
            statusText: "Not Found",
          });
        },
        websocket: this._wsHandler,
        async error(err) {
          throw err;
        },
      });

      this._wsServers.set(port, server);
      return server;
    }

    return undefined;
  }

  public killServer(server: Server | undefined) {
    if (server && server.port) {
      try {
        this.getOrCreateWebsocketServer(server.port)?.stop(false);
      } catch {
        //
      }

      this._wsServers.delete(server.port);
    }

    return this;
  }

  public get wsHandler() {
    return this._wsHandler;
  }

  public getServer() {
    if (this._serverInstance) {
      return this._serverInstance;
    }

    if (this._getServerInstance && isFunction(this._getServerInstance)) {
      return this._getServerInstance();
    }

    return undefined;
  }

  public get router() {
    return this._routerInstance;
  }

  set router(router: BunRouter) {
    this._routerInstance = router;
    this._routerInstance.setBunWebSocket(this);
  }

  private async processRegisteredRouteHandlerFor(
    event: "open" | "close" | "drain" | "message" | "ping" | "pong",
    ws: ServerWebSocket<WebSocketClientData>,
    ...otherArgs: unknown[]
  ) {
    const path = ws.data?.path;
    if (
      !!path &&
      ["open", "close", "drain", "message", "ping", "pong"].includes(event)
    ) {
      const handlersArr = this._routeHandlers.get(path);
      if (isArray(handlersArr)) {
        const bunServer = this.getServer();
        if (!bunServer) {
          return undefined;
        }

        await Promise.allSettled(
          handlersArr
            .map((handler) => {
              const handlerToExecute = isObject(handler)
                ? handler[event]
                : undefined;

              if (handlerToExecute && isFunction(handlerToExecute)) {
                switch (event) {
                  case "open": {
                    type HandlerFnType = NonNullable<
                      WebSocketHandler<WebSocketClientData>["open"]
                    >;
                    type FnHandlerParameters = Parameters<HandlerFnType>;

                    const [wsClient, ...fnArgs] = [
                      ws,
                      ...otherArgs,
                    ] as unknown as FnHandlerParameters;

                    return (handlerToExecute as HandlerFnType).call(
                      bunServer,
                      wsClient,
                      ...fnArgs,
                    );
                  }

                  case "close": {
                    type HandlerFnType = NonNullable<
                      WebSocketHandler<WebSocketClientData>["close"]
                    >;
                    type FnHandlerParameters = Parameters<HandlerFnType>;

                    const [wsClient, ...fnArgs] = [
                      ws,
                      ...otherArgs,
                    ] as unknown as FnHandlerParameters;

                    return (handlerToExecute as HandlerFnType).call(
                      bunServer,
                      wsClient,
                      ...fnArgs,
                    );
                  }

                  case "drain": {
                    type HandlerFnType = NonNullable<
                      WebSocketHandler<WebSocketClientData>["drain"]
                    >;
                    type FnHandlerParameters = Parameters<HandlerFnType>;

                    const [wsClient, ...fnArgs] = [
                      ws,
                      ...otherArgs,
                    ] as unknown as FnHandlerParameters;

                    return (handlerToExecute as HandlerFnType).call(
                      bunServer,
                      wsClient,
                      ...fnArgs,
                    );
                  }

                  case "message": {
                    type HandlerFnType = NonNullable<
                      WebSocketHandler<WebSocketClientData>["message"]
                    >;
                    type FnHandlerParameters = Parameters<HandlerFnType>;

                    const [wsClient, ...fnArgs] = [
                      ws,
                      ...otherArgs,
                    ] as unknown as FnHandlerParameters;

                    return (handlerToExecute as HandlerFnType).call(
                      bunServer,
                      wsClient,
                      ...fnArgs,
                    );
                  }

                  case "ping": {
                    type HandlerFnType = NonNullable<
                      WebSocketHandler<WebSocketClientData>["ping"]
                    >;
                    type FnHandlerParameters = Parameters<HandlerFnType>;

                    const [wsClient, ...fnArgs] = [
                      ws,
                      ...otherArgs,
                    ] as unknown as FnHandlerParameters;

                    return (handlerToExecute as HandlerFnType).call(
                      bunServer,
                      wsClient,
                      ...fnArgs,
                    );
                  }

                  case "pong": {
                    type HandlerFnType = NonNullable<
                      WebSocketHandler<WebSocketClientData>["pong"]
                    >;
                    type FnHandlerParameters = Parameters<HandlerFnType>;

                    const [wsClient, ...fnArgs] = [
                      ws,
                      ...otherArgs,
                    ] as unknown as FnHandlerParameters;

                    return (handlerToExecute as HandlerFnType).call(
                      bunServer,
                      wsClient,
                      ...fnArgs,
                    );
                  }

                  default: {
                    return (
                      handlerToExecute as (ws: WebSocketClient) => unknown
                    ).call(bunServer, ws);
                  }
                }
              }

              return undefined;
            })
            .filter((handler) => !!handler),
        );

        return handlersArr.length;
      }
    }

    return 0;
  }

  public async setRouteHandler(
    path: string,
    handler: WebSocketHandler<WebSocketClientData>,
    customDataToWsClientFn?: (
      req: BunRequest,
      res: BunResponse,
    ) => unknown | Promise<unknown>,
  ) {
    if (!isObject(handler)) {
      return false;
    }

    // Set the path and handler
    {
      let handlersArr = this._routeHandlers.get(path) || [];
      if (!isArray(handlersArr)) {
        handlersArr = [];
      }

      if (!handlersArr.includes(handler)) {
        handlersArr.push(handler);
      }

      this._routeHandlers.set(path, handlersArr);
    }

    // Register upgrade endpoint for route
    const wsRouteHandler = async (
      req: BunRequest,
      res: BunResponse,
      next: NextFunction,
    ) => {
      const connectionHeader = String(
        req.headersObj.get("connection")?.toLowerCase() || "",
      );
      const upgradeHeader = String(
        req.headersObj.get("upgrade")?.toLowerCase() || "",
      );
      const secWebsocketKey = String(
        req.headersObj.get("sec-websocket-key") || "",
      );

      if (
        req.method?.toLowerCase() === "get" &&
        connectionHeader.startsWith("upgrade") &&
        upgradeHeader === "websocket" &&
        secWebsocketKey
      ) {
        let getCustomDataFn: BunWebSocketGeneralOptions["customDataToWsClientFn"];
        if (customDataToWsClientFn && isFunction(customDataToWsClientFn)) {
          getCustomDataFn = customDataToWsClientFn;
        } else if (
          this._customDataToWsClientFn &&
          isFunction(this._customDataToWsClientFn)
        ) {
          getCustomDataFn = this._customDataToWsClientFn;
        }

        let customData: unknown;
        if (getCustomDataFn) {
          customData = await Promise.resolve(getCustomDataFn(req, res));
        }

        const data: WebSocketClientData = {
          path: req.path,
          headers: req.headersObj as unknown as Headers,
          user: get(req, "user", undefined),
          custom: customData,
        };

        return res.upgradeToWebsocket(data);
      }

      next();
    };

    this.router.setRoute({
      path,
      method: undefined,
      callbacks: [wsRouteHandler],
    });

    return true;
  }
}
