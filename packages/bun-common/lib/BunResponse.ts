import { join as joinPath } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";
import { type Readable, isReadable } from "node:stream";
import type { ReadableStreamController } from "node:stream/web";
import type { BunFile } from "bun";
import { format as formatDate, isValid as isDateValid } from "date-fns";
import isNumeric from "fast-isnumeric";
import { fileTypeFromBuffer } from "file-type";
import {
  each,
  get,
  isArray,
  isBoolean,
  isFunction,
  isMap,
  isNull,
  isNumber,
  isObject,
  isString,
  isUndefined,
  set,
  values,
} from "lodash-es";
import type { DeepWritable } from "ts-essentials";
import type { BunRequest } from "./BunRequest";
// import { formatInTimeZone } from 'date-fns-tz';
import type { SendFileOptions } from "./types/general";

type WriteHeadersInput = Record<string, string | string[]> | string[];

export class BunResponse {
  private response: Response | undefined = undefined;
  private options: DeepWritable<ResponseInit> = {};
  private headersObj = new Headers();
  private _checkConnectionTimer: ReturnType<typeof setInterval> | undefined =
    undefined;

  private _isLongLived = false;
  private _writeController: ReadableStreamController<unknown> | undefined =
    undefined;

  private _writeControllerStream: ReadableStream | undefined = undefined;
  private _writeDataBeforeSetupController: unknown[][] = [];

  constructor(public req: BunRequest) {}

  public get isLongLived() {
    return this.req.socket.keepAlive === true || this._isLongLived || false;
  }

  protected getWriteController() {
    return this._writeController;
  }

  public header(key: string, value: string | string[]) {
    return this.setHeader(key, value);
  }

  public status(code: number): BunResponse {
    this.options.status = code;
    return this;
  }

  public type(mimeType: string): BunResponse {
    this.headersObj.set("Content-Type", mimeType);
    return this;
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

      this.response = new Response(JSON.stringify(body), this.options);
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

      // If no content type, Attempt to extract content type from buffer and send
      if (!this.options.headers.get("content-type") && isString(bodyToBeSent)) {
        let contentType = "text/plain";

        try {
          const typeResp = await fileTypeFromBuffer(
            Buffer.from(bodyToBeSent, "utf-8"),
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

  public async longLivedWrite(
    ...args: Parameters<ReadableStreamController<unknown>["enqueue"]>
  ) {
    if (
      !get(this._writeControllerStream, "done") ||
      !!this._writeControllerStream
    ) {
      try {
        await this._writeController?.enqueue(...args);
      } catch {
        await this.endLongLivedConnection();
      }
    }

    return 0;
  }

  public initLongLivedConnection() {
    if (this._isLongLived) return false;
    this.req.socket.setKeepAlive(true);
    this.req.socket.setNoDelay(true);
    this.req.socket.setTimeout(0);

    this._checkConnectionTimer = setInterval(async () => {
      const isAbortedBoolean = isBoolean(this.req?.request?.signal?.aborted);
      if (
        !isAbortedBoolean ||
        (isAbortedBoolean && this.req?.request?.signal?.aborted)
      ) {
        await this.endLongLivedConnection();
      }
    }, 10);

    this._isLongLived = true;
    this.options.headers = this.headersObj;

    this._writeControllerStream = new ReadableStream(
      {
        start: async (controller) => {
          await controller.enqueue("Hello World");
          this._writeController = controller;

          if (this._writeDataBeforeSetupController) {
            for await (const passedArgs of this
              ._writeDataBeforeSetupController) {
              await this.longLivedWrite(...passedArgs);
            }

            this._writeDataBeforeSetupController = [];
          } else {
            await this.longLivedWrite("/n");
          }
        },
        cancel: async () => {
          await this.endLongLivedConnection();
        },
      },
      {
        highWaterMark: 1,
        size(chunk) {
          return chunk.length;
        },
      },
    );

    this.response = new Response(
      this._writeControllerStream as ReadableStream,
      this.options,
    );

    return true;
  }

  async endLongLivedConnection() {
    clearInterval(this._checkConnectionTimer);
    try {
      await this._writeController?.close();
    } catch {
      //
    }

    this._checkConnectionTimer = undefined;
    this._writeDataBeforeSetupController = [];
    set(
      this._writeControllerStream as unknown as Record<string, unknown>,
      "done",
      true,
    );
    this._writeControllerStream = undefined;
    this._writeController = undefined;
  }

  flushHeaders(): boolean {
    return this.initLongLivedConnection();
  }

  getWritable() {
    return {
      ...this._writeController,
      write: this.write.bind(this),
    };
  }

  write(...args: Parameters<ReadableStreamController<unknown>["enqueue"]>) {
    if (!this._isLongLived) {
      this.initLongLivedConnection();
    }

    if (this._isLongLived) {
      if (!this._writeController) {
        this._writeDataBeforeSetupController.push(args);
      } else {
        this.longLivedWrite(...args);
      }
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
    return !!this.response || !!this.isLongLived;
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

  async get(name: string, defaultVal: string | string[]) {
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
}
