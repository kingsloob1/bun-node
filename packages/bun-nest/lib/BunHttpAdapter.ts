/* eslint-disable ts/no-unsafe-function-type */

import type {
  BodyParserOptions,
  BodyParserType,
  BunRequestOptions,
  BunRouterOptions,
  BunServeNormalOptions,
  BunServeOptions,
  BunWebSocketCreateServerOptions,
  BunWebSocketHandlerType,
  BunWebSocketNormalOptions,
  BunWebSocketServerType,
  EmptyShape,
  FetchInput,
  matchedRoute,
  MountedHandler,
  NextFunction,
  ResolvedBunRequestOptions,
  RouterErrorMiddlewareHandler,
  RouterHandler,
  RouterMiddlewareHandler,
  ServeStaticOptions,
  UnmountedRouter,
  ValidatorMiddleware,
} from "@kingsleyweb/bun-common";
import type { NestApplicationOptions } from "@nestjs/common";
// `@nestjs/*` has no `exports` map, so a deep path is resolved as a file: it
// needs its extension for a `node16` consumer, who reads this specifier
// verbatim in the shipped declaration.
import type {
  CorsOptions,
  CorsOptionsDelegate,
} from "@nestjs/common/interfaces/external/cors-options.interface.js";
import type { AddressInfo } from "node:net";
import type {
  BunWebSocketAdapterOptions,
  WebSocketClientData,
} from "./BunWebSocketAdapter";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { isPromise } from "node:util/types";
import {
  BunRequest,
  BunResponse,
  BunRouter,
  cors,
  createServeStaticHandler,
  each,
  FETCH_STUB_SERVER,
  finalErrorResponse,
  get,
  isFunction,
  isNull,
  isObject,
  isString,
  isUndefined,
  mergeBunRequestOptions,
  omit,
  set,
  toNativeRequest,
  waitUntil,
} from "@kingsleyweb/bun-common";
import {
  InternalServerErrorException,
  Logger,
  RequestMethod,
  StreamableFile,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import { AbstractHttpAdapter } from "@nestjs/core/adapters/http-adapter.js";
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

/**
 * `listen()`'s callback: called with the listening server once it is bound
 * (NestJS passes a no-argument callback, which fits too).
 */
export type ListenCallback<customWebsocketDataType = unknown> = (
  server: BunWebSocketServerType<customWebsocketDataType>,
) => void;

/**
 * What {@link BunHttpAdapter.createMiddlewareFactory} returns: registers
 * `callback` as method-scoped middleware at `path` and returns the adapter.
 * `callback` stays `Function` because that is what NestJS hands it (and what
 * `AbstractHttpAdapter` declares); it is called as `(req, res, next)`.
 * `TAdapter` is the adapter returned; the factory gives it as `this`.
 */
export type MiddlewareFactoryRespType<
  TAdapter extends AbstractHttpAdapter = AbstractHttpAdapter,
> = (path: string, callback: Function) => TAdapter;

/**
 * The `options` of {@link BunHttpAdapter.render}: what a `@Render()` handler
 * returned — view locals, opaque to the adapter — plus an optional `status`.
 */
export interface RenderOptions {
  /** HTTP status to send; `200` when absent or not a positive integer. */
  status?: number;
  /** View locals: whatever else the handler returned. */
  [local: string]: unknown;
}

type ApplyVersionFilterParameters = Parameters<
  AbstractHttpAdapter["applyVersionFilter"]
>;

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

  /** The merged request options; see {@link requestOpts}. */
  #requestOpts!: ResolvedBunRequestOptions;

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
  /**
   * Body parsers already registered, keyed by path prefix and parser kind
   * (`"*"` for the untyped `registerParserMiddleware`), so each kind is added
   * once while different kinds (`json` beside `text`, …) stack.
   */
  #registeredBodyParsers = new Set<string>();
  /** When true, every response computes an `ETag`. Opt-in (off by default). */
  protected etagEnabled = false;
  /**
   * Emits the server's `listening`, `error` and `close` events, which the
   * Nest-facing server proxy forwards. Annotated rather than inferred: the
   * inferred `EventEmitter<[never]>` is written into the shipped declaration
   * and fails `TS2344` against the `@types/node` a consumer resolves.
   */
  public readonly eventEmitter: EventEmitter = new EventEmitter();

  constructor(
    /**
     * Per-request timeout in milliseconds applied when finalising a response
     * (passed to {@link BunResponse.getNativeResponse}). `0` means no timeout.
     */
    protected requestTimeout = 0,
    options?: {
      /**
       * Request-parsing options forwarded to every {@link BunRequest}
       * (body/cookie/query parsing, size caps, `cookieSecret`, etc.), merged
       * over `{ parseBody: true, parseCookies: true }` with
       * `mergeBunRequestOptions` — so `{ cookieSecret }` alone keeps body
       * parsing on. Set a default explicitly to turn it off
       * (`{ parseBody: false }`).
       */
      request?: Partial<BunRequestOptions>;
      /**
       * Overrides for the built-in NestJS WebSocket adapter, merged field by
       * field over the defaults that bind it to this HTTP adapter:
       * `{ httpAdapter: this, newInstance: false, router: httpAdapter.instance,
       * getServer: () => httpAdapter.getBunServer() }`. Every field given wins —
       * `httpAdapter` (router and server from another HTTP adapter),
       * `getServer` (the server to ride on), `router`, `wsOptions`,
       * `onUpgrade` (or the deprecated `customDataToWsClientFn`), and
       * `newInstance: true` with `listen` (a
       * dedicated server bound at construction; `listen.port` is required).
       * `{ httpAdapter, localOptions }` is accepted too. A custom adapter can
       * also be supplied later via `app.useWebSocketAdapter()`.
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

    // Merged over the defaults, not in place of them.
    this.requestOpts = options?.request ?? {};

    this.etagEnabled = options?.etag ?? false;
    this.logger = logger;
    this.serverOptions = options?.server || {};

    this.webSocketAdapter = new BunNestWebsocketAdapter<
      customWebsocketDataType,
      routesType
    >(this.resolveWebSocketOptions(options?.websocket));

    this.defineHttpServer();
  }

  /**
   * Merges the constructor's `websocket` option over the defaults that bind
   * the built-in WebSocket adapter to this HTTP adapter. Every field given
   * wins; see that option's description.
   */
  private resolveWebSocketOptions(
    websocket:
      | Partial<WebsocketOptions<customWebsocketDataType, routesType>>
      | undefined,
  ): BunWebSocketAdapterOptions<customWebsocketDataType, routesType> {
    const given = websocket ?? {};
    const httpAdapter = given.httpAdapter ?? this;
    // Either shape's fields, all optional: `getServer` from the riding shape,
    // `listen` and friends from the dedicated-server shape.
    const local = (("localOptions" in given
      ? given.localOptions
      : omit(given, ["httpAdapter"])) ?? {}) as Partial<
      Omit<BunWebSocketNormalOptions<customWebsocketDataType>, "newInstance">
    > &
      Partial<
        Omit<
          BunWebSocketCreateServerOptions<customWebsocketDataType, routesType>,
          "newInstance"
        >
      > & {
        /** Whether to bind a dedicated server (`true`) or ride one (`false`). */
        newInstance?: boolean;
      };

    if (local.newInstance === true) {
      // `listen` is required for a dedicated server; a missing port is
      // reported by BunWebSocket rather than replaced by a hidden default.
      return {
        ...local,
        newInstance: true,
        listen: local.listen ?? { port: Number.NaN },
        router: local.router ?? httpAdapter.instance,
        httpAdapter,
      };
    }

    return {
      httpAdapter,
      localOptions: {
        ...local,
        newInstance: false,
        router: local.router ?? httpAdapter.instance,
        getServer: local.getServer ?? (() => httpAdapter.getBunServer()),
      },
    };
  }

  /**
   * Turns one native `Request` into its `Response`, running the whole
   * adapter pipeline: request construction, the payload guard, the router,
   * not-found handlers, WebSocket upgrade and response finalisation.
   *
   * `Bun.serve`'s `fetch` is a thin wrapper over this, and so is
   * {@link fetch} — a socket-free call therefore exercises exactly the same
   * code as a real request rather than a parallel approximation.
   */
  protected async handleNativeRequest(
    nativeRequest: Request,
    server: BunWebSocketServerType<customWebsocketDataType>,
  ): Promise<Response | undefined> {
    // `BunRequest.init` returns the instance synchronously when no body
    // or cookie parsing was scheduled. Branching (rather than awaiting
    // unconditionally) is what banks the saving — `await` on a plain
    // value still costs a microtask tick.
    const created = BunRequest.init(nativeRequest, server, this.requestOpts);
    const req = created instanceof BunRequest ? created : await created;

    // DDoS guard: a body that exceeded `parseBody.maxContentLength` is
    // rejected with 413 before any route handler or middleware runs.
    if (req.isPayloadTooLarge) {
      return BunRequest.payloadTooLargeResponse(req);
    }

    // A body refused for its `Content-Encoding` while the request was built
    // (`parseBody.inflate: false`, an unsupported coding, a corrupt stream)
    // goes to the error handling with the request, as body-parser's
    // `next(err)` does — answered with its 415/400 rather than routed with no
    // body.
    const decodingError = req.bodyDecodingError;
    if (decodingError) {
      set(decodingError, "req", req);
      throw decodingError;
    }

    const res = new BunResponse<customWebsocketDataType>(req, {
      etag: this.etagEnabled,
    });
    let routeUsed: matchedRoute | true | undefined;

    const pipeline = this.instance.handle({
      requestHost: req.host,
      requestMethod: req.method,
      response: res,
      request: req,
      requestUrl: req.originalUrl,
    });

    // A handler that opens a long-lived stream and awaits its end — NestJS's
    // `@Sse()` resolves only once the observable completes or the client
    // leaves — would otherwise hold the headers back until then. On Node they
    // go out as soon as `writeHead`/`flushHeaders` runs, so the stream's
    // response is returned the moment it exists, the pipeline still running.
    if (Bun.peek.status(pipeline) === "pending") {
      const streamed = await Promise.race([
        pipeline.then(
          () => undefined,
          () => undefined,
        ),
        res
          .getNativeResponse(0)
          .then((response) => (res.isLongLived ? response : undefined)),
      ]);
      if (streamed) {
        pipeline.catch((error: unknown) => {
          // Headers are gone, so nothing but the stream's end can answer it,
          // as Express's finalhandler does once headers were sent.
          this.logger.error(
            "Error after a streaming response started",
            error instanceof Error ? error.stack : String(error),
          );
          // `end()` on a response that has already ended does nothing.
          void res.end();
        });
        return streamed;
      }
    }

    try {
      routeUsed = await pipeline;
    } catch (e) {
      const err: object = isObject(e) ? e : new Error(String(e));

      set(err, "req", req);
      throw err;
    }

    let hasNativeResponse = false;
    if (routeUsed) {
      hasNativeResponse = true;
    } else if (this._notFoundHandlers.length) {
      let continueProcessingHandlers = true;
      const next: NextFunction = (err) => {
        if (!(isUndefined(err) || isNull(err))) {
          continueProcessingHandlers = false;
        }
      };

      for await (const handler of this._notFoundHandlers) {
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
        const upgradeData = res.upgradeToWsData;
        const success = server.upgrade(nativeRequest, {
          // The accepting server's port, unless the handler recorded one, so
          // a gateway can tell which server a client arrived on.
          data: { ...upgradeData, port: upgradeData.port ?? server.port },
          // Only headers the upgrade was explicitly given; the key is left out
          // otherwise so the 101 is exactly Bun's default.
          ...(res.upgradeToWsHeaders
            ? { headers: res.upgradeToWsHeaders }
            : {}),
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
        (await res.getNativeResponse(this.requestTimeout))
      );
    }

    return new Response(undefined, {
      status: 404,
      statusText: "Not Found",
    });
  }

  /**
   * Runs a request through the adapter without binding a socket, resolving
   * the `Response` the server would have sent.
   *
   * Delegates to {@link handleNativeRequest}, the same method
   * `Bun.serve`'s `fetch` calls, and routes a thrown error through
   * {@link handleRequestError}, the same method `Bun.serve`'s `error` callback
   * calls — so not-found handlers, error handlers, the payload guard and
   * response finalisation all apply exactly as they do in production.
   *
   * It never rejects for an error in the pipeline. With no error handler (no
   * Nest application registered one, or none was set), or none that can run,
   * it resolves the `finalhandler`-style response a served request gets (see
   * {@link handleRequestError}), such as `415` for a refused
   * `Content-Encoding` or `500` for a plain throw.
   *
   * @example
   * ```ts
   * const res = await adapter.fetch("/users/42");
   * expect(res.status).toBe(200);
   * ```
   */
  public async fetch(input: FetchInput, init?: RequestInit): Promise<Response> {
    const nativeRequest = toNativeRequest(
      input,
      init,
      this.isListening ? this.url : undefined,
    );

    let response: Response | undefined;
    try {
      response = await this.handleNativeRequest(
        nativeRequest,
        // A live server when one exists, so `requestIP`/`upgrade` behave; a
        // stub otherwise, which reports no peer and refuses upgrades.
        // The stub is not a real server (only `requestIP`/`upgrade` exist),
        // which is exactly what this method touches.
        this.getBunServer() ??
          (FETCH_STUB_SERVER as BunWebSocketServerType<customWebsocketDataType>),
      );
    } catch (error) {
      // The same final error handling `Bun.serve`'s `error` callback runs.
      return this.handleRequestError(error);
    }

    return (
      response ??
      new Response(null, { status: 101, statusText: "Switching Protocols" })
    );
  }

  /**
   * The request-parsing options applied to every {@link BunRequest}: what was
   * last assigned, merged over `{ parseBody: true, parseCookies: true }`.
   */
  get requestOpts(): ResolvedBunRequestOptions {
    return this.#requestOpts;
  }

  /**
   * Replaces the request options, merged over the defaults
   * (`{ parseBody: true, parseCookies: true }`) — not over the options set
   * before, so an option left out returns to its default.
   */
  set requestOpts(opts: Partial<BunRequestOptions>) {
    this.#requestOpts = mergeBunRequestOptions(opts);
  }

  /**
   * Replaces the request options for the next request on, merged over the
   * defaults as the {@link requestOpts} setter. Returns the adapter.
   */
  setRequestOpts(opts: Partial<BunRequestOptions>) {
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

  /**
   * Router-wide headers for the `101` of every WebSocket upgrade on the app's
   * router ({@link instance}) — gateway upgrades and a bare
   * `res.upgradeToWebsocket()` alike. The lowest header layer:
   * `res.webSocketUpgradeHeaders`, then an `onUpgrade` hook's headers or
   * `upgradeToWebsocket`'s `options.headers`, replace them per header name.
   * Delegates to `instance.webSocketUpgradeHeaders`; see
   * `BunRouter.webSocketUpgradeHeaders`. `undefined` by default.
   */
  get webSocketUpgradeHeaders(): Headers | undefined {
    return this.instance.webSocketUpgradeHeaders;
  }

  set webSocketUpgradeHeaders(headers: Bun.HeadersInit | undefined) {
    this.instance.webSocketUpgradeHeaders = headers;
  }

  /** Sets {@link webSocketUpgradeHeaders} and returns the adapter, for chaining. */
  setWebSocketUpgradeHeaders(headers: Bun.HeadersInit | undefined): this {
    this.webSocketUpgradeHeaders = headers;
    return this;
  }

  /**
   * Router-wide base for `ws.data` on the app's router ({@link instance}),
   * merged shallowly over the data built from the upgrade request and under
   * `res.webSocketUpgradeData` and an `onUpgrade` hook's `custom`. Delegates
   * to `instance.webSocketUpgradeData`; see `BunRouter.webSocketUpgradeData`.
   * `undefined` by default.
   */
  get webSocketUpgradeData(): Partial<WebSocketClientData> | undefined {
    return this.instance.webSocketUpgradeData;
  }

  set webSocketUpgradeData(data: Partial<WebSocketClientData> | undefined) {
    this.instance.webSocketUpgradeData = data;
  }

  /** Sets {@link webSocketUpgradeData} and returns the adapter, for chaining. */
  setWebSocketUpgradeData(
    data: Partial<WebSocketClientData> | undefined,
  ): this {
    this.webSocketUpgradeData = data;
    return this;
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

  public setTimeout(
    reqTimeout: number,
    /** Called once the adapter has a listening server, with that server. */
    callback: (server: BunWebSocketServerType<customWebsocketDataType>) => void,
  ): Promise<void> {
    this.requestTimeout = reqTimeout;
    return waitUntil(
      () => this.getBunServer(),
      (server): server is BunWebSocketServerType<customWebsocketDataType> =>
        !!server,
    ).then(callback);
  }

  public getHeader(response: BunResponse, name: string) {
    return response.getHeader(name);
  }

  public appendHeader(response: BunResponse, name: string, value: string) {
    response.appendHeader(name, value);
    return this;
  }

  /**
   * Registers one body-parsing middleware, unless one for the same `prefix`
   * and `parser` kind is already registered.
   */
  private registerBodyParser(
    /** Path prefix the parser runs under; every path when omitted. */
    prefix: string | undefined,
    /** Store the raw bytes on `req.rawBody` when this parser parsed a body. */
    rawBody: boolean | undefined,
    /** body-parser options: `type`, `limit`, `inflate`, … */
    options: BodyParserOptions | undefined,
    /** The parser kind, whose default media type applies without `type`; every type when omitted. */
    parser?: BodyParserType,
  ) {
    const key = `${prefix ?? ""}\0${parser ?? "*"}`;
    if (this.#registeredBodyParsers.has(key)) {
      return this;
    }

    const middlewareHandler: RouterMiddlewareHandler = async (req, _, next) => {
      const buffer = await req.handleBodyParsing(true, options, parser);
      // As body-parser's `verify` hook in Nest's ExpressAdapter: `rawBody` is
      // set only by a parser that read the body. A request this parser skipped
      // (another type, or no body) keeps what an earlier parser set.
      if (rawBody && buffer !== undefined) {
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

    this.#registeredBodyParsers.add(key);
    return this;
  }

  /**
   * Registers a parser for one kind of body — what `app.useBodyParser(type,
   * options)` calls, with the application's `rawBody` option.
   *
   * - `options.type` picks the requests it parses; without it, the kind's
   *   body-parser default (`json` → `application/json`, `urlencoded` →
   *   `application/x-www-form-urlencoded`, `text` → `text/plain`, `raw` →
   *   `application/octet-stream`). Any other request is left to other parsers.
   * - `options.limit` over the body rejects with a 413 `PayloadTooLargeError`,
   *   which Nest's exception layer answers `413`; `options.inflate: false`
   *   refuses a compressed body with `415`.
   * - With `rawBody`, the bytes a parser read are kept on `req.rawBody`.
   *
   * Each kind is registered once — a second call for the same kind does
   * nothing — while different kinds stack.
   */
  public useBodyParser(
    type: BodyParserType,
    rawBody: boolean,
    options: BodyParserOptions,
  ) {
    return this.registerBodyParser(undefined, rawBody, options, type);
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

  /**
   * Binds `Bun.serve` on `port` (at 127.0.0.1) and resolves the server, after
   * calling `callback` with it. NestJS's `app.listen()` uses this form.
   *
   * A bind failure (a busy port, say) rejects — unless an `error` listener is
   * attached to the HTTP server, as `app.listen()` attaches one. Then, as with
   * `@nestjs/platform-express` (whose `listen` hands off to `node:http`,
   * which reports the failure only through `error`), the listener receives
   * the error, the callback is not called, and this resolves `undefined`:
   * rejecting too would leave a rejection `app.listen()` never observes.
   */
  public async listen(
    port: string | number,
    callback?: ListenCallback<customWebsocketDataType>,
  ): Promise<BunWebSocketServerType<customWebsocketDataType> | undefined>;
  /** As above, bound at `hostname`. */
  public async listen(
    port: string | number,
    hostname: string,
    callback?: ListenCallback<customWebsocketDataType>,
  ): Promise<BunWebSocketServerType<customWebsocketDataType> | undefined>;
  public async listen(
    port: number | string,
    hostname?: string | ListenCallback<customWebsocketDataType>,
    callback?: ListenCallback<customWebsocketDataType>,
  ): Promise<BunWebSocketServerType<customWebsocketDataType> | undefined> {
    // The callback may arrive as the 2nd argument (`listen(port, cb)`, the form
    // NestJS's `app.listen()` uses) or the 3rd (`listen(port, host, cb)`).
    // Resolve it *before* normalising `hostname`, otherwise the 2nd-arg form
    // loses the callback and `app.listen()` never resolves.
    const done = isFunction(hostname)
      ? hostname
      : isFunction(callback)
        ? callback
        : () => undefined;

    // Anything `Bun.serve` accepts — an IP literal, `"localhost"`, a name —
    // is bound as given; only an absent hostname defaults to 127.0.0.1.
    const host = isString(hostname) && hostname ? hostname : "127.0.0.1";

    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
      throw new RangeError(
        `listen(): port must be an integer from 0 to 65535, got ${port}`,
      );
    }

    if (this._serverInstance && this.isServerListening) {
      // Port `0` asks for "any port", which the running server satisfies.
      const sameAddress =
        this._listeningHost === host &&
        (portNumber === 0 || Number(this._serverInstance.port) === portNumber);

      if (sameAddress) {
        await done(this._serverInstance);
        return this._serverInstance;
      }

      // A different address: move there.
      await this._serverInstance.stop(true);
      this._serverInstance = undefined;
      this.isServerListening = false;
    }

    let httpServer: BunWebSocketServerType<customWebsocketDataType>;
    try {
      httpServer = Bun.serve<
        WebSocketClientData<customWebsocketDataType>,
        routesType
      >({
        ...(this.serverOptions || {}),
        port: portNumber,
        hostname: host,
        development: Bun.env.NODE_ENV !== "production",
        fetch: (nativeRequest: Request, server) => {
          return this.handleNativeRequest(nativeRequest, server);
        },
        websocket: this.buildServerWebSocketHandler(),
        error: (err) => {
          return this.handleRequestError(err);
        },
      });
    } catch (error) {
      // A busy port (`EADDRINUSE`), a hostname that does not resolve, a port
      // needing privileges: reported, as `node:http` does, never bound
      // somewhere else. NestJS's `app.listen()` listens for the HTTP server's
      // `error` event and rejects with it; a direct caller gets the rejection.
      this.logger.error(
        `Error while binding to ${host}:${portNumber}`,
        error instanceof Error ? error.stack : String(error),
      );
      if (this.eventEmitter.listenerCount("error") > 0) {
        this.eventEmitter.emit("error", error);
        return undefined;
      }
      throw error;
    }

    this._serverInstance = httpServer;
    this._listeningHost = host;
    this._listeningPort = httpServer.port ?? portNumber;
    await this.getListenAddress();

    this.isServerListening = true;
    this.eventEmitter.emit("listening", this._serverInstance);

    await done(this._serverInstance);

    return this._serverInstance;
  }

  /**
   * The adapter's final error handling — the one implementation behind both
   * `Bun.serve`'s `error` callback and {@link fetch}, so a served request and
   * a socket-free one cannot be handled differently.
   *
   * Runs the {@link setErrorHandler} handlers as Express runs error
   * middleware: in registration order, as `(err, req, res, next)`, against a
   * fresh response. Only `next` moves on, and a return value is ignored:
   * `next(err)` hands `err` to the next handler (once none is left, it is
   * answered as below); `next()`, `next("route")` or `next("router")` leaves
   * error mode, and with nothing registered after these handlers that is
   * Express's `404`. A handler that neither responds nor calls `next` (which
   * it may still do from a callback) is given a second, then answered for the
   * timeout. In a Nest application the handler is Nest's own exception layer,
   * registered through `RoutesResolver.registerExceptionHandler`, so errors
   * raised before routing (a refused body, say) reach the exception filters
   * as they do on `@nestjs/platform-express`, where that handler is an Express
   * error middleware.
   *
   * With no handler registered, or when the error carries no request (it was
   * thrown before one was built, or by response finalisation such as a
   * timeout), it answers as Express's `finalhandler` does — what an Express
   * app with no error middleware sends; see {@link finalErrorResponse}. A
   * handler that throws is answered the same way, for the error it threw. It
   * therefore always resolves. Mirrors bun-common's `handleRequestError`.
   */
  protected async handleRequestError(error: unknown): Promise<Response> {
    const req = get(error, "req", undefined) as BunRequest | undefined;
    if (!req || !this._errorHandlers.length) {
      return this.finalErrorResponse(error, req);
    }

    let currentError: unknown = error;
    try {
      const response = new BunResponse(req, { etag: this.etagEnabled });
      for (const handler of this._errorHandlers) {
        const nextInvoked = Promise.withResolvers<undefined>();
        let nextCalled = false;
        let nextArg: Parameters<NextFunction>[0];
        const next: NextFunction = (arg) => {
          if (nextCalled) {
            return;
          }
          nextCalled = true;
          nextArg = arg;
          nextInvoked.resolve(undefined);
        };

        await handler(currentError, req, response, next);

        // A handler may still call `next` from a callback: wait for that or
        // for the response, whichever comes first.
        if (!nextCalled && !response.headersSent) {
          const settled = await Promise.race([
            nextInvoked.promise,
            response.getNativeResponse(1000),
          ]);
          if (settled) {
            return settled;
          }
        }

        if (response.headersSent || !nextCalled) {
          break;
        }

        if (
          isUndefined(nextArg) ||
          isNull(nextArg) ||
          nextArg === "route" ||
          nextArg === "router"
        ) {
          // Error mode is over and no middleware follows: finalhandler's 404.
          return this.finalErrorResponse(
            Object.assign(new Error(`Cannot ${req.method} ${req.path}`), {
              status: 404,
            }),
            req,
          );
        }

        currentError = nextArg;
      }

      if (!response.headersSent) {
        // Every handler passed the error on.
        return this.finalErrorResponse(currentError, req);
      }

      return await response.getNativeResponse(1000);
    } catch (handlerError) {
      return this.finalErrorResponse(handlerError, req);
    }
  }

  /**
   * The response for an error nothing handled: bun-common's standalone
   * `finalErrorResponse` (Express's `finalhandler`), for `req`'s method — so
   * this adapter and bun-common's answer byte for byte alike.
   *
   * The error is logged through Nest's {@link logger} at `error` level as
   * `(message, stack)`, the message naming the method, path and status,
   * except under `NODE_ENV=test`, as Express's default error logging does.
   */
  protected finalErrorResponse(error: unknown, req?: BunRequest): Response {
    return finalErrorResponse(error, {
      method: req?.method,
      path: req?.path,
      log:
        Bun.env.NODE_ENV === "test"
          ? undefined
          : (message, err, { status }) => {
              const where = req
                ? ` (${req.method} ${req.path}, ${status})`
                : "";
              this.logger.error(
                `${message}${where}`,
                err instanceof Error ? err.stack : String(err),
              );
            },
    });
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
     * streams, `FormData`/`URLSearchParams` and async iterables — plus a
     * NestJS `StreamableFile`, which is streamed with its headers.
     */
    body: Parameters<BunResponse["send"]>[0] | StreamableFile,
    /** Optional status code applied before sending. */
    statusCode?: number,
  ) {
    if (statusCode) {
      response = response.status(statusCode);
    }

    if (body instanceof StreamableFile) {
      // As @nestjs/platform-express: the file's type, disposition and length
      // fill in whichever of those headers the handler did not set itself.
      const { type, disposition, length } = body.getHeaders();
      if (!response.getHeader("Content-Type") && type !== undefined) {
        response.setHeader("Content-Type", type);
      }
      if (
        !response.getHeader("Content-Disposition") &&
        disposition !== undefined
      ) {
        response.setHeader("Content-Disposition", disposition);
      }
      if (!response.getHeader("Content-Length") && length !== undefined) {
        response.setHeader("Content-Length", String(length));
      }

      const stream = body.getStream();
      stream.once("error", (error: Error) => {
        body.errorLogger(error);
      });
      return response.send(stream);
    }

    return response.send(body);
  }

  public status(response: BunResponse, statusCode: number) {
    return response.status(statusCode);
  }

  public end(response: BunResponse, message?: string) {
    return response.headersSent ? undefined : response.send(message);
  }

  /**
   * Sends the file at `view` with its content type. `options` is what Nest
   * passes for `@Render()`: the handler's return value, which may be
   * anything — a positive `status` on it sets the status (default `200`).
   */
  public render(
    response: BunResponse,
    view: string,
    options?: RenderOptions | null,
  ) {
    const file = Bun.file(view);
    response.setHeader("Content-Type", file.type);
    const status = options?.status;
    return response
      .status(
        typeof status === "number" && Number.isInteger(status) && status > 0
          ? status
          : 200,
      )
      .send(file.stream());
  }

  /**
   * Redirects to `url`: sets `Location` and the status (`302` when
   * `statusCode` is `0`), then sends the response with an empty body. Like
   * Express's `res.redirect` (what `@Redirect()` calls on
   * `@nestjs/platform-express`), this finishes the response — nothing needs to
   * follow it — but it sends no "Redirecting to" body.
   */
  public redirect(response: BunResponse, statusCode: number, url: string) {
    response.setHeader("Location", url);
    return response.status(statusCode || 302).send(undefined);
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

          corsHandler = cors(corsOpts);
        } catch (e) {
          return res
            .status(400)
            .end(e instanceof Error ? e.message : String(e));
        }
      } else {
        corsHandler = cors(options);
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
    // Error and not-found handlers are configuration, like routes: they stay,
    // so a closed adapter that listens again (or is driven through `fetch()`)
    // behaves exactly as before.
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

    // Each lifecycle callback forwards its arguments, unchanged, to the
    // adapter active at call time. Spelled out per event: TypeScript cannot
    // correlate a handler's parameters with its name across a loop.
    const active = () => this.resolveWebSocketAdapter().wsHandler;
    handler.open = (ws) => active().open?.(ws);
    handler.message = (ws, message) => active().message?.(ws, message);
    handler.close = (ws, code, reason) => active().close?.(ws, code, reason);
    handler.drain = (ws) => active().drain?.(ws);
    handler.ping = (ws, data) => active().ping?.(ws, data);
    handler.pong = (ws, data) => active().pong?.(ws, data);

    return handler;
  }

  public defineHttpServer() {
    if (this.httpServer) {
      return this.httpServer;
    }

    // Bypass event handlers added to httpServer and call of address
    // Only a proxy target: every property read is answered by the handler.
    this.httpServer = new Proxy(
      {} as BunWebSocketServerType<customWebsocketDataType>,
      {
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
              // Not thenable. NestJS `await`s `initHttpServer()`, which resolves
              // this proxy; a `then` here would make that await wait for a
              // listening server — forever, for an app that is only `init()`ed
              // and driven through `fetch()` — and keep the process alive.
              return undefined;
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
      },
    );

    return this.httpServer;
  }

  /**
   * The {@link BunRouter} this adapter routes through — the same object as
   * {@link instance}. NestJS's `AbstractHttpAdapter` declares
   * `getInstance<T = any>()`, which left every call typed `any`: a
   * comparison or call on the result was never checked. Here the default is
   * the router; pass `T` to assert another type, as before.
   */
  public override getInstance<T = BunRouter>(): T {
    return this.instance as T;
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
    (this.instance[verb] as (...a: (string | RouterHandler)[]) => void)(
      ...args,
    );
    return this;
  }

  // `use` mirrors bun-common's `BunRouter.use`: middleware and mounted
  // sub-routers, with an optional leading path. The two mount-typed overloads
  // are hand-written there too (`use` is excluded from the verb-overload
  // generator, because it mounts on a path *prefix*); keep them in step.

  /**
   * Mounts a bun-common sub-router at `path`, requiring the sub-router to have
   * been declared with the same mount path.
   *
   * `new BunRouter<"/users/:id">()` lets the sub-router's routes see
   * `params.id`; this signature keeps that declaration honest — a sub-router
   * declaring a different path, or a validated `query`/`body` that no
   * validator here produces, is a compile error. Same contract as
   * bun-common's `BunRouter.use`.
   */
  override use<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    // `NoInfer`: without it `TPath` also infers from the router and widens to
    // the union of both paths, which a mismatched mount then satisfies.
    // `TShape` is inferred from the router and must be empty — a router
    // declaring a validated shape needs the validator overload below.
    router: BunRouter<NoInfer<TPath>, TShape> &
      (keyof TShape extends never ? unknown : never),
  ): this;

  /**
   * Mounts a bun-common sub-router at `path` behind a `validate()` middleware.
   * The validated `query` and `body` reach the sub-router's handlers, so its
   * declared mount shape must match them; validated `params` are not part of
   * the contract (the pipeline rebinds `req.params` on entering each route).
   */
  override use<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    router: BunRouter<NoInfer<TPath>, NoInfer<Omit<TShape, "params">>>,
  ): this;

  /**
   * Registers router middleware on every path, and/or mounts sub-routers at
   * the root — any `BunRouter` (or `@routejs/router` `Router`) that declared
   * no mount context. Runs below Nest's pipeline: guards, interceptors and
   * `setGlobalPrefix` do not apply.
   */
  override use(...callbacks: (RouterHandler | UnmountedRouter)[]): this;

  /**
   * Registers router middleware under the path prefix `path` (Express
   * `use()` prefix matching), and/or mounts sub-routers there — e.g.
   * `adapter.use(ui.basePath, ui.router)`. A router that declared a mount
   * path goes through the mount-typed overloads above instead.
   */
  override use(
    path: string,
    ...callbacks: (RouterHandler | UnmountedRouter)[]
  ): this;

  override use(
    p?: string | RouterHandler | UnmountedRouter,
    ...c: (RouterHandler | UnmountedRouter)[]
  ): this {
    const args = p === undefined ? c : [p, ...c];
    // `BunRouter.use`'s implementation signature is not callable from outside;
    // its widest public overloads take exactly these arguments.
    (
      this.instance.use as (
        ...a: (string | RouterHandler | UnmountedRouter)[]
      ) => BunRouter
    ).apply(this.instance, args);
    return this;
  }

  /* --- BEGIN generated typed overloads: get --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override get<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: get --- */
  override get(path: string, ...callbacks: RouterHandler[]): this;
  override get(...callbacks: RouterHandler[]): this;
  override get(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("get", p, c);
  }

  /* --- BEGIN generated typed overloads: post --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override post<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: post --- */
  override post(path: string, ...callbacks: RouterHandler[]): this;
  override post(...callbacks: RouterHandler[]): this;
  override post(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("post", p, c);
  }

  /* --- BEGIN generated typed overloads: head --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override head<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: head --- */
  override head(path: string, ...callbacks: RouterHandler[]): this;
  override head(...callbacks: RouterHandler[]): this;
  override head(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("head", p, c);
  }

  /* --- BEGIN generated typed overloads: delete --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override delete<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: delete --- */
  override delete(path: string, ...callbacks: RouterHandler[]): this;
  override delete(...callbacks: RouterHandler[]): this;
  override delete(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("delete", p, c);
  }

  /* --- BEGIN generated typed overloads: put --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override put<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: put --- */
  override put(path: string, ...callbacks: RouterHandler[]): this;
  override put(...callbacks: RouterHandler[]): this;
  override put(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("put", p, c);
  }

  /* --- BEGIN generated typed overloads: patch --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override patch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: patch --- */
  override patch(path: string, ...callbacks: RouterHandler[]): this;
  override patch(...callbacks: RouterHandler[]): this;
  override patch(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("patch", p, c);
  }

  /* --- BEGIN generated typed overloads: propfind --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override propfind<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: propfind --- */
  override propfind(path: string, ...callbacks: RouterHandler[]): this;
  override propfind(...callbacks: RouterHandler[]): this;
  override propfind(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("propfind", p, c);
  }

  /* --- BEGIN generated typed overloads: proppatch --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override proppatch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override proppatch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override proppatch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override proppatch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override proppatch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override proppatch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override proppatch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override proppatch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override proppatch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override proppatch<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: proppatch --- */
  override proppatch(path: string, ...callbacks: RouterHandler[]): this;
  override proppatch(...callbacks: RouterHandler[]): this;
  override proppatch(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("proppatch", p, c);
  }

  /* --- BEGIN generated typed overloads: mkcol --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override mkcol<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: mkcol --- */
  override mkcol(path: string, ...callbacks: RouterHandler[]): this;
  override mkcol(...callbacks: RouterHandler[]): this;
  override mkcol(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("mkcol", p, c);
  }

  /* --- BEGIN generated typed overloads: copy --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override copy<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: copy --- */
  override copy(path: string, ...callbacks: RouterHandler[]): this;
  override copy(...callbacks: RouterHandler[]): this;
  override copy(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("copy", p, c);
  }

  /* --- BEGIN generated typed overloads: move --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override move<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: move --- */
  override move(path: string, ...callbacks: RouterHandler[]): this;
  override move(...callbacks: RouterHandler[]): this;
  override move(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("move", p, c);
  }

  /* --- BEGIN generated typed overloads: lock --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override lock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: lock --- */
  override lock(path: string, ...callbacks: RouterHandler[]): this;
  override lock(...callbacks: RouterHandler[]): this;
  override lock(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("lock", p, c);
  }

  /* --- BEGIN generated typed overloads: unlock --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override unlock<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: unlock --- */
  override unlock(path: string, ...callbacks: RouterHandler[]): this;
  override unlock(...callbacks: RouterHandler[]): this;
  override unlock(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("unlock", p, c);
  }

  /* --- BEGIN generated typed overloads: all --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override all<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: all --- */
  override all(path: string, ...callbacks: RouterHandler[]): this;
  override all(...callbacks: RouterHandler[]): this;
  override all(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("all", p, c);
  }

  /* --- BEGIN generated typed overloads: search --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override search<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: search --- */
  override search(path: string, ...callbacks: RouterHandler[]): this;
  override search(...callbacks: RouterHandler[]): this;
  override search(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("search", p, c);
  }

  /* --- BEGIN generated typed overloads: options --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  override options<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    handler6: RouterHandler,
    handler7: RouterHandler,
    handler8: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  /* --- END generated typed overloads: options --- */
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
  ): MiddlewareFactoryRespType<this> {
    return (path, callback) => {
      // NestJS middleware must behave like middleware — not a route handler.
      // `useMethod` registers it method-scoped but with `isEndpoint` false,
      // so it keeps registration order and is excluded from route
      // specificity ordering. `RequestMethod.ALL` maps to method-agnostic.
      const method = this.getRequestMethodStr(requestMethod);
      this.instance.useMethod(
        method,
        path,
        // NestJS's `Function` is its `(req, res, next)` middleware.
        callback as RouterHandler,
      );
      return this;
    };
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

      // `AbstractHttpAdapter` declares the route returns `Function`; what it
      // really returns is `next()`'s result, which NestJS ignores.
      return next() as unknown as Function;
    };

    if (
      version === VERSION_NEUTRAL ||
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
            if (version.includes(VERSION_NEUTRAL)) {
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
            if (version.includes(VERSION_NEUTRAL)) {
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
  routesType extends string = never,
> extends BunHttpAdapter<customWebsocketDataType, routesType> {}
