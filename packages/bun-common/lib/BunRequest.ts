import type { SocketAddress } from "bun";
import type { IncomingMessage } from "node:http";
import type { BunResponse } from "./BunResponse";
import type { StorageFile } from "./multipart";
import type {
  BunRequestInterface,
  BunServer,
  MultiPartFileRecord,
  MultiPartOptions,
  NestExpressBodyParserOptions,
} from "./types/general";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import accepts from "accepts";
import busboy from "busboy";
import { type CookieParseOptions, parse as parseCookie } from "cookie";
import { JSONCookies, signedCookies } from "cookie-parser";
import EventEmitter from "eventemitter3";
import { fileTypeFromBuffer, type FileTypeResult } from "file-type";
import fresh from "fresh";
import ucwords from "locutus/php/strings/ucwords";
import {
  cloneDeep,
  each,
  first,
  flattenDeep,
  get,
  isArray,
  isBoolean,
  isNull,
  isNumber,
  isObject,
  isString,
  isUndefined,
  keys,
  merge,
  omit,
  values,
} from "lodash-es";
import {
  parseDomain,
  type ParseResult,
  ParseResultType,
  Validation,
} from "parse-domain";
import qs from "qs";
import rangeParser from "range-parser";
import typeIs from "type-is";
import { streamToBuffer } from "./utils/general";

export class BunRequest extends EventEmitter implements BunRequestInterface {
  private headerNamesWithMultiple: string[] = [
    "cache-control",
    "X-Forwarded-For",
  ];

  private bunResponse: BunResponse | undefined = undefined;
  public headers: Record<string, string | string[]> = {};
  public headersObj: InstanceType<typeof Headers>;
  public parsedUrl: InstanceType<typeof URL>;
  public maxHeadersCount = 0;
  public reusedSocket = false;
  private _body:
    | string
    | Record<string, unknown>
    | Buffer
    | unknown[]
    | null
    | undefined = undefined;

  public secret: string | string[] | undefined = undefined;
  public cookies: BunRequestInterface["cookies"] = {};
  public signedCookies: BunRequestInterface["signedCookies"] = {};
  public url: string;
  public params: Record<string, string> = {};
  public query: Record<string, unknown> = {};
  public _route: BunRequestInterface["route"] | undefined = undefined;
  private readonly socketAddress: SocketAddress | null = null;
  private readonly parsedDomainResult: ParseResult;
  private _files: Record<string, File> = {};
  private _contentType: "json" | "text" | "buffer" | "form" | undefined =
    undefined;

  private _isFormParsed = false;
  private _buffer: Buffer | undefined = undefined;
  private _storageFiles: StorageFile[] | Record<string, StorageFile[]> = [];

  public subdomains: string[] = [];

  constructor(
    public request: Request,
    private server: BunServer,
    private options: {
      canHandleUpload: boolean;
      parseCookies?: boolean;
      cookieParseOptions?: CookieParseOptions;
    } = {
      canHandleUpload: true,
      parseCookies: true,
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
    this.parsedUrl = new URL(request.url);
    this.headers = this.getHeaders();
    this.socketAddress = this.server.requestIP(this.request);
    this.url = this.request.url;
    this.parsedDomainResult = parseDomain(this.parsedUrl.hostname, {
      validation: Validation.Lax,
    });

    this.parsedUrl.searchParams.forEach((v, k) => {
      this.query[k] = v;
    });

    this.extractSubdomains();

    if (this.options?.parseCookies) {
      this.parseCookies({
        forceUpdateRequest: true,
        secret: this.secret,
      });
    }
  }

  get route() {
    return this._route;
  }

  set route(route: BunRequestInterface["route"]) {
    this._route = route;
  }

  get socket() {
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
    return this._storageFiles;
  }

  get storageFile() {
    if (isArray(this._storageFiles)) {
      return first(this._storageFiles);
    }

    if (isObject(this._storageFiles)) {
      const val = first(values(this._storageFiles));
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
      this._storageFiles = files;
    }
  }

  private extractSubdomains() {
    let subdomains: string[] = [];
    if (this.parsedDomainResult.type === ParseResultType.Listed) {
      subdomains = this.parsedDomainResult.subDomains;
    }

    if (
      [ParseResultType.NotListed, ParseResultType.Reserved].includes(
        this.parsedDomainResult.type,
      )
    ) {
      const list = get(this.parsedDomainResult, "labels", []);
      subdomains = list.slice(0, -2);
    }

    this.subdomains = subdomains;
    return subdomains;
  }

  get isFormDataParsed() {
    return this._isFormParsed;
  }

  public async getMultiParts(options: MultiPartOptions): Promise<{
    files: Map<MultiPartFileRecord, Set<string>>;
    fields: Record<string, unknown>;
  }> {
    if (this._isFormParsed || !this.buffer) {
      return {
        files: new Map(),
        fields: {},
      };
    }

    const buffer = await this.buffer;
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
            const parsedObj = qs.parse(`${fieldname}=x`, {
              depth: 100,
              ignoreQueryPrefix: true,
              allowDots: true,
              allowEmptyArrays: true,
              arrayLimit: 999999999,
              allowSparse: true,
            });

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

              // Attempt to inflat using qs.parse
              if (!isObject(parsedData)) {
                parsedData = qs.parse(`${fieldname}=${value}`, {
                  depth: 100,
                  ignoreQueryPrefix: true,
                  allowDots: true,
                  allowEmptyArrays: true,
                  arrayLimit: 999999999,
                  allowSparse: true,
                });
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
        let filesState: boolean[] = [];
        let fieldState: boolean[] = [];

        bb.on("file", async (name, file, info) => {
          const filesStateIndex = filesState.length;
          filesState[filesStateIndex] = false;

          const fileBuffer = await streamToBuffer(file as unknown as Readable);
          let mimeTypeResp: FileTypeResult | undefined;

          try {
            mimeTypeResp = await fileTypeFromBuffer(
              fileBuffer as unknown as ArrayBuffer,
            );
          } catch (e) {
            if (Bun.env.NODE_ENV === "development") {
              console.log("Error here is =====> ", e);
            }

            throw e;
            //
          }

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
            const pathListInFileMap = files.get(fileData) || new Set<string>();

            if (!pathListInFileMap.has(fileData.fieldname)) {
              pathListInFileMap.add(fileData.fieldname);
            }

            files.set(fileData, pathListInFileMap);
          }

          filesState[filesStateIndex] = true;
        });

        bb.on("field", async (name, val) => {
          const valueList = fieldNameAndValue.get(name) || new Set<string>();
          if (!valueList.has(val)) {
            valueList.add(val);
          }

          fieldNameAndValue.set(name, valueList);
        });

        bb.on("close", async () => {
          await Promise.all([
            new Promise((resolve) => {
              const interval = setInterval(() => {
                if (
                  fieldState.length === 0 ||
                  fieldState.findIndex((state) => state === false) === -1
                ) {
                  clearInterval(interval);
                  resolve(true);
                }
              }, 1);
            }),
            new Promise((resolve) => {
              const interval = setInterval(() => {
                if (
                  filesState.length === 0 ||
                  filesState.findIndex((state) => state === false) === -1
                ) {
                  clearInterval(interval);
                  resolve(true);
                }
              }, 1);
            }),
          ]);

          filesState = [];
          fieldState = [];

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

          const returnObj = {
            files,
            fields,
          };

          resolve(returnObj);
          this._isFormParsed = true;
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
      const parsedData = qs.parse(data, {
        depth: 100,
        ignoreQueryPrefix: true,
        allowDots: true,
        allowEmptyArrays: true,
        arrayLimit: 999999999,
        allowSparse: true,
      });

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

  private async handleJsoonBodyParsing(data: string) {
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

    const cookies = parseCookie(cookieStr, this.options.cookieParseOptions);
    let signedCookiesObj: BunRequest["signedCookies"] = {};

    if (secrets.length) {
      const parsedSignedCookies = signedCookies(cookies, secrets);
      signedCookiesObj = JSONCookies(
        parsedSignedCookies as Record<string, string>,
      );
    }

    const resp = {
      signedCookies: signedCookiesObj,
      cookies: JSONCookies(cookies),
    };

    if (!this.cookies || forceUpdateRequest) {
      this.cookies = resp.cookies;
      this.signedCookies = resp.signedCookies;
    }

    return resp;
  }

  public async handleBodyParsing(): Promise<undefined>;
  public async handleBodyParsing(returnBuffer: false): Promise<undefined>;
  public async handleBodyParsing(
    returnBuffer: true,
    options?: NestExpressBodyParserOptions,
  ): Promise<Buffer>;
  public async handleBodyParsing(
    returnBuffer = false,
    // options?: NestExpressBodyParserOptions,
  ): Promise<Buffer | undefined> {
    if (this.request.bodyUsed || !this.options.canHandleUpload) {
      if (returnBuffer && this._buffer) {
        return Buffer.from(this._buffer as unknown as ArrayBuffer);
      }

      return;
    }

    const buffer = Buffer.from(await this.request.arrayBuffer());

    if (!buffer) {
      throw new Error("Invalid buffer object");
    }

    this._buffer = buffer;

    const bufferText = buffer.toString();
    const contentTypeHeader = this.getHeader("Content-Type");

    if (!contentTypeHeader) {
      let hasParsedData = false;

      // Try JSON parse
      if (!hasParsedData) {
        hasParsedData = await this.handleJsoonBodyParsing(bufferText);
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
          await this.handleJsoonBodyParsing(bufferText);
          break;
        }

        case contentTypeHeader?.includes("application/x-www-form-urlencoded"): {
          await this.handleUrlFormEncodingParsing(bufferText);
          break;
        }

        case contentTypeHeader?.includes("multipart/form-data"): {
          // Leave the interceptors to handle this..
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

    if (returnBuffer) {
      return buffer;
    }
  }

  get isBodyParsed() {
    return !!this._contentType;
  }

  get path() {
    return `${this.parsedUrl.pathname}${this.parsedUrl.search}${this.parsedUrl.hash}`;
  }

  get method() {
    return this.request.method.toUpperCase();
  }

  get host() {
    return this.parsedUrl.host || this.headersObj.get("Host") || "127.0.0.1";
  }

  get protocol() {
    const protocol = this.parsedUrl.protocol;
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

  getHeaders() {
    return Array.from(this.headersObj.keys()).reduce(
      (prev, val) => {
        let value: string | string[] | null = this.headersObj.get(val);
        const valLower = val.toLowerCase().trim();

        if (isNull(value)) {
          return prev;
        }

        if (
          isString(value) &&
          (valLower.startsWith("accept-") ||
            ["cache-control", "X-Forwarded-For"].includes(valLower))
        ) {
          value = value.split(",").map((ip) => ip.trimStart());
        }

        prev[val] = value;
        return prev;
      },
      {} as Record<string, string[] | string>,
    );
  }

  getRawHeaderNames() {
    return this.getHeaderNames().map((name) => ucwords(name));
  }

  hasHeader(name: string) {
    return this.headersObj.has(name);
  }

  removeHeader(name: string) {
    this.headersObj.delete(name);
    this.headers = this.getHeaders();
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
    return flattenDeep(Object.entries(this.headers));
  }

  get secure() {
    return this.protocol.toLowerCase() === "https";
  }

  public setResponse(res: BunResponse) {
    this.bunResponse = res;
    return this;
  }

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
      return fresh(this.headers, {
        etag: (res.get("ETag", "") || "") as string | string[],
        "last-modified": res.get("Last-Modified", "") as string | string[],
      });
    }

    return false;
  }

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

  public is(types: string[]): string | false | null;
  public is(...types: string[]): string | false | null;
  public is(...args: string[] | [string[]]) {
    return typeIs(this as unknown as IncomingMessage, flattenDeep(args));
  }

  end() {
    //
  }
}
