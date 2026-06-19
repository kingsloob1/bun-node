/**
 * Native, dependency-free utilities.
 *
 * These replace a collection of small third-party packages (lodash-es,
 * fast-isnumeric, date-fns, locutus, encodeurl, vary, fresh, range-parser,
 * @tinyhttp/etag, cookie, cookie-parser, cookie-signature, get-port,
 * until-promise) with lean implementations backed by the standard library
 * and Bun primitives.
 */
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

/* ------------------------------------------------------------------ *
 * Type guards (lodash-es replacements)
 * ------------------------------------------------------------------ */

export const isArray = Array.isArray;

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isFunction(value: unknown): value is (...args: any[]) => any {
  return typeof value === "function";
}

export function isUndefined(value: unknown): value is undefined {
  return value === undefined;
}

export function isNull(value: unknown): value is null {
  return value === null;
}

/**
 * Mirrors lodash `isObject`: arrays and functions count as objects, `null`
 * does not.
 */
export function isObject(value: unknown): value is object {
  return (
    value !== null && (typeof value === "object" || typeof value === "function")
  );
}

export function isError(value: unknown): value is Error {
  return (
    value instanceof Error ||
    (isObject(value) &&
      Object.prototype.toString.call(value) === "[object Error]")
  );
}

export function isBuffer(value: unknown): value is Buffer {
  return Buffer.isBuffer(value);
}

export function isMap(value: unknown): value is Map<unknown, unknown> {
  return value instanceof Map;
}

/* ------------------------------------------------------------------ *
 * Numeric detection (fast-isnumeric replacement)
 * ------------------------------------------------------------------ */

/**
 * Returns true when `value` represents a finite number, accepting numeric
 * strings (but not whitespace-only or empty strings).
 */
export function isNumeric(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value === "string") {
    if (value.trim() === "") {
      return false;
    }
    return Number.isFinite(Number(value));
  }

  return false;
}

/**
 * Binary byte-size units accepted by {@link parseByteSize}. Mirrors the `bytes`
 * library's unit set (powers of 1024), so `"1kb" === 1024`.
 */
const BYTE_SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
  pb: 1024 ** 5,
};

/**
 * Parses a human byte-size into a number of bytes. Accepts a plain number
 * (returned as-is when finite and non-negative) or a string like `"100kb"`,
 * `"5mb"`, `"1.5gb"` (case-insensitive, optional unit defaults to bytes).
 * Returns `undefined` for anything unparseable or negative.
 */
export function parseByteSize(value: number | string): number | undefined {
  if (isNumber(value)) {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  if (!isString(value)) {
    return undefined;
  }

  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|pb)?$/i.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] || "b").toLowerCase();
  return Math.floor(amount * BYTE_SIZE_UNITS[unit]);
}

/* ------------------------------------------------------------------ *
 * Collection helpers (lodash-es replacements)
 * ------------------------------------------------------------------ */

export const keys = (value: unknown): string[] =>
  value == null ? [] : Object.keys(value as object);

export const values = <T = unknown>(value: unknown): T[] =>
  value == null ? [] : (Object.values(value as object) as T[]);

export const first = <T>(
  value: ArrayLike<T> | null | undefined,
): T | undefined => (value && value.length ? value[0] : undefined);

export function flattenDeep<T = any>(value: readonly unknown[]): T[] {
  return value.flat(Infinity as 1) as T[];
}

/** Iterate arrays or plain objects, calling `fn(value, key)`. */
export function each<T = any>(
  collection: T[] | Record<string, T> | object | null | undefined,
  fn: (value: T, key: any) => void,
): void {
  if (collection == null) {
    return;
  }

  if (Array.isArray(collection)) {
    for (let i = 0; i < collection.length; i++) {
      fn(collection[i], i);
    }
    return;
  }

  for (const key of Object.keys(collection)) {
    fn((collection as Record<string, T>)[key], key);
  }
}

export function omit<T extends object>(
  obj: T | null | undefined,
  paths: string[],
): Partial<T> {
  const result: Record<string, unknown> = {};
  if (obj == null) {
    return result as Partial<T>;
  }

  const exclude = new Set(paths);
  for (const key of Object.keys(obj)) {
    if (!exclude.has(key)) {
      result[key] = (obj as Record<string, unknown>)[key];
    }
  }

  return result as Partial<T>;
}

export function pick<T extends object>(
  obj: T | null | undefined,
  paths: string[],
): Partial<T> {
  const result: Record<string, unknown> = {};
  if (obj == null) {
    return result as Partial<T>;
  }

  for (const key of paths) {
    if (key in obj) {
      result[key] = (obj as Record<string, unknown>)[key];
    }
  }

  return result as Partial<T>;
}

export function unset(obj: unknown, key: string | number): boolean {
  if (obj != null && typeof obj === "object") {
    delete (obj as Record<string | number, unknown>)[key];
    return true;
  }
  return false;
}

/** Deep clone using the structured clone algorithm. */
export function cloneDeep<T>(value: T): T {
  return structuredClone(value);
}

/* ----- property paths (lodash get/set) --------------------------- */

function toPath(path: string | (string | number)[]): (string | number)[] {
  if (Array.isArray(path)) {
    return path;
  }

  const result: (string | number)[] = [];
  const pattern = /[^.[\]]+/g;
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = pattern.exec(path)) !== null) {
    result.push(match[0]);
  }
  return result;
}

export function get<T = unknown>(
  obj: unknown,
  path: string | (string | number)[],
  defaultValue?: T,
): T {
  const segments = toPath(path);
  let current: any = obj;

  for (const segment of segments) {
    if (current == null) {
      return defaultValue as T;
    }
    current = current[segment];
  }

  return (current === undefined ? defaultValue : current) as T;
}

export function set<T extends object>(
  obj: T,
  path: string | (string | number)[],
  value: unknown,
): T {
  const segments = toPath(path);
  if (segments.length === 0 || obj == null) {
    return obj;
  }

  let current: any = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const next = current[segment];
    if (next == null || typeof next !== "object") {
      const nextSegment = segments[i + 1];
      current[segment] = typeof nextSegment === "number" ? [] : {};
    }
    current = current[segment];
  }

  current[segments[segments.length - 1]] = value;
  return obj;
}

export function lastIndexOf<T>(
  collection: string | readonly T[],
  value: T,
): number {
  return (collection as readonly T[]).lastIndexOf(value as T);
}

/* ----- deep merge (lodash merge) --------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function mergeInto(target: any, source: any): any {
  if (source == null) {
    return target;
  }

  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (Array.isArray(sourceValue)) {
      const base = Array.isArray(targetValue) ? targetValue : [];
      target[key] = mergeInto(base, sourceValue);
    } else if (isPlainObject(sourceValue)) {
      const base = isPlainObject(targetValue) ? targetValue : {};
      target[key] = mergeInto(base, sourceValue);
    } else if (sourceValue !== undefined) {
      target[key] = sourceValue;
    }
  }

  return target;
}

/** Recursively merges `sources` into `target`, mutating and returning it. */
export function merge<T extends object>(target: T, ...sources: unknown[]): T {
  for (const source of sources) {
    mergeInto(target, source);
  }
  return target;
}

/* ----- ordering (lodash orderBy) --------------------------------- */

export function orderBy<T>(
  collection: readonly T[],
  iteratees: ((item: T) => unknown)[],
  orders: ("asc" | "desc")[],
): T[] {
  return [...collection].sort((a, b) => {
    for (let i = 0; i < iteratees.length; i++) {
      const direction = orders[i] === "desc" ? -1 : 1;
      const aValue = iteratees[i](a) as any;
      const bValue = iteratees[i](b) as any;

      if (aValue < bValue) {
        return -1 * direction;
      }
      if (aValue > bValue) {
        return 1 * direction;
      }
    }
    return 0;
  });
}

/* ------------------------------------------------------------------ *
 * String helpers (locutus replacement)
 * ------------------------------------------------------------------ */

/** Uppercases the first letter of each whitespace/hyphen-delimited word. */
export function ucwords(str: string): string {
  return String(str).replace(
    /(^|[\s-])([a-z])/g,
    (_, boundary: string, letter: string) => boundary + letter.toUpperCase(),
  );
}

/* ------------------------------------------------------------------ *
 * URL encoding (encodeurl replacement)
 * ------------------------------------------------------------------ */

// Matches runs of characters outside the URL-safe set defined by RFC 3986
// (the range mirrors the `encodeurl` package); the ranges are deliberate.
// eslint-disable-next-line regexp/no-obscure-range -- spec-derived safe-character set
const ENCODE_CHARS = /(?:[^!#-;=?-_|~]|%(?![0-9A-F]{2}))+/gi;

/**
 * Encodes a URL while leaving already-percent-encoded sequences intact, matching
 * the behaviour of the `encodeurl` package.
 */
export function encodeUrl(url: string): string {
  return String(url).replace(ENCODE_CHARS, (match) => encodeURI(match));
}

/* ------------------------------------------------------------------ *
 * Date formatting (date-fns replacement)
 * ------------------------------------------------------------------ */

export function isDateValid(date: Date): boolean {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

/** Formats a date as an HTTP-date (RFC 7231), e.g. `Last-Modified`. */
export function toHttpDate(date: Date): string {
  return date.toUTCString();
}

/* ------------------------------------------------------------------ *
 * ETag generation (@tinyhttp/etag replacement)
 * ------------------------------------------------------------------ */

/**
 * Generates a strong ETag for a string or buffer using Bun's fast non-crypto
 * hash, encoding both byte length and a content hash.
 */
export function etag(entity: string | Buffer | ArrayBufferView): string {
  const buf =
    typeof entity === "string"
      ? Buffer.from(entity, "utf8")
      : Buffer.isBuffer(entity)
        ? entity
        : Buffer.from(
            (entity as ArrayBufferView).buffer,
            (entity as ArrayBufferView).byteOffset,
            (entity as ArrayBufferView).byteLength,
          );

  if (buf.length === 0) {
    return '"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';
  }

  const len = buf.length;
  const hash = Bun.hash(buf).toString(16);
  return `"${len.toString(16)}-${hash}"`;
}

/* ------------------------------------------------------------------ *
 * HTTP freshness (fresh replacement)
 * ------------------------------------------------------------------ */

const CACHE_NO_CACHE = /(?:^|,)\s*no-cache\s*(?:,|$)/;

/**
 * Determines whether a cached response is still fresh given request and
 * response headers, per RFC 7232.
 */
export function fresh(
  reqHeaders: Record<string, string | string[] | undefined>,
  resHeaders: Record<string, string | string[] | undefined>,
): boolean {
  const modifiedSince = reqHeaders["if-modified-since"];
  const noneMatch = reqHeaders["if-none-match"];

  if (!modifiedSince && !noneMatch) {
    return false;
  }

  const cacheControl = reqHeaders["cache-control"];
  if (
    cacheControl &&
    CACHE_NO_CACHE.test(
      Array.isArray(cacheControl) ? cacheControl.join(",") : cacheControl,
    )
  ) {
    return false;
  }

  // If-None-Match
  if (noneMatch && noneMatch !== "*") {
    const etagHeader = resHeaders.etag;
    if (!etagHeader) {
      return false;
    }

    const matches = parseTokenList(
      Array.isArray(noneMatch) ? noneMatch.join(",") : noneMatch,
    );
    const currentEtag = Array.isArray(etagHeader) ? etagHeader[0] : etagHeader;
    let etagMatches = false;
    for (const match of matches) {
      if (
        match === currentEtag ||
        match === `W/${currentEtag}` ||
        `W/${match}` === currentEtag
      ) {
        etagMatches = true;
        break;
      }
    }
    if (!etagMatches) {
      return false;
    }
  }

  // If-Modified-Since
  if (modifiedSince) {
    const lastModified = resHeaders["last-modified"];
    const since = Array.isArray(modifiedSince)
      ? modifiedSince[0]
      : modifiedSince;
    const modified = Array.isArray(lastModified)
      ? lastModified[0]
      : lastModified;
    const lastModifiedValid =
      modified && Date.parse(modified) <= Date.parse(since);
    if (!lastModifiedValid) {
      return false;
    }
  }

  return true;
}

function parseTokenList(str: string): string[] {
  return str
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Range parsing (range-parser replacement)
 * ------------------------------------------------------------------ */

export interface Range {
  start: number;
  end: number;
}

export interface RangesSpecifier extends Array<Range> {
  type: string;
}

export type RangeParserResult = -1 | -2 | RangesSpecifier;

/**
 * Parses a `Range` header value. Returns `-1` for an unsatisfiable range,
 * `-2` for a malformed header, or an array of ranges with a `type` property.
 */
export function rangeParser(
  size: number,
  header: string,
  options?: { combine?: boolean },
): RangeParserResult {
  const index = header.indexOf("=");
  if (index === -1) {
    return -2;
  }

  const type = header.slice(0, index);
  const rangeStrings = header.slice(index + 1).split(",");
  const ranges: RangesSpecifier = Object.assign([] as Range[], { type });

  for (const rangeString of rangeStrings) {
    const dash = rangeString.indexOf("-");
    let start = Number.parseInt(rangeString.slice(0, dash), 10);
    let end = Number.parseInt(rangeString.slice(dash + 1), 10);

    if (Number.isNaN(start)) {
      start = size - end;
      end = size - 1;
    } else if (Number.isNaN(end)) {
      end = size - 1;
    }

    if (end > size - 1) {
      end = size - 1;
    }

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0) {
      continue;
    }

    ranges.push({ start, end });
  }

  if (ranges.length === 0) {
    return -1;
  }

  return options?.combine ? combineRanges(ranges) : ranges;
}

/**
 * Merges overlapping/adjacent byte ranges into the smallest equivalent set,
 * preserving the original request order on the result (`rangeParser` calls this
 * when its `combine` option is set). Each input/output entry is an inclusive
 * `{ start, end }` byte range.
 */
export function combineRanges(ranges: RangesSpecifier): RangesSpecifier {
  const ordered = ranges
    .map((range, index) => ({ ...range, index }))
    .sort((a, b) => a.start - b.start);

  let lastIndex = 0;
  for (let i = 1; i < ordered.length; i++) {
    const range = ordered[i];
    const current = ordered[lastIndex];

    if (range.start > current.end + 1) {
      ordered[++lastIndex] = range;
    } else if (range.end > current.end) {
      current.end = range.end;
      current.index = Math.min(current.index, range.index);
    }
  }

  ordered.length = lastIndex + 1;
  ordered.sort((a, b) => a.index - b.index);

  const combined: RangesSpecifier = Object.assign([] as Range[], {
    type: ranges.type,
  });
  for (const range of ordered) {
    combined.push({ start: range.start, end: range.end });
  }
  return combined;
}

/* ------------------------------------------------------------------ *
 * Vary header (vary replacement)
 * ------------------------------------------------------------------ */

const FIELD_NAME = /^[!#$%&'*+\-.^\w`|~]+$/;

/** Appends one or more field names to a `Vary` header value. */
export function appendVary(current: string, field: string | string[]): string {
  const fields = Array.isArray(field) ? field : parseTokenList(field);

  for (const name of fields) {
    if (!FIELD_NAME.test(name)) {
      throw new TypeError("field argument contains an invalid header name");
    }
  }

  if (current === "*") {
    return current;
  }

  let value = current;
  const existing = parseTokenList(current.toLowerCase());

  if (fields.includes("*") || existing.includes("*")) {
    return "*";
  }

  for (const name of fields) {
    if (!existing.includes(name.toLowerCase())) {
      value = value ? `${value}, ${name}` : name;
      existing.push(name.toLowerCase());
    }
  }

  return value;
}

/* ------------------------------------------------------------------ *
 * Cookies — parsing/serialization is delegated to Bun's native
 * `Bun.CookieMap` / `Bun.Cookie`; signing remains a local HMAC.
 * ------------------------------------------------------------------ */

export interface CookieParseOptions {
  /**
   * Retained for call-signature compatibility. Bun's `CookieMap` performs
   * standard percent-decoding, so a custom decoder is no longer applied.
   */
  decode?: (value: string) => string;
}

export interface CookieSerializeOptions {
  /**
   * Retained for call-signature compatibility. Bun's `Cookie` performs
   * standard percent-encoding, so a custom encoder is no longer applied.
   */
  encode?: (value: string) => string;
  maxAge?: number;
  domain?: string;
  path?: string;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  partitioned?: boolean;
  priority?: "low" | "medium" | "high";
  sameSite?: boolean | "lax" | "strict" | "none";
}

/**
 * Parses a `Cookie` header into a key/value record using Bun's native
 * `CookieMap`.
 */
export function parseCookie(
  str: string,
  _options?: CookieParseOptions,
): Record<string, string> {
  if (!str) {
    return {};
  }

  try {
    return new Bun.CookieMap(str).toJSON();
  } catch {
    return {};
  }
}

/**
 * Serializes a name/value pair into a `Set-Cookie` header string using Bun's
 * native `Cookie`. Bun applies `Path=/` and `SameSite=Lax` defaults; the
 * `Priority` attribute (unsupported by `Bun.Cookie`) is appended manually.
 */
export function serializeCookie(
  name: string,
  value: string,
  options?: CookieSerializeOptions,
): string {
  const opts = options ?? {};
  const sameSite =
    opts.sameSite === true
      ? "strict"
      : opts.sameSite === false
        ? undefined
        : opts.sameSite;

  let serialized = new Bun.Cookie(name, value, {
    domain: opts.domain,
    path: opts.path,
    expires: opts.expires,
    maxAge: opts.maxAge == null ? undefined : Math.floor(opts.maxAge),
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    partitioned: opts.partitioned,
    sameSite,
  }).serialize();

  if (opts.priority) {
    const priority = opts.priority;
    serialized += `; Priority=${priority.charAt(0).toUpperCase()}${priority.slice(1)}`;
  }

  return serialized;
}

/** Signs a cookie value with an HMAC-SHA256 of the supplied secret. */
export function signCookie(value: string, secret: string): string {
  const signature = createHmac("sha256", secret)
    .update(value)
    .digest("base64")
    .replace(/=+$/, "");
  return `${value}.${signature}`;
}

/**
 * Verifies a signed cookie. Returns the original value, or `false` when the
 * signature is invalid.
 */
export function unsignCookie(input: string, secret: string): string | false {
  const dotIndex = input.lastIndexOf(".");
  if (dotIndex < 0) {
    return false;
  }

  const value = input.slice(0, dotIndex);
  const expected = signCookie(value, secret);
  const expectedBuf = Buffer.from(expected);
  const inputBuf = Buffer.from(input);

  if (
    expectedBuf.length === inputBuf.length &&
    timingSafeEqual(expectedBuf, inputBuf)
  ) {
    return value;
  }

  return false;
}

/** Parses any `j:`-prefixed JSON cookie values in place (cookie-parser). */
export function jsonCookies<T extends Record<string, string>>(
  cookies: T,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...cookies };
  for (const key of Object.keys(result)) {
    const value = result[key];
    if (typeof value === "string" && value.startsWith("j:")) {
      try {
        result[key] = JSON.parse(value.slice(2));
      } catch {
        // leave the raw value in place
      }
    }
  }
  return result;
}

/**
 * Splits parsed cookies into successfully verified signed cookies (cookie-parser
 * `signedCookies`). Verified entries are removed from the input object.
 */
export function extractSignedCookies(
  cookies: Record<string, string>,
  secrets: string[],
): Record<string, string> {
  const signed: Record<string, string> = {};

  for (const key of Object.keys(cookies)) {
    const value = cookies[key];
    if (typeof value !== "string" || !value.startsWith("s:")) {
      continue;
    }

    const raw = value.slice(2);
    for (const secret of secrets) {
      const unsigned = unsignCookie(raw, secret);
      if (unsigned !== false) {
        signed[key] = unsigned;
        delete cookies[key];
        break;
      }
    }
  }

  return signed;
}

/* ------------------------------------------------------------------ *
 * Async helpers (until-promise replacement)
 * ------------------------------------------------------------------ */

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/** Creates an externally-resolvable promise. */
export function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Repeatedly evaluates `getValue` until `predicate` is satisfied, then resolves
 * with that value. Replaces the `until-promise` package.
 */
export async function waitUntil<T>(
  getValue: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  options?: { interval?: number; timeout?: number },
): Promise<T> {
  const interval = options?.interval ?? 5;
  const timeout = options?.timeout ?? 0;
  const deadline = timeout > 0 ? Date.now() + timeout : 0;

  while (true) {
    const value = await getValue();
    if (predicate(value)) {
      return value;
    }

    if (deadline && Date.now() >= deadline) {
      throw new Error("waitUntil timed out");
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/* ------------------------------------------------------------------ *
 * Free port discovery (get-port replacement)
 * ------------------------------------------------------------------ */

/**
 * Ports handed out recently, kept locked briefly so concurrent/sequential
 * callers never receive the same port before its previous owner has fully
 * released it. Mirrors the `get-port` package's lock behaviour.
 */
const lockedPorts = new Set<number>();
const PORT_LOCK_MS = 1000;

/**
 * Finds an available TCP port. Tries each candidate in `port` (and finally an
 * OS-assigned port) by briefly binding a Bun server, skipping ports handed out
 * within the last second.
 */
export async function getPort(options?: {
  host?: string;
  port?: number | number[];
}): Promise<number> {
  const host = options?.host ?? "127.0.0.1";
  const candidates = options?.port
    ? Array.isArray(options.port)
      ? options.port
      : [options.port]
    : [];

  for (const candidate of [...candidates, 0]) {
    if (candidate !== 0 && lockedPorts.has(candidate)) {
      continue;
    }

    try {
      const server = Bun.serve({
        port: candidate,
        hostname: host,
        fetch: () => new Response(null),
      });
      const port = server.port;
      server.stop(true);
      if (port != null && !lockedPorts.has(port)) {
        lockedPorts.add(port);
        const timer = setTimeout(() => lockedPorts.delete(port), PORT_LOCK_MS);
        timer.unref?.();
        return port;
      }
    } catch {
      // port in use; try the next candidate
    }
  }

  throw new Error("No available port found");
}

/* ------------------------------------------------------------------ *
 * XML parsing (native; no third-party dependency)
 *
 * Parses an XML document into a plain JS object suitable for use as a
 * request body. Element attributes are exposed under `attributeNamePrefix`
 * (default `"@_"`); a leaf element's text becomes its value, while an
 * element that also has attributes/children keeps its text under
 * `textNodeName` (default `"#text"`). Repeated sibling elements collapse
 * into an array. The XML/processing-instruction declarations, comments and
 * DOCTYPE are ignored; CDATA sections are treated as text.
 * ------------------------------------------------------------------ */

export interface ParseXmlOptions {
  /** Prefix used for attribute keys. Defaults to `"@_"`. */
  attributeNamePrefix?: string;
  /**
   * Key holding an element's text when it also carries attributes or child
   * elements. Defaults to `"#text"`.
   */
  textNodeName?: string;
  /** When `false`, attributes are dropped entirely. Defaults to `true`. */
  ignoreAttributes?: boolean;
  /**
   * When `true`, text that looks like a number/boolean is coerced to a
   * `number`/`boolean`. Defaults to `true`.
   */
  parsePrimitives?: boolean;
}

const XML_NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decodes the XML predefined entities (`&amp; &lt; &gt; &quot; &apos;`) and
 * numeric character references (`&#nn;` / `&#xhh;`) in `text`. Unknown
 * entities are left untouched.
 */
export function decodeXmlEntities(text: string): string {
  if (!text.includes("&")) {
    return text;
  }

  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    const decoded = XML_NAMED_ENTITIES[body.toLowerCase()];
    return decoded === undefined ? match : decoded;
  });
}

/**
 * Coerces XML text to a primitive: `"true"`/`"false"` become booleans and
 * numeric text becomes a `number` (after trimming). When `parsePrimitives` is
 * `false`, the trimmed string is returned as-is.
 */
export function coerceXmlPrimitive(
  text: string,
  parsePrimitives: boolean,
): unknown {
  const trimmed = text.trim();
  if (!parsePrimitives) {
    return trimmed;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed !== "" && isNumeric(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

/** Whether `code` is an XML whitespace char (space, tab, LF, CR). */
export function isXmlWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/**
 * Whether `text` is empty or contains only XML whitespace. Avoids the
 * allocation of `text.trim() === ""` by scanning char codes in place.
 */
function isXmlBlank(text: string): boolean {
  for (let j = 0; j < text.length; j++) {
    if (!isXmlWhitespace(text.charCodeAt(j))) {
      return false;
    }
  }
  return true;
}

/**
 * Parses an XML string into a plain object keyed by the root element name.
 * Throws if no XML element is present.
 *
 * Implemented as a single forward pass that builds the result object directly
 * (no intermediate node tree, no second walk) and scans with `charCodeAt` to
 * avoid per-character string allocations — both meaningfully faster than the
 * naive two-pass approach on large documents.
 */
export function parseXmlToObject(
  xml: string,
  options?: ParseXmlOptions,
): Record<string, unknown> {
  const attributeNamePrefix = options?.attributeNamePrefix ?? "@_";
  const textNodeName = options?.textNodeName ?? "#text";
  const ignoreAttributes = options?.ignoreAttributes ?? false;
  const parsePrimitives = options?.parsePrimitives ?? true;

  let i = 0;
  const len = xml.length;
  // The most recently parsed element's name, returned out-of-band from
  // `parseElement` so a parent can key the child's value without an extra
  // wrapper object allocation per element.
  let lastName = "";

  const value = (text: string): unknown =>
    coerceXmlPrimitive(text, parsePrimitives);

  // Parses one element (cursor positioned just after its opening `<`) and
  // returns its value; leaves the element's name in `lastName`.
  function parseElement(): unknown {
    const nameStart = i;
    while (i < len) {
      const c = xml.charCodeAt(i);
      if (isXmlWhitespace(c) || c === 47 /* / */ || c === 62 /* > */) {
        break;
      }
      i++;
    }
    const name = xml.slice(nameStart, i);
    let obj: Record<string, unknown> | null = null;

    // Attributes (up to the closing `>` or self-closing `/>`).
    for (;;) {
      while (i < len && isXmlWhitespace(xml.charCodeAt(i))) {
        i++;
      }
      const c = xml.charCodeAt(i);
      if (c === 47 /* / */) {
        while (i < len && xml.charCodeAt(i) !== 62) {
          i++;
        }
        i++; // skip '>'
        lastName = name;
        return obj ?? value("");
      }
      if (c === 62 /* > */) {
        i++; // skip '>'
        break;
      }
      const attrNameStart = i;
      while (i < len) {
        const cc = xml.charCodeAt(i);
        if (
          isXmlWhitespace(cc) ||
          cc === 61 /* = */ ||
          cc === 47 /* / */ ||
          cc === 62 /* > */
        ) {
          break;
        }
        i++;
      }
      const attrName = xml.slice(attrNameStart, i);
      while (i < len && isXmlWhitespace(xml.charCodeAt(i))) {
        i++;
      }
      let attrValue = "";
      let attrHasEntity = false;
      if (xml.charCodeAt(i) === 61 /* = */) {
        i++; // skip '='
        while (i < len && isXmlWhitespace(xml.charCodeAt(i))) {
          i++;
        }
        const quote = xml.charCodeAt(i);
        if (quote === 34 /* " */ || quote === 39 /* ' */) {
          i++; // skip opening quote
          const valStart = i;
          while (i < len) {
            const cc = xml.charCodeAt(i);
            if (cc === quote) {
              break;
            }
            if (cc === 38 /* & */) {
              attrHasEntity = true;
            }
            i++;
          }
          attrValue = xml.slice(valStart, i);
          i++; // skip closing quote
        } else {
          const valStart = i;
          while (i < len) {
            const cc = xml.charCodeAt(i);
            if (isXmlWhitespace(cc) || cc === 62 /* > */) {
              break;
            }
            if (cc === 38 /* & */) {
              attrHasEntity = true;
            }
            i++;
          }
          attrValue = xml.slice(valStart, i);
        }
      }
      if (attrName && !ignoreAttributes) {
        (obj ??= {})[`${attributeNamePrefix}${attrName}`] = value(
          attrHasEntity ? decodeXmlEntities(attrValue) : attrValue,
        );
      }
    }

    // Children and text content, until this element's closing tag.
    let text = "";
    for (;;) {
      if (i >= len) {
        break;
      }
      if (xml.charCodeAt(i) === 60 /* < */) {
        const c1 = xml.charCodeAt(i + 1);
        if (c1 === 47 /* / */) {
          // closing tag — consume up to '>' and finish this element
          i += 2;
          while (i < len && xml.charCodeAt(i) !== 62) {
            i++;
          }
          i++; // skip '>'
          break;
        } else if (c1 === 33 /* ! */) {
          const c2 = xml.charCodeAt(i + 2);
          if (c2 === 45 /* - */) {
            // comment
            const end = xml.indexOf("-->", i + 4);
            i = end === -1 ? len : end + 3;
          } else if (c2 === 91 /* [ */) {
            // CDATA — raw text
            const end = xml.indexOf("]]>", i + 9);
            text += xml.slice(i + 9, end === -1 ? len : end);
            i = end === -1 ? len : end + 3;
          } else {
            // DOCTYPE or other declaration
            while (i < len && xml.charCodeAt(i) !== 62) {
              i++;
            }
            i++; // skip '>'
          }
        } else if (c1 === 63 /* ? */) {
          // processing instruction
          const end = xml.indexOf("?>", i + 2);
          i = end === -1 ? len : end + 2;
        } else {
          i++; // skip '<'
          const childValue = parseElement();
          const childName = lastName;
          const o = (obj ??= {});
          const existing = o[childName];
          if (existing === undefined) {
            o[childName] = childValue;
          } else if (isArray(existing)) {
            existing.push(childValue);
          } else {
            o[childName] = [existing, childValue];
          }
        }
      } else {
        const textStart = i;
        let textHasEntity = false;
        while (i < len) {
          const c = xml.charCodeAt(i);
          if (c === 60 /* < */) {
            break;
          }
          if (c === 38 /* & */) {
            textHasEntity = true;
          }
          i++;
        }
        const chunk = xml.slice(textStart, i);
        text += textHasEntity ? decodeXmlEntities(chunk) : chunk;
      }
    }

    lastName = name;
    if (obj === null) {
      return value(text);
    }
    if (!isXmlBlank(text)) {
      obj[textNodeName] = value(text);
    }
    return obj;
  }

  // Skip the prolog (declaration, comments, DOCTYPE) up to the root element.
  for (;;) {
    while (i < len && xml.charCodeAt(i) !== 60) {
      i++;
    }
    if (i >= len) {
      break;
    }
    const c1 = xml.charCodeAt(i + 1);
    if (c1 === 63 /* ? */) {
      const end = xml.indexOf("?>", i + 2);
      i = end === -1 ? len : end + 2;
    } else if (c1 === 33 /* ! */) {
      if (xml.charCodeAt(i + 2) === 45 /* - */) {
        const end = xml.indexOf("-->", i + 4);
        i = end === -1 ? len : end + 3;
      } else {
        while (i < len && xml.charCodeAt(i) !== 62) {
          i++;
        }
        i++; // skip '>'
      }
    } else {
      break;
    }
  }

  if (i >= len) {
    throw new Error("No XML element found");
  }
  i++; // skip the root element's opening '<'
  const rootValue = parseElement();
  return { [lastName]: rootValue };
}
