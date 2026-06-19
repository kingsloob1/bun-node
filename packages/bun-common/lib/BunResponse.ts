import type { BunFile } from "bun";
import type { Buffer } from "node:buffer";
import type { Readable } from "node:stream";
import type { BunRequest } from "./BunRequest";
import type { TypedEmitter, WebSocketClientData } from "./BunWebSocket";
import type {
  NextFunction,
  RouterMiddlewareHandler,
  SendFileOptions,
} from "./types/general";
import type { CookieSerializeOptions, Deferred } from "./utils/native";
import { EventEmitter } from "node:events";
import { join as joinPath } from "node:path";
import process from "node:process";
import { ReadableStream } from "node:stream/web";
import { getMimeFromStr, isNodeReadableStream } from "./utils/general";
import {
  appendVary,
  createDeferred,
  each,
  encodeUrl,
  etag,
  get,
  isArray,
  isBoolean,
  isBuffer,
  isDateValid,
  isFunction,
  isMap,
  isNull,
  isNumber,
  isNumeric,
  isObject,
  isString,
  isUndefined,
  merge,
  serializeCookie,
  signCookie,
  toHttpDate,
} from "./utils/native";

type WriteHeadersInput = Record<string, string | string[]> | string[];
type CookieSerializeParams = Parameters<typeof serializeCookie>;
/** Writable view of `ResponseInit`, since its members are `readonly`. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The lifecycle events emitted by {@link BunResponse}, mirroring Node's
 * `http.ServerResponse`. Declared as a `type` (not an `interface`) so it
 * satisfies `TypedEmitter`'s `Record<string, …>` constraint.
 */
// eslint-disable-next-line ts/consistent-type-definitions
export type BunResponseEvents = {
  /** The response body has been fully produced. */
  finish: () => void;
  /** The response (and its connection) has closed. */
  close: () => void;
  /** A stream error occurred while producing the response. */
  error: (error: unknown) => void;
  /** The write buffer drained and is ready to accept more data. */
  drain: () => void;
  /** A readable stream was piped into the response. */
  pipe: (source: Readable) => void;
  /** A previously-piped readable stream was unpiped from the response. */
  unpipe: (source: Readable) => void;
};

/** A {@link BunResponse} event name. */
type ResEventName = keyof BunResponseEvents;
/** The listener signature for a given {@link BunResponse} event. */
type ResListener<E extends ResEventName> = BunResponseEvents[E];

export class BunResponse<customWebsocketDataType = unknown>
  implements TypedEmitter<BunResponseEvents>
{
  private _upgradeToWsData:
    | WebSocketClientData<customWebsocketDataType>
    | undefined = undefined;

  #nativeResponse: Response | undefined = undefined;
  /** Resolvers awaiting the native `Response` (see {@link getNativeResponse}). */
  #responseWaiters: ((response: Response) => void)[] = [];
  private options: Writable<ResponseInit> = {};
  private headersObj = new Headers();
  private _isLongLived = false;
  #readableStream: ReadableStream | undefined = undefined;
  #readableStreamController: ReadableStreamDefaultController | undefined =
    undefined;

  #readableStreamClosePromise: Promise<undefined> | undefined = undefined;
  #readableStreamCloseResolve: (() => void) | undefined = undefined;
  #readableStreamEventMap = new Map<string, string | Buffer>();
  /** Notifies a parked stream `pull` that data is available to enqueue. */
  #streamWriteNotifier: Deferred<void> | undefined = undefined;

  /** When true, {@link send} computes an `ETag` for the body. Opt-in. */
  #etagEnabled: boolean;

  /**
   * Lazily-created event bus mirroring Node's `http.ServerResponse` events
   * (`finish`, `close`, `error`, `pipe`, `unpipe`, `drain`, …). It is built
   * only when the first listener is registered, so a response nobody listens
   * to costs nothing.
   */
  #emitter: EventEmitter | undefined = undefined;
  #finishEmitted = false;
  #closeEmitted = false;

  /**
   * The response body, captured for inspection — see {@link getBody}. Holds
   * the value passed to `json`/`send`/`sendStatus`/`end`, or, for a streamed
   * response, the array of chunks written so far.
   */
  #sentBody: unknown = undefined;

  constructor(
    /** The {@link BunRequest} this response is paired with (one per request). */
    public req: BunRequest,
    options?: {
      /**
       * Enable automatic `ETag` generation for this response. Opt-in because
       * hashing every body has a measurable per-request cost; defaults to
       * `false`. Can also be toggled later via {@link setEtag}.
       */
      etag?: boolean;
    },
  ) {
    this.#etagEnabled = options?.etag ?? false;
  }

  /**
   * Enables (or disables) automatic `ETag` generation for this response.
   * ETag is **opt-in** — hashing every body has a measurable per-request cost.
   */
  public setEtag(enabled = true): BunResponse {
    this.#etagEnabled = enabled;
    return this;
  }

  /* ---------------------------------------------------------------- *
   * Node `http.ServerResponse`-style events
   *
   * `BunResponse` is not an `EventEmitter` subclass (that would add a
   * per-request cost). Instead the emitter is created lazily on the first
   * `on`/`once`/... call; `emit` is a no-op while none exists.
   * ---------------------------------------------------------------- */

  /** Returns the emitter, creating (and wiring lifecycle bridges) on demand. */
  private get events(): EventEmitter {
    if (!this.#emitter) {
      const emitter = new EventEmitter();
      emitter.setMaxListeners(0);
      this.#emitter = emitter;

      // Bridge a dropped connection to a `close` event (Node emits `close`
      // when the socket terminates). Wired only once, only when listened to.
      const signal = this.req.request.signal;
      if (!signal.aborted) {
        signal.addEventListener("abort", () => this.emitClose(), {
          once: true,
        });
      }
    }
    return this.#emitter;
  }

  /** Emits `finish` exactly once, then schedules `close` (Node ordering). */
  private emitFinish(): void {
    if (this.#finishEmitted || !this.#emitter) {
      return;
    }
    this.#finishEmitted = true;
    this.#emitter.emit("finish");
    queueMicrotask(() => this.emitClose());
  }

  /** Emits `close` exactly once. */
  private emitClose(): void {
    if (this.#closeEmitted || !this.#emitter) {
      return;
    }
    this.#closeEmitted = true;
    this.#emitter.emit("close");
  }

  /** Emits an `error` event (no-op when nothing is listening). */
  public emitError(error: unknown): void {
    this.#emitter?.emit("error", error);
  }

  public on<E extends ResEventName>(event: E, listener: ResListener<E>): this {
    this.events.on(event, listener as (...args: any[]) => void);
    return this;
  }

  public addListener<E extends ResEventName>(
    event: E,
    listener: ResListener<E>,
  ): this {
    this.events.addListener(event, listener as (...args: any[]) => void);
    return this;
  }

  public once<E extends ResEventName>(
    event: E,
    listener: ResListener<E>,
  ): this {
    this.events.once(event, listener as (...args: any[]) => void);
    return this;
  }

  public prependListener<E extends ResEventName>(
    event: E,
    listener: ResListener<E>,
  ): this {
    this.events.prependListener(event, listener as (...args: any[]) => void);
    return this;
  }

  public prependOnceListener<E extends ResEventName>(
    event: E,
    listener: ResListener<E>,
  ): this {
    this.events.prependOnceListener(
      event,
      listener as (...args: any[]) => void,
    );
    return this;
  }

  public off<E extends ResEventName>(event: E, listener: ResListener<E>): this {
    this.#emitter?.off(event, listener as (...args: any[]) => void);
    return this;
  }

  public removeListener<E extends ResEventName>(
    event: E,
    listener: ResListener<E>,
  ): this {
    this.#emitter?.removeListener(event, listener as (...args: any[]) => void);
    return this;
  }

  public removeAllListeners<E extends ResEventName>(event?: E): this {
    this.#emitter?.removeAllListeners(event);
    return this;
  }

  /** Emits an event; returns `false` when there is no emitter/listener. */
  public emit<E extends ResEventName>(
    event: E,
    ...args: Parameters<ResListener<E>>
  ): boolean {
    return this.#emitter ? this.#emitter.emit(event, ...args) : false;
  }

  public listeners<E extends ResEventName>(event: E): ResListener<E>[] {
    return (this.#emitter?.listeners(event) ?? []) as ResListener<E>[];
  }

  public listenerCount<E extends ResEventName>(event: E): number {
    return this.#emitter?.listenerCount(event) ?? 0;
  }

  public eventNames(): (ResEventName | string | symbol)[] {
    return this.#emitter?.eventNames() ?? [];
  }

  public setMaxListeners(max: number): this {
    this.events.setMaxListeners(max);
    return this;
  }

  public getMaxListeners(): number {
    return this.#emitter?.getMaxListeners() ?? EventEmitter.defaultMaxListeners;
  }

  /** The native `Response`; assigning notifies any {@link getNativeResponse} waiters. */
  private get response(): Response | undefined {
    return this.#nativeResponse;
  }

  private set response(value: Response | undefined) {
    this.#nativeResponse = value;
    // Certify to the request that a response has been produced — a later
    // connection drop is then a `close`, not an `aborted` (see BunRequest).
    if (value) {
      this.req.markResponded();
    }
    if (value && this.#responseWaiters.length) {
      const waiters = this.#responseWaiters;
      this.#responseWaiters = [];
      for (const waiter of waiters) {
        waiter(value);
      }
    }

    // A produced response = `finish`. Streaming (long-lived) responses finish
    // when the stream ends — see `endLongLivedConnection`.
    if (value && !this._isLongLived) {
      this.emitFinish();
    }
  }

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
    this.#sentBody = body;
    this.response = Response.json(body, this.options);
    return this;
  }

  public upgradeToWebsocket(
    data?: WebSocketClientData<customWebsocketDataType>,
  ) {
    this._upgradeToWsData =
      data ||
      ({
        host: this.req.host,
        path: this.req.path,
        search: this.req.search,
        hash: this.req.hash,
        originalUrl: this.req.originalUrl,
        headers: this.req.headersObj,
        user: get(this.req, "user", undefined),
        custom: {} as customWebsocketDataType,
      } satisfies WebSocketClientData<customWebsocketDataType>);
    return this;
  }

  public get upgradeToWsData() {
    return this._upgradeToWsData;
  }

  /**
   * Builds the native response from `body`. Synchronous — no `await` is on the
   * hot path, so the router can dispatch a sync handler without a microtask
   * hop. (Sending a {@link BunResponse} whose response is not yet ready is the
   * one case that cannot resolve synchronously; it falls back to an empty
   * body — build that response before sending it.)
   */
  send(
    body:
      | string
      | null
      | undefined
      | ReadableStream
      | Readable
      | object
      | BunFile
      | BunResponse
      | Response
      | ConstructorParameters<typeof Response>[0],
  ): BunResponse {
    if (this.headersSent) {
      return this;
    }

    // Capture the body for inspection (see `getBody`) before any 204/304
    // stripping or serialisation rewrites it.
    this.#sentBody = body;

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

    let wasResponseInitSet = false;
    if (body instanceof BunResponse) {
      // Use the already-produced native response when available.
      const peeked = Bun.peek(body.getNativeResponse(0));
      let response: Response;
      if (peeked instanceof Response) {
        response = peeked;
      } else {
        response = new Response(undefined, this.options);
        wasResponseInitSet = true;
      }

      this.response = response;
    } else if (body instanceof Response) {
      this.response = body;
    } else if (
      body instanceof Blob ||
      body instanceof ReadableStream ||
      isNodeReadableStream(body)
    ) {
      wasResponseInitSet = true;
      this.response = new Response(body, this.options);
    } else if (isObject(body) || isArray(body)) {
      this.options.headers.set("Content-Type", "application/json");
      const bodyToBeSent = JSON.stringify(body);

      if (this.#etagEnabled && !this.hasHeader("ETag")) {
        this.setHeader("ETag", etag(bodyToBeSent));
      }

      wasResponseInitSet = true;
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

      if (this.#etagEnabled && !this.hasHeader("ETag") && bodyToBeSent) {
        this.setHeader("ETag", etag(bodyToBeSent));
      }

      // A string body is text — default to `text/plain`. (Magic-byte
      // sniffing here would cost a `file-type` scan on every response.)
      if (!this.options.headers.get("content-type") && isString(bodyToBeSent)) {
        this.options.headers.set("Content-Type", "text/plain");
      }

      wasResponseInitSet = true;
      this.response = new Response(bodyToBeSent, this.options);
    }

    if (this.response && !wasResponseInitSet) {
      const respHeaders = this.response.headers;
      const headers = this.nativeResponseOptions?.headers as
        | Headers
        | undefined;

      if (headers) {
        headers.forEach((headerValue, key) => {
          if (!respHeaders.has(key)) {
            respHeaders.set(key, headerValue);
          }
        });
      }
    }

    return this;
  }

  writeHead(
    statusCode: number,
    statusMessage: string,
    headers: WriteHeadersInput,
  ): this;
  writeHead(statusCode: number, headers: WriteHeadersInput): this;
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
    this.#readableStreamCloseResolve?.();
    this.#readableStreamClosePromise = undefined;
    this.#readableStreamCloseResolve = undefined;

    try {
      await this.getWritable().close();
    } catch {
      //
    }

    this.#readableStream = undefined;
    // A streaming response finishes when its stream ends.
    this.emitFinish();
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

            // Park until a write notifies us instead of busy-polling.
            if (this.#readableStreamEventMap.size === 0) {
              this.#streamWriteNotifier = createDeferred<void>();
              await this.#streamWriteNotifier.promise;
              this.#streamWriteNotifier = undefined;
            }

            for (const key of this.#readableStreamEventMap.keys()) {
              const value = this.#readableStreamEventMap.get(key);

              controller.enqueue(
                isBuffer(value) ? value : encoder.encode(String(value)),
              );

              this.#readableStreamEventMap.delete(key);
            }
          },
          cancel: async (reason: string) => {
            this.req.emit("abort", reason);
            // A cancel with a reason is a stream error on the response.
            if (reason != null) {
              this.emitError(reason);
            }
            await this.endLongLivedConnection();
          },
        },
        {
          highWaterMark: 1,
        },
      );

      this.#readableStreamClosePromise = new Promise((resolve) => {
        this.#readableStreamCloseResolve = () => resolve(undefined);
        const signal = this.req.request.signal;
        if (signal.aborted) {
          resolve(undefined);
          void this.endLongLivedConnection();
        } else {
          signal.addEventListener(
            "abort",
            () => {
              resolve(undefined);
              void this.endLongLivedConnection();
            },
            { once: true },
          );
        }
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

    this.#readableStreamEventMap.set(key, chunk as string | Buffer);
    // Accumulate streamed chunks so `getBody()` can report them too.
    if (!Array.isArray(this.#sentBody)) {
      this.#sentBody = [];
    }
    (this.#sentBody as unknown[]).push(chunk);
    // Wake any `pull` parked waiting for data.
    this.#streamWriteNotifier?.resolve();
    // The write buffer is unbounded, so the writer is always ready for more.
    this.#emitter?.emit("drain");
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

    return this.send(body as Parameters<typeof this.send>[0]);
  }

  redirect(
    url: string,
    status: ResponseInit | number | undefined = 302,
  ): BunResponse {
    this.response = Number.isFinite(status)
      ? Response.redirect(url, status as number)
      : Response.redirect(url, status as ResponseInit | undefined);
    return this;
  }

  public get nativeResponseOptions(): ResponseInit | undefined {
    return this.options;
  }

  /**
   * Resolves with the native `Response` once it has been produced. Resolves
   * immediately when one already exists; otherwise parks until {@link send}
   * (or another producer) sets it. Rejects after `timeout` ms when positive.
   */
  getNativeResponse(
    timeout = isNumeric(Bun.env.HTTP_REQUEST_TIMEOUT)
      ? Number(Bun.env.HTTP_REQUEST_TIMEOUT)
      : undefined,
  ): Promise<Response> {
    if (this.#nativeResponse) {
      return Promise.resolve(this.#nativeResponse);
    }

    const enableTimeout = isNumeric(timeout) && Number(timeout) > 0;

    return new Promise<Response>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const waiter = (response: Response) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolve(response);
      };

      this.#responseWaiters.push(waiter);

      if (enableTimeout) {
        timer = setTimeout(() => {
          const index = this.#responseWaiters.indexOf(waiter);
          if (index !== -1) {
            this.#responseWaiters.splice(index, 1);
          }
          reject(new Error("Request Timedout"));
        }, Number(timeout));
      }
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

  /**
   * The response body that was sent — the value passed to
   * `json`/`send`/`sendStatus`/`end`, or, for a streamed response, the array
   * of chunks written so far. `undefined` until a body is produced.
   *
   * Together with {@link getHeaders} and {@link statusCode} this lets logging
   * middleware (e.g. `pino-http`) report the full response, the way Node's
   * `http` response headers and body can be inspected.
   */
  getBody(): unknown {
    return this.#sentBody;
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
        this.headersObj.set("Last-Modified", toHttpDate(date));
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

    // `Content-Disposition: attachment` is only set above when `download` is
    // requested; a plain sendFile serves the file inline.
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

    return value;
  }

  public sendStatus(status: number) {
    if (this.headersSent) {
      return;
    }

    this.options.headers = this.headersObj;
    this.#sentBody = String(status);
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

    return this.set("Location", encodeUrl(loc));
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
      val = `s:${signCookie(val, secret as string)}`;
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

    // Serialize with the normalized `options` (path/expires/maxAge applied
    // above) — passing the raw `opts` would drop them when `opts` was omitted.
    this.append("Set-Cookie", serializeCookie(name, String(val), options));

    return this;
  }

  public clearCookie(name: string, opts: Parameters<BunResponse["cookie"]>[2]) {
    const options = merge({ expires: new Date(1), path: "/" }, opts || {});
    return this.cookie(name, "", options);
  }

  public vary(fields: string | string[]) {
    const current = this.headersObj.get("Vary") || "";
    const next = appendVary(current, fields);
    if (next) {
      this.headersObj.set("Vary", next);
    }
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
