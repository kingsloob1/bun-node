/* eslint-disable perfectionist/sort-exports */
import * as acceptsModule from "accepts";
import * as typeIsModule from "type-is";
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
// Object / collection helpers.
export {
  cloneDeep,
  each,
  first,
  flattenDeep,
  get,
  keys,
  lastIndexOf,
  merge,
  omit,
  orderBy,
  pick,
  set,
  unset,
  values,
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
  parseCookie,
  serializeCookie,
  signCookie,
  unsignCookie,
} from "./utils/native";
// Async helpers — deferreds, polling, and the OS-assigned-port helper that
// tests and adapters use.
export {
  createDeferred,
  type Deferred,
  getPort,
  waitUntil,
} from "./utils/native";
// XML utilities & types.
export {
  coerceXmlPrimitive,
  decodeXmlEntities,
  isXmlWhitespace,
  type ParseXmlOptions,
  parseXmlToObject,
} from "./utils/native";
export { cors, type CorsOptions, type CorsOptionsDelegate } from "./cors";
// Re-export the `busboy` types that appear in bun-common's public type surface
// (`MultiPartOptions`, `MultiPartFileRecord`, `MultiPartFieldRecord`,
// `getMultiParts`, ...). Without this a consumer can use those composed types
// but cannot name the base types directly, and TypeScript declaration emit can
// raise TS2742 "cannot be named" portability errors referencing them.
export type { BusboyConfig, FieldInfo, FileInfo } from "busboy";
export { pump } from "./multipart/stream";
export {
  DiskStorage,
  type DiskStorageOptions,
} from "./multipart/storage/disk-storage";
export { MemoryStorage } from "./multipart/storage/memory-storage";
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
  BunRequest,
  type ContentParserType,
  type ContentTypeParserOptsMap,
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_CONTENT_LENGTH_BY_KIND,
  DEFAULT_PARSE_QUERY_OPTS,
  type ParseBodyConfig,
  type ParseBodyContentTypeConfig,
  type ParseBodyContentTypesMap,
  type ParseBodyOption,
  PayloadTooLargeError,
  type QueryParserOpts,
} from "./BunRequest";
export { BunResponse } from "./BunResponse";
export { createServeStaticHandler } from "./serveStatic";
export {
  BunRouter,
  type CachedRouteMatch,
  DEFAULT_ROUTE_CACHE_MAX,
  type matchedRoute,
  RouteClass,
  type RouteConstructorOption,
  type RouteMatchMethodOptionType,
  routeModulePath,
} from "./BunRouter";
export {
  BunHttpAdapter,
  type BunRequestOptions,
  type BunRouterOptions,
  type WebsocketOptions,
} from "./BunHttpAdapter";
export {
  type BodyParserOptions,
  type BodyParserType,
  type BunRequestInterface,
  type BunServeNormalOptions,
  type BunServeOptions,
  type BunServer,
  type BunServeUnixNormalOptions,
  type Constructor,
  type Logger,
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
export const { accepts } = { accepts: acceptsModule };
export const { typeIs } = { typeIs: typeIsModule };
export { default as mime } from "mime";
