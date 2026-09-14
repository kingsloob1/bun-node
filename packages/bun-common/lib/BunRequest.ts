import type { SocketAddress } from "bun";
import type { FileTypeResult } from "file-type";
import type { IncomingMessage } from "node:http";
import type { BunResponse } from "./BunResponse";
import type { TypedEmitter } from "./BunWebSocket";
import type { StorageFile } from "./multipart";
import type {
  BodyParserOptions,
  BunRequestInterface,
  BunServer,
  MultiPartFileRecord,
  MultiPartOptions,
} from "./types/general";
import type { CookieParseOptions, ParseXmlOptions } from "./utils/native";
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
  parseByteSize,
  parseCookie,
  parseXmlToObject,
  rangeParser,
  set,
  ucwords,
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
 */
export interface ParseBodyConfig {
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
  public readonly statusCode = 413 as const;
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
  /** An error occurred while receiving/parsing the request body. */
  error: (error: unknown) => void;
  /** A streaming response bound to this request was cancelled. */
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

export class BunRequest
  implements BunRequestInterface, TypedEmitter<BunRequestEvents>
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
  #perTypeConfig:
    | Map<ContentParserType, { opts?: unknown; maxContentLength?: number }>
    | undefined = undefined;

  /**
   * Set when {@link parseBody} aborts because the body exceeded its cap. The
   * adapter reads {@link isPayloadTooLarge} after `init` to short-circuit with
   * an HTTP 413 before routing.
   */
  #payloadTooLarge: { limit: number; length?: number } | undefined = undefined;

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
  /** The error captured when {@link #bodyState} is `"errored"`. */
  #bodyError: unknown = undefined;
  /** True once the `data`/`end`/`error` body events have been emitted. */
  #bodyEventsEmitted = false;

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
    /** The native Bun/Web `Request` this instance wraps. */
    public request: Request,
    /**
     * The owning `Bun.serve` server — used for connection info (`requestIP`,
     * local address/port) and to upgrade the request to a WebSocket.
     */
    private server: BunServer,
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
       * Options for the query-string parser (`picoquery`). Defaults to
       * {@link DEFAULT_PARSE_QUERY_OPTS} (`nestingSyntax: "js"`,
       * `arrayRepeat: true`).
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
    this.headersObj = request.headers as Headers;
    this.url = this.request.url;

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

    if (!this.options.parseQueryOpts) {
      this.options.parseQueryOpts = { ...DEFAULT_PARSE_QUERY_OPTS };
    }

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
          (error: unknown) => {
            this.#bodyState = "errored";
            this.#bodyError = error;
            this.#flushBodyEvents();
          },
        ),
      );
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

  async ready() {
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
    this.#emitter?.removeAllListeners(event);
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
      const parsedData = parseSearchString(
        data,
        this.getParserOpts("urlencoded") ?? DEFAULT_PARSE_QUERY_OPTS,
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
      this._body = JSON.parse(data, this.getParserOpts("json")?.reviver);
      this._contentType = "json";
      this.setHeader("Content-Type", "application/json");
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
      this.setHeader("Content-Type", "application/xml");
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
    const perType = new Map<
      ContentParserType,
      { opts?: unknown; maxContentLength?: number }
    >();

    for (const key of keys(contentTypes) as ContentParserType[]) {
      // Ignore unrecognized keys entirely.
      if (!VALID_PARSER_KINDS.has(key)) {
        continue;
      }

      const value = (contentTypes as Record<string, unknown>)[key];
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
   * Leaves the body untouched as a raw `Buffer`. When `rewriteContentType` is
   * `true` the header is normalized to `application/octet-stream`; otherwise
   * the original `Content-Type` is preserved (used when a recognized media
   * type was deliberately excluded via `allowedContentTypes`).
   */
  private leaveBodyAsRaw(buffer: Buffer, rewriteContentType: boolean) {
    this._body = buffer;
    this._buffer = buffer;
    this._contentType = "buffer";
    if (rewriteContentType) {
      this.setHeader("Content-Type", "application/octet-stream");
    }
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

  public setQueryParserOptions(opts: QueryParserOpts) {
    set(this.options, "parseQueryOpts", opts);
    return this;
  }

  public parseQuery(opts?: QueryParserOpts) {
    const options: QueryParserOpts = opts ||
      this.options?.parseQueryOpts || { ...DEFAULT_PARSE_QUERY_OPTS };

    this.query = parseSearchString(this.splitRequestUrl().search, options);
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

    const contentTypeHeader = this.getHeader("Content-Type");

    let buffer = this._buffer;
    if (!buffer && !this.request.bodyUsed) {
      // Resolve the size cap from the declared content type up front, then read
      // the body under that cap — rejecting an oversized payload before (or
      // while) it is buffered. See {@link readBodyWithLimit}.
      const declaredKind = contentTypeHeader
        ? this.detectParserKind(contentTypeHeader)
        : undefined;
      const limit = this.resolveContentLimit(declaredKind);
      try {
        buffer = await this.readBodyWithLimit(limit);
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
        this.leaveBodyAsRaw(buffer, true);
      }
    } else {
      const kind = this.detectParserKind(contentTypeHeader);

      // A recognized media type whose parser was excluded via
      // `allowedContentTypes`/`parseBody.contentTypes` is left as a raw buffer,
      // preserving its header.
      if (kind && !this.isParserAllowed(kind)) {
        this.leaveBodyAsRaw(buffer, false);
      } else {
        switch (kind) {
          case "text": {
            const encoding = this.getParserOpts("text")?.encoding;
            this._body = encoding ? buffer.toString(encoding) : bufferText;
            this._contentType = "text";
            break;
          }

          case "raw": {
            this.leaveBodyAsRaw(buffer, false);
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
            this.leaveBodyAsRaw(buffer, true);
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
