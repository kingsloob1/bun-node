import type { WebSocketHandler } from "bun";
import type { Server as NodeServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FetchInput } from "./BunRouter";
import type {
  CorsOptions as BunCorsOptions,
  CorsOptionsDelegate,
} from "./cors";
import type {
  BodyParserOptions,
  BodyParserType,
  BunServeNormalOptions,
  BunServer,
  BunWebSocketServerType,
  matchedRoute,
  NextFunction,
  RouterErrorMiddlewareHandler,
  RouterHandler,
  RouterMiddlewareHandler,
  ServeStaticOptions,
  WebSocketClientData,
} from "./index";
import type { LoggerLike } from "./logging";
import { EventEmitter } from "node:events";
import { STATUS_CODES } from "node:http";
import { isPromise } from "node:util/types";
import { BunRouter, FETCH_STUB_SERVER, toNativeRequest } from "./BunRouter";
import { cors } from "./cors";
import {
  BunRequest,
  BunResponse,
  BunWebSocket,
  mergeBunRequestOptions,
} from "./index";
import { resolveLogger } from "./logging";
import { createServeStaticHandler } from "./serveStatic";
import {
  each,
  get,
  isFunction,
  isNull,
  isObject,
  isString,
  isUndefined,
  omit,
  set,
  waitUntil,
} from "./utils/native";

export type BunRequestOptions = ConstructorParameters<typeof BunRequest>[2];

/**
 * The request options an adapter actually holds: never `undefined`, because
 * whatever is assigned is merged over the defaults with
 * `mergeBunRequestOptions`, which always returns an object.
 */
export type ResolvedBunRequestOptions = NonNullable<BunRequestOptions>;

/**
 * The events {@link BunHttpAdapter.eventEmitter} emits, as Node's
 * `EventEmitter<T>` event map (event name → listener arguments).
 *
 * @typeParam customWebsocketDataType The adapter's WebSocket data type, which
 * the `listening` server is typed with.
 */
export interface BunHttpAdapterEvents<customWebsocketDataType = unknown> {
  /** `listen` bound a server; its argument is that `Bun.serve` server. */
  listening: [server: BunServer<WebSocketClientData<customWebsocketDataType>>];
  /** `close` stopped the server (emitted once the server has stopped). */
  close: [];
}
export type WebsocketOptions<customWebsocketDataType = unknown> =
  ConstructorParameters<typeof BunWebSocket<customWebsocketDataType>>[0];
export type BunRouterOptions = ConstructorParameters<typeof BunRouter>[0];

/**
 * The HTTP status an unhandled error answers with, as Express's `finalhandler`
 * picks it: `err.status`, else `err.statusCode`, when it is a number from 400
 * to 599; otherwise `500`.
 */
export function errorStatusCode(error: unknown): number {
  for (const key of ["status", "statusCode"] as const) {
    const value: unknown = isObject(error)
      ? get(error, key, undefined)
      : undefined;
    if (typeof value === "number" && value >= 400 && value < 600) {
      return value;
    }
  }
  return 500;
}

/** HTML-escapes the few characters `finalhandler`'s `escape-html` does. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** What {@link finalErrorResponse} passes its `log` callback besides the error. */
export interface FinalErrorLogContext {
  /** The status the response answers with (see {@link errorStatusCode}). */
  status: number;
  /** The request's method, when {@link FinalErrorResponseOptions.method} was given. */
  method?: string;
  /** The request's path, when {@link FinalErrorResponseOptions.path} was given. */
  path?: string;
}

/** Options for {@link finalErrorResponse}. */
export interface FinalErrorResponseOptions {
  /**
   * The request's method. `HEAD` answers with no body; anything else, or
   * absent (the error carries no request), answers with the HTML page.
   */
  method?: string;
  /** The request's path; only passed through to `log`. */
  path?: string;
  /**
   * Called once, before the response is built, to report the error. It is
   * always called when given — gating it (the adapters skip it under
   * `NODE_ENV=test`) is the caller's choice. Absent: nothing is logged.
   */
  log?: (
    message: string,
    error: unknown,
    context: FinalErrorLogContext,
  ) => void;
}

/**
 * The response for an error nothing handled, as Express's `finalhandler`
 * builds it — what an Express app with no error middleware sends, and what
 * both HTTP adapters (bun-common's and bun-nest's) answer with:
 *
 * - status from `err.status` or `err.statusCode` when it is 4xx/5xx, else
 *   `500` (see {@link errorStatusCode});
 * - an HTML page whose text is the status message (`"Payload Too Large"`),
 *   never the error's message or stack, so nothing leaks in any environment;
 * - `Content-Security-Policy: default-src 'none'` and
 *   `X-Content-Type-Options: nosniff`, plus any `err.headers`;
 * - no body when `options.method` is `HEAD`.
 *
 * @param error The unhandled error (any thrown value).
 * @param options The request's method/path and an optional `log` callback,
 * called as `(message, error, { status, method, path })`.
 */
export function finalErrorResponse(
  error: unknown,
  options: FinalErrorResponseOptions = {},
): Response {
  const status = errorStatusCode(error);
  const { method, path, log } = options;

  log?.("Unhandled error while handling a request", error, {
    status,
    method,
    path,
  });

  const headers = new Headers();
  const errorHeaders: unknown = isObject(error)
    ? get(error, "headers", undefined)
    : undefined;
  if (isObject(errorHeaders)) {
    each(errorHeaders as Record<string, unknown>, (value, key) => {
      headers.set(key, String(value));
    });
  }

  const message = STATUS_CODES[status] ?? String(status);
  const body = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>${escapeHtml(message)}</pre>\n</body>\n</html>\n`;

  headers.set("Content-Security-Policy", "default-src 'none'");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Type", "text/html; charset=utf-8");

  return new Response(method === "HEAD" ? null : body, {
    status,
    statusText: message,
    headers,
  });
}

export class BunHttpAdapter<
  customWebsocketDataType = unknown,
  routesType extends string = never,
> extends BunRouter {
  /** The merged request options; see {@link requestOpts}. */
  #requestOpts!: ResolvedBunRequestOptions;
  #nodeHttpServer!: NodeServer;
  private _instance!: BunRouter;
  private _websocketAdapter!: BunWebSocket<customWebsocketDataType>;
  private _serverInstance:
    | BunServer<WebSocketClientData<customWebsocketDataType>>
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
   * The body parsers already registered, keyed by prefix and parser kind
   * (`"*"` for the untyped `registerParserMiddleware`), so each kind is added
   * once while `json` and `urlencoded` can still sit side by side.
   */
  #registeredBodyParsers = new Set<string>();
  /** When true, every response computes an `ETag`. Opt-in (off by default). */
  protected etagEnabled = false;
  /**
   * Adapter lifecycle events, typed by {@link BunHttpAdapterEvents}:
   * `listening` with the `Bun.serve` server once `listen` binds, and `close`
   * once {@link close} has stopped it. Also what the `nodeHttpServer()` shim's
   * `on`/`once`/`emit` delegate to.
   */
  public readonly eventEmitter = new EventEmitter<
    BunHttpAdapterEvents<customWebsocketDataType>
  >();

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
       * Overrides for the built-in {@link BunWebSocket} adapter (e.g.
       * `wsOptions`, `customDataToWsClientFn`). Merged over the defaults that
       * bind the adapter to this HTTP server's router and shared server.
       */
      websocket?: Partial<WebsocketOptions<customWebsocketDataType>>;
      /**
       * Logger used for adapter diagnostics; also passed to the underlying
       * {@link BunRouter}. Accepts a `Logger` or any supported logging library
       * (pino, winston, consola, log4js, tslog, bunyan, NestJS) — see
       * `resolveLogger`. Defaults to a console logger.
       */
      logger?: LoggerLike;
      /**
       * Options for the underlying {@link BunRouter} (e.g. `caseSensitive`,
       * `debug`). Merged over the defaults `{ caseSensitive: true, debug: false }`,
       * so matching is case-sensitive unless `caseSensitive: false` is given —
       * `/Users` does not match `/users` — even when only `debug` is set.
       * Unlike a bare `BunRouter` (and Express), which default to
       * case-insensitive.
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
    const websocketOptions = options?.websocket || {};

    // Resolved once here so the adapter and its router share one instance
    // rather than each adapting the same input separately.
    const logger = resolveLogger(options?.logger);

    super({
      // The documented defaults, with `router` merged over them — the same
      // shape as bun-nest's adapter, so a partial `router` keeps the rest.
      caseSensitive: true,
      debug: false,
      ...options?.router,
      ...(options?.routeCacheMax !== undefined
        ? { routeCacheMax: options.routeCacheMax }
        : {}),
      logger,
    });

    // Merged over the defaults, not in place of them.
    this.requestOpts = options?.request ?? {};

    this.etagEnabled = options?.etag ?? false;
    this.logger = logger;
    this.serverOptions = options?.server || {};
    this.webSocketAdapter = new BunWebSocket<customWebsocketDataType>({
      router: this,
      newInstance: false,
      getServer: () => {
        return this.getBunServer();
      },
      // The caller's options win, `newInstance` included, so the merged object
      // cannot be checked against one arm of the union statically.
      ...websocketOptions,
    } as WebsocketOptions<customWebsocketDataType>);

    this.initNodeHttpServer();
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
    server: BunServer<WebSocketClientData<customWebsocketDataType>>,
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

    try {
      routeUsed = await this.instance.handle({
        requestHost: req.host,
        requestMethod: req.method,
        response: res,
        request: req,
        requestUrl: req.originalUrl,
      });
    } catch (error) {
      // The request rides on the error to `handleRequestError`, which needs it
      // to run the error handlers. A thrown primitive is wrapped to carry it.
      const carrier: object = isObject(error)
        ? error
        : new Error(String(error));
      set(carrier, "req", req);
      throw carrier;
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
      const upgradeData = res.upgradeToWsData;
      if (upgradeData) {
        const success = server.upgrade(nativeRequest, {
          // The port of the server that accepted the client, unless the
          // upgrade already named one. A socket-free stub has no port.
          data: { ...upgradeData, port: upgradeData.port ?? server.port },
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
   * Runs a request through the adapter without binding a socket, resolving the
   * `Response` the server would have sent.
   *
   * Delegates to {@link handleNativeRequest}, the same method `Bun.serve`'s
   * `fetch` calls, and routes a thrown error through
   * {@link handleRequestError}, the same method `Bun.serve`'s `error` callback
   * calls — so not-found handlers, `setErrorHandler` handlers, the payload
   * guard and response finalisation all apply exactly as they do in production.
   *
   * It never rejects for an error in the pipeline. With no error handler, or
   * none that can run, it resolves the `finalhandler`-style response a served
   * request gets (see {@link handleRequestError}), such as `413` for an
   * oversized body or `500` for a plain throw.
   *
   * @example
   * ```ts
   * const res = await adapter.fetch("/users/42");
   * expect(res.status).toBe(200);
   * ```
   */
  override async fetch(
    input: FetchInput,
    init?: RequestInit,
  ): Promise<Response> {
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
        this.getBunServer() ??
          (FETCH_STUB_SERVER as BunServer<
            WebSocketClientData<customWebsocketDataType>
          >),
      );
    } catch (error) {
      return this.handleRequestError(error);
    }

    // `handleNativeRequest` returns undefined only for a successful WebSocket
    // upgrade, which cannot happen without a socket.
    return (
      response ??
      new Response(null, { status: 101, statusText: "Switching Protocols" })
    );
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
   * timeout.
   *
   * With no handler registered, or when the error carries no request (it was
   * thrown before one was built, or by response finalisation such as a
   * timeout), it answers as Express's `finalhandler` does; see
   * {@link finalErrorResponse}. A handler that throws is answered the same
   * way, for the error it threw. It therefore always resolves.
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
   * The response for an error nothing handled: the standalone
   * {@link finalErrorResponse} (Express's `finalhandler`), for `req`'s method.
   *
   * The error is logged through {@link logger} at `error` level, with its
   * status, method and path as fields, except under `NODE_ENV=test`, as
   * Express's default error logging does.
   */
  protected finalErrorResponse(error: unknown, req?: BunRequest): Response {
    return finalErrorResponse(error, {
      method: req?.method,
      path: req?.path,
      log:
        Bun.env.NODE_ENV === "test"
          ? undefined
          : (message, err, context) => {
              this.logger.error(message, { error: err, ...context });
            },
    });
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

  get instance(): BunRouter {
    return this._instance || this;
  }

  set instance(instance: BunRouter) {
    this._instance = instance;
  }

  public getInstance() {
    return this.instance;
  }

  /**
   * Replaces the router requests run through (the adapter itself by default).
   *
   * From then on only `instance` is consulted. Routes and middleware already
   * on the adapter or a previous instance stay there, unused, so register
   * against the new instance afterwards — {@link enableCors},
   * {@link registerParserMiddleware}, {@link useBodyParser} and
   * {@link useStaticAssets} all register on the current instance.
   */
  public setInstance(instance: BunRouter) {
    this.instance = instance;
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
   * Registers a WebSocket route on this adapter's {@link BunWebSocket} — see
   * {@link BunRouter.ws}. `TCustom`, the type of `ws.data.custom`, defaults to
   * the adapter's own WebSocket data type, so handlers read it without a cast.
   */
  override ws<TCustom = customWebsocketDataType>(
    path: string,
    handler: WebSocketHandler<WebSocketClientData<TCustom>>,
    customDataToWsClientFn?: (
      req: BunRequest,
      res: BunResponse,
    ) => TCustom | Promise<TCustom>,
  ): this {
    return super.ws(path, handler, customDataToWsClientFn);
  }

  get webSocketAdapter() {
    return this._websocketAdapter;
  }

  set webSocketAdapter(adapter: BunWebSocket<customWebsocketDataType>) {
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

  /**
   * Sets the request timeout at once, and calls `callback` with the server once
   * one is listening. Resolves with what `callback` returns (awaited).
   */
  public async setTimeout<R>(
    reqTimeout: number,
    /** Called with the listening server; its result is what the promise resolves. */
    callback: (
      server: BunServer<WebSocketClientData<customWebsocketDataType>>,
    ) => R,
  ): Promise<Awaited<R>> {
    this.requestTimeout = reqTimeout;
    const server = await waitUntil(
      () => this.getBunServer(),
      (
        candidate,
      ): candidate is BunServer<WebSocketClientData<customWebsocketDataType>> =>
        !!candidate,
    );
    return await callback(server);
  }

  public getHeader(response: BunResponse, name: string) {
    return response.getHeader(name);
  }

  public appendHeader(response: BunResponse, name: string, value: string) {
    response.appendHeader(name, value);
    return this;
  }

  /**
   * Registers one body-parsing middleware on the current instance, unless the
   * same `prefix` and `parser` kind is already registered.
   */
  private registerBodyParser(
    /** Path prefix the parser runs under; every path when omitted. */
    prefix: string | undefined,
    /** Store the raw bytes on `req.rawBody` when a body was parsed. */
    rawBody: boolean | undefined,
    /** body-parser options: `type`, `limit`, `inflate`, … */
    options: BodyParserOptions | undefined,
    /** The parser kind, whose default media type applies without `type`; all types when omitted. */
    parser?: BodyParserType,
  ) {
    const key = `${prefix ?? ""}\0${parser ?? "*"}`;
    if (this.#registeredBodyParsers.has(key)) {
      return this;
    }

    const middlewareHandler: RouterMiddlewareHandler = async (req, _, next) => {
      const buffer = await req.handleBodyParsing(true, options, parser);
      // A request this parser skipped (another type, or no body) keeps any
      // `rawBody` an earlier parser set.
      if (rawBody && buffer !== undefined) {
        req.rawBody = buffer;
      }

      if (next) {
        next();
      }
    };

    // On the instance requests actually run through (see `setInstance`).
    if (isString(prefix) && prefix) {
      this.instance.use(prefix, middlewareHandler);
    } else {
      this.instance.use(middlewareHandler);
    }

    this.#registeredBodyParsers.add(key);
    return this;
  }

  /**
   * Registers a parser for one kind of body, as Nest's `useBodyParser` does.
   *
   * `type` picks body-parser's default media type for that kind (`json` →
   * `application/json`, `urlencoded` → `application/x-www-form-urlencoded`,
   * `text` → `text/plain`, `raw` → `application/octet-stream`), unless
   * `options.type` names others. A request of another type is left for other
   * parsers. `options.limit` over the body answers `413`; `options.inflate:
   * false` refuses a compressed body with `415`.
   *
   * Each kind is registered once; calling again for the same kind does
   * nothing, while different kinds stack.
   */
  public useBodyParser(
    type: BodyParserType,
    rawBody: boolean,
    options: BodyParserOptions,
  ) {
    return this.registerBodyParser(undefined, rawBody, options, type);
  }

  public async setListenOptions(
    options: Partial<
      BunServeNormalOptions<
        WebSocketClientData<customWebsocketDataType>,
        routesType
      >
    > & {
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
   * Starts `Bun.serve` on `port` (`0` for an OS-assigned port) and `hostname`
   * (default `127.0.0.1`; any hostname `Bun.serve` accepts, `"localhost"`
   * included), then emits `listening` and calls `callback` with the server.
   *
   * - A port that cannot be bound — busy, privileged — rejects with
   *   `Bun.serve`'s error; the adapter never moves to another port.
   * - Called again while listening on the same hostname and port (or with port
   *   `0`), it resolves with the running server and calls back, without a
   *   second `listening` event.
   * - Called again with a different hostname or port, it stops the running
   *   server (force-closing its connections) and binds the new address.
   */
  public async listen(
    port: string | number,
    /**
     * Called with the listening server, and awaited. Its return value is
     * ignored.
     */
    callback?: (
      server: BunServer<WebSocketClientData<customWebsocketDataType>>,
    ) => unknown,
  ): Promise<BunServer<WebSocketClientData<customWebsocketDataType>>>;
  public async listen(
    port: string | number,
    /** Hostname to bind; `127.0.0.1` when empty. */
    hostname: string,
    /**
     * Called with the listening server, and awaited. Its return value is
     * ignored.
     */
    callback?: (
      server: BunServer<WebSocketClientData<customWebsocketDataType>>,
    ) => unknown,
  ): Promise<BunServer<WebSocketClientData<customWebsocketDataType>>>;
  public async listen(
    port: number | string,
    hostname?:
      | string
      | ((
          server: BunServer<WebSocketClientData<customWebsocketDataType>>,
        ) => unknown),
    callback?: (
      server: BunServer<WebSocketClientData<customWebsocketDataType>>,
    ) => unknown,
  ): Promise<BunServer<WebSocketClientData<customWebsocketDataType>>> {
    callback = isFunction(hostname)
      ? hostname
      : isFunction(callback)
        ? callback
        : () => undefined;

    // Anything `Bun.serve` accepts — an IP literal, `"localhost"`, a name.
    hostname = isString(hostname) && hostname ? hostname : "127.0.0.1";

    port = Number(port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new RangeError(
        `listen(): port must be an integer from 0 to 65535, got ${port}`,
      );
    }

    if (this._serverInstance && this.isServerListening) {
      // Port `0` asks for "any port", which the running server satisfies.
      const sameAddress =
        this._listeningHost === hostname &&
        (port === 0 || Number(this._serverInstance.port) === port);

      if (sameAddress) {
        await callback(this._serverInstance);
        return this._serverInstance;
      }

      // A different address: move there, as documented on `listen`.
      await this._serverInstance.stop(true);
      this._serverInstance = undefined;
      this.isServerListening = false;
    }

    // eslint-disable-next-line ts/no-this-alias
    const that = this;
    let serverInstance: BunServer<WebSocketClientData<customWebsocketDataType>>;
    try {
      serverInstance = Bun.serve<
        WebSocketClientData<customWebsocketDataType>,
        routesType
      >({
        ...(this.serverOptions || {}),
        port,
        hostname,
        development: Bun.env.NODE_ENV !== "production",
        async fetch(nativeRequest: Request, server) {
          return that.handleNativeRequest(nativeRequest, server);
        },
        websocket: that.webSocketAdapter.wsHandler,
        error(err) {
          return that.handleRequestError(err);
        },
      });
    } catch (error) {
      // A busy port (`EADDRINUSE`), a hostname that does not resolve, a port
      // needing privileges: surfaced, as `node:http` does, rather than bound
      // somewhere else.
      this.logger.error("Error while binding to listener", {
        error,
        hostname,
        port,
      });
      throw error;
    }

    this._serverInstance = serverInstance;
    this._listeningHost = hostname;
    this._listeningPort = serverInstance.port ?? port;
    await this.getListenAddress();

    this.isServerListening = true;
    this.eventEmitter.emit("listening", serverInstance);

    await callback(this._serverInstance);

    return this._serverInstance;
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

  /**
   * Redirects to `url`: sets `Location` and the status (`302` when
   * `statusCode` is `0`), then sends the response with an empty body. Like
   * Express's `res.redirect`, this finishes the response — nothing needs to
   * follow it — but unlike Express it sends no "Redirecting to" body.
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

  /**
   * Adds a final error handler for an error the router's own error handlers
   * left unhandled. Runs for a served request and for {@link fetch} alike (see
   * {@link handleRequestError}); handlers are kept across {@link close}.
   */
  public setErrorHandler(handler: RouterErrorMiddlewareHandler) {
    this._errorHandlers.push(handler);
  }

  /**
   * Adds a handler for a request no route answered, run in place of the empty
   * `404`. Handlers are kept across {@link close}.
   */
  public setNotFoundHandler(handler: RouterMiddlewareHandler) {
    this._notFoundHandlers.push(handler);
  }

  /**
   * Serves a directory of files under `options.prefix`.
   *
   * Implements the `serve-static` contract in {@link ServeStaticOptions}:
   * directory indexes, extension fallbacks, dotfile policy, `ETag` /
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
    // No parser kind: every body type is parsed.
    this.registerBodyParser(prefix, rawBody, {
      inflate: true,
    });

    return this;
  }

  public enableCors(
    options: BunCorsOptions | CorsOptionsDelegate<BunRequest>,
    prefix?: string,
  ) {
    // `cors()` takes both forms: fixed options, or a per-request delegate whose
    // error is passed to `next(err)` — so it reaches the error handlers.
    const handler: RouterHandler = cors(options);

    // Everything on the instance requests actually run through (see
    // `setInstance`), so the middleware and its preflight route stay together.
    if (prefix) {
      this.instance.use(prefix, handler);
      const router = new BunRouter();
      router.options("*", handler);
      this.instance.group(prefix, router);
      return this;
    }

    this.instance.use(handler);
    this.instance.options("*", handler);
    return this;
  }

  /**
   * Stops listening: force-closes the server (`server.stop(true)`, so a
   * keep-alive connection cannot keep answering from it) and emits `close`.
   *
   * Everything registered survives — routes, middleware, and the
   * {@link setErrorHandler}/{@link setNotFoundHandler} handlers — so the
   * adapter can {@link listen} again, or keep serving {@link fetch}, as it was.
   */
  public async close() {
    try {
      if (this._serverInstance && this.isServerListening) {
        // Force-close active (keep-alive) connections so the port is fully
        // released; a graceful stop can leave the listener lingering.
        await this._serverInstance.stop(true);
      }
    } catch (err) {
      this.logger.error("An error occurred while closing bun http adapter", {
        error: err,
      });
    }
    this.eventEmitter.emit("close");
    this._serverInstance = undefined;
    this.isServerListening = false;
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

  public async init() {
    if (this._serverInstance) {
      return this._serverInstance;
    }

    return undefined;
  }

  public initNodeHttpServer() {
    if (this.#nodeHttpServer) {
      return this.#nodeHttpServer;
    }

    // Bypass event handlers added to httpServer and call of address
    this.#nodeHttpServer = new Proxy({} as NodeServer, {
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
            // Not thenable. A `then` here makes `await server` (and NestJS's
            // resolution of an async `initHttpServer()`) wait on it; the old
            // trap polled for a listening server forever, so an app that never
            // listened never settled or exited, even after `close()`.
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
    });

    return this.#nodeHttpServer;
  }

  public nodeHttpServer() {
    return this.initNodeHttpServer();
  }
}
