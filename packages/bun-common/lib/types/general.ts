import type { Serve } from "bun";
import type { BusboyConfig, FieldInfo, FileInfo } from "busboy";
import type { JSONCookies } from "cookie-parser";
import type { FileTypeResult } from "file-type";
import type { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import type { BunRouter } from "..";
import type { BunRequest } from "../BunRequest";
import type { BunResponse } from "../BunResponse";
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
  cookies: ReturnType<typeof JSONCookies>; // Depends on cookie parser library
  signedCookies: ReturnType<typeof JSONCookies>; // Depends on cookie parser library
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

export type BunServeOptions = Omit<Serve, "fetch" | "websocket">;

export type BunServer = ReturnType<typeof Bun.serve>;

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

export type NextFunction = (type?: string | Error | undefined) => unknown;
export type RouterMiddlewareHandler = (
  req: BunRequest,
  res: BunResponse,
  next: NextFunction,
) => unknown;

export type RouterErrorMiddlewareHandler = (
  error: unknown,
  req: BunRequest,
  res: BunResponse,
  next: NextFunction,
) => unknown;

export type RouterHandler =
  | RouterMiddlewareHandler
  | RouterErrorMiddlewareHandler;

export interface NestExpressBodyParserOptions {
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

export type NestExpressBodyParserType = "json" | "urlencoded" | "text" | "raw";

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
export { type matchedRoute } from "@routejs/router";
