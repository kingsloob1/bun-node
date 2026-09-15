import type { SocketAddress } from "bun";
import type { FileTypeResult } from "file-type";
import type { IncomingMessage } from "node:http";
import type { BunResponse } from "./BunResponse";
import type { TypedEmitter } from "./BunWebSocket";
import type { StorageFile } from "./multipart";
import type { UploadErrorCode } from "./multipart/errors";
import type {
  BodyDecodingOptions,
  BodyParserOptions,
  BodyParserType,
  BunRequestInterface,
  BunServer,
  DefaultRequestBody,
  MultiPartFileRecord,
  MultiPartOptions,
  NextFunction,
} from "./types/general";
import type {
  CompressionDictionaries,
  ContentEncodingAllowlist,
  CookieParseOptions,
  JsonValue,
  ParseXmlOptions,
  RangeParserResult,
} from "./utils/native";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import accepts from "accepts";
import busboy from "busboy";
import { fileTypeFromBuffer } from "file-type";
import { parseDomain, ParseResultType, Validation } from "parse-domain";
import { parse as parseQueryString } from "picoquery";
import typeIs from "type-is";
import { UploadError } from "./multipart/errors";
import { streamToBuffer } from "./utils/general";
import {
  cloneDeep,
  ContentCodingLimitError,
  decompressBody,
  DecompressionError,
  DecompressionLimitError,
  DEFAULT_DECOMPRESS_FAST_PATH_LIMIT,
  DEFAULT_MAX_CONTENT_CODINGS,
  each,
  extractSignedCookies,
  first,
  flattenDeep,
  fresh,
  get,
  isArray,
  isBoolean,
  isContentCodingAllowed,
  isNull,
  isObject,
  isString,
  isUndefined,
  jsonCookies,
  keys,
  merge,
  omit,
  parseByteSize,
  parseContentCodings,
  parseCookie,
  parseXmlToObject,
  rangeParser,
  resolveContentEncodingAllowlist,
  set,
  ucwords,
  UnknownCompressionDictionaryError,
  values,
} from "./utils/native";

/**
 * bun-common-specific query-parse options layered on top of picoquery's native
 * {@link parseQueryString} options.
 */
export interface QueryParserExtraOpts {
  /**
   * When `true`, {@link globalThis.decodeURIComponent} is applied to the whole
   * (prefix-stripped) query string *before* it is handed to picoquery.
   * Defaults to `false` — and you very rarely need it.
   *
   * picoquery decodes each key and value's *content* itself, but it detects the
   * nesting/array **structure** *before* decoding. The encoded nesting brackets
   * (`%5B`/`%5D`) are already handled safely and by default (see
   * {@link parseSearchString}); this flag is the heavier escape hatch for the
   * rare case where the pair (`&`) or key/value (`=`) **delimiters** are
   * themselves percent-encoded and you need them surfaced too.
   *
   * The trade-off is that a full decode **double-decodes** ordinary content: a
   * value with a genuinely-encoded delimiter (e.g. `q=a%26b`, whose `%26` should
   * stay a literal `&`) would instead split into two keys. A malformed
   * percent-sequence that `decodeURIComponent` cannot decode falls back to the
   * raw string. Prefer leaving this off and relying on the default bracket
   * decoding.
   */
  decodeURIComponent?: boolean;

  /**
   * Custom decoder applied to the whole (prefix-stripped) query string before
   * it is handed to picoquery. When provided it takes **full control** of the
   * pre-parse decoding step — the default nesting-bracket decode and the
   * {@link QueryParserExtraOpts.decodeURIComponent} flag are both bypassed.
   * Reach for it when neither the safe default nor a blanket decode fits (e.g.
   * a bespoke encoding, or normalising only a specific subset of tokens).
   * Receives the leading-`?`-stripped query string and must return the string
   * to parse; if it throws, parsing falls back to the default bracket decode.
   */
  decode?: (query: string) => string;
}

export type QueryParserOpts =
  | (NonNullable<Parameters<typeof parseQueryString>[1]> & QueryParserExtraOpts)
  | undefined;

/**
 * The kinds of request body a {@link BunRequest} knows how to parse, keyed by
 * the media type they handle:
 *
 * - `"json"`        — `application/json` (and `+json` suffixes)
 * - `"urlencoded"`  — `application/x-www-form-urlencoded`
 * - `"xml"`         — `application/xml`, `text/xml` (and `+xml` suffixes)
 * - `"multipart"`   — `multipart/form-data`
 * - `"text"`        — `text/plain`
 * - `"raw"`         — `application/octet-stream` / binary streams
 *
 * Used by the `allowedContentTypes` request option to restrict which body
 * types are parsed; a body whose media type maps to a disallowed kind is left
 * untouched as a raw `Buffer`.
 */
export type ContentParserType =
  | "json"
  | "urlencoded"
  | "xml"
  | "multipart"
  | "text"
  | "raw";

/**
 * The recognized {@link ContentParserType} kinds, used to filter out invalid
 * entries from an allowlist — an allowlist that is empty after filtering means
 * "no restriction" (every kind is parsed) rather than "block everything".
 */
const VALID_PARSER_KINDS: ReadonlySet<ContentParserType> = new Set([
  "json",
  "urlencoded",
  "xml",
  "multipart",
  "text",
  "raw",
]);

/**
 * The parser-option shape forwarded to each {@link ContentParserType}, used by
 * the per-content-type `opts` field of {@link ParseBodyConfig}. Keying by kind
 * gives `parseBody.contentTypes.<kind>.opts` precise IntelliSense.
 */
export interface ContentTypeParserOptsMap {
  /** `JSON.parse` reviver applied to a JSON body. */
  json: {
    // `unknown` on purpose: a reviver sees values other revivers already
    // replaced, and may return anything, exactly as `JSON.parse` allows.
    reviver?: (this: unknown, key: string, value: unknown) => unknown;
  };
  /** `picoquery` options for an `x-www-form-urlencoded` body. */
  urlencoded: QueryParserOpts;
  /** XML-to-object parser options. */
  xml: ParseXmlOptions;
  /** `busboy`/multipart parser options. */
  multipart: MultiPartOptions;
  /** Buffer decoding for a `text/plain` body (defaults to `utf-8`). */
  text: { encoding?: BufferEncoding };
  /** No options — a raw body is left as a `Buffer`. */
  raw: Record<string, never>;
}

/**
 * Per-content-type entry of {@link ParseBodyConfig.contentTypes}. Supplying an
 * object both **allows** the kind and configures it; `opts` are forwarded to
 * the kind's parser and `maxContentLength` overrides the config-level cap for
 * that kind only.
 */
export interface ParseBodyContentTypeConfig<
  K extends ContentParserType = ContentParserType,
> {
  /** Parser options forwarded to this content type's parser. */
  opts?: ContentTypeParserOptsMap[K];
  /**
   * Maximum body size for this content type, in bytes or a human string
   * (`"5mb"`). Overrides {@link ParseBodyConfig.maxContentLength}.
   */
  maxContentLength?: number | string;
}

/**
 * The `contentTypes` allowlist map. Each {@link ContentParserType} key is
 * **allowed** when set to `true` or a {@link ParseBodyContentTypeConfig}, and
 * **disallowed** when set to `false` or omitted (a body of an omitted kind is
 * left as a raw `Buffer`).
 */
export type ParseBodyContentTypesMap = {
  [K in ContentParserType]?: boolean | ParseBodyContentTypeConfig<K>;
};

/**
 * Object form of the `parseBody` request option. Enables body parsing with a
 * DDoS-hardening size cap and a per-content-type allowlist/config.
 *
 * It also carries the body-decoding options ({@link BodyDecodingOptions}:
 * `inflate`, `decompressionFastPathLimit`, `encodings`, `maxContentCodings`,
 * `compressionDictionaries`). A request whose adapter parses the
 * body while building it reads the body before any middleware runs, so these
 * are the only place those options can reach that parse; a body-parser
 * middleware's own options apply only to a body not read yet.
 */
export interface ParseBodyConfig extends BodyDecodingOptions {
  /**
   * Maximum overall request body size, in bytes or a human string (`"100kb"`,
   * `"5mb"`). A request whose declared `Content-Length` — or whose actual
   * streamed size — exceeds this is rejected with **HTTP 413** before the body
   * is parsed (and, for a missing/chunked `Content-Length`, the stream read is
   * aborted the moment the cap is crossed).
   *
   * When omitted, the object form falls back to per-kind defaults: **100kb**
   * for most kinds, **10mb** for `multipart` and `raw` (see
   * {@link DEFAULT_MAX_CONTENT_LENGTH} / {@link DEFAULT_MAX_CONTENT_LENGTH_BY_KIND}).
   * A per-content-type `maxContentLength` overrides this; boolean
   * `parseBody: true` stays uncapped.
   */
  maxContentLength?: number | string;
  /**
   * Which content types to parse. `"all"` parses every supported kind (the
   * default); an object form is an allowlist whose keys are the kinds to parse
   * — each mapped to `true`, or to a {@link ParseBodyContentTypeConfig} for
   * per-kind parser options and size caps.
   */
  contentTypes?: "all" | ParseBodyContentTypesMap;
}

/**
 * The `parseBody` request option. `true` parses every body of any size
 * (no cap); `false` disables body parsing; a {@link ParseBodyConfig} object
 * enables parsing with a size cap and per-content-type configuration.
 */
export type ParseBodyOption = boolean | ParseBodyConfig;

/** The options a {@link BunRequest} is built with (its third constructor argument). */
type BunRequestInitOptions = NonNullable<
  ConstructorParameters<typeof BunRequest>[2]
>;

/**
 * The request options an adapter applies when its `request` option is not
 * given: body and cookie parsing on. Frozen; merge over it with
 * {@link mergeBunRequestOptions}.
 */
export const DEFAULT_ADAPTER_REQUEST_OPTIONS: Readonly<BunRequestInitOptions> =
  Object.freeze({ parseBody: true, parseCookies: true });

/**
 * Merges request options over `base` (by default
 * {@link DEFAULT_ADAPTER_REQUEST_OPTIONS}), so a partial object such as
 * `{ cookieSecret }` keeps body and cookie parsing on. A key set to
 * `undefined` keeps the base value. `parseBody` merges too when both sides
 * are objects (a boolean on either side replaces), and so does its
 * `contentTypes` map. Neither argument is modified.
 */
export function mergeBunRequestOptions(
  overrides: Partial<BunRequestInitOptions> | undefined,
  base: Readonly<BunRequestInitOptions> = DEFAULT_ADAPTER_REQUEST_OPTIONS,
): BunRequestInitOptions {
  const merged: BunRequestInitOptions = { ...base };
  if (!overrides) {
    return merged;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      Object.assign(merged, { [key]: value });
    }
  }

  const baseBody = base.parseBody;
  const body = overrides.parseBody;
  if (isObject(baseBody) && isObject(body)) {
    const baseTypes = baseBody.contentTypes;
    const types = body.contentTypes;
    merged.parseBody = {
      ...baseBody,
      ...body,
      ...(isObject(baseTypes) && isObject(types)
        ? { contentTypes: { ...baseTypes, ...types } }
        : {}),
    };
  }
  return merged;
}

/**
 * Default body-size cap (100kb) applied to most kinds when the object form of
 * `parseBody` omits `maxContentLength`. Boolean `parseBody: true` stays
 * uncapped. See {@link DEFAULT_MAX_CONTENT_LENGTH_BY_KIND} for the kinds that
 * default higher.
 */
export const DEFAULT_MAX_CONTENT_LENGTH = 100 * 1024;

/**
 * Per-kind default body-size caps, used when neither a per-content-type nor a
 * config-level `maxContentLength` is set. `multipart` (file uploads) and `raw`
 * (binary payloads) default to **10mb**; every other kind falls back to
 * {@link DEFAULT_MAX_CONTENT_LENGTH} (100kb).
 */
export const DEFAULT_MAX_CONTENT_LENGTH_BY_KIND: Partial<
  Record<ContentParserType, number>
> = {
  multipart: 10 * 1024 * 1024,
  raw: 10 * 1024 * 1024,
};

/**
 * Thrown by {@link BunRequest.parseBody} when a request body exceeds its
 * configured `maxContentLength`. Carries `statusCode = 413` so adapters and
 * error handlers can map it to an HTTP **413 Payload Too Large** response.
 */
export class PayloadTooLargeError extends Error {
  /** HTTP status for the error (413), as `http-errors` sets it. */
  public readonly status = 413 as const;
  /** Alias of {@link status}, read by adapters and Node-style handlers. */
  public readonly statusCode = 413 as const;
  /** The message is safe to show the client (`http-errors`' `expose`). */
  public readonly expose = true as const;
  /** The configured byte cap that was exceeded. */
  public readonly limit: number;
  /** The observed body size in bytes, when known. */
  public readonly length: number | undefined;

  constructor(limit: number, length?: number) {
    const received = length !== undefined ? ` (received ${length} bytes)` : "";
    super(
      `Request body exceeds the maximum allowed size of ${limit} bytes${received}`,
    );
    this.name = "PayloadTooLargeError";
    this.limit = limit;
    this.length = length;
  }
}

/**
 * Default `picoquery` parse options. `nestingSyntax: "js"` accepts both dotted
 * (`a.b`) and bracketed (`a[b]`) keys, and `arrayRepeat` collapses repeated
 * keys into arrays — together approximating the previous `qs` behaviour.
 *
 * Options given as `parseQueryOpts`, to {@link BunRequest.parseQuery} /
 * `setQueryParserOptions`, or as `parseBody.contentTypes.urlencoded.opts` are
 * **merged over** these, so a partial object keeps the rest. To opt out of a
 * default, set it explicitly — e.g. `{ nesting: false }` or
 * `{ arrayRepeat: false }`.
 */
export const DEFAULT_PARSE_QUERY_OPTS: QueryParserOpts = Object.freeze({
  nesting: true,
  nestingSyntax: "js",
  arrayRepeat: true,
  arrayRepeatSyntax: "repeat",
});

/**
 * The per-content-type overrides resolved from `parseBody.contentTypes`: the
 * kind's parser options and its byte cap.
 */
interface PerTypeParserConfig {
  /** Parser options for the kind; read back through `getParserOpts(kind)`. */
  opts?: ContentTypeParserOptsMap[ContentParserType];
  /** The kind's own byte cap, already parsed to bytes. */
  maxContentLength?: number;
}

/**
 * What {@link BunRequest.getMultiParts} resolves to.
 *
 * `TFields` is the shape of `fields`. It is `Record<string, unknown>` by
 * default because, with `inflate` on, a value is whatever the field inflator
 * produced — `JSON.parse` output or nested objects for the built-in one, and
 * anything at all for a custom `fieldInflator`. With `inflate: false` it is
 * {@link RawMultiPartFields}.
 */
export interface MultiPartParseResult<TFields = Record<string, unknown>> {
  /** Each uploaded file, mapped to the field paths (`docs[passport]`) naming it. */
  files: Map<MultiPartFileRecord, Set<string>>;
  /** The non-file fields. */
  fields: TFields;
}

/**
 * The fields of a multipart body parsed with `inflate: false`, as multer
 * reports them: names exactly as sent, values strings, a repeated name an
 * array of its values in arrival order.
 */
export type RawMultiPartFields = Record<string, string | string[]>;

/** What {@link BunRequest.parseCookies} returns. */
export interface BunRequestCookies {
  /** The unsigned cookies: raw strings, or parsed JSON for `j:` values. */
  cookies: Record<string, JsonValue>;
  /** Verified values (parsed JSON for `j:`), or `false` when tampered. */
  signedCookies: Record<string, JsonValue>;
}

/** Merges query-parser options over {@link DEFAULT_PARSE_QUERY_OPTS}. */
function withDefaultQueryOpts(opts?: QueryParserOpts): QueryParserOpts {
  return { ...DEFAULT_PARSE_QUERY_OPTS, ...opts };
}

/**
 * The media types a `useBodyParser(kind)` parses when its options give no
 * `type` — body-parser's defaults for each kind.
 */
const DEFAULT_BODY_PARSER_TYPES: Record<BodyParserType, string> = {
  json: "application/json",
  urlencoded: "application/x-www-form-urlencoded",
  text: "text/plain",
  raw: "application/octet-stream",
};

/**
 * `N` when it names the `Set-Cookie` header in any letter case, otherwise
 * `never` — so an overload taking `N & SetCookieHeaderName<N>` matches only a
 * literal `"set-cookie"` / `"Set-Cookie"` / … name. Used by `req.get` and
 * `res.get`, which answer that header as an array.
 */
export type SetCookieHeaderName<N extends string> =
  Lowercase<N> extends "set-cookie" ? N : never;

/**
 * The busboy / inflation options {@link BunRequest.getMultiParts} compares to
 * decide whether a per-call options object changes the parse.
 */
const MULTIPART_PARSE_KEYS = [
  "limits",
  "preservePath",
  "defParamCharset",
  "defCharset",
  "highWaterMark",
  "fileHwm",
  "isPartAFile",
  "inflate",
  "fieldInflator",
  "fileInflator",
] as const;

/**
 * An HTTP error as `http-errors` builds it: an `Error` carrying its status
 * twice (`status`, `statusCode`) and `expose`, so the message may be shown.
 */
export type BunHttpClientError = Error & {
  /** The HTTP status to answer with (4xx). */
  status: number;
  /** Alias of `status`, read by adapters and Node-style handlers. */
  statusCode: number;
  /** The message is safe to show the client. */
  expose: true;
};

/**
 * Validates a `decompressionFastPathLimit` option: a non-negative number
 * (`Infinity` included), or `undefined` for the default.
 *
 * @throws {RangeError} for anything else — a misconfiguration, reported as
 * one rather than as a 400 for a body that was never at fault.
 */
function resolveDecompressionFastPathLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_DECOMPRESS_FAST_PATH_LIMIT;
  }
  if (!(typeof value === "number" && value >= 0)) {
    throw new RangeError(
      `decompressionFastPathLimit must be a non-negative number, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Validates a `maxContentCodings` option: a non-negative number (`Infinity`
 * included), or `undefined` for the default.
 *
 * @throws {RangeError} for anything else, as a misconfiguration.
 */
function resolveMaxContentCodings(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_CONTENT_CODINGS;
  }
  if (!(typeof value === "number" && value >= 0)) {
    throw new RangeError(
      `maxContentCodings must be a non-negative number, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Validates an `encodings` option and answers it, `"*"` when unset.
 *
 * @throws {RangeError} for an entry that is not a coding the library decodes.
 */
function resolveContentEncodings(
  value: ContentEncodingAllowlist | undefined,
): ContentEncodingAllowlist {
  resolveContentEncodingAllowlist(value);
  return value ?? "*";
}

/**
 * Validates a `compressionDictionaries` option: an array of byte arrays, a
 * resolver function, or `undefined` for none.
 *
 * @throws {TypeError} for anything else, as a misconfiguration.
 */
function resolveCompressionDictionaries(
  value: CompressionDictionaries | undefined,
): CompressionDictionaries | undefined {
  if (
    value === undefined ||
    typeof value === "function" ||
    (Array.isArray(value) &&
      value.every((dictionary) => dictionary instanceof Uint8Array))
  ) {
    return value;
  }
  throw new TypeError(
    `compressionDictionaries must be an array of Uint8Array dictionaries or a resolver function, got ${String(value)}`,
  );
}

/** Builds an HTTP error (`status`/`statusCode`), as `http-errors` does. */
function httpError(statusCode: number, message: string): BunHttpClientError {
  return Object.assign(new Error(message), {
    status: statusCode,
    statusCode,
    expose: true as const,
  });
}

/** Strips a leading `?` so query strings parse cleanly. */
function stripQueryPrefix(search: string): string {
  return search.charCodeAt(0) === 63 ? search.slice(1) : search;
}

/**
 * Percent-encoded forms of picoquery's structural nesting brackets (`%5B` = `[`,
 * `%5D` = `]`, either case). Matched so {@link decodeNestingBrackets} can surface
 * them ahead of parsing.
 */
const ENCODED_NESTING_BRACKETS = /%5[bd]/gi;

/**
 * Decode only the encoded nesting brackets in a query string, leaving every
 * other percent-sequence untouched.
 *
 * picoquery detects the array/object structure *before* it URI-decodes, so a
 * client that encodes the brackets themselves — e.g.
 * `payrollrunid%5B0%5D=1&payrollrunid%5B1%5D=2` — defeats nesting and yields
 * literal keys (`{ "payrollrunid[0]": "1", … }`). Surfacing just `[`/`]` fixes
 * that with **no** double-decode hazard: unlike a blanket
 * {@link globalThis.decodeURIComponent}, it never touches the pair (`&`) or
 * key/value (`=`) delimiters, so a value that legitimately contains an encoded
 * delimiter is preserved. And because picoquery already decodes `%5B`/`%5D`
 * inside *values*, doing it early cannot change any value — it only lets the key
 * parser see the structure it was going to ignore.
 */
function decodeNestingBrackets(input: string): string {
  return input.replace(ENCODED_NESTING_BRACKETS, (match) => {
    return match.toLowerCase() === "%5b" ? "[" : "]";
  });
}

/**
 * Parse a raw query (or `x-www-form-urlencoded`) string into an object,
 * honouring bun-common's {@link QueryParserExtraOpts}. It strips a leading `?`,
 * then decodes the string ahead of picoquery using, in precedence order:
 *
 * - a user-supplied `decode` function, if given, which takes full control
 *   (falling back to the bracket decode below if it throws);
 * - otherwise a full {@link globalThis.decodeURIComponent} when
 *   `decodeURIComponent` is enabled (falling back to the bracket decode if the
 *   string is malformed);
 * - otherwise, by default, only {@link decodeNestingBrackets} — so
 *   encoded-bracket arrays parse correctly with no risk of double-decoding
 *   delimiters.
 *
 * The custom `decode`/`decodeURIComponent` options are stripped before the
 * actual parse is handed to picoquery.
 */
function parseSearchString(raw: string, opts?: QueryParserOpts) {
  const { decodeURIComponent: shouldDecode, decode, ...picoOpts } = opts ?? {};
  const stripped = stripQueryPrefix(raw);
  let input = decodeNestingBrackets(stripped);

  if (typeof decode === "function") {
    try {
      input = decode(stripped);
    } catch {
      // User decoder threw — keep the safe bracket-only decode above.
    }
  } else if (shouldDecode) {
    try {
      input = decodeURIComponent(stripped);
    } catch {
      // Malformed percent-encoding — keep the safe bracket-only decode above.
    }
  }

  return parseQueryString(input, picoOpts);
}

/**
 * The lifecycle events emitted by {@link BunRequest}, mirroring Node's
 * `IncomingMessage`. Declared as a `type` (not an `interface`) so it satisfies
 * `TypedEmitter`'s `Record<string, …>` constraint.
 */
// eslint-disable-next-line ts/consistent-type-definitions
export type BunRequestEvents = {
  /**
   * The connection was aborted **before a response was produced**. Once a
   * response has been sent, a dropped connection emits `close` instead.
   */
  aborted: () => void;
  /** The request connection has closed. */
  close: () => void;
  /** A chunk of the request body. */
  data: (chunk: Buffer) => void;
  /** The request body has been fully received. */
  end: () => void;
  /**
   * An error occurred while receiving/parsing the request body. `unknown`:
   * it is whatever the parser threw.
   */
  error: (error: unknown) => void;
  /**
   * A streaming response bound to this request was cancelled. `unknown`: the
   * reason is whatever the stream's consumer passed to `cancel()`.
   */
  abort: (reason?: unknown) => void;
};

/** A {@link BunRequest} event name. */
type ReqEventName = keyof BunRequestEvents;
/** The listener signature for a given {@link BunRequest} event. */
type ReqListener<E extends ReqEventName> = BunRequestEvents[E];

/**
 * Internal, non-`@deprecated` view of the legacy request options. The public
 * option fields carry `@deprecated` tags so editors warn callers; the library
 * reads its own fallbacks through this view to avoid flagging that internal use.
 */
interface LegacyBodyOptions {
  allowedContentTypes?: ContentParserType[];
  parseXmlOpts?: ParseXmlOptions;
  parseMultiPartFormDataOpts?: MultiPartOptions;
}

/**
 * The events {@link BunRequestSocket} emits with a known payload. Any other
 * event name is accepted too, with `unknown` arguments.
 */
// eslint-disable-next-line ts/consistent-type-definitions
export type BunRequestSocketEvents = {
  /**
   * The client disconnected. `hadError` is always `false`: Bun reports no
   * transmission error for a dropped connection.
   */
  close: (hadError: boolean) => void;
  /**
   * Never emitted — Bun owns the idle timeout — but `setTimeout(ms, cb)`
   * registers `cb` for it, as Node does.
   */
  timeout: () => void;
};

/**
 * A listener for an event outside {@link BunRequestSocketEvents}. Its
 * arguments are `unknown` because they are whatever the emitter was given.
 */
type SocketListener = (...args: unknown[]) => void;

/** Any listener the socket accepts, typed or not. */
type AnySocketListener =
  | BunRequestSocketEvents[keyof BunRequestSocketEvents]
  | SocketListener;

/** An event name that is not one of {@link BunRequestSocketEvents}. */
type UntypedSocketEvent<E extends string> =
  E extends keyof BunRequestSocketEvents ? never : E;

/**
 * Adds or removes a listener: typed by {@link BunRequestSocketEvents} for a
 * known event, with `unknown` arguments for any other.
 */
interface SocketListenerMethod {
  <E extends keyof BunRequestSocketEvents>(
    event: E,
    listener: BunRequestSocketEvents[E],
  ): BunRequestSocket;
  (event: string, listener: SocketListener): BunRequestSocket;
}

/**
 * Emits an event: a known event must be given its declared arguments; any
 * other name takes whatever arguments it is given.
 */
interface SocketEmitMethod {
  <E extends keyof BunRequestSocketEvents>(
    event: E,
    ...args: Parameters<BunRequestSocketEvents[E]>
  ): boolean;
  <E extends string>(
    event: E & UntypedSocketEvent<E>,
    ...args: unknown[]
  ): boolean;
}

/**
 * The Node `net.Socket`-shaped object `req.socket` returns. Bun exposes no
 * socket per request, so this carries what Express, NestJS and Node-style
 * middleware reach for: the keep-alive/no-delay/timeout setters, the local
 * address, and an event emitter that emits `close` when the client
 * disconnects (NestJS's `@Sse()` waits on `socket.once("close")`).
 */
export interface BunRequestSocket {
  /** Whether `setKeepAlive(true)` has been called. Starts `false`. */
  keepAlive: boolean;
  /** Records keep-alive (read by long-lived responses). Returns the socket. */
  setKeepAlive: (enable?: boolean) => BunRequestSocket;
  /** Accepted for compatibility; Bun manages Nagle itself. Returns the socket. */
  setNoDelay: (noDelay?: boolean) => BunRequestSocket;
  /**
   * Accepted for compatibility; Bun owns the idle timeout, so no `timeout`
   * event is ever emitted. A `callback` is registered as a `timeout`
   * listener, as Node does. Returns the socket.
   */
  setTimeout: (timeout: number, callback?: () => void) => BunRequestSocket;
  /** Adds a listener (`close` fires once, when the client disconnects). */
  on: SocketListenerMethod;
  /** Alias of {@link BunRequestSocket.on}. */
  addListener: SocketListenerMethod;
  /** Adds a listener that runs at most once. */
  once: SocketListenerMethod;
  /** Removes a listener. */
  off: SocketListenerMethod;
  /** Alias of {@link BunRequestSocket.off}. */
  removeListener: SocketListenerMethod;
  /** Removes every listener, or every listener for `event`. */
  removeAllListeners: (event?: string) => BunRequestSocket;
  /** Emits an event; `false` when nothing is listening. */
  emit: SocketEmitMethod;
  /** The number of listeners for `event`. */
  listenerCount: (event: string) => number;
  /** `true` once the client has disconnected. */
  readonly destroyed: boolean;
  /** The peer's port, when the server reports one. */
  readonly localPort: number | undefined;
  /** The peer's address (`req.ip`), or `""`. */
  readonly localAddress: string;
  /** The peer's address family, when the server reports one. */
  readonly localFamily: SocketAddress["family"] | undefined;
}

export class BunRequest<
  /**
   * Shape of `req.params`. Defaults to the untyped `Record<string, string>`;
   * a route registered with a path literal narrows it to that path's params.
   */
  TParams = Record<string, string>,
  /**
   * Shape of `req.query`. Defaults to the parser's untyped output; a validator
   * narrows it to its parsed result.
   */
  TQuery = Record<string, unknown>,
  /** Shape of `req.body`. Defaults to the union the body parsers produce. */
  TBody = DefaultRequestBody,
>
  implements
    BunRequestInterface<TParams, TQuery, TBody>,
    TypedEmitter<BunRequestEvents>
{
  private bunResponse: BunResponse | undefined = undefined;
  public headersObj: InstanceType<typeof Headers>;
  /** Lazily-built plain-object header view (see the `headers` getter). */
  #headers: Record<string, string | string[]> | undefined = undefined;
  /** Lazily-parsed request URL (see the `parsedUrl` getter). */
  #parsedUrl: URL | undefined = undefined;
  /**
   * Memoized `{ host, path, search, hash }` split of the request URL (no
   * `new URL`). `path` is the pathname only; `search`/`hash` keep their
   * leading `?`/`#` (or are `""` when absent), matching WHATWG `URL`.
   */
  #urlSplit:
    | { host: string; path: string; search: string; hash: string }
    | undefined = undefined;

  public maxHeadersCount = 0;
  public reusedSocket = false;
  /**
   * The exact bytes of the request body, as Nest's `rawBody: true` keeps them
   * (body-parser's `verify` hook). Set by the adapter's parser middleware
   * (`registerParserMiddleware(prefix, true)` / `useBodyParser(kind, true)`)
   * when that parser read a body; `undefined` otherwise — including for a
   * request no such parser handled. See also {@link buffer}.
   */
  public rawBody?: Buffer = undefined;
  /**
   * Init promises, lazily allocated only when body/cookie/query parsing runs:
   * the parsed query, the body parse (settled, no value) and the cookies.
   */
  #initPromises: Promise<TQuery | BunRequestCookies | void>[] | undefined =
    undefined;

  /**
   * The parsed body. Widened to {@link DefaultRequestBody} so the generic
   * `TBody` view can be cast in and out without narrowing the storage.
   */
  private _body: DefaultRequestBody = undefined;

  /**
   * The cookie secret, as cookie-parser's `req.secret`: the `cookieSecret`
   * request option's first entry when that is set, otherwise `undefined`
   * until middleware assigns it or `parseCookies({ secret })` fills it in.
   * `res.cookie(..., { signed: true })` signs with it (its first entry, when
   * an array).
   */
  public secret: string | string[] | undefined = undefined;
  // `cookies`/`signedCookies`/`params`/`query` are lazily allocated — a
  // routing-only request that never reads them pays no allocation.
  /** Backing field for `cookies`; `undefined` until parsed or assigned. */
  #cookies: Record<string, JsonValue> | undefined = undefined;
  /** Backing field for `signedCookies`; `undefined` until parsed or assigned. */
  #signedCookies: Record<string, JsonValue> | undefined = undefined;
  /** Backing field for `url`; computed from the request on first read. */
  #url: string | undefined = undefined;

  /**
   * The path the router handling this request was mounted at, as Express's
   * `req.baseUrl`. `""` by default: bun-common's router matches a mount by
   * prefix without rewriting `url`, so nothing sets it unless the router does.
   */
  public baseUrl: string = "";

  /**
   * The current layer's `next`, set by the router; `undefined` outside a
   * pipeline. `res.format()` sends its 406 through it.
   */
  public next?: NextFunction;
  /** Backing field for `params`, stored untyped; `TParams` is the caller's view. */
  #params: Record<string, string> | undefined = undefined;
  /**
   * Backing field for `query`, stored as the parser's untyped output (values
   * are `unknown` until a validator narrows them); `TQuery` is the caller's
   * view, cast in and out as `_body` is.
   */
  #query: Record<string, unknown> | undefined = undefined;
  public _route: BunRequestInterface["route"] | undefined = undefined;
  private _contentType:
    | "json"
    | "text"
    | "buffer"
    | "form"
    | "xml"
    | "multipart"
    | undefined = undefined;

  /**
   * Normalized set of body-parser kinds permitted by `allowedContentTypes` or
   * by `parseBody.contentTypes`. `undefined` means "no restriction" — every
   * kind is parsed (the default).
   */
  #allowedParsers: Set<ContentParserType> | undefined = undefined;

  /**
   * `true` when the object form of `parseBody` is in effect, so body-size caps
   * apply. Boolean `parseBody` leaves this `false` (parsing is uncapped).
   */
  #bodyCapsEnabled = false;

  /**
   * The explicit config-level `parseBody.maxContentLength` in bytes, or
   * `undefined` when unset (in which case the per-kind defaults apply — see
   * {@link DEFAULT_MAX_CONTENT_LENGTH_BY_KIND}).
   */
  #maxContentLength: number | undefined = undefined;

  /**
   * Per-content-type parser `opts` and `maxContentLength` overrides, parsed
   * from the object form of `parseBody.contentTypes`. Lazily allocated — only
   * present when at least one kind supplies an object config.
   */
  #perTypeConfig: Map<ContentParserType, PerTypeParserConfig> | undefined =
    undefined;

  /**
   * Set when {@link parseBody} aborts because the body exceeded its cap. The
   * adapter reads {@link isPayloadTooLarge} after `init` to short-circuit with
   * an HTTP 413 before routing.
   */
  #payloadTooLarge: { limit: number; length?: number } | undefined = undefined;

  /** The cached multipart parse (see {@link getMultiParts}). */
  #parsedMultipartResp?: MultiPartParseResult | undefined = undefined;

  /**
   * The options {@link #parsedMultipartResp} was parsed with, so a later
   * {@link getMultiParts} call whose options differ re-parses instead of
   * returning a result that ignores them.
   */
  #multipartOptions: MultiPartOptions | undefined = undefined;

  /**
   * Set when the multipart parse was refused (a busboy limit, or a parser
   * error), holding what it rejected with. A later {@link getMultiParts} call
   * that changes no parse-affecting option rejects with the same error, and
   * one that does re-parses with its options merged over the failed ones — so
   * a handler cannot slip past the request's own `limits` by calling again.
   * `unknown`, as a parser may reject with anything.
   */
  #multipartFailure: { error: unknown } | undefined = undefined;

  /** `true` once {@link parseBody} has run, even for a body left `undefined`. */
  #bodyParsed = false;

  /**
   * Whether a compressed body is decoded before parsing: `Content-Encoding`
   * `gzip`/`x-gzip`, `deflate`, `br`, `zstd`, stacked codings (`gzip, br`,
   * decoded last to first) and `dcb`/`dcz` given
   * {@link #compressionDictionaries}. `true` by default, as body-parser. Resolved from
   * `parseBody.inflate` (object form) when the request is built or
   * {@link setParseBodyOptions} runs, and overridden by the `inflate` option
   * of {@link handleBodyParsing}; either affects only a body not yet read.
   */
  #inflate = true;

  /**
   * The most memory, in bytes, one uncapped Bun gunzip/inflate of the body may
   * use in the worst case before decoding falls back to `node:zlib`, capped at
   * the body limit (see {@link #decodeContentEncoding}). Default
   * `DEFAULT_DECOMPRESS_FAST_PATH_LIMIT` (32 MiB); `0` always uses node:zlib.
   * Resolved, like {@link #inflate}, from `parseBody.decompressionFastPathLimit`
   * and overridden by the option of the same name on
   * {@link handleBodyParsing}; either affects only a body not yet read.
   */
  #decompressionFastPathLimit = DEFAULT_DECOMPRESS_FAST_PATH_LIMIT;

  /**
   * The `Content-Encoding` codings a body may use: `"*"` (the default) for
   * every coding `decompressBody` decodes, or an allowlist. Resolved, like
   * {@link #inflate}, from `parseBody.encodings` and overridden by the option
   * of the same name on {@link handleBodyParsing}.
   */
  #contentEncodings: ContentEncodingAllowlist = "*";

  /**
   * The most codings one `Content-Encoding` may stack. Default
   * `DEFAULT_MAX_CONTENT_CODINGS` (5). Resolved, like {@link #inflate}, from
   * `parseBody.maxContentCodings` and overridden by the option of the same
   * name on {@link handleBodyParsing}; either affects only a body not yet read.
   */
  #maxContentCodings = DEFAULT_MAX_CONTENT_CODINGS;

  /**
   * Dictionaries `dcb`/`dcz` bodies may name; `undefined` (the default)
   * refuses those codings with 415. Resolved, like {@link #inflate}, from
   * `parseBody.compressionDictionaries` and overridden by the option of the
   * same name on {@link handleBodyParsing}; either affects only a body not yet
   * read.
   */
  #compressionDictionaries: CompressionDictionaries | undefined = undefined;

  /**
   * The 415 or 400 a `Content-Encoding` could not be decoded with (inflation
   * off, a coding unsupported or not allowed, too many stacked codings, a
   * corrupt stream, an unknown dictionary), once a body read hit one.
   * Adapters read it after `init` (see {@link bodyDecodingError}) so a body
   * refused while the request was built is answered rather than routed with
   * no body. A decompression bomb is not here: it is a 413, see
   * {@link isPayloadTooLarge}.
   */
  #bodyDecodingError: BunHttpClientError | undefined = undefined;

  private _buffer: Buffer | undefined = undefined;
  /** Uploaded files — lazily allocated; only multipart requests populate it. */
  #storageFiles: StorageFile[] | Record<string, StorageFile[]> | undefined =
    undefined;

  /**
   * Lazily-computed subdomains. `parseDomain` (a public-suffix-list lookup) is
   * comparatively expensive, so it runs only on first access of `subdomains`.
   */
  #subdomains: string[] | undefined = undefined;

  /**
   * Lazily-created event bus mirroring Node's `IncomingMessage` events
   * (`aborted`, `close`, `data`, `end`, …). It is built only when the first
   * listener is registered — a routing-only request nobody listens to costs
   * nothing, and the connection-abort bridge is wired only then.
   */
  #emitter: EventEmitter | undefined = undefined;

  /**
   * Set by {@link BunResponse} (via {@link markResponded}) once a response
   * has been produced. A connection drop after this point is a normal
   * `close`, not an `aborted`.
   */
  #responded = false;

  /** Lifecycle of the request body, driving the `data`/`end`/`error` events. */
  #bodyState: "pending" | "ended" | "errored" = "pending";
  /**
   * The error captured when {@link #bodyState} is `"errored"` — `unknown`,
   * since it is whatever the body parse rejected with.
   */
  #bodyError: unknown = undefined;

  /**
   * The `Bun.serve` server this request arrived on (see the `server` getter).
   * `undefined` only when a caller constructed the request without one.
   */
  readonly #server: BunServer | undefined;
  /** True once the `data`/`end`/`error` body events have been emitted. */
  #bodyEventsEmitted = false;

  /** Memoized Node-compatible socket shim (see the `socket` getter). */
  #socket: BunRequestSocket | undefined = undefined;

  constructor(
    /** The native Bun/Web `Request` this instance wraps. */
    public request: Request,
    /**
     * The owning `Bun.serve` server — used for connection info (`requestIP`,
     * local address/port) and to upgrade the request to a WebSocket.
     */
    server: BunServer,
    private options: {
      /**
       * Controls request-body parsing. `true` parses every body of any size
       * (no cap); `false` disables parsing; a {@link ParseBodyConfig} object
       * enables parsing with a `maxContentLength` size cap (DDoS hardening) and
       * a per-content-type allowlist/config (`contentTypes`).
       *
       * The object form's `maxContentLength` defaults to **100kb** (and
       * **10mb** for `multipart`/`raw`) when unset. Use
       * {@link BunRequest.setParseBodyOptions} to change this at runtime (e.g.
       * from a middleware, before the body is parsed).
       */
      parseBody: ParseBodyOption;
      /** Parse the `Cookie` header into `req.cookies`. Defaults to `true`. */
      parseCookies?: boolean;
      /**
       * Parse the URL query string into `req.query`. Defaults to `true`.
       */
      parseQuery?: boolean;
      /**
       * Options for the query-string parser (`picoquery`), **merged over**
       * {@link DEFAULT_PARSE_QUERY_OPTS} (`nestingSyntax: "js"`,
       * `arrayRepeat: true`), so a partial object keeps the other defaults.
       * Set a default explicitly to opt out (`{ nesting: false }`).
       */
      parseQueryOpts?: QueryParserOpts;
      /**
       * Multipart/`busboy` parser options.
       *
       * @deprecated Prefer `parseBody.contentTypes.multipart.opts`. Still
       * honoured as a fallback when the new config omits multipart options.
       */
      parseMultiPartFormDataOpts?: MultiPartOptions;
      /**
       * XML parser options.
       *
       * @deprecated Prefer `parseBody.contentTypes.xml.opts`. Still honoured as
       * a fallback when the new config omits XML options.
       */
      parseXmlOpts?: ParseXmlOptions;
      /**
       * Restricts which body media types are parsed. When provided, only the
       * listed {@link ContentParserType} kinds are decoded; a body whose media
       * type maps to an omitted kind is left as a raw `Buffer`. When omitted,
       * every supported kind is parsed (backwards-compatible default).
       *
       * @deprecated Prefer `parseBody.contentTypes` (an allowlist that also
       * carries per-kind parser options and size caps). Honoured only when
       * `parseBody.contentTypes` is absent.
       */
      allowedContentTypes?: ContentParserType[];
      /** Options for the cookie parser, applied when `parseCookies` is on. */
      cookieParseOptions?: CookieParseOptions;
      /**
       * The secret(s) signed cookies are verified with, as
       * `cookieParser(secret)`: a string, or an array for rotation (newest
       * first — the first signs, every one verifies). When set, `req.secret`
       * is its first entry from the moment the request is built, so
       * `res.cookie(name, value, { signed: true })` signs with it, and the
       * build-time cookie parse fills `req.signedCookies` (a cookie no secret
       * verifies becomes `false`). Unset (or `""`/`[]`): no secret, and `s:`
       * cookies stay in `req.cookies` until `parseCookies({ secret })` runs.
       */
      cookieSecret?: string | string[];
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
    this.#server = server;
    this.headersObj = request.headers as Headers;

    // Normalize options with direct assignment — `set()`'s path parsing is
    // wasted work for these known, fixed property names. `parseBody` may be a
    // boolean or a config object; anything else falls back to `true`.
    if (
      !isBoolean(this.options.parseBody) &&
      !isObject(this.options.parseBody)
    ) {
      this.options.parseBody = true;
    }

    if (!isBoolean(this.options.parseCookies)) {
      this.options.parseCookies = true;
    }

    if (!isBoolean(this.options.parseQuery)) {
      this.options.parseQuery = true;
    }

    if (!isObject(this.legacyOptions.parseMultiPartFormDataOpts)) {
      this.legacyOptions.parseMultiPartFormDataOpts = {};
    }

    this.options.parseQueryOpts = withDefaultQueryOpts(
      this.options.parseQueryOpts,
    );

    // Resolve the `parseBody` config (size caps + per-content-type allowlist),
    // honouring the deprecated `allowedContentTypes` as a fallback.
    this.normalizeParseBodyOptions();

    if (this.options?.parseQuery) {
      (this.#initPromises ??= []).push(
        Promise.resolve(this.parseQuery(this.options.parseQueryOpts)),
      );
    }

    if (this.options?.parseBody) {
      (this.#initPromises ??= []).push(
        Promise.resolve(this.parseBody()).then(
          () => {
            // The body has been fully received — release the `data`/`end`
            // events to any listener (or arm them for a later subscriber).
            this.#bodyState = "ended";
            this.#flushBodyEvents();
          },
          // `unknown`: a rejection reason is whatever the parse threw.
          (error: unknown) => {
            this.#bodyState = "errored";
            this.#bodyError = error;
            this.#flushBodyEvents();
          },
        ),
      );
    }

    // cookie-parser sets `req.secret = secrets[0]` on every request.
    const cookieSecrets = this.#configuredCookieSecrets();
    if (cookieSecrets.length) {
      this.secret = cookieSecrets[0];
    }

    if (this.options?.parseCookies) {
      (this.#initPromises ??= []).push(
        Promise.resolve(
          this.parseCookies({
            forceUpdateRequest: true,
            secret: cookieSecrets.length ? cookieSecrets : undefined,
          }),
        ),
      );
    }
  }

  /** The `cookieSecret` option as a list of non-empty secrets; `[]` when unset. */
  #configuredCookieSecrets(): string[] {
    const configured = this.options?.cookieSecret;
    const list = isArray(configured) ? configured : [configured];
    return list.filter(
      (secret): secret is string => isString(secret) && secret !== "",
    );
  }

  /**
   * Builds a `BunRequest` and settles whatever initialisation the options
   * scheduled (body / cookie parsing).
   *
   * Returns the instance **synchronously** when nothing was scheduled — the
   * common case for a router that only needs the URL and method. Declaring
   * this `async` instead would allocate two promises and burn two microtask
   * ticks per request purely to discover there was nothing to await, measured
   * at 347ns against 139ns for plain construction.
   *
   * Callers may always `await` the result; to actually collect the saving,
   * branch on it instead (see `BunHttpAdapter`'s fetch handler), since
   * `await` on a non-promise still costs a microtask tick.
   */
  static init(
    ...args: ConstructorParameters<typeof BunRequest>
  ): BunRequest | Promise<BunRequest> {
    const req = new BunRequest(...args);
    const pending = req.#initPromises;
    if (pending === undefined || pending.length === 0) {
      return req;
    }
    return req.ready().then(() => req);
  }

  /**
   * Settles every initialisation task the options scheduled (query, body and
   * cookie parsing) and reports each outcome; `[]` when none was scheduled.
   */
  async ready(): Promise<
    PromiseSettledResult<TQuery | BunRequestCookies | void>[]
  > {
    // Avoid the `Promise.allSettled` allocation when nothing was scheduled.
    if (!this.#initPromises || this.#initPromises.length === 0) {
      return [];
    }
    return await Promise.allSettled(this.#initPromises);
  }

  /* ---------------------------------------------------------------- *
   * Node `IncomingMessage`-style events
   *
   * `BunRequest` is not an `EventEmitter` subclass (that would add a
   * per-request cost). The emitter is created lazily on the first
   * `on`/`once`/... call; `emit` is a no-op while none exists.
   * ---------------------------------------------------------------- */

  /** Returns the emitter, creating (and wiring the abort bridge) on demand. */
  private get events(): EventEmitter {
    if (!this.#emitter) {
      const emitter = new EventEmitter();
      emitter.setMaxListeners(0);
      this.#emitter = emitter;

      // Bridge a dropped connection to `aborted`/`close` (Node emits these
      // when the request socket terminates). `aborted` fires only for a
      // *genuine* abort — one that happens before a response was produced;
      // once responded, a drop is reported solely as `close`. Wired once,
      // only when listened to.
      const signal = this.request.signal;
      if (!signal.aborted) {
        signal.addEventListener(
          "abort",
          () => {
            if (!this.#responded) {
              emitter.emit("aborted");
            }
            emitter.emit("close");
          },
          { once: true },
        );
      }
    }
    return this.#emitter;
  }

  /**
   * Marks the request as having received a response. Called by
   * {@link BunResponse} so a later connection drop is reported as `close`
   * rather than `aborted`, and {@link aborted} reads `false`.
   */
  markResponded(): this {
    this.#responded = true;
    return this;
  }

  /**
   * `true` when the connection was aborted **before** a response was produced
   * — a genuine client abort, not a normal post-response close. Mirrors
   * Node's `IncomingMessage.aborted`.
   */
  get aborted(): boolean {
    return this.request.signal.aborted && !this.#responded;
  }

  /** `true` once the request body has been fully received (Node `complete`). */
  get complete(): boolean {
    return this.#bodyState === "ended";
  }

  /**
   * Emits the buffered request body as Node-style `data`/`end` events (or
   * `error` if parsing failed) — exactly once, and only once both the body
   * has finished parsing and an emitter exists.
   */
  #flushBodyEvents(): void {
    if (
      this.#bodyEventsEmitted ||
      !this.#emitter ||
      this.#bodyState === "pending"
    ) {
      return;
    }
    this.#bodyEventsEmitted = true;

    if (this.#bodyState === "errored") {
      this.#emitter.emit("error", this.#bodyError);
      return;
    }

    if (this._buffer && this._buffer.length > 0) {
      this.#emitter.emit("data", this._buffer);
    }
    this.#emitter.emit("end");
  }

  /**
   * When a body-stream listener (`data`/`end`/`error`) is registered, arms a
   * deferred body-event flush. The microtask hop lets the caller finish
   * attaching all of its listeners before any event fires.
   */
  #scheduleBodyFlush(event: ReqEventName | string | symbol): void {
    if (
      !this.#bodyEventsEmitted &&
      (event === "data" || event === "end" || event === "error")
    ) {
      queueMicrotask(() => this.#flushBodyEvents());
    }
  }

  public on<E extends ReqEventName>(event: E, listener: ReqListener<E>): this {
    this.events.on(event, listener as (...args: any[]) => void);
    this.#scheduleBodyFlush(event);
    return this;
  }

  public addListener<E extends ReqEventName>(
    event: E,
    listener: ReqListener<E>,
  ): this {
    this.events.addListener(event, listener as (...args: any[]) => void);
    this.#scheduleBodyFlush(event);
    return this;
  }

  public once<E extends ReqEventName>(
    event: E,
    listener: ReqListener<E>,
  ): this {
    this.events.once(event, listener as (...args: any[]) => void);
    this.#scheduleBodyFlush(event);
    return this;
  }

  public prependListener<E extends ReqEventName>(
    event: E,
    listener: ReqListener<E>,
  ): this {
    this.events.prependListener(event, listener as (...args: any[]) => void);
    this.#scheduleBodyFlush(event);
    return this;
  }

  public prependOnceListener<E extends ReqEventName>(
    event: E,
    listener: ReqListener<E>,
  ): this {
    this.events.prependOnceListener(
      event,
      listener as (...args: any[]) => void,
    );
    this.#scheduleBodyFlush(event);
    return this;
  }

  public off<E extends ReqEventName>(event: E, listener: ReqListener<E>): this {
    this.#emitter?.off(event, listener as (...args: any[]) => void);
    return this;
  }

  public removeListener<E extends ReqEventName>(
    event: E,
    listener: ReqListener<E>,
  ): this {
    this.#emitter?.removeListener(event, listener as (...args: any[]) => void);
    return this;
  }

  public removeAllListeners<E extends ReqEventName>(event?: E): this {
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
  public emit<E extends ReqEventName>(
    event: E,
    ...args: Parameters<ReqListener<E>>
  ): boolean {
    return this.#emitter ? this.#emitter.emit(event, ...args) : false;
  }

  public listeners<E extends ReqEventName>(event: E): ReqListener<E>[] {
    return (this.#emitter?.listeners(event) ?? []) as ReqListener<E>[];
  }

  public listenerCount<E extends ReqEventName>(event: E): number {
    return this.#emitter?.listenerCount(event) ?? 0;
  }

  public eventNames(): (ReqEventName | string | symbol)[] {
    return this.#emitter?.eventNames() ?? [];
  }

  public setMaxListeners(max: number): this {
    this.events.setMaxListeners(max);
    return this;
  }

  public getMaxListeners(): number {
    return this.#emitter?.getMaxListeners() ?? EventEmitter.defaultMaxListeners;
  }

  /**
   * The request target as Express's `req.url`: path, query and (when the
   * `Request` carries one) fragment — not the absolute URL. Assignable, as in
   * Express; it starts equal to {@link originalUrl}. The absolute URL is
   * `req.request.url` (or `req.parsedUrl.href`).
   */
  get url(): string {
    return (this.#url ??= this.originalUrl);
  }

  set url(value: string) {
    this.#url = value;
  }

  /**
   * Parsed cookies — lazily allocated on first access. A value is the raw
   * string, or the parsed JSON of a `j:` cookie (an object, array, number,
   * boolean or `null`), so it is typed `JsonValue`.
   */
  get cookies(): Record<string, JsonValue> {
    return (this.#cookies ??= {});
  }

  set cookies(value: Record<string, JsonValue>) {
    this.#cookies = value;
  }

  /**
   * Signed cookies — lazily allocated on first access. A verified cookie's
   * value (parsed JSON for a `j:` one), or `false` when no secret verifies it.
   */
  get signedCookies(): Record<string, JsonValue> {
    return (this.#signedCookies ??= {});
  }

  set signedCookies(value: Record<string, JsonValue>) {
    this.#signedCookies = value;
  }

  /**
   * Matched route params — lazily allocated; the router assigns the real set.
   * Typed as `TParams`, which a path literal or a validator narrows.
   */
  get params(): TParams {
    return (this.#params ??= {}) as TParams;
  }

  set params(value: TParams) {
    this.#params = value as Record<string, string>;
  }

  /** Parsed query string — lazily allocated on first access. */
  get query(): TQuery {
    return (this.#query ??= {}) as TQuery;
  }

  set query(value: TQuery) {
    this.#query = value as Record<string, unknown>;
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
    return this.#server?.requestIP(this.request) || null;
  }

  /**
   * The `Bun.serve` server this request came in on — the one it was built
   * with. Its `port` is the port that accepted the request (`socket.localPort`
   * is the *peer's*). A socket-free `router.fetch()` request carries the fetch
   * stub instead, which has no `port`, `url` or real `upgrade`; `undefined`
   * only when a caller constructed the request without a server.
   */
  get server(): BunServer | undefined {
    return this.#server;
  }

  get route() {
    return this._route;
  }

  set route(route: BunRequestInterface["route"]) {
    this._route = route;
  }

  /**
   * Whether `socket.setKeepAlive(true)` has been called, **without** creating
   * the socket shim as a side effect.
   *
   * `keepAlive` starts `false` and can only become `true` through the `socket`
   * getter, so a request whose shim was never built cannot have it set. Reading
   * it through `socket` instead would allocate that shim — an object carrying
   * three accessors — on the first `response.headersSent` check of every
   * request, which `send()` and each pipeline layer perform.
   */
  get isKeepAlive(): boolean {
    return this.#socket?.keepAlive === true;
  }

  /**
   * A Node `net.Socket`-shaped shim — see {@link BunRequestSocket}. Its
   * emitter is created on the first listener, and only then is the client
   * disconnect (the request's abort signal) bridged to a `close` event.
   */
  get socket(): BunRequestSocket {
    // Memoized: the shim is stateful (`keepAlive`) and read on every
    // `response.headersSent` check, so it must be a single stable instance.
    if (this.#socket) {
      return this.#socket;
    }

    // eslint-disable-next-line ts/no-this-alias
    const that = this;
    let emitter: EventEmitter | undefined;

    const events = (): EventEmitter => {
      if (!emitter) {
        const created = new EventEmitter();
        created.setMaxListeners(0);
        emitter = created;

        const signal = that.request.signal;
        const onDisconnect = () => created.emit("close", false);
        if (signal.aborted) {
          queueMicrotask(onDisconnect);
        } else {
          signal.addEventListener("abort", onDisconnect, { once: true });
        }
      }
      return emitter;
    };

    const obj: BunRequestSocket = {
      keepAlive: false,
      setKeepAlive(enable = false) {
        obj.keepAlive = enable;
        return obj;
      },
      setNoDelay: () => obj,
      setTimeout(_timeout, callback) {
        if (callback) {
          events().once("timeout", callback);
        }
        return obj;
      },
      // Annotated: an overloaded member gives the implementation no
      // contextual parameter types.
      on(event: string, listener: AnySocketListener) {
        events().on(event, listener);
        return obj;
      },
      addListener(event: string, listener: AnySocketListener) {
        events().addListener(event, listener);
        return obj;
      },
      once(event: string, listener: AnySocketListener) {
        events().once(event, listener);
        return obj;
      },
      off(event: string, listener: AnySocketListener) {
        emitter?.off(event, listener);
        return obj;
      },
      removeListener(event: string, listener: AnySocketListener) {
        emitter?.removeListener(event, listener);
        return obj;
      },
      removeAllListeners(event) {
        if (event === undefined) {
          emitter?.removeAllListeners();
        } else {
          emitter?.removeAllListeners(event);
        }
        return obj;
      },
      emit: (event: string, ...args: unknown[]) =>
        emitter?.emit(event, ...args) ?? false,
      listenerCount: (event) => emitter?.listenerCount(event) ?? 0,
      get destroyed() {
        return that.request.signal.aborted;
      },
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

  /**
   * The parsed body. As with Express's body parsers:
   * - no body at all (no `Content-Length` and no `Transfer-Encoding`, e.g. a
   *   plain GET, or `fetch()` without a `body`) — `undefined`, never `{}`;
   * - a declared but empty body (`Content-Length: 0`) — `{}` for JSON and
   *   urlencoded, `""` for text, an empty `Buffer` for raw, `undefined` with no
   *   or an unrecognised `Content-Type`;
   * - `parseBody: false`, or not yet parsed — `undefined`.
   * Otherwise the parsed value (object, array, string or `Buffer`).
   */
  get body(): TBody {
    return this._body as TBody;
  }

  set body(data: TBody) {
    this._body = data as DefaultRequestBody;
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

  /**
   * Whether `options` sets any parse-affecting key ({@link MULTIPART_PARSE_KEYS})
   * to something other than what the cached result was parsed with.
   * `limits` is compared by its entries; everything else by identity.
   */
  #multipartOptionsDiffer(options: MultiPartOptions | undefined): boolean {
    if (!options) {
      return false;
    }
    const cached: MultiPartOptions = this.#multipartOptions ?? {};
    const given: MultiPartOptions = options;
    type Limits = NonNullable<MultiPartOptions["limits"]>;

    return MULTIPART_PARSE_KEYS.some((key) => {
      const next = given[key];
      if (next === undefined) {
        return false;
      }
      const previous = cached[key];
      if (key === "limits" && isObject(next)) {
        // Unset limits compare equal to `{}`.
        const a: Limits = next as Limits;
        const b: Limits = isObject(previous) ? (previous as Limits) : {};
        const names = new Set([...Object.keys(a), ...Object.keys(b)]);
        return [...names].some(
          (name) => a[name as keyof Limits] !== b[name as keyof Limits],
        );
      }
      return next !== previous;
    });
  }

  /**
   * Parses a `multipart/form-data` body with busboy.
   *
   * The body is parsed once, normally while the request is built (with
   * `parseBody.contentTypes.multipart.opts`), and that result is returned to
   * later calls. When a call's `options` set a parse-affecting key — busboy's
   * `limits`, `preservePath`, charsets, high-water marks, or `inflate` /
   * `fieldInflator` / `fileInflator` — to a different value, the buffered body
   * is **re-parsed** with those options merged over the original ones, so an
   * upload handler's `limits: { files: 1 }` applies.
   *
   * Fields: every value is kept in arrival order; a repeated name becomes an
   * array. With `inflate` (the default, as documented on `MultiPartOptions`),
   * bracketed names nest (`address[city]`) and each value is additionally
   * `JSON.parse`d when it is valid JSON — so `"1"` becomes `1` and `"true"`
   * becomes `true`, unlike multer, whose fields are always strings. Pass
   * `inflate: false` for multer's behaviour: names kept as sent, values
   * strings — typed {@link RawMultiPartFields}. (`inflate: false` always
   * re-parses a result that was inflated, so that type holds for a cached
   * result too.)
   *
   * busboy `limits` refuse the upload, as multer does, rather than cutting it
   * short: the parse rejects with an {@link UploadError} (status 413) the
   * moment a limit is hit, stops reading the body, and never resolves with
   * truncated data — `LIMIT_PART_COUNT` (`parts`), `LIMIT_FILE_COUNT`
   * (`files`), `LIMIT_FIELD_COUNT` (`fields`), `LIMIT_FILE_SIZE` (`fileSize`,
   * `field` naming the file's field), `LIMIT_FIELD_KEY` (`fieldNameSize`) and
   * `LIMIT_FIELD_VALUE` (`fieldSize`, `field` naming the field). The refusal
   * is remembered: calling again with the same options rejects the same way.
   *
   * @throws {UploadError} when a busboy limit is exceeded.
   */
  public async getMultiParts(
    options: MultiPartOptions & { inflate: false },
  ): Promise<MultiPartParseResult<RawMultiPartFields>>;
  public async getMultiParts(
    options: MultiPartOptions,
  ): Promise<MultiPartParseResult>;
  public async getMultiParts(
    options: MultiPartOptions,
  ): Promise<MultiPartParseResult> {
    if (this.#parsedMultipartResp || this.#multipartFailure) {
      if (!this.#multipartOptionsDiffer(options)) {
        if (this.#multipartFailure) {
          throw this.#multipartFailure.error;
        }
        if (this.#parsedMultipartResp) {
          return this.#parsedMultipartResp;
        }
      }

      // Merged by key; values are the options' own, of mixed types.
      const merged: Record<string, unknown> = { ...this.#multipartOptions };
      for (const [key, value] of Object.entries(options)) {
        if (value !== undefined) {
          merged[key] = value;
        }
      }
      options = merged as MultiPartOptions;
    }

    const contentTypeHeader = this.getHeader("Content-Type");
    if (!this.buffer || !contentTypeHeader?.includes("multipart/form-data")) {
      return {
        files: new Map(),
        fields: {},
      };
    }

    const buffer = this.buffer;
    const parseOptions = options;
    return new Promise((resolve, reject) => {
      const files = new Map<MultiPartFileRecord, Set<string>>();
      const fieldNameAndValue = new Map<string, string[]>();

      let { inflate, fileInflator, fieldInflator } = options;
      const busBoyOpts = omit(options, [
        "inflate",
        "fileInflator",
        "fieldInflator",
      ]);

      if (!isBoolean(inflate)) {
        inflate = true;
      }

      // `obj` is the query parser's untyped tree, walked by shape.
      const recursivelyReplacePlaceholder = (
        obj: Record<string, unknown>,
        replacement: Buffer,
        valueToReplace: string,
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

              // Attempt to inflate using the query-string parser. The value is
              // encoded so a `&`, `=`, `+` or `%` in it survives as data.
              if (!isObject(parsedData)) {
                parsedData = parseQueryString(
                  `${fieldname}=${encodeURIComponent(value)}`,
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

      /** Set once the parse has resolved or rejected; later events are ignored. */
      let settled = false;

      /** Rejects the parse once, remembering why (see `#multipartFailure`). */
      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        files.clear();
        fieldNameAndValue.clear();
        this.#multipartOptions = parseOptions;
        this.#parsedMultipartResp = undefined;
        this.#multipartFailure = { error };
        reject(error);
      };

      try {
        const bb = busboy({ ...busBoyOpts, headers: this.headers });
        const source = Readable.from(buffer);
        // Track each file handler's promise so the `close` event can await
        // completion deterministically instead of polling state arrays.
        const filePromises: Promise<void>[] = [];

        // multer's `abortWithCode`: refuse the upload, stop feeding busboy and
        // cancel the body, so nothing truncated is ever resolved.
        const abort = (code: UploadErrorCode, field?: string) => {
          if (settled) {
            return;
          }
          fail(new UploadError(code, { field }));
          source.unpipe(bb);
          source.destroy();
        };

        // busboy never truncates a multipart part's name (its `nameTruncated`
        // is always `false` there), so, as multer does, `fieldNameSize` is
        // checked by hand — only when it was given.
        const { limits } = options;
        const fieldNameSize =
          limits && Object.hasOwn(limits, "fieldNameSize")
            ? limits.fieldNameSize
            : undefined;
        const nameTooLong = (name: string) =>
          fieldNameSize !== undefined && name.length > fieldNameSize;

        bb.on("partsLimit", () => abort("LIMIT_PART_COUNT"));
        bb.on("filesLimit", () => abort("LIMIT_FILE_COUNT"));
        bb.on("fieldsLimit", () => abort("LIMIT_FIELD_COUNT"));

        bb.on("file", (name, file, info) => {
          file.on("limit", () => abort("LIMIT_FILE_SIZE", name));
          if (nameTooLong(name)) {
            abort("LIMIT_FIELD_KEY");
          }
          if (settled) {
            file.resume();
            return;
          }

          const task = (async () => {
            const fileBuffer = await streamToBuffer(file);
            const mimeTypeResp: FileTypeResult | undefined =
              await fileTypeFromBuffer(fileBuffer);

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

                // `obj` is `unknown`: the inflator's output is walked by
                // shape, and a custom `fileInflator` may return anything.
                const processNestedValuePath = (
                  obj: unknown,
                  paths: string[],
                ) => {
                  try {
                    if (obj === fileBuffer) {
                      const pathStr = paths.reduce(
                        (prev, val) => `${prev}[${val}]`,
                        ``,
                      );

                      if (!pathListInFileMap.has(pathStr)) {
                        pathListInFileMap.add(pathStr);
                      }
                    } else if (
                      (isObject(obj) || isArray(obj)) &&
                      !Buffer.isBuffer(obj)
                    ) {
                      // Direct property access: an inflator's key may itself
                      // contain brackets (`docs[passport]`), which a
                      // path-aware `get()` would misread as nesting.
                      const record = obj as Record<string, unknown>;
                      Object.keys(record).forEach((key) => {
                        processNestedValuePath(record[key], [...paths, key]);
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
          })();
          // `close` awaits every task; this only keeps a task whose stream an
          // abort cut off from surfacing as an unhandled rejection.
          task.catch(() => {});
          filePromises.push(task);
        });

        bb.on("field", (name, val, info) => {
          // multer checks the name before the value.
          if (info.nameTruncated) {
            abort("LIMIT_FIELD_KEY");
            return;
          }
          if (info.valueTruncated) {
            abort("LIMIT_FIELD_VALUE", name);
            return;
          }
          if (nameTooLong(name)) {
            abort("LIMIT_FIELD_KEY");
            return;
          }
          if (settled) {
            return;
          }

          // Every value, in arrival order — a repeated identical value is
          // data, as in busboy and multer.
          const valueList = fieldNameAndValue.get(name);
          if (valueList) {
            valueList.push(val);
          } else {
            fieldNameAndValue.set(name, [val]);
          }
        });

        bb.on("close", async () => {
          if (settled) {
            return;
          }
          const fileResults = await Promise.allSettled(filePromises);
          if (settled) {
            return;
          }
          const failedFile = fileResults.find(
            (result) => result.status === "rejected",
          );
          if (failedFile && failedFile.status === "rejected") {
            fail(failedFile.reason);
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
          for (const [fieldName, values] of fieldNameAndValue) {
            if (!(inflate && fieldInflator)) {
              // Names kept exactly as sent; a repeated name is an array.
              fields[fieldName] = values.length > 1 ? [...values] : values[0];
              continue;
            }

            // A repeated name is inflated per value, with its index.
            const entries: [string, string][] =
              values.length > 1
                ? values.map((value, index) => [
                    `${fieldName}[${index}]`,
                    value,
                  ])
                : [[fieldName, values[0]]];

            for (const [name, value] of entries) {
              const parsedData = await fieldInflator(name, value, undefined);
              // Direct property access: a key may contain brackets, which a
              // path-aware `get()` would read as nesting and find nothing.
              for (const key of Object.keys(parsedData)) {
                fields = merge(fields, { [key]: parsedData[key] });
              }
            }
          }

          settled = true;
          this._contentType = "multipart";
          this.#multipartOptions = parseOptions;
          this.#multipartFailure = undefined;
          this.#parsedMultipartResp = {
            files,
            fields,
          };

          resolve(this.#parsedMultipartResp);
        });

        bb.on("error", (error) => fail(error));
        source.pipe(bb);
      } catch (err) {
        fail(err);
      }
    });
  }

  // The body parsers never write request headers: `Content-Type` stays exactly
  // what the client sent (a sniffed body is reported by `isBodyParsed` and the
  // body's shape, not by a rewritten header).

  private async handleUrlFormEncodingParsing(data: string) {
    try {
      const parsedData = parseSearchString(
        data,
        withDefaultQueryOpts(this.getParserOpts("urlencoded")),
      );

      if (isObject(parsedData) || isArray(parsedData)) {
        this._body = parsedData;
        this._contentType = "form";
        return true;
      }
    } catch {
      //
    }

    return false;
  }

  private async handleJsonBodyParsing(data: string) {
    try {
      this._body = JSON.parse(data, this.getParserOpts("json")?.reviver);
      this._contentType = "json";
      return true;
    } catch {
      // return false;
    }
    return false;
  }

  private async handleXmlBodyParsing(data: string) {
    try {
      this._body = parseXmlToObject(
        data,
        this.getParserOpts("xml") ?? this.legacyOptions.parseXmlOpts,
      );
      this._contentType = "xml";
      return true;
    } catch {
      // return false;
    }
    return false;
  }

  /**
   * Non-`@deprecated` view of the legacy options, used by the library's own
   * fallback reads so they don't trip the deprecation warning that the public
   * option fields carry for callers.
   */
  private get legacyOptions(): LegacyBodyOptions {
    return this.options;
  }

  /**
   * Resolves the object form of `parseBody` into the internal `#allowedParsers`
   * allowlist, `#maxContentLength` cap and `#perTypeConfig` overrides. The
   * deprecated `allowedContentTypes` option is honoured as a fallback when the
   * new `contentTypes` map is absent.
   */
  private normalizeParseBodyOptions(): void {
    // Reset derived state so this is safe to re-run (see setParseBodyOptions).
    this.#allowedParsers = undefined;
    this.#perTypeConfig = undefined;
    this.#maxContentLength = undefined;
    this.#bodyCapsEnabled = false;
    this.#inflate = true;
    this.#decompressionFastPathLimit = DEFAULT_DECOMPRESS_FAST_PATH_LIMIT;
    this.#contentEncodings = "*";
    this.#maxContentCodings = DEFAULT_MAX_CONTENT_CODINGS;
    this.#compressionDictionaries = undefined;

    // Deprecated allowlist fallback (overridden below by `contentTypes`).
    // Invalid/empty entries are dropped; an allowlist that filters down to
    // nothing means "no restriction" rather than "block every kind".
    const legacyAllowed = this.legacyOptions.allowedContentTypes;
    if (isArray(legacyAllowed)) {
      const allowed = new Set(
        legacyAllowed.filter((kind) => VALID_PARSER_KINDS.has(kind)),
      );
      this.#allowedParsers = allowed.size ? allowed : undefined;
    }

    const parseBody = this.options.parseBody;
    // Boolean form (or default): uncapped, every kind allowed.
    if (!isObject(parseBody) || isArray(parseBody)) {
      return;
    }

    const config = parseBody as ParseBodyConfig;

    // Object form: body-size caps apply. Store the explicit config-level cap
    // (if any); when unset, the per-kind defaults are used at resolve time.
    this.#bodyCapsEnabled = true;
    this.#maxContentLength =
      config.maxContentLength !== undefined
        ? parseByteSize(config.maxContentLength)
        : undefined;
    // Body decoding, resolved here with the caps so it reaches the parse the
    // constructor schedules — which reads the body before any middleware.
    this.#inflate = config.inflate !== false;
    this.#decompressionFastPathLimit = resolveDecompressionFastPathLimit(
      config.decompressionFastPathLimit,
    );
    this.#contentEncodings = resolveContentEncodings(config.encodings);
    this.#maxContentCodings = resolveMaxContentCodings(
      config.maxContentCodings,
    );
    this.#compressionDictionaries = resolveCompressionDictionaries(
      config.compressionDictionaries,
    );

    const contentTypes = config.contentTypes;
    // `"all"` (or omitted) → no kind restriction beyond any deprecated
    // allowlist already resolved above.
    if (contentTypes === undefined || contentTypes === "all") {
      return;
    }

    if (!isObject(contentTypes)) {
      return;
    }

    const allowed = new Set<ContentParserType>();
    const perType = new Map<ContentParserType, PerTypeParserConfig>();

    for (const key of keys(contentTypes) as ContentParserType[]) {
      // Ignore unrecognized keys entirely.
      if (!VALID_PARSER_KINDS.has(key)) {
        continue;
      }

      const value = contentTypes[key];
      // `false`/`null`/`undefined` → kind explicitly disallowed.
      if (value === false || isNull(value) || isUndefined(value)) {
        continue;
      }

      allowed.add(key);

      // An object entry both allows the kind and configures it.
      if (isObject(value) && !isBoolean(value)) {
        const typeConfig = value as ParseBodyContentTypeConfig;
        const max =
          typeConfig.maxContentLength !== undefined
            ? parseByteSize(typeConfig.maxContentLength)
            : undefined;
        perType.set(key, { opts: typeConfig.opts, maxContentLength: max });
      }
    }

    this.#allowedParsers = allowed;
    if (perType.size) {
      this.#perTypeConfig = perType;
    }
  }

  /**
   * Resolves the effective byte cap for a body of the given parser kind, in
   * precedence order:
   * 1. the kind's own `maxContentLength` (`parseBody.contentTypes.<kind>`);
   * 2. the config-level `parseBody.maxContentLength`;
   * 3. the per-kind default (10mb for `multipart`/`raw`, else 100kb).
   *
   * Returns `undefined` (uncapped) for the boolean `parseBody` form.
   */
  private resolveContentLimit(
    kind: ContentParserType | undefined,
  ): number | undefined {
    if (!this.#bodyCapsEnabled) {
      return undefined;
    }

    if (kind && this.#perTypeConfig) {
      const typeConfig = this.#perTypeConfig.get(kind);
      if (typeConfig && typeConfig.maxContentLength !== undefined) {
        return typeConfig.maxContentLength;
      }
    }

    if (this.#maxContentLength !== undefined) {
      return this.#maxContentLength;
    }

    const kindDefault = kind
      ? DEFAULT_MAX_CONTENT_LENGTH_BY_KIND[kind]
      : undefined;
    return kindDefault ?? DEFAULT_MAX_CONTENT_LENGTH;
  }

  /**
   * Returns the per-content-type parser `opts` configured for the given kind
   * via `parseBody.contentTypes.<kind>.opts`, or `undefined` when unset.
   */
  private getParserOpts<K extends ContentParserType>(
    kind: K,
  ): ContentTypeParserOptsMap[K] | undefined {
    return this.#perTypeConfig?.get(kind)?.opts as
      | ContentTypeParserOptsMap[K]
      | undefined;
  }

  /**
   * Reads the request body into a `Buffer` while enforcing a byte cap. When
   * `limit` is set, the declared `Content-Length` is checked first (rejecting
   * an oversized body before a single byte is buffered); then the body stream
   * is read chunk-by-chunk, aborting the moment the accumulated size crosses
   * the cap — so a missing or dishonest `Content-Length` (chunked uploads)
   * cannot bypass it. An uncapped `limit` reads the whole body in one shot.
   *
   * @throws {PayloadTooLargeError} when the body exceeds `limit`.
   */
  private async readBodyWithLimit(limit: number | undefined): Promise<Buffer> {
    if (limit !== undefined) {
      const declared = this.getHeader("Content-Length");
      if (declared) {
        const declaredLength = Number(declared);
        if (Number.isFinite(declaredLength) && declaredLength > limit) {
          throw new PayloadTooLargeError(limit, declaredLength);
        }
      }
    }

    const stream = this.request.body;
    // No cap, or no readable stream (empty body): one-shot read.
    if (limit === undefined || !stream) {
      return Buffer.from(await this.request.arrayBuffer());
    }

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          total += value.byteLength;
          if (total > limit) {
            await reader.cancel();
            throw new PayloadTooLargeError(limit, total);
          }
          chunks.push(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        //
      }
    }

    return Buffer.concat(chunks);
  }

  /**
   * Maps a `Content-Type` header to the {@link ContentParserType} that would
   * handle it, or `undefined` for an unrecognized media type.
   */
  private detectParserKind(contentType: string): ContentParserType | undefined {
    const ct = contentType.toLowerCase();
    switch (true) {
      case ct.includes("application/json") || ct.includes("+json"):
        return "json";
      case ct.includes("application/x-www-form-urlencoded"):
        return "urlencoded";
      case ct.includes("multipart/form-data"):
        return "multipart";
      case ct.includes("application/xml") ||
        ct.includes("text/xml") ||
        ct.includes("+xml"):
        return "xml";
      case ct.includes("text/plain"):
        return "text";
      case ct.includes("application/octet-stream"):
        return "raw";
      default:
        return undefined;
    }
  }

  /**
   * Whether the given parser kind is permitted by `allowedContentTypes`. The
   * `"raw"` kind is always allowed — it is the fallback for everything else.
   */
  private isParserAllowed(type: ContentParserType): boolean {
    if (type === "raw" || !this.#allowedParsers) {
      return true;
    }
    return this.#allowedParsers.has(type);
  }

  /**
   * Leaves the body untouched as a raw `Buffer`. The request's `Content-Type`
   * is never rewritten.
   */
  private leaveBodyAsRaw(buffer: Buffer) {
    this._body = buffer;
    this._buffer = buffer;
    this._contentType = "buffer";
  }

  /**
   * Decodes a body per its `Content-Encoding` through `decompressBody`:
   * `gzip`/`x-gzip`, `deflate` and `br` as body-parser does, plus `zstd`,
   * `dcb`/`dcz` (with {@link #compressionDictionaries}) and stacked codings
   * (`gzip, br`, decoded last to first), which body-parser refuses. `identity`
   * (or no header) is returned as is. An HTTP 415 error answers inflation off,
   * a coding unsupported or outside {@link #contentEncodings}, or more than
   * {@link #maxContentCodings} stacked; a 400 answers a corrupt layer or a
   * dictionary not provided.
   *
   * `limit` caps the **decoded** size of every layer, body-parser's `limit`
   * applied after inflation: a body that would decode past it (a
   * decompression bomb) is a {@link PayloadTooLargeError} (413). Bun's own
   * decoders run when a layer's worst case fits
   * {@link #decompressionFastPathLimit}; otherwise `node:zlib` decodes,
   * stopping at the limit.
   */
  #decodeContentEncoding(buffer: Buffer, limit: number | undefined): Buffer {
    const header = this.getHeader("Content-Encoding") ?? "";
    const codings = parseContentCodings(header);
    // No body at all (no `Content-Length`, no `Transfer-Encoding`, as
    // `type-is` defines it) is never decoded — body-parser skips such a
    // request before looking at its encoding.
    if (
      codings.length === 0 ||
      (buffer.length === 0 &&
        !typeIs.hasBody(this as unknown as IncomingMessage))
    ) {
      return buffer;
    }

    if (!this.#inflate) {
      throw this.#refuseEncoding(415, "content encoding unsupported");
    }

    let decoded: Buffer | undefined;
    try {
      decoded = decompressBody(buffer, header, {
        maxOutputLength: limit,
        fastPathLimit: this.#decompressionFastPathLimit,
        encodings: this.#contentEncodings,
        maxCodings: this.#maxContentCodings,
        dictionaries: this.#compressionDictionaries,
      });
    } catch (error) {
      if (error instanceof DecompressionLimitError) {
        throw new PayloadTooLargeError(error.limit);
      }
      if (error instanceof ContentCodingLimitError) {
        throw this.#refuseEncoding(
          415,
          `too many content encodings (${error.count}, at most ${error.limit})`,
        );
      }
      if (error instanceof UnknownCompressionDictionaryError) {
        throw this.#refuseEncoding(400, "unknown compression dictionary");
      }
      if (error instanceof DecompressionError) {
        throw this.#refuseEncoding(400, "invalid compressed request body");
      }
      // A dictionary resolver's own failure is the server's, not a 4xx.
      throw error;
    }

    if (!decoded) {
      const refused =
        codings.find(
          (coding) => !isContentCodingAllowed(coding, this.#contentEncodings),
        ) ?? codings.join(", ");
      throw this.#refuseEncoding(
        415,
        `unsupported content encoding "${refused}"`,
      );
    }
    return decoded;
  }

  /** Builds, and records as {@link bodyDecodingError}, a refused `Content-Encoding`. */
  #refuseEncoding(statusCode: 400 | 415, message: string): BunHttpClientError {
    const error = httpError(statusCode, message);
    this.#bodyDecodingError = error;
    return error;
  }

  /**
   * Replaces the `parseBody` option at runtime and re-resolves the derived
   * allowlist, size caps and per-content-type config. Useful from a middleware
   * to tailor body handling per route — e.g. raise the cap for an upload
   * endpoint, or restrict the allowed content types.
   *
   * Changing the size cap only affects a body that has **not** been read yet
   * (the raw buffer is cached after the first read). To apply new options to an
   * already-buffered body, follow this with {@link parseBody} (passing `true`
   * to re-parse), or use {@link parseBodyWithOptions} which does both.
   */
  public setParseBodyOptions(parseBody: ParseBodyOption) {
    this.options.parseBody = parseBody;
    this.normalizeParseBodyOptions();
    return this;
  }

  /**
   * Applies `parseBody` options (via {@link setParseBodyOptions}) and then
   * parses the body with them in a single call. `fresh` forces a re-parse of an
   * already-parsed body (its cached buffer is reused — the size cap is only
   * enforced on the initial network read). Returns the same shape as
   * {@link parseBody}.
   *
   * @throws {PayloadTooLargeError} when an unread body exceeds the cap (the
   * {@link isPayloadTooLarge} flag is set before the throw).
   */
  public async parseBodyWithOptions(parseBody: ParseBodyOption, fresh = false) {
    this.setParseBodyOptions(parseBody);
    return this.parseBody(fresh);
  }

  public setMultipartParserOptions(opts: MultiPartOptions) {
    set(this.options, "parseMultiPartFormDataOpts", opts);
    return this;
  }

  public setXmlParserOptions(opts: ParseXmlOptions) {
    set(this.options, "parseXmlOpts", opts);
    return this;
  }

  /**
   * Restricts which body media types are parsed (see `allowedContentTypes`).
   * Pass `undefined` to remove the restriction and parse every supported kind.
   */
  public setAllowedContentTypes(types: ContentParserType[] | undefined) {
    this.legacyOptions.allowedContentTypes = types;
    if (isArray(types)) {
      const allowed = new Set(
        types.filter((kind) => VALID_PARSER_KINDS.has(kind)),
      );
      this.#allowedParsers = allowed.size ? allowed : undefined;
    } else {
      this.#allowedParsers = undefined;
    }
    return this;
  }

  /** Replaces `parseQueryOpts`; merged over the defaults when parsing. */
  public setQueryParserOptions(opts: QueryParserOpts) {
    set(this.options, "parseQueryOpts", opts);
    return this;
  }

  /**
   * Parses the query string into `req.query` and returns it. `opts` (else
   * `parseQueryOpts`) are merged over {@link DEFAULT_PARSE_QUERY_OPTS}.
   */
  public parseQuery(opts?: QueryParserOpts) {
    const options = withDefaultQueryOpts(opts || this.options?.parseQueryOpts);

    // The parser returns the untyped shape; `TQuery` is the caller's view of it.
    this.query = parseSearchString(
      this.splitRequestUrl().search,
      options,
    ) as TQuery;
    return this.query;
  }

  /**
   * Parses the `Cookie` header as cookie-parser does and returns
   * `{ cookies, signedCookies }`. With a secret (`opts.secret`, else
   * `req.secret`), every `s:` cookie moves from `cookies` to `signedCookies`:
   * its unsigned value when a secret verifies it, `false` when none does
   * (tampered). `j:` values are expanded in both.
   *
   * The result is written to `req.cookies`/`req.signedCookies` when they have
   * not been parsed yet (e.g. `parseCookies: false`), or always with
   * `forceUpdateRequest: true`.
   */
  public parseCookies(opts?: {
    /** Overwrite `req.cookies`/`req.signedCookies` even when already parsed. */
    forceUpdateRequest?: boolean;
    /** Secret(s) to verify signed cookies with; the first becomes `req.secret` when unset. */
    secret?: BunRequest["secret"];
  }): BunRequestCookies {
    const forceUpdateRequest = isBoolean(opts?.forceUpdateRequest)
      ? opts?.forceUpdateRequest
      : false;
    const updateRequest = forceUpdateRequest || this.#cookies === undefined;

    const sentSecret = !isUndefined(opts?.secret) ? opts?.secret : "";

    let reqSecret = this.secret;
    if (!reqSecret && sentSecret) {
      this.secret = isArray(sentSecret) ? sentSecret[0] : sentSecret;
      reqSecret = this.secret;
    }

    const cookieStr =
      this.getHeader("cookie") || this.getHeader("Cookie") || "";

    if (!cookieStr) {
      const empty = { cookies: {}, signedCookies: {} };
      if (updateRequest) {
        this.cookies = {};
        this.signedCookies = {};
      }
      return empty;
    }

    // With no secret passed, a `req.secret` still holding the `cookieSecret`
    // option's first entry verifies with the whole rotation, not just it.
    const configuredSecrets = this.#configuredCookieSecrets();
    const secrets = isArray(sentSecret)
      ? sentSecret
      : isString(sentSecret) && sentSecret
        ? [sentSecret]
        : isArray(this.secret)
          ? this.secret
          : isString(this.secret) && this.secret
            ? this.secret === configuredSecrets[0]
              ? configuredSecrets
              : [this.secret]
            : [];

    const cookies = parseCookie(
      cookieStr,
      this.options.cookieParseOptions,
    ) as Record<string, string>;
    let signedCookiesObj: Record<string, JsonValue> = {};

    if (secrets.length) {
      const verified = extractSignedCookies(cookies, secrets);
      // cookie-parser reports an `s:` cookie no secret verifies as `false`
      // and removes it from `cookies`, so a tampered value is never trusted.
      const tampered: Record<string, false> = {};
      for (const key of Object.keys(cookies)) {
        if (cookies[key].startsWith("s:")) {
          tampered[key] = false;
          delete cookies[key];
        }
      }
      signedCookiesObj = { ...jsonCookies(verified), ...tampered };
    }

    const resp: BunRequestCookies = {
      signedCookies: signedCookiesObj,
      cookies: jsonCookies(cookies),
    };

    if (updateRequest) {
      this.cookies = resp.cookies;
      this.signedCookies = resp.signedCookies;
    }

    return resp;
  }

  /**
   * Reads and parses the body (see `parseBody` option docs). A request with no
   * body — no `Content-Length` and no `Transfer-Encoding`, as `type-is`
   * defines it — leaves `req.body` `undefined`, as Express's body parsers do;
   * a declared-but-empty JSON or urlencoded body gives `{}`, and an empty text
   * body `""`. Request headers are never modified.
   */
  public async parseBody(fresh = false) {
    return this.#parseBody(fresh, undefined);
  }

  /** {@link parseBody}, with an optional byte cap overriding `parseBody`'s. */
  async #parseBody(fresh: boolean, limitOverride: number | undefined) {
    if (!fresh && this.isBodyParsed) {
      return {
        body: this._body,
        buffer: this._buffer,
        contentType: this._contentType,
        multipart: this.#parsedMultipartResp,
      };
    }

    const contentTypeHeader = this.getHeader("Content-Type");
    const declaredKind = contentTypeHeader
      ? this.detectParserKind(contentTypeHeader)
      : undefined;
    const limit = limitOverride ?? this.resolveContentLimit(declaredKind);

    let buffer = this._buffer;
    if (!buffer && !this.request.bodyUsed) {
      // Read the body under the cap resolved from the declared content type —
      // rejecting an oversized payload before (or while) it is buffered. See
      // {@link readBodyWithLimit}.
      try {
        buffer = this.#decodeContentEncoding(
          await this.readBodyWithLimit(limit),
          limit,
        );
        if (limit !== undefined && buffer.length > limit) {
          throw new PayloadTooLargeError(limit, buffer.length);
        }
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          this.#payloadTooLarge = { limit: error.limit, length: error.length };
        }
        throw error;
      }
    }

    if (!buffer) {
      throw new Error("Invalid body sent");
    }

    this._buffer = buffer;
    this.#bodyParsed = true;

    if (buffer.length === 0) {
      this._body = undefined;
      // `as unknown as IncomingMessage` here and below: `type-is` and
      // `accepts` are typed for Node's request, and read only the headers
      // this class exposes under the same names.
      if (typeIs.hasBody(this as unknown as IncomingMessage) && declaredKind) {
        if (!this.isParserAllowed(declaredKind)) {
          this.leaveBodyAsRaw(buffer);
        } else if (declaredKind === "json" || declaredKind === "urlencoded") {
          this._body = {};
        } else if (declaredKind === "text") {
          this._body = "";
        } else if (declaredKind === "raw") {
          this.leaveBodyAsRaw(buffer);
        }
      }

      return {
        body: this._body,
        buffer: this._buffer,
        contentType: this._contentType,
        multipart: this.#parsedMultipartResp,
      };
    }

    const bufferText = buffer.toString();

    if (!contentTypeHeader) {
      let hasParsedData = false;

      // Try JSON parse
      if (!hasParsedData && this.isParserAllowed("json")) {
        hasParsedData = await this.handleJsonBodyParsing(bufferText);
      }

      // Try XML parse (only when the payload actually looks like XML) — this
      // runs before the url-encoded attempt, which would otherwise greedily
      // accept arbitrary text.
      if (
        !hasParsedData &&
        this.isParserAllowed("xml") &&
        bufferText.trimStart().startsWith("<")
      ) {
        hasParsedData = await this.handleXmlBodyParsing(bufferText);
      }

      // Try url-encoded form data parse
      if (!hasParsedData && this.isParserAllowed("urlencoded")) {
        hasParsedData = await this.handleUrlFormEncodingParsing(bufferText);
      }

      // Leave it as buffer
      if (!hasParsedData) {
        this.leaveBodyAsRaw(buffer);
      }
    } else {
      const kind = declaredKind;

      // A recognized media type whose parser was excluded via
      // `allowedContentTypes`/`parseBody.contentTypes` is left as a raw buffer.
      if (kind && !this.isParserAllowed(kind)) {
        this.leaveBodyAsRaw(buffer);
      } else {
        switch (kind) {
          case "text": {
            const encoding = this.getParserOpts("text")?.encoding;
            this._body = encoding ? buffer.toString(encoding) : bufferText;
            this._contentType = "text";
            break;
          }

          case "raw": {
            this.leaveBodyAsRaw(buffer);
            break;
          }

          case "json": {
            await this.handleJsonBodyParsing(bufferText);
            break;
          }

          case "urlencoded": {
            await this.handleUrlFormEncodingParsing(bufferText);
            break;
          }

          case "xml": {
            await this.handleXmlBodyParsing(bufferText);
            break;
          }

          case "multipart": {
            await this.getMultiParts(
              this.getParserOpts("multipart") ??
                this.legacyOptions.parseMultiPartFormDataOpts ??
                {},
            );
            break;
          }

          default: {
            this.leaveBodyAsRaw(buffer);
            break;
          }
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

  /** Whether the request matches a body-parser `type` option (body-parser's `typeChecker`). */
  #matchesBodyParserType(
    type: NonNullable<BodyParserOptions["type"]>,
  ): boolean {
    if (typeof type === "function") {
      return Boolean(type(this as unknown as IncomingMessage));
    }
    // Matched on the header alone: `type-is`'s request form also requires a
    // `Content-Length`/`Transfer-Encoding`, which a `Request` built in process
    // (`fetch()`, tests) does not carry even with a body.
    const contentType = this.getHeader("Content-Type");
    return Boolean(
      contentType && typeIs.is(contentType, isString(type) ? [type] : type),
    );
  }

  /**
   * The body-parser middleware entry point (`useBodyParser` /
   * `registerParserMiddleware`). Parses the body when `parseBody` is enabled
   * and resolves the buffered body when `returnBuffer` is `true`.
   *
   * `options` follow body-parser:
   * - `type` — a media type, list, or `(req) => boolean`. A request that does
   *   not match (or has no body) is skipped: nothing is parsed and
   *   `undefined` is returned. Without `type`, `parser` picks body-parser's
   *   default for that kind (`json` → `application/json`, …); with neither,
   *   every request is parsed.
   * - `limit` — bytes or a string (`"1mb"`). Overrides `parseBody`'s cap; a
   *   larger body throws {@link PayloadTooLargeError} (413), including one
   *   already buffered while the request was built. Unset keeps `parseBody`'s
   *   own cap (body-parser would default to 100kb).
   * - `inflate` — `true` (default) decodes `gzip`/`x-gzip`, `deflate`, `br`,
   *   `zstd`, stacked codings (`gzip, br`) and, with
   *   `compressionDictionaries`, `dcb`/`dcz`; `false` rejects any
   *   `Content-Encoding` but `identity` with a 415 error. The other
   *   {@link BodyDecodingOptions} (`encodings`, `maxContentCodings`,
   *   `decompressionFastPathLimit`, `compressionDictionaries`) apply too.
   *
   * With `parseBody: false` on the request this parses nothing.
   *
   * `returnBuffer: true` resolves `Buffer | undefined`, never a guaranteed
   * buffer: it is `undefined` when the request does not match `type`, when
   * `parseBody` is off and nothing was buffered, or when the body was already
   * consumed without being buffered.
   */
  public async handleBodyParsing(): Promise<undefined>;
  public async handleBodyParsing(
    returnBuffer: false,
    options?: BodyParserOptions,
    parser?: BodyParserType,
  ): Promise<undefined>;
  public async handleBodyParsing(
    returnBuffer: true,
    options?: BodyParserOptions,
    parser?: BodyParserType,
  ): Promise<Buffer | undefined>;
  public async handleBodyParsing(
    returnBuffer = false,
    options?: BodyParserOptions,
    parser?: BodyParserType,
  ): Promise<Buffer | undefined> {
    if (!this.options.parseBody) {
      if (returnBuffer && this._buffer) {
        return Buffer.from(this._buffer);
      }
      return;
    }

    const type =
      options?.type ?? (parser ? DEFAULT_BODY_PARSER_TYPES[parser] : undefined);
    if (type !== undefined && !this.#matchesBodyParserType(type)) {
      return;
    }

    if (options?.decompressionFastPathLimit !== undefined) {
      this.#decompressionFastPathLimit = resolveDecompressionFastPathLimit(
        options.decompressionFastPathLimit,
      );
    }
    if (options?.maxContentCodings !== undefined) {
      this.#maxContentCodings = resolveMaxContentCodings(
        options.maxContentCodings,
      );
    }
    if (options?.compressionDictionaries !== undefined) {
      this.#compressionDictionaries = resolveCompressionDictionaries(
        options.compressionDictionaries,
      );
    }
    if (options?.encodings !== undefined) {
      this.#contentEncodings = resolveContentEncodings(options.encodings);
    }

    // `inflate` and `encodings` refuse a coding even for a body already read,
    // as body-parser checks `inflate` in every parser it runs.
    if (options?.inflate !== undefined || options?.encodings !== undefined) {
      if (options.inflate !== undefined) {
        this.#inflate = options.inflate !== false;
      }
      const codings = parseContentCodings(
        this.getHeader("Content-Encoding") ?? "",
      );
      if (!this.#inflate && codings.length > 0) {
        throw httpError(415, "content encoding unsupported");
      }
      const refused =
        options.encodings === undefined
          ? undefined
          : codings.find(
              (coding) =>
                !isContentCodingAllowed(coding, this.#contentEncodings),
            );
      if (refused !== undefined) {
        throw httpError(415, `unsupported content encoding "${refused}"`);
      }
    }

    const limit =
      options?.limit !== undefined ? parseByteSize(options.limit) : undefined;
    if (limit !== undefined && this._buffer && this._buffer.length > limit) {
      this.#payloadTooLarge = { limit, length: this._buffer.length };
      throw new PayloadTooLargeError(limit, this._buffer.length);
    }

    if (this.request.bodyUsed && !this._buffer) {
      return;
    }

    const parsedBodyResp = await this.#parseBody(false, limit);

    if (returnBuffer) {
      return parsedBodyResp.buffer;
    }
  }

  /** `true` once the body has been parsed (a body left `undefined` included). */
  get isBodyParsed() {
    return this.#bodyParsed || !!this._contentType;
  }

  /**
   * `true` when {@link parseBody} aborted because the body exceeded its
   * configured `maxContentLength`. Adapters read this after `init` to respond
   * with HTTP 413 before any route handler runs.
   */
  get isPayloadTooLarge(): boolean {
    return !!this.#payloadTooLarge;
  }

  /**
   * Details of the cap that was exceeded (`limit`, and the observed `length`
   * when known), or `undefined` when the body was within its cap.
   */
  get payloadTooLarge(): { limit: number; length?: number } | undefined {
    return this.#payloadTooLarge;
  }

  /**
   * The HTTP error a body read was refused with because its
   * `Content-Encoding` could not be decoded: `415` with `inflate: false` or
   * for an unsupported coding, `400` for a corrupt stream. `undefined` while
   * no read hit one.
   *
   * Adapters read it after `init`, next to {@link isPayloadTooLarge}: a body
   * parsed while the request was built is read before any middleware, so the
   * adapter passes this error to its error handling (body-parser's
   * `next(err)`), answering with its status instead of routing a request
   * whose body is missing.
   */
  get bodyDecodingError(): BunHttpClientError | undefined {
    return this.#bodyDecodingError;
  }

  /**
   * Builds the canonical **413 Payload Too Large** `Response` for a request
   * whose body exceeded its cap. Shared by the HTTP adapters so an oversized
   * body is rejected uniformly, before routing.
   */
  static payloadTooLargeResponse(req: BunRequest): Response {
    const limit = req.payloadTooLarge?.limit;
    return new Response(
      JSON.stringify({
        statusCode: 413,
        error: "Payload Too Large",
        message:
          limit !== undefined
            ? `Request body exceeds the maximum allowed size of ${limit} bytes`
            : "Request body is too large",
      }),
      {
        status: 413,
        statusText: "Payload Too Large",
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  /**
   * Splits the absolute request URL into `{ host, path, search, hash }` by a
   * single string scan, avoiding a `new URL()` for the hot routing reads
   * (`host`, `path`, `originalUrl`). `path` is the pathname only (Express-style
   * `req.path` — not normalized); `search` and `hash` keep their leading
   * `?`/`#` (or are `""` when absent), matching WHATWG `URL.search`/`URL.hash`.
   */
  private splitRequestUrl(): {
    host: string;
    path: string;
    search: string;
    hash: string;
  } {
    if (this.#urlSplit) {
      return this.#urlSplit;
    }

    const url = this.request.url;
    const schemeEnd = url.indexOf("://");
    const hostStart = schemeEnd === -1 ? 0 : schemeEnd + 3;

    let authorityEnd = url.length;
    for (let i = hostStart; i < url.length; i++) {
      const code = url.charCodeAt(i);
      // First of '/' (47), '?' (63), '#' (35) ends the authority.
      if (code === 47 || code === 63 || code === 35) {
        authorityEnd = i;
        break;
      }
    }

    let host = url.slice(hostStart, authorityEnd);
    const at = host.lastIndexOf("@");
    if (at !== -1) {
      host = host.slice(at + 1); // drop any userinfo
    }

    // Locate the query ('?') and fragment ('#') boundaries. `indexOf` scans in
    // native code, so this is markedly cheaper than a per-character JS loop
    // over what may be a long path. '#' always ends the query, so a '?' at or
    // beyond the fragment start belongs to the fragment, not the query.
    const hashStart = url.indexOf("#", authorityEnd);
    const searchEnd = hashStart === -1 ? url.length : hashStart;

    let queryStart = url.indexOf("?", authorityEnd);
    if (queryStart === -1 || queryStart >= searchEnd) {
      queryStart = -1;
    }

    const pathEnd = queryStart === -1 ? searchEnd : queryStart;

    let path = url.slice(authorityEnd, pathEnd);
    if (path.charCodeAt(0) !== 47) {
      path = `/${path}`; // a bare `?query`/`#hash` implies pathname "/"
    }

    const search = queryStart === -1 ? "" : url.slice(queryStart, searchEnd);
    const hash = hashStart === -1 ? "" : url.slice(hashStart);

    this.#urlSplit = { host, path, search, hash };
    return this.#urlSplit;
  }

  get path() {
    return this.splitRequestUrl().path;
  }

  /** Query string including the leading `?` (or `""` when absent). */
  get search() {
    return this.splitRequestUrl().search;
  }

  /** Query string without the leading `?` (Express `req.querystring`-style). */
  get querystring() {
    return stripQueryPrefix(this.splitRequestUrl().search);
  }

  /** URL fragment including the leading `#` (or `""` when absent). */
  get hash() {
    return this.splitRequestUrl().hash;
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
        // `Set-Cookie` is always an array, as Node's `req.headers`.
        const value: string | string[] | null =
          val === "set-cookie"
            ? this.headersObj.getSetCookie()
            : this.headersObj.get(val);
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

    // Invalidate the cached view, as `removeHeader` does.
    this.#headers = undefined;
  }

  get ip() {
    return this.socketAddress?.address || "";
  }

  /**
   * The addresses in `X-Forwarded-For`, client first (Express's `req.ips` with
   * proxy trust enabled). `[]` when the header is absent or empty. Unlike
   * Express there is no `trust proxy` setting: the header is always read, so
   * only rely on it behind a proxy that sets it.
   */
  get ips(): string[] {
    const header = this.headersObj.get("X-Forwarded-For");
    if (!header) {
      return [];
    }
    return header
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean);
  }

  get originalUrl() {
    const { path, search, hash } = this.splitRequestUrl();
    return `${path}${search}${hash}`;
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
      const modifiedSince = this.headersObj.get("if-modified-since");
      const noneMatch = this.headersObj.get("if-none-match");

      // Without a validator there is nothing to revalidate against, so the
      // response can never be fresh — `fresh()` itself returns false on this
      // exact condition. Short-circuiting here keeps the overwhelmingly common
      // unconditional request from reading a third header, allocating two
      // object literals and calling into `fresh()`.
      if (modifiedSince === null && noneMatch === null) {
        return false;
      }

      return fresh(
        {
          "if-modified-since": modifiedSince ?? undefined,
          "if-none-match": noneMatch ?? undefined,
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

  /**
   * Content negotiation on `Accept`, as Express's `req.accepts`. With no
   * types, every acceptable type in preference order (`string[]`); with types
   * (a list or spread), the best match or `false`.
   */
  public accepts(): string[];
  public accepts(types: string[]): string | false;
  public accepts(...types: string[]): string | false;
  public accepts(...args: string[] | [string[]]): string[] | string | false {
    const accept = accepts(this as unknown as IncomingMessage);
    // eslint-disable-next-line prefer-spread
    return accept.types.apply(accept, flattenDeep(args));
  }

  /** Alias of {@link accepts}. */
  public acceptsTypes(): string[];
  public acceptsTypes(types: string[]): string | false;
  public acceptsTypes(...types: string[]): string | false;
  public acceptsTypes(
    ...args: string[] | [string[]]
  ): string[] | string | false {
    const accept = accepts(this as unknown as IncomingMessage);
    // eslint-disable-next-line prefer-spread
    return accept.types.apply(accept, flattenDeep(args));
  }

  /** Alias of {@link accepts}. */
  public acceptsType(): string[];
  public acceptsType(types: string[]): string | false;
  public acceptsType(...types: string[]): string | false;
  public acceptsType(
    ...args: string[] | [string[]]
  ): string[] | string | false {
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

  /** Alias of {@link acceptsEncodings}. */
  public acceptsEncoding(): string[];
  public acceptsEncoding(encodings: string[]): string | false;
  public acceptsEncoding(...encodings: string[]): string | false;
  public acceptsEncoding(
    ...args: string[] | [string[]]
  ): string[] | string | false {
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

  /** Alias of {@link acceptsCharsets}. */
  public acceptsCharset(): string[];
  public acceptsCharset(charsets: string[]): string | false;
  public acceptsCharset(...charsets: string[]): string | false;
  public acceptsCharset(
    ...args: string[] | [string[]]
  ): string[] | string | false {
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

  /** Alias of {@link acceptsLanguages}. */
  public acceptsLanguage(): string[];
  public acceptsLanguage(languages: string[]): string | false;
  public acceptsLanguage(...languages: string[]): string | false;
  public acceptsLanguage(
    ...args: string[] | [string[]]
  ): string[] | string | false {
    const accept = accepts(this as unknown as IncomingMessage);
    // eslint-disable-next-line prefer-spread
    return accept.languages.apply(accept, flattenDeep(args));
  }

  /**
   * Parses the `Range` header against a resource of `size` bytes, as
   * Express's `req.range`: the ranges (with their `type`), `-1` when
   * unsatisfiable, `-2` when malformed, `undefined` with no `Range` header.
   * `combine` merges overlapping and adjacent ranges.
   */
  public range(
    size: number,
    opts?: Parameters<typeof rangeParser>[2],
  ): RangeParserResult | undefined {
    const rangeHeader = this.getHeader("Range");
    if (!rangeHeader) return;
    return rangeParser(size, rangeHeader, opts);
  }

  /**
   * A request header, case-insensitively. Absent, it is `null` — or
   * `defaultVal` when one is given. Like `Headers.get`, a repeated header
   * comes back as one comma-joined string — except `Set-Cookie`, which, as
   * Node's `req.headers["set-cookie"]` (and so Express's `req.get`), is an
   * array of its lines (`Headers.getSetCookie()`): a cookie's `Expires` date
   * holds a comma, so joined lines could not be split back apart. The array
   * type follows a literal name in any letter case; a name typed only as
   * `string` is typed `string | null` even when it is `set-cookie`.
   */
  get<N extends string>(name: N & SetCookieHeaderName<N>): string[] | null;
  get<N extends string>(
    name: N & SetCookieHeaderName<N>,
    defaultVal: string[],
  ): string[];
  get<N extends string>(
    name: N & SetCookieHeaderName<N>,
    defaultVal: string,
  ): string[] | string;
  get(name: string): string | null;
  get(name: string, defaultVal: string): string;
  get(name: string, defaultVal: string[]): string | string[];
  get(
    name: string,
    defaultVal: string | string[] | undefined,
  ): string | string[] | null;
  get(
    name: string,
    defaultVal: string | string[] | undefined = undefined,
  ): string | string[] | null {
    if (!this.hasHeader(name)) {
      return isUndefined(defaultVal) ? null : defaultVal;
    }

    if (name.toLowerCase() === "set-cookie") {
      return this.headersObj.getSetCookie();
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
