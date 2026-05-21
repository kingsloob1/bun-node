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
export * from "./utils/native";
export { cors, type CorsOptions, type CorsOptionsDelegate } from "./cors";
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
  DEFAULT_PARSE_QUERY_OPTS,
  type QueryParserOpts,
} from "./BunRequest";
export { BunResponse } from "./BunResponse";
export {
  BunRouter,
  type CachedRouteMatch,
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
