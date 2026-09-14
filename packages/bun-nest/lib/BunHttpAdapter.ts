/* eslint-disable ts/no-unsafe-function-type */

import type {
  BodyParserOptions,
  BodyParserType,
  BunRequestOptions,
  BunRouterOptions,
  BunServeNormalOptions,
  BunServeOptions,
  BunServer,
  BunWebSocketHandlerType,
  BunWebSocketNormalOptions,
  BunWebSocketServerType,
  CorsOptions as MainCorsOptions,
  matchedRoute,
  NextFunction,
  RouterErrorMiddlewareHandler,
  RouterHandler,
  RouterMiddlewareHandler,
  ServeStaticOptions,
} from "@kingsleyweb/bun-common";
import type { NestApplicationOptions } from "@nestjs/common";
import type {
  CorsOptions,
  CorsOptionsDelegate,
} from "@nestjs/common/interfaces/external/cors-options.interface";
import type { AddressInfo } from "node:net";
import type {
  BunWebSocketAdapterOptions,
  WebSocketClientData,
} from "./BunWebSocketAdapter";
import { EventEmitter } from "node:events";
import { isIPv4, isIPv6 } from "node:net";
import process from "node:process";
import { promisify } from "node:util";
import { isPromise } from "node:util/types";
import {
  BunRequest,
  BunResponse,
  BunRouter,
  cors,
  createServeStaticHandler,
  each,
  get,
  getPort,
  isFunction,
  isNull,
  isObject,
  isString,
  isUndefined,
  omit,
  set,
  waitUntil,
} from "@kingsleyweb/bun-common";
import {
  InternalServerErrorException,
  Logger,
  RequestMethod,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import { AbstractHttpAdapter } from "@nestjs/core/adapters/http-adapter";
import { BunNestWebsocketAdapter } from "./BunWebSocketAdapter";

export type VersionedRoute = (
  req: BunRequest,
  res: BunResponse,
  next: NextFunction,
) => Function;

export type WebsocketOptions<
  customWebsocketDataType = unknown,
  routesType extends string = never,
> = BunWebSocketAdapterOptions<customWebsocketDataType, routesType>;

export type MiddlewareFactoryRespType = (
  path: string,
  callback: Function,
) => unknown;

type ApplyVersionFilterParameters = Parameters<
  AbstractHttpAdapter["applyVersionFilter"]
>;

export const man = 1;

export class BunHttpAdapter<
  customWebsocketDataType = unknown,
  routesType extends string = never,
> extends AbstractHttpAdapter<
  BunWebSocketServerType<customWebsocketDataType>,
  BunRequest,
  BunResponse<customWebsocketDataType>
> {
  declare public instance: BunRouter;
  declare public httpServer: BunWebSocketServerType<customWebsocketDataType>;

  #requestOpts!: BunRequestOptions;

  public _logger!: Logger;
  private _websocketAdapter!: BunNestWebsocketAdapter<customWebsocketDataType>;
  private _serverInstance:
    | BunWebSocketServerType<customWebsocketDataType>
    | undefined = undefined;

  private _listeningHost = "127.0.0.1";
  private _listeningPort: string | number = 3000;
  protected isServerListening = false;
  private serverOptions:
    | BunServeNormalOptions<
        WebSocketClientData<customWebsocketDataType>,
        routesType
      >
    | undefined = undefined;

  private _notFoundHandlers: RouterMiddlewareHandler[] = [];
  private _errorHandlers: RouterErrorMiddlewareHandler[] = [];
  private _hasRegisteredBodyParser = false;
  /** When true, every response computes an `ETag`. Opt-in (off by default). */
  protected etagEnabled = false;
  public readonly eventEmitter = new EventEmitter();

  constructor(
    /**
     * Per-request timeout in milliseconds applied when finalising a response
     * (passed to {@link BunResponse.getNativeResponse}). `0` means no timeout.
     */
    protected requestTimeout = 0,
    options?: {
      /**
       * Request-parsing options forwarded to every {@link BunRequest}
       * (body/cookie/query parsing, size caps, etc.). Defaults to
       * `{ parseBody: true, parseCookies: true }`.
       */
      request?: BunRequestOptions;
      /**
       * Overrides for the built-in NestJS WebSocket adapter. Merged over the
       * defaults that bind the adapter to this HTTP adapter (its router and
       * shared `Bun.serve` server). A custom adapter can also be supplied later
       * via `app.useWebSocketAdapter()`.
       */
      websocket?: Partial<
        WebsocketOptions<customWebsocketDataType, routesType>
      >;
      /** NestJS {@link Logger} used for adapter diagnostics. */
      logger?: Logger;
      /**
       * Options for the underlying {@link BunRouter} (e.g. `caseSensitive`,
       * `debug`). Defaults to `{ caseSensitive: true, debug: false }`.
       */
      router?: BunRouterOptions;
      /** Enable automatic `ETag` generation for every response. */
      etag?: boolean;
      /**
       * Upper bound on the router's matched-pipeline cache before FIFO
       * eviction. Forwarded to {@link BunRouter}; defaults to
       * {@link DEFAULT_ROUTE_CACHE_MAX} (50 000). Pass `0` to disable the
       * cache entirely.
       *
       * The cache is keyed by resolved path, so a route carrying an id needs
       * one entry per distinct id seen. Size this above the number of
       * distinct paths in flight, or set `0` — a value between the two means
       * every request misses *and* pays eviction.
       */
      routeCacheMax?: number;
      /**
       * Base `Bun.serve` options merged into the server created in `listen()`
       * (TLS, `maxRequestBodySize`, etc.). `port`/`hostname`/`fetch`/`websocket`
       * are managed by the adapter and override anything set here.
       */
      server?: BunServeNormalOptions<
        WebSocketClientData<customWebsocketDataType>,
        routesType
      >;
    },
  ) {
    const routerOptions: BunRouterOptions = {
      caseSensitive: true,
      debug: false,
      ...(options?.router ?? {}),
      ...(options?.routeCacheMax !== undefined
        ? { routeCacheMax: options.routeCacheMax }
        : {}),
    };
    const router = new BunRouter(routerOptions);
    super(router);

    const logger = options?.logger || new Logger();
    this.setInstance(router);

    this.requestOpts = options?.request || {
      parseBody: true,
      parseCookies: true,
    };

    this.etagEnabled = options?.etag ?? false;
    this.logger = logger;
    this.serverOptions = options?.server || {};

    const websocketOptions = options?.websocket || {};
    const websocketLocalOptions =
      "localOptions" in websocketOptions
        ? websocketOptions.localOptions
        : "newInstance" in websocketOptions
          ? omit(websocketOptions, ["httpAdapter"])
          : undefined;
    const websocketHttpAdapter = websocketOptions?.httpAdapter ?? this;

    this.webSocketAdapter = new BunNestWebsocketAdapter<
      customWebsocketDataType,
      routesType
    >({
      httpAdapter: websocketHttpAdapter,
      localOptions: {
        router: websocketHttpAdapter.instance,
        newInstance: false,
        wsOptions: websocketLocalOptions?.wsOptions,
        customDataToWsClientFn: websocketLocalOptions?.customDataToWsClientFn,
        getServer() {
          const noNewInstanceWsOptions =
            websocketLocalOptions &&
            "newInstance" in websocketLocalOptions &&
            !websocketLocalOptions.newInstance
              ? (websocketLocalOptions as unknown as BunWebSocketNormalOptions<customWebsocketDataType>)
              : undefined;

          return noNewInstanceWsOptions
            ? noNewInstanceWsOptions.getServer()
            : websocketHttpAdapter.getBunServer();
        },
      },

      // httpAd
      // router: this,
      // newInstance: false,
      // getServer: () => {
      //   return this.getBunServer();
      // },
      // ...websocketOptions,
    });

    this.defineHttpServer();
  }

  get requestOpts() {
    return this.#requestOpts;
  }

  set requestOpts(opts: BunRequestOptions) {
    this.#requestOpts = opts;
  }

  setRequestOpts(opts: BunRequestOptions) {
    this.requestOpts = opts;
    return this;
  }

  get logger(): Logger {
    if (this._logger) {
      return this._logger;
    }

    // Lazily create a logger rather than recursing into this getter.
    this._logger = new Logger(BunHttpAdapter.name);
    return this._logger;
  }

  set logger(logger: Logger) {
    this._logger = logger;
  }

  setLogger(logger: Logger) {
    this.logger = logger;
    return this;
  }

  get serverAddress(): AddressInfo {
    let port = Number(this._listeningPort || 3000);
    let hostname = this._listeningHost || "127.0.0.1";
    let address: AddressInfo | undefined;

    if (this.isServerListening && this._serverInstance) {
      hostname = this._serverInstance.hostname ?? hostname;
      port = Number(this._serverInstance.port);
      address = get(this._serverInstance, "address", undefined) as
        | AddressInfo
        | undefined;
    }

    if (address) {
      return address;
    }

    return {
      address: hostname,
      family: "IPv4",
      port,
    };
  }

  address() {
    return this.serverAddress;
  }

  get url() {
    return (
      this.server?.url?.origin ||
      `http://${this.listeningHost}:${this.listeningPort}`
    );
  }

  get webSocketAdapter() {
    return this._websocketAdapter;
  }

  set webSocketAdapter(
    adapter: BunNestWebsocketAdapter<customWebsocketDataType>,
  ) {
    this._websocketAdapter = adapter;
    this.instance.setBunWebSocket(this.webSocketAdapter);
  }

  public get isListening() {
    return !!this._serverInstance?.url || this.isServerListening;
  }

  public get listening() {
    return this.isListening;
  }

  public get listeningHost() {
    if (this._serverInstance?.url?.hostname) {
      return String(this._serverInstance.url.hostname);
    }

    if (this.serverAddress?.address) {
      return String(this.serverAddress.address);
    }

    return this._listeningHost;
  }

  public get listeningPort() {
    if (this._serverInstance?.url?.port) {
      return Number(this._serverInstance.url.port);
    }

    if (this.serverAddress?.port) {
      return Number(this.serverAddress.port);
    }

    return Number(this._listeningPort);
  }

  get timeout() {
    return this.requestTimeout;
  }

  public setTimeout(reqTimeout: number, callback: CallableFunction) {
    this.requestTimeout = reqTimeout;
    return waitUntil(
      () => this.getBunServer(),
      (server) => !!server,
    ).then(
      callback as unknown as (
        server: BunWebSocketServerType<customWebsocketDataType> | undefined,
      ) => unknown,
    );
  }

  public getHeader(response: BunResponse, name: string) {
    return response.getHeader(name);
  }

  public appendHeader(response: BunResponse, name: string, value: string) {
    response.appendHeader(name, value);
    return this;
  }

  private registerBodyParser(
    prefix?: string | undefined,
    rawBody?: boolean,
    options?: BodyParserOptions,
  ) {
    if (this._hasRegisteredBodyParser) {
      return;
    }

    const middlewareHandler: RouterMiddlewareHandler = async (req, _, next) => {
      const buffer = await req.handleBodyParsing(true, options);
      if (rawBody) {
        set(req, "rawBody", buffer);
      }

      if (next) {
        next();
      }
    };

    if (isString(prefix) && prefix) {
      this.use(prefix, middlewareHandler);
    } else {
      this.use(middlewareHandler);
    }

    // Mark as registered so a second call does not stack a duplicate parser.
    this._hasRegisteredBodyParser = true;
    return this;
  }

  public useBodyParser(
    _: BodyParserType,
    rawBody: boolean,
    options: BodyParserOptions,
  ) {
    return this.registerBodyParser(undefined, rawBody, options);
  }

  public async setListenOptions(
    options: Partial<BunServeOptions> & {
      hostname?: string;
      port: string | number;
    },
  ): Promise<BunWebSocketServerType<customWebsocketDataType> | undefined> {
    const hostname = options.hostname || "127.0.0.1";
    const port = options.port;

    const mainServeOptions = omit(options, ["hostname", "port"]);
    const serverOptions = this.serverOptions || {};

    each(mainServeOptions, (value, key) => {
      set(serverOptions, key, value);
    });

    this.serverOptions = serverOptions;
    return await this.listen(port, hostname);
  }

  public async listen(
    port: string | number,
    callback?: (...args: unknown[]) => void,
  ): Promise<BunServer>;
  public async listen(
    port: string | number,
    hostname: string,
    callback?: (...args: unknown[]) => void,
  ): Promise<BunServer>;
  public async listen(
    port: number | string,
    hostname?: string | ((...args: unknown[]) => void),
    callback?: (...args: unknown[]) => void,
  ) {
    // The callback may arrive as the 2nd argument (`listen(port, cb)`, the form
    // NestJS's `app.listen()` uses) or the 3rd (`listen(port, host, cb)`).
    // Resolve it *before* normalising `hostname`, otherwise the 2nd-arg form
    // loses the callback and `app.listen()` never resolves.
    callback = isFunction(hostname)
      ? hostname
      : isFunction(callback)
        ? callback
        : () => undefined;

    hostname =
      typeof hostname === "string" && (isIPv4(hostname) || isIPv6(hostname))
        ? hostname
        : "127.0.0.1";

    port = Number(port);
    if (!(this.listeningHost === hostname && this.listeningPort === port)) {
      await this._serverInstance?.stop(true);
      this._serverInstance = undefined;
      this.isServerListening = false;
    }

    if (this.isServerListening || this._serverInstance) {
      if (callback) {
        await callback(this._serverInstance);
      }

      return this._serverInstance;
    }

    const portsToTest: number[] = [port];
    while (portsToTest.length < 10) {
      portsToTest.push(port + portsToTest.length);
    }

    const availablePort = await getPort({
      host: hostname,
      port: portsToTest,
    });

    this._listeningHost = hostname;
    this._listeningPort = availablePort;

    try {
      // eslint-disable-next-line ts/no-this-alias
      const that = this;
      const httpServer = Bun.serve<
        WebSocketClientData<customWebsocketDataType>,
        routesType
      >({
        ...(this.serverOptions || {}),
        port: this._listeningPort,
        hostname: this._listeningHost,
        development: Bun.env.NODE_ENV !== "production",
        async fetch(nativeRequest: Request, server) {
          // `BunRequest.init` returns the instance synchronously when no body
          // or cookie parsing was scheduled. Branching (rather than awaiting
          // unconditionally) is what banks the saving — `await` on a plain
          // value still costs a microtask tick.
          const created = BunRequest.init(
            nativeRequest,
            server,
            that.requestOpts,
          );
          const req = created instanceof BunRequest ? created : await created;

          // DDoS guard: a body that exceeded `parseBody.maxContentLength` is
          // rejected with 413 before any route handler or middleware runs.
          if (req.isPayloadTooLarge) {
            return BunRequest.payloadTooLargeResponse(req);
          }

          const res = new BunResponse<customWebsocketDataType>(req, {
            etag: that.etagEnabled,
          });
          let routeUsed: matchedRoute | true | undefined;

          try {
            routeUsed = await that.instance.handle({
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
          } else if (that._notFoundHandlers.length) {
            let continueProcessingHandlers = true;
            const next: NextFunction = (err) => {
              if (!(isUndefined(err) || isNull(err))) {
                continueProcessingHandlers = false;
              }
            };

            for await (const handler of that._notFoundHandlers) {
              if (!continueProcessingHandlers) {
                break;
              }

              const resp = await handler(req, res, next);
              continueProcessingHandlers = !!resp;
            }

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

            // A handler that called `send()` has already produced the native
            // response synchronously; taking it directly avoids a
            // `Promise.resolve` plus a microtask tick on the common path.
            return (
              res.settledResponse ??
              (await res.getNativeResponse(that.requestTimeout))
            );
          }

          return new Response(undefined, {
            status: 404,
            statusText: "Not Found",
          });
        },
        websocket: that.buildServerWebSocketHandler(),
        async error(err) {
          const req = get(err, "req", undefined) as BunRequest | undefined;
          if (!req) {
            throw err;
          }

          let continueProcessingHandlers = true;
          const next: NextFunction = (err) => {
            if (!(isUndefined(err) || isNull(err))) {
              continueProcessingHandlers = false;
            }
          };

          const response = new BunResponse(req, { etag: that.etagEnabled });
          for await (const handler of that._errorHandlers) {
            if (!continueProcessingHandlers) {
              break;
            }

            const resp = await handler(err, req, response, next);
            continueProcessingHandlers = !!resp;
          }

          if (that._errorHandlers.length) {
            const nativeResponse = await response.getNativeResponse(1000);
            return nativeResponse;
          } else {
            throw err;
          }
        },
      });

      this._serverInstance = httpServer;
      const address = await this.getListenAddress();

      if (!(address && this._serverInstance)) {
        throw new Error(
          `Ooops an error occurred while listening on ${this._listeningHost}:${this._listeningPort}`,
        );
      }

      this.isServerListening = true;
      this.eventEmitter.emit("listening", this._serverInstance);

      if (callback) {
        await callback(this._serverInstance);
      }

      return this._serverInstance;
    } catch (e) {
      const errorMessage = "Error while binding to listener...";
      this.logger.log(errorMessage);
      this.logger.log(e);
      process.exit(1);
    }
  }

  public async getListenAddress(): Promise<URL> {
    const url = await waitUntil(
      () => this._serverInstance?.url,
      (url) => !!url,
    );

    return url as URL;
  }

  public reply(
    response: BunResponse,
    /**
     * The body to send. Anything {@link BunResponse.send} accepts — text,
     * objects (JSON), binary (`Buffer`/typed array/`ArrayBuffer`), `BunFile`,
     * streams, `FormData`/`URLSearchParams` and async iterables.
     */
    body: Parameters<BunResponse["send"]>[0],
    /** Optional status code applied before sending. */
    statusCode?: number,
  ) {
    if (statusCode) {
      response = response.status(statusCode);
    }

    return response.send(body);
  }

  public status(response: BunResponse, statusCode: number) {
    return response.status(statusCode);
  }

  public end(response: BunResponse, message?: string) {
    return response.headersSent ? undefined : response.send(message);
  }

  public render(response: BunResponse, view: string, options: any) {
    const file = Bun.file(view);
    response.setHeader("Content-Type", file.type);
    return response.status(options.status || 200).send(file.stream());
  }

  public redirect(response: BunResponse, statusCode: number, url: string) {
    response.setHeader("Location", url);
    return response.status(statusCode || 302);
  }

  public isHeadersSent(response: BunResponse) {
    const nativeResp = Bun.peek(response.getNativeResponse());
    if (isPromise(nativeResp)) {
      return false;
    }

    return !!nativeResp;
  }

  public setHeader(response: BunResponse, name: string, value: string) {
    response.setHeader(name, value);
  }

  // `prefix` is accepted for `AbstractHttpAdapter` signature parity; these
  // handlers are applied globally as a final fallback (see `listen`).
  public setErrorHandler(
    handler: RouterErrorMiddlewareHandler,
    _prefix?: string,
  ) {
    this._errorHandlers.push(handler);
  }

  public setNotFoundHandler(
    handler: RouterMiddlewareHandler,
    _prefix?: string,
  ) {
    this._notFoundHandlers.push(handler);
  }

  /**
   * Serves a directory of files under `options.prefix`.
   *
   * Shares bun-common's implementation, so behaviour matches that adapter
   * exactly: directory indexes, extension fallbacks, dotfile policy, `ETag` /
   * `Last-Modified` validators (so conditional requests answer `304`),
   * `Cache-Control` from `maxAge`/`immutable`, and a `404` — not a `500` — for
   * a path that resolves to nothing. Range requests are served as `206` by Bun.
   */
  public useStaticAssets(path: string, options: ServeStaticOptions) {
    const { prefix, handler } = createServeStaticHandler(path, options);

    return this.instance.get(`${prefix}/*`, handler);
  }

  public getRequestHostname(request: BunRequest): string {
    const defaultHostname = "127.0.0.1";
    const headerHost = request.host;
    return headerHost || defaultHostname;
  }

  public getRequestMethod(request: BunRequest): string {
    return request.method;
  }

  public getRequestUrl(request: BunRequest): string {
    return request.originalUrl;
  }

  public registerParserMiddleware(prefix?: string, rawBody?: boolean) {
    this.registerBodyParser(prefix, rawBody, {
      inflate: true,
    });

    return this;
  }

  public enableCors(
    options: CorsOptions | CorsOptionsDelegate<BunRequest>,
    prefix?: string,
  ) {
    const handler: RouterHandler = async (
      req: BunRequest,
      res: BunResponse,
      next: NextFunction,
    ) => {
      let corsHandler: RouterHandler | undefined;
      if (isFunction(options)) {
        try {
          const promisedFn = promisify(options);
          const corsOpts = await promisedFn(req);

          corsHandler = cors(corsOpts as unknown as MainCorsOptions);
        } catch (e) {
          return res.status(400).end(e);
        }
      } else {
        corsHandler = cors(options as unknown as MainCorsOptions);
      }

      if (!corsHandler) {
        corsHandler = cors();
      }

      return corsHandler(req, res, next);
    };

    if (prefix) {
      this.use(prefix, handler);
      const router = new BunRouter();
      router.options("*", handler);
      this.instance.group(prefix, router);
      return this;
    }

    this.use(handler);
    this.instance.options("*", handler);
    return this;
  }

  public async close() {
    try {
      if (this._serverInstance && this.isServerListening) {
        // Force-close active (keep-alive) connections so the port is fully
        // released; a graceful stop can leave the listener lingering.
        await this._serverInstance.stop(true);
      }
    } catch (err) {
      this.logger.error(
        "An error occurred while closing bun http adapter ====> ",
        err,
      );
    }
    this.eventEmitter.emit("close");
    this._serverInstance = undefined;
    this.isServerListening = false;
    this._errorHandlers = [];
    this._notFoundHandlers = [];
  }

  public getType(): string {
    return "express";
  }

  get server() {
    return this._serverInstance;
  }

  public getBunServer() {
    return this.server;
  }

  /**
   * Resolves the WebSocket adapter currently registered on the router. NestJS's
   * `app.useWebSocketAdapter(customAdapter)` swaps the active adapter by calling
   * `instance.setBunWebSocket(customAdapter)` (via the adapter's constructor),
   * so `instance.getBunWebsocket()` is the source of truth — the custom adapter
   * when one was supplied, otherwise this adapter's built-in one.
   */
  private resolveWebSocketAdapter() {
    return this.instance.getBunWebsocket() ?? this.webSocketAdapter;
  }

  /**
   * Builds the `websocket` handler handed to `Bun.serve`. `Bun.serve` reads the
   * handler object once at `listen()` time, but NestJS can swap the active
   * WebSocket adapter beforehand via `app.useWebSocketAdapter()`. Hard-wiring
   * the built-in adapter's handler here would bypass a custom adapter entirely
   * (gateway connect/message bindings live on *its* emitter and route table),
   * which is the bug this fixes. So every lifecycle callback is delegated to
   * whichever adapter is active on the router at call time; the one-time config
   * fields (idleTimeout, maxPayloadLength, …) are taken from the active adapter
   * at bind time, matching Bun's one-time read of those props.
   */
  private buildServerWebSocketHandler(): BunWebSocketHandlerType<customWebsocketDataType> {
    const base = this.resolveWebSocketAdapter().wsHandler;
    const handler = {
      ...base,
    } as BunWebSocketHandlerType<customWebsocketDataType>;

    const lifecycleEvents = [
      "open",
      "message",
      "close",
      "drain",
      "ping",
      "pong",
    ] as const;

    for (const event of lifecycleEvents) {
      (handler as unknown as Record<string, unknown>)[event] = (
        ...args: unknown[]
      ) => {
        const active = this.resolveWebSocketAdapter()
          .wsHandler as unknown as Record<
          string,
          ((...callArgs: unknown[]) => unknown) | undefined
        >;
        return active[event]?.(...args);
      };
    }

    return handler;
  }

  public defineHttpServer() {
    if (this.httpServer) {
      return this.httpServer;
    }

    // Bypass event handlers added to httpServer and call of address
    this.httpServer = new Proxy({} as unknown as BunServer, {
      get: (_, prop) => {
        switch (true) {
          case [
            "emit",
            "on",
            "once",
            "addListener",
            "off",
            "removeListener",
            "eventNames",
            "listeners",
            "listenerCount",
            "removeAllListeners",
          ].includes(prop as string): {
            let method = get(this.eventEmitter, prop as string) as
              | CallableFunction
              | undefined;

            if (method) {
              method = method.bind(this.eventEmitter);
              return method;
            }

            return () => null;
          }

          case prop === "then": {
            return new Promise(async (resolve) => {
              await waitUntil(
                () => this._serverInstance && this.isServerListening,
                (isReady) => !!isReady,
              );

              resolve(this._serverInstance);
            });
          }

          default: {
            if (Reflect.has(this, prop)) {
              return Reflect.get(this, prop, this);
            }

            if (
              this._serverInstance &&
              Reflect.has(this._serverInstance, prop)
            ) {
              return Reflect.get(
                this._serverInstance,
                prop,
                this._serverInstance,
              );
            }

            return undefined;
          }
        }
      },
    });

    return this.httpServer;
  }

  public getHttpServer() {
    return this.defineHttpServer();
  }

  public setHttpServer(
    server: BunWebSocketServerType<customWebsocketDataType>,
  ) {
    this.httpServer = server;
    return this;
  }

  public async init() {
    if (this.server) {
      return;
    }

    this.defineHttpServer();
  }

  // `options` is accepted for `AbstractHttpAdapter` signature parity; the Bun
  // server is configured via the constructor's `server` option / setListenOptions.
  public async initHttpServer(_options?: NestApplicationOptions) {
    await this.init();
    return this.httpServer;
  }

  /**
   * Delegates an HTTP-verb route registration to the underlying
   * {@link BunRouter}. Centralises the `(path?, ...callbacks)` argument
   * shuffling shared by every verb override below.
   */
  private registerVerb(
    verb:
      | "use"
      | "get"
      | "post"
      | "head"
      | "delete"
      | "put"
      | "patch"
      | "propfind"
      | "proppatch"
      | "mkcol"
      | "copy"
      | "move"
      | "lock"
      | "unlock"
      | "all"
      | "search"
      | "options",
    path: string | RouterHandler | undefined,
    callbacks: RouterHandler[],
  ): this {
    const args: (string | RouterHandler)[] =
      path == null ? callbacks : [path, ...callbacks];
    (this.instance[verb] as (...a: (string | RouterHandler)[]) => unknown)(
      ...args,
    );
    return this;
  }

  override use(...callbacks: RouterHandler[]): this;
  override use(path: string, ...callbacks: RouterHandler[]): this;
  override use(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("use", p, c);
  }

  override get(path: string, ...callbacks: RouterHandler[]): this;
  override get(...callbacks: RouterHandler[]): this;
  override get(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("get", p, c);
  }

  override post(path: string, ...callbacks: RouterHandler[]): this;
  override post(...callbacks: RouterHandler[]): this;
  override post(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("post", p, c);
  }

  override head(path: string, ...callbacks: RouterHandler[]): this;
  override head(...callbacks: RouterHandler[]): this;
  override head(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("head", p, c);
  }

  override delete(path: string, ...callbacks: RouterHandler[]): this;
  override delete(...callbacks: RouterHandler[]): this;
  override delete(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("delete", p, c);
  }

  override put(path: string, ...callbacks: RouterHandler[]): this;
  override put(...callbacks: RouterHandler[]): this;
  override put(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("put", p, c);
  }

  override patch(path: string, ...callbacks: RouterHandler[]): this;
  override patch(...callbacks: RouterHandler[]): this;
  override patch(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("patch", p, c);
  }

  override propfind(path: string, ...callbacks: RouterHandler[]): this;
  override propfind(...callbacks: RouterHandler[]): this;
  override propfind(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("propfind", p, c);
  }

  override proppatch(path: string, ...callbacks: RouterHandler[]): this;
  override proppatch(...callbacks: RouterHandler[]): this;
  override proppatch(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("proppatch", p, c);
  }

  override mkcol(path: string, ...callbacks: RouterHandler[]): this;
  override mkcol(...callbacks: RouterHandler[]): this;
  override mkcol(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("mkcol", p, c);
  }

  override copy(path: string, ...callbacks: RouterHandler[]): this;
  override copy(...callbacks: RouterHandler[]): this;
  override copy(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("copy", p, c);
  }

  override move(path: string, ...callbacks: RouterHandler[]): this;
  override move(...callbacks: RouterHandler[]): this;
  override move(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("move", p, c);
  }

  override lock(path: string, ...callbacks: RouterHandler[]): this;
  override lock(...callbacks: RouterHandler[]): this;
  override lock(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("lock", p, c);
  }

  override unlock(path: string, ...callbacks: RouterHandler[]): this;
  override unlock(...callbacks: RouterHandler[]): this;
  override unlock(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("unlock", p, c);
  }

  override all(path: string, ...callbacks: RouterHandler[]): this;
  override all(...callbacks: RouterHandler[]): this;
  override all(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("all", p, c);
  }

  override search(path: string, ...callbacks: RouterHandler[]): this;
  override search(...callbacks: RouterHandler[]): this;
  override search(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("search", p, c);
  }

  override options(path: string, ...callbacks: RouterHandler[]): this;
  override options(...callbacks: RouterHandler[]): this;
  override options(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("options", p, c);
  }

  public setViewEngine(engine: string) {
    if (engine) return this;
    return this;
  }

  public getRequestMethodStr(requestMethod: RequestMethod): string {
    let method = "";
    switch (requestMethod) {
      case RequestMethod.GET: {
        method = "get";
        break;
      }

      case RequestMethod.POST: {
        method = "post";
        break;
      }

      case RequestMethod.PUT: {
        method = "put";
        break;
      }

      case RequestMethod.DELETE: {
        method = "delete";
        break;
      }

      case RequestMethod.PATCH: {
        method = "patch";
        break;
      }

      case RequestMethod.ALL: {
        method = "all";
        break;
      }

      case RequestMethod.OPTIONS: {
        method = "options";
        break;
      }

      case RequestMethod.HEAD: {
        method = "head";
        break;
      }

      case RequestMethod.SEARCH: {
        method = "search";
        break;
      }

      case RequestMethod.PROPFIND: {
        method = "propfind";
        break;
      }

      case RequestMethod.PROPPATCH: {
        method = "proppatch";
        break;
      }

      case RequestMethod.MKCOL: {
        method = "mkcol";
        break;
      }

      case RequestMethod.COPY: {
        method = "copy";
        break;
      }

      case RequestMethod.MOVE: {
        method = "move";
        break;
      }

      case RequestMethod.LOCK: {
        method = "lock";
        break;
      }

      case RequestMethod.UNLOCK: {
        method = "unlock";
        break;
      }
    }

    if (method) {
      return method;
    }

    if (String(requestMethod) === "-1") {
      return "all";
    }

    throw new InternalServerErrorException(
      `An invalid request method was encountered with value ${requestMethod}`,
    );
  }

  public createMiddlewareFactory(
    requestMethod: RequestMethod,
  ): MiddlewareFactoryRespType {
    return ((path, callback) => {
      // NestJS middleware must behave like middleware — not a route handler.
      // `useMethod` registers it method-scoped but with `isEndpoint` false,
      // so it keeps registration order and is excluded from route
      // specificity ordering. `RequestMethod.ALL` maps to method-agnostic.
      const method = this.getRequestMethodStr(requestMethod);
      this.instance.useMethod(
        method,
        path,
        callback as unknown as RouterHandler,
      );
      return this;
    }) as MiddlewareFactoryRespType;
  }

  public applyVersionFilter(
    handler: ApplyVersionFilterParameters[0],
    version: ApplyVersionFilterParameters[1],
    versioningOptions: ApplyVersionFilterParameters[2],
  ): VersionedRoute {
    const callNextHandler: VersionedRoute = (_, __, next) => {
      if (!next) {
        throw new InternalServerErrorException(
          "HTTP adapter does not support filtering on version",
        );
      }

      return next() as unknown as Function;
    };

    const versionNeutralStr = VERSION_NEUTRAL as unknown as string;

    if (
      version === versionNeutralStr ||
      // URL Versioning is done via the path, so the filter continues forward
      versioningOptions.type === VersioningType.URI
    ) {
      const handlerForNoVersioning: VersionedRoute = (req, res, next) =>
        handler(req, res, next);
      return handlerForNoVersioning;
    }

    // Custom Extractor Versioning Handler
    if (versioningOptions.type === VersioningType.CUSTOM) {
      const handlerForCustomVersioning: VersionedRoute = (req, res, next) => {
        const extractedVersion = versioningOptions.extractor(req);

        if (Array.isArray(version)) {
          if (
            Array.isArray(extractedVersion) &&
            version.filter((v) => extractedVersion.includes(v as string)).length
          ) {
            return handler(req, res, next);
          }

          if (
            isString(extractedVersion) &&
            version.includes(extractedVersion)
          ) {
            return handler(req, res, next);
          }
        } else if (isString(version)) {
          // Known bug here - if there are multiple versions supported across separate
          // handlers/controllers, we can't select the highest matching handler.
          // Since this code is evaluated per-handler, then we can't see if the highest
          // specified version exists in a different handler.
          if (
            Array.isArray(extractedVersion) &&
            extractedVersion.includes(version)
          ) {
            return handler(req, res, next);
          }

          if (isString(extractedVersion) && version === extractedVersion) {
            return handler(req, res, next);
          }
        }

        return callNextHandler(req, res, next);
      };

      return handlerForCustomVersioning;
    }

    // Media Type (Accept Header) Versioning Handler
    if (versioningOptions.type === VersioningType.MEDIA_TYPE) {
      const handlerForMediaTypeVersioning: VersionedRoute = (
        req,
        res,
        next,
      ) => {
        const MEDIA_TYPE_HEADER = "Accept";
        const acceptHeaderValue: string | undefined =
          req.getHeader(MEDIA_TYPE_HEADER) ||
          req.getHeader(MEDIA_TYPE_HEADER.toLowerCase()) ||
          undefined;

        const acceptHeaderVersionParameter = acceptHeaderValue
          ? acceptHeaderValue.split(";")[1]
          : undefined;

        // No version was supplied
        if (isUndefined(acceptHeaderVersionParameter)) {
          if (Array.isArray(version)) {
            if (version.includes(versionNeutralStr)) {
              return handler(req, res, next);
            }
          }
        } else {
          const headerVersion = acceptHeaderVersionParameter.split(
            versioningOptions.key,
          )[1];

          if (headerVersion) {
            if (Array.isArray(version)) {
              if (version.includes(headerVersion)) {
                return handler(req, res, next);
              }
            } else if (isString(version)) {
              if (version === headerVersion) {
                return handler(req, res, next);
              }
            }
          }
        }

        return callNextHandler(req, res, next);
      };

      return handlerForMediaTypeVersioning;
    }

    // Header Versioning Handler
    if (versioningOptions.type === VersioningType.HEADER) {
      const handlerForHeaderVersioning: VersionedRoute = (req, res, next) => {
        const customHeaderVersionParameter: string | undefined =
          req.getHeader(versioningOptions.header) ||
          req.getHeader(versioningOptions.header.toLowerCase()) ||
          undefined;

        // No version was supplied
        if (isUndefined(customHeaderVersionParameter)) {
          if (Array.isArray(version)) {
            if (version.includes(versionNeutralStr)) {
              return handler(req, res, next);
            }
          }
        } else {
          if (Array.isArray(version)) {
            if (version.includes(customHeaderVersionParameter)) {
              return handler(req, res, next);
            }
          } else if (isString(version)) {
            if (version === customHeaderVersionParameter) {
              return handler(req, res, next);
            }
          }
        }

        return callNextHandler(req, res, next);
      };

      return handlerForHeaderVersioning;
    }

    throw new Error("Unsupported versioning options");
  }
}

export class BunNestHttpAdapter<
  customWebsocketDataType = unknown,
> extends BunHttpAdapter<customWebsocketDataType> {}
