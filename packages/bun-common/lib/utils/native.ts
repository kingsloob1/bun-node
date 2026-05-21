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

function combineRanges(ranges: RangesSpecifier): RangesSpecifier {
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
