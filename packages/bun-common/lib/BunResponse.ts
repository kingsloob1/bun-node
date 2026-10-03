import type { BunFile } from "bun";
import type { Readable } from "node:stream";
import type { BunRequest, SetCookieHeaderName } from "./BunRequest";
import type {
  TypedEmitter,
  WebSocketClientData,
  WebSocketUpgradeDefaults,
} from "./BunWebSocket";
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
import { mergeUpgradeHeaders } from "./utils/wsUpgrade";

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
   * `server.upgrade` as its `headers`. Default: none. Merged over the
   * router's `webSocketUpgradeHeaders` and the response's own (unless
   * {@link inherit} is `false`), a name given here replacing every value of
   * that name beneath. Headers set on the response through `setHeader`/`set`
   * are never sent. A `Sec-WebSocket-Protocol` here replaces Bun's default,
   * which echoes the first protocol the client offered, so it is how a server
   * picks a subprotocol.
   */
  headers?: Bun.HeadersInit;
  /**
   * Whether the router- and response-level upgrade values apply beneath this
   * call's arguments: `webSocketUpgradeHeaders` under {@link headers}, and —
   * only when no `data` is passed — `webSocketUpgradeData` over the data
   * built from the request. Default `true`. With `false` only this call's
   * arguments count, exactly as before those layers existed.
   */
  inherit?: boolean;
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
 * How a response tags a body with an `ETag` (see {@link BunResponse.etag}):
 * off, on (strong), `"weak"`, `"strong"`, or a function returning the tag
 * (or `undefined` for none), as Express's `etag` setting.
 */
export type EtagOption =
  | boolean
  | "weak"
  | "strong"
  | ((body: string | Uint8Array) => string | undefined);

/**
 * `option` checked: `undefined` is `false`.
 *
 * @throws TypeError for anything else that is not an {@link EtagOption}.
 */
export function normalizeEtagOption(
  option: EtagOption | undefined,
): EtagOption {
  if (option === undefined) {
    return false;
  }
  if (
    typeof option === "boolean" ||
    option === "weak" ||
    option === "strong" ||
    typeof option === "function"
  ) {
    return option;
  }
  throw new TypeError(
    `etag must be a boolean, "weak", "strong" or a function; got ${String(option)}`,
  );
}

/**
 * The default `Content-Type` of a text body: what Bun itself writes for a
 * string body, so a response sent with no headers and one sent with others
 * carry the same type.
 */
const TEXT_CONTENT_TYPE = "text/plain;charset=utf-8";

/** The `Content-Type` of a JSON body: what `Response.json` sets. */
const JSON_CONTENT_TYPE = "application/json;charset=utf-8";

/** A shared, never-written `Headers` that header reads see before any exist. */
const NO_HEADERS = new Headers();

/**
 * Text responses sent with no `Headers` object, whose `Content-Type` Bun adds
 * only on the wire. A socket-free `fetch()` adds it to them (see
 * {@link toFetchResponse}) so it answers as a served request does.
 */
const IMPLICIT_TEXT_RESPONSES = new WeakSet<Response>();

/**
 * `response` as a served request's client would see it, for a socket-free
 * `fetch()`: the `Content-Type` Bun writes for a text body sent without
 * headers, and no body in answer to `HEAD` (Bun drops it on the wire).
 */
export function toFetchResponse(response: Response, method: string): Response {
  if (
    IMPLICIT_TEXT_RESPONSES.has(response) &&
    !response.headers.has("content-type")
  ) {
    response.headers.set("Content-Type", TEXT_CONTENT_TYPE);
  }
  if (method.toUpperCase() !== "HEAD" || response.body === null) {
    return response;
  }
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

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

/**
 * BunResponse's rarely-used state (see its `#state`): one object,
 * allocated only when one of these fields is first written.
 */
class BunResponseState<customWebsocketDataType = unknown> {
  /** Backs BunResponse's `_upgradeToWsData`; see its documentation there. */
  _upgradeToWsData: WebSocketClientData<customWebsocketDataType> | undefined =
    undefined;

  /** Backs BunResponse's `_upgradeToWsHeaders`; see its documentation there. */
  _upgradeToWsHeaders: Headers | undefined = undefined;
  /** Backs BunResponse's `_webSocketUpgradeHeaders`; see its documentation there. */
  _webSocketUpgradeHeaders: Headers | undefined = undefined;
  /** Backs BunResponse's `_webSocketUpgradeData`; see its documentation there. */
  _webSocketUpgradeData:
    | Partial<WebSocketClientData<customWebsocketDataType>>
    | undefined = undefined;

  /** Backs BunResponse's `#responseWaiters`; see its documentation there. */
  responseWaiters: ((response: Response) => void)[] | undefined = undefined;
  /** Backs BunResponse's `_isLongLived`; see its documentation there. */
  _isLongLived: boolean = false;
  /** Backs BunResponse's `#readableStream`; see its documentation there. */
  readableStream: ReadableStream | undefined = undefined;
  /** Backs BunResponse's `#readableStreamController`; see its documentation there. */
  readableStreamController: ReadableStreamDefaultController | undefined =
    undefined;

  /** Backs BunResponse's `#readableStreamClosePromise`; see its documentation there. */
  readableStreamClosePromise: Promise<undefined> | undefined = undefined;
  /** Backs BunResponse's `#readableStreamCloseResolve`; see its documentation there. */
  readableStreamCloseResolve: (() => void) | undefined = undefined;
  /** Backs BunResponse's `#readableStreamEventMap`; see its documentation there. */
  readableStreamEventMap:
    | Map<string, string | ArrayBufferView | ArrayBufferLike>
    | undefined = undefined;

  /** Backs BunResponse's `#streamWriteNotifier`; see its documentation there. */
  streamWriteNotifier: Deferred<void> | undefined = undefined;
  /** Backs BunResponse's `#streamEnding`; see its documentation there. */
  streamEnding: boolean = false;
  /** Backs BunResponse's `#streamClosed`; see its documentation there. */
  streamClosed: boolean = false;
  /** Backs BunResponse's `#destroyedWith`; see its documentation there. */
  destroyedWith: unknown = undefined;
  /** Backs BunResponse's `#destroyed`; see its documentation there. */
  destroyed: boolean = false;
  /** Backs BunResponse's `#streamEndWaiters`; see its documentation there. */
  streamEndWaiters: (() => void)[] | undefined = undefined;
  /** Backs BunResponse's `#emitter`; see its documentation there. */
  emitter: EventEmitter | undefined = undefined;
  /** Backs BunResponse's `#finishEmitted`; see its documentation there. */
  finishEmitted: boolean = false;
  /** Backs BunResponse's `#closeEmitted`; see its documentation there. */
  closeEmitted: boolean = false;
  /** Backs BunResponse's `#streamedChunks`; see its documentation there. */
  streamedChunks: BunResponseChunk[] | undefined = undefined;
  /** Backs BunResponse's `#responseTransforms`; see its documentation there. */
  responseTransforms: BunResponseTransform[] | undefined = undefined;
  /** Backs BunResponse's `#transformBody`; see its documentation there. */
  transformBody: BunResponseTransformBody | undefined = undefined;
}

export class BunResponse<
  /**
   * The `custom` data of a WebSocket this response upgrades to. `unknown`
   * until declared, matching `BunWebSocket`: it is whatever the caller's
   * `onUpgrade` hook returns as `custom`.
   */
  customWebsocketDataType = unknown,
> implements TypedEmitter<BunResponseEvents> {
  /**
   * Rarely-used state, created on first write. Each field moved here is an
   * accessor that reads its default until then, so a request or response that
   * never touches it pays no per-field initialisation (about 6 ns each).
   */
  #state: BunResponseState<customWebsocketDataType> | undefined = undefined;

  private get _upgradeToWsData():
    | WebSocketClientData<customWebsocketDataType>
    | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder._upgradeToWsData;
  }

  private set _upgradeToWsData(
    value: WebSocketClientData<customWebsocketDataType> | undefined,
  ) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>())._upgradeToWsData = value;
  }

  /**
   * Headers for the `101` of a WebSocket upgrade, as {@link upgradeToWebsocket}
   * merged them; `undefined` when no layer had any, so the upgrade sends
   * exactly Bun's default.
   */
  private get _upgradeToWsHeaders(): Headers | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder._upgradeToWsHeaders;
  }

  private set _upgradeToWsHeaders(value: Headers | undefined) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>())._upgradeToWsHeaders =
      value;
  }

  /** Per-request `101` headers — see {@link webSocketUpgradeHeaders}. */
  private get _webSocketUpgradeHeaders(): Headers | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder._webSocketUpgradeHeaders;
  }

  private set _webSocketUpgradeHeaders(value: Headers | undefined) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>())._webSocketUpgradeHeaders =
      value;
  }

  /** Per-request `ws.data` values — see {@link webSocketUpgradeData}. */
  private get _webSocketUpgradeData():
    | Partial<WebSocketClientData<customWebsocketDataType>>
    | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder._webSocketUpgradeData;
  }

  private set _webSocketUpgradeData(
    value: Partial<WebSocketClientData<customWebsocketDataType>> | undefined,
  ) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>())._webSocketUpgradeData =
      value;
  }

  /**
   * Where router-wide upgrade defaults (`webSocketUpgradeHeaders`,
   * `webSocketUpgradeData`) are read from by a bare
   * {@link upgradeToWebsocket}. `BunRouter.handle()` sets it to the router
   * running the request — the outermost one, when one router's pipeline runs
   * another's — unless something set it first. `undefined` outside a router
   * (a response built by hand), meaning no router layer.
   */
  public webSocketUpgradeDefaults: WebSocketUpgradeDefaults | undefined =
    undefined;

  #nativeResponse: Response | undefined = undefined;
  /**
   * Resolvers awaiting the native `Response` (see {@link getNativeResponse}).
   * Allocated on the first waiter — a response nobody awaits costs no array.
   */
  get #responseWaiters(): ((response: Response) => void)[] | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder.responseWaiters;
  }

  set #responseWaiters(value: ((response: Response) => void)[] | undefined) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).responseWaiters = value;
  }

  private options: Writable<ResponseInit> = {};
  /**
   * The headers set so far; `undefined` until the first write (see
   * {@link headersObj}). A response that never sets one is sent without a
   * `Headers` object at all — see {@link #canSkipHeaders}.
   */
  #headers: Headers | undefined = undefined;

  /**
   * The `Content-Type` a response sent without headers carries — the one Bun
   * (or `Response.json`) gives it — so reading the headers after the send
   * still reports it. `undefined` otherwise.
   */
  #implicitContentType: string | undefined = undefined;

  /**
   * The headers, created on first use. A response sent without headers
   * starts them with the `Content-Type` it was sent with.
   */
  private get headersObj(): Headers {
    if (this.#headers === undefined) {
      this.#headers = new Headers();
      if (this.#implicitContentType !== undefined) {
        this.#headers.set("Content-Type", this.#implicitContentType);
      }
    }
    return this.#headers;
  }

  /**
   * The headers for a read: the real ones once any exist, a shared empty set
   * otherwise — so reading (`getHeader`, `hasHeader`, …) never creates them
   * and never takes a response off the no-headers path.
   */
  get #readableHeaders(): Headers {
    if (
      this.#headers !== undefined ||
      this.#implicitContentType !== undefined
    ) {
      return this.headersObj;
    }
    return NO_HEADERS;
  }

  /**
   * Whether the body can be sent without a `Headers` object: nothing set a
   * header (or passed one in the init), no `ETag` is to be computed and no
   * transform (`compression()`) will rewrite the response, and the request
   * is not `HEAD`. Freshness needs a validator header, so it cannot apply
   * either.
   */
  #canSkipHeaders(): boolean {
    return (
      this.#headers === undefined &&
      // Bun leaves the type off a served HEAD response it has no headers
      // for, while GET gets it; HEAD carries it explicitly instead.
      this.req.method !== "HEAD" &&
      this.options.headers === undefined &&
      !this.#etagEnabled &&
      this.#responseTransforms === undefined
    );
  }

  /** The init for a response sent without headers: status and reason only. */
  #initWithoutHeaders(): ResponseInit | undefined {
    const { status, statusText } = this.options;
    if (status === undefined && statusText === undefined) {
      return undefined;
    }
    return { status, statusText };
  }

  private get _isLongLived(): boolean {
    const holder = this.#state;
    return holder === undefined ? false : holder._isLongLived;
  }

  private set _isLongLived(value: boolean) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>())._isLongLived = value;
  }

  get #readableStream(): ReadableStream | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder.readableStream;
  }

  set #readableStream(value: ReadableStream | undefined) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).readableStream = value;
  }

  get #readableStreamController(): ReadableStreamDefaultController | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder.readableStreamController;
  }

  set #readableStreamController(
    value: ReadableStreamDefaultController | undefined,
  ) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).readableStreamController =
      value;
  }

  get #readableStreamClosePromise(): Promise<undefined> | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder.readableStreamClosePromise;
  }

  set #readableStreamClosePromise(value: Promise<undefined> | undefined) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).readableStreamClosePromise =
      value;
  }

  get #readableStreamCloseResolve(): (() => void) | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder.readableStreamCloseResolve;
  }

  set #readableStreamCloseResolve(value: (() => void) | undefined) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).readableStreamCloseResolve =
      value;
  }

  /**
   * Chunks written but not yet enqueued on {@link readableStream}, keyed by an
   * arrival-ordered token. Values are text or binary (`Buffer`, typed array,
   * `DataView`, `ArrayBuffer`); binary is enqueued verbatim.
   */
  get #readableStreamEventMap():
    | Map<string, string | ArrayBufferView | ArrayBufferLike>
    | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder.readableStreamEventMap;
  }

  set #readableStreamEventMap(
    value: Map<string, string | ArrayBufferView | ArrayBufferLike> | undefined,
  ) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).readableStreamEventMap =
      value;
  }

  /** The pending-chunk map, created on the first buffered write. */
  get #pendingChunks(): Map<
    string,
    string | ArrayBufferView | ArrayBufferLike
  > {
    return (this.#readableStreamEventMap ??= new Map());
  }

  /** Notifies a parked stream `pull` that data is available to enqueue. */
  get #streamWriteNotifier(): Deferred<void> | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder.streamWriteNotifier;
  }

  set #streamWriteNotifier(value: Deferred<void> | undefined) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).streamWriteNotifier =
      value;
  }

  /**
   * Set once the stream has been asked to end. The pending chunks are still
   * flushed first: by the parked `pull` when one is waiting, immediately when
   * the controller is idle, or by the first `pull` when nothing has read yet.
   */
  get #streamEnding(): boolean {
    const holder = this.#state;
    return holder === undefined ? false : holder.streamEnding;
  }

  set #streamEnding(value: boolean) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).streamEnding = value;
  }

  /** True once the stream's controller has been closed (closing is once-only). */
  get #streamClosed(): boolean {
    const holder = this.#state;
    return holder === undefined ? false : holder.streamClosed;
  }

  set #streamClosed(value: boolean) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).streamClosed = value;
  }

  /**
   * Why {@link destroy} ended the stream, once it has; `undefined` otherwise.
   * A `pull` that runs later errors the stream with it.
   */
  get #destroyedWith(): unknown {
    const holder = this.#state;
    return holder === undefined ? undefined : holder.destroyedWith;
  }

  set #destroyedWith(value: unknown) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).destroyedWith = value;
  }

  /** True once {@link destroy} has run. */
  get #destroyed(): boolean {
    const holder = this.#state;
    return holder === undefined ? false : holder.destroyed;
  }

  set #destroyed(value: boolean) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).destroyed = value;
  }

  /**
   * Called once when a streamed response ends — `end()`, the client leaving
   * or {@link destroy}. See {@link onceStreamEnded}.
   */
  get #streamEndWaiters(): (() => void)[] | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder.streamEndWaiters;
  }

  set #streamEndWaiters(value: (() => void)[] | undefined) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).streamEndWaiters = value;
  }

  /**
   * How {@link send} tags a body with an `ETag` — see {@link etag}. Starts as
   * the adapter's `etag` option (`false` by default).
   */
  #etag: EtagOption;

  /**
   * Lazily-created event bus mirroring Node's `http.ServerResponse` events
   * (`finish`, `close`, `error`, `pipe`, `unpipe`, `drain`, …). It is built
   * only when the first listener is registered, so a response nobody listens
   * to costs nothing.
   */
  get #emitter(): EventEmitter | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder.emitter;
  }

  set #emitter(value: EventEmitter | undefined) {
    (this.#state ??= new BunResponseState<customWebsocketDataType>()).emitter =
      value;
  }

  get #finishEmitted(): boolean {
    const holder = this.#state;
    return holder === undefined ? false : holder.finishEmitted;
  }

  set #finishEmitted(value: boolean) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).finishEmitted = value;
  }

  get #closeEmitted(): boolean {
    const holder = this.#state;
    return holder === undefined ? false : holder.closeEmitted;
  }

  set #closeEmitted(value: boolean) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).closeEmitted = value;
  }

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
  get #streamedChunks(): BunResponseChunk[] | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder.streamedChunks;
  }

  set #streamedChunks(value: BunResponseChunk[] | undefined) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).streamedChunks = value;
  }

  /**
   * Transforms run on the native `Response` as it is produced, in
   * registration order — see {@link addResponseTransform}. `undefined` until
   * the first is added, so a response without one pays a single check.
   */
  get #responseTransforms(): BunResponseTransform[] | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder.responseTransforms;
  }

  set #responseTransforms(value: BunResponseTransform[] | undefined) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).responseTransforms =
      value;
  }

  /**
   * The buffered body of the `Response` about to be produced, when `send`'s
   * captured body is not it (serialised JSON text, a `sendFile` slice).
   * Recorded only while a transform is registered; cleared once read.
   */
  get #transformBody(): BunResponseTransformBody | undefined {
    const holder = this.#state;
    return holder === undefined ? undefined : holder.transformBody;
  }

  set #transformBody(value: BunResponseTransformBody | undefined) {
    (this.#state ??=
      new BunResponseState<customWebsocketDataType>()).transformBody = value;
  }

  constructor(
    /** The {@link BunRequest} this response is paired with (one per request). */
    public req: BunRequest,
    options?: {
      /**
       * How this response tags a body with an `ETag` — see {@link etag}.
       * Opt-in because hashing every body has a measurable per-request cost;
       * defaults to `false`. The adapters pass their `etag` option; change it
       * per response with {@link setEtag} or {@link etag}.
       */
      etag?: EtagOption;
    },
  ) {
    this.#etag = normalizeEtagOption(options?.etag);
    // Bind the pair at construction, as Express does with `req.res`, so
    // `req.fresh` / `req.stale` can be computed from the moment the response
    // exists — not only once `send()` runs.
    req.setResponse(this);
  }

  /**
   * How this response tags a body with an `ETag`, overruling the adapter's
   * `etag` option for this response only (as Express's `etag` setting, per
   * response):
   *
   * - `false` — no `ETag`;
   * - `true` or `"strong"` — a strong tag over the body's bytes
   *   (`"<length>-<hash>"`);
   * - `"weak"` — the same tag, weak (`W/"<length>-<hash>"`);
   * - a function `(body) => string | undefined` — the tag to send (quoted,
   *   `W/` for a weak one), or `undefined` for none. It receives a text body
   *   as a string and a binary one as bytes.
   *
   * A tag set by hand (`res.set("ETag", …)`) always wins. Files sent with
   * `sendFile` get the weak size-and-mtime tag whenever this is not `false`.
   * A request whose `If-None-Match` matches the tag is answered `304`.
   */
  get etag(): EtagOption {
    return this.#etag;
  }

  set etag(option: EtagOption) {
    this.#etag = normalizeEtagOption(option);
  }

  /**
   * Sets {@link etag} — how (and whether) this response is tagged — and
   * returns the response. `setEtag()` alone turns it on; `setEtag(false)`
   * turns it off even when the adapter's `etag` option is on.
   */
  public setEtag(option: EtagOption = true): BunResponse {
    this.etag = option;
    return this;
  }

  /** Whether any `ETag` is to be generated for this response. */
  get #etagEnabled(): boolean {
    return this.#etag !== false;
  }

  /**
   * The `ETag` for `body` under {@link etag}, or `undefined` for none (off,
   * or a function that returned nothing).
   */
  #etagFor(
    body: string | ArrayBufferView | ArrayBufferLike,
  ): string | undefined {
    const option = this.#etag;
    if (option === false) {
      return undefined;
    }
    if (typeof option === "function") {
      const tag = option(
        typeof body === "string"
          ? body
          : ArrayBuffer.isView(body)
            ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
            : new Uint8Array(body as ArrayBuffer),
      );
      return typeof tag === "string" && tag !== "" ? tag : undefined;
    }
    const tag = etag(body);
    return option === "weak" ? `W/${tag}` : tag;
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
   * Sends `body` serialised as `application/json;charset=utf-8` (with no
   * header set, through `Response.json`, without a `Headers` object). Goes through the same path
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
    this.#sentBody = body;
    if (this.#canSkipHeaders()) {
      return this.#respondWithJson(body);
    }
    this.options.headers = this.headersObj;
    this.headersObj.set("Content-Type", JSON_CONTENT_TYPE);
    return this.#respondWithText(JSON.stringify(body));
  }

  /**
   * Sends `body` as JSON with no `Headers` object: `Response.json`
   * serialises it as `JSON.stringify` does and sets
   * `application/json;charset=utf-8` itself. Only for a response with no
   * header set (see {@link #canSkipHeaders}).
   */
  #respondWithJson(body: unknown): BunResponse {
    const code = this.options.status;
    if (code === 204 || code === 205 || code === 304) {
      // These strip the body: the full path handles them.
      this.options.headers = this.headersObj;
      this.headersObj.set("Content-Type", JSON_CONTENT_TYPE);
      return this.#respondWithText(JSON.stringify(body));
    }
    this.req.setResponse(this);
    this.#implicitContentType = JSON_CONTENT_TYPE;
    const kind = typeof body;
    // `JSON.stringify` gives `undefined` for `undefined`, a function or a
    // symbol: an empty body then, as the text path sends one.
    this.response =
      kind === "undefined" || kind === "function" || kind === "symbol"
        ? new Response(undefined, this.#initWithoutHeaders())
        : Response.json(body, this.#initWithoutHeaders());
    return this;
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
      this.set("Content-Type", JSON_CONTENT_TYPE);
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
    this.req.setResponse(this);

    // Nothing set a header: send the text with no `Headers` object at all.
    // Bun writes `text/plain;charset=utf-8` for a string body itself, which
    // is the default here too. A 204/205/304 still takes the full path (it
    // strips the body), as does anything needing a header.
    if (this.#canSkipHeaders()) {
      const code = this.options.status;
      if (code !== 204 && code !== 205 && code !== 304) {
        this.#implicitContentType = TEXT_CONTENT_TYPE;
        IMPLICIT_TEXT_RESPONSES.add(
          (this.response = new Response(text, this.#initWithoutHeaders())),
        );
        return this;
      }
    }

    this.options.headers = this.headersObj;

    if (this.#etagEnabled && text && !this.hasHeader("ETag")) {
      const tag = this.#etagFor(text);
      if (tag !== undefined) {
        this.setHeader("ETag", tag);
      }
    }

    if (this.#applyFreshnessAndStrip()) {
      this.response = new Response(null, this.options);
      return this;
    }

    if (!this.headersObj.has("content-type")) {
      this.headersObj.set("Content-Type", TEXT_CONTENT_TYPE);
    }

    if (this.#responseTransforms !== undefined) {
      this.#transformBody = text;
    }
    this.response = new Response(text, this.options);
    return this;
  }

  /**
   * Headers this request's WebSocket upgrade sends on its `101`, set by
   * middleware that runs before the upgrading route or handler. They sit over
   * the router's `webSocketUpgradeHeaders` and under the route's `onUpgrade`
   * headers or {@link upgradeToWebsocket}'s `options.headers`, per header name.
   * Accepts any `HeadersInit` (copied); reads back as a `Headers`, or
   * `undefined` when none are set. Assign `undefined` to clear.
   */
  public get webSocketUpgradeHeaders(): Headers | undefined {
    return this._webSocketUpgradeHeaders;
  }

  public set webSocketUpgradeHeaders(headers: Bun.HeadersInit | undefined) {
    this._webSocketUpgradeHeaders =
      headers === undefined ? undefined : new Headers(headers);
  }

  /**
   * `ws.data` values for this request's WebSocket upgrade, set by middleware
   * that runs before the upgrading route or handler. Merged shallowly over the
   * data built from the request and the router's `webSocketUpgradeData` (this
   * wins per key), and under an `onUpgrade` hook's `custom`. Ignored when the
   * data is given outright — `upgradeToWebsocket(data)` or a hook's `data`.
   * A `ws()` route's `route`/`params`/`port` always come from its match.
   * Stored as a shallow copy; `undefined` clears it.
   */
  public get webSocketUpgradeData():
    | Partial<WebSocketClientData<customWebsocketDataType>>
    | undefined {
    return this._webSocketUpgradeData;
  }

  public set webSocketUpgradeData(
    data: Partial<WebSocketClientData<customWebsocketDataType>> | undefined,
  ) {
    this._webSocketUpgradeData = data === undefined ? undefined : { ...data };
  }

  /**
   * Marks the response as a WebSocket upgrade, with `data` as the socket's
   * `ws.data`.
   *
   * **Data.** A `data` argument is used exactly as given — no router- or
   * response-level `webSocketUpgradeData` is merged into it, at any depth.
   * Without one, it is built from the request (including `port`, the port of
   * the server that accepted it, when that server has one), then the router's
   * `webSocketUpgradeData` and then {@link webSocketUpgradeData} are merged
   * over it shallowly, later winning per key.
   *
   * **Headers.** The `101` carries the router's `webSocketUpgradeHeaders`,
   * then {@link webSocketUpgradeHeaders}, then `options.headers`, merged per
   * header name — a name passed here replaces every value of that name
   * beneath, e.g. `{ "Sec-WebSocket-Protocol": "chat.v1" }` to choose a
   * subprotocol. Headers set on this response any other way are not sent.
   * Each call recomputes the headers, so an earlier call's `options.headers`
   * never carry over. With no layer set and no `options.headers`, the `101`
   * is exactly Bun's default.
   *
   * `options.inherit: false` drops the router and response layers, so only
   * this call's arguments count.
   */
  public upgradeToWebsocket(
    data?: WebSocketClientData<customWebsocketDataType>,
    options?: UpgradeToWebsocketOptions,
  ) {
    const inherit = options?.inherit !== false;
    const defaults = inherit ? this.webSocketUpgradeDefaults : undefined;
    this._upgradeToWsHeaders = mergeUpgradeHeaders(
      defaults?.webSocketUpgradeHeaders,
      inherit ? this._webSocketUpgradeHeaders : undefined,
      options?.headers,
    );

    if (data) {
      this._upgradeToWsData = data;
      return this;
    }

    const port = this.req.server?.port;
    this._upgradeToWsData = {
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
      // The router-wide base carries no custom type of its own.
      ...(defaults?.webSocketUpgradeData as
        | Partial<WebSocketClientData<customWebsocketDataType>>
        | undefined),
      ...(inherit ? this._webSocketUpgradeData : undefined),
    } satisfies WebSocketClientData<customWebsocketDataType>;
    return this;
  }

  public get upgradeToWsData() {
    return this._upgradeToWsData;
  }

  /**
   * The headers the `101` will carry, as {@link upgradeToWebsocket} merged
   * them from every layer, or `undefined` when no layer had any (or it was not
   * called). Every server that performs the upgrade passes them to
   * `server.upgrade` as `headers`.
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
   * - `string` — sent as `text/plain;charset=utf-8` unless a Content-Type is
   *   already set. With no header set at all, the response is built without
   *   a `Headers` object (Bun writes that type itself).
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
        const tag = this.#etagFor(
          body as string | ArrayBufferView | ArrayBufferLike,
        );
        if (tag !== undefined) {
          this.setHeader("ETag", tag);
        }
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
      if (this.#canSkipHeaders()) {
        return this.#respondWithJson(body);
      }
      this.headersObj.set("Content-Type", JSON_CONTENT_TYPE);
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
    this.#notifyStreamEnded();
  }

  /** Calls (once) everything waiting for the stream to end. */
  #notifyStreamEnded(): void {
    const waiters = this.#streamEndWaiters;
    if (waiters !== undefined) {
      this.#streamEndWaiters = undefined;
      for (const waiter of waiters) {
        waiter();
      }
    }
  }

  /**
   * `true` while a streamed response (`write()`, `flushHeaders()`) is open:
   * it has started and not yet ended, been destroyed or lost its client.
   */
  get isStreamOpen(): boolean {
    return this._isLongLived && !this.#streamEnding && !this.#destroyed;
  }

  /**
   * Whether the response has ended, as Node's `writableEnded`: a body was
   * produced (`send`, `json`, `end`, `redirect`, …) or a streamed response
   * was asked to end.
   */
  get writableEnded(): boolean {
    return this.#ended;
  }

  /**
   * Calls `listener` once, when the open stream ends (`end()`, the client
   * leaving, {@link destroy}) — at once if no stream is open. Returns a
   * function that unsubscribes a listener not yet called.
   */
  onceStreamEnded(listener: () => void): () => void {
    if (!this.isStreamOpen) {
      listener();
      return () => {};
    }
    (this.#streamEndWaiters ??= []).push(listener);
    return () => {
      const waiters = this.#streamEndWaiters;
      const index = waiters === undefined ? -1 : waiters.indexOf(listener);
      if (index !== -1) {
        waiters!.splice(index, 1);
      }
    };
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
            if (this.#destroyed) {
              this.#errorController(controller);
              return;
            }

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

            if (this.#destroyed) {
              this.#errorController(controller);
              return;
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

  /** Errors `controller` with the {@link destroy} reason, once. */
  #errorController(controller: ReadableStreamDefaultController): void {
    if (this.#streamClosed) {
      return;
    }
    this.#streamClosed = true;
    try {
      controller.error(this.#destroyedWith);
    } catch {
      // Already cancelled or errored by the client.
    }
  }

  /**
   * Ends the response abruptly, as Node's `res.destroy(error)`: a streamed
   * response that is still open is cut off mid-body (the client sees the
   * connection end without the body's end), nothing more can be written,
   * and `close` is emitted — never `finish`. A response already complete is
   * left as it is. `error` defaults to an `Error` saying so.
   *
   * It is what Express's finalhandler does to an error that arrives after
   * the headers went out, and what {@link BunRouter.handle} does in its place.
   */
  destroy(error?: unknown): this {
    if (this.#destroyed) {
      return this;
    }
    this.#destroyed = true;
    this.#destroyedWith = error ?? new Error("The response was destroyed");
    if (this._isLongLived && !this.#streamClosed) {
      // Nothing more may be written; a parked `pull` wakes and errors.
      this.#streamEnding = true;
      const notifier = this.#streamWriteNotifier;
      if (notifier) {
        notifier.resolve();
      } else if (this.#readableStreamController) {
        this.#errorController(this.#readableStreamController);
      }
    }
    this.emitClose();
    this.#notifyStreamEnded();
    return this;
  }

  /** Whether {@link destroy} has run, as Node's `writable.destroyed`. */
  get destroyed(): boolean {
    return this.#destroyed;
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
   * Calls `listener` once, with the native `Response`, when one is produced —
   * at once (synchronously) if it already has been. Returns a function that
   * unsubscribes a listener not yet called. Unlike {@link getNativeResponse}
   * it allocates no promise and starts no timer, so a caller racing it
   * against something else can drop it cleanly.
   */
  public onceResponded(listener: (response: Response) => void): () => void {
    const existing = this.#nativeResponse;
    if (existing) {
      listener(existing);
      return () => {};
    }
    (this.#responseWaiters ??= []).push(listener);
    return () => {
      const waiters = this.#responseWaiters;
      const index = waiters === undefined ? -1 : waiters.indexOf(listener);
      if (index !== -1) {
        waiters!.splice(index, 1);
      }
    };
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
    const headers = this.#readableHeaders;
    if (name.toLowerCase() === "set-cookie") {
      const lines = headers.getSetCookie();
      return lines.length > 0 ? lines : undefined;
    }
    return headers.get(name);
  }

  /**
   * The lower-cased names of the headers set so far, each once, as Node's
   * `getHeaderNames()` (a `Headers` store lists `set-cookie` once per line).
   * In the order `Headers` iterates them, not Node's insertion order.
   */
  getHeaderNames(): string[] {
    return Array.from(new Set(this.#readableHeaders.keys()));
  }

  /**
   * A snapshot of the headers set so far, as Node's `getHeaders()`: an object
   * with no prototype, keyed by lower-cased name, `set-cookie` the array of
   * its lines and every other header one string.
   */
  getHeaders(): BunResponseHeaders {
    const headers: BunResponseHeaders = Object.create(null);
    const source = this.#readableHeaders;
    for (const [name, value] of source) {
      if (name !== "set-cookie") {
        headers[name] = value;
      } else if (!headers["set-cookie"]) {
        headers["set-cookie"] = source.getSetCookie();
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
    return this.#readableHeaders.has(name);
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
    const headers = this.#readableHeaders;
    if (name.toLowerCase() === "set-cookie") {
      const lines = headers.getSetCookie();
      return lines.length > 0 ? lines : defaultVal;
    }

    const value = headers.get(name);
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
