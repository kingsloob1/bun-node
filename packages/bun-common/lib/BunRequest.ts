import type { SocketAddress } from "bun";
import type { FileTypeResult } from "file-type";
import type { IncomingMessage } from "node:http";
import type { BunResponse } from "./BunResponse";
import type { StorageFile } from "./multipart";
import type {
  BodyParserOptions,
  BunRequestInterface,
  BunServer,
  MultiPartFileRecord,
  MultiPartOptions,
} from "./types/general";
import type { CookieParseOptions } from "./utils/native";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import accepts from "accepts";
import busboy from "busboy";
import { fileTypeFromBuffer } from "file-type";
import { parseDomain, ParseResultType, Validation } from "parse-domain";
import { parse as parseQueryString } from "picoquery";
import typeIs from "type-is";
import { streamToBuffer } from "./utils/general";
import {
  cloneDeep,
  each,
  extractSignedCookies,
  first,
  flattenDeep,
  fresh,
  get,
  isArray,
  isBoolean,
  isNull,
  isNumber,
  isObject,
  isString,
  isUndefined,
  jsonCookies,
  keys,
  merge,
  omit,
  parseCookie,
  rangeParser,
  set,
  ucwords,
  values,
} from "./utils/native";

export type QueryParserOpts = Parameters<typeof parseQueryString>[1];

/**
 * Default `picoquery` parse options. `nestingSyntax: "js"` accepts both dotted
 * (`a.b`) and bracketed (`a[b]`) keys, and `arrayRepeat` collapses repeated
 * keys into arrays — together approximating the previous `qs` behaviour.
 */
export const DEFAULT_PARSE_QUERY_OPTS: QueryParserOpts = Object.freeze({
  nesting: true,
  nestingSyntax: "js",
  arrayRepeat: true,
  arrayRepeatSyntax: "repeat",
});

/** Strips a leading `?` so query strings parse cleanly. */
function stripQueryPrefix(search: string): string {
  return search.charCodeAt(0) === 63 ? search.slice(1) : search;
}

export class BunRequest extends EventEmitter implements BunRequestInterface {
  private bunResponse: BunResponse | undefined = undefined;
  public headersObj: InstanceType<typeof Headers>;
  /** Lazily-built plain-object header view (see the `headers` getter). */
  #headers: Record<string, string | string[]> | undefined = undefined;
  /** Lazily-parsed request URL (see the `parsedUrl` getter). */
  #parsedUrl: URL | undefined = undefined;
  /** Memoized `{ host, path }` split of the request URL (no `new URL`). */
  #urlSplit: { host: string; path: string } | undefined = undefined;
  public maxHeadersCount = 0;
  public reusedSocket = false;
  /** Init promises, lazily allocated only when body/cookie/query parsing runs. */
  #initPromises: Promise<unknown>[] | undefined = undefined;
  private _body:
    | string
    | Record<string, unknown>
    | Buffer
    | unknown[]
    | null
    | undefined = undefined;

  public secret: string | string[] | undefined = undefined;
  // `cookies`/`signedCookies`/`params`/`query` are lazily allocated — a
  // routing-only request that never reads them pays no allocation.
  #cookies: BunRequestInterface["cookies"] | undefined = undefined;
  #signedCookies: BunRequestInterface["signedCookies"] | undefined = undefined;
  public url: string;
  #params: Record<string, string> | undefined = undefined;
  #query: Record<string, unknown> | undefined = undefined;
  public _route: BunRequestInterface["route"] | undefined = undefined;
  private _contentType:
    | "json"
    | "text"
    | "buffer"
    | "form"
    | "multipart"
    | undefined = undefined;

  #parsedMultipartResp?:
    | {
        files: Map<MultiPartFileRecord, Set<string>>;
        fields: Record<string, unknown>;
      }
    | undefined = undefined;

  private _buffer: Buffer | undefined = undefined;
  /** Uploaded files — lazily allocated; only multipart requests populate it. */
  #storageFiles: StorageFile[] | Record<string, StorageFile[]> | undefined =
    undefined;

  /**
   * Lazily-computed subdomains. `parseDomain` (a public-suffix-list lookup) is
   * comparatively expensive, so it runs only on first access of `subdomains`.
   */
  #subdomains: string[] | undefined = undefined;

  /** Memoized Node-compatible socket shim (see the `socket` getter). */
  #socket:
    | {
        keepAlive: boolean;
        setKeepAlive: (value: boolean) => boolean;
        setNoDelay: (value: boolean) => boolean;
        setTimeout: (value: number) => boolean;
        readonly localPort: number | undefined;
        readonly localAddress: string;
        readonly localFamily: SocketAddress["family"] | undefined;
      }
    | undefined = undefined;

  constructor(
    public request: Request,
    private server: BunServer,
    private options: {
      parseBody: boolean;
      parseCookies?: boolean;
      parseQuery?: boolean;
      parseQueryOpts?: QueryParserOpts;
      parseMultiPartFormDataOpts?: MultiPartOptions;
      cookieParseOptions?: CookieParseOptions;
    } = {
      parseBody: true,
      parseCookies: true,
      parseQuery: true,
      parseQueryOpts: {
        ...DEFAULT_PARSE_QUERY_OPTS,
      },
      parseMultiPartFormDataOpts: {},
    },
  ) {
    super();

    const abortEventHandler = () => {
      this.emit("close");
      this.emit("end");
      this.emit("aborted");

      this.request.signal.removeEventListener("abort", abortEventHandler);
    };
    this.request.signal.addEventListener("abort", abortEventHandler);

    this.headersObj = request.headers as Headers;
    this.url = this.request.url;

    // Normalize options with direct assignment — `set()`'s path parsing is
    // wasted work for these known, fixed property names.
    if (!isBoolean(this.options.parseBody)) {
      this.options.parseBody = true;
    }

    if (!isBoolean(this.options.parseCookies)) {
      this.options.parseCookies = true;
    }

    if (!isBoolean(this.options.parseQuery)) {
      this.options.parseQuery = true;
    }

    if (!isObject(this.options.parseMultiPartFormDataOpts)) {
      this.options.parseMultiPartFormDataOpts = {};
    }

    if (!this.options.parseQueryOpts) {
      this.options.parseQueryOpts = { ...DEFAULT_PARSE_QUERY_OPTS };
    }

    if (this.options?.parseQuery) {
      (this.#initPromises ??= []).push(
        Promise.resolve(this.parseQuery(this.options.parseQueryOpts)),
      );
    }

    if (this.options?.parseBody) {
      (this.#initPromises ??= []).push(Promise.resolve(this.parseBody()));
    }

    if (this.options?.parseCookies) {
      (this.#initPromises ??= []).push(
        Promise.resolve(
          this.parseCookies({
            forceUpdateRequest: true,
            secret: this.secret,
          }),
        ),
      );
    }
  }

  static async init(...args: ConstructorParameters<typeof BunRequest>) {
    const req = new BunRequest(...args);
    await req.ready();
    return req;
  }

  async ready() {
    // Avoid the `Promise.allSettled` allocation when nothing was scheduled.
    if (!this.#initPromises || this.#initPromises.length === 0) {
      return [];
    }
    return await Promise.allSettled(this.#initPromises);
  }

  /** Parsed cookies — lazily allocated on first access. */
  get cookies(): BunRequestInterface["cookies"] {
    return (this.#cookies ??= {});
  }

  set cookies(value: BunRequestInterface["cookies"]) {
    this.#cookies = value;
  }

  /** Verified signed cookies — lazily allocated on first access. */
  get signedCookies(): BunRequestInterface["signedCookies"] {
    return (this.#signedCookies ??= {});
  }

  set signedCookies(value: BunRequestInterface["signedCookies"]) {
    this.#signedCookies = value;
  }

  /** Matched route params — lazily allocated; the router assigns the real set. */
  get params(): Record<string, string> {
    return (this.#params ??= {});
  }

  set params(value: Record<string, string>) {
    this.#params = value;
  }

  /** Parsed query string — lazily allocated on first access. */
  get query(): Record<string, unknown> {
    return (this.#query ??= {});
  }

  set query(value: Record<string, unknown>) {
    this.#query = value;
  }

  /**
   * Parsed request URL. `new URL()` is deferred until first access, so a
   * `BunRequest` whose URL is never inspected pays no parsing cost.
   */
  get parsedUrl(): URL {
    return (this.#parsedUrl ??= new URL(this.request.url));
  }

  set parsedUrl(value: URL) {
    this.#parsedUrl = value;
  }

  get socketAddress(): SocketAddress | null {
    return this.server?.requestIP(this.request) || null;
  }

  get route() {
    return this._route;
  }

  set route(route: BunRequestInterface["route"]) {
    this._route = route;
  }

  get socket() {
    // Memoized: the shim is stateful (`keepAlive`) and read on every
    // `response.headersSent` check, so it must be a single stable instance.
    if (this.#socket) {
      return this.#socket;
    }

    // eslint-disable-next-line ts/no-this-alias
    const that = this;

    const obj = {
      keepAlive: false,
      setKeepAlive(value: boolean) {
        obj.keepAlive = value;
        return isBoolean(obj.keepAlive);
      },
      setNoDelay: (value: boolean) => isBoolean(value),
      setTimeout: (value: number) => isNumber(value),
      get localPort() {
        return that.socketAddress?.port;
      },
      get localAddress() {
        return that.ip;
      },
      get localFamily() {
        return that.socketAddress?.family;
      },
    };

    this.#socket = obj;
    return obj;
  }

  get buffer() {
    return this._buffer;
  }

  get body():
    | string
    | Record<string, unknown>
    | Buffer
    | unknown[]
    | null
    | undefined {
    return this._body;
  }

  set body(
    data:
      | string
      | Record<string, unknown>
      | Buffer
      | unknown[]
      | null
      | undefined,
  ) {
    this._body = data;
  }

  get storageFiles() {
    return (this.#storageFiles ??= []);
  }

  get storageFile() {
    const storageFiles = this.#storageFiles;
    if (storageFiles === undefined) {
      return undefined;
    }

    if (isArray(storageFiles)) {
      return first(storageFiles);
    }

    if (isObject(storageFiles)) {
      const val = first(values(storageFiles));
      if (isArray(val)) {
        return first(val);
      }

      return val;
    }

    return undefined;
  }

  set storageFiles(files: StorageFile[] | Record<string, StorageFile[]>) {
    this.setStorageFiles(files);
  }

  get files() {
    return this.storageFiles;
  }

  get file() {
    return this.storageFile;
  }

  setStorageFiles(files: StorageFile[] | Record<string, StorageFile[]>) {
    if (
      (isArray(files) && files.every((file) => isObject(file))) ||
      isObject(files)
    ) {
      this.#storageFiles = files;
    }
  }

  /**
   * Host subdomains. Lazily computed via `parseDomain` on first read (the
   * public-suffix lookup is skipped entirely when never accessed); the router
   * may override this with the matched route's subdomains.
   */
  get subdomains(): string[] {
    if (this.#subdomains === undefined) {
      this.#subdomains = this.extractSubdomains();
    }
    return this.#subdomains;
  }

  set subdomains(value: string[]) {
    this.#subdomains = value;
  }

  private extractSubdomains(): string[] {
    const parsed = parseDomain(this.parsedUrl.hostname, {
      validation: Validation.Lax,
    });

    if (parsed.type === ParseResultType.Listed) {
      return parsed.subDomains;
    }

    if (
      parsed.type === ParseResultType.NotListed ||
      parsed.type === ParseResultType.Reserved
    ) {
      return (get(parsed, "labels", []) as string[]).slice(0, -2);
    }

    return [];
  }

  get isFormDataParsed() {
    return !!this.#parsedMultipartResp;
  }

  public async getMultiParts(options: MultiPartOptions): Promise<{
    files: Map<MultiPartFileRecord, Set<string>>;
    fields: Record<string, unknown>;
  }> {
    if (this.#parsedMultipartResp) {
      return this.#parsedMultipartResp;
    }

    const contentTypeHeader = this.getHeader("Content-Type");
    if (!this.buffer || !contentTypeHeader?.includes("multipart/form-data")) {
      return {
        files: new Map(),
        fields: {},
      };
    }

    const buffer = await Promise.resolve(this.buffer);
    return new Promise((resolve, reject) => {
      const files = new Map<MultiPartFileRecord, Set<string>>();
      const fieldNameAndValue = new Map<string, Set<string>>();

      let { inflate, fileInflator, fieldInflator } = options;
      const busBoyOpts = omit(options, [
        "inflate",
        "fileInflator",
        "fieldInflator",
      ]);

      if (!isBoolean(inflate)) {
        inflate = true;
      }

      const recursivelyReplacePlaceholder = (
        obj: Record<string, unknown>,
        replacement: unknown,
        valueToReplace: unknown,
      ) => {
        each(obj, (value, key) => {
          if (value === valueToReplace) {
            obj[key] = replacement;
          } else if (isObject(value)) {
            recursivelyReplacePlaceholder(
              value as Record<string, unknown>,
              replacement,
              valueToReplace,
            );
          }
        });
      };

      if (inflate) {
        if (!fileInflator) {
          fileInflator = async (
            fieldname: string,
            file: Buffer,
            // opts: FileInfo,
          ) => {
            const parsedObj = parseQueryString(
              `${fieldname}=x`,
              DEFAULT_PARSE_QUERY_OPTS,
            );

            if (isObject(parsedObj)) {
              recursivelyReplacePlaceholder(parsedObj, file, "x");
              return parsedObj;
            }

            return { [fieldname]: file };
          };
        }

        if (!fieldInflator) {
          fieldInflator = async (
            fieldname: string,
            value: string,
            // opts: FieldInfo,
          ) => {
            try {
              let parsedData: Record<string, unknown> | undefined;

              // Attempt to inflate using the query-string parser
              if (!isObject(parsedData)) {
                parsedData = parseQueryString(
                  `${fieldname}=${value}`,
                  DEFAULT_PARSE_QUERY_OPTS,
                ) as Record<string, unknown>;
              }

              // Attempt to inflat using JSON.parse
              if (!isObject(parsedData)) {
                try {
                  const parsedJSONstring = value.replace(/\\\\"/g, `"`);
                  const parsedJSONValue = JSON.parse(parsedJSONstring);
                  parsedData = { [fieldname]: parsedJSONValue };
                } catch {
                  //
                }
              } else {
                each(parsedData, (value, key) => {
                  try {
                    if (!!parsedData && isString(value)) {
                      value = value.replace(/\\\\"/g, `"`);
                      parsedData[key] = JSON.parse(value as string);
                    }
                  } catch {
                    //
                  }
                });
              }

              if (isObject(parsedData)) {
                return parsedData;
              } else {
                throw new Error("Failed to parse form data field");
              }
            } catch {
              //
            }

            return { [fieldname]: value };
          };
        }
      }

      try {
        const bb = busboy({ ...busBoyOpts, headers: this.headers });
        // Track each file handler's promise so the `close` event can await
        // completion deterministically instead of polling state arrays.
        const filePromises: Promise<void>[] = [];

        bb.on("file", (name, file, info) => {
          filePromises.push(
            (async () => {
              const fileBuffer = await streamToBuffer(
                file as unknown as Readable,
              );
              const mimeTypeResp: FileTypeResult | undefined =
                await fileTypeFromBuffer(fileBuffer as unknown as ArrayBuffer);

              const fileData: MultiPartFileRecord = {
                ...info,
                validatedMimeType: mimeTypeResp,
                fieldname: name,
                originalFilename: info.filename,
                file: fileBuffer,
                type: "file",
              };

              let pushFile = false;
              if (inflate && fileInflator) {
                try {
                  const parsedData = await fileInflator(name, fileBuffer, info);
                  const pathListInFileMap =
                    files.get(fileData) || new Set<string>();

                  const processNestedValuePath = (
                    obj: unknown,
                    paths: string[],
                  ) => {
                    try {
                      if ((obj as unknown as Buffer) === fileBuffer) {
                        const pathStr = paths.reduce(
                          (prev, val) => `${prev}[${val}]`,
                          ``,
                        );

                        if (!pathListInFileMap.has(pathStr)) {
                          pathListInFileMap.add(pathStr);
                        }
                      } else {
                        keys(obj).forEach((key) => {
                          processNestedValuePath(get(obj, key) as unknown, [
                            ...paths,
                            String(key),
                          ]);
                        });
                      }
                    } catch {
                      //
                    }
                  };

                  processNestedValuePath(parsedData, []);
                  files.set(fileData, pathListInFileMap);
                } catch {
                  pushFile = true;
                }
              } else {
                pushFile = true;
              }

              if (pushFile) {
                const pathListInFileMap =
                  files.get(fileData) || new Set<string>();

                if (!pathListInFileMap.has(fileData.fieldname)) {
                  pathListInFileMap.add(fileData.fieldname);
                }

                files.set(fileData, pathListInFileMap);
              }
            })(),
          );
        });

        bb.on("field", (name, val) => {
          const valueList = fieldNameAndValue.get(name) || new Set<string>();
          if (!valueList.has(val)) {
            valueList.add(val);
          }

          fieldNameAndValue.set(name, valueList);
        });

        bb.on("close", async () => {
          const fileResults = await Promise.allSettled(filePromises);
          const failedFile = fileResults.find(
            (result) => result.status === "rejected",
          );
          if (failedFile && failedFile.status === "rejected") {
            files.clear();
            fieldNameAndValue.clear();
            reject(failedFile.reason);
            return;
          }

          // Remove file uploads without any pointers;
          for (const key of files.keys()) {
            const listOfPaths = files.get(key);
            if (!(listOfPaths && listOfPaths.size > 0)) {
              files.delete(key);
            }
          }

          let fields: Record<string, unknown> = {};
          await Promise.all(
            Array.from(fieldNameAndValue.keys()).map(async (fieldName) => {
              const values = fieldNameAndValue.get(fieldName);

              if (values?.size) {
                switch (true) {
                  // When the key was repeated in form data
                  case values.size > 1: {
                    await Promise.all(
                      Array.from(values.values()).map(async (value, index) => {
                        let parsedData!: Record<string, unknown>;

                        if (inflate && fieldInflator) {
                          const name = `${fieldName}[${index}]`;
                          parsedData = await fieldInflator(
                            name,
                            value,
                            undefined,
                          );
                        } else {
                          const valueArr: string[] = [];
                          valueArr[index] = value;
                          parsedData = {
                            [fieldName]: valueArr,
                          };
                        }

                        keys(parsedData).forEach((key) => {
                          const value = get(parsedData, key);
                          fields = merge(fields, {
                            [key]: value,
                          });
                        });
                      }),
                    );
                    break;
                  }

                  // When the key wasnt repeated in form data
                  case values.size === 1: {
                    const value = Array.from(values.values())[0];
                    let parsedData!: Record<string, unknown>;

                    if (inflate && fieldInflator) {
                      parsedData = await fieldInflator(
                        fieldName,
                        value,
                        undefined,
                      );
                    } else {
                      parsedData = {
                        [fieldName]: value,
                      };
                    }

                    keys(parsedData).forEach((key) => {
                      const value = get(parsedData, key);
                      fields = merge(fields, {
                        [key]: value,
                      });
                    });
                    break;
                  }

                  default: {
                    //
                  }
                }
              }
            }),
          );

          this._contentType = "multipart";
          this.#parsedMultipartResp = {
            files,
            fields,
          };

          resolve(this.#parsedMultipartResp);
        });

        bb.on("error", (error) => {
          files.clear();
          fieldNameAndValue.clear();
          reject(error);
        });
        Readable.from(buffer).pipe(bb);
      } catch (err) {
        files.clear();
        fieldNameAndValue.clear();

        reject(err);
      }
    });
  }

  private async handleUrlFormEncodingParsing(data: string) {
    try {
      const parsedData = parseQueryString(
        stripQueryPrefix(data),
        DEFAULT_PARSE_QUERY_OPTS,
      );

      if (isObject(parsedData) || isArray(parsedData)) {
        this._body = parsedData;
        this._contentType = "form";
        this.setHeader("Content-Type", "application/x-www-form-urlencoded");
        return true;
      }
    } catch {
      //
    }

    return false;
  }

  private async handleJsonBodyParsing(data: string) {
    try {
      this._body = JSON.parse(data);
      this._contentType = "json";
      this.setHeader("Content-Type", "application/json");
      return true;
    } catch {
      // return false;
    }
    return false;
  }

  public setMultipartParserOptions(opts: MultiPartOptions) {
    set(this.options, "parseMultiPartFormDataOpts", opts);
    return this;
  }

  public setQueryParserOptions(opts: QueryParserOpts) {
    set(this.options, "parseQueryOpts", opts);
    return this;
  }

  public parseQuery(opts?: QueryParserOpts) {
    const options: QueryParserOpts = opts ||
      this.options?.parseQueryOpts || { ...DEFAULT_PARSE_QUERY_OPTS };

    this.query = parseQueryString(
      stripQueryPrefix(this.parsedUrl.search),
      options,
    );
    return this.query;
  }

  public parseCookies(opts?: {
    forceUpdateRequest?: boolean;
    secret?: BunRequest["secret"];
  }): {
    cookies: BunRequest["cookies"];
    signedCookies: BunRequest["signedCookies"];
  } {
    const forceUpdateRequest = isBoolean(opts?.forceUpdateRequest)
      ? opts?.forceUpdateRequest
      : false;

    const sentSecret = !isUndefined(opts?.secret) ? opts?.secret : "";

    let reqSecret = this.secret;
    if (!reqSecret && sentSecret) {
      this.secret = isArray(sentSecret) ? sentSecret[0] : sentSecret;
      reqSecret = this.secret;
    }

    const cookieStr =
      this.getHeader("cookie") || this.getHeader("Cookie") || "";

    if (!cookieStr) {
      return {
        cookies: {},
        signedCookies: {},
      };
    }

    const secrets = isArray(sentSecret)
      ? sentSecret
      : isString(sentSecret) && sentSecret
        ? [sentSecret]
        : isArray(this.secret)
          ? this.secret
          : isString(this.secret) && this.secret
            ? [this.secret]
            : [];

    const cookies = parseCookie(
      cookieStr,
      this.options.cookieParseOptions,
    ) as Record<string, string>;
    let signedCookiesObj: BunRequest["signedCookies"] = {};

    if (secrets.length) {
      const parsedSignedCookies = extractSignedCookies(cookies, secrets);
      signedCookiesObj = jsonCookies(parsedSignedCookies);
    }

    const resp = {
      signedCookies: signedCookiesObj,
      cookies: jsonCookies(cookies),
    };

    if (!this.cookies || forceUpdateRequest) {
      this.cookies = resp.cookies;
      this.signedCookies = resp.signedCookies;
    }

    return resp;
  }

  public async parseBody(fresh = false) {
    if (!fresh && this.isBodyParsed) {
      return {
        body: this._body,
        buffer: this._buffer,
        contentType: this._contentType,
        multipart: this.#parsedMultipartResp,
      };
    }

    let buffer = this._buffer;
    if (!buffer && !this.request.bodyUsed) {
      buffer = Buffer.from(await this.request.arrayBuffer());
    }

    if (!buffer) {
      throw new Error("Invalid body sent");
    }

    this._buffer = buffer;

    const bufferText = buffer.toString();
    const contentTypeHeader = this.getHeader("Content-Type");

    if (!contentTypeHeader) {
      let hasParsedData = false;

      // Try JSON parse
      if (!hasParsedData) {
        hasParsedData = await this.handleJsonBodyParsing(bufferText);
      }

      // Try url-encoded form data parse
      if (!hasParsedData) {
        hasParsedData = await this.handleUrlFormEncodingParsing(bufferText);
      }

      // Leave it as buffer
      if (!hasParsedData) {
        this._body = buffer;
        this._buffer = buffer;
        this._contentType = "buffer";
        this.setHeader("Content-Type", "application/octet-stream");
      }
    } else {
      switch (true) {
        case contentTypeHeader?.includes("text/plain"): {
          this._body = bufferText;
          break;
        }

        case contentTypeHeader?.includes("application/octet-stream"): {
          this._body = this.buffer;
          break;
        }

        case contentTypeHeader?.includes("application/json"): {
          await this.handleJsonBodyParsing(bufferText);
          break;
        }

        case contentTypeHeader?.includes("application/x-www-form-urlencoded"): {
          await this.handleUrlFormEncodingParsing(bufferText);
          break;
        }

        case contentTypeHeader?.includes("multipart/form-data"): {
          await this.getMultiParts(
            this.options?.parseMultiPartFormDataOpts || {},
          );
          break;
        }

        default: {
          try {
            this._body = buffer;
            this._buffer = buffer;
            this._contentType = "buffer";
            this.setHeader("Content-Type", "application/octet-stream");
          } catch {
            //
          }
          break;
        }
      }
    }

    return {
      body: this._body,
      buffer: this._buffer,
      contentType: this._contentType,
      multipart: this.#parsedMultipartResp,
    };
  }

  public async handleBodyParsing(): Promise<undefined>;
  public async handleBodyParsing(returnBuffer: false): Promise<undefined>;
  public async handleBodyParsing(
    returnBuffer: true,
    options?: BodyParserOptions,
  ): Promise<Buffer>;
  public async handleBodyParsing(
    returnBuffer = false,
    // options?: BodyParserOptions,
  ): Promise<Buffer | undefined> {
    if (this.request.bodyUsed || !this.options.parseBody) {
      if (returnBuffer && this._buffer) {
        return Buffer.from(this._buffer as unknown as ArrayBuffer);
      }

      return;
    }

    const parsedBodyResp = await this.parseBody();

    if (returnBuffer) {
      return parsedBodyResp.buffer;
    }
  }

  get isBodyParsed() {
    return !!this._contentType;
  }

  /**
   * Splits the absolute request URL into `{ host, path }` by a single string
   * scan, avoiding a `new URL()` for the hot routing reads (`host`, `path`,
   * `originalUrl`). `path` is `pathname + search + hash` exactly as received
   * (Express-style — not normalized).
   */
  private splitRequestUrl(): { host: string; path: string } {
    if (this.#urlSplit) {
      return this.#urlSplit;
    }

    const url = this.request.url;
    const schemeEnd = url.indexOf("://");
    const hostStart = schemeEnd === -1 ? 0 : schemeEnd + 3;

    let cut = url.length;
    for (let i = hostStart; i < url.length; i++) {
      const code = url.charCodeAt(i);
      // First of '/' (47), '?' (63), '#' (35) ends the authority.
      if (code === 47 || code === 63 || code === 35) {
        cut = i;
        break;
      }
    }

    let host = url.slice(hostStart, cut);
    const at = host.lastIndexOf("@");
    if (at !== -1) {
      host = host.slice(at + 1); // drop any userinfo
    }

    let path = cut >= url.length ? "/" : url.slice(cut);
    if (path.charCodeAt(0) !== 47) {
      path = `/${path}`; // a bare `?query`/`#hash` implies pathname "/"
    }

    this.#urlSplit = { host, path };
    return this.#urlSplit;
  }

  get path() {
    return this.splitRequestUrl().path;
  }

  get method() {
    return this.request.method.toUpperCase();
  }

  get host() {
    return (
      this.splitRequestUrl().host || this.headersObj.get("Host") || "127.0.0.1"
    );
  }

  get protocol() {
    // `URL.protocol` includes a trailing ":" ("https:"); strip it so the
    // value matches Express (`"https"`) and `secure` compares correctly.
    const protocol = this.parsedUrl.protocol.replace(/:$/, "");
    const protocolHeader = this.getHeader("X-Forwarded-Proto") || protocol;
    const index = protocolHeader.indexOf(",");

    return index !== -1
      ? protocolHeader.substring(0, index).trim()
      : protocolHeader.trim();
  }

  get hostname() {
    return this.parsedUrl.hostname;
  }

  getHeader(name: string) {
    return this.headersObj.get(name);
  }

  getHeaderNames() {
    return Array.from(this.headersObj.keys());
  }

  /**
   * Plain-object view of the request headers. Built lazily on first access —
   * a routing-only request that never inspects headers pays nothing.
   */
  get headers(): Record<string, string | string[]> {
    if (this.#headers === undefined) {
      this.#headers = this.getHeaders();
    }
    return this.#headers;
  }

  set headers(value: Record<string, string | string[]>) {
    this.#headers = value;
  }

  getHeaders() {
    const arr = Array.from(this.headersObj.keys()).reduce(
      (prev, val) => {
        const value: string | string[] | null = this.headersObj.get(val);
        if (isNull(value)) {
          return prev;
        }

        prev[val] = value;
        return prev;
      },
      {} as Record<string, string[] | string>,
    );

    return arr;
  }

  getRawHeaderNames() {
    return this.getHeaderNames().map((name) => ucwords(name));
  }

  hasHeader(name: string) {
    return this.headersObj.has(name);
  }

  removeHeader(name: string) {
    this.headersObj.delete(name);
    // Invalidate the cached view; it rebuilds on next access.
    this.#headers = undefined;
  }

  setHeader(name: string, value: string | string[], replace = true) {
    if (replace) {
      this.headersObj.delete(name);
    }

    if (isArray(value)) {
      value.forEach((val) => {
        this.headersObj.append(name, val);
      });
    } else {
      if (replace) {
        this.headersObj.set(name, value);
      } else {
        this.headersObj.append(name, value);
      }
    }
  }

  get ip() {
    return this.socketAddress?.address || "";
  }

  get ips() {
    return (this.headersObj.get("X-Forwarded-For") || "")
      .split(",")
      .map((ip) => ip.trimStart());
  }

  get originalUrl() {
    return this.path;
  }

  get headersDistinct() {
    const distinctHeaders = cloneDeep(this.headers);
    each(distinctHeaders, (value, key) => {
      distinctHeaders[key] = isArray(value) ? value : [value];
    });

    return distinctHeaders as Record<string, string[]>;
  }

  get httpVersion() {
    return "1.1" as const;
  }

  private get httpVersionArr() {
    return this.httpVersion.trim().split(".");
  }

  get httpVersionMajor() {
    return this.httpVersionArr[0];
  }

  get httpVersionMinor() {
    return this.httpVersionArr[1];
  }

  get rawHeaders() {
    return flattenDeep<string>(Object.entries(this.headers));
  }

  get secure() {
    return this.protocol.toLowerCase() === "https";
  }

  public setResponse(res: BunResponse) {
    this.bunResponse = res;
    return this;
  }

  /**
   * Check if the request is fresh, aka
   * Last-Modified or the ETag
   * still match.
   *
   * @return {boolean}
   * @public
   */
  get fresh() {
    const res = this.bunResponse;
    const method = this.method;

    if (!res) {
      return false;
    }

    const status = res.statusCode;

    // GET or HEAD for weak freshness validation only
    if (method !== "GET" && method !== "HEAD") return false;

    // 2xx or 304 as per rfc2616 14.26
    if ((status >= 200 && status < 300) || status === 304) {
      // Read the three conditional headers straight from `headersObj` so the
      // freshness check never forces the lazy `headers` view to be built.
      return fresh(
        {
          "if-modified-since":
            this.headersObj.get("if-modified-since") ?? undefined,
          "if-none-match": this.headersObj.get("if-none-match") ?? undefined,
          "cache-control": this.headersObj.get("cache-control") ?? undefined,
        },
        {
          etag: (res.get("ETag", "") || "") as string | string[],
          "last-modified": res.get("Last-Modified", "") as string | string[],
        },
      );
    }

    return false;
  }

  /**
   * Check if the request is stale, aka
   * Last-Modified or the ETag
   * doesn't match.
   *
   * @return {boolean}
   * @public
   */
  get stale() {
    return !this.fresh;
  }

  get xhr() {
    const xHrHeader = this.getHeader("X-Requested-With") || "";
    return isString(xHrHeader)
      ? xHrHeader.toLowerCase() === "xmlhttprequest"
      : false;
  }

  public accepts(): string[] | string | false;
  public accepts(types: string[]): string[] | string | false;
  public accepts(...types: string[]): string[] | string | false;
  public accepts(...args: string[] | [string[]]) {
    const accept = accepts(this as unknown as IncomingMessage);
    // eslint-disable-next-line prefer-spread
    return accept.types.apply(accept, flattenDeep(args));
  }

  public acceptsTypes(): string[] | string | false;
  public acceptsTypes(types: string[]): string[] | string | false;
  public acceptsTypes(...types: string[]): string[] | string | false;
  public acceptsTypes(...args: string[] | [string[]]) {
    const accept = accepts(this as unknown as IncomingMessage);
    // eslint-disable-next-line prefer-spread
    return accept.types.apply(accept, flattenDeep(args));
  }

  public acceptsType(encodings: string[]): string[] | string | false;
  public acceptsType(...encodings: string[]): string[] | string | false;
  public acceptsType(...args: string[] | [string[]]) {
    const accept = accepts(this as unknown as IncomingMessage);
    // eslint-disable-next-line prefer-spread
    return accept.types.apply(accept, flattenDeep(args));
  }

  public acceptsEncodings(): string[];
  public acceptsEncodings(encodings: string[]): string | false;
  public acceptsEncodings(...encodings: string[]): string | false;
  public acceptsEncodings(...args: string[] | [string[]]) {
    const accept = accepts(this as unknown as IncomingMessage);

    if (!args.length) {
      return accept.encodings();
    }

    // eslint-disable-next-line prefer-spread
    return accept.encodings.apply(accept, flattenDeep(args));
  }

  public acceptsEncoding(encodings: string[]): string[] | string | false;
  public acceptsEncoding(...encodings: string[]): string[] | string | false;
  public acceptsEncoding(...args: string[] | [string[]]) {
    const accept = accepts(this as unknown as IncomingMessage);
    // eslint-disable-next-line prefer-spread
    return accept.encodings.apply(accept, flattenDeep(args));
  }

  public acceptsCharsets(): string[];
  public acceptsCharsets(charsets: string[]): string | false;
  public acceptsCharsets(...charsets: string[]): string | false;
  public acceptsCharsets(...args: string[] | [string[]]) {
    const accept = accepts(this as unknown as IncomingMessage);

    if (!args.length) {
      return accept.charsets();
    }

    // eslint-disable-next-line prefer-spread
    return accept.charsets.apply(accept, flattenDeep(args));
  }

  public acceptsCharset(charsets: string[]): string[] | string | false;
  public acceptsCharset(...charsets: string[]): string[] | string | false;
  public acceptsCharset(...args: string[] | [string[]]) {
    const accept = accepts(this as unknown as IncomingMessage);
    // eslint-disable-next-line prefer-spread
    return accept.charsets.apply(accept, flattenDeep(args));
  }

  public acceptsLanguages(): string[];
  public acceptsLanguages(languages: string[]): string | false;
  public acceptsLanguages(...languages: string[]): string | false;
  public acceptsLanguages(...args: string[] | [string[]]) {
    const accept = accepts(this as unknown as IncomingMessage);

    if (!args.length) {
      return accept.languages();
    }

    // eslint-disable-next-line prefer-spread
    return accept.languages.apply(accept, flattenDeep(args));
  }

  public acceptsLanguage(languages: string[]): string | false;
  public acceptsLanguage(...languages: string[]): string | false;
  public acceptsLanguage(...args: string[] | [string[]]) {
    const accept = accepts(this as unknown as IncomingMessage);
    // eslint-disable-next-line prefer-spread
    return accept.languages.apply(accept, flattenDeep(args));
  }

  public range(
    size: Parameters<typeof rangeParser>[0],
    opts: Parameters<typeof rangeParser>[2],
  ) {
    const rangeHeader = this.getHeader("Range");
    if (!rangeHeader) return;
    return rangeParser(size, rangeHeader, opts);
  }

  get(name: string, defaultVal: string | string[] | undefined = undefined) {
    if (!isUndefined(defaultVal) && !this.hasHeader(name)) {
      return defaultVal as string | string[];
    }

    return this.getHeader(name);
  }

  /**
   * Check if the incoming request contains the "Content-Type"
   * header field, and it contains the given mime `type`.
   *
   * Examples:
   *
   *      // With Content-Type: text/html; charset=utf-8
   *      req.is('html');
   *      req.is('text/html');
   *      req.is('text/*');
   *      // => true
   *
   *      // When Content-Type is application/json
   *      req.is('json');
   *      req.is('application/json');
   *      req.is('application/*');
   *      // => true
   *
   *      req.is('html');
   *      // => false
   *
   * @param {string | Array} types...
   * @return {string | false | null}
   * @public
   */

  public is(types: string[]): string | false | null;
  public is(...types: string[]): string | false | null;
  public is(...args: string[] | [string[]]) {
    return typeIs(this as unknown as IncomingMessage, flattenDeep(args));
  }

  end() {
    //
  }
}
