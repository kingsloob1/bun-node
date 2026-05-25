import type { Server as BunServerType, Serve as BunServeType } from "bun";
import type { BusboyConfig, FieldInfo, FileInfo } from "busboy";
import type { FileTypeResult } from "file-type";
import type { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import type { BunRequest } from "../BunRequest";
import type { BunResponse } from "../BunResponse";
import type { BunRouter } from "../BunRouter";
import type {
  StorageExpandedFile,
  StorageFile,
  UploadFilterFile,
} from "../multipart";

export type MultiPartOptions = BusboyConfig & {
  inflate?: boolean; // Parse JSON string or Url encoded string
  fieldInflator?: (
    fieldname: string,
    value: string,
    opts?: FieldInfo,
  ) => Promise<Record<string, unknown>>;
  fileInflator?: (
    fieldname: string,
    file: Buffer,
    opts?: FileInfo,
  ) => Promise<Record<string, unknown>>;
};

export interface BunRequestInterface {
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
  body:
    | string
    | Record<string, unknown>
    | ArrayBufferView
    | unknown[]
    | null
    | undefined;
  buffer: Buffer | undefined;
  secret?: string | string[];
  cookies: Record<string, unknown>;
  signedCookies: Record<string, unknown>;
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
  params: Record<string, string>;
  query: Record<string, unknown>;
  route: Awaited<ReturnType<BunRouter["handle"]>> | null | undefined;
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
  getMultiParts: (options: BusboyConfig) => Promise<{
    files: Map<MultiPartFileRecord, Set<string>>;
    fields: Record<string, unknown>;
  }>;
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
   * 'ignore' Pretend like the dotfile does not exist and call next()
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
   * Redirect to trailing "/" when the pathname is a dir. Defaults to true.
   */
  redirect?: boolean;

  /**
   * Function to set custom headers on response. Alterations to the headers need to occur synchronously.
   * The function is called as `fn(res, path, stat)`, where the arguments are:
   * `res` - the response object
   * `path` - the file path that is being sent
   * `stat` - the stat object of the file that is being sent
   */
  setHeaders?: (res: any, path: string, stat: any) => any;

  /**
   * Creates a virtual path prefix
   */
  prefix?: string;
}

export interface SendFileOptions {
  maxAge?: string | number;
  root?: string;
  lastModified?: boolean;
  dotfiles?: "allow" | "ignore";
  accepRanges?: boolean;
  cacheControl?: boolean;
  immutable?: boolean;
  headers?: Record<string, unknown>;
}

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

export type RouterErrorMiddlewareHandler<R = unknown> = (
  error: unknown,
  req: BunRequest,
  res: BunResponse,
  next: NextFunction,
) => R | Promise<R>;

export type RouterHandler<R = unknown> = RouterMiddlewareHandler<R>;

/**
 * Any callback registrable on a route. The router accepts handlers of every
 * arity it has to dispatch — 1-arg (`req` only), 2-arg (`req`, `res`), the
 * regular 3-arg `(req, res, next)` middleware/route handler, and the 4-arg
 * `(err, req, res, next)` Express-style error handler. Listing each arity as
 * an explicit member of the union lets TypeScript pick the right contextual
 * signature for an untyped arrow at the call site.
 */
export type RouterCallback<R = unknown> =
  | RouterRequestOnlyHandler<R>
  | RouterRequestResponseHandler<R>
  | RouterHandler<R>
  | RouterErrorMiddlewareHandler<R>;

export interface BodyParserOptions {
  /** When set to true, then deflated (compressed) bodies will be inflated; when false, deflated bodies are rejected. Defaults to true. */
  inflate?: boolean | undefined;

  /**
   * Controls the maximum request body size. If this is a number,
   * then the value specifies the number of bytes; if it is a string,
   * the value is passed to the bytes library for parsing. Defaults to '100kb'.
   */
  limit?: number | string | undefined;

  /**
   * The type option is used to determine what media type the middleware will parse
   */
  type?: string | string[] | ((req: IncomingMessage) => any) | undefined;

  // Catch-all for body-parser type specific options
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
  value:
    | unknown[]
    | Record<string, unknown>
    | unknown
    | string
    | null
    | undefined;
};

export type RequestStorageFiles = BunRequest["storageFiles"];
export type RequestStorageFile = BunRequest["storageFile"];

export interface Logger {
  log: (...optionalParams: unknown[]) => void;
  error: (...optionalParams: unknown[]) => void;
  warn: (...optionalParams: unknown[]) => void;
}

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
