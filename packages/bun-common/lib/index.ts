/* eslint-disable perfectionist/sort-exports */
import acceptsFn from "accepts";
import typeIsFn from "type-is";
import {
  appendVary,
  etag,
  extractSignedCookies,
  jsonCookies,
  parseCookie,
  serializeCookie,
  signCookie,
  unsignCookie,
} from "./utils/native";

export {
  getMimeFromStr,
  getUniqueFilename,
  isMime,
  pathExists,
  randomBytes,
  streamToBuffer,
} from "./utils/general";
/* ------------------------------------------------------------------ *
 * Native utilities (`lib/utils/native.ts`) — the dependency-free helpers
 * that replaced lodash-es, cookie, etag, fresh, range-parser, get-port, …
 *
 * The wildcard keeps future additions exported automatically; the blocks
 * below name every current helper and type explicitly, grouped by concern,
 * so they are discoverable from an editor's auto-import and from the
 * generated API surface.
 * ------------------------------------------------------------------ */
export * from "./utils/native";
// Type guards.
export {
  isAnyArrayBuffer,
  isArray,
  isArrayBufferView,
  isAsyncGeneratorFunction,
  isAsyncIterable,
  isBinaryBody,
  isBoolean,
  isBuffer,
  isError,
  isFunction,
  isMap,
  isNull,
  isNumber,
  isNumeric,
  isObject,
  isString,
  isUndefined,
} from "./utils/native";
// Object / collection helpers, and the types their generics and overloads
// resolve to.
export {
  cloneDeep,
  type DeepFlatten,
  type DistributiveOmit,
  each,
  type EachKey,
  type EachValue,
  first,
  flattenDeep,
  get,
  keys,
  lastIndexOf,
  merge,
  type MergeResult,
  type MergeSources,
  type NestedArray,
  omit,
  type OmitResult,
  orderBy,
  type PathSegments,
  type PathValue,
  pick,
  type PropertyPath,
  set,
  unset,
  values,
  type ValuesOf,
} from "./utils/native";
// String, number and date helpers.
export {
  encodeUrl,
  isDateValid,
  parseByteSize,
  toHttpDate,
  ucwords,
} from "./utils/native";
// HTTP helpers: caching/validation, `Vary`, and `Range` parsing & types.
export {
  appendVary,
  combineRanges,
  etag,
  fresh,
  type Range,
  rangeParser,
  type RangeParserResult,
  type RangesSpecifier,
} from "./utils/native";
// Cookie parsing, serialisation, signing and their option types.
export {
  type CookieParseOptions,
  type CookieSerializeOptions,
  extractSignedCookies,
  jsonCookies,
  type JsonCookies,
  parseCookie,
  serializeCookie,
  signCookie,
  unsignCookie,
} from "./utils/native";
// Async helpers — deferreds, polling, and the OS-assigned-port helper that
// tests and adapters use.
export {
  type BackoffOptions,
  type BackoffType,
  computeBackoff,
  createDeferred,
  type Deferred,
  getPort,
  isAbortError,
  Mutex,
  retry,
  type RetryOptions,
  Semaphore,
  sleep,
  type SleepOptions,
  TimeoutError,
  waitUntil,
  type WaitUntilOptions,
  withTimeout,
  type WithTimeoutOptions,
} from "./utils/native";
// Error flattening and JSON round-tripping, for anything that crosses a
// process, worker or database boundary.
export {
  type DeserializedError,
  deserializeError,
  jsonClone,
  type Jsonify,
  type JsonPrimitive,
  type JsonValue,
  type SerializedError,
  serializeError,
  type SerializeErrorOptions,
} from "./utils/native";
// XML utilities & types.
export {
  coerceXmlPrimitive,
  decodeXmlEntities,
  isXmlWhitespace,
  type ParseXmlOptions,
  parseXmlToObject,
  type XmlDocument,
  type XmlElement,
  type XmlNode,
  type XmlPrimitive,
} from "./utils/native";
/* ------------------------------------------------------------------ *
 * Structured logging (`lib/logging.ts`) — the `Logger` contract every
 * option object accepts, the default implementation and its sinks, and
 * adapters that turn an existing pino/bunyan/winston/consola/log4js/tslog/
 * NestJS/console logger into one.
 * ------------------------------------------------------------------ */
export {
  type AdapterOptions,
  type BunyanLike,
  collectSink,
  type ConsolaLike,
  type ConsoleLike,
  consoleSink,
  type ConsoleSinkOptions,
  createLogger,
  type CreateLoggerOptions,
  createTestLogger,
  fromBunyan,
  fromConsola,
  fromConsole,
  fromLog4js,
  fromNestLogger,
  fromPino,
  fromTslog,
  fromWinston,
  isLogger,
  type Log4jsLike,
  LOG_LEVEL_VALUES,
  LOG_LEVELS,
  type LogEvent,
  type LogFields,
  type Logger,
  type LoggerLike,
  type LogLevel,
  type LogLevelThreshold,
  type LogSink,
  mergeLogFields,
  multiSink,
  type NestLoggerLike,
  noopLogger,
  type PinoLike,
  resolveLogger,
  type TslogLike,
  type WinstonLike,
} from "./logging";
export {
  cors,
  type CorsCustomOrigin,
  type CorsOptions,
  type CorsOptionsDelegate,
  type CorsOrigin,
  type CorsStaticOrigin,
} from "./cors";
// Re-export the `busboy` types that appear in bun-common's public type surface
// (`MultiPartOptions`, `MultiPartFileRecord`, `MultiPartFieldRecord`,
// `getMultiParts`, ...). Without this a consumer can use those composed types
// but cannot name the base types directly, and TypeScript declaration emit can
// raise TS2742 "cannot be named" portability errors referencing them.
export type { BusboyConfig, FieldInfo, FileInfo } from "busboy";
export { pump } from "./multipart/stream";
export {
  DiskStorage,
  type DiskStorageOptionHandler,
  type DiskStorageOptions,
} from "./multipart/storage/disk-storage";
export {
  MemoryStorage,
  type MemoryStorageOptions,
} from "./multipart/storage/memory-storage";
export {
  handleMultipartAnyFiles,
  handleMultipartFileFields,
  handleMultipartMultipleFiles,
  handleMultipartSingleFile,
  handleNoFiles,
  uploadFieldsToMap,
} from "./multipart/handlers";
export {
  type BunMultipartRequest,
  type CustomStorageFile,
  type CustomUploadOptions,
  DEFAULT_UPLOAD_OPTIONS,
  type DiskStorageFile,
  type DiskUploadOptions,
  filterUpload,
  getBusBoyConfig,
  type MemoryStorageFile,
  type MemoryUploadOptions,
  type RawMultipartFile,
  removeStorageFiles,
  type Storage,
  type StorageExpandedFile,
  type StorageFile,
  type TransFormedUploadOptions,
  transformUploadOptions,
  type UploadField,
  type UploadFieldMapEntry,
  type UploadFilterFile,
  type UploadFilterHandler,
  type UploadOptions,
} from "./multipart/index";
export {
  UPLOAD_ERROR_MESSAGES,
  UploadError,
  type UploadErrorCode,
  type UploadErrorOptions,
} from "./multipart/errors";
export {
  BunWebSocket,
  type BunWebSocketCreateServerOptions,
  type BunWebSocketEventHandlersType,
  type BunWebSocketGeneralOptions,
  type BunWebsocketHandlerFor,
  type BunWebSocketHandlerType,
  type BunWebSocketNormalOptions,
  type BunWebSocketOptions,
  type BunWebSocketServerType,
  type TypedEmitter,
  type WebSocketClient,
  type WebSocketClientData,
} from "./BunWebSocket";
export {
  type BunHttpClientError,
  BunRequest,
  type BunRequestCookies,
  type BunRequestEvents,
  type BunRequestSocket,
  type BunRequestSocketEvents,
  type ContentParserType,
  type ContentTypeParserOptsMap,
  DEFAULT_ADAPTER_REQUEST_OPTIONS,
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_CONTENT_LENGTH_BY_KIND,
  DEFAULT_PARSE_QUERY_OPTS,
  mergeBunRequestOptions,
  type MultiPartParseResult,
  type ParseBodyConfig,
  type ParseBodyContentTypeConfig,
  type ParseBodyContentTypesMap,
  type ParseBodyOption,
  PayloadTooLargeError,
  type QueryParserOpts,
  type RawMultiPartFields,
} from "./BunRequest";
export {
  type BunCookieOptions,
  BunResponse,
  type BunResponseBody,
  type BunResponseChunk,
  type BunResponseEvents,
  type BunResponseHeaders,
  type BunResponseSentBody,
  type CookieValue,
  type SendFileCallOptions,
  type UpgradeToWebsocketOptions,
} from "./BunResponse";
export {
  BunValidate,
  type BunValidateOptions,
  type InferValidatedShape,
  type SchemaTargets,
  type StandardValidateFunction,
  type TargetHooks,
  toStandardSchema,
  type ToStandardSchemaOptions,
  validate,
  type ValidatedShapeFor,
  ValidationError,
  type ValidationFailureMode,
  type ValidationIssue,
  type ValidationSchemas,
  type ValidationTarget,
  type ValidatorMiddleware,
} from "./BunValidate";
export type { StandardSchemaV1 } from "./types/standardSchema";
export { createServeStaticHandler, ServeStaticError } from "./serveStatic";
/* ------------------------------------------------------------------ *
 * Response compression (`lib/compression.ts`) — the `compression`
 * package's middleware with zstd and RFC 9842 dictionaries, the
 * `BunResponse` transform hook it is built on, and the static-file
 * precompressed-sibling options.
 * ------------------------------------------------------------------ */
export {
  compression,
  type CompressionEncoding,
  type CompressionEncodingsOption,
  type CompressionFilter,
  type CompressionMiddleware,
  type CompressionOptions,
  DEFAULT_COMPRESSION_ASYNC_THRESHOLD,
  DEFAULT_COMPRESSION_ENCODINGS,
  DEFAULT_COMPRESSION_THRESHOLD,
  DEFAULT_DICTIONARY_ENCODINGS,
  dictionaryCompressionSupported,
  formatUseAsDictionary,
  isCompressible,
  rankEncodings,
  resolveEncodingOrder,
  shouldCompress,
  SUPPORTED_COMPRESSION_ENCODINGS,
  type UseAsDictionaryOptions,
} from "./compression";
export type {
  BunResponseTransform,
  BunResponseTransformBody,
  BunResponseTransformContext,
} from "./BunResponse";
export type { ServeStaticPrecompressedOptions } from "./types/general";
export type { ExtractRouteParams } from "./types/routeParams";
export type {
  EmptyShape,
  MergeShape,
  MountedHandler,
  ResolveBody,
  ResolvedHandler,
  ResolveParams,
  ResolveQuery,
  RouterVerb,
  RouterVerbMethod,
  ValidationShape,
} from "./types/routeTyping";
export {
  BunRouter,
  type CachedRouteMatch,
  DEFAULT_ROUTE_CACHE_MAX,
  FETCH_STUB_SERVER,
  type FetchInput,
  type matchedRoute,
  RouteClass,
  type RouteConstructorOption,
  type RouteMatchMethodOptionType,
  routeModulePath,
  toNativeRequest,
  type UnmountedRouter,
} from "./BunRouter";
export {
  BunHttpAdapter,
  type BunHttpAdapterEvents,
  type BunRequestOptions,
  type BunRouterOptions,
  errorStatusCode,
  type FinalErrorLogContext,
  finalErrorResponse,
  type FinalErrorResponseOptions,
  type ResolvedBunRequestOptions,
  type WebsocketOptions,
} from "./BunHttpAdapter";
export {
  type BodyDecodingOptions,
  type BodyParserOptions,
  type BodyParserType,
  type BunRequestInterface,
  type BunServeNormalOptions,
  type BunServeOptions,
  type BunServer,
  type BunServeUnixNormalOptions,
  type Constructor,
  type DefaultRequestBody,
  type MultiPartFieldRecord,
  type MultiPartFileRecord,
  type MultiPartOptions,
  type NextFunction,
  type RequestStorageFile,
  type RequestStorageFiles,
  type RouterErrorMiddlewareHandler,
  type RouterHandler,
  type RouterMiddlewareHandler,
  type SendFileOptions,
  type ServeStaticOptions,
  type TypedRouteHandler,
} from "./types/general";

/* ------------------------------------------------------------------ *
 * Compatibility helpers — native replacements grouped under the same
 * names previously re-exported from third-party packages. The underlying
 * functions (`parseCookie`, `etag`, `fresh`, `rangeParser`, ...) are also
 * exported individually via `export * from "./utils/native"`.
 * ------------------------------------------------------------------ */
export const cookie = { parse: parseCookie, serialize: serializeCookie };
export const cookieSignature = { sign: signCookie, unsign: unsignCookie };
export const cookieParser = {
  JSONCookies: jsonCookies,
  signedCookies: extractSignedCookies,
};
export const vary = appendVary;
export const eTag = etag;

/**
 * Anything carrying request headers — the only part of a request `accepts`
 * and `type-is` read. A `BunRequest`, a Node `IncomingMessage` and a plain
 * `{ headers: { accept: "text/html" } }` all qualify.
 */
export interface RequestHeadersLike {
  /**
   * Lower-cased header names to their values: a `string[]` for a repeated
   * header, `undefined` (or no key) for an absent one.
   */
  headers: Record<string, string | string[] | undefined>;
}

/**
 * `accepts(request)`: negotiation over the request's `Accept`,
 * `Accept-Encoding`, `Accept-Charset` and `Accept-Language` headers.
 */
export type AcceptsFunction = (
  request: RequestHeadersLike,
) => acceptsFn.Accepts;

/**
 * `typeIs(request, types)`: the first of `types` the request body's
 * `Content-Type` matches, `false` for none, `null` when the request has no
 * body — plus the header-free helpers hung off it.
 */
export interface TypeIsFunction {
  (request: RequestHeadersLike, types: string[]): string | false | null;
  (request: RequestHeadersLike, ...types: string[]): string | false | null;
  /** Expands a shorthand (`json`, `urlencoded`, `+json`) to a media type; `false` when unknown. */
  normalize: typeof typeIsFn.normalize;
  /** Whether the request declares a body: a `Transfer-Encoding` header, or a numeric `Content-Length`. */
  hasBody: (request: RequestHeadersLike) => boolean;
  /** The first of `types` a media type matches (the type itself for a wildcard or `+suffix`), else `false`. */
  is: typeof typeIsFn.is;
  /** Whether `actual` matches `expected`, wildcards and `+suffix` included. */
  match: typeof typeIsFn.match;
}

/**
 * The `accepts` package's function: `accepts(req).types(["json", "html"])`.
 *
 * Its `@types` ask for a Node `IncomingMessage`, but `accepts` and
 * `negotiator` read nothing except `request.headers`, so this is the same
 * function typed to take any {@link RequestHeadersLike}.
 */
export const accepts: AcceptsFunction = acceptsFn as AcceptsFunction;
/**
 * The `type-is` package's function, with `is`/`normalize`/`match`/`hasBody`.
 *
 * Typed like {@link accepts}: `type-is` reads only the `content-type`,
 * `transfer-encoding` and `content-length` headers of a request.
 */
export const typeIs: TypeIsFunction = typeIsFn as TypeIsFunction;
export { default as mime } from "mime";
