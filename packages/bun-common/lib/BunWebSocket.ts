import { EventEmitter } from "node:stream";
import { createHash } from "node:crypto";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { get, isArray, isFunction, isObject, set } from "lodash-es";
import isNumeric from "fast-isnumeric";
import {
  BunRequest,
  BunResponse,
  BunRouter,
  type BunServeOptions,
  type NextFunction,
  type matchedRoute,
} from "./index";

export interface WebSocketClientData {
  path: string;
  headers: Headers;
  user?: Record<string, unknown>;
  [string: string]: unknown;
}

export type WebSocketClient = ServerWebSocket<WebSocketClientData>;

interface BunWebSocketGeneralOptions {
  wsOptions?: Omit<
    WebSocketHandler<WebSocketClientData>,
    "open" | "close" | "message" | "drain" | "ping" | "pong"
  >;
  router?: BunRouter;
  newInstance: boolean;
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
  private _serverInstance?: Server;
  private _getServerInstance?: () => Server | undefined;
  private _routerInstance!: BunRouter;
  private _wsHandler!: WebSocketHandler<WebSocketClientData>;
  private _routeHandlers = new Map<
    string,
    WebSocketHandler<WebSocketClientData>[]
  >();

  constructor(private options: BunWebSocketOptions) {
    super();

    this._wsHandler = {
      perMessageDeflate: true,
      idleTimeout: 30, // 30 seconds
      maxPayloadLength: 1024 * 1024, // 1 MB
      ...(options?.wsOptions || {}),
      open: async (ws) => {
        this.emit("connect", ws);
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

    if (options.newInstance) {
      if (!(options?.listen.port && isNumeric(options.listen.port))) {
        throw new Error("Ooops.. Port is required to start server");
      }

      this._serverInstance = Bun.serve({
        ...(options?.serverOptions || {}),
        port: options?.listen.port,
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
            const nativeResponse = await res.getNativeResponse(
              (options?.wsOptions?.idleTimeout || 60) * 1000,
            );
            return nativeResponse;
          }

          return new Response(undefined, {
            status: 400,
            statusText: "Not Found",
          });
        },
        websocket: this._wsHandler,
        async error(err) {
          throw err;
        },
      });
    } else {
      this._getServerInstance = options?.getServer;
    }
  }

  public get wsHandler() {
    return this._wsHandler;
  }

  public getServer() {
    if (this._serverInstance) {
      return this._serverInstance;
    }

    if (this._getServerInstance) {
      return this._getServerInstance();
    }
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

  #getWebSocketAcceptKey(websocketKey: string) {
    // Predefined GUID for WebSocket handshake
    const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    // Concatenate the client's key with the GUID
    const combinedKey = websocketKey + GUID;

    // Compute the SHA-1 hash
    const hash = createHash("sha1");
    hash.update(combinedKey);
    const hashResult = hash.digest("base64");

    return hashResult;
  }

  public async setRouteHandler(
    path: string,
    handler: WebSocketHandler<WebSocketClientData>,
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
        const server = this.getServer();
        if (!server) {
          return res.status(400).end();
        }

        const data: WebSocketClientData = {
          path: req.path,
          headers: req.headersObj as unknown as Headers,
          user: get(req, "user", undefined),
        };

        try {
          const headers = {
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Accept":
              this.#getWebSocketAcceptKey(secWebsocketKey),
          };
          const success = server.upgrade(req.request, { headers, data });
          Bun.sleepSync(2000);

          if (success) {
            return res
              .status(101)
              .statusText("Switching to WebSocket protocol")
              .setHeaders(headers)
              .end();
          }
        } catch (e) {
          console.error(e);
        }

        return res.status(400).end();
      }

      next();
    };

    this.router.setRoute({
      name: "ws-handler",
      path,
      method: undefined,
      callbacks: [wsRouteHandler],
    });

    return true;
  }
}
