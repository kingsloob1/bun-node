import type { BunFile } from "bun";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DeepWritable } from "ts-essentials";
import type { BunRequest } from "./BunRequest";
import { Buffer } from "node:buffer";
import { join as joinPath } from "node:path";
import process from "node:process";
import { isReadable, type Readable } from "node:stream";
import { eTag } from "@tinyhttp/etag";
import {
  type CookieSerializeOptions,
  serialize as serializeCookie,
} from "cookie";
import * as cookieSignature from "cookie-signature";
import { format as formatDate, isValid as isDateValid } from "date-fns";
import encodeurl from "encodeurl";
import isNumeric from "fast-isnumeric";
import { fileTypeFromBuffer } from "file-type";
import {
  each,
  get,
  isArray,
  isBoolean,
  isBuffer,
  isFunction,
  isMap,
  isNull,
  isNumber,
  isObject,
  isString,
  isUndefined,
  merge,
  values,
} from "lodash-es";
import pollUntil from "until-promise";
import vary from "vary";
import { getMimeFromStr } from "./utils/general";
// import { formatInTimeZone } from 'date-fns-tz';
import type {
  NextFunction,
  RouterMiddlewareHandler,
  SendFileOptions,
} from "./types/general";

type WriteHeadersInput = Record<string, string | string[]> | string[];
type CookieSerializeParams = Parameters<typeof serializeCookie>;

export class BunResponse {
  private _upgradeToWsData: unknown | undefined = undefined;
  private response: Response | undefined = undefined;
  private options: DeepWritable<ResponseInit> = {};
  private headersObj = new Headers();
  private _isLongLived = false;
  #readableStream: ReadableStream | undefined = undefined;
  #readableStreamController: ReadableStreamDefaultController | undefined =
    undefined;

  #readableStreamCloseInterval: ReturnType<typeof setInterval> | undefined =
    undefined;

  #readableStreamClosePromise: Promise<undefined> | undefined = undefined;
  #readableStreamEventMap = new Map<string, string | Buffer>();

  constructor(public req: BunRequest) {}

  public get isLongLived() {
    return this.req.socket.keepAlive === true || this._isLongLived || false;
  }

  public header(key: string, value: string | string[]) {
    return this.setHeader(key, value);
  }

  public status(code: number): BunResponse {
    this.options.status = code;
    return this;
  }

  set statusCode(code: number) {
    this.status(code);
  }

  get statusCode() {
    return this.options.status || 200;
  }

  public type(mimeType: string): BunResponse {
    this.headersObj.set("Content-Type", mimeType);
    return this;
  }

  public contentType(...args: Parameters<BunResponse["type"]>) {
    return this.type(...args);
  }

  public option(option: ResponseInit): BunResponse {
    this.options = Object.assign(this.options, option);
    return this;
  }

  public statusText(text: string): BunResponse {
    this.options.statusText = text;
    return this;
  }

  public json<T extends Record<string, unknown>>(body: T): BunResponse {
    this.options.headers = this.headersObj;
    this.options.headers.set("Content-Type", "application/json");
    this.response = Response.json(body, this.options);
    return this;
  }

  public upgradeToWebsocket(data?: unknown) {
    this._upgradeToWsData = data || {};
    return this;
  }

  public get upgradeToWsData() {
    return this._upgradeToWsData;
  }

  async send(
    body:
      | string
      | null
      | undefined
      | ReadableStream
      | BunFile
      | BunResponse
      | Response
      | ConstructorParameters<typeof Response>[0],
  ): Promise<BunResponse> {
    if (this.headersSent) {
      return this;
    }

    this.options.headers = this.headersObj;
    this.req.setResponse(this);

    // freshness
    if (this.req.fresh) this.status(304);

    // strip irrelevant headers
    if (this.statusCode === 204 || this.statusCode === 304) {
      this.removeHeader("Content-Type");
      this.removeHeader("Content-Length");
      this.removeHeader("Transfer-Encoding");
      body = "";
    }

    // alter headers for 205
    if (this.statusCode === 205) {
      this.set("Content-Length", "0");
      this.removeHeader("Transfer-Encoding");
      body = "";
    }

    if (body instanceof BunResponse) {
      let response!: Response;

      try {
        const nativeRes = await body.getNativeResponse(1000);
        if (nativeRes instanceof Response) {
          response = nativeRes;
        }
      } catch {
        //
      }

      if (!response) {
        response = new Response(undefined, this.options);
      }

      this.response = response;
    } else if (body instanceof Response) {
      this.response = body;
    } else if (
      body instanceof Blob ||
      isReadable(body as unknown as Readable)
    ) {
      this.response = new Response(body, this.options);
    } else if (isObject(body) || isArray(body)) {
      this.options.headers.set("Content-Type", "application/json");
      const bodyToBeSent = JSON.stringify(body);

      if (!this.hasHeader("ETag")) {
        this.setHeader("ETag", eTag(bodyToBeSent));
      }

      this.response = new Response(bodyToBeSent, this.options);
    } else {
      let bodyToBeSent = body;
      if (
        !(
          isNull(bodyToBeSent) ||
          isUndefined(bodyToBeSent) ||
          isBoolean(bodyToBeSent)
        )
      ) {
        bodyToBeSent = String(bodyToBeSent);
      }

      if (!this.hasHeader("ETag") && bodyToBeSent) {
        this.setHeader("ETag", eTag(bodyToBeSent));
      }

      // If no content type, Attempt to extract content type from buffer and send
      if (!this.options.headers.get("content-type") && isString(bodyToBeSent)) {
        let contentType = "text/plain";

        try {
          const typeResp = await fileTypeFromBuffer(
            Buffer.from(bodyToBeSent, "utf-8") as unknown as ArrayBuffer,
          );

          if (typeResp?.mime) {
            contentType = typeResp?.mime;
          }
        } catch {
          //
        }

        this.options.headers.set("Content-Type", contentType);
      }

      this.response = new Response(bodyToBeSent, this.options);
    }

    return this;
  }

  writeHead(
    statusCode: number,
    statusMessage: string,
    headers: WriteHeadersInput,
  ): this;
  writeHead(statusMessage: string, headers: WriteHeadersInput): this;
  writeHead(headers: WriteHeadersInput): this;
  writeHead(...args: unknown[]) {
    let headers: WriteHeadersInput | undefined;
    let statusCode: number | undefined;
    let statusMessage: string | undefined;
    if (args.length === 3) {
      statusCode = args[0] as number;
      statusMessage = args[1] as string;
      headers = args[2] as WriteHeadersInput;
    } else if (args.length === 2) {
      if (isNumber(args[0])) {
        statusCode = args[0];
        statusMessage = undefined;
      } else if (isString(args[0])) {
        statusCode = undefined;
        statusMessage = args[0];
      }

      headers = args[1] as WriteHeadersInput;
    } else {
      headers = args[0] as WriteHeadersInput;
    }

    this.setHeaders(headers);
    if (statusCode) {
      this.status(statusCode);
    }

    if (statusMessage) {
      this.statusText(statusMessage);
    }

    return this;
  }

  public async initLongLivedConnection() {
    if (this._isLongLived) return false;
    this.req.socket.setKeepAlive(true);
    this.req.socket.setNoDelay(true);
    this.req.socket.setTimeout(0);

    this.setHeader("Content-Type", "text/event-stream");
    this.setHeader("Cache-Control", "no-cache");
    this.setHeader("Connection", "keep-alive");

    this._isLongLived = true;
    this.options.headers = this.headersObj;
    const readableStream = this.readableStream;
    this.response = new Response(readableStream, this.options);
    return true;
  }

  async endLongLivedConnection() {
    clearInterval(this.#readableStreamCloseInterval);
    this.#readableStreamClosePromise = undefined;
    this.#readableStreamCloseInterval = undefined;

    try {
      await this.getWritable().close();
    } catch {
      //
    }

    this.#readableStream = undefined;
  }

  flushHeaders(): boolean {
    this.initLongLivedConnection();
    return true;
  }

  get readableStream() {
    this._isLongLived = true;

    if (this.#readableStream) {
      return this.#readableStream;
    }

    if (!this.response && !this.#readableStream) {
      this.#readableStreamEventMap.clear();

      const encoder = new TextEncoder();
      this.#readableStream = new ReadableStream(
        {
          pull: async (controller) => {
            this.#readableStreamController = controller;
            await pollUntil(
              () => this.#readableStreamEventMap.size,
              (size) => size !== 0,
            );

            for await (const key of this.#readableStreamEventMap.keys()) {
              const value = this.#readableStreamEventMap.get(key);

              await controller.enqueue(
                isBuffer(value) ? value : encoder.encode(String(value)),
              );

              this.#readableStreamEventMap.delete(key);
            }
          },
          cancel: async (reason: string) => {
            this.req.emit("abort", reason);
            await this.endLongLivedConnection();
          },
        },
        {
          highWaterMark: 1,
        },
      );

      this.#readableStreamClosePromise = new Promise((resolve) => {
        this.#readableStreamCloseInterval = setInterval(async () => {
          if (this.req.request.signal.aborted) {
            resolve(undefined);
            await this.endLongLivedConnection();
          }
        });
      });

      return this.#readableStream;
    }

    return undefined;
  }

  private async abortWritableStream(reason: unknown) {
    await this.#readableStream?.cancel(reason);
  }

  private async closeWritableStream() {
    await this.#readableStreamController?.close();
  }

  private async writeToWritableStream(chunk: unknown) {
    let key = String(Bun.nanoseconds());
    while (this.#readableStreamEventMap.has(key)) {
      key = `${key}${Bun.nanoseconds()}`;
    }

    await this.#readableStreamEventMap.set(key, chunk as string | Buffer);
  }

  getWritable(): WritableStreamDefaultWriter {
    return {
      closed: this.#readableStreamClosePromise || Promise.resolve(undefined),
      desiredSize: this.#readableStreamController?.desiredSize || null,
      ready: Promise.resolve(undefined),
      abort: this.abortWritableStream.bind(this),
      close: this.closeWritableStream.bind(this),
      write: this.writeToWritableStream.bind(this),
      releaseLock() {},
    };
  }

  write(...args: Parameters<WritableStreamDefaultWriter["write"]>) {
    if (!this._isLongLived) {
      this.initLongLivedConnection();
    }

    if (this._isLongLived) {
      this.getWritable()?.write(...args);
    }

    return true;
  }

  async end(body: unknown | undefined = undefined) {
    if (this._isLongLived) {
      await this.endLongLivedConnection();
      return "/n";
    }

    return await this.send(body as Parameters<typeof this.send>[0]);
  }

  redirect(
    url: string,
    status: Parameters<typeof Response.redirect>[1] = 302,
  ): BunResponse {
    this.response = Response.redirect(url, status);
    return this;
  }

  getNativeResponse(
    timeout = isNumeric(Bun.env.HTTP_REQUEST_TIMEOUT)
      ? Number(Bun.env.HTTP_REQUEST_TIMEOUT)
      : undefined,
  ): Promise<Response> {
    const enableTimeout = isNumeric(timeout) && Number(timeout) > 0;

    return new Promise((resolve, reject) => {
      let elapsedTime = 0;
      const interval = setInterval(() => {
        if (this.response) {
          clearInterval(interval);
          resolve(this.response);
        } else {
          if (elapsedTime > (timeout as number)) {
            clearInterval(interval);
            reject(new Error("Request Timedout"));
            return;
          }

          if (enableTimeout) {
            elapsedTime += 1;
          }
        }
      }, 1);
    });
  }

  get headersSent() {
    return !!this.upgradeToWsData || !!this.response || !!this.isLongLived;
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

    return this;
  }

  setHeaders(
    headers:
      | Headers
      | Map<string, string>
      | string[]
      | Record<string, string | string[]>,
  ) {
    if (isArray(headers)) {
      headers.forEach((header) => {
        if (isString(header)) {
          const parts = header.split(":").map((part) => part.trim());
          if (parts && parts[0] && parts[1]) {
            this.headersObj.set(parts[0], parts[1]);
          }
        }
      });
    } else if (
      isMap(headers) ||
      headers instanceof Headers ||
      ("keys" in headers && isFunction(headers.keys))
    ) {
      const list = headers as unknown as Map<string, string>;
      const keys = Array.from(list.keys());
      keys.forEach((key) => {
        const value = list.get(key);

        if (value) {
          this.headersObj.set(key, value);
        }
      });
    } else if (isObject(headers)) {
      each(headers, (value, key) => {
        if (!key) {
          return;
        }

        if (isArray(value)) {
          this.headersObj.delete(key);
          value.forEach((val) => this.headersObj.append(key, val));
        } else if (isString(value)) {
          this.headersObj.set(key, value);
        }
      });
    }

    return this;
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
        prev[val] = this.headersObj.get(val);
        return prev;
      },
      {} as Record<string, string | null>,
    );
  }

  append(key: string, value: string | string[]) {
    if (!isArray(value)) {
      value = [value];
    }

    value.forEach((val) => {
      this.headersObj.append(key, val);
    });

    return this;
  }

  appendHeader(key: string, value: string | string[]) {
    return this.append(key, value);
  }

  hasHeader(name: string) {
    return this.headersObj.has(name);
  }

  removeHeader(name: string) {
    this.headersObj.delete(name);
    return this;
  }

  async attachment(path?: string) {
    if (path) {
      const file = Bun.file(path);
      if (await file.exists()) {
        this.headersObj.set(
          "Content-Disposition",
          `attachment; filename="${file.name}"`,
        );
        this.headersObj.set("Content-Type", file.type);
        return this;
      }
    }

    this.headersObj.set("Content-Disposition", `attachment`);
    return this;
  }

  async download(
    path: string,
    filename?: string,
    options?: SendFileOptions,
    cb?: () => unknown,
  ) {
    await this.sendFile(path, {
      ...(options || {}),
      download: true,
      filename,
    });

    if (cb) {
      cb();
    }

    return this;
  }

  async handleNotFound() {
    if (this.headersSent) {
      return this;
    }

    this.options.status = 404;
    this.options.statusText = "Not Found";
    this.response = new Response(undefined, this.options);
    return this;
  }

  async sendFile(
    path: string,
    options: SendFileOptions & {
      download?: boolean;
      filename?: string;
    },
  ) {
    options = options || {};
    const maxAge = get(options, "maxAge", 0);
    const root = get(options, "root", process.cwd());
    const lastModified = get(options, "lastModified", true);
    const headers = get(options, "headers", {});
    const download = get(options, "download", false);
    const filename = get(options, "filename");
    // const dotFiles = get(options, 'dotfiles', 'ignore');
    // const acceptRanges = get(options, 'accepRanges', true);
    const cacheControl = get(options, "cacheControl", true);
    const immutable = get(options, "immutable", false);

    const file = Bun.file(joinPath(root, path));
    const exists = await file.exists();

    if (!exists) {
      return this.handleNotFound();
    }

    if (isObject(headers)) {
      each(headers, (value, key) => {
        this.headersObj.set(key, value);
      });
    }

    if (download) {
      this.headersObj.set(
        "Content-Disposition",
        `attachment; filename="${filename || file.name}"`,
      );
    }

    if (lastModified) {
      const date = new Date(file.lastModified * 1000);
      if (isDateValid(date)) {
        const formattedDateStr = formatDate(
          date,
          "eee, dd MMM yyyy hh:mm:ss GMT",
        );
        this.headersObj.set("Last-Modified", formattedDateStr);
      }
    }

    if (cacheControl) {
      this.headersObj.delete("Cache-Control");

      if (maxAge && maxAge !== "0") {
        this.headersObj.append("Cache-Control", String(maxAge));
      }

      if (immutable) {
        this.headersObj.append("Cache-Control", "immutable");
      }
    } else {
      this.headersObj.delete("Cache-Control");
    }

    this.headersObj.set(
      "Content-Disposition",
      `attachment; filename="${filename || file.name}"`,
    );
    this.headersObj.set("Content-Type", file.type);
    this.options.headers = this.headersObj;

    if (this.headersSent) {
      return this;
    }

    this.response = new Response(file, this.options);
    return this;
  }

  public get(name: string, defaultVal?: string | string[]) {
    const value = this.headersObj.get(name);
    if (!isString(value)) {
      return defaultVal;
    }

    return values;
  }

  public sendStatus(status: number) {
    if (this.headersSent) {
      return;
    }

    this.options.headers = this.headersObj;
    this.response = new Response(String(status), this.options);
    return this;
  }

  public set(name: string, value: string | string[], replace = true) {
    return this.setHeader(name, value, replace);
  }

  public location(url: string) {
    let loc = "";

    // "back" is an alias for the referrer
    if (url === "back") {
      let location = this.req.get("Referrer", "/") || "/";
      if (!isString(location)) {
        location = "/";
      }

      loc = location as string;
    } else {
      loc = String(url);
    }

    return this.set("Location", encodeurl(loc));
  }

  public links(links: Record<string, string>) {
    let link = this.get("Link", "") || "";
    if (link) link += ", ";

    return this.set(
      "Link",
      link +
        Object.keys(links)
          .map(function (rel) {
            return `<${links[rel]}>; rel="${rel}"`;
          })
          .join(", "),
    );
  }

  public cookie(
    name: CookieSerializeParams[0],
    value: CookieSerializeParams[1],
    opts?: CookieSerializeOptions & {
      signed?: boolean;
      secret?: string;
      maxAge?: null | number | string; // Convenient option for setting the expiry time relative to the current time in milliseconds.
    },
  ) {
    const options = opts || {};

    let secret = options?.secret || this.req.secret;
    if (isArray(secret)) {
      secret = secret[0];
    }

    const signed = options?.signed;

    if (signed && !secret) {
      throw new Error(
        "Secret is required for signed cookies... Kindly pass in the secret or update Bun request secret using this.req.secret = <secret",
      );
    }

    let val =
      typeof value === "object" ? `j:${JSON.stringify(value)}` : String(value);

    if (signed) {
      val = `s:${cookieSignature.sign(val, secret as string)}`;
    }

    if (isNumeric(options?.maxAge)) {
      const maxAge = Number(options?.maxAge);

      if (!Number.isNaN(maxAge)) {
        options.expires = new Date(Date.now() + maxAge);
        options.maxAge = Math.floor(maxAge / 1000);
      }
    }

    if (!isString(options?.path)) {
      options.path = "/";
    }

    this.append("Set-Cookie", serializeCookie(name, String(val), opts));

    return this;
  }

  public clearCookie(name: string, opts: Parameters<BunResponse["cookie"]>[2]) {
    const options = merge({ expires: new Date(1), path: "/" }, opts || {});
    return this.cookie(name, "", options);
  }

  public vary(fields: Parameters<typeof vary>[1]) {
    vary(this as unknown as ServerResponse<IncomingMessage>, fields);
    return this;
  }

  public format(obj: Record<string, RouterMiddlewareHandler>) {
    const req = this.req;
    const next = get(req, "next", () => null) as NextFunction;

    const keys = Object.keys(obj).filter(function (v) {
      return v !== "default";
    });

    const key = keys.length > 0 ? req.accepts(keys) : false;
    const keyStr = isString(key) ? key : isArray(key) ? key[0] : "";
    const mime = keyStr ? getMimeFromStr(keyStr) : "";
    this.vary("Accept");

    if (mime) {
      this.set("Content-Type", mime);
      obj[keyStr](req, this, next);
    } else if (obj.default) {
      obj.default(req, this, next);
    } else {
      next(new Error(`NO_FORMAT_TYPE_MATCHES_RESPONSE_CONTENT_TYPE`));
    }

    return this;
  }
}
