/* eslint-disable @typescript-eslint/no-unsafe-function-type */

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
  EtagOption,
  FetchInput,
  matchedRoute,
  MountedHandler,
  NextFunction,
  ResolvedBunRequestOptions,
  RouterErrorMiddlewareHandler,
  RouterHandler,
  RouterMiddlewareHandler,
  ServeHooks,
  ServeStaticOptions,
  SocketFreeExchange,
  UnmountedRouter,
  ValidatorMiddleware,
  ViewEngine,
} from "@kingsleyweb/bun-common";
import type { NestApplicationOptions } from "@nestjs/common";
// A deep path names a file, with its `.js` extension: Nest 11's `@nestjs/*`
// have no `exports` map (the path is resolved as a file), Nest 12's serve it
// through their `./*.js` entry, and a `node16` consumer reads this specifier
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
  assertExpressPath,
  awaitPipelineOrStream,
  BunRequest,
  BunResponse,
  BunRouter,
  BunViews,
  cors,
  createServeStaticHandler,
  defineHidden,
  each,
  encodeUrl,
  FETCH_STUB_SERVER,
  finalErrorResponse,
  get,
  isFunction,
  isNull,
  isObject,
  isRequestTimeoutError,
  isString,
  isUndefined,
  mergeBunRequestOptions,
  normalizeEtagOption,
  omit,
  openSocketFree,
  RequestPipelineOptions,
  set,
  toFetchResponse,
  validateParseBodyOption,
  waitUntil,
} from "@kingsleyweb/bun-common";
import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  RequestMethod,
  StreamableFile,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import { AbstractHttpAdapter } from "@nestjs/core/adapters/http-adapter.js";
import { LegacyRouteConverter } from "@nestjs/core/router/legacy-route-converter.js";
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
 * returned — the view's locals, as on `@nestjs/platform-express`. Every key
 * is a local, `status` included (set a status with `@HttpCode()`).
 */
export interface RenderOptions {
  /** A view local: whatever the handler returned. */
  [local: string]: unknown;
}

type ApplyVersionFilterParameters = Parameters<
  AbstractHttpAdapter["applyVersionFilter"]
>;

/**
 * Whether the installed `@nestjs/core` scopes the not-found handler to the
 * global prefix, as `@nestjs/platform-express` does from Nest 12 (nestjs/nest
 * #16372). Read from a capability, never a version string:
 * `AbstractHttpAdapter.prototype.mapException`, which 12.0.0 added with that
 * scoping (#15075). `excludedRoutes` cannot be the signal: the core passes it
 * only from 12.1.3.
 */
function coreScopesNotFoundToPrefix(): boolean {
  return (
    typeof (AbstractHttpAdapter.prototype as { mapException?: unknown })
      .mapException === "function"
  );
}

/**
 * `RequestMethod.QUERY` when the installed `@nestjs/common` has it (11.2.0
 * and 12), else `undefined`: read from the enum object, never from a version
 * string, and never named in a type, which Nest 11.1's declarations lack.
 */
function queryRequestMethod(): RequestMethod | undefined {
  return (RequestMethod as unknown as Record<string, RequestMethod | undefined>)
    .QUERY;
}

/** One not-found handler Nest registered, with the prefix it is scoped to. */
interface NotFoundEntry {
  /** Nest's not-found proxy: throws `NotFoundException` into its filters. */
  handler: RouterMiddlewareHandler;
  /**
   * The normalised global prefix (`/api`, `/:tenant`) it answers under, or
   * `undefined` when it answers outside every prefix: an application without
   * one, or any application on Nest 11, where the handler is global.
   * Compared as written by the skip for other applications' prefixes.
   */
  prefix: string | undefined;
  /**
   * {@link prefix} compiled once, as a `use()` mount matches it: a prefix
   * match on whole segments, case-insensitive, its parameters matching any
   * segment (see {@link prefixMatcher}). `undefined` with no prefix.
   */
  matcher: ((pathname: string) => boolean) | undefined;
}

/**
 * A global prefix as `@nestjs/platform-express` 12 normalises it
 * (`stripEndSlash(addLeadingSlash(prefix))`): a leading slash added unless it
 * starts with `/` or `{/`, and one trailing slash removed (`api/` → `/api`).
 * Empty, `/`, or anything but a string is no prefix (`undefined`): Nest hands
 * an array from `setGlobalPrefix(["api", "v1"])` over as it is (the array
 * form is in v12.1.0's release notes but was reverted before any release),
 * and Express's `addLeadingSlash` reads a non-string as `""`.
 */
function normalizePrefix(prefix: unknown): string | undefined {
  if (!prefix || typeof prefix !== "string") {
    return undefined;
  }
  const withSlash =
    prefix.startsWith("/") || prefix.startsWith("{/") ? prefix : `/${prefix}`;
  return (
    (withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash) || undefined
  );
}

/** A prefix routejs compiles to a literal: segments of `[\w.~-]` only. */
const PLAIN_PREFIX = /^(?:\/[\w.~-]+)+$/;

/**
 * A normalised prefix compiled as Express's `use(prefix, router)` matches
 * it: at the prefix or below it, on whole segments (`/apiary` is not under
 * `/api`), case-insensitively, a `:param` matching any one segment
 * (`/:tenant` covers `/t1/x`), a `{…}` group optional. Compiled by
 * bun-common's router itself, as it compiles a `use()` prefix, so the two
 * cannot disagree; `i` is added if the compiled regex lacks it.
 *
 * A prefix of plain segments (`/api/v1`: letters, digits, `_ . ~ -`) is
 * matched without the regex, by {@link isUnderAsciiPrefix}: it compiles to
 * the literal `^\/api\/v1\/?(?=\/|$)`, which that comparison is.
 */
function prefixMatcher(prefix: string): (pathname: string) => boolean {
  if (PLAIN_PREFIX.test(prefix)) {
    const lower = prefix.toLowerCase();
    return (pathname) => isUnderAsciiPrefix(pathname, lower);
  }
  const router = new BunRouter({ caseSensitive: false });
  router.use(prefix, (_req, _res, next) => next());
  const compiled = router.routes()[0]!.pathRegexp;
  const regexp = compiled.flags.includes("i")
    ? compiled
    : new RegExp(compiled.source, `${compiled.flags}i`);
  return (pathname) => regexp.test(pathname);
}

/**
 * Whether `pathname` is `lower` (an ASCII prefix, lower-cased) or below it on
 * whole segments, ASCII letters compared case-insensitively: what the
 * prefix's `i` regex `^<prefix>\/?(?=\/|$)` matches. A non-ASCII character
 * never folds to an ASCII letter under a non-Unicode `i` regex, so ASCII
 * folding is the whole of it.
 */
function isUnderAsciiPrefix(pathname: string, lower: string): boolean {
  const length = lower.length;
  if (
    pathname.length < length ||
    (pathname.length > length && pathname.charCodeAt(length) !== 47) // "/"
  ) {
    return false;
  }
  for (let i = 0; i < length; i++) {
    let code = pathname.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      code |= 32; // A-Z to a-z
    }
    if (code !== lower.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether `pathname` is `prefix` or below it, comparing the prefix as
 * written, on whole segments: `@nestjs/platform-express` 12's skip, in an
 * unprefixed application's handler, for paths under another application's
 * prefix.
 */
function isUnderLiteralPrefix(pathname: string, prefix: string): boolean {
  return (
    pathname.startsWith(prefix) &&
    (pathname.length === prefix.length ||
      pathname.charCodeAt(prefix.length) === 47) // "/"
  );
}

/**
 * The path of a request URL as `url.split(/[?#]/)[0]` reads it, up to the
 * first `?` or `#`, without the regex or the array.
 */
function pathOfUrl(url: string): string {
  let end = url.indexOf("?");
  const hash = url.indexOf("#");
  if (hash !== -1 && (end === -1 || hash < end)) {
    end = hash;
  }
  return end === -1 ? url : url.slice(0, end);
}

/** The five characters `escape-html` replaces, and their entities. */
const HTML_ESCAPES: Record<string, string> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
};

/** `escape-html`'s escaping, which `finalhandler` applies to its page. */
function escapeHtml(text: string): string {
  return text.replace(/["&'<>]/g, (char) => HTML_ESCAPES[char]);
}

/**
 * bun-common's 404 page, read once (see {@link cannotRouteResponse}): its HTML
 * split around its message, its status and its headers.
 */
interface NotFoundPage {
  /** The HTML before `<pre>`. */
  before: string;
  /** The HTML after `</pre>`. */
  after: string;
  /** Its status, `404`. */
  status: number;
  /** Its status text, `Not Found`. */
  statusText: string;
  /** Its headers, as `Headers.forEach` lists them. */
  headers: [name: string, value: string][];
}

/** {@link NotFoundPage} while it is read, the first time a page is built. */
let notFoundPageRead: Promise<NotFoundPage> | undefined;
/** {@link NotFoundPage} once read: later pages are built synchronously. */
let notFoundPage: NotFoundPage | undefined;

/** The headers `finalhandler` removes from a response before its page. */
const FINALHANDLER_REMOVED_HEADERS = [
  "content-encoding",
  "content-language",
  "content-range",
];

/**
 * The page Express's `finalhandler` sends when nothing answered a request
 * (no error at all): `404` with `<pre>Cannot GET /path</pre>`, the path being
 * the request's, without its query, URL-encoded and HTML-escaped.
 *
 * Built from bun-common's {@link finalErrorResponse} 404 — its status, its
 * headers (`Content-Type`, `Content-Security-Policy`, `nosniff`) and its
 * HTML, with the status message replaced by finalhandler's text — so the
 * template is defined in one place. As finalhandler, it keeps the headers
 * middleware already set on the response (CORS, security headers, cookies),
 * less `Content-Encoding`, `Content-Language` and `Content-Range`, and sets
 * its own over them.
 */
function cannotRouteResponse(
  method: string,
  pathname: string,
  responseHeaders: Record<string, string | string[] | number | undefined>,
): Response | Promise<Response> {
  if (notFoundPage) {
    return buildCannotRoute(notFoundPage, method, pathname, responseHeaders);
  }
  notFoundPageRead ??= readNotFoundPage();
  return notFoundPageRead.then((page) =>
    buildCannotRoute(page, method, pathname, responseHeaders),
  );
}

/**
 * Reads bun-common's 404 once: a `GET` 404 from {@link finalErrorResponse}
 * is the same every time, so its parts are kept rather than rebuilt per miss.
 */
async function readNotFoundPage(): Promise<NotFoundPage> {
  const base = finalErrorResponse({ status: 404 }, { method: "GET" });
  const headers: [string, string][] = [];
  base.headers.forEach((value, name) => {
    headers.push([name, value]);
  });
  const html = await base.text();
  const [before = "", after = ""] = html.split(`<pre>${base.statusText}</pre>`);
  notFoundPage = {
    before,
    after,
    status: base.status,
    statusText: base.statusText,
    headers,
  };
  return notFoundPage;
}

/** One {@link cannotRouteResponse} page, from the page read once. */
function buildCannotRoute(
  page: NotFoundPage,
  method: string,
  pathname: string,
  responseHeaders: Record<string, string | string[] | number | undefined>,
): Response {
  const message = escapeHtml(`Cannot ${method} ${encodeUrl(pathname)}`);
  // A HEAD request too: the transport drops the body (Bun on the wire,
  // `toFetchResponse` for `fetch()`) and keeps its length, as finalhandler
  // sends `Content-Length` without the body.
  const headers = new Headers();
  for (const name in responseHeaders) {
    const value = responseHeaders[name];
    if (value === undefined || FINALHANDLER_REMOVED_HEADERS.includes(name)) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const one of value) {
        headers.append(name, String(one));
      }
    } else {
      headers.append(name, String(value));
    }
  }
  for (const [name, value] of page.headers) {
    headers.set(name, value);
  }
  return new Response(`${page.before}<pre>${message}</pre>${page.after}`, {
    status: page.status,
    statusText: page.statusText,
    headers,
  });
}

/** `close()`'s default drain cap, in milliseconds. */
const DEFAULT_CLOSE_DRAIN_TIMEOUT = 10_000;

/**
 * The `closeDrainTimeout` adapter option, checked: `undefined` is the
 * default; anything but a finite number of milliseconds `>= 0` throws.
 */
function validateCloseDrainTimeout(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_CLOSE_DRAIN_TIMEOUT;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `closeDrainTimeout must be a finite number of milliseconds >= 0, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * `page` with the headers a response had set before it, as `finalhandler`
 * writes its page on that response: `responseHeaders` less the ones it
 * removes and `Content-Length` (the page's own), with `page`'s set over them.
 */
function withResponseHeaders(
  page: Response,
  responseHeaders: Record<string, string | string[] | number | undefined>,
): Response {
  const headers = new Headers();
  for (const name in responseHeaders) {
    const value = responseHeaders[name];
    if (
      value === undefined ||
      name === "content-length" ||
      FINALHANDLER_REMOVED_HEADERS.includes(name)
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const one of value) {
        headers.append(name, String(one));
      }
    } else {
      headers.append(name, String(value));
    }
  }
  page.headers.forEach((value, name) => {
    headers.set(name, value);
  });
  return new Response(page.body, {
    status: page.status,
    statusText: page.statusText,
    headers,
  });
}

/** `value` as an `Error`: itself when it is one, else wrapped. */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * The body {@link BunHttpAdapter.reply} streams for a `StreamableFile` whose
 * first chunk (`first`) has been read: that chunk, then the rest of `chunks`.
 * A failure along the way goes to the file's `errorHandler` and ends the
 * body; a body cancelled by the client returns the iterator, which destroys
 * the source.
 */
async function* streamFileFrom(
  first: IteratorResult<unknown>,
  chunks: AsyncIterator<unknown>,
  file: StreamableFile,
  response: BunResponse,
): AsyncGenerator<unknown, void, undefined> {
  let finished = first.done === true;
  try {
    if (!finished) {
      yield first.value;
    }
    while (!finished) {
      let next: IteratorResult<unknown>;
      try {
        next = await chunks.next();
      } catch (error) {
        finished = true;
        file.errorHandler(asError(error), response);
        return;
      }
      if (next.done) {
        finished = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!finished) {
      await chunks.return?.();
    }
  }
}

/**
 * The key the response a request was answering rides on, on a carried error
 * (see {@link carryRequest}). A symbol, so an error's own `res` or `response`
 * property (a client library's, say) is never mistaken for it.
 */
const CARRIED_RESPONSE = Symbol("bun-nest.carriedResponse");

/**
 * `error` with the request riding on it, for `handleRequestError`, which
 * needs it to run the error handlers; a thrown primitive is wrapped to carry
 * it. A pipeline parked past the request timeout is passed on as is: it is
 * answered as a timed-out response wait always was, without the request.
 *
 * `res`, when given, is the response the pipeline was building, which rides
 * along too: the error handlers then answer on it, as Express's error
 * middleware gets the same `res` (so the headers set before the error, a
 * security hook's or CORS's, reach the error's answer).
 */
function carryRequest(
  error: unknown,
  req: BunRequest,
  res?: BunResponse,
): unknown {
  if (isRequestTimeoutError(error)) {
    return error;
  }
  const carrier: object = isObject(error) ? error : new Error(String(error));
  defineHidden(carrier, "req", req);
  defineHidden(carrier, CARRIED_RESPONSE, res);
  return carrier;
}

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

  /**
   * Set once a body parser is registered with `rawBody`: it needs the bytes
   * of every body, so the request options keep them (`retainBuffer`) unless
   * they say otherwise, whenever they are replaced.
   */
  #rawBodyNeedsBuffer = false;

  /**
   * Set once a security hook is registered (`app.enableCsrfProtection()` or
   * `app.useSecurityHeaders()`, through {@link registerSecurityHook}): the
   * hook must run before the body is read, so the request options defer it
   * (`deferBody`) unless they say otherwise, whenever they are replaced.
   */
  #securityHookDefersBody = false;

  public _logger!: Logger;
  private _websocketAdapter!: BunNestWebsocketAdapter<customWebsocketDataType>;
  private _serverInstance:
    | BunWebSocketServerType<customWebsocketDataType>
    | undefined = undefined;

  private _listeningHost = "127.0.0.1";
  private _listeningPort: string | number = 3000;
  /**
   * The unix socket path the server listens on, when `listen()` was given
   * one; `undefined` while it listens on a TCP port (or not at all).
   */
  private _listeningSocketPath: string | undefined = undefined;
  protected isServerListening = false;

  /**
   * Whether the application is shutting down: set by {@link beforeClose}
   * (which Nest 12 calls before the shutdown hooks run) and by {@link close},
   * cleared by a successful {@link listen}. While it is set, the
   * `return503OnClosing` middleware answers every request `503`.
   */
  #isShuttingDown = false;

  /**
   * The `forceCloseConnections` application option, read in
   * {@link initHttpServer}: `close()` then cuts in-flight requests at once
   * instead of draining them. Default `false`.
   */
  #forceCloseConnections = false;

  /** Whether the `return503OnClosing` middleware is registered (once per adapter). */
  #closingGuardRegistered = false;

  /**
   * The longest {@link close} waits for in-flight requests to finish before
   * cutting them, in milliseconds: the constructor's `closeDrainTimeout`
   * option, default `10_000`.
   */
  readonly #closeDrainTimeout: number;
  private serverOptions:
    | BunServeNormalOptions<
        WebSocketClientData<customWebsocketDataType>,
        routesType
      >
    | undefined = undefined;

  /** Nest's not-found handlers, each with its prefix; see {@link setNotFoundHandler}. */
  private _notFoundHandlers: NotFoundEntry[] = [];
  /**
   * Every not-found handler, in order, while none is scoped to a prefix
   * (always on Nest 11; on Nest 12 without a global prefix): a miss then
   * runs them all, with no path to read. `undefined` once one is scoped.
   * Rebuilt by {@link setNotFoundHandler}.
   */
  #unscopedNotFoundHandlers: RouterMiddlewareHandler[] | undefined;
  /**
   * The handler lists a miss has selected while some handler is scoped,
   * keyed by the bit mask of the entries selected, so a miss allocates no
   * list once its combination has been seen. Cleared by
   * {@link setNotFoundHandler}.
   */
  #scopedNotFoundSets = new Map<number, RouterMiddlewareHandler[]>();
  private _errorHandlers: RouterErrorMiddlewareHandler[] = [];
  /**
   * Whether not-found handlers are scoped to their global prefix, as
   * `@nestjs/platform-express` 12 scopes them: read once, here, from the
   * installed `@nestjs/core` (see {@link setNotFoundHandler}).
   */
  readonly #scopeNotFoundToPrefix = coreScopesNotFoundToPrefix();
  /**
   * Body parsers already registered, keyed by path prefix and parser kind
   * (`"*"` for the untyped `registerParserMiddleware`), so each kind is added
   * once while different kinds (`json` beside `text`, …) stack.
   */
  #registeredBodyParsers = new Set<string>();
  /**
   * The application's views — Express's `views` / `view engine` /
   * `view cache` settings, engines and `app.locals` — which every response's
   * `render()` (and so `@Render()`) uses. Set through {@link setBaseViewsDir},
   * {@link setViewEngine}, {@link engine}, {@link setLocal} and {@link set}.
   * The underlying bun-common router (`getInstance()`) is given the same
   * instance, so its own `fetch()` renders through it too.
   */
  readonly views: BunViews;
  /** The `etag` option every response starts with (see `BunResponse.etag`). */
  protected etagEnabled: EtagOption = false;
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
       * (body/cookie/query parsing, size caps, the cookie secret, etc.),
       * merged over `{ parseBody: true, parseCookies: true }` with
       * `mergeBunRequestOptions` — so `{ parseCookies: { secret } }` alone
       * keeps body parsing on. Set a default explicitly to turn it off
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
       * `debug`). Defaults to `{ caseSensitive: false, debug: false }`:
       * paths match case-insensitively, as on `@nestjs/platform-express`
       * (Express's default). `{ caseSensitive: true }` opts in to exact case.
       */
      router?: BunRouterOptions;
      /**
       * How every response is tagged with an `ETag`: `false` (the default),
       * `true`/`"strong"`, `"weak"`, or a function returning the tag (see
       * `BunResponse.etag`). A response's own `res.setEtag(...)` /
       * `res.etag = ...` overrules it for that response.
       */
      etag?: EtagOption;
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
       * The longest `close()` (and so `app.close()`) waits for in-flight
       * requests to finish before cutting them, in milliseconds. Defaults to
       * `10_000`. `0` waits for nothing: in-flight requests are cut at once,
       * as with the `forceCloseConnections` application option, which skips
       * the wait whatever this says. A negative or non-finite value throws a
       * `RangeError` here, at construction.
       */
      closeDrainTimeout?: number;
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
      caseSensitive: false,
      debug: false,
      ...(options?.router ?? {}),
      ...(options?.routeCacheMax !== undefined
        ? { routeCacheMax: options.routeCacheMax }
        : {}),
    };
    // One BunViews for the adapter and its router, so the router's own
    // `fetch()` renders as the adapter does.
    const views = new BunViews();
    const router = new BunRouter({ ...routerOptions, views });
    super(router);
    this.views = views;

    const logger = options?.logger || new Logger();
    this.setInstance(router);

    // Merged over the defaults, not in place of them.
    this.requestOpts = options?.request ?? {};

    // Checked here, so a bad value fails at startup, not on the first close.
    this.#closeDrainTimeout = validateCloseDrainTimeout(
      options?.closeDrainTimeout,
    );

    // Checked here, so a bad value fails at startup, not on every request.
    this.etagEnabled = normalizeEtagOption(options?.etag);
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
    return this.serveNativeRequest(nativeRequest, server);
  }

  /**
   * {@link handleNativeRequest}, without the promise when none is needed: a
   * request with no body whose layers all finish synchronously gets its
   * `Response` back directly, which `Bun.serve` writes without resolving a
   * promise. Anything asynchronous along the way makes the result a promise
   * from that point. An error is always a rejection, as from
   * {@link handleNativeRequest}.
   *
   * `Bun.serve`'s `fetch` calls this unless a subclass overrides
   * {@link handleNativeRequest}, in which case the override is called.
   */
  protected serveNativeRequest(
    nativeRequest: Request,
    server: BunWebSocketServerType<customWebsocketDataType>,
  ): Response | undefined | Promise<Response | undefined> {
    try {
      // `BunRequest.init` returns the instance synchronously when nothing is
      // left to read. Branching rather than awaiting is what keeps the whole
      // request synchronous.
      const created = BunRequest.init(nativeRequest, server, this.requestOpts);
      if (created instanceof BunRequest) {
        return this.#routeRequest(created, nativeRequest, server);
      }
      return created.then((req) =>
        this.#routeRequest(req, nativeRequest, server),
      );
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- passes on whatever was thrown, unchanged, so the error handler sees the value a route threw
      return Promise.reject(error);
    }
  }

  /** Runs a built request through the payload guard and the router. */
  #routeRequest(
    req: BunRequest,
    nativeRequest: Request,
    server: BunWebSocketServerType<customWebsocketDataType>,
  ): Response | undefined | Promise<Response | undefined> {
    // DDoS guard: a body that exceeded `parseBody.maxContentLength` is
    // rejected with 413 before any route handler or middleware runs.
    if (req.isPayloadTooLarge) {
      return BunRequest.payloadTooLargeResponse(req);
    }

    // A body refused for its `Content-Encoding` while the request was built
    // (`parseBody.inflate: false`, an unsupported coding, a corrupt stream)
    // goes to the error handling with the request, as body-parser's
    // `next(err)` does — answered with its 415/400 rather than routed with no
    // body. Unless the route that would handle it opted in
    // (`acceptUndecodableBody`): then it is routed, the refusal on
    // `req.bodyDecodingError`, as `router.fetch()` routes it.
    const router = this.instance;
    const decodingError = req.bodyDecodingError;
    if (decodingError && !router.routesUndecodableBody(req)) {
      defineHidden(decodingError, "req", req);
      throw decodingError;
    }

    const res = new BunResponse<customWebsocketDataType>(req, {
      etag: this.etagEnabled,
      views: this.views,
    });
    // The host and the full target are read only if a route needs them.
    const options = new RequestPipelineOptions(
      req,
      res,
      req.method,
      req.path,
      this.requestTimeout,
    );

    // A handler that opens a long-lived stream and awaits its end — NestJS's
    // `@Sse()` resolves only once the observable completes or the client
    // leaves — would otherwise hold the headers back until then. On Node they
    // go out as soon as `writeHead`/`flushHeaders` runs, so the stream's
    // response is returned the moment it opens, the pipeline still running.
    if (router.handle === BunRouter.prototype.handle) {
      return router.serveRequest(options, this.#serveHooks);
    }
    // A router whose `handle` was overridden is run through the override.
    let routed: ReturnType<typeof awaitPipelineOrStream>;
    try {
      routed = awaitPipelineOrStream(router.handle(options), res, (error) => {
        this.#serveHooks.lateError(options, error);
      });
    } catch (error) {
      throw carryRequest(error, req, res);
    }
    return routed.then(
      (outcome) =>
        outcome.stream ??
        this.#respond(req, res, outcome.routeUsed, nativeRequest, server),
      (error: unknown) => {
        throw carryRequest(error, req, res);
      },
    );
  }

  /**
   * How the router finishes a served request (see bun-common's
   * `BunRouter.serveRequest`): one object for every request, so a request
   * pays for no closures, and an asynchronous one for no promise but the
   * pipeline's — Nest's route callback is always asynchronous.
   */
  readonly #serveHooks: ServeHooks<Response | undefined> = {
    respond: (options, routeUsed) => {
      const req = options.request;
      return this.#respond(
        req,
        options.response as BunResponse<customWebsocketDataType>,
        routeUsed,
        req.request,
        req.server as BunWebSocketServerType<customWebsocketDataType>,
      );
    },
    stream: (_options, stream) => stream,
    error: (options, error) =>
      carryRequest(error, options.request, options.response),
    lateError: (options, error) => {
      // Headers are gone, so nothing but the stream's end can answer it,
      // as Express's finalhandler does once headers were sent.
      this.logger.error(
        "Error after a streaming response started",
        error instanceof Error ? error.stack : String(error),
      );
      // `end()` on a response that has already ended does nothing.
      void options.response.end();
    },
  };

  /** Produces the response once the router is done with the request. */
  #respond(
    req: BunRequest,
    res: BunResponse<customWebsocketDataType>,
    routeUsed: matchedRoute | true | undefined,
    nativeRequest: Request,
    server: BunWebSocketServerType<customWebsocketDataType>,
  ): Response | undefined | Promise<Response | undefined> {
    if (!routeUsed) {
      if (!this._notFoundHandlers.length) {
        return new Response(undefined, {
          status: 404,
          statusText: "Not Found",
        });
      }
      const unscoped = this.#unscopedNotFoundHandlers;
      if (unscoped) {
        return this.#runNotFoundHandlers(req, res, unscoped).then(() =>
          this.#produceResponse(res, nativeRequest, server),
        );
      }
      const pathname = pathOfUrl(req.originalUrl);
      const handlers = this.#notFoundHandlersFor(pathname);
      if (!handlers.length) {
        // Outside every application's prefix (Nest 12): no Nest handler
        // answers, so Express's finalhandler does, with its HTML page.
        return cannotRouteResponse(req.method, pathname, res.getHeaders());
      }
      return this.#runNotFoundHandlers(req, res, handlers).then(() =>
        this.#produceResponse(res, nativeRequest, server),
      );
    }
    return this.#produceResponse(res, nativeRequest, server);
  }

  /**
   * The not-found handlers that answer a miss at `pathname`, in registration
   * order, as `@nestjs/platform-express` 12 mounts them: one scoped to a
   * prefix answers at or under it, matched as Express's `use(prefix)`
   * matches (case-insensitively, `:param` segments included); an unscoped
   * one answers unless `pathname` is under some application's prefix as
   * written (several applications on one adapter). On Nest 11 every handler
   * is unscoped, so every one applies (and {@link #respond} never asks).
   *
   * Plain loops and a remembered list per combination: a miss allocates
   * nothing once its combination has been seen.
   */
  #notFoundHandlersFor(pathname: string): RouterMiddlewareHandler[] {
    const entries = this._notFoundHandlers;
    let underSomePrefix = false;
    for (const entry of entries) {
      if (
        entry.prefix !== undefined &&
        isUnderLiteralPrefix(pathname, entry.prefix)
      ) {
        underSomePrefix = true;
        break;
      }
    }
    // Past what a 31-bit mask holds, the list is built each time.
    const built: RouterMiddlewareHandler[] | undefined =
      entries.length > 31 ? [] : undefined;
    let mask = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (
        entry.matcher === undefined ? !underSomePrefix : entry.matcher(pathname)
      ) {
        if (built) {
          built.push(entry.handler);
        } else {
          mask |= 1 << i;
        }
      }
    }
    if (built) {
      return built;
    }
    let handlers = this.#scopedNotFoundSets.get(mask);
    if (!handlers) {
      handlers = entries
        .filter((_, i) => mask & (1 << i))
        .map((entry) => entry.handler);
      this.#scopedNotFoundSets.set(mask, handlers);
    }
    return handlers;
  }

  /** Runs the not-found handlers, as when no route answered the request. */
  async #runNotFoundHandlers(
    req: BunRequest,
    res: BunResponse<customWebsocketDataType>,
    handlers: RouterMiddlewareHandler[],
  ): Promise<void> {
    let continueProcessingHandlers = true;
    const next: NextFunction = (err) => {
      if (!(isUndefined(err) || isNull(err))) {
        continueProcessingHandlers = false;
      }
    };

    for await (const handler of handlers) {
      if (!continueProcessingHandlers) {
        break;
      }

      const resp = await handler(req, res, next);
      continueProcessingHandlers = !!resp;
    }
  }

  /** The native response the handlers produced, or the WebSocket upgrade. */
  #produceResponse(
    res: BunResponse<customWebsocketDataType>,
    nativeRequest: Request,
    server: BunWebSocketServerType<customWebsocketDataType>,
  ): Response | undefined | Promise<Response | undefined> {
    const upgradeData = res.upgradeToWsData;
    if (upgradeData) {
      const success = server.upgrade(nativeRequest, {
        // The accepting server's port, unless the handler recorded one, so
        // a gateway can tell which server a client arrived on.
        data: { ...upgradeData, port: upgradeData.port ?? server.port },
        // Only headers the upgrade was explicitly given; the key is left out
        // otherwise so the 101 is exactly Bun's default.
        ...(res.upgradeToWsHeaders ? { headers: res.upgradeToWsHeaders } : {}),
      });

      if (success) {
        return undefined;
      }

      return res.getNativeResponse(100).catch(
        () =>
          new Response("An error occurred while upgrading websocket", {
            status: 400,
          }),
      );
    }

    // A handler that called `send()` has already produced the native
    // response synchronously; taking it directly avoids a promise and a
    // microtask tick on the common path.
    return res.settledResponse ?? res.getNativeResponse(this.requestTimeout);
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
   * The caller leaving is a disconnect, as served (see bun-common's
   * `openSocketFree`): an abort of the request's signal rejects this with
   * its reason, and so does the read in progress on a streamed body (an
   * `@Sse()` stream among them); cancelling a streamed body aborts
   * `req.signal`, so `res`, `req` and `req.socket` emit `close` — what Nest's
   * SSE teardown and `@SseSignal()` listen to. A signal passed in a
   * `RequestInit` that is aborted already rejects at once, without handling;
   * a `Request`'s own is read only once the router's pipeline waits on a
   * layer (a Nest handler always does).
   *
   * @example
   * ```ts
   * const res = await adapter.fetch("/users/42");
   * expect(res.status).toBe(200);
   * ```
   */
  public fetch(input: FetchInput, init?: RequestInit): Promise<Response> {
    const exchange = openSocketFree(
      input,
      init,
      this.isListening ? this.url : undefined,
    );
    return exchange.preflight() ?? this.#fetchExchange(exchange);
  }

  /**
   * {@link fetch}'s handling of the exchange's request: through
   * {@link serveNativeRequest}, as `Bun.serve`'s `fetch` handler calls it
   * (or an overriding {@link handleNativeRequest}), racing the caller's
   * signal only when it returns a promise.
   */
  async #fetchExchange(exchange: SocketFreeExchange): Promise<Response> {
    const nativeRequest = exchange.request;
    // A live server when one exists, so `requestIP`/`upgrade` behave; a stub
    // otherwise, which reports no peer and refuses upgrades. The stub is not
    // a real server (only `requestIP`/`upgrade` exist), which is exactly what
    // this method touches.
    const server = this.getBunServer() ?? FETCH_STUB_SERVER;
    let response: Response | undefined;
    try {
      const handled =
        this.handleNativeRequest ===
        BunHttpAdapter.prototype.handleNativeRequest
          ? this.serveNativeRequest(nativeRequest, server)
          : this.handleNativeRequest(nativeRequest, server);
      response =
        handled instanceof Promise
          ? await exchange.race(
              handled,
              (late) => {
                if (late !== undefined) {
                  exchange.discard(late);
                }
              },
              // Handled as `Bun.serve`'s `error` callback would, for nobody.
              (error) => {
                this.handleRequestError(error).catch(() => undefined);
              },
            )
          : handled;
    } catch (error) {
      if (exchange.callerGone) {
        throw error;
      }
      // The same final error handling `Bun.serve`'s `error` callback runs.
      return exchange.deliver(
        toFetchResponse(
          await this.handleRequestError(error),
          nativeRequest.method,
        ),
      );
    }

    // A served HEAD response carries no body: Bun drops it on the wire.
    return exchange.deliver(
      toFetchResponse(
        response ??
          new Response(null, {
            status: 101,
            statusText: "Switching Protocols",
          }),
        nativeRequest.method,
      ),
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
    const merged = mergeBunRequestOptions(opts);
    // Requests resolve `parseBody` lazily (only one with a body does), so a
    // misconfiguration is caught here instead of on the first such request.
    validateParseBodyOption(merged.parseBody);
    if (this.#rawBodyNeedsBuffer && merged.retainBuffer === undefined) {
      merged.retainBuffer = true;
    }
    if (this.#securityHookDefersBody && merged.deferBody === undefined) {
      merged.deferBody = true;
    }
    this.#requestOpts = merged;
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

    // On a unix socket Bun's `address` is the path, a string: see `address()`.
    if (isObject(address)) {
      return address;
    }

    return {
      address: hostname,
      family: "IPv4",
      port,
    };
  }

  /**
   * The listening address, as `net.Server.address()` gives it: the socket
   * path while listening on a unix socket, `{ address, family, port }`
   * otherwise. Nest's `app.listen()` and `app.getUrl()` read it.
   */
  address(): AddressInfo | string {
    if (this._listeningSocketPath !== undefined && this.isServerListening) {
      return this._listeningSocketPath;
    }
    return this.serverAddress;
  }

  get url() {
    // A unix socket's URL (`unix:///path`) has no origin; requests to it are
    // addressed to `localhost`, as Bun's `fetch(url, { unix })` sends them.
    if (this._listeningSocketPath !== undefined && this.isServerListening) {
      return "http://localhost";
    }
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
    // `rawBody` needs the bytes, which a JSON body read with
    // `request.json()` does not keep: keep them for every request.
    if (rawBody && !this.#rawBodyNeedsBuffer) {
      this.#rawBodyNeedsBuffer = true;
      this.requestOpts = this.#requestOpts;
    }

    const parse = async (req: BunRequest, next: NextFunction) => {
      const buffer = await req.handleBodyParsing(true, options, parser);
      // As body-parser's `verify` hook in Nest's ExpressAdapter: `rawBody` is
      // set only by a parser that read the body. A request this parser skipped
      // (another type) keeps what an earlier parser set.
      if (rawBody && buffer !== undefined) {
        set(req, "rawBody", buffer);
      }
      next();
    };
    // A request with no body is passed on synchronously, before its type,
    // encoding or size is looked at, as body-parser's `read()` does — so the
    // pipeline never waits on a promise for it, and `rawBody` stays unset.
    const middlewareHandler: RouterMiddlewareHandler = (req, _, next) => {
      if (!req.hasBody) {
        next();
        return;
      }
      return parse(req, next);
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
   * A string that is not a port number is a unix socket path, as with
   * `node:http`'s `listen(path)`: the server listens there (`hostname` is
   * ignored), {@link address} returns the path, and Nest's `app.getUrl()`
   * gives `http+unix://<encoded path>`. Bun removes the socket file when the
   * server stops; an existing file at the path is `EADDRINUSE`, as on Node.
   *
   * A bind failure (a busy port or socket path, say) or a port outside
   * 0–65535 rejects — unless an `error` listener is attached to the HTTP
   * server, as `app.listen()` attaches one. Then, as with
   * `@nestjs/platform-express` (whose `listen` hands off to `node:http`,
   * which reports a bind failure only through `error`), the listener receives
   * the error, the callback is not called, and this resolves `undefined`:
   * rejecting too would leave a rejection `app.listen()` never observes. So
   * `app.listen()` rejects with the error either way.
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

    // A string that is not a port number names a unix socket, as `node:http`
    // reads `listen(path)` (its `isPipeName`: `Number(port) >= 0` fails). A
    // hostname is then ignored, as there.
    const socketPath =
      isString(port) && !(Number(port) >= 0) ? port : undefined;

    // Anything `Bun.serve` accepts — an IP literal, `"localhost"`, a name —
    // is bound as given; only an absent hostname defaults to 127.0.0.1.
    const host = isString(hostname) && hostname ? hostname : "127.0.0.1";

    const portNumber = socketPath === undefined ? Number(port) : 0;
    if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
      // `node:http` throws this before binding, which `app.listen()` turns
      // into its rejection. Thrown from this async method, it would be a
      // rejection nobody observes, and `app.listen()` would never settle; so
      // it takes the bind-failure path below.
      return this.#reportListenError(
        new RangeError(
          `listen(): port must be an integer from 0 to 65535, got ${port}`,
        ),
      );
    }

    if (this._serverInstance && this.isServerListening) {
      // Port `0` asks for "any port", which the running server satisfies.
      const sameAddress =
        socketPath !== undefined
          ? this._listeningSocketPath === socketPath
          : this._listeningSocketPath === undefined &&
            this._listeningHost === host &&
            (portNumber === 0 ||
              Number(this._serverInstance.port) === portNumber);

      if (sameAddress) {
        await done(this._serverInstance);
        return this._serverInstance;
      }

      // A different address: move there.
      await this._serverInstance.stop(true);
      this._serverInstance = undefined;
      this._listeningSocketPath = undefined;
      this.isServerListening = false;
    }

    let httpServer: BunWebSocketServerType<customWebsocketDataType>;
    try {
      httpServer = Bun.serve<
        WebSocketClientData<customWebsocketDataType>,
        routesType
      >({
        ...(this.serverOptions || {}),
        // `Bun.serve` refuses a hostname beside `unix`. Typed as the TCP
        // shape: the `server` option's type is, and `unix` is the one key
        // this adds to it.
        ...((socketPath !== undefined
          ? { unix: socketPath }
          : { port: portNumber, hostname: host }) as {
          port: number;
          hostname: string;
        }),
        development: Bun.env.NODE_ENV !== "production",
        fetch: (nativeRequest: Request, server) => {
          // The synchronous path, unless a subclass replaced the handler.
          return this.handleNativeRequest ===
            BunHttpAdapter.prototype.handleNativeRequest
            ? this.serveNativeRequest(nativeRequest, server)
            : this.handleNativeRequest(nativeRequest, server);
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
        `Error while binding to ${socketPath ?? `${host}:${portNumber}`}`,
        error instanceof Error ? error.stack : String(error),
      );
      return this.#reportListenError(error);
    }

    this._serverInstance = httpServer;
    this._listeningSocketPath = socketPath;
    if (socketPath === undefined) {
      this._listeningHost = host;
      this._listeningPort = httpServer.port ?? portNumber;
    }
    await this.getListenAddress();

    this.isServerListening = true;
    // Listening again after a close: no longer shutting down.
    this.#isShuttingDown = false;
    this.eventEmitter.emit("listening", this._serverInstance);

    await done(this._serverInstance);

    return this._serverInstance;
  }

  /**
   * How {@link listen} reports a failure to listen: to the HTTP server's
   * `error` listeners when it has any, resolving `undefined` (`app.listen()`
   * attaches one and rejects with what it receives, as `node:http` reports a
   * bind failure only through `error`); otherwise as `listen()`'s rejection.
   */
  #reportListenError(error: unknown): undefined {
    if (this.eventEmitter.listenerCount("error") > 0) {
      this.eventEmitter.emit("error", error);
      return undefined;
    }
    throw error;
  }

  /**
   * The adapter's final error handling — the one implementation behind both
   * `Bun.serve`'s `error` callback and {@link fetch}, so a served request and
   * a socket-free one cannot be handled differently.
   *
   * Runs the {@link setErrorHandler} handlers as Express runs error
   * middleware: in registration order, as `(err, req, res, next)`, against
   * the response the request was answering when the error was raised, as
   * Express hands error middleware the same `res`: the status and headers
   * middleware or the handler set before the error (a security hook's
   * headers, CORS's) are still on it, and an exception filter sees it as they
   * left it. An error raised before there was one (while the request was
   * built) gets a fresh response. Only `next` moves on, and a return value is ignored:
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
   * app with no error middleware sends; see {@link finalErrorResponse}; it
   * too keeps the headers already set on the request's response. A
   * handler that throws is answered the same way, for the error it threw. It
   * therefore always resolves. Mirrors bun-common's `handleRequestError`.
   */
  protected async handleRequestError(error: unknown): Promise<Response> {
    const req = get(error, "req", undefined) as BunRequest | undefined;
    // `req` rides only on an object, and the response with it.
    const carried = req
      ? (Reflect.get(error as object, CARRIED_RESPONSE) as
          | BunResponse
          | undefined)
      : undefined;
    // One already sent is past answering on: its error handlers ran in the
    // pipeline. A fresh response then, as before one existed.
    const usable = carried && !carried.headersSent ? carried : undefined;
    if (!req || !this._errorHandlers.length) {
      return this.finalErrorResponse(error, req, usable);
    }

    let currentError: unknown = error;
    try {
      const response =
        usable ??
        new BunResponse(req, {
          etag: this.etagEnabled,
          views: this.views,
        });
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
            response,
          );
        }

        currentError = nextArg;
      }

      if (!response.headersSent) {
        // Every handler passed the error on.
        return this.finalErrorResponse(currentError, req, response);
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
   * The error is logged through Nest's {@link logger} as `(message, stack)`,
   * at `warn` for a 4xx and `error` otherwise, the message naming the method,
   * path and status,
   * except under `NODE_ENV=test`, as Express's default error logging does.
   *
   * With `res`, the response the request was answering, the page keeps the
   * headers already set on it, as `finalhandler` writes its page on the same
   * response: less `Content-Encoding`, `Content-Language`, `Content-Range`
   * (which finalhandler removes) and `Content-Length`, with the page's own
   * headers set over them.
   */
  protected finalErrorResponse(
    error: unknown,
    req?: BunRequest,
    res?: BunResponse,
  ): Response {
    const page = this.#finalErrorPage(error, req);
    return res ? withResponseHeaders(page, res.getHeaders()) : page;
  }

  /** bun-common's `finalErrorResponse` for `error`, logged; see {@link finalErrorResponse}. */
  #finalErrorPage(error: unknown, req: BunRequest | undefined): Response {
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
              const detail = err instanceof Error ? err.stack : String(err);
              // A client error (4xx) is the client's doing: a warning.
              if (status < 500) {
                this.logger.warn(`${message}${where}`, detail);
              } else {
                this.logger.error(`${message}${where}`, detail);
              }
            },
    });
  }

  public async getListenAddress(): Promise<URL> {
    const url = await waitUntil(
      () => this._serverInstance?.url,
      (url) => !!url,
    );

    return url;
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
      return this.#replyStreamableFile(response, body);
    }

    return response.send(body);
  }

  /**
   * Sends a `StreamableFile`, as `@nestjs/platform-express` does: its type,
   * disposition and length fill in whichever of those headers the handler did
   * not set, and a source that fails goes to the file's `errorHandler`
   * (`StreamableFile.setErrorHandler()`), with this response.
   *
   * The response is held back until the source yields its first chunk, as
   * Express writes the status line on the first chunk piped. So a source that
   * fails before that (a file that cannot be opened) is answered by the
   * handler, whose default answers `400` with the error's message; and one
   * that had already failed when the handler returned is handed to it at once,
   * without the file's headers (nestjs/nest 1933cc9ed, platform-express
   * 12.2.0). After the first chunk, a failure is still handed to the handler,
   * whose default ends the response, as Express's `res.end()` does.
   */
  #replyStreamableFile(
    response: BunResponse,
    file: StreamableFile,
  ): BunResponse | Promise<BunResponse | void> | void {
    const stream = file.getStream();
    const failed: unknown = stream.errored;
    if (failed) {
      return file.errorHandler(asError(failed), response);
    }
    // As @nestjs/platform-express: the file's type, disposition and length
    // fill in whichever of those headers the handler did not set itself.
    const { type, disposition, length } = file.getHeaders();
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

    const chunks = stream[Symbol.asyncIterator]() as AsyncIterator<unknown>;
    return chunks.next().then(
      (first) => response.send(streamFileFrom(first, chunks, file, response)),
      (error: unknown) => file.errorHandler(asError(error), response),
    );
  }

  public status(response: BunResponse, statusCode: number) {
    return response.status(statusCode);
  }

  public end(response: BunResponse, message?: string) {
    return response.headersSent ? undefined : response.send(message);
  }

  /**
   * Renders the view `view` with `options` as its locals and sends it — what
   * `@Render()` calls, and what `@nestjs/platform-express` does:
   * `res.render(view, options)`, through this adapter's {@link views} (see
   * {@link setBaseViewsDir} and {@link setViewEngine}). The status is the
   * route's (`@HttpCode()`); a `status` local is only a local.
   *
   * A view that cannot be found, or a template that throws, goes to the
   * error handling, as Express's `next(err)`; with no view engine set and no
   * extension on `view`, it throws `No default engine was specified and no
   * extension was provided.`
   */
  public render(
    response: BunResponse,
    view: string,
    options?: RenderOptions | null,
  ) {
    return response.render(view, options ?? undefined);
  }

  /**
   * Redirects to `url` with `statusCode` (`302` when it is `0`) — what
   * `@Redirect()` calls, and what `@nestjs/platform-express` does:
   * `res.redirect(statusCode, url)`. `Location` is URL-encoded and the body
   * is Express's short "Redirecting to" text or HTML, chosen by `Accept`
   * (see `BunResponse.redirect`).
   */
  public redirect(response: BunResponse, statusCode: number, url: string) {
    return response.redirect(statusCode || 302, url);
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
   * Maps an error raised outside a route's own exception zone (a body the
   * adapter refused, a path parameter that cannot be decoded, a middleware's
   * `next(err)`) before Nest's exception filters see it, as
   * `@nestjs/platform-express` does: a `SyntaxError` (unparsable JSON) or a
   * `URIError` (bad percent-encoding) becomes a `BadRequestException` with
   * its message; anything else is returned as it is.
   *
   * Nest 12 calls it from the exception layer it registers through
   * {@link setErrorHandler} (nestjs/nest #15075 moved the mapping out of the
   * core into each adapter). Nest 11 never calls it: its core maps the same
   * two errors itself. Declared without `override`, since Nest 11's
   * `AbstractHttpAdapter` has no such member.
   */
  public mapException(error: unknown): unknown {
    if (error instanceof SyntaxError || error instanceof URIError) {
      return new BadRequestException(error.message);
    }
    return error;
  }

  /**
   * `true`: routes match in registration order, as on Express. Nest 12's
   * core reads it (`HttpServer.isRouteOrderSensitive`) to decide whether the
   * `specificity` route-resolution strategy must sort routes before
   * registering them; `false` would also tell it this router rejects
   * duplicate routes itself, which it does not. Nest 11 never calls it.
   */
  public isRouteOrderSensitive(): boolean {
    return true;
  }

  /**
   * Installs the request hook behind Nest 12's `app.enableCsrfProtection()`
   * and `app.useSecurityHeaders()`, as `AbstractHttpAdapter`'s default does
   * for Express: a middleware at this point of the chain (so before Nest's
   * body parsers and middleware, which `app.init()` registers later) that
   * calls `hook(req, res)` and hands an error it returns to `next(err)`, the
   * exception layer. That layer answers on the same response, so a `403`
   * carries the headers the hook set (see {@link handleRequestError}).
   *
   * One difference from that default, so the hook runs before the body is
   * read, as on Express (where the body is read by a body-parser middleware
   * registered after it): from here on the request options defer the body
   * (`deferBody: true`), unless they set `deferBody` themselves. A rejected
   * request is then refused before its body is read, so a malformed or
   * oversized body gets the `403`, not a `400` or `413`; an accepted one is
   * read by the first body parser, or just before its route handler, as
   * before. An application with neither feature keeps reading bodies while
   * the request is built.
   *
   * Declared without `override`, since Nest 11's `AbstractHttpAdapter` has
   * no such member (Nest 11 has neither feature, and never calls it). The
   * hook's type is Nest 12's `SecurityRequestHook`, written structurally.
   */
  public registerSecurityHook(
    /** Nest's hook: sets the security headers, returns the error that rejects the request. */
    hook: (
      request: BunRequest,
      response: {
        setHeader: (name: string, value: string) => unknown;
        removeHeader: (name: string) => unknown;
      },
    ) => Error | undefined,
  ): this {
    if (!this.#securityHookDefersBody) {
      this.#securityHookDefersBody = true;
      this.requestOpts = this.#requestOpts;
    }
    return this.use((req, res, next) => {
      const error = hook(req, res);
      if (error) {
        next(error);
      } else {
        next();
      }
    });
  }

  // `prefix` is accepted for `AbstractHttpAdapter` signature parity; these
  // handlers are applied globally as a final fallback (see `listen`), which
  // is what Express 12's prefix mount plus its root mount amount to.
  public setErrorHandler(
    handler: RouterErrorMiddlewareHandler,
    _prefix?: string,
  ) {
    this._errorHandlers.push(handler);
  }

  /**
   * Registers Nest's not-found handler, which answers a request no route
   * took (it throws `NotFoundException` into the exception filters).
   *
   * On Nest 11 it is global, whatever `prefix` says, as on
   * `@nestjs/platform-express` 11. From Nest 12 it is scoped as
   * platform-express 12 scopes it (nestjs/nest #16372, #17648, #17923): with
   * a global `prefix`, it answers only at or under the prefix, and on each of
   * `excludedRoutes`' paths for every method (so `POST /health` beside
   * `GET /health` is Nest's 404); without one, it answers everywhere outside
   * other applications' prefixes (several applications on one adapter). A
   * request no handler covers gets `finalhandler`'s HTML
   * `Cannot GET /path` 404, as on Express.
   */
  public setNotFoundHandler(
    handler: RouterMiddlewareHandler,
    prefix?: string,
    /**
     * The routes excluded from `prefix`, at the paths they are served at
     * (`/v1/health` under URI versioning). Nest passes them from 12.1.3;
     * structurally Nest's `RouteInfo`.
     */
    excludedRoutes?: {
      /** The path the excluded route is served at, without the prefix. */
      path: string;
      /** Its method; the handler is mounted there for every method regardless. */
      method?: RequestMethod;
    }[],
  ) {
    const scoped = this.#scopeNotFoundToPrefix
      ? normalizePrefix(prefix)
      : undefined;
    this._notFoundHandlers.push({
      handler,
      prefix: scoped,
      matcher: scoped === undefined ? undefined : prefixMatcher(scoped),
    });
    // The per-miss work, decided here once (see `#respond`).
    this.#unscopedNotFoundHandlers = this._notFoundHandlers.every(
      (entry) => entry.prefix === undefined,
    )
      ? this._notFoundHandlers.map((entry) => entry.handler)
      : undefined;
    this.#scopedNotFoundSets.clear();
    if (!scoped) {
      return;
    }
    // As Express 12: mounted on each excluded path, for every method, after
    // the application's routes, so it answers only a miss there.
    for (const route of excludedRoutes ?? []) {
      const path = route.path.startsWith("/") ? route.path : `/${route.path}`;
      this.instance.all(path, handler);
    }
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

    // The mount itself too, as Express's `app.use(prefix, static)`: `/static`
    // is the directory without its slash, redirected (301) to `/static/`.
    if (prefix) {
      this.instance.get(prefix, handler);
    }
    return this.instance.get(`${prefix}/*`, handler);
  }

  /**
   * Converts and checks a route path before Nest registers it, as
   * `@nestjs/platform-express`'s `normalizePath` does: a legacy path (`/*`,
   * `/(.*)`, a mid-path `*`) is converted to path-to-regexp 8 syntax by
   * Nest's `LegacyRouteConverter`, which warns, and the result must be a path
   * Express accepts. Anything else (`:id?`, `:id(\d+)`, an unclosed `{`)
   * throws path-to-regexp's `TypeError` at boot, with the converter's error
   * logged, exactly as on Express. The router itself still takes routejs
   * paths registered on it directly (`adapter.get("/a/:b?", …)`).
   *
   * @throws PathSyntaxError (a `TypeError`) for a path Express rejects.
   */
  public override normalizePath(path: string): string {
    try {
      const converted = LegacyRouteConverter.tryConvert(path);
      assertExpressPath(converted);
      return converted;
    } catch (error) {
      if (error instanceof TypeError) {
        LegacyRouteConverter.printError(path);
      }
      throw error;
    }
  }

  /**
   * The request's host name without its port — Express's `req.hostname`,
   * which `@nestjs/platform-express` returns and Nest matches
   * `@Controller({ host })` against: the `Host` header as sent (its case
   * kept), the port stripped (an IPv6 literal keeps its brackets,
   * `[::1]:3000` is `[::1]`). `X-Forwarded-Host` is not read, as Express
   * reads it only with `trust proxy` set. Without a `Host` header, the
   * request URL's host name.
   */
  public getRequestHostname(request: BunRequest): string {
    const host = request.headersObj.get("host");
    if (!host) {
      return request.hostname || "127.0.0.1";
    }
    const offset = host.startsWith("[") ? host.indexOf("]") + 1 : 0;
    const colon = host.indexOf(":", offset);
    return colon === -1 ? host : host.slice(0, colon);
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

  /**
   * Puts the adapter into its "shutting down" state, as
   * `@nestjs/platform-express` 12 does: from now on, with the
   * `return503OnClosing` application option, every request is answered `503
   * Service Unavailable` with `Connection: close`. Nest 12's `app.close()`
   * calls it before any shutdown hook runs, while the server still accepts
   * requests; Nest 11 never calls it ({@link close} sets the same state).
   * Declared without `override`: Nest 11's `AbstractHttpAdapter` has no such
   * member.
   */
  public beforeClose(): void {
    this.#isShuttingDown = true;
  }

  /**
   * Stops the server, as `@nestjs/platform-express` 12 does: it stops
   * accepting connections and lets the requests in flight finish, then
   * resolves. Unlike Express, which waits for them indefinitely (an open
   * `@Sse()` stream holds `app.close()` forever), the wait is capped by the
   * constructor's `closeDrainTimeout` option (10 s by default; `0` waits for
   * nothing); whatever is still open then — a stream, a hung handler — is
   * cut. With the `forceCloseConnections` application option nothing waits:
   * in-flight requests are cut at once.
   *
   * WebSocket connections are not waited for; they are closed when the
   * server stops. Nothing of the stopped server outlives the returned
   * promise, so a server bound on the same port next can never be answered
   * by this one (the port-release rule in CLAUDE.md).
   */
  public async close() {
    this.#isShuttingDown = true;
    try {
      if (this._serverInstance && this.isServerListening) {
        await this.#stopServer(this._serverInstance);
      }
    } catch (err) {
      this.logger.error(
        "An error occurred while closing bun http adapter ====> ",
        err,
      );
    }
    this.eventEmitter.emit("close");
    this._serverInstance = undefined;
    this._listeningSocketPath = undefined;
    this.isServerListening = false;
    // Error and not-found handlers are configuration, like routes: they stay,
    // so a closed adapter that listens again (or is driven through `fetch()`)
    // behaves exactly as before.
  }

  /**
   * {@link close}'s stop: drain, then force. `stop(false)` stops accepting:
   * Bun closes the listener and every idle keep-alive connection at once, and
   * each busy connection as soon as its response completes (measured on Bun
   * 1.4.2 to 1.4.4). The wait is on `pendingRequests`, not on that call's
   * promise, which also waits for every WebSocket. `stop(true)` then always
   * runs: a graceful stop alone leaves a long-lived response (an SSE stream)
   * and WebSockets served by this server after `close()` resolves, even
   * once another server is bound on the same port (measured, PR-6b's spike).
   */
  async #stopServer(
    server: BunWebSocketServerType<customWebsocketDataType>,
  ): Promise<void> {
    if (
      !this.#forceCloseConnections &&
      this.#closeDrainTimeout > 0 &&
      server.pendingRequests > 0
    ) {
      server.stop(false).catch(() => undefined);
      const deadline = Date.now() + this.#closeDrainTimeout;
      while (server.pendingRequests > 0 && Date.now() < deadline) {
        await Bun.sleep(10);
      }
    }
    await server.stop(true);
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

  /**
   * Called by Nest once, synchronously, as the application is constructed.
   * Of `options` it honours, as `@nestjs/platform-express` does,
   * `forceCloseConnections` (see {@link close}) and `return503OnClosing`
   * (see {@link beforeClose}); the Bun server itself is configured through
   * the constructor's `server` option and {@link setListenOptions}.
   */
  public async initHttpServer(options?: NestApplicationOptions) {
    // Before the first `await`: Nest does not await this, and the 503 guard
    // must be registered ahead of every route, as Express's is.
    this.#applyApplicationOptions(options);
    await this.init();
    return this.httpServer;
  }

  /**
   * Applies {@link initHttpServer}'s lifecycle options. `return503OnClosing`
   * is read by name: Nest 11's `NestApplicationOptions` has no such key.
   */
  #applyApplicationOptions(options: NestApplicationOptions | undefined): void {
    if (options?.forceCloseConnections) {
      this.#forceCloseConnections = true;
    }
    const return503OnClosing =
      Reflect.get(options ?? {}, "return503OnClosing") === true;
    if (return503OnClosing && !this.#closingGuardRegistered) {
      this.#closingGuardRegistered = true;
      // A middleware only when asked for, as Express registers it: the
      // default request path carries no shutdown check at all.
      this.instance.use((_req, res, next) => {
        if (this.#isShuttingDown) {
          // Express's answer, its `text/html` included (a string body is
          // `text/plain` here otherwise).
          res.set("Connection", "close");
          res.set("Content-Type", "text/html; charset=utf-8");
          res.status(503).send("Service Unavailable");
          return;
        }
        next();
      });
    }
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
      | "options"
      | "query",
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

  // HTTP `QUERY` (RFC 10008): NestJS's `@QueryMethod()` (11.2.0, 12) calls
  // it. No `override`: Nest 11.1's `AbstractHttpAdapter` has no `query`.
  // Its body is parsed as any other method's.
  /* --- BEGIN generated typed overloads: query --- */
  // Generated by scripts/generate-verb-overloads.ts — do not edit by hand.
  query<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  query<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  query<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  query<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  query<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  query<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  query<TPath extends string, TShape = EmptyShape>(
    path: TPath,
    handler1: RouterHandler,
    handler2: RouterHandler,
    handler3: RouterHandler,
    handler4: RouterHandler,
    handler5: RouterHandler,
    validator: ValidatorMiddleware<TShape>,
    handler: MountedHandler<"", EmptyShape, TPath, TShape>,
  ): this;
  query<TPath extends string, TShape = EmptyShape>(
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
  query<TPath extends string, TShape = EmptyShape>(
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
  query<TPath extends string, TShape = EmptyShape>(
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
  /* --- END generated typed overloads: query --- */
  query(path: string, ...callbacks: RouterHandler[]): this;
  query(...callbacks: RouterHandler[]): this;
  query(p?: string | RouterHandler, ...c: RouterHandler[]): this {
    return this.registerVerb("query", p, c);
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

  /**
   * Sets the extension a view name without one is rendered with (`"ejs"`,
   * `"hbs"`, …) — Express's `view engine` setting, which
   * `app.setViewEngine()` sets on `@nestjs/platform-express`. Unless an engine
   * was registered for it with {@link engine}, the module of that name is
   * loaded on first render and its `__express` export used, as in Express.
   */
  public setViewEngine(engine: string) {
    this.views.set("view engine", engine);
    return this;
  }

  /**
   * Sets the directory, or directories in lookup order, views are found in —
   * Express's `views` setting, which `app.setBaseViewsDir()` sets. Defaults to
   * `views` under the working directory.
   */
  public setBaseViewsDir(path: string | string[]) {
    this.views.set("views", path);
    return this;
  }

  /**
   * Registers `fn` as the template engine for `ext`, as Express's
   * `app.engine(ext, fn)` (`app.engine()` on a Nest app).
   */
  public engine(ext: string, fn: ViewEngine) {
    this.views.engine(ext, fn);
    return this;
  }

  /**
   * Sets an application-wide view local — Express's `app.locals[key] =
   * value`, which `app.setLocal()` does on `@nestjs/platform-express`.
   */
  public setLocal(key: string, value: unknown) {
    this.views.locals[key] = value;
    return this;
  }

  /**
   * Sets an Express application setting (`app.set()` on a Nest app). The
   * view settings apply: `views`, `view engine`, `view cache` and
   * `view options`. Turning `x-powered-by` off is accepted silently, since
   * this adapter never sends that header (Nest 12's `useSecurityHeaders()`
   * calls `disable("x-powered-by")`). Any other setting, or `x-powered-by`
   * on, is accepted and has no effect on this adapter, which logs a warning
   * naming it once.
   */
  public set(setting: string, value: unknown) {
    if (setting === "x-powered-by" && !value) {
      return this;
    }
    // `BunViews.set` holds the view settings, shared with bun-common's
    // adapter so the two cannot drift.
    if (
      !this.views.set(setting, value) &&
      !this.#ignoredSettings.has(setting)
    ) {
      this.#ignoredSettings.add(setting);
      this.logger.warn(
        `app.set("${setting}") has no effect on BunHttpAdapter: only the view settings (${BunViews.SETTINGS.map((name) => `"${name}"`).join(", ")}) apply`,
      );
    }
    return this;
  }

  /** `set(setting, true)`, as Express's `app.enable()`. */
  public enable(setting: string) {
    return this.set(setting, true);
  }

  /** `set(setting, false)`, as Express's `app.disable()`. */
  public disable(setting: string) {
    return this.set(setting, false);
  }

  /** Settings {@link set} was given and ignores, each warned about once. */
  #ignoredSettings = new Set<string>();

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

    // `RequestMethod.QUERY` exists from Nest 11.2.0, so it is read from the
    // enum at run time (Nest 11.1's types, and its enum, lack it).
    if (requestMethod === queryRequestMethod()) {
      return "query";
    }

    throw new InternalServerErrorException(
      `An invalid request method was encountered with value ${requestMethod}`,
    );
  }

  public createMiddlewareFactory(
    requestMethod: RequestMethod,
  ): MiddlewareFactoryRespType<this> {
    return (path, callback) => {
      // As `@nestjs/platform-express` does: the core's exact-match marker
      // (`$`) stripped, a legacy path converted (and warned about), and the
      // result checked as Express checks a path it registers — a path it
      // cannot convert fails at boot, with the converter's error logged.
      const exact = path.endsWith("$");
      let converted: string;
      try {
        converted = LegacyRouteConverter.tryConvert(
          exact ? path.slice(0, -1) : path,
        );
        assertExpressPath(converted, { loosen: true });
      } catch (error) {
        if (error instanceof TypeError) {
          LegacyRouteConverter.printError(path);
        }
        throw error;
      }
      // NestJS middleware must behave like middleware — not a route handler.
      // `useMethod` registers it method-scoped but with `isEndpoint` false,
      // so it keeps registration order and is excluded from route
      // specificity ordering. `RequestMethod.ALL` maps to method-agnostic.
      const method = this.getRequestMethodStr(requestMethod);
      // NestJS's `Function` is its `(req, res, next)` middleware.
      const middleware = callback as RouterHandler;
      if (exact) {
        this.useExactMiddleware(method, converted, middleware);
        return this;
      }
      this.instance.useMethod(method, converted, middleware);
      return this;
    };
  }

  /**
   * Registers `middleware` for `path` exactly (not as a prefix), for one
   * method or every one (`"all"`), still as middleware rather than a route
   * handler, so a request it alone matches remains a miss.
   *
   * For the core's exact-match marker: for a wildcard `forRoutes('*')` under
   * a global prefix it registers `/<prefix>$` beside `/<prefix>/{*path}`,
   * the `$` meaning "exactly this path". As `@nestjs/platform-express` 12.1.3
   * (nestjs/nest #17942), the `$` is stripped and a request ending in `/` is
   * skipped, since the wildcard entry beside it already matches `/api/` and
   * the middleware must not run twice.
   */
  private useExactMiddleware(
    method: string,
    path: string,
    middleware: RouterHandler,
  ): void {
    const normalized = method.toUpperCase();
    const handler: RouterHandler = (req, res, next) =>
      req.path.endsWith("/") ? next() : middleware(req, res, next);
    // `setRoute` with a `path` compiles an exact match; it is not an endpoint
    // (`useMethod` and `use` register through it the same way, with `group`).
    this.instance.setRoute({
      method: normalized === "ALL" ? undefined : normalized,
      path,
      callbacks: [handler],
    });
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
      return next() as Function;
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
