import type { Server as BunServerType, Serve as BunServeType } from "bun";
import type { BusboyConfig, FieldInfo, FileInfo } from "busboy";
import type { FileTypeResult } from "file-type";
import type { Buffer } from "node:buffer";
import type { Stats } from "node:fs";
import type { IncomingMessage } from "node:http";
import type {
  BunRequest,
  MultiPartParseResult,
  RawMultiPartFields,
} from "../BunRequest";
import type { BunResponse } from "../BunResponse";
import type { matchedRoute } from "../BunRouter";
import type {
  CompressionEncoding,
  CompressionEncodingsOption,
  CompressionOptions,
} from "../compression";
import type {
  StorageExpandedFile,
  StorageFile,
  UploadFilterFile,
} from "../multipart";
import type {
  CompressionDictionaries,
  ContentEncodingAllowlist,
  JsonValue,
} from "../utils/native";

export type MultiPartOptions = BusboyConfig & {
  /**
   * Whether field values are inflated: a value that parses as JSON (or as a
   * urlencoded string) is replaced by the parsed value. Defaults to `true`;
   * `inflate: false` keeps every field value as the raw string.
   */
  inflate?: boolean;
  /**
   * Custom inflation for a field value. The result is client-supplied data,
   * parsed but not validated — hence `unknown` values.
   */
  fieldInflator?: (
    fieldname: string,
    value: string,
    opts?: FieldInfo,
  ) => Promise<Record<string, unknown>>;
  /**
   * Custom inflation for an uploaded file's bytes. As with `fieldInflator`, the
   * result is unvalidated client data.
   */
  fileInflator?: (
    fieldname: string,
    file: Buffer,
    opts?: FileInfo,
  ) => Promise<Record<string, unknown>>;
  /**
   * Decides whether a part is a file (`true`) or a field, given its field
   * name, content type and file name. busboy honours it, but `@types/busboy`
   * does not declare it. Defaults to busboy's rule: a part with a `filename`
   * is a file.
   */
  isPartAFile?: (
    fieldName: string | undefined,
    contentType: string | undefined,
    fileName: string | undefined,
  ) => boolean;
};

/**
 * The body shape a request carries when nothing narrower is known — the union
 * the body parsers can produce. Used as the default for the `TBody` type
 * parameter so untyped code keeps its current behaviour.
 *
 * The `unknown` members are deliberate: a parsed JSON or urlencoded body is
 * client input that nothing has validated yet. A `BunValidate` middleware
 * narrows it.
 */
export type DefaultRequestBody =
  | string
  | Record<string, unknown>
  | ArrayBufferView
  | unknown[]
  | null
  | undefined;

export interface BunRequestInterface<
  TParams = Record<string, string>,
  TQuery = Record<string, unknown>,
  TBody = DefaultRequestBody,
> {
  parsedUrl: InstanceType<typeof URL>;
  headersObj: InstanceType<typeof Headers>;
  getHeader: (name: string) => string | null;
  getHeaderNames: () => string[];
  getHeaders: () => Record<string, string[] | string>;
  getRawHeaderNames: () => string[];
  hasHeader: (name: string) => boolean;
  maxHeadersCount: number;
  path: string;
  method: string;
  host: string;
  protocol: string;
  removeHeader: (name: string) => void; // Removed header value
  reusedSocket: boolean;
  setHeader: (
    name: string,
    value: string | string[],
    replace?: boolean,
  ) => void;
  body: TBody;
  buffer: Buffer | undefined;
  /**
   * The exact body bytes, kept by a parser middleware registered with
   * `rawBody: true`; `undefined` when no such parser read a body.
   */
  rawBody?: Buffer;
  secret?: string | string[];
  /**
   * The path the router handling this request was mounted at, as Express's
   * `req.baseUrl` — the part of the URL the mount matched (`"/users/42"` for a
   * router mounted at `/users/:id`). `""` outside any mount.
   */
  baseUrl: string;
  /** Parsed cookies. A `j:`-prefixed value is JSON-decoded, as cookie-parser does. */
  cookies: Record<string, JsonValue>;
  /** Cookies whose signature verified against `secret`, decoded like `cookies`. */
  signedCookies: Record<string, JsonValue>;
  hostname: string;
  ip: string;
  ips: string[];
  originalUrl: string;
  headers: Record<string, string | string[]>;
  headersDistinct: Record<string, string[]>;
  httpVersion: "1.1" | "1.0";
  httpVersionMajor: string;
  httpVersionMinor: string;
  rawHeaders: string[];
  url: string;
  params: TParams;
  query: TQuery;
  /**
   * The route currently handling the request, as Express's `req.route`: set by
   * the router on entering each matched route handler (verb, `all`, `any`),
   * to that route's match — its `path`, `method`, `host`, `callbacks`, and the
   * `params`/`subdomains` captured for this request. `undefined` in middleware
   * that runs before any route handler.
   */
  route: matchedRoute | null | undefined;
  secure: boolean;
  subdomains: string[];
  xhr: boolean;
  get: (
    name: string,
    defaultVal: string | string[] | undefined,
  ) => string | string[] | null;
  storageFiles:
    | UploadFilterFile[]
    | Record<string, StorageFile[]>
    | StorageExpandedFile<StorageFile>;
  storageFile: UploadFilterFile | StorageExpandedFile<StorageFile> | undefined;
  /**
   * Parses the multipart body, as {@link BunRequest.getMultiParts}: with
   * `inflate: false` the fields are the raw strings ({@link RawMultiPartFields}),
   * otherwise whatever the field inflator produced.
   */
  getMultiParts: {
    (
      options: MultiPartOptions & { inflate: false },
    ): Promise<MultiPartParseResult<RawMultiPartFields>>;
    (options: MultiPartOptions): Promise<MultiPartParseResult>;
  };
}

export type BunServeNormalOptions<
  customWebsocketDataType = unknown,
  routesType extends string = never,
> = Omit<
  BunServeType.FetchOrRoutes<customWebsocketDataType, routesType> &
    BunServeType.HostnamePortServeOptions<customWebsocketDataType>,
  "fetch" | "port" | "hostname"
>;

export type BunServeUnixNormalOptions<
  customWebsocketDataType = unknown,
  routesType extends string = never,
> = Omit<
  BunServeType.FetchOrRoutes<customWebsocketDataType, routesType> &
    BunServeType.UnixServeOptions<customWebsocketDataType>,
  "fetch"
>;

export type BunServeOptions<
  customWebsocketDataType = unknown,
  routesType extends string = never,
> =
  | BunServeNormalOptions<customWebsocketDataType, routesType>
  | BunServeUnixNormalOptions<customWebsocketDataType, routesType>;

export type BunServer<customWebsocketDataType = unknown> =
  BunServerType<customWebsocketDataType>;

export interface ServeStaticOptions {
  /**
   * Set how "dotfiles" are treated when encountered. A dotfile is a file or directory that begins with a dot (".").
   * Note this check is done on the path itself without checking if the path actually exists on the disk.
   * If root is specified, only the dotfiles above the root are checked (i.e. the root itself can be within a dotfile when when set to "deny").
   * The default value is 'ignore'.
   * 'allow' No special treatment for dotfiles
   * 'deny' Send a 403 for any request for a dotfile
   * 'ignore' Pretend like the dotfile does not exist: next() when fallthrough is true, otherwise a 404
   */
  dotfiles?: string;

  /**
   * Enable or disable etag generation, defaults to true.
   */
  etag?: boolean;

  /**
   * Set file extension fallbacks. When set, if a file is not found, the given extensions will be added to the file name and search for.
   * The first that exists will be served. Example: ['html', 'htm'].
   * The default value is false.
   */
  extensions?: string[];

  /**
   * Let client errors fall-through as unhandled requests, otherwise forward a client error.
   * The default value is false.
   */
  fallthrough?: boolean;

  /**
   * Enable or disable the immutable directive in the Cache-Control response header.
   * If enabled, the maxAge option should also be specified to enable caching. The immutable directive will prevent supported clients from making conditional requests during the life of the maxAge option to check if the file has changed.
   */
  immutable?: boolean;

  /**
   * By default this module will send "index.html" files in response to a request on a directory.
   * To disable this set false or to supply a new index pass a string or an array in preferred order.
   */
  index?: boolean | string | string[];

  /**
   * Enable or disable Last-Modified header, defaults to true. Uses the file system's last modified value.
   */
  lastModified?: boolean;

  /**
   * Provide a max-age in milliseconds for http caching, defaults to 0. This can also be a string accepted by the ms module.
   */
  maxAge?: number | string;

  /**
   * Redirect (301) to trailing "/" when the pathname is a dir, keeping the query string; when false a directory is treated as a miss. Defaults to true.
   */
  redirect?: boolean;

  /**
   * Function to set custom headers on response. Alterations to the headers need to occur synchronously.
   * The function is called as `fn(res, path, stat)`, where the arguments are:
   * `res` - the response object
   * `path` - the file path that is being sent
   * `stat` - the `fs.Stats` of the file that is being sent
   */
  setHeaders?: (res: BunResponse, path: string, stat: Stats) => void;

  /**
   * Creates a virtual path prefix
   */
  prefix?: string;

  /**
   * How long, in milliseconds, a resolved path (its size, mtime, content type
   * and ETag) stays memoised before the filesystem is consulted again.
   * Defaults to 1000. Set `0` to disable and stat on every request.
   *
   * Only metadata is cached, never file contents — the response still streams
   * the file from disk. A file replaced within the window may be served with
   * the previous length or validators for up to this long.
   */
  metadataCacheTtl?: number;

  /**
   * Maximum number of paths held in the metadata cache before the oldest is
   * evicted. Defaults to 1024. Keyed by resolved path, so its size is bounded
   * by the asset tree rather than by request volume.
   */
  metadataCacheMax?: number;

  /**
   * Serves a precompressed sibling of the requested file — `app.js.br`,
   * `app.js.gz` — when the client accepts its coding, as nginx's
   * `gzip_static`/`brotli_static` do. `true` enables the defaults of
   * {@link ServeStaticPrecompressedOptions}; `false` or unset (the default)
   * looks for none.
   *
   * The sibling is sent with `Content-Encoding`, the **original** file's
   * `Content-Type`, `Vary: Accept-Encoding`, and its own `Content-Length`,
   * `Last-Modified` and an `ETag` naming the coding, so conditional requests
   * and byte ranges apply to the encoded representation.
   *
   * A sibling is only served for a file that exists. nginx serves `app.js.gz`
   * for `/app.js` even when `app.js` is missing; here that would make the URL
   * exist for one client and 404 for another, so a missing original is a
   * miss whatever the client accepts. A sibling requested by its own name
   * (`/app.js.gz`) is an ordinary file, with no `Content-Encoding`.
   */
  precompressed?: boolean | ServeStaticPrecompressedOptions;

  /**
   * Compresses files on the fly with `compression()`'s rules — its
   * `threshold`, `filter` (compressible types only) and `encodings` — when no
   * precompressed sibling is served. `true` (the default) uses
   * `compression()`'s defaults, an object customises them, and `false` sends
   * every file as it is on disk. A range request is never compressed.
   */
  compression?: boolean | CompressionOptions;
}

/** Options for {@link ServeStaticOptions.precompressed}. */
export interface ServeStaticPrecompressedOptions {
  /** Whether siblings are looked for. Defaults to `true`. */
  enabled?: boolean;
  /**
   * The sibling extensions of each coding, tried in order; a leading dot is
   * optional. Merged over the defaults `br: [".br"]`, `zstd: [".zst"]` and
   * `gzip: [".gz"]` (none for `deflate`); an empty list turns a coding off.
   */
  extensions?: Partial<Record<CompressionEncoding, string | readonly string[]>>;
  /**
   * The server's preference between the codings that have extensions, which
   * breaks ties between equal q-values in `Accept-Encoding`. `"*"` entries
   * stand for the codings not listed, in `br`, `zstd`, `gzip`, `deflate`
   * order. Defaults to `"*"`.
   */
  encodings?: CompressionEncodingsOption;
  /**
   * What to send when the client accepts none of the precompressed codings,
   * or no sibling exists: `"compress"` compresses the original on the fly
   * (unless `compression` is `false`), `"identity"` sends it as it is.
   * Defaults to `"compress"`.
   */
  fallback?: "compress" | "identity";
}

export interface SendFileOptions {
  /**
   * `Cache-Control` max-age: milliseconds as a number, or an `ms`-style
   * duration string (`"2h"`, `"1d"`). Defaults to `0`; clamped to one year.
   */
  maxAge?: string | number;
  /** Directory a relative path is resolved against. */
  root?: string;
  /** Send `Last-Modified` from the file's mtime. Defaults to `true`. */
  lastModified?: boolean;
  /**
   * How a path segment starting with a dot is treated: `"ignore"` (default)
   * answers 404, `"deny"` answers 403, `"allow"` serves it.
   */
  dotfiles?: "allow" | "deny" | "ignore";
  /** Honour `Range` requests and send `Accept-Ranges: bytes`. Defaults to `true`. */
  acceptRanges?: boolean;
  /** @deprecated Misspelling of {@link acceptRanges}; still honoured. */
  accepRanges?: boolean;
  /** Send a `Cache-Control` header. Defaults to `true`. */
  cacheControl?: boolean;
  /** Add `immutable` to `Cache-Control` (with a non-zero `maxAge`). */
  immutable?: boolean;
  /** Extra response headers; each value is sent as its string form. */
  headers?: Record<string, string | number | readonly string[]>;
}

/**
 * Advances the pipeline. `next()` continues; `next(err)` enters error mode;
 * `next("route")` skips the rest of the current route; `next("router")` leaves
 * the current router.
 *
 * `R` defaults to `unknown` on purpose: the pipeline ignores what `next`
 * returns, so callers can neither rely on nor be constrained by it.
 */
export type NextFunction<R = unknown> = (
  type?: string | Error | undefined,
) => R | Promise<R>;

/** A request-only handler — e.g. `(req) => res.json(...)` shorthands. */
export type RouterRequestOnlyHandler<R = unknown> = (
  req: BunRequest,
) => R | Promise<R>;

/** A request/response handler that doesn't need `next`. */
export type RouterRequestResponseHandler<R = unknown> = (
  req: BunRequest,
  res: BunResponse,
) => R | Promise<R>;

export type RouterMiddlewareHandler<R = unknown> = (
  req: BunRequest,
  res: BunResponse,
  next: NextFunction,
) => R | Promise<R>;

/**
 * An Express-style error handler, told apart by its four parameters.
 *
 * `error` is `unknown` because anything can be thrown or passed to `next()`;
 * narrow it (`error instanceof HttpError`) before reading it.
 */
export type RouterErrorMiddlewareHandler<R = unknown> = (
  error: unknown,
  req: BunRequest,
  res: BunResponse,
  next: NextFunction,
) => R | Promise<R>;

export type RouterHandler<R = unknown> = RouterMiddlewareHandler<R>;

/**
 * A route handler whose request is narrowed to a specific route's shapes.
 *
 * `TParams` comes from the registered path literal (see `ExtractRouteParams`)
 * unless a validator in the same chain declares its own; `TQuery` and `TBody`
 * come from a validator, or from explicit type arguments on the verb method.
 * Existing untyped handlers keep working — the defaults are exactly the types
 * `RouterHandler` has always used.
 */
export type TypedRouteHandler<
  TParams = Record<string, string>,
  TQuery = Record<string, unknown>,
  TBody = DefaultRequestBody,
  R = unknown,
> = (
  req: BunRequest<TParams, TQuery, TBody>,
  res: BunResponse,
  next: NextFunction,
) => R | Promise<R>;

/**
 * Any callback registrable on a route. The router accepts handlers of every
 * arity it has to dispatch — 1-arg (`req` only), 2-arg (`req`, `res`), the
 * regular 3-arg `(req, res, next)` middleware/route handler, and the 4-arg
 * `(err, req, res, next)` Express-style error handler. Listing each arity as
 * an explicit member of the union lets TypeScript pick the right contextual
 * signature for an untyped arrow at the call site.
 */
// Every handler's `R` defaults to `unknown` on purpose: the pipeline ignores a
// handler's return value, so a handler may return `res.send(...)`, a promise,
// or nothing. `void` would reject `async (req, res) => res.json(x)`.
export type RouterCallback<R = unknown> =
  | RouterRequestOnlyHandler<R>
  | RouterRequestResponseHandler<R>
  | RouterHandler<R>
  | RouterErrorMiddlewareHandler<R>;

/**
 * How a compressed request body (`Content-Encoding`) is decoded. Shared by
 * {@link BodyParserOptions} (a body parsed from middleware) and the object
 * form of the request's `parseBody` option (`ParseBodyConfig`, a body parsed
 * while the request is built), so both configure it the same way.
 *
 * A body may use `gzip` (or `x-gzip`), `deflate`, `br`, `zstd`, and `dcb`/`dcz`
 * given `compressionDictionaries` — and may stack them (`gzip, br`, decoded
 * last to first, RFC 9110 §8.4). `zstd`, `dcb`/`dcz` and stacking go beyond
 * body-parser, which accepts exactly one of `gzip`/`deflate`/`br`. A coding
 * that is unsupported or not allowed, in any layer, is a 415; data a layer
 * cannot decode (or a dictionary not provided) is a 400; a layer decoding past
 * the body limit is a 413.
 */
export interface BodyDecodingOptions {
  /**
   * When `true` (the default, as body-parser), a compressed body is decoded
   * before it is parsed; when `false`, a `Content-Encoding` listing any coding
   * but `identity` is refused with a 415 error — the same as `encodings: []`.
   * A request with no body is never refused.
   */
  inflate?: boolean | undefined;

  /**
   * Worst-case memory, in bytes, one compressed layer may use when decoded by Bun's faster (uncapped) gunzip, inflate
   * or zstd decoder. A `gzip`/`deflate` layer's worst case is its compressed size × 1032; a `zstd` layer's is the size
   * its frames declare, or else 128 KiB per compressed block. Layers whose worst case exceeds it are decoded by
   * `node:zlib`, stopped at the body limit. `br`, `dcb` and `dcz` always are. `0` disables the fast path; `Infinity`
   * always uses it. Default 32 MiB (`DEFAULT_DECOMPRESS_FAST_PATH_LIMIT`). Anything but a non-negative number is a
   * `RangeError`.
   */
  decompressionFastPathLimit?: number | undefined;

  /**
   * Which codings a body may use. `"*"` (the default) admits every coding this library decodes — `gzip`/`x-gzip`,
   * `deflate`, `br`, `zstd`, and `dcb`/`dcz` when `compressionDictionaries` is set. A list (`["gzip", "br"]`) admits
   * only its members, unless it also holds `"*"`; `"gzip"` admits `x-gzip`, and `identity` is always admitted, so `[]`
   * behaves like `inflate: false`. A body using any other coding, in any layer of a stacked list, is refused with 415.
   * A `*` sent *in* `Content-Encoding` is not a wildcard — RFC 9110 defines `*` only for `Accept-Encoding` — but an
   * unknown coding, so also a 415. A list entry that is not a coding this library decodes is a `RangeError`.
   */
  encodings?: ContentEncodingAllowlist | undefined;

  /**
   * The most codings one `Content-Encoding` may stack; `identity` and empty list elements do not count. A body stacking
   * more is refused with 415 before anything is decoded, which stops a many-layered decompression bomb. Default 5
   * (`DEFAULT_MAX_CONTENT_CODINGS`), the limit undici's `fetch` and curl put on responses (curl since CVE-2022-32206).
   * `0` admits `identity` only. Anything but a non-negative number is a `RangeError`.
   */
  maxContentCodings?: number | undefined;

  /**
   * Dictionaries for `dcb`/`dcz` bodies (Dictionary-Compressed Brotli/Zstandard, RFC 9842): the dictionaries
   * themselves, indexed by SHA-256 on first use, or a resolver `(hash, encoding) => Uint8Array | undefined` whose answer
   * is hashed and must match. Without it, `dcb`/`dcz` bodies are refused with 415; with it, a body whose header names a
   * dictionary not provided is a 400. Browsers do not send dictionary-compressed request bodies: this is for clients
   * that share a dictionary with the server by arrangement.
   */
  compressionDictionaries?: CompressionDictionaries | undefined;
}

export interface BodyParserOptions extends BodyDecodingOptions {
  /**
   * Controls the maximum request body size. If this is a number,
   * then the value specifies the number of bytes; if it is a string,
   * the value is passed to the bytes library for parsing. Defaults to '100kb'.
   */
  limit?: number | string | undefined;

  /**
   * Which requests the parser handles: a media type (`"application/json"`,
   * `"text/*"`), a list of them, or a predicate whose truthy result parses. A
   * request that does not match is skipped. Defaults to the parser kind's own
   * type (`json` → `application/json`, …).
   */
  type?: string | string[] | ((req: IncomingMessage) => unknown) | undefined;

  /**
   * Catch-all for parser-specific options (`strict`, `reviver`, `extended`, …).
   * Opaque here, so `unknown`.
   */
  [key: string]: unknown;
}

export type BodyParserType = "json" | "urlencoded" | "text" | "raw";

export type MultiPartFileRecord = FileInfo & {
  fieldname: string;
  validatedMimeType: FileTypeResult | undefined;
  originalFilename: string;
  file: Buffer;
  type: "file";
};

export type MultiPartFieldRecord = FieldInfo & {
  type: "field";
  fieldname: string;
  /**
   * The field's value: the raw string, or what it inflated to (an object,
   * array or primitive; see `MultiPartOptions.inflate`). Client input that
   * nothing has validated, so `unknown`. The earlier union of `unknown[]`,
   * `Record<string, unknown>`, `string` and `null` already collapsed to it.
   */
  value: unknown;
};

export type RequestStorageFiles = BunRequest["storageFiles"];
export type RequestStorageFile = BunRequest["storageFile"];

/**
 * The structured logging contract, defined in `lib/logging.ts`. Re-exported
 * here because every option object in the repo referred to `Logger` from this
 * module before logging grew its own file.
 *
 * @see {@link LoggerLike} for what an option accepts, and `resolveLogger` for
 * turning one into a `Logger`.
 */
export type { Logger, LoggerLike } from "../logging";

export type Constructor<T = object> = T extends new (
  ...args: infer A
) => infer R
  ? new (...args: A) => R
  : new (...args: any[]) => any;

export type Shift<AT = unknown, T extends AT[] = AT[]> = T extends [
  infer _,
  ...infer Rest,
]
  ? Rest
  : never;
