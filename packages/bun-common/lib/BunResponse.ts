import type { BunFile } from "bun";
import type { Readable } from "node:stream";
import type { BunRequest, SetCookieHeaderName } from "./BunRequest";
import type { TypedEmitter, WebSocketClientData } from "./BunWebSocket";
import type {
  NextFunction,
  RouterMiddlewareHandler,
  SendFileOptions,
} from "./types/general";
import type { CookieSerializeOptions, Deferred } from "./utils/native";
import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { STATUS_CODES } from "node:http";
import {
  basename,
  extname,
  isAbsolute,
  join as joinPath,
  normalize,
  resolve as resolvePath,
  sep,
} from "node:path";
import process from "node:process";
import { ReadableStream } from "node:stream/web";
import { inspect } from "node:util";
import mime from "mime";
import { getMimeFromStr, isNodeReadableStream } from "./utils/general";
import {
  appendVary,
  createDeferred,
  each,
  encodeUrl,
  etag,
  get,
  isAnyArrayBuffer,
  isArray,
  isArrayBufferView,
  isAsyncGeneratorFunction,
  isAsyncIterable,
  isBinaryBody,
  isFunction,
  isMap,
  isNull,
  isNumber,
  isNumeric,
  isObject,
  isString,
  isUndefined,
  merge,
  rangeParser,
  serializeCookie,
  signCookie,
  toHttpDate,
} from "./utils/native";

type WriteHeadersInput = Record<string, string | string[]> | string[];
/** Writable view of `ResponseInit`, since its members are `readonly`. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * A value {@link BunResponse.cookie} accepts. An object (or `null`) is written
 * as a `j:`-prefixed JSON cookie, exactly as Express does; anything else is
 * converted with `String()`.
 */
export type CookieValue = string | number | boolean | object | null;

/** Options for {@link BunResponse.cookie}. */
export type BunCookieOptions = Omit<CookieSerializeOptions, "maxAge"> & {
  /** Sign the value with `secret` (or `req.secret`), as an `s:` cookie. */
  signed?: boolean;
  /** Secret used to sign; defaults to `req.secret` (its first entry). */
  secret?: string;
  /**
   * Expiry relative to now, in **milliseconds** — a number or a numeric
   * string. Written as `Max-Age` in seconds plus a matching `Expires`, as in
   * Express. `null`/`undefined` leaves both unset.
   */
  maxAge?: number | string | null;
};

/**
 * Options accepted by {@link BunResponse.sendFile}: every `SendFileOptions`
 * field, with the semantics of Express `res.sendFile` (the `send` package),
 * plus bun-common's `download`/`filename`.
 */
export type SendFileCallOptions = Omit<
  SendFileOptions,
  "dotfiles" | "accepRanges"
> & {
  /**
   * How a path segment starting with a dot is treated: `"ignore"` (default)
   * answers 404, `"deny"` answers 403, `"allow"` serves it. With `root` only
   * the segments below `root` are checked; without it, every segment is.
   */
  dotfiles?: "allow" | "deny" | "ignore";
  /** Honour `Range` requests and send `Accept-Ranges: bytes`. Defaults to `true`. */
  acceptRanges?: boolean;
  /** @deprecated Misspelling of {@link acceptRanges}; still honoured. */
  accepRanges?: boolean;
  /** Answer with `Content-Disposition: attachment`. Defaults to `false`. */
  download?: boolean;
  /** File name for the attachment; defaults to the served file's basename. */
  filename?: string;
};

/**
 * A chunk {@link BunResponse.write} streams: binary (`Buffer`, a typed array,
 * `DataView`, `ArrayBuffer`) goes out verbatim, text is UTF-8 encoded.
 */
export type BunResponseChunk = string | ArrayBufferView | ArrayBufferLike;

/**
 * Options for {@link BunResponse.upgradeToWebsocket}.
 */
export interface UpgradeToWebsocketOptions {
  /**
   * Extra headers for the `101 Switching Protocols` response, handed to
   * `server.upgrade` as its `headers`. Default: none. Only these are sent —
   * headers set on the response through `setHeader`/`set` are not. A
   * `Sec-WebSocket-Protocol` here replaces Bun's default, which echoes the
   * first protocol the client offered, so it is how a server picks a
   * subprotocol.
   */
  headers?: Bun.HeadersInit;
}

/**
 * Every body {@link BunResponse.send} (and `end`) accepts — see `send` for how
 * each is written. It includes `object`, since any plain object or array is
 * sent as JSON.
 */
export type BunResponseBody =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadableStream
  | Readable
  | ArrayBufferView
  | ArrayBufferLike
  | Blob
  | FormData
  | URLSearchParams
  | AsyncIterable<BunResponseChunk>
  | (() => AsyncGenerator<BunResponseChunk>)
  | object
  | BunFile
  | BunResponse
  | Response
  | ConstructorParameters<typeof Response>[0];

/**
 * What {@link BunResponse.getBody} reports: the body handed to
 * `json`/`jsonp`/`send`/`sendStatus`/`end`, or, for a streamed response, the
 * chunks written so far.
 */
export type BunResponseSentBody = BunResponseBody | BunResponseChunk[];

/**
 * What {@link BunResponse.getHeaders} returns, as Node's
 * `OutgoingMessage.getHeaders()`: lower-cased names, and `set-cookie` as the
 * array of its lines rather than one comma-joined string.
 */
export interface BunResponseHeaders {
  /** Every `Set-Cookie` line, in order; absent when none is set. */
  "set-cookie"?: string[];
  /** Any other header, by lower-cased name; repeated values comma-joined. */
  [name: string]: string | string[] | undefined;
}

/**
 * A buffered body a {@link BunResponseTransform} is told about: the text of a
 * string or JSON body, the bytes of a binary one, or a `Blob`/`BunFile`.
 */
export type BunResponseTransformBody =
  | string
  | ArrayBufferView
  | ArrayBufferLike
  | Blob;

/** What a {@link BunResponseTransform} receives beside the `Response`. */
export interface BunResponseTransformContext {
  /** The response producing the native `Response`. */
  res: BunResponse;
  /**
   * The body the `Response` was built from, when it is buffered text, bytes
   * or a `Blob` — so a transform can size it, or read it synchronously,
   * without consuming the `Response`. `undefined` for a stream, a
   * 204/205/304, a response with no body, or once an earlier transform
   * replaced the `Response`.
   */
  body: BunResponseTransformBody | undefined;
}

/**
 * A hook onto the native `Response` a {@link BunResponse} produces — how a
 * middleware such as `compression()` rewrites the final body and headers.
 * Registered with {@link BunResponse.addResponseTransform}.
 */
export interface BunResponseTransform {
  /**
   * Called synchronously as the `Response` is produced (by `send`, `json`,
   * `sendFile`, the first `write`, …); answers the `Response` to send — the
   * one given when nothing changes. Its headers may be immutable (a
   * `Response.redirect`), so build a new `Response` to change them.
   */
  transform: (
    response: Response,
    context: BunResponseTransformContext,
  ) => Response;
  /**
   * Called by {@link BunResponse.flush}: push out anything buffered, as the
   * `compression` package's `res.flush()`. Optional.
   */
  flush?: () => void;
}

/** Whether `value` is a chunk `write`/`end` can stream: text or bytes. */
function isResponseChunk(value: unknown): value is BunResponseChunk {
  return (
    typeof value === "string" ||
    isArrayBufferView(value) ||
    isAnyArrayBuffer(value)
  );
}

/** How Node's `ERR_INVALID_ARG_TYPE` describes the value it received. */
function describeReceived(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "function") {
    return `function ${value.name}`;
  }
  if (typeof value === "object") {
    const name: unknown = value.constructor?.name;
    return typeof name === "string" && name
      ? `an instance of ${name}`
      : inspect(value, { depth: -1 });
  }
  let shown = inspect(value, { colors: false });
  if (shown.length > 28) {
    shown = `${shown.slice(0, 25)}...`;
  }
  return `type ${typeof value} (${shown})`;
}

/**
 * Checks a `write`/`end` chunk as Node's `OutgoingMessage` does: `null` throws
 * `ERR_STREAM_NULL_VALUES`, anything but text or bytes `ERR_INVALID_ARG_TYPE`
 * (both `TypeError`s). Node accepts a string, `Buffer` or `Uint8Array`; any
 * `ArrayBufferView` or `ArrayBuffer` is accepted here too, as a stream can
 * enqueue them as bytes.
 */
function assertResponseChunk(
  chunk: unknown,
): asserts chunk is BunResponseChunk {
  if (chunk === null) {
    throw Object.assign(new TypeError("May not write null values to stream"), {
      code: "ERR_STREAM_NULL_VALUES" as const,
    });
  }
  if (!isResponseChunk(chunk)) {
    throw Object.assign(
      new TypeError(
        `The "chunk" argument must be of type string or an instance of Buffer, Uint8Array, ArrayBufferView or ArrayBuffer. Received ${describeReceived(chunk)}`,
      ),
      { code: "ERR_INVALID_ARG_TYPE" as const },
    );
  }
}

/** Longest `maxAge` `send` accepts: one year, in milliseconds. */
const MAX_MAX_AGE = 60 * 60 * 24 * 365 * 1000;

/** A `..` segment anywhere in a path (the `send` package's `UP_PATH_REGEXP`). */
const UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/** Milliseconds per unit for the `ms`-style durations `maxAge` accepts. */
const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_557_600_000,
};

/**
 * Converts `sendFile`'s `maxAge` to milliseconds the way `send` does: a number
 * is milliseconds; a string is an `ms` duration (`"2h"`, `"1d"`, `"500"`).
 * Anything unparseable is `0`; the result is clamped to one year.
 */
function maxAgeToMs(value: string | number | undefined): number {
  let ms: number;
  if (isString(value)) {
    const match =
      /^(-?(?:\d+(?:\.\d+)?|\.\d+))\s*(ms|msecs?|milliseconds?|[smhdwy]|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?|yrs?|years?)?$/i.exec(
        value.trim(),
      );
    const unit = match?.[2]?.toLowerCase() ?? "ms";
    const key =
      unit.startsWith("ms") || unit.startsWith("milli") ? "ms" : unit[0];
    ms = match
      ? Number.parseFloat(match[1]) * (DURATION_UNITS[key] ?? 1)
      : Number.NaN;
  } else {
    ms = Number(value);
  }
  return Number.isNaN(ms) ? 0 : Math.min(Math.max(0, ms), MAX_MAX_AGE);
}

/**
 * Builds a `Content-Disposition` value the way the `content-disposition`
 * package does for Express: the file's **basename** in a quoted `filename`,
 * plus an RFC 5987 `filename*` when the name is not ISO-8859-1 (whose
 * `filename` then carries a `?`-substituted fallback).
 */
function contentDisposition(filename?: string): string {
  if (filename === undefined) {
    return "attachment";
  }
  const name = basename(filename);
  const quote = (value: string) => `"${value.replace(/[\\"]/g, "\\$&")}"`;

  const nonLatin1 = /[^\x20-\x7E\xA0-\xFF]/g;
  if (!nonLatin1.test(name) && !/%[0-9A-F]{2}/i.test(name)) {
    return `attachment; filename=${quote(name)}`;
  }
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename=${quote(name.replace(nonLatin1, "?"))}; filename*=UTF-8''${encoded}`;
}

/** Splits a comma-separated header token list (`If-Match`), trimming each. */
function parseTokenList(value: string): string[] {
  return value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

/** Shared encoder for streamed text chunks. */
const textEncoder = new TextEncoder();

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
  /**
   * A stream error occurred while producing the response. `unknown`: it is
   * whatever was thrown, or the reason the stream was cancelled with.
   */
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

export class BunResponse<
  /**
   * The `custom` data of a WebSocket this response upgrades to. `unknown`
   * until declared, matching `BunWebSocket`: it is whatever the caller's
   * `customDataToWsClientFn` returns.
   */
  customWebsocketDataType = unknown,
> implements TypedEmitter<BunResponseEvents> {
  private _upgradeToWsData:
    | WebSocketClientData<customWebsocketDataType>
    | undefined = undefined;

  /**
   * Headers for the `101` of a WebSocket upgrade, from
   * {@link upgradeToWebsocket}'s `options.headers`; `undefined` when none were
   * given, so an upgrade without them sends exactly Bun's default.
   */
  private _upgradeToWsHeaders: Headers | undefined = undefined;

  #nativeResponse: Response | undefined = undefined;
  /**
   * Resolvers awaiting the native `Response` (see {@link getNativeResponse}).
   * Allocated on the first waiter — a response nobody awaits costs no array.
   */
  #responseWaiters: ((response: Response) => void)[] | undefined = undefined;
  private options: Writable<ResponseInit> = {};
  private headersObj = new Headers();
  private _isLongLived = false;
  #readableStream: ReadableStream | undefined = undefined;
  #readableStreamController: ReadableStreamDefaultController | undefined =
    undefined;

  #readableStreamClosePromise: Promise<undefined> | undefined = undefined;
  #readableStreamCloseResolve: (() => void) | undefined = undefined;
  /**
   * Chunks written but not yet enqueued on {@link readableStream}, keyed by an
   * arrival-ordered token. Values are text or binary (`Buffer`, typed array,
   * `DataView`, `ArrayBuffer`); binary is enqueued verbatim.
   */
  #readableStreamEventMap:
    | Map<string, string | ArrayBufferView | ArrayBufferLike>
    | undefined = undefined;

  /** The pending-chunk map, created on the first buffered write. */
  get #pendingChunks(): Map<
    string,
    string | ArrayBufferView | ArrayBufferLike
  > {
    return (this.#readableStreamEventMap ??= new Map());
  }

  /** Notifies a parked stream `pull` that data is available to enqueue. */
  #streamWriteNotifier: Deferred<void> | undefined = undefined;

  /**
   * Set once the stream has been asked to end. The pending chunks are still
   * flushed first: by the parked `pull` when one is waiting, immediately when
   * the controller is idle, or by the first `pull` when nothing has read yet.
   */
  #streamEnding = false;

  /** True once the stream's controller has been closed (closing is once-only). */
  #streamClosed = false;

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
  #sentBody: BunResponseSentBody = undefined;

  /**
   * Every chunk streamed so far, in order — the response's own list, reported
   * by {@link getBody}. Never a body the caller passed to `send`, which is
   * never mutated. `undefined` until the first streamed chunk.
   */
  #streamedChunks: BunResponseChunk[] | undefined = undefined;

  /**
   * Transforms run on the native `Response` as it is produced, in
   * registration order — see {@link addResponseTransform}. `undefined` until
   * the first is added, so a response without one pays a single check.
   */
  #responseTransforms: BunResponseTransform[] | undefined = undefined;

  /**
   * The buffered body of the `Response` about to be produced, when `send`'s
   * captured body is not it (serialised JSON text, a `sendFile` slice).
   * Recorded only while a transform is registered; cleared once read.
   */
  #transformBody: BunResponseTransformBody | undefined = undefined;

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
    // Bind the pair at construction, as Express does with `req.res`, so
    // `req.fresh` / `req.stale` can be computed from the moment the response
    // exists — not only once `send()` runs.
    req.setResponse(this);
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

  /**
   * Emits an `error` event (no-op when nothing is listening). `unknown`, as
   * any thrown value can be reported.
   */
  public emitError(error: unknown): void {
    this.#emitter?.emit("error", error);
  }

  /**
   * Whether the response has ended, as Node's `writableEnded`: a body was
   * produced (`send`, `json`, `end`, `redirect`, …) or, for a long-lived
   * stream, it was asked to end. Writing after that is an error.
   */
  get #ended(): boolean {
    return this._isLongLived
      ? this.#streamEnding
      : this.#nativeResponse !== undefined;
  }

  /**
   * Node's `ERR_STREAM_WRITE_AFTER_END`, emitted as an `error` event on the
   * next tick, as `OutgoingMessage` does. Unlike Node, it is not emitted when
   * no `error` listener is registered, rather than crashing the process.
   */
  #emitWriteAfterEnd(): void {
    const error = Object.assign(new Error("write after end"), {
      code: "ERR_STREAM_WRITE_AFTER_END" as const,
    });
    process.nextTick(() => {
      if (this.listenerCount("error") > 0) {
        this.emitError(error);
      }
    });
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
    // `EventEmitter#removeAllListeners` branches on `arguments.length`, not on
    // the argument's value: forwarding `undefined` explicitly makes it look
    // like "remove listeners for the event named `undefined`", which removes
    // nothing. The no-argument case has to call it with no argument.
    if (event === undefined) {
      this.#emitter?.removeAllListeners();
    } else {
      this.#emitter?.removeAllListeners(event);
    }
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
    if (value && this.#responseTransforms !== undefined) {
      value = this.#applyResponseTransforms(value, this.#responseTransforms);
    }
    this.#nativeResponse = value;
    // Certify to the request that a response has been produced — a later
    // connection drop is then a `close`, not an `aborted` (see BunRequest).
    if (value) {
      this.req.markResponded();
    }
    if (value && this.#responseWaiters !== undefined) {
      const waiters = this.#responseWaiters;
      this.#responseWaiters = undefined;
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

  /**
   * Registers a transform run on the native `Response` as it is produced —
   * the hook `compression()` uses to rewrite the final body and headers.
   * Transforms run synchronously in registration order, each given the
   * previous one's result; one added after the response was produced never
   * runs. Returns the response.
   */
  public addResponseTransform(transform: BunResponseTransform): this {
    (this.#responseTransforms ??= []).push(transform);
    return this;
  }

  /**
   * Flushes what a registered transform holds buffered — with `compression()`,
   * the compressor's pending output, as the `compression` package's
   * `res.flush()`. A no-op when nothing is registered.
   */
  public flush(): void {
    const transforms = this.#responseTransforms;
    if (transforms !== undefined) {
      for (const transform of transforms) {
        transform.flush?.();
      }
    }
  }

  /** Runs `transforms` over a produced `Response`; see {@link addResponseTransform}. */
  #applyResponseTransforms(
    response: Response,
    transforms: BunResponseTransform[],
  ): Response {
    const sent = this.#sentBody;
    const recorded = this.#transformBody;
    this.#transformBody = undefined;

    // Status, not `response.body`: reading `body` would make Bun wrap a
    // buffered body in a stream. The body-less statuses are the answers whose
    // captured `send` body was dropped.
    let body: BunResponseTransformBody | undefined;
    const status = response.status;
    if (status !== 204 && status !== 205 && status !== 304) {
      body =
        recorded ??
        (isString(sent) || isBinaryBody(sent) || sent instanceof Blob
          ? sent
          : undefined);
    }

    let current = response;
    for (const transform of transforms) {
      const next = transform.transform(current, { res: this, body });
      if (next !== current) {
        // The body described no longer is the one being sent.
        body = undefined;
        current = next;
      }
    }
    return current;
  }

  public get isLongLived() {
    return this.req.isKeepAlive || this._isLongLived || false;
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

  /**
   * Sets `Content-Type`. As in Express, a value containing `/` is used as
   * given; otherwise it is an extension or name (`"json"`, `".html"`, `"txt"`)
   * looked up with `mime`, falling back to `application/octet-stream`. Unlike
   * Express, no `; charset=utf-8` is appended — matching `json()`/`send()`.
   */
  public type(type: string): BunResponse {
    const contentType = type.includes("/")
      ? type
      : (mime.getType(type) ?? "application/octet-stream");
    this.headersObj.set("Content-Type", contentType);
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

  /**
   * Sends `body` serialised as `application/json`. Goes through the same path
   * as a string `send()`: the automatic `ETag` (when enabled) is computed over
   * the serialisation, then freshness turns a matching conditional request
   * into a 304 — as Express's `res.json` does via `res.send`.
   *
   * Any JSON-serialisable value is accepted — an object, array, string,
   * number, boolean or `null`. Pass `T` to check the body against a response
   * shape: `res.json<UserDto>(user)`. (`bigint` and `symbol`, which
   * `JSON.stringify` cannot serialise, are rejected.)
   */
  public json<T extends BunResponseBody>(body: T): BunResponse {
    this.options.headers = this.headersObj;
    this.headersObj.set("Content-Type", "application/json");
    this.#sentBody = body;
    return this.#respondWithText(JSON.stringify(body));
  }

  /**
   * Sends a JSONP response, as Express's `res.jsonp`. When the query carries a
   * `callback` parameter (the first, if repeated) the JSON is wrapped in a call
   * to it — the name restricted to `[]\w$.` characters, with the `/**\/`
   * Rosetta-Flash guard — and sent as `text/javascript`; otherwise it is plain
   * JSON. Both set `X-Content-Type-Options: nosniff`. The callback parameter
   * name is fixed at `callback` (Express's default; it has no app setting here).
   * As with {@link json}, `T` checks the body against a response shape.
   */
  public jsonp<T extends BunResponseBody>(body: T): BunResponse {
    let text: string | undefined = JSON.stringify(body);
    // `unknown`: an untrusted query value, narrowed below.
    let callback: unknown = this.req.query.callback;

    if (!this.hasHeader("Content-Type")) {
      this.set("X-Content-Type-Options", "nosniff");
      this.set("Content-Type", "application/json");
    }

    if (isArray(callback)) {
      callback = callback[0];
    }

    if (isString(callback) && callback.length !== 0) {
      this.set("X-Content-Type-Options", "nosniff");
      this.set("Content-Type", "text/javascript");

      const name = callback.replace(/[^[\]\w$.]/g, "");
      const payload =
        text === undefined
          ? ""
          : text.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
      text = `/**/ typeof ${name} === 'function' && ${name}(${payload});`;
    }

    return this.send(text);
  }

  /**
   * Express's `res.send` tail for 204/304/205, run after any `ETag` is set:
   * a fresh request becomes 304; 204 and 304 lose `Content-Type`,
   * `Content-Length` and `Transfer-Encoding`; 205 gets `Content-Length: 0`.
   * Returns `true` when the body must be dropped.
   */
  #applyFreshnessAndStrip(): boolean {
    if (this.req.fresh) {
      this.status(304);
    }

    const code = this.statusCode;
    if (code === 204 || code === 304) {
      this.removeHeader("Content-Type");
      this.removeHeader("Content-Length");
      this.removeHeader("Transfer-Encoding");
      return true;
    }

    if (code === 205) {
      this.set("Content-Length", "0");
      this.removeHeader("Transfer-Encoding");
      return true;
    }

    return false;
  }

  /**
   * Produces the response for a text body (a string `send()`, `json()`, a
   * number): `ETag` first, then freshness and header stripping, then
   * `text/plain` unless a Content-Type is already set. Synchronous.
   */
  #respondWithText(text: string): BunResponse {
    this.options.headers = this.headersObj;
    this.req.setResponse(this);

    if (this.#etagEnabled && text && !this.hasHeader("ETag")) {
      this.setHeader("ETag", etag(text));
    }

    if (this.#applyFreshnessAndStrip()) {
      this.response = new Response(null, this.options);
      return this;
    }

    if (!this.headersObj.has("content-type")) {
      this.headersObj.set("Content-Type", "text/plain");
    }

    if (this.#responseTransforms !== undefined) {
      this.#transformBody = text;
    }
    this.response = new Response(text, this.options);
    return this;
  }

  /**
   * Marks the response as a WebSocket upgrade, with `data` as the socket's
   * `ws.data`. Without `data`, it is built from the request — including
   * `port`, the port of the server that accepted it, when that server has one.
   *
   * `options.headers` go out on the `101 Switching Protocols` response —
   * for example `{ "Sec-WebSocket-Protocol": "chat.v1" }` to choose a
   * subprotocol. Headers set on this response any other way are not sent.
   * Each call replaces the headers of the one before.
   */
  public upgradeToWebsocket(
    data?: WebSocketClientData<customWebsocketDataType>,
    options?: UpgradeToWebsocketOptions,
  ) {
    let headers: Headers | undefined;
    if (options?.headers !== undefined) {
      headers = new Headers(options.headers);
      // An empty set is no headers: the upgrade then sends exactly what it
      // would without the option.
      if (headers.keys().next().done) {
        headers = undefined;
      }
    }
    this._upgradeToWsHeaders = headers;

    const port = this.req.server?.port;
    this._upgradeToWsData =
      data ||
      ({
        ...(typeof port === "number" && Number.isInteger(port) && port > 0
          ? { port }
          : {}),
        host: this.req.host,
        path: this.req.path,
        search: this.req.search,
        hash: this.req.hash,
        originalUrl: this.req.originalUrl,
        headers: this.req.headersObj,
        user: get<Record<string, unknown> | undefined>(
          this.req,
          "user",
          undefined,
        ),
        custom: {} as customWebsocketDataType,
      } satisfies WebSocketClientData<customWebsocketDataType>);
    return this;
  }

  public get upgradeToWsData() {
    return this._upgradeToWsData;
  }

  /**
   * The headers {@link upgradeToWebsocket} was given for the `101`, or
   * `undefined` when it was given none (or not called). Every server that
   * performs the upgrade passes them to `server.upgrade` as `headers`.
   */
  public get upgradeToWsHeaders(): Headers | undefined {
    return this._upgradeToWsHeaders;
  }

  /**
   * Builds the native response from `body`. Synchronous — no `await` is on the
   * hot path, so the router can dispatch a sync handler without a microtask
   * hop. (Sending a {@link BunResponse} whose response is not yet ready is the
   * one case that cannot resolve synchronously; it falls back to an empty
   * body — build that response before sending it.)
   *
   * Every body type `Bun.serve` can write is accepted:
   *
   * - `string` — sent as `text/plain` unless a Content-Type is already set.
   * - plain objects / arrays — serialised as `application/json`.
   * - binary: `Buffer`, any typed array, `DataView`, `ArrayBuffer`,
   *   `SharedArrayBuffer` — sent verbatim (only the view's byte window),
   *   defaulting to `application/octet-stream`.
   * - `Blob` / `BunFile` — streamed, carrying the blob's own type.
   * - `FormData` / `URLSearchParams` — encoded by Bun with the matching
   *   Content-Type (a multipart boundary is generated, so never pre-set it).
   * - `ReadableStream`, Node `Readable`, async iterables and
   *   `async function*` — streamed to the client.
   * - a `Response` or another {@link BunResponse} — passed through.
   *
   * With ETag enabled ({@link setEtag}) the tag is computed over the bytes of
   * a string, JSON or binary body; streamed bodies are never hashed. As in
   * Express, the tag is set **before** freshness is evaluated, so a request
   * whose `If-None-Match` matches the generated tag is answered 304.
   *
   * A number or boolean is sent as its string (`text/plain`) — note Express 5
   * sends those as JSON. `null`/`undefined` send an empty body with no
   * Content-Type, as Express does.
   */
  send(body: BunResponseBody): BunResponse {
    if (this.headersSent) {
      return this;
    }

    // Capture the body for inspection (see `getBody`) before any 204/304
    // stripping or serialisation rewrites it.
    this.#sentBody = body;

    // Fast path for the overwhelmingly common case: a string body. Testing
    // `typeof` first skips the type guards below, which against a value the
    // compiler only knows as a wide union are megamorphic and measured at
    // ~162ns.
    if (typeof body === "string") {
      return this.#respondWithText(body);
    }

    this.options.headers = this.headersObj;

    // Pass-through bodies carry their own status and headers; ours are merged
    // in only where the produced response lacks them.
    if (body instanceof BunResponse || body instanceof Response) {
      let response: Response;
      if (body instanceof Response) {
        response = body;
      } else {
        // Use the already-produced native response when available.
        const peeked = Bun.peek(body.getNativeResponse(0));
        if (!(peeked instanceof Response)) {
          this.response = new Response(undefined, this.options);
          return this;
        }
        response = peeked;
      }

      const respHeaders = response.headers;
      this.headersObj.forEach((headerValue, key) => {
        if (!respHeaders.has(key)) {
          respHeaders.set(key, headerValue);
        }
      });
      this.response = response;
      return this;
    }

    if (isNumber(body) || typeof body === "boolean") {
      return this.#respondWithText(String(body));
    }

    this.req.setResponse(this);

    if (isBinaryBody(body)) {
      // Binary bodies (Buffer, any typed array, DataView, ArrayBuffer,
      // SharedArrayBuffer) go to the socket verbatim — Bun writes the bytes
      // and sets Content-Length itself.
      if (this.#etagEnabled && !this.hasHeader("ETag")) {
        this.setHeader("ETag", etag(body));
      }

      if (this.#applyFreshnessAndStrip()) {
        this.response = new Response(null, this.options);
        return this;
      }

      // Express defaults a binary body to `application/octet-stream`; be
      // explicit rather than relying on Bun's own fallback.
      if (!this.headersObj.has("content-type")) {
        this.headersObj.set("Content-Type", "application/octet-stream");
      }

      this.response = new Response(
        body as ConstructorParameters<typeof Response>[0],
        this.options,
      );
      return this;
    }

    if (
      !(
        isNull(body) ||
        isUndefined(body) ||
        body instanceof Blob ||
        body instanceof ReadableStream ||
        isNodeReadableStream(body) ||
        body instanceof FormData ||
        body instanceof URLSearchParams ||
        isAsyncIterable(body) ||
        isAsyncGeneratorFunction(body)
      ) &&
      (isObject(body) || isArray(body))
    ) {
      this.headersObj.set("Content-Type", "application/json");
      return this.#respondWithText(JSON.stringify(body));
    }

    // Streamed or natively-encoded bodies (never hashed), and null/undefined.
    // `FormData`/`URLSearchParams` carry their own Content-Type (a multipart
    // one needs the generated boundary, so never pre-set it); async iterables
    // and `async function*` stream.
    if (this.#applyFreshnessAndStrip() || isNull(body) || isUndefined(body)) {
      this.response = new Response(null, this.options);
      return this;
    }

    this.response = new Response(
      body as ConstructorParameters<typeof Response>[0],
      this.options,
    );
    return this;
  }

  /**
   * Sets the status, reason phrase and headers, as Node's
   * `writeHead(statusCode[, statusMessage][, headers])`: `writeHead(404)`
   * alone sets the status. Also accepted, beyond Node: `(statusMessage,
   * headers)` and `(headers)`.
   */
  writeHead(
    statusCode: number,
    statusMessage: string,
    headers: WriteHeadersInput,
  ): this;
  writeHead(statusCode: number, statusMessage?: string): this;
  writeHead(statusCode: number, headers: WriteHeadersInput): this;
  writeHead(statusMessage: string, headers: WriteHeadersInput): this;
  writeHead(headers: WriteHeadersInput): this;
  writeHead(
    ...args:
      | [WriteHeadersInput]
      | [number, string?]
      | [number | string, WriteHeadersInput]
      | [number, string, WriteHeadersInput]
  ) {
    const [first, second, third] = args;
    let headers: WriteHeadersInput | undefined;
    let statusCode: number | undefined;
    let statusMessage: string | undefined;
    if (isNumber(first)) {
      statusCode = first;
      if (isString(second)) {
        statusMessage = second;
        headers = third;
      } else {
        headers = second;
      }
    } else if (isString(first)) {
      statusMessage = first;
      headers = isString(second) ? undefined : second;
    } else {
      headers = first;
    }

    if (headers !== undefined) {
      this.setHeaders(headers);
    }
    if (statusCode) {
      this.status(statusCode);
    }

    if (statusMessage) {
      this.statusText(statusMessage);
    }

    return this;
  }

  /**
   * Opens the long-lived streamed response that {@link write} and
   * {@link flushHeaders} start; `false` when it is already open.
   *
   * As Node's `ServerResponse`, no header is added or changed: the response
   * goes out with exactly the headers set so far. A server-sent events
   * endpoint sets `Content-Type: text/event-stream` (and any `Cache-Control`)
   * itself before the first write, as NestJS's `@Sse()` does.
   */
  public async initLongLivedConnection() {
    if (this._isLongLived) return false;
    this.req.socket.setKeepAlive(true);
    this.req.socket.setNoDelay(true);
    this.req.socket.setTimeout(0);

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

  /**
   * Sends the headers set so far and opens the streamed response, as Node's
   * `flushHeaders()`; it adds no header of its own.
   */
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
      this.#readableStreamEventMap?.clear();

      this.#readableStream = new ReadableStream(
        {
          pull: async (controller) => {
            this.#readableStreamController = controller;

            // Park until a write (or the end) notifies us instead of
            // busy-polling.
            if (
              (this.#readableStreamEventMap?.size ?? 0) === 0 &&
              !this.#streamEnding
            ) {
              this.#streamWriteNotifier = createDeferred<void>();
              await this.#streamWriteNotifier.promise;
              this.#streamWriteNotifier = undefined;
            }

            this.#flushPendingChunks(controller);
            if (this.#streamEnding) {
              this.#closeController(controller);
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

  /** Cancels the stream; `reason` is `unknown`, as `WritableStream.abort` takes any. */
  private async abortWritableStream(reason: unknown) {
    await this.#readableStream?.cancel(reason);
  }

  /** Enqueues every pending chunk, in arrival order, on `controller`. */
  #flushPendingChunks(controller: ReadableStreamDefaultController): void {
    const pending = this.#readableStreamEventMap;
    if (!pending || this.#streamClosed) {
      return;
    }

    for (const [key, value] of pending) {
      // Binary chunks (Buffer, typed array, DataView, ArrayBuffer) are
      // enqueued as bytes; anything else is text-encoded.
      controller.enqueue(
        isArrayBufferView(value)
          ? value
          : isAnyArrayBuffer(value)
            ? new Uint8Array(value)
            : textEncoder.encode(String(value)),
      );
      pending.delete(key);
    }
  }

  /** Closes `controller` once; a stream already cancelled is ignored. */
  #closeController(controller: ReadableStreamDefaultController): void {
    if (this.#streamClosed) {
      return;
    }
    this.#streamClosed = true;
    try {
      controller.close();
    } catch {
      // Already cancelled or errored by the client.
    }
  }

  /**
   * Ends the stream **after** every chunk written so far. Closing the
   * controller directly would drop chunks no `pull` had enqueued yet — and if
   * nothing had pulled, there is no controller to close, so the client would
   * wait forever.
   */
  private async closeWritableStream() {
    this.#streamEnding = true;

    // A parked pull wakes, flushes and closes.
    const notifier = this.#streamWriteNotifier;
    if (notifier) {
      notifier.resolve();
      return;
    }

    // An idle controller is flushed and closed now; with no controller yet,
    // the first pull does both.
    const controller = this.#readableStreamController;
    if (controller) {
      this.#flushPendingChunks(controller);
      this.#closeController(controller);
    }
  }

  private async writeToWritableStream(chunk: BunResponseChunk) {
    let key = String(Bun.nanoseconds());
    while (this.#pendingChunks.has(key)) {
      key = `${key}${Bun.nanoseconds()}`;
    }

    this.#pendingChunks.set(key, chunk);
    // Accumulate streamed chunks so `getBody()` can report them too — in the
    // response's own list, never an array body a caller passed to `send`.
    (this.#streamedChunks ??= []).push(chunk);
    this.#sentBody = this.#streamedChunks;
    // Wake any `pull` parked waiting for data.
    this.#streamWriteNotifier?.resolve();
    // The write buffer is unbounded, so the writer is always ready for more.
    this.#emitter?.emit("drain");
  }

  /** A writer onto the long-lived response stream; it takes {@link BunResponseChunk}s. */
  getWritable(): WritableStreamDefaultWriter<BunResponseChunk> {
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

  /**
   * Streams a chunk, opening the long-lived response on the first write, as
   * Node's `ServerResponse.write`. The first write sends the headers set so
   * far and adds none: set `Content-Type` (`text/event-stream` for
   * server-sent events) before it.
   *
   * - `true` while the response is open (the write buffer is unbounded);
   * - once it has ended (a body was sent, or `end()` called) nothing is
   *   written, it answers `false` and `ERR_STREAM_WRITE_AFTER_END` is emitted
   *   as an `error` event on the next tick;
   * - a chunk that is not text or bytes throws a `TypeError`
   *   (`ERR_INVALID_ARG_TYPE`; `null`: `ERR_STREAM_NULL_VALUES`).
   */
  write(chunk: BunResponseChunk): boolean {
    assertResponseChunk(chunk);
    if (this.#ended) {
      this.#emitWriteAfterEnd();
      return false;
    }

    if (!this._isLongLived) {
      this.initLongLivedConnection();
    }

    if (this._isLongLived) {
      this.getWritable()?.write(chunk);
    }

    return true;
  }

  /**
   * Finishes the response and resolves with it (Node's `res.end()` returns the
   * response). On a long-lived stream a given `chunk` is written as the last
   * one, then the stream ends after every chunk already written; otherwise
   * `chunk` is sent with {@link send}.
   *
   * As Node's `end(chunk)`, the chunk must be text or bytes — anything else
   * throws a `TypeError` with `code: "ERR_INVALID_ARG_TYPE"`, synchronously;
   * send an object with {@link json}/{@link send}. On a response that has
   * already ended, `end()` does nothing and `end(chunk)` also emits
   * `ERR_STREAM_WRITE_AFTER_END` (see {@link write}).
   */
  end(chunk?: BunResponseChunk | null): Promise<BunResponse> {
    const hasChunk = chunk !== undefined && chunk !== null;
    if (hasChunk) {
      assertResponseChunk(chunk);
    }

    if (this.#ended) {
      if (hasChunk) {
        this.#emitWriteAfterEnd();
      }
      return Promise.resolve(this);
    }

    return this.#endOpen(hasChunk ? chunk : undefined);
  }

  /** {@link end} on a response that has not ended yet. */
  async #endOpen(chunk: BunResponseChunk | undefined): Promise<BunResponse> {
    if (this._isLongLived) {
      if (chunk !== undefined) {
        this.write(chunk);
      }
      await this.endLongLivedConnection();
      return this;
    }

    return this.send(chunk);
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

      (this.#responseWaiters ??= []).push(waiter);

      if (enableTimeout) {
        timer = setTimeout(() => {
          const index = this.#responseWaiters?.indexOf(waiter) ?? -1;
          if (index !== -1) {
            this.#responseWaiters?.splice(index, 1);
          }
          reject(new Error("Request Timedout"));
        }, Number(timeout));
      }
    });
  }

  /**
   * The native `Response` if one has already been produced, otherwise
   * `undefined`.
   *
   * {@link getNativeResponse} always returns a promise, so awaiting it costs a
   * `Promise.resolve` plus a microtask tick even when the response is already
   * settled — which is the common case, since a handler that called `send()`
   * has produced it synchronously. Callers on a hot path can check this first
   * and skip both.
   */
  public get settledResponse(): Response | undefined {
    return this.#nativeResponse;
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
      // By entry, not `keys()` + `get()`: `get("set-cookie")` joins the lines
      // with commas, which `Expires` makes unsplittable. As Node's
      // `setHeaders`, every `Set-Cookie` line is gathered and set together.
      const list = headers as Headers | Map<string, string>;
      const cookies: string[] = [];
      for (const [key, value] of list.entries()) {
        if (!value) {
          continue;
        }
        if (key.toLowerCase() === "set-cookie") {
          cookies.push(value);
        } else {
          this.headersObj.set(key, value);
        }
      }
      if (cookies.length > 0) {
        this.setHeader("Set-Cookie", cookies);
      }
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

  /**
   * A response header set so far, case-insensitively, as Node's
   * `OutgoingMessage.getHeader`. `Set-Cookie` is the array of its lines
   * (`undefined` when none is set), so a line whose `Expires` holds a comma
   * stays whole — whether it came from `cookie()`, `setHeader` with an array
   * or `appendHeader`. Unlike Node, one line set as a string also comes back
   * as a one-element array: the header store keeps no record of the form.
   *
   * Any other header is one string, repeated values comma-joined, and `null`
   * when absent (`Headers.get`). The array type follows a literal name in any
   * letter case; a name typed only as `string` is typed `string | null` even
   * when it is `set-cookie`, as {@link get} does.
   */
  getHeader<N extends string>(
    name: N & SetCookieHeaderName<N>,
  ): string[] | undefined;
  getHeader(name: string): string | null;
  getHeader(name: string): string | string[] | null | undefined {
    if (name.toLowerCase() === "set-cookie") {
      const lines = this.headersObj.getSetCookie();
      return lines.length > 0 ? lines : undefined;
    }
    return this.headersObj.get(name);
  }

  /**
   * The lower-cased names of the headers set so far, each once, as Node's
   * `getHeaderNames()` (a `Headers` store lists `set-cookie` once per line).
   * In the order `Headers` iterates them, not Node's insertion order.
   */
  getHeaderNames(): string[] {
    return Array.from(new Set(this.headersObj.keys()));
  }

  /**
   * A snapshot of the headers set so far, as Node's `getHeaders()`: an object
   * with no prototype, keyed by lower-cased name, `set-cookie` the array of
   * its lines and every other header one string.
   */
  getHeaders(): BunResponseHeaders {
    const headers: BunResponseHeaders = Object.create(null);
    for (const [name, value] of this.headersObj) {
      if (name !== "set-cookie") {
        headers[name] = value;
      } else if (!headers["set-cookie"]) {
        headers["set-cookie"] = this.headersObj.getSetCookie();
      }
    }
    return headers;
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
  getBody(): BunResponseSentBody {
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

  /**
   * Sets `Content-Disposition: attachment`, as Express's `res.attachment`.
   * With a `filename`, its **basename** is the `filename` parameter (with an
   * RFC 5987 `filename*` for non-ISO-8859-1 names) and `Content-Type` is set
   * from its extension. The file system is not consulted, so the name need
   * not exist. Synchronous; awaiting it still works.
   */
  attachment(filename?: string): BunResponse {
    if (filename) {
      this.type(extname(filename));
    }

    this.headersObj.set("Content-Disposition", contentDisposition(filename));
    return this;
  }

  /**
   * Sends the file as an attachment (`sendFile` with `download: true`), then
   * calls `cb` with no arguments; its return value is ignored.
   */
  async download(
    path: string,
    filename?: string,
    options?: SendFileCallOptions,
    cb?: () => void,
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

  /**
   * Answers with an empty body and the given status (and its standard reason
   * phrase), keeping headers already set — the outcome of a failed `sendFile`.
   */
  #respondWithStatus(code: number): BunResponse {
    this.options.status = code;
    this.options.statusText = STATUS_CODES[code] ?? "";
    this.options.headers = this.headersObj;
    this.response = new Response(null, this.options);
    return this;
  }

  /**
   * Streams a file, with the semantics of Express 5 `res.sendFile` (the `send`
   * package) for every option:
   *
   * - `path` must be absolute unless `root` is given (a `TypeError` otherwise,
   *   as in Express). With `root`, `path` — even an absolute one — is resolved
   *   **under** `root`; a `..` segment answers 403 and a NUL byte 400.
   * - `dotfiles` (`"ignore"` default → 404, `"deny"` → 403, `"allow"`).
   * - `headers` are applied first, so they win over the defaults below.
   * - `acceptRanges` (default `true`): `Accept-Ranges: bytes`, a single
   *   satisfiable `Range` → 206 with `Content-Range`, an unsatisfiable one →
   *   416; `If-Range` is honoured. Several ranges send the whole file.
   * - `cacheControl` (default `true`): when no `Cache-Control` is set, writes
   *   `public, max-age=<maxAge in seconds>` (plus `, immutable` with
   *   `immutable`). `maxAge` is milliseconds or an `ms` string (`"1d"`),
   *   capped at a year. An existing `Cache-Control` is left alone.
   * - `lastModified` (default `true`): the file's mtime, unless already set.
   * - With ETag enabled ({@link setEtag}), a weak `ETag` from size and mtime.
   * - Conditional requests: a failed `If-Match`/`If-Unmodified-Since` → 412;
   *   a fresh `If-None-Match`/`If-Modified-Since` → 304.
   *
   * Where Express passes an error to `next` (missing file, directory, 403…)
   * this answers directly with that status and an empty body, since there is
   * no callback here. `download`/`filename` add `Content-Disposition`.
   */
  async sendFile(
    path: string,
    options?: SendFileCallOptions,
  ): Promise<BunResponse> {
    const opts = options ?? {};

    if (!isString(path) || !path) {
      throw new TypeError("path argument is required to res.sendFile");
    }
    if (!opts.root && !isAbsolute(path)) {
      throw new TypeError(
        "path must be absolute or specify root to res.sendFile",
      );
    }

    const dotfiles = opts.dotfiles ?? "ignore";
    if (dotfiles !== "ignore" && dotfiles !== "allow" && dotfiles !== "deny") {
      throw new TypeError(
        'dotfiles option must be "allow", "deny", or "ignore"',
      );
    }

    if (path.includes("\0")) {
      return this.#respondWithStatus(400);
    }

    let fullPath: string;
    let parts: string[];
    if (opts.root) {
      const relative = normalize(`.${sep}${path}`);
      if (UP_PATH_REGEXP.test(relative)) {
        return this.#respondWithStatus(403);
      }
      parts = relative.split(sep);
      fullPath = normalize(joinPath(resolvePath(opts.root), relative));
    } else {
      if (UP_PATH_REGEXP.test(path)) {
        return this.#respondWithStatus(403);
      }
      parts = normalize(path).split(sep);
      fullPath = resolvePath(path);
    }

    if (parts.some((part) => part.length > 1 && part[0] === ".")) {
      if (dotfiles === "deny") {
        return this.#respondWithStatus(403);
      }
      if (dotfiles === "ignore") {
        return this.#respondWithStatus(404);
      }
    }

    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(fullPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return this.#respondWithStatus(
        code === "ENOENT" || code === "ENAMETOOLONG" || code === "ENOTDIR"
          ? 404
          : 500,
      );
    }

    if (stats.isDirectory()) {
      return this.#respondWithStatus(404);
    }

    if (this.headersSent) {
      return this;
    }

    const acceptRanges = opts.acceptRanges ?? opts.accepRanges ?? true;
    const cacheControl = opts.cacheControl ?? true;
    const lastModified = opts.lastModified ?? true;

    if (isObject(opts.headers)) {
      each(opts.headers, (value, key) => {
        this.headersObj.set(key, String(value));
      });
    }

    if (opts.download) {
      this.headersObj.set(
        "Content-Disposition",
        contentDisposition(opts.filename ?? fullPath),
      );
    }

    if (acceptRanges && !this.hasHeader("Accept-Ranges")) {
      this.headersObj.set("Accept-Ranges", "bytes");
    }

    if (cacheControl && !this.hasHeader("Cache-Control")) {
      const seconds = Math.floor(maxAgeToMs(opts.maxAge) / 1000);
      this.headersObj.set(
        "Cache-Control",
        `public, max-age=${seconds}${opts.immutable ? ", immutable" : ""}`,
      );
    }

    if (lastModified && !this.hasHeader("Last-Modified")) {
      this.headersObj.set("Last-Modified", toHttpDate(stats.mtime));
    }

    if (this.#etagEnabled && !this.hasHeader("ETag")) {
      this.headersObj.set(
        "ETag",
        `W/"${stats.size.toString(16)}-${stats.mtime.getTime().toString(16)}"`,
      );
    }

    const file = Bun.file(fullPath);
    if (!this.hasHeader("Content-Type")) {
      this.headersObj.set(
        "Content-Type",
        file.type || "application/octet-stream",
      );
    }

    this.options.headers = this.headersObj;
    this.req.setResponse(this);

    // Conditional GET.
    if (this.#isPreconditionFailure()) {
      return this.#respondWithStatus(412);
    }
    const status = this.statusCode;
    if (((status >= 200 && status < 300) || status === 304) && this.req.fresh) {
      for (const name of [
        "Content-Encoding",
        "Content-Language",
        "Content-Length",
        "Content-Range",
        "Content-Type",
      ]) {
        this.headersObj.delete(name);
      }
      return this.#respondWithStatus(304);
    }

    // Range support.
    let body: Blob = file;
    const rangeHeader = this.req.getHeader("Range");
    if (acceptRanges && rangeHeader && /^ *bytes=/.test(rangeHeader)) {
      let ranges = rangeParser(stats.size, rangeHeader, { combine: true });
      if (!this.#isRangeFresh()) {
        ranges = -2;
      }

      if (ranges === -1) {
        this.headersObj.set("Content-Range", `bytes */${stats.size}`);
        return this.#respondWithStatus(416);
      }

      if (ranges !== -2 && ranges.length === 1) {
        const [{ start, end }] = ranges;
        this.status(206);
        this.headersObj.set(
          "Content-Range",
          `bytes ${start}-${end}/${stats.size}`,
        );
        body = file.slice(start, end + 1);
      }
    }

    if (this.#responseTransforms !== undefined) {
      this.#transformBody = body;
    }
    this.response = new Response(body, this.options);
    return this;
  }

  /** `send`'s `isPreconditionFailure`: a failed `If-Match` or `If-Unmodified-Since`. */
  #isPreconditionFailure(): boolean {
    const match = this.req.getHeader("If-Match");
    if (match) {
      const tag = this.headersObj.get("ETag");
      return (
        !tag ||
        (match !== "*" &&
          parseTokenList(match).every(
            (candidate) =>
              candidate !== tag &&
              candidate !== `W/${tag}` &&
              `W/${candidate}` !== tag,
          ))
      );
    }

    const unmodifiedSince = Date.parse(
      this.req.getHeader("If-Unmodified-Since") ?? "",
    );
    if (!Number.isNaN(unmodifiedSince)) {
      const modified = Date.parse(this.headersObj.get("Last-Modified") ?? "");
      return Number.isNaN(modified) || modified > unmodifiedSince;
    }

    return false;
  }

  /** `send`'s `isRangeFresh`: whether `If-Range` still matches the file. */
  #isRangeFresh(): boolean {
    const ifRange = this.req.getHeader("If-Range");
    if (!ifRange) {
      return true;
    }

    if (ifRange.includes('"')) {
      const tag = this.headersObj.get("ETag");
      return Boolean(tag && ifRange.includes(tag));
    }

    return (
      Date.parse(this.headersObj.get("Last-Modified") ?? "") <=
      Date.parse(ifRange)
    );
  }

  /**
   * A response header set so far, case-insensitively: `undefined` when
   * absent, or `defaultVal` when one is given. A repeated header comes back
   * comma-joined, as `Headers.get` does — except `Set-Cookie`, which is an
   * array of its lines (`Headers.getSetCookie()`), as Node's
   * `res.getHeader("set-cookie")` after `res.cookie()`. The array type follows
   * a literal name in any letter case; a name typed only as `string` is typed
   * `string | undefined` even when it is `set-cookie`.
   */
  public get<N extends string>(
    name: N & SetCookieHeaderName<N>,
  ): string[] | undefined;
  public get<N extends string>(
    name: N & SetCookieHeaderName<N>,
    defaultVal: string[],
  ): string[];
  public get<N extends string>(
    name: N & SetCookieHeaderName<N>,
    defaultVal: string,
  ): string[] | string;
  public get(name: string): string | undefined;
  public get(name: string, defaultVal: string): string;
  public get(name: string, defaultVal: string[]): string | string[];
  public get(
    name: string,
    defaultVal?: string | string[],
  ): string | string[] | undefined;
  public get(
    name: string,
    defaultVal?: string | string[],
  ): string | string[] | undefined {
    if (name.toLowerCase() === "set-cookie") {
      const lines = this.headersObj.getSetCookie();
      return lines.length > 0 ? lines : defaultVal;
    }

    const value = this.headersObj.get(name);
    if (!isString(value)) {
      return defaultVal;
    }

    return value;
  }

  /**
   * Sets the status and sends its standard reason phrase as a `text/plain`
   * body (`404` → `"Not Found"`; an unknown code → the code itself), as
   * Express's `res.sendStatus`. Answers `undefined` once headers are sent.
   */
  public sendStatus(status: number): BunResponse | undefined {
    if (this.headersSent) {
      return;
    }

    this.status(status);
    this.type("txt");
    return this.send(STATUS_CODES[status] ?? String(status));
  }

  public set(name: string, value: string | string[], replace = true) {
    return this.setHeader(name, value, replace);
  }

  /**
   * Sets `Location`, URL-encoded. `"back"` resolves to the request's
   * `Referer` (or the non-standard `Referrer`), else `/` — the Express 4
   * alias, kept here for compatibility although Express 5 dropped it and sets
   * the literal value.
   */
  public location(url: string) {
    let loc = String(url);

    if (url === "back") {
      const referer =
        this.req.getHeader("Referer") ?? this.req.getHeader("Referrer");
      loc = referer || "/";
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

  /**
   * Appends a `Set-Cookie`, as Express's `res.cookie`. An object `value` is
   * written as a `j:` JSON cookie; `signed` signs it (`s:`) with
   * `opts.secret` or `req.secret`; `maxAge` is milliseconds (a number or
   * numeric string); `path` defaults to `/`. The caller's `opts` object is not
   * modified.
   */
  public cookie(name: string, value: CookieValue, opts?: BunCookieOptions) {
    const { signed, secret: optsSecret, maxAge, ...rest } = opts ?? {};
    const options: CookieSerializeOptions = { ...rest };

    let secret = optsSecret || this.req.secret;
    if (isArray(secret)) {
      secret = secret[0];
    }

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

    if (isNumeric(maxAge)) {
      const ms = Number(maxAge);
      options.expires = new Date(Date.now() + ms);
      options.maxAge = Math.floor(ms / 1000);
    }

    options.path ??= "/";

    this.append("Set-Cookie", serializeCookie(name, val, options));

    return this;
  }

  public clearCookie(name: string, opts?: BunCookieOptions) {
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

  /**
   * Content negotiation, as Express's `res.format`: runs the handler whose key
   * best matches `Accept` (setting its Content-Type), else `default`. With no
   * match and no `default`, Express calls `next()` with a 406 error carrying
   * the acceptable `types`; here that error goes to `req.next` when the
   * pipeline provides one, and otherwise the response is answered **406 Not
   * Acceptable** directly, so the request never hangs.
   */
  public format(obj: Record<string, RouterMiddlewareHandler>) {
    const req = this.req;
    const pipelineNext = req.next;
    const next: NextFunction = pipelineNext ?? (() => undefined);

    const keys = Object.keys(obj).filter(function (v) {
      return v !== "default";
    });

    const key = keys.length > 0 ? req.accepts(keys) : false;
    // With types given, `accepts` answers the best match or `false`.
    const keyStr = isString(key) ? key : "";
    const matchedType = keyStr ? getMimeFromStr(keyStr) : "";
    this.vary("Accept");

    if (matchedType) {
      this.set("Content-Type", matchedType);
      obj[keyStr](req, this, next);
    } else if (obj.default) {
      obj.default(req, this, next);
    } else if (pipelineNext) {
      pipelineNext(
        Object.assign(new Error("Not Acceptable"), {
          status: 406,
          statusCode: 406,
          expose: true,
          types: keys.map((type) => getMimeFromStr(type) ?? type),
        }),
      );
    } else {
      this.#respondWithStatus(406);
    }

    return this;
  }
}
