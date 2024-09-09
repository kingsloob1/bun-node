import { EventEmitter } from "node:stream";
import isNumeric from "fast-isnumeric";
import { get, isArray, isFunction, isObject, set } from "lodash-es";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import {
  BunRequest,
  BunResponse,
  BunRouter,
  type BunServeOptions,
  type matchedRoute,
  type NextFunction,
} from "./index";

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

interface BunWebSocketGeneralOptions {
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
  serverOptions?: BunServeOptions;
  request?: BunRequest;
  response?: BunResponse;
}

export interface BunWebSocketNormalOptions extends BunWebSocketGeneralOptions {
  newInstance: false;
  getServer: () => Server | undefined;
}

export type BunWebSocketOptions =
  | BunWebSocketNormalOptions
  | BunWebSocketCreateServerOptions;

export class BunWebSocket extends EventEmitter {
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
      open: async (ws) => {
        this.emit("connect", ws);
        this.emit("open", ws);
        await this.processRegisteredRouteHandlerFor("open", ws);
      },
      message: async (ws, message) => {
        this.emit("message", ws, message);
        await this.processRegisteredRouteHandlerFor("message", ws);
      },
      close: async (ws) => {
        this.emit("disconnect", ws);
        this.emit("close", ws);
        await this.processRegisteredRouteHandlerFor("close", ws);
      },
      ping: async (ws, data) => {
        this.emit("ping", ws, data);
        await this.processRegisteredRouteHandlerFor("ping", ws);
      },
      pong: async (ws, data) => {
        this.emit("pong", ws, data);
        await this.processRegisteredRouteHandlerFor("pong", ws);
      },
      drain: async (ws) => {
        this.emit("drain", ws);
        await this.processRegisteredRouteHandlerFor("drain", ws);
      },
    } as WebSocketHandler<WebSocketClientData>;
    this._routerInstance = options.router || new BunRouter();
    this._routerInstance.setBunWebSocket(this);

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
            new BunRequest(nativeRequest, server, {
              canHandleUpload: false,
            });
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
              if (handlerToExecute && isFunction(handler)) {
                return handler.call(bunServer, ws, ...otherArgs);
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
