import type {
  Server as BunServerType,
  ServerWebSocket,
  WebSocketHandler,
} from "bun";
import type { BunRequestOptions } from "./BunHttpAdapter";
import type {
  BunRouter,
  BunServeNormalOptions,
  matchedRoute,
  NextFunction,
} from "./index";
import { EventEmitter } from "node:events";
import { BunRequest } from "./BunRequest";
import { BunResponse } from "./BunResponse";
import {
  get,
  isArray,
  isFunction,
  isNumeric,
  isObject,
  set,
} from "./utils/native";

/**
 * Minimal strongly-typed `EventEmitter` surface — replaces the `typed-emitter`
 * package without any runtime footprint.
 */
export interface TypedEmitter<
  Events extends Record<string, (...args: any[]) => any>,
> {
  addListener: <E extends keyof Events>(event: E, listener: Events[E]) => this;
  on: <E extends keyof Events>(event: E, listener: Events[E]) => this;
  once: <E extends keyof Events>(event: E, listener: Events[E]) => this;
  prependListener: <E extends keyof Events>(
    event: E,
    listener: Events[E],
  ) => this;
  prependOnceListener: <E extends keyof Events>(
    event: E,
    listener: Events[E],
  ) => this;
  off: <E extends keyof Events>(event: E, listener: Events[E]) => this;
  removeAllListeners: <E extends keyof Events>(event?: E) => this;
  removeListener: <E extends keyof Events>(
    event: E,
    listener: Events[E],
  ) => this;
  emit: <E extends keyof Events>(
    event: E,
    ...args: Parameters<Events[E]>
  ) => boolean;
  eventNames: () => (keyof Events | string | symbol)[];
  listeners: <E extends keyof Events>(event: E) => Events[E][];
  listenerCount: <E extends keyof Events>(event: E) => number;
  getMaxListeners: () => number;
  setMaxListeners: (maxListeners: number) => this;
}

export interface WebSocketClientData<CustomData = unknown> {
  path: string;
  headers: Headers;
  user?: Record<string, unknown>;
  custom: CustomData;
}

export type BunWebSocketServerType<customWebsocketDataType = unknown> =
  BunServerType<WebSocketClientData<customWebsocketDataType>>;

export type BunWebSocketHandlerType<customWebsocketDataType = unknown> =
  WebSocketHandler<WebSocketClientData<customWebsocketDataType>>;

export type BunWebsocketHandlerFor<
  MethodName extends keyof WebSocketHandler<unknown>,
  customWebsocketDataType = unknown,
> = BunWebSocketHandlerType<customWebsocketDataType>[MethodName];

export type WebSocketClient<customWebsocketDataType = unknown> =
  ServerWebSocket<WebSocketClientData<customWebsocketDataType>>;

export interface BunWebSocketGeneralOptions<customWebsocketDataType = unknown> {
  wsOptions?: Omit<
    BunWebSocketHandlerType<customWebsocketDataType>,
    "open" | "close" | "message" | "drain" | "ping" | "pong"
  >;
  router?: BunRouter;
  newInstance: boolean;
  customDataToWsClientFn?: (
    req: BunRequest,
    res: BunResponse,
  ) => customWebsocketDataType | Promise<customWebsocketDataType>;
}

export interface BunWebSocketCreateServerOptions<
  customWebsocketDataType = unknown,
  routesType extends string = never,
> extends Omit<BunWebSocketGeneralOptions<customWebsocketDataType>, "server"> {
  newInstance: true;
  listen: {
    host?: string;
    port: number;
  };
  serverOptions?: BunServeNormalOptions<
    WebSocketClientData<customWebsocketDataType>,
    routesType
  >;
  request?: BunRequest;
  response?: BunResponse<customWebsocketDataType>;
  bunRequestOpts?: BunRequestOptions;
}

export interface BunWebSocketNormalOptions<customWebsocketDataType = unknown>
  extends BunWebSocketGeneralOptions<customWebsocketDataType> {
  newInstance: false;
  getServer: () => BunWebSocketServerType<customWebsocketDataType> | undefined;
}

export type BunWebSocketOptions<
  customWebsocketDataType = unknown,
  routesType extends string = never,
> =
  | BunWebSocketNormalOptions<customWebsocketDataType>
  | BunWebSocketCreateServerOptions<customWebsocketDataType, routesType>;

export type BunWebSocketEventHandlersType<customWebsocketDataType = unknown> =
  TypedEmitter<{
    connect: NonNullable<
      BunWebSocketHandlerType<customWebsocketDataType>["open"]
    >;
    open: NonNullable<BunWebSocketHandlerType<customWebsocketDataType>["open"]>;
    message: NonNullable<
      BunWebSocketHandlerType<customWebsocketDataType>["message"]
    >;
    disconnect: NonNullable<
      BunWebSocketHandlerType<customWebsocketDataType>["close"]
    >;
    close: NonNullable<
      BunWebSocketHandlerType<customWebsocketDataType>["close"]
    >;
    ping: NonNullable<BunWebSocketHandlerType<customWebsocketDataType>["ping"]>;
    pong: NonNullable<BunWebSocketHandlerType<customWebsocketDataType>["pong"]>;
    drain: NonNullable<
      BunWebSocketHandlerType<customWebsocketDataType>["drain"]
    >;
  }>;

export class BunWebSocket<
  customWebsocketDataType = unknown,
> extends (EventEmitter as new () => BunWebSocketEventHandlersType) {
  private _wsServers = new Map<
    number,
    BunWebSocketServerType<customWebsocketDataType>
  >();

  private _serverInstance?: BunWebSocketServerType<customWebsocketDataType>;
  private _getServerInstance?: () =>
    | BunWebSocketServerType<customWebsocketDataType>
    | undefined;

  private _routerInstance!: BunRouter;
  private _wsHandler!: BunWebSocketHandlerType<customWebsocketDataType>;

  private _routeHandlers = new Map<
    string,
    BunWebSocketHandlerType<customWebsocketDataType>[]
  >();

  private _customDataToWsClientFn: BunWebSocketGeneralOptions<customWebsocketDataType>["customDataToWsClientFn"] =
    undefined;

  constructor(private options: BunWebSocketOptions<customWebsocketDataType>) {
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
    } as BunWebSocketHandlerType<customWebsocketDataType>;

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
      server = Bun.serve<WebSocketClientData<customWebsocketDataType>>({
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

          const res =
            options.response || new BunResponse<customWebsocketDataType>(req);
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

  public killServer(
    server: BunWebSocketServerType<customWebsocketDataType> | undefined,
  ) {
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
    ws: WebSocketClient<customWebsocketDataType>,
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
                      BunWebSocketHandlerType<customWebsocketDataType>["open"]
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
                      BunWebSocketHandlerType<customWebsocketDataType>["close"]
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
                      BunWebSocketHandlerType<customWebsocketDataType>["drain"]
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
                      BunWebSocketHandlerType<customWebsocketDataType>["message"]
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
                      BunWebSocketHandlerType<customWebsocketDataType>["ping"]
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
                      BunWebSocketHandlerType<customWebsocketDataType>["pong"]
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
                      handlerToExecute as (
                        ws: WebSocketClient<customWebsocketDataType>,
                      ) => unknown
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
    handler: BunWebSocketHandlerType<customWebsocketDataType>,
    customDataToWsClientFn: BunWebSocketGeneralOptions<customWebsocketDataType>["customDataToWsClientFn"],
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
        let getCustomDataFn: BunWebSocketGeneralOptions<customWebsocketDataType>["customDataToWsClientFn"];
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
