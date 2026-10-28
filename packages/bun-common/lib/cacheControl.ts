/**
 * `Cache-Control` from a typed object: {@link formatCacheControl} builds the
 * header value, {@link cacheControl} is a middleware that sets it.
 *
 * The directives are the response directives of RFC 9111 §5.2.2, with
 * `stale-while-revalidate` and `stale-if-error` from RFC 5861 and `immutable`
 * from RFC 8246. Every lifetime is in **seconds**, as the header is
 * (`delta-seconds`, RFC 9111 §1.2.2), not milliseconds.
 *
 * Two contradictions are compile errors, and throw at run time for a value
 * the types did not see: `public` with `private`, and `noStore` with any
 * lifetime (`maxAge`, `sMaxAge`, `staleWhileRevalidate`, `staleIfError`,
 * `immutable`) — a response no cache may store has no lifetime to give.
 * `noStore` with `mustUnderstand` is allowed, and is what RFC 9111 §5.2.2.3
 * recommends.
 */
import type { BunRequest } from "./BunRequest";
import type { BunResponse } from "./BunResponse";
import type { NextFunction, RouterMiddlewareHandler } from "./types/general";

/** Every directive {@link formatCacheControl} knows, unconstrained. */
interface CacheControlDirectiveFields {
  /**
   * `public` (RFC 9111 §5.2.2.9): any cache may store the response, even one
   * that would otherwise not be (a request with `Authorization`). Not with
   * `private`.
   */
  public?: boolean;
  /**
   * `private` (§5.2.2.7): a shared cache must not store the response; a
   * private (browser) cache may. A list of field names is the qualified
   * form, `private="Set-Cookie"`: only those header fields are private.
   * Not with `public`.
   */
  private?: boolean | readonly string[];
  /**
   * `no-cache` (§5.2.2.4): a cache may store the response but must
   * revalidate it before every reuse. A list of field names is the
   * qualified form, `no-cache="Set-Cookie"`: the response may be reused
   * without those fields.
   */
  noCache?: boolean | readonly string[];
  /**
   * `no-store` (§5.2.2.5): no cache may store any part of the response. Not
   * with a lifetime (`maxAge`, `sMaxAge`, `staleWhileRevalidate`,
   * `staleIfError`, `immutable`).
   */
  noStore?: boolean;
  /**
   * `max-age` (§5.2.2.1): how long the response stays fresh, in **seconds**
   * (not milliseconds). A whole number, `0` or more.
   */
  maxAge?: number;
  /**
   * `s-maxage` (§5.2.2.10): `maxAge` for shared caches (CDNs, proxies),
   * overriding it there, in **seconds**. A whole number, `0` or more.
   */
  sMaxAge?: number;
  /**
   * `stale-while-revalidate` (RFC 5861 §3): how long, in **seconds**, after
   * the response goes stale a cache may still serve it while it revalidates
   * in the background. A whole number, `0` or more.
   */
  staleWhileRevalidate?: number;
  /**
   * `stale-if-error` (RFC 5861 §4): how long, in **seconds**, after the
   * response goes stale a cache may still serve it when revalidating fails
   * (a 5xx or no answer). A whole number, `0` or more.
   */
  staleIfError?: number;
  /**
   * `must-revalidate` (§5.2.2.2): once stale, the response must not be used
   * without revalidating — no stale serving, whatever `staleWhileRevalidate`
   * or `staleIfError` say.
   */
  mustRevalidate?: boolean;
  /**
   * `proxy-revalidate` (§5.2.2.8): `mustRevalidate` for shared caches only.
   */
  proxyRevalidate?: boolean;
  /**
   * `must-understand` (§5.2.2.3): only a cache that understands the
   * status code's caching rules may store the response. RFC 9111 recommends
   * pairing it with `noStore`, which caches that do not know the directive
   * then obey.
   */
  mustUnderstand?: boolean;
  /**
   * `no-transform` (§5.2.2.6): intermediaries must not transform the
   * content. `compression()` honours it too, and leaves the body as it is.
   */
  noTransform?: boolean;
  /**
   * `immutable` (RFC 8246): the body will not change while the response is
   * fresh, so a client need not revalidate it on a reload. Meant for
   * versioned (fingerprinted) assets with a long `maxAge`.
   */
  immutable?: boolean;
}

/** The directives that `public` excludes; see {@link CacheControlDirectives}. */
interface PublicOnly {
  /** Excluded by `public: true`. */
  private?: false;
}

/** The directives that `private` excludes; see {@link CacheControlDirectives}. */
interface PrivateOnly {
  /** Excluded by `private`. */
  public?: false;
}

/** A storable response: no `noStore`; see {@link CacheControlDirectives}. */
interface Storable {
  /** Excluded by any lifetime. */
  noStore?: false;
}

/** An unstorable response: no lifetimes; see {@link CacheControlDirectives}. */
interface NotStored {
  /** Excluded by `noStore: true`. */
  maxAge?: undefined;
  /** Excluded by `noStore: true`. */
  sMaxAge?: undefined;
  /** Excluded by `noStore: true`. */
  staleWhileRevalidate?: undefined;
  /** Excluded by `noStore: true`. */
  staleIfError?: undefined;
  /** Excluded by `noStore: true`. */
  immutable?: false;
}

/**
 * The response directives of a `Cache-Control` header, for
 * {@link formatCacheControl} and {@link cacheControl}. Lifetimes are in
 * **seconds**. A `false` or `undefined` directive is left out.
 *
 * Contradictions do not compile: `public` with `private`, and `noStore` with
 * a lifetime. A flag held in a `boolean` variable counts as possibly set, so
 * `{ public: isPublic, private: isPrivate }` is an error too; spread the one
 * that applies (`...(isPublic ? { public: true } : { private: true })`).
 */
export type CacheControlDirectives = CacheControlDirectiveFields &
  (PublicOnly | PrivateOnly) &
  (Storable | NotStored);

/** How one directive is written. */
type DirectiveKind = "flag" | "seconds" | "fields";

/**
 * Every directive in the order it is written: who may store (`public`,
 * `private`, `no-cache`, `no-store`), for how long, then what a cache must
 * do with it.
 */
const DIRECTIVES: readonly (readonly [
  key: keyof CacheControlDirectiveFields,
  name: string,
  kind: DirectiveKind,
])[] = [
  ["public", "public", "flag"],
  ["private", "private", "fields"],
  ["noCache", "no-cache", "fields"],
  ["noStore", "no-store", "flag"],
  ["maxAge", "max-age", "seconds"],
  ["sMaxAge", "s-maxage", "seconds"],
  ["staleWhileRevalidate", "stale-while-revalidate", "seconds"],
  ["staleIfError", "stale-if-error", "seconds"],
  ["mustRevalidate", "must-revalidate", "flag"],
  ["proxyRevalidate", "proxy-revalidate", "flag"],
  ["mustUnderstand", "must-understand", "flag"],
  ["noTransform", "no-transform", "flag"],
  ["immutable", "immutable", "flag"],
];

/** The directive keys, for refusing an unknown one. */
const KNOWN_KEYS: ReadonlySet<string> = new Set(DIRECTIVES.map(([key]) => key));

/** The lifetimes `noStore` excludes. */
const LIFETIME_KEYS = [
  "maxAge",
  "sMaxAge",
  "staleWhileRevalidate",
  "staleIfError",
  "immutable",
] as const;

/** A field name: an RFC 9110 §5.6.2 `token`. */
const TOKEN_REGEXP = /^[!#$%&'*+\-.^`|~\w]+$/;

/** Whether `value` sets its directive: anything but `undefined` and `false`. */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== false;
}

/** Writes one directive's text, or throws for a value of the wrong kind. */
function formatDirective(
  key: string,
  name: string,
  kind: DirectiveKind,
  value: unknown,
): string {
  if (kind === "seconds") {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new RangeError(
        `Cache-Control ${key} must be a whole number of seconds, 0 or more; got ${String(value)}`,
      );
    }
    // The token form: RFC 9111 §5.2.2.1 forbids max-age="5".
    return `${name}=${value}`;
  }
  if (value === true) {
    return name;
  }
  if (kind === "fields" && Array.isArray(value)) {
    const fields = value as readonly unknown[];
    if (fields.length === 0) {
      throw new TypeError(
        `Cache-Control ${key} needs at least one field name; use true for the unqualified form`,
      );
    }
    for (const field of fields) {
      if (typeof field !== "string" || !TOKEN_REGEXP.test(field)) {
        throw new TypeError(
          `Cache-Control ${key}: ${JSON.stringify(field)} is not a header field name`,
        );
      }
    }
    // The quoted-string form, even for one name: RFC 9111 §5.2.2.4 and
    // §5.2.2.7 say a sender SHOULD NOT generate the token form.
    return `${name}="${fields.join(", ")}"`;
  }
  throw new TypeError(
    `Cache-Control ${key} must be ${kind === "fields" ? "a boolean or a list of field names" : "a boolean"}; got ${String(value)}`,
  );
}

/**
 * Formats `directives` as a `Cache-Control` header value, directives
 * comma-separated in a fixed order:
 *
 * ```ts
 * formatCacheControl({ public: true, maxAge: 31_536_000, immutable: true });
 * // "public, max-age=31536000, immutable"
 * formatCacheControl({ private: ["Set-Cookie"], noCache: true });
 * // 'private="Set-Cookie", no-cache'
 * ```
 *
 * Lifetimes are whole **seconds**. Returns `""` when no directive is set.
 *
 * Throws a `RangeError` for a lifetime that is negative, fractional or not a
 * number, and a `TypeError` for `public` with `private`, `noStore` with a
 * lifetime, an empty or malformed field-name list, a flag that is not a
 * boolean, or an unknown key (`max_age`).
 */
export function formatCacheControl(directives: CacheControlDirectives): string {
  const values = directives as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(values)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new TypeError(`Unknown Cache-Control directive key: ${key}`);
    }
  }
  if (isSet(values.public) && isSet(values.private)) {
    throw new TypeError("Cache-Control cannot be both public and private");
  }
  if (isSet(values.noStore)) {
    const lifetime = LIFETIME_KEYS.find((key) => isSet(values[key]));
    if (lifetime !== undefined) {
      throw new TypeError(
        `Cache-Control noStore leaves nothing stored for ${lifetime} to apply to`,
      );
    }
  }

  let header = "";
  for (const [key, name, kind] of DIRECTIVES) {
    const value = values[key];
    if (!isSet(value)) {
      continue;
    }
    const text = formatDirective(key, name, kind, value);
    header = header === "" ? text : `${header}, ${text}`;
  }
  return header;
}

/** Options for {@link cacheControl}. */
export interface CacheControlOptions {
  /**
   * Also sets `Surrogate-Control` (the Edge Architecture header CDNs such
   * as Fastly and Akamai read, and strip before the client sees it) from
   * these directives, written as `Cache-Control`'s are. CDNs read
   * `maxAge`, `noStore`, and (Fastly) `staleWhileRevalidate` and
   * `staleIfError`; the rest mean nothing there. Default: not set.
   */
  surrogateControl?: CacheControlDirectives;
}

/**
 * A middleware setting `Cache-Control` from typed directives (see
 * {@link CacheControlDirectives}; lifetimes in **seconds**):
 *
 * ```ts
 * router.get("/assets/*file", cacheControl({ public: true, maxAge: 31_536_000, immutable: true }), h);
 * router.get("/feed", cacheControl({ sMaxAge: 60, staleWhileRevalidate: 30, staleIfError: 600 }), h);
 * router.get("/me", cacheControl({ private: true, noStore: true }), h);
 * ```
 *
 * The value is formatted once, here, so a bad directive throws (as
 * {@link formatCacheControl} does) when the route is built, not per
 * request; so do no directives at all. Each request then gets the header
 * set — replacing one an earlier layer set — and goes on with `next()`; a
 * handler can still change it. A response already sent is left alone.
 */
export function cacheControl(
  directives: CacheControlDirectives,
  options: CacheControlOptions = {},
): RouterMiddlewareHandler {
  const value = formatCacheControl(directives);
  if (value === "") {
    throw new TypeError("cacheControl() needs at least one directive");
  }
  let surrogate: string | undefined;
  if (options.surrogateControl !== undefined) {
    surrogate = formatCacheControl(options.surrogateControl);
    if (surrogate === "") {
      throw new TypeError(
        "cacheControl()'s surrogateControl needs at least one directive",
      );
    }
  }

  return function cacheControlMiddleware(
    _req: BunRequest,
    res: BunResponse,
    next: NextFunction,
  ) {
    if (!res.headersSent) {
      res.setHeader("Cache-Control", value);
      if (surrogate !== undefined) {
        res.setHeader("Surrogate-Control", surrogate);
      }
    }
    return next();
  };
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/**
 * A `Cache-Control` header as {@link parseCacheControl} read it: request and
 * response directives alike (the parser does not know which side the header
 * came from), under {@link CacheControlDirectives}' keys where they overlap.
 * A directive that is absent is left out; a flag that is present is `true`.
 * Lifetimes are in **seconds**.
 *
 * Contradictions are kept as they arrived (`public` beside `private`,
 * `noStore` beside `maxAge`): RFC 9111 §4.2.1 has the reader honour the most
 * restrictive, and that is the reader's decision, not the parser's.
 */
export interface ParsedCacheControl {
  /** `public` (RFC 9111 §5.2.2.9). */
  public?: true;
  /**
   * `private` (§5.2.2.7): `true`, or the field names of the qualified form
   * (`private="Set-Cookie"`), as written — compare them case-insensitively.
   */
  private?: true | string[];
  /**
   * `no-cache` (§5.2.1.4 in a request, §5.2.2.4 in a response): `true`, or
   * the field names of the response's qualified form, as written.
   */
  noCache?: true | string[];
  /** `no-store` (§5.2.1.5, §5.2.2.5). */
  noStore?: true;
  /**
   * `max-age` (§5.2.1.1, §5.2.2.1), in seconds. In a response, how long it
   * stays fresh; in a request, the oldest response the client accepts.
   */
  maxAge?: number;
  /** `s-maxage` (§5.2.2.10), in seconds: `maxAge` for shared caches. */
  sMaxAge?: number;
  /** `stale-while-revalidate` (RFC 5861 §3), in seconds. */
  staleWhileRevalidate?: number;
  /**
   * `stale-if-error` (RFC 5861 §4), in seconds — a response directive, and
   * a request one (the staleness the client accepts on an error).
   */
  staleIfError?: number;
  /** `must-revalidate` (§5.2.2.2). */
  mustRevalidate?: true;
  /** `proxy-revalidate` (§5.2.2.8). */
  proxyRevalidate?: true;
  /** `must-understand` (§5.2.2.3). */
  mustUnderstand?: true;
  /** `no-transform` (§5.2.1.6, §5.2.2.6). */
  noTransform?: true;
  /** `immutable` (RFC 8246). */
  immutable?: true;
  /**
   * `max-stale` (§5.2.1.2, a request directive): the seconds past its
   * freshness lifetime the client accepts a response, or `true` when it
   * gave no value — a stale response of any age.
   */
  maxStale?: number | true;
  /**
   * `min-fresh` (§5.2.1.3, a request directive): the seconds a response
   * must still stay fresh for the client to accept it.
   */
  minFresh?: number;
  /** `only-if-cached` (§5.2.1.7, a request directive). */
  onlyIfCached?: true;
  /**
   * Directives this parser does not know, by lower-cased name: their
   * argument (unquoted), or `true` without one. RFC 9111 §5.2.3 has a cache
   * ignore them; they are kept so a reader that knows one can act on it.
   * A null-prototype object, so a name such as `__proto__` is only a key.
   * Absent when there are none.
   */
  extensions?: Record<string, string | true>;
  /**
   * Known directives whose argument was malformed, by header name
   * (`max-age` for `max-age=soon`), each once. Each is still set, to its
   * most restrictive reading (RFC 9111 §4.2.1 has a cache treat invalid
   * freshness information as stale): a lifetime reads `0`, a malformed
   * field list the unqualified form (`true`), a flag given an argument
   * `true`. Absent when there are none.
   */
  invalid?: string[];
  /**
   * Known directives that appeared more than once, by header name, each
   * once. The first occurrence is the one kept, as RFC 9111 §4.2.1 allows.
   * Absent when there are none.
   */
  duplicates?: string[];
}

/** How a directive's argument is read. */
type ParseKind = "flag" | "seconds" | "optional-seconds" | "fields";

/** The keys of {@link ParsedCacheControl} a directive can set. */
type ParsedKey = Exclude<
  keyof ParsedCacheControl,
  "extensions" | "invalid" | "duplicates"
>;

/** Every directive the parser knows, by lower-cased header name. */
const PARSED_DIRECTIVES: ReadonlyMap<string, readonly [ParsedKey, ParseKind]> =
  new Map<string, readonly [ParsedKey, ParseKind]>([
    ...DIRECTIVES.map(([key, name, kind]) => [name, [key, kind]] as const),
    ["max-stale", ["maxStale", "optional-seconds"]],
    ["min-fresh", ["minFresh", "seconds"]],
    ["only-if-cached", ["onlyIfCached", "flag"]],
  ]);

/** RFC 9111 §1.2.2: the value an overflowing `delta-seconds` is taken as. */
const DELTA_SECONDS_CAP = 2_147_483_648;

/** A `tchar` (RFC 9110 §5.6.2). */
const TCHAR_REGEXP = /[!#$%&'*+\-.^`|~\w]/;

/** `delta-seconds` (`1*DIGIT`). */
const DIGITS_REGEXP = /^\d+$/;

/** Optional whitespace: a space or a horizontal tab (RFC 9110 §5.6.3). */
function isOws(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

/** One element of the header, as the scanner found it. */
interface ScannedDirective {
  /** The directive's name, lower-cased. */
  name: string;
  /** Its argument, unquoted; `undefined` without one. */
  value: string | undefined;
  /** Whether the argument was malformed (an unterminated quote, trailing text, `=` with nothing). */
  malformed: boolean;
}

/**
 * Splits a `Cache-Control` value into its directives (`#cache-directive`,
 * RFC 9111 §5.2): empty elements skipped, commas inside a quoted-string
 * kept, an element with no valid name dropped.
 */
function scanDirectives(header: string): ScannedDirective[] {
  const found: ScannedDirective[] = [];
  const length = header.length;
  let i = 0;

  /** Moves `i` past the rest of the element, a quoted-string included. */
  const skipElement = (): void => {
    let quoted = false;
    for (; i < length; i += 1) {
      const char = header[i];
      if (quoted) {
        if (char === "\\") {
          i += 1;
        } else if (char === '"') {
          quoted = false;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ",") {
        return;
      }
    }
  };

  while (i < length) {
    while (i < length && (isOws(header[i]) || header[i] === ",")) {
      i += 1;
    }
    if (i >= length) {
      break;
    }
    const nameStart = i;
    while (i < length && TCHAR_REGEXP.test(header[i] ?? "")) {
      i += 1;
    }
    const name = header.slice(nameStart, i).toLowerCase();
    if (name === "") {
      // Not a token: ignored, as an unrecognised directive is.
      skipElement();
      continue;
    }
    while (isOws(header[i])) {
      i += 1;
    }

    let value: string | undefined;
    let malformed = false;
    if (header[i] === "=") {
      i += 1;
      while (isOws(header[i])) {
        i += 1;
      }
      if (header[i] === '"') {
        i += 1;
        let text = "";
        let closed = false;
        while (i < length) {
          const char = header[i] ?? "";
          if (char === "\\" && i + 1 < length) {
            text += header[i + 1];
            i += 2;
          } else if (char === '"') {
            closed = true;
            i += 1;
            break;
          } else {
            text += char;
            i += 1;
          }
        }
        value = text;
        malformed = !closed;
      } else {
        const valueStart = i;
        while (i < length && TCHAR_REGEXP.test(header[i] ?? "")) {
          i += 1;
        }
        value = header.slice(valueStart, i);
        malformed = value === "";
      }
      while (isOws(header[i])) {
        i += 1;
      }
    }
    if (i < length && header[i] !== ",") {
      malformed = true;
      skipElement();
    }
    found.push({ name, value, malformed });
  }
  return found;
}

/** `delta-seconds`, capped at 2^31 (RFC 9111 §1.2.2); `undefined` when malformed. */
function parseDeltaSeconds(value: string | undefined): number | undefined {
  if (value === undefined || !DIGITS_REGEXP.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  return seconds > DELTA_SECONDS_CAP ? DELTA_SECONDS_CAP : seconds;
}

/** A qualified form's field names; `undefined` when the list is malformed or empty. */
function parseFieldNames(value: string): string[] | undefined {
  const fields: string[] = [];
  for (const part of value.split(",")) {
    const field = part.trim();
    if (field === "") {
      continue;
    }
    if (!TOKEN_REGEXP.test(field)) {
      return undefined;
    }
    fields.push(field);
  }
  return fields.length === 0 ? undefined : fields;
}

/**
 * Reads one known directive's argument: the value to store, and whether it
 * was malformed (then the most restrictive reading is stored).
 */
function readDirective(
  kind: ParseKind,
  directive: ScannedDirective,
): { value: number | true | string[]; invalid: boolean } {
  const { value, malformed } = directive;
  switch (kind) {
    case "flag":
      // A flag takes no argument; one given is ignored, and reported.
      return { value: true, invalid: malformed || value !== undefined };
    case "fields": {
      if (value === undefined && !malformed) {
        return { value: true, invalid: false };
      }
      const fields =
        malformed || value === undefined ? undefined : parseFieldNames(value);
      return fields === undefined
        ? { value: true, invalid: true }
        : { value: fields, invalid: false };
    }
    case "optional-seconds":
    case "seconds": {
      if (kind === "optional-seconds" && value === undefined && !malformed) {
        // `max-stale` with no value: a stale response of any age.
        return { value: true, invalid: false };
      }
      const seconds = malformed ? undefined : parseDeltaSeconds(value);
      return seconds === undefined
        ? { value: 0, invalid: true }
        : { value: seconds, invalid: false };
    }
  }
}

/**
 * Parses a `Cache-Control` header value — a request's or a response's —
 * by RFC 9111 §5.2 (with RFC 5861's stale windows and RFC 8246's
 * `immutable`). Never throws: `null`, `undefined` and `""` give `{}`.
 *
 * ```ts
 * parseCacheControl('public, max-age=60, stale-while-revalidate=30');
 * // { public: true, maxAge: 60, staleWhileRevalidate: 30 }
 * parseCacheControl(req.get("cache-control"));
 * // e.g. { maxStale: true, onlyIfCached: true }
 * ```
 *
 * - Names are matched case-insensitively; an argument may be a token or a
 *   quoted-string (`max-age="60"` reads as `60`), whatever form the
 *   directive asks senders to use.
 * - `delta-seconds` past 2147483648 reads as 2147483648 (§1.2.2).
 * - A directive written twice keeps its first occurrence, and is listed in
 *   `duplicates` (§4.2.1).
 * - A malformed argument (`max-age=soon`, `max-age=-1`, `no-cache=""`) is
 *   read the most restrictive way (`0`, the unqualified form) and listed in
 *   `invalid` (§4.2.1).
 * - An unknown directive goes to `extensions`, by lower-cased name, rather
 *   than being dropped (§5.2.3 has a cache ignore it); an element that is
 *   not a directive at all is ignored.
 * - Contradictions are kept as they arrived: see {@link ParsedCacheControl}.
 */
export function parseCacheControl(
  value: string | null | undefined,
): ParsedCacheControl {
  const parsed: ParsedCacheControl = {};
  if (typeof value !== "string" || value === "") {
    return parsed;
  }
  const set = parsed as Record<ParsedKey, number | true | string[] | undefined>;
  let extensions: Record<string, string | true> | undefined;
  let invalid: string[] | undefined;
  let duplicates: string[] | undefined;

  for (const directive of scanDirectives(value)) {
    const known = PARSED_DIRECTIVES.get(directive.name);
    if (known === undefined) {
      if (directive.malformed) {
        continue;
      }
      extensions ??= Object.create(null) as Record<string, string | true>;
      if (!(directive.name in extensions)) {
        extensions[directive.name] = directive.value ?? true;
      }
      continue;
    }
    const [key, kind] = known;
    if (set[key] !== undefined) {
      duplicates ??= [];
      if (!duplicates.includes(directive.name)) {
        duplicates.push(directive.name);
      }
      continue;
    }
    const read = readDirective(kind, directive);
    set[key] = read.value;
    if (read.invalid) {
      invalid ??= [];
      if (!invalid.includes(directive.name)) {
        invalid.push(directive.name);
      }
    }
  }

  if (extensions !== undefined) {
    parsed.extensions = extensions;
  }
  if (invalid !== undefined) {
    parsed.invalid = invalid;
  }
  if (duplicates !== undefined) {
    parsed.duplicates = duplicates;
  }
  return parsed;
}
