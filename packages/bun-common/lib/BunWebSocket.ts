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
  /**
   * The components of the upgrade request URL, mirroring what
   * `BunRequest.splitRequestUrl()` exposes: `host` (authority), `path`
   * (pathname only), `search` (`?…` or `""`), and `hash` (`#…` or `""`).
   * `originalUrl` is the full `path + search + hash` (`BunRequest.originalUrl`).
   */
  host: string;
  path: string;
  search: string;
  hash: string;
  originalUrl: string;
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

/**
 * The event map emitted by {@link BunWebSocket}. Declared as a `type` (not an
 * `interface`) so it satisfies `TypedEmitter`'s `Record<string, …>` constraint
 * — interfaces are open to augmentation and so lack an implicit index sig.
 */
// eslint-disable-next-line ts/consistent-type-definitions
export type BunWebSocketEvents<customWebsocketDataType = unknown> = {
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
  close: NonNullable<BunWebSocketHandlerType<customWebsocketDataType>["close"]>;
  ping: NonNullable<BunWebSocketHandlerType<customWebsocketDataType>["ping"]>;
  pong: NonNullable<BunWebSocketHandlerType<customWebsocketDataType>["pong"]>;
  drain: NonNullable<BunWebSocketHandlerType<customWebsocketDataType>["drain"]>;
};

export type BunWebSocketEventHandlersType<customWebsocketDataType = unknown> =
  TypedEmitter<BunWebSocketEvents<customWebsocketDataType>>;

/** A {@link BunWebSocket} event name. */
type WsEventName<T> = keyof BunWebSocketEvents<T>;
/** The listener signature for a given {@link BunWebSocket} event. */
type WsListener<T, E extends WsEventName<T>> = BunWebSocketEvents<T>[E];

export class BunWebSocket<customWebsocketDataType = unknown>
  implements BunWebSocketEventHandlersType<customWebsocketDataType>
{
  private _wsServers = new Map<
    number,
    BunWebSocketServerType<customWebsocketDataType>
  >();

  /**
   * Lazily-created event bus. `BunWebSocket` is not an `EventEmitter`
   * subclass; the emitter is built on the first `on`/`once`/... call so an
   * instance nobody listens to costs nothing, and `emit` is a no-op until
   * then.
   */
  #emitter: EventEmitter | undefined = undefined;

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

  /* ---------------------------------------------------------------- *
   * `TypedEmitter` surface — lazily backed by a `node:events` emitter.
   * ---------------------------------------------------------------- */

  /** Returns the emitter, creating it on demand. */
  private get events(): EventEmitter {
    if (!this.#emitter) {
      const emitter = new EventEmitter();
      emitter.setMaxListeners(0);
      this.#emitter = emitter;
    }
    return this.#emitter;
  }

  public addListener<E extends WsEventName<customWebsocketDataType>>(
    event: E,
    listener: WsListener<customWebsocketDataType, E>,
  ): this {
    this.events.addListener(event, listener as (...args: any[]) => void);
    return this;
  }

  public on<E extends WsEventName<customWebsocketDataType>>(
    event: E,
    listener: WsListener<customWebsocketDataType, E>,
  ): this {
    this.events.on(event, listener as (...args: any[]) => void);
    return this;
  }

  public once<E extends WsEventName<customWebsocketDataType>>(
    event: E,
    listener: WsListener<customWebsocketDataType, E>,
  ): this {
    this.events.once(event, listener as (...args: any[]) => void);
    return this;
  }

  public prependListener<E extends WsEventName<customWebsocketDataType>>(
    event: E,
    listener: WsListener<customWebsocketDataType, E>,
  ): this {
    this.events.prependListener(event, listener as (...args: any[]) => void);
    return this;
  }

  public prependOnceListener<E extends WsEventName<customWebsocketDataType>>(
    event: E,
    listener: WsListener<customWebsocketDataType, E>,
  ): this {
    this.events.prependOnceListener(
      event,
      listener as (...args: any[]) => void,
    );
    return this;
  }

  public off<E extends WsEventName<customWebsocketDataType>>(
    event: E,
    listener: WsListener<customWebsocketDataType, E>,
  ): this {
    this.#emitter?.off(event, listener as (...args: any[]) => void);
    return this;
  }

  public removeListener<E extends WsEventName<customWebsocketDataType>>(
    event: E,
    listener: WsListener<customWebsocketDataType, E>,
  ): this {
    this.#emitter?.removeListener(event, listener as (...args: any[]) => void);
    return this;
  }

  public removeAllListeners<E extends WsEventName<customWebsocketDataType>>(
    event?: E,
  ): this {
    this.#emitter?.removeAllListeners(event);
    return this;
  }

  /** Emits an event; returns `false` when there is no emitter/listener. */
  public emit<E extends WsEventName<customWebsocketDataType>>(
    event: E,
    ...args: Parameters<WsListener<customWebsocketDataType, E>>
  ): boolean {
    return this.#emitter ? this.#emitter.emit(event, ...args) : false;
  }

  public listeners<E extends WsEventName<customWebsocketDataType>>(
    event: E,
  ): WsListener<customWebsocketDataType, E>[] {
    return (this.#emitter?.listeners(event) ?? []) as WsListener<
      customWebsocketDataType,
      E
    >[];
  }

  public listenerCount<E extends WsEventName<customWebsocketDataType>>(
    event: E,
  ): number {
    return this.#emitter?.listenerCount(event) ?? 0;
  }

  public eventNames(): (
    | WsEventName<customWebsocketDataType>
    | string
    | symbol
  )[] {
    return this.#emitter?.eventNames() ?? [];
  }

  public getMaxListeners(): number {
    return this.#emitter?.getMaxListeners() ?? EventEmitter.defaultMaxListeners;
  }

  public setMaxListeners(maxListeners: number): this {
    this.events.setMaxListeners(maxListeners);
    return this;
  }

  public getOrCreateWebsocketServer(port: number) {
    const sharedServer = this.getServer();
    if (sharedServer && String(sharedServer.port) === String(port)) {
      this._wsServers.set(port, sharedServer);
      return sharedServer;
    }

    const cached = this._wsServers.get(port);
    if (cached) {
      return cached;
    }

    // Port `0` / unspecified means "ride on the existing (shared) server" — e.g.
    // a NestJS `@WebSocketGateway()` with no port shares the HTTP adapter's
    // server (which may not be listening yet, hence possibly `undefined`).
    if (!port || Number(port) <= 0) {
      return sharedServer;
    }

    // A specific port was requested (a standalone `newInstance` adapter, or a
    // `@WebSocketGateway(port)` declaring a non-shared port): bind a dedicated
    // server that listens on exactly that port.
    const server = this.buildWebsocketServer(port);
    this._wsServers.set(port, server);
    return server;
  }

  /**
   * Builds a Bun server (HTTP + WebSocket) bound to `port`, routing requests
   * through this instance's router and upgrading matched WS routes. Used both
   * for standalone (`newInstance`) adapters and for gateways that declare an
   * explicit port distinct from the shared HTTP server.
   */
  private buildWebsocketServer(port: number) {
    const options = this.options;
    const createOpts = options.newInstance ? options : undefined;

    return Bun.serve<WebSocketClientData<customWebsocketDataType>>({
      ...(createOpts?.serverOptions || {}),
      port,
      hostname: createOpts?.listen?.host,
      development: Bun.env.NODE_ENV !== "production",
      fetch: async (nativeRequest: Request, server) => {
        const req =
          createOpts?.request ||
          (await BunRequest.init(
            nativeRequest,
            server,
            createOpts?.bunRequestOpts || {
              parseBody: true,
              parseCookies: true,
              parseQuery: true,
            },
          ));

        const res =
          createOpts?.response || new BunResponse<customWebsocketDataType>(req);
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

        const hasNativeResponse = !!routeUsed;

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
            // Never re-invoke this instance's own aggregate handler: the Bun
            // server's `websocket` is already bound to `_wsHandler` (which both
            // emits events *and* calls this method), so a route registered with
            // `router.ws(path, this.wsHandler)` — as the NestJS adapter does —
            // would recurse infinitely once `path` matches the connection's
            // path (e.g. a gateway `namespace`). Per-route *user* handlers
            // (the normal `router.ws` use) are unaffected.
            .filter((handler) => handler !== this._wsHandler)
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
          host: req.host,
          path: req.path,
          search: req.search,
          hash: req.hash,
          originalUrl: req.originalUrl,
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
