/**
 * Native, dependency-free utilities.
 *
 * These replace a collection of small third-party packages (lodash-es,
 * fast-isnumeric, date-fns, locutus, encodeurl, vary, fresh, range-parser,
 * @tinyhttp/etag, cookie, cookie-parser, cookie-signature, get-port,
 * until-promise) with lean implementations backed by the standard library
 * and Bun primitives.
 */
import { Buffer, kMaxLength } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  brotliCompressSync,
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";

/* ------------------------------------------------------------------ *
 * Shared type helpers
 * ------------------------------------------------------------------ */

/** `true` when `T` is `any` — the one type every conditional must special-case. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** Flattens an intersection into one object type, for readable hovers. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** A value `JSON.parse` can produce: what survives a JSON round trip. */
export type JsonPrimitive = string | number | boolean | null;

/** Any JSON document — a primitive, an array of them, or an object of them. */
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * What `JSON.stringify` refuses to write: it drops such a property from an
 * object, writes `null` for it in an array, and yields `undefined` for it at
 * the top level.
 */
type JsonUnrepresentable = undefined | symbol | ((...args: never[]) => unknown);

/** What JSON makes of a `Map` or a `Set`: an object with no properties. */
type EmptyJsonObject = Record<string, never>;

/**
 * An object property after JSON. The unrepresentable part of a union is gone,
 * leaving `undefined` in its place — the key may be absent — and `unknown` is
 * any JSON value or `undefined`.
 */
type JsonifyProperty<V> =
  IsAny<V> extends true
    ? V
    : unknown extends V
      ? JsonValue | undefined
      :
          | JsonifyValue<Exclude<V, JsonUnrepresentable>>
          | ([Extract<V, JsonUnrepresentable>] extends [never]
              ? never
              : undefined);

/** An array element after JSON: an unrepresentable element becomes `null`. */
type JsonifyElement<E> =
  IsAny<E> extends true
    ? E
    : unknown extends E
      ? JsonValue
      : E extends JsonUnrepresentable
        ? null
        : JsonifyValue<E>;

/**
 * The keys JSON can write: a symbol key is never written, nor a property whose
 * every possible value is unrepresentable.
 */
type JsonKey<T, K extends keyof T> = K extends symbol
  ? never
  : unknown extends T[K]
    ? K
    : [Exclude<T[K], JsonUnrepresentable>] extends [never]
      ? never
      : K;

/**
 * An object after JSON, one property at a time. Optional keys stay optional;
 * a key whose value is only sometimes unrepresentable stays too, typed with
 * `| undefined` — reading it gives what an optional key would, and the result
 * still assigns back to `T` where `T` was already JSON-shaped.
 */
type JsonifyObject<T extends object> = {
  -readonly [K in keyof T as JsonKey<T, K>]: JsonifyProperty<T[K]>;
};

/** One member of a union after JSON (distributes over `T`). */
type JsonifyValue<T> = T extends JsonValue
  ? T
  : T extends { toJSON: (...args: never[]) => infer R }
    ? Jsonify<R>
    : T extends JsonPrimitive
      ? T
      : T extends bigint
        ? never
        : T extends JsonUnrepresentable
          ? undefined
          : T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>
            ? EmptyJsonObject
            : T extends readonly unknown[]
              ? { -readonly [I in keyof T]: JsonifyElement<T[I]> }
              : T extends object
                ? JsonifyObject<T>
                : never;

/**
 * The type `JSON.parse(JSON.stringify(value))` produces for a `T` — what
 * {@link jsonClone} returns.
 *
 * It follows `JSON.stringify`: `toJSON()` is honoured (so a `Date` is a
 * `string`); a function, symbol or `undefined` property is dropped (optional
 * when only part of its type is), and the same value in an array is `null`;
 * a `Map` or `Set` is an empty object; `readonly` is gone; a symbol key is
 * gone. A top-level function, symbol or `undefined` is `undefined`, and a
 * `bigint` is `never`, because stringifying one throws. `unknown` becomes
 * `JsonValue` (plus `undefined` at the top level); `any` stays `any`.
 *
 * A type already made of JSON values comes back unchanged. `NaN` and
 * `Infinity` still type as `number`, although they serialise as `null`.
 */
export type Jsonify<T> =
  IsAny<T> extends true
    ? T
    : unknown extends T
      ? JsonValue | undefined
      : JsonifyValue<T>;

/* ------------------------------------------------------------------ *
 * Type guards (lodash-es replacements)
 *
 * Each guard takes `unknown` on purpose: inspecting a value of unknown type
 * is what a guard is for, and the `value is X` predicate narrows a caller's
 * union to the members assignable to `X`.
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

/**
 * True for any view over an `ArrayBuffer` — every typed array (including
 * `Buffer`, which is a `Uint8Array`) plus `DataView`.
 */
export function isArrayBufferView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value);
}

/**
 * True for a raw binary buffer: `ArrayBuffer` or `SharedArrayBuffer`.
 * `SharedArrayBuffer` is feature-detected — it is absent when the runtime
 * disables it (e.g. without cross-origin isolation).
 */
export function isAnyArrayBuffer(value: unknown): value is ArrayBufferLike {
  return (
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" &&
      value instanceof SharedArrayBuffer)
  );
}

/**
 * True for a binary body Bun can write to the socket verbatim: a typed array,
 * a `DataView`, an `ArrayBuffer` or a `SharedArrayBuffer`.
 */
export function isBinaryBody(
  value: unknown,
): value is ArrayBufferView | ArrayBufferLike {
  return isArrayBufferView(value) || isAnyArrayBuffer(value);
}

/** True for an object implementing `Symbol.asyncIterator` (streamable body). */
export function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<unknown> {
  return (
    isObject(value) &&
    isFunction((value as AsyncIterable<unknown>)[Symbol.asyncIterator])
  );
}

/**
 * True for an `async function*` declaration itself (not a running generator).
 * Bun's `Response` accepts one directly and pulls the body from it lazily.
 */
export function isAsyncGeneratorFunction(
  value: unknown,
): value is () => AsyncGenerator<unknown> {
  return (
    isFunction(value) && value.constructor?.name === "AsyncGeneratorFunction"
  );
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

/**
 * The own enumerable keys of `value`, `[]` for `null`/`undefined`. Typed
 * `string[]` rather than `keyof T` for the reason `Object.keys` is: an object
 * may carry more keys than its type declares. Accepts anything, as
 * `Object.keys` does (a string yields its indexes).
 */
export const keys = (value: unknown): string[] =>
  value == null ? [] : Object.keys(value as object);

/** The string keys of an object type; `string` when it declares none. */
type ObjectKey<C> = [Extract<keyof C, string>] extends [never]
  ? string
  : Extract<keyof C, string>;

/** The value type at the string keys of an object type; `unknown` when it declares none. */
type ObjectValue<C> = [Extract<keyof C, string>] extends [never]
  ? unknown
  : C[Extract<keyof C, string>];

/**
 * The key {@link each} passes for a collection: the index for an array, the
 * string key for an object. Distributes over a union of collections.
 */
export type EachKey<C> = C extends readonly unknown[]
  ? number
  : C extends object
    ? ObjectKey<C>
    : never;

/**
 * The value {@link each} passes for a collection: the element for an array,
 * the property value for an object. Distributes over a union of collections.
 */
export type EachValue<C> = C extends readonly unknown[]
  ? C[number]
  : C extends object
    ? ObjectValue<C>
    : never;

/**
 * The element type {@link values} returns for `C`, mirroring `Object.values`:
 * nothing for `null`/`undefined` and for number/boolean/bigint/symbol, the
 * characters of a string, an array's elements, an object's property values.
 */
export type ValuesOf<C> = C extends null | undefined
  ? never
  : C extends readonly unknown[]
    ? C[number]
    : C extends string
      ? string
      : C extends number | boolean | bigint | symbol
        ? never
        : C extends object
          ? ObjectValue<C>
          : unknown;

/** The own enumerable property values of `value`, `[]` for `null`/`undefined`. */
export const values = <C>(value: C): ValuesOf<C>[] =>
  value == null ? [] : (Object.values(value as object) as ValuesOf<C>[]);

export const first = <T>(
  value: ArrayLike<T> | null | undefined,
): T | undefined => (value && value.length ? value[0] : undefined);

/** An array nested to any depth, whose leaves are `T`. */
export type NestedArray<T> = T | readonly NestedArray<T>[];

/** The leaf type of a nested array type: `DeepFlatten<(1 | 2[])[]>` is `1 | 2`. */
export type DeepFlatten<T> = T extends readonly (infer E)[]
  ? DeepFlatten<E>
  : T;

/**
 * Flattens `value` recursively, however deep. The element type is inferred
 * from the input; `flattenDeep<T>(value)` states the leaf type instead, and
 * then requires every leaf of `value` to be a `T`.
 */
export function flattenDeep<A extends readonly unknown[]>(
  value: A,
): DeepFlatten<A>[];
export function flattenDeep<T>(value: readonly NestedArray<T>[]): T[];
export function flattenDeep(value: readonly unknown[]): unknown[] {
  return value.flat(Infinity as 1);
}

/**
 * Iterate arrays or plain objects, calling `fn(value, key)` — the index for an
 * array, the own enumerable string key for an object. `null`/`undefined` is a
 * no-op.
 */
export function each<C extends object>(
  collection: C | null | undefined,
  fn: (value: EachValue<C>, key: EachKey<C>) => void,
): void;
export function each(
  collection: object | null | undefined,
  fn: (value: unknown, key: string | number) => void,
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
    fn((collection as Record<string, unknown>)[key], key);
  }
}

/** `Omit` applied to each member of a union separately, so no member loses its own keys. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * What {@link omit} returns: `T` without the keys `K`. A `K` of plain `string`
 * (keys not known at compile time) could have removed anything, so it gives
 * `Partial<T>`.
 */
export type OmitResult<T, K extends string> = string extends K
  ? Partial<T>
  : DistributiveOmit<T, K>;

/**
 * A shallow copy of `obj`'s own enumerable string keys, without those in
 * `paths`. `null`/`undefined` gives `{}`, which is why the nullable overload
 * returns a `Partial`.
 */
export function omit<T extends object, K extends string>(
  obj: T,
  paths: readonly K[],
): OmitResult<T, K>;
export function omit<T extends object, K extends string>(
  obj: T | null | undefined,
  paths: readonly K[],
): Partial<OmitResult<T, K>>;
export function omit(
  obj: object | null | undefined,
  paths: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (obj == null) {
    return result;
  }

  const exclude = new Set(paths);
  for (const key of Object.keys(obj)) {
    if (!exclude.has(key)) {
      result[key] = (obj as Record<string, unknown>)[key];
    }
  }

  return result;
}

/**
 * A shallow copy of the keys in `paths` that `obj` has (`key in obj`). Keys the
 * type declares give a `Pick`; any other string is accepted too and gives a
 * `Partial<T>`, since such a key is copied only when present at runtime.
 */
export function pick<T extends object, K extends Extract<keyof T, string>>(
  obj: T,
  paths: readonly K[],
): Pick<T, K>;
export function pick<T extends object, K extends Extract<keyof T, string>>(
  obj: T | null | undefined,
  paths: readonly K[],
): Partial<Pick<T, K>>;
export function pick<T extends object>(
  obj: T | null | undefined,
  paths: readonly string[],
): Partial<T>;
export function pick(
  obj: object | null | undefined,
  paths: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (obj == null) {
    return result;
  }

  for (const key of paths) {
    if (key in obj) {
      result[key] = (obj as Record<string, unknown>)[key];
    }
  }

  return result;
}

/**
 * Deletes `key` from `obj`. Answers `true` for any object (even when the key
 * was absent) and `false` for anything else, which is why it accepts
 * `unknown`.
 */
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

function toPath(path: PropertyPath): readonly (string | number)[] {
  if (typeof path !== "string") {
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

/** A property path: a dotted/bracketed string (`"a.b[0].c"`) or its segments. */
export type PropertyPath = string | readonly (string | number)[];

/**
 * Splits a string path exactly as `get`/`set` do at runtime: on `.`, `[` and
 * `]`, dropping empty segments — `"a.b[0].c"` is `["a", "b", "0", "c"]`.
 */
export type PathSegments<
  P extends string,
  Current extends string = "",
  Out extends string[] = [],
> = P extends `${infer C}${infer Rest}`
  ? C extends "." | "[" | "]"
    ? PathSegments<Rest, "", Current extends "" ? Out : [...Out, Current]>
    : PathSegments<Rest, `${Current}${C}`, Out>
  : Current extends ""
    ? Out
    : [...Out, Current];

/**
 * The value one segment down from `T`. A nullish `T` gives `undefined` (the
 * walk stops there); a key the type does not declare gives `unknown`, since
 * the object may still carry it at runtime.
 */
type SegmentValue<T, K extends string> = T extends null | undefined
  ? undefined
  : K extends keyof T
    ? T[K]
    : T extends readonly unknown[]
      ? K extends `${number}`
        ? T[number] | undefined
        : unknown
      : K extends `${infer N extends number}`
        ? N extends keyof T
          ? T[N]
          : unknown
        : unknown;

/** Walks `T` along a tuple of segments. */
type WalkPath<T, S extends readonly (string | number)[]> =
  IsAny<T> extends true
    ? T
    : S extends readonly [
          infer H extends string | number,
          ...infer R extends readonly (string | number)[],
        ]
      ? WalkPath<SegmentValue<T, `${H}`>, R>
      : S extends readonly []
        ? T
        : unknown;

/**
 * The type `get(obj, path)` reads from a `T`. A path only known as `string` or
 * `(string | number)[]` at compile time gives `unknown`.
 */
export type PathValue<T, P extends PropertyPath> = P extends string
  ? string extends P
    ? unknown
    : WalkPath<T, PathSegments<P>>
  : P extends readonly (string | number)[]
    ? WalkPath<T, P>
    : unknown;

/**
 * Reads the value at `path` in `obj` (lodash `get`). Without a default the
 * result is the type at that path; with one, a missing (`undefined`) value is
 * replaced, so the result is that type minus `undefined`, or the default's.
 *
 * `get<T>(obj, path)` states the result type instead of inferring it, for an
 * `obj` whose type does not describe the path.
 */
export function get<T, const P extends PropertyPath>(
  obj: T,
  path: P,
): PathValue<T, P>;
export function get<T, const P extends PropertyPath, D>(
  obj: T,
  path: P,
  defaultValue: D,
): Exclude<PathValue<T, P>, undefined> | D;
export function get<T>(obj: unknown, path: PropertyPath): T | undefined;
export function get<T>(obj: unknown, path: PropertyPath, defaultValue: T): T;
export function get(
  obj: unknown,
  path: PropertyPath,
  defaultValue?: unknown,
): unknown {
  const segments = toPath(path);
  let current: any = obj;

  for (const segment of segments) {
    if (current == null) {
      return defaultValue;
    }
    current = current[segment];
  }

  return current === undefined ? defaultValue : current;
}

/**
 * Writes `value` at `path` in `obj`, creating missing containers, and returns
 * `obj`. `value` is `unknown` because any value may be written, and the path
 * need not exist in `T`.
 */
export function set<T extends object>(
  obj: T,
  path: PropertyPath,
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

/**
 * The last index of `value` in `collection`, `-1` when absent. A string is
 * searched for a substring, so its `value` must be a string too.
 */
export function lastIndexOf(collection: string, value: string): number;
export function lastIndexOf<T>(collection: readonly T[], value: T): number;
export function lastIndexOf(
  collection: string | readonly unknown[],
  value: unknown,
): number {
  return (collection as readonly unknown[]).lastIndexOf(value);
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

/** Values `merge` assigns by reference instead of merging into: anything that is not a plain object or an array. */
type MergeOpaque =
  | Date
  | RegExp
  | Map<unknown, unknown>
  | Set<unknown>
  | WeakMap<WeakKey, unknown>
  | WeakSet<WeakKey>
  | Promise<unknown>
  | Error
  | ArrayBufferView
  | ArrayBufferLike
  | ((...args: never[]) => unknown);

/** The base a plain-object source merges into: the target value when it is a plain object, else a fresh `{}`. */
type MergeObjectBase<A> = [A] extends [never]
  ? Record<never, never>
  : A extends readonly unknown[] | MergeOpaque
    ? Record<never, never>
    : A extends object
      ? A
      : Record<never, never>;

/** The element type of an array type, `never` for anything else. */
type ArrayElement<A> = A extends readonly (infer E)[] ? E : never;

/** An array source merged index by index into an array target (or into `[]`). */
type MergeArray<A, B extends readonly unknown[]> = Array<
  ArrayElement<A> | MergeValue<ArrayElement<A>, B[number]>
>;

/** One plain-object source merged into one object target. */
type MergeObject<A, B> = A extends unknown
  ? Simplify<
      { [K in keyof A as K extends keyof B ? never : K]: A[K] } & {
        [K in keyof A as K extends keyof B ? K : never]: K extends keyof B
          ? MergeValue<A[K], B[K]>
          : never;
      } & {
        [K in keyof B as K extends keyof A ? never : K]: MergeValue<
          never,
          B[K]
        >;
      }
    >
  : never;

/** A defined source value merged into a target value. */
type MergeDefined<A, B> = B extends readonly unknown[]
  ? MergeArray<A, B>
  : B extends MergeOpaque
    ? B
    : B extends object
      ? MergeObject<MergeObjectBase<A>, B>
      : B;

/** A source value merged into a target value; an `undefined` source leaves the target as it was. */
type MergeValue<A, B> =
  IsAny<B> extends true
    ? A | B
    : [Exclude<B, undefined>] extends [never]
      ? A
      : undefined extends B
        ? A | MergeDefined<A, Exclude<B, undefined>>
        : MergeDefined<A, B>;

/**
 * The type of `merge(target, source)`: plain objects merge key by key, arrays
 * index by index, `undefined` source values are skipped, and anything else
 * (a `Date`, a `Map`, a primitive) replaces the target's value. A `null` or
 * `undefined` source changes nothing. Distributes over a union of sources.
 */
export type MergeResult<T, S> =
  IsAny<T> extends true
    ? T
    : IsAny<S> extends true
      ? T
      : S extends null | undefined
        ? T
        : S extends readonly unknown[]
          ? T extends readonly unknown[]
            ? MergeArray<T, S>
            : T
          : S extends object
            ? MergeObject<T, S>
            : T;

/** {@link MergeResult} applied to each source in turn, left to right. */
export type MergeSources<T, S extends readonly unknown[]> = S extends readonly [
  infer H,
  ...infer R,
]
  ? MergeSources<MergeResult<T, H>, R>
  : S extends readonly []
    ? T
    : MergeResult<T, S[number]>;

/**
 * Recursively merges `sources` into `target`, mutating and returning it. The
 * result type is the merged shape; `merge<T>(target, ...sources)` states it
 * as `T` instead.
 */
export function merge<
  T extends object,
  S extends readonly (object | null | undefined)[],
>(target: T, ...sources: S): MergeSources<T, S>;
export function merge<T extends object>(
  target: T,
  ...sources: readonly (object | null | undefined)[]
): T;
export function merge(
  target: object,
  ...sources: readonly (object | null | undefined)[]
): object {
  for (const source of sources) {
    mergeInto(target, source);
  }
  return target;
}

/* ----- ordering (lodash orderBy) --------------------------------- */

/**
 * A stable sort by several keys, each with its own direction. An iteratee may
 * return anything: keys are compared with `<`/`>`, which is defined for every
 * value, so its result is deliberately `unknown`.
 */
export function orderBy<T>(
  collection: readonly T[],
  iteratees: readonly ((item: T) => unknown)[],
  orders: readonly ("asc" | "desc")[],
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

// A high surrogate not followed by a low one, or a low surrogate not preceded
// by a high one — the same pattern (and replacement) `encodeurl` uses.
const UNMATCHED_SURROGATE =
  /(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF]([^\uDC00-\uDFFF]|$)/g;

/**
 * Encodes a URL while leaving already-percent-encoded sequences intact, matching
 * the behaviour of the `encodeurl` package: an unmatched surrogate is replaced
 * with U+FFFD (encoded as `%EF%BF%BD`) rather than making `encodeURI` throw.
 */
export function encodeUrl(url: string): string {
  return String(url)
    .replace(UNMATCHED_SURROGATE, "$1\uFFFD$2")
    .replace(ENCODE_CHARS, (match) => encodeURI(match));
}

/* ------------------------------------------------------------------ *
 * Date formatting (date-fns replacement)
 * ------------------------------------------------------------------ */

/**
 * Whether `value` is a `Date` holding a real instant — `false` for an
 * `Invalid Date` and for anything that is not a `Date` at all (a date string
 * included).
 *
 * Called with something not already typed `Date`, it is a type guard. Called
 * with a `Date` it answers a plain `boolean`: a guard there would narrow the
 * `false` branch to `never`, although an invalid `Date` is still a `Date`.
 */
export function isDateValid(date: Date): boolean;
export function isDateValid(value: unknown): value is Date;
export function isDateValid(value: unknown): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
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
export function etag(
  entity: string | Buffer | ArrayBufferView | ArrayBufferLike,
): string {
  const buf =
    typeof entity === "string"
      ? Buffer.from(entity, "utf8")
      : Buffer.isBuffer(entity)
        ? entity
        : isAnyArrayBuffer(entity)
          ? Buffer.from(entity as ArrayBuffer)
          : Buffer.from(
              (entity as ArrayBufferView).buffer as ArrayBuffer,
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
  /**
   * The `SameSite` attribute. `true` means `Strict`; `false` omits the
   * attribute, as the `cookie` package does. Left unset, Bun's default
   * `SameSite=Lax` is emitted.
   */
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
 * `sameSite: false` omits `SameSite` entirely, matching the `cookie` package —
 * `Bun.Cookie` cannot express that, so its trailing default is stripped.
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

  if (opts.sameSite === false) {
    // Bun always writes SameSite, and always as the last attribute; names,
    // values and paths cannot contain `;`, so the anchored match is exact.
    serialized = serialized.replace(/; SameSite=Lax$/, "");
  }

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

/**
 * Parses any `j:`-prefixed JSON cookie values in place and returns the same
 * object, exactly as cookie-parser's `JSONCookies` does. A value that is not
 * valid JSON is left raw — and so, as in cookie-parser, is one that parses to
 * a falsy value (`j:null`, `j:false`, `j:0`, `j:""`).
 */
export function jsonCookies<T extends Record<string, string>>(
  cookies: T,
): JsonCookies<T> {
  const result: Record<string, JsonValue> = cookies;
  for (const key of Object.keys(result)) {
    const value = result[key];
    if (typeof value !== "string" || !value.startsWith("j:")) {
      continue;
    }

    let parsed: JsonValue;
    try {
      parsed = JSON.parse(value.slice(2));
    } catch {
      continue;
    }

    if (parsed) {
      result[key] = parsed;
    }
  }
  return result as JsonCookies<T>;
}

/** {@link jsonCookies}' result: each cookie is its raw string or, for a `j:` value, the parsed JSON. */
export type JsonCookies<T extends Record<string, string>> = {
  [K in keyof T]: T[K] | JsonValue;
};

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

/** Options for {@link waitUntil}. */
export interface WaitUntilOptions {
  /** Milliseconds between evaluations. Defaults to `5`. */
  interval?: number;
  /** Milliseconds before rejecting with `waitUntil timed out`. `0` (the default) waits forever. */
  timeout?: number;
}

/** A promise together with the functions that settle it. */
export interface Deferred<T> {
  /** The promise `resolve`/`reject` settle. */
  promise: Promise<T>;
  /** Fulfils `promise` with a value (or adopts another promise's outcome). */
  resolve: (value: T | PromiseLike<T>) => void;
  /** Rejects `promise`. The reason is `unknown`, as any value may be thrown. */
  reject: (reason?: unknown) => void;
}

/**
 * Creates an externally-resolvable promise. `T` defaults to `void`, for a
 * deferred that only signals completion (`resolve()` with no argument).
 */
export function createDeferred<T = void>(): Deferred<T> {
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
 * with that value. Replaces the `until-promise` package. A type-guard
 * `predicate` narrows the resolved value.
 */
export async function waitUntil<T, U extends T>(
  getValue: () => T | Promise<T>,
  predicate: (value: T) => value is U,
  options?: WaitUntilOptions,
): Promise<U>;
export async function waitUntil<T>(
  getValue: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  options?: WaitUntilOptions,
): Promise<T>;
export async function waitUntil<T>(
  getValue: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  options?: WaitUntilOptions,
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

/** Options for {@link sleep}. */
export interface SleepOptions {
  /**
   * Cuts the wait short. The promise always rejects with an `Error`: the
   * signal's `reason` itself when that is an `Error` (a plain `abort()` gives
   * a `DOMException` named `"AbortError"`; `AbortSignal.timeout()` one named
   * `"TimeoutError"`), otherwise a new `Error` named `"AbortError"` whose
   * `cause` is the reason — so `abort("because")` rejects with an error that
   * {@link isAbortError} recognises and whose `cause` is `"because"`. This is
   * how Node's `timers/promises` treats a non-`Error` reason too.
   */
  signal?: AbortSignal;
  /**
   * When `true` the timer does not keep the process alive (`timer.unref()`).
   * Defaults to `false`.
   */
  unref?: boolean;
}

/**
 * Builds the error an aborted wait rejects with: the signal's own `reason`
 * when it is an `Error` (a `DOMException` in the standard case), else an
 * `Error` named `"AbortError"` carrying the reason as its `cause`, so a
 * rejection is always an `Error` and a non-`Error` reason is not lost.
 */
function toAbortError(reason: unknown, message: string): Error {
  if (reason instanceof Error) {
    return reason;
  }

  const error = new Error(
    message,
    reason === undefined ? undefined : { cause: reason },
  );
  error.name = "AbortError";
  return error;
}

/**
 * Promise-based `setTimeout`. Prefer it over hand-rolled timers so aborts and
 * `unref` behave consistently.
 */
export function sleep(ms: number, options?: SleepOptions): Promise<void> {
  const signal = options?.signal;

  if (signal?.aborted) {
    return Promise.reject(toAbortError(signal.reason, "The wait was aborted"));
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms),
    );

    if (options?.unref) {
      timer.unref?.();
    }

    function onAbort() {
      clearTimeout(timer);
      reject(toAbortError(signal?.reason, "The wait was aborted"));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * True when `error` is an abort — either a `DOMException`/`Error` named
 * `"AbortError"` or one carrying the `ABORT_ERR` code. Use it to tell "the
 * caller cancelled" apart from a genuine failure.
 */
export function isAbortError(error: unknown): boolean {
  if (!isObject(error)) {
    return false;
  }

  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === "AbortError" || code === "ABORT_ERR" || code === 20;
}

/** Raised by {@link withTimeout} when the work outlives its budget. */
export class TimeoutError extends Error {
  /** The budget that elapsed, in milliseconds. */
  readonly ms: number;

  constructor(ms: number, message?: string) {
    super(message ?? `Timed out after ${ms}ms`);
    this.name = "TimeoutError";
    this.ms = ms;
  }
}

/** Options for {@link withTimeout}. */
export interface WithTimeoutOptions {
  /** Message for the raised {@link TimeoutError}. Defaults to `Timed out after <ms>ms`. */
  message?: string;
  /**
   * Called once when the budget elapses, before the returned promise rejects.
   * The place to abort an `AbortController` driving the work.
   */
  onTimeout?: () => void;
  /**
   * When `true` the timeout timer does not keep the process alive. Defaults
   * to `true`, since a pending timeout is never itself a reason to stay up.
   */
  unref?: boolean;
}

/**
 * Rejects with a {@link TimeoutError} when `work` has not settled within `ms`.
 *
 * `ms <= 0` means "no timeout" and simply awaits the work. The original
 * promise keeps a terminal handler either way, so a rejection arriving *after*
 * the timeout can never surface as an `unhandledRejection`.
 *
 * Always returns a promise: a `work` function that throws synchronously
 * produces a rejected promise, never an exception out of `withTimeout`.
 */
export function withTimeout<T>(
  work: Promise<T> | (() => Promise<T> | T),
  ms: number,
  options?: WithTimeoutOptions,
): Promise<T> {
  let promise: Promise<T>;
  try {
    promise = Promise.resolve(isFunction(work) ? work() : work);
  } catch (error) {
    return Promise.reject(error);
  }

  if (!(ms > 0)) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      options?.onTimeout?.();
      reject(new TimeoutError(ms, options?.message));
    }, ms);

    if (options?.unref !== false) {
      timer.unref?.();
    }

    promise.then(
      (value) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(value);
        }
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(error);
        }
        // Otherwise the timeout already rejected and this handler is the
        // terminal one that keeps the late rejection from going unhandled.
      },
    );
  });
}

/**
 * How a backoff grows from one attempt to the next, for `n` failed attempts:
 *
 * - `"fixed"` — `delay`, every time.
 * - `"exponential"` — `delay × factorⁿ⁻¹`.
 * - `"linear"` — `delay × n`.
 * - `"fibonacci"` — `delay × fib(n)`: 1, 1, 2, 3, 5, 8… Gentler than
 *   exponential, for a dependency that usually recovers in a few tries.
 * - `"full-jitter"` — anywhere from zero up to the exponential delay. Spreads
 *   a crowd of clients that failed together the most evenly, at the cost of
 *   sometimes retrying almost at once.
 * - `"decorrelated-jitter"` — each delay drawn between `delay` and three times
 *   the last. Never shorter than `delay`, and unlike full jitter it grows.
 *
 * The two jittered strategies are random by construction, so `jitter` does
 * not apply to them; `max` does, to all six.
 */
export type BackoffType =
  | "fixed"
  | "exponential"
  | "linear"
  | "fibonacci"
  | "full-jitter"
  | "decorrelated-jitter";

/** Shape of a backoff schedule, shared by {@link computeBackoff} and {@link retry}. */
export interface BackoffOptions {
  /** How the delay grows; see {@link BackoffType}. Defaults to `"fixed"`. */
  type?: BackoffType;
  /** Base delay in milliseconds. Defaults to `1000`. */
  delay?: number;
  /** Growth factor for `"exponential"` and `"full-jitter"`. Defaults to `2`. */
  factor?: number;
  /** Upper bound on the delay before jitter, in milliseconds. Defaults to `Infinity`. */
  max?: number;
  /**
   * Randomises the delay by ±fraction to avoid a thundering herd. `true` means
   * `0.1` (±10%); a number is the fraction itself. Defaults to `0` (none).
   */
  jitter?: number | boolean;
}

/**
 * Delay before attempt `attempt + 1`, given that `attempt` (1-based) just
 * failed. A plain number is shorthand for `{ type: "fixed", delay }`.
 *
 * The cap applies to the computed delay; jitter is then applied on top, so a
 * jittered value may sit slightly above `max` (never below zero).
 */
export function computeBackoff(
  attempt: number,
  options?: BackoffOptions | number,
): number {
  const resolved: BackoffOptions = isNumber(options)
    ? { type: "fixed", delay: options }
    : (options ?? {});

  const base = resolved.delay ?? 1000;
  const factor = resolved.factor ?? 2;
  const max = resolved.max ?? Number.POSITIVE_INFINITY;
  const step = Math.max(1, Math.floor(attempt));

  switch (resolved.type) {
    case "full-jitter":
      return Math.random() * Math.min(base * factor ** (step - 1), max);
    case "decorrelated-jitter":
      return decorrelatedJitter(step, base, max);
  }

  const raw =
    resolved.type === "exponential"
      ? base * factor ** (step - 1)
      : resolved.type === "linear"
        ? base * step
        : resolved.type === "fibonacci"
          ? base * fibonacci(step)
          : base;
  const capped = Math.min(raw, max);

  const jitter =
    resolved.jitter === true
      ? 0.1
      : isNumber(resolved.jitter)
        ? resolved.jitter
        : 0;

  if (!jitter) {
    return Math.max(0, capped);
  }

  const spread = capped * jitter;
  return Math.max(0, capped + (Math.random() * 2 - 1) * spread);
}

/**
 * The `n`th Fibonacci number, counting 1, 1, 2, 3, 5 from `n = 1`.
 *
 * Iterative, and it overflows to `Infinity` rather than looping forever,
 * which the caller's `max` then caps.
 */
function fibonacci(n: number): number {
  let previous = 0;
  let current = 1;

  for (let at = 1; at < n && Number.isFinite(current); at++) {
    [previous, current] = [current, previous + current];
  }

  return current;
}

/**
 * Decorrelated jitter, without the state it is usually described with.
 *
 * The published form keeps the last delay between calls — `sleep = min(cap,
 * random(base, sleep × 3))` — and a job's attempts happen in different
 * processes, often on different machines, with nothing to keep it in. Walking
 * the recurrence from the first attempt draws from the same distribution
 * using only the attempt number. Attempts are few, so the walk is short; it is
 * bounded anyway, since past the cap every further step is the cap.
 */
function decorrelatedJitter(step: number, base: number, max: number): number {
  let delay = base;

  for (let at = 0; at < Math.min(step, 64) && delay < max; at++) {
    delay = Math.min(max, base + Math.random() * (delay * 3 - base));
  }

  return Math.max(0, Math.min(delay, max));
}

/** Options for {@link retry}. */
export interface RetryOptions {
  /** Total attempts, including the first. Defaults to `3`. */
  attempts?: number;
  /** Delay schedule between attempts. Defaults to `{ type: "fixed", delay: 1000 }`. */
  backoff?: BackoffOptions | number;
  /** Decides whether a given failure is worth another attempt. Defaults to always. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before each wait, with the error that caused it. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /**
   * Aborts between attempts and is forwarded to `fn`. An abort rejects with
   * the same error {@link sleep} does: the signal's `reason` when it is an
   * `Error`, otherwise an `Error` named `"AbortError"` with the reason as its
   * `cause`. It does not interrupt an attempt already running — `fn` must
   * watch the signal for that.
   */
  signal?: AbortSignal;
  /**
   * When `true` the waits between attempts do not keep the process alive
   * (`timer.unref()`), so a process with nothing else pending may exit before
   * the next attempt. Defaults to `false`, as {@link SleepOptions.unref} does.
   */
  unref?: boolean;
}

/**
 * Runs `fn` until it succeeds or the attempts run out, waiting
 * {@link computeBackoff} between tries. Re-throws the last error.
 */
export async function retry<T>(
  fn: (attempt: number, signal?: AbortSignal) => Promise<T> | T,
  options?: RetryOptions,
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options?.attempts ?? 3));
  const signal = options?.signal;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) {
      throw toAbortError(signal.reason, "The retry was aborted");
    }

    try {
      return await fn(attempt, signal);
    } catch (error) {
      lastError = error;

      const isLast = attempt >= attempts;
      const retryable = options?.shouldRetry?.(error, attempt) ?? true;
      if (isLast || !retryable) {
        break;
      }

      const delay = computeBackoff(attempt, options?.backoff);
      options?.onRetry?.(error, attempt, delay);
      await sleep(delay, { signal, unref: options?.unref ?? false });
    }
  }

  throw lastError;
}

/**
 * A non-reentrant in-process lock. Bun has no `Mutex`, and serialising
 * read-modify-write sequences (a JSON state file, a SQLite transaction) needs
 * one. Waiters are served FIFO.
 */
export class Mutex {
  /** Resolvers of the queued `acquire()` calls, in arrival order. */
  readonly #queue: (() => void)[] = [];
  /** Whether the lock is currently held. */
  #locked = false;

  /** Whether the lock is currently held. */
  get locked(): boolean {
    return this.#locked;
  }

  /** How many callers are waiting for the lock. */
  get waiting(): number {
    return this.#queue.length;
  }

  /**
   * Waits for the lock and resolves with its release function. Calling the
   * release function more than once is a no-op.
   */
  acquire(): Promise<() => void> {
    if (!this.#locked) {
      this.#locked = true;
      return Promise.resolve(this.#createRelease());
    }

    return new Promise<() => void>((resolve) => {
      this.#queue.push(() => resolve(this.#createRelease()));
    });
  }

  /** Runs `fn` while holding the lock, releasing it however `fn` settles. */
  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Builds a single-use release function for the current holder. */
  #createRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;

      const next = this.#queue.shift();
      if (next) {
        // Hand the lock straight to the next waiter — never unlocked in
        // between, so ordering cannot be jumped by a fresh caller.
        next();
      } else {
        this.#locked = false;
      }
    };
  }
}

/**
 * Counting semaphore, for bounding concurrency (in-flight jobs, open file
 * handles). Waiters are served FIFO.
 */
export class Semaphore {
  /** Resolvers of the queued `acquire()` calls, in arrival order. */
  readonly #queue: (() => void)[] = [];
  /**
   * Permits currently held. Can briefly exceed {@link permits} after the
   * limit is lowered, until enough holders release.
   */
  #held = 0;
  /** Total permits, adjustable via {@link setPermits}. */
  #permits: number;

  constructor(
    /** How many holders may run concurrently. Must be at least `1`. */
    permits: number,
  ) {
    this.#permits = Math.max(1, Math.floor(permits));
  }

  /** Permits currently free. Never below `0`, even after lowering the limit. */
  get available(): number {
    return Math.max(0, this.#permits - this.#held);
  }

  /** How many callers are waiting for a permit. */
  get waiting(): number {
    return this.#queue.length;
  }

  /** Total permits. */
  get permits(): number {
    return this.#permits;
  }

  /**
   * Waits for a permit and resolves with its release function. Calling the
   * release function more than once is a no-op.
   */
  acquire(): Promise<() => void> {
    const immediate = this.tryAcquire();
    if (immediate) {
      return Promise.resolve(immediate);
    }

    return new Promise<() => void>((resolve) => {
      this.#queue.push(() => resolve(this.#createRelease()));
    });
  }

  /** Takes a permit if one is free, else returns `null` without waiting. */
  tryAcquire(): (() => void) | null {
    if (this.#held >= this.#permits) {
      return null;
    }

    this.#held++;
    return this.#createRelease();
  }

  /** Runs `fn` holding a permit, releasing it however `fn` settles. */
  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Changes the permit count at runtime. Raising it wakes waiters
   * immediately; lowering it never revokes a permit already held, so the
   * limit takes effect as holders release: no waiter is admitted until the
   * number of holders has fallen below the new limit.
   */
  setPermits(permits: number): void {
    this.#permits = Math.max(1, Math.floor(permits));
    this.#drain();
  }

  /** Admits queued waiters, FIFO, while the holder count is under the limit. */
  #drain(): void {
    while (this.#held < this.#permits && this.#queue.length > 0) {
      this.#held++;
      this.#queue.shift()?.();
    }
  }

  /** Builds a single-use release function for one permit. */
  #createRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;

      this.#held--;
      // Waiters are admitted before this returns, so a fresh `tryAcquire`
      // can never jump the queue.
      this.#drain();
    };
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

/** A leaf of a parsed XML document: text, or a coerced number/boolean. */
export type XmlPrimitive = string | number | boolean;

/**
 * A parsed element carrying attributes or children: attribute keys (under
 * `attributeNamePrefix`), child element names, and `textNodeName` for its text.
 */
export interface XmlElement<L extends XmlPrimitive = XmlPrimitive> {
  /** An attribute, a child element (an array when repeated) or the element's text. */
  [key: string]: XmlNode<L>;
}

/** Any value in a parsed XML document: a leaf, an element, or repeated siblings. */
export type XmlNode<L extends XmlPrimitive = XmlPrimitive> =
  | L
  | XmlElement<L>
  | (L | XmlElement<L>)[];

/** What {@link parseXmlToObject} returns: the root element's value under its name. */
export type XmlDocument<L extends XmlPrimitive = XmlPrimitive> = Record<
  string,
  L | XmlElement<L>
>;

export interface ParseXmlOptions {
  /** Prefix used for attribute keys. Defaults to `"@_"`. */
  attributeNamePrefix?: string;
  /**
   * Key holding an element's text when it also carries attributes or child
   * elements. Defaults to `"#text"`.
   */
  textNodeName?: string;
  /**
   * When `true`, attributes are dropped entirely. Defaults to `false`
   * (attributes are kept under `attributeNamePrefix`).
   */
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
 * entities are left untouched, and so is a numeric reference past U+10FFFF,
 * which names no code point.
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
      return Number.isNaN(codePoint) || codePoint > 0x10ffff
        ? match
        : String.fromCodePoint(codePoint);
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
  parsePrimitives: false,
): string;
export function coerceXmlPrimitive(
  text: string,
  parsePrimitives: boolean,
): XmlPrimitive;
export function coerceXmlPrimitive(
  text: string,
  parsePrimitives: boolean,
): XmlPrimitive {
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
 *
 * With `parsePrimitives: false` every leaf is a string; otherwise a leaf may
 * also be a `number` or `boolean`.
 */
export function parseXmlToObject(
  xml: string,
  options: ParseXmlOptions & { parsePrimitives: false },
): XmlDocument<string>;
export function parseXmlToObject(
  xml: string,
  options?: ParseXmlOptions,
): XmlDocument;
export function parseXmlToObject(
  xml: string,
  options?: ParseXmlOptions,
): XmlDocument {
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

  const value = (text: string): XmlPrimitive =>
    coerceXmlPrimitive(text, parsePrimitives);

  // Parses one element (cursor positioned just after its opening `<`) and
  // returns its value; leaves the element's name in `lastName`.
  function parseElement(): XmlPrimitive | XmlElement {
    const nameStart = i;
    while (i < len) {
      const c = xml.charCodeAt(i);
      if (isXmlWhitespace(c) || c === 47 /* / */ || c === 62 /* > */) {
        break;
      }
      i++;
    }
    const name = xml.slice(nameStart, i);
    let obj: XmlElement | null = null;

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

/* ------------------------------------------------------------------ *
 * Errors & structured cloning
 *
 * Errors do not survive `JSON.stringify` (an `Error` serialises to `{}`) and
 * do not survive a process/worker boundary, so anything that reports a
 * failure across one has to flatten it first. These helpers do that
 * losslessly enough to rebuild a real `Error` on the far side.
 * ------------------------------------------------------------------ */

/**
 * A plain-object form of an `Error`, safe to `JSON.stringify`. `TData` is the
 * shape of `data`, the error's extra properties.
 */
export interface SerializedError<
  TData extends object = Record<string, JsonValue>,
> {
  /** The error's `name` (`"Error"`, `"TypeError"`, a custom class name, ...). */
  name: string;
  /** The error's `message`. */
  message: string;
  /** The stack trace, truncated to `maxStackBytes`. */
  stack?: string;
  /** A `code` property when the error carried one (`"ENOENT"`, `"LOCK_LOST"`, ...). */
  code?: string | number;
  /** The serialised `cause`, up to `maxDepth` levels deep. */
  cause?: SerializedError;
  /** Remaining own enumerable properties, JSON-cloned. */
  data?: TData;
}

/**
 * What {@link deserializeError} rebuilds: an `Error` with the restored `code`
 * and `cause`, plus `TData`'s properties when the input's `data` declared a
 * shape (they are optional, as `data` itself is). `data` keys named `name`,
 * `message`, `stack`, `code` or `cause` are left out: those fields only ever
 * come from the serialised error's top level, so `data` cannot retype them.
 */
export type DeserializedError<TData extends object = Record<never, never>> =
  Error & {
    /** The restored `code`, when the original carried one. */
    code?: string | number;
    /** The restored `cause`, itself rebuilt. */
    cause?: DeserializedError;
  } & (string extends keyof TData
      ? unknown
      : TData extends unknown
        ? Partial<Omit<TData, "name" | "message" | "stack" | "code" | "cause">>
        : never);

/** Options for {@link serializeError}. */
export interface SerializeErrorOptions {
  /** How many `cause` levels to follow. Defaults to `5`. */
  maxDepth?: number;
  /**
   * Cap on the retained stack, in UTF-8 bytes. A longer stack is cut on a
   * character boundary (so it may keep slightly fewer bytes than the cap) and
   * `\n… (stack truncated)` is appended beyond it. Defaults to `8192`.
   */
  maxStackBytes?: number;
}

/** Properties handled explicitly, so they never land in `data`. */
const SERIALIZED_ERROR_KEYS = new Set([
  "name",
  "message",
  "stack",
  "code",
  "cause",
]);

/**
 * Flattens any thrown value into a {@link SerializedError}.
 *
 * A non-`Error` (a string, an object, `undefined`) becomes
 * `{ name: "NonError", message: String(value) }` rather than being dropped —
 * throwing a non-error is a bug worth seeing, not worth losing. Own
 * enumerable properties beyond the standard ones are kept under `data`, with
 * anything unserialisable omitted.
 */
export function serializeError(
  error: unknown,
  options?: SerializeErrorOptions,
): SerializedError {
  const maxDepth = options?.maxDepth ?? 5;
  const maxStackBytes = options?.maxStackBytes ?? 8192;

  if (!isError(error)) {
    return {
      name: "NonError",
      message: typeof error === "string" ? error : safeStringify(error),
    };
  }

  const source = error as Error & {
    code?: string | number;
    cause?: unknown;
  };

  const serialized: SerializedError = {
    name: source.name || "Error",
    message: source.message || "",
  };

  if (source.stack) {
    serialized.stack = truncateUtf8(source.stack, maxStackBytes);
  }

  if (isString(source.code) || isNumber(source.code)) {
    serialized.code = source.code;
  }

  if (source.cause !== undefined && maxDepth > 0) {
    serialized.cause = serializeError(source.cause, {
      maxDepth: maxDepth - 1,
      maxStackBytes,
    });
  }

  const data: Record<string, JsonValue> = {};
  let hasData = false;
  for (const key of Object.keys(source)) {
    if (SERIALIZED_ERROR_KEYS.has(key)) {
      continue;
    }

    const value = (source as unknown as Record<string, unknown>)[key];
    const cloned = tryJsonClone(value);
    if (cloned !== undefined) {
      data[key] = cloned;
      hasData = true;
    }
  }

  if (hasData) {
    serialized.data = data;
  }

  return serialized;
}

/**
 * Rebuilds an `Error` from {@link serializeError}'s output, restoring `name`,
 * `stack`, `code`, `cause` and any `data` properties. The result is a real
 * `Error` instance whose `name` is the original one — not the original class,
 * which cannot cross a process boundary.
 *
 * `name`, `message`, `stack`, `code` and `cause` come only from the input's
 * top-level fields. A `data` key with one of those names — which
 * `serializeError` never emits, but hand-built or foreign input may carry — is
 * dropped rather than allowed to overwrite the real field. Every other `data`
 * key becomes an own enumerable property, defined rather than assigned, so a
 * key such as `__proto__` from parsed JSON stays a plain property instead of
 * replacing the error's prototype.
 */
export function deserializeError<TData extends object>(
  input: SerializedError<TData>,
): DeserializedError<TData> {
  const error = new Error(input.message) as DeserializedError;

  error.name = input.name;

  if (input.stack) {
    error.stack = input.stack;
  }

  if (input.code !== undefined) {
    error.code = input.code;
  }

  if (input.cause) {
    error.cause = deserializeError(input.cause);
  }

  if (input.data) {
    for (const [key, value] of Object.entries(input.data)) {
      if (SERIALIZED_ERROR_KEYS.has(key)) {
        continue;
      }

      Object.defineProperty(error, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  return error as DeserializedError<TData>;
}

/**
 * Round-trips `value` through JSON, giving the exact object a JSON driver,
 * an IPC channel or a database column would hand back.
 *
 * Lossy by design, and deliberately so — the loss is what crosses the wire:
 * `undefined` properties are dropped, a `Date` becomes an ISO string, a
 * `Map`/`Set`/class instance becomes a plain object, and a `BigInt` or a
 * cycle throws `TypeError`. Use it at a boundary so the value a handler sees
 * locally matches what it would see remotely.
 *
 * The return type, {@link Jsonify}, says what came back rather than what went
 * in: a `Date` property is a `string`, a function property is gone.
 *
 * `TResult` exists for one reason: code written against the earlier
 * `jsonClone<T>(value: T): T` — typically a generic `(value: T): T` wrapper,
 * where a deferred `Jsonify<T>` can never be assigned to `T` — may still
 * claim the input type, through an explicit type argument or a contextual
 * return type. It may claim nothing else: without such a context the result
 * is `Jsonify<T>`.
 */
export function jsonClone<T, TResult extends Jsonify<T> | T = Jsonify<T>>(
  value: T,
): TResult {
  const json = JSON.stringify(value);
  if (json === undefined) {
    return undefined as TResult;
  }
  return JSON.parse(json) as TResult;
}

/**
 * {@link jsonClone} that yields `undefined` instead of throwing. The input is
 * any value; the output is what JSON made of it.
 */
function tryJsonClone(value: unknown): JsonValue | undefined {
  try {
    return jsonClone(value) as JsonValue | undefined;
  } catch {
    return undefined;
  }
}

/**
 * `text` unchanged when it fits in `maxBytes` UTF-8 bytes; otherwise its
 * longest prefix that does, cut on a character boundary, plus a marker.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  // Each UTF-16 unit is at most 3 UTF-8 bytes: skip the encode when it fits.
  if (text.length * 3 <= maxBytes) {
    return text;
  }

  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }

  let end = Math.max(0, Math.floor(maxBytes));
  // Back off any continuation bytes (10xxxxxx) so no character is split.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }

  return `${bytes.subarray(0, end).toString("utf8")}\n… (stack truncated)`;
}

/** `String(value)` that survives a throwing `toString`/getter. */
function safeStringify(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/* ------------------------------------------------------------------ *
 * Request-body decompression (Content-Encoding)
 *
 * Each encoding uses the fastest decoder that behaves exactly like
 * body-parser's `zlib.createGunzip`/`createInflate`/`createBrotliDecompress`,
 * measured on Bun 1.4.3:
 *
 * - `gzip`: `Bun.gunzipSync` (libdeflate), 1.6-2.2x node:zlib. It decodes only
 *   the first gzip member and ignores what follows, so its result is kept only
 *   when that member provably spans the whole body; anything else is decoded
 *   again by node:zlib, which handles multi-member bodies and rejects junk.
 * - `deflate`: `Bun.inflateSync` with `windowBits: 15` (zlib-wrapped, as HTTP
 *   `deflate` is), up to 1.6x node:zlib and never meaningfully slower.
 * - `br`: node:zlib `brotliDecompressSync`. Bun has no brotli API of its own,
 *   and `DecompressionStream("brotli")` is slower.
 *
 * Neither Bun API can cap its output, so they run only while the format's
 * worst-case expansion (`compressed length × 1032`) fits `fastPathLimit`, and
 * their output is held to `maxOutputLength` afterwards. A larger body goes to
 * node:zlib with `maxOutputLength`, which stops as soon as it overflows.
 *
 * Beyond body-parser, which decodes exactly one of those three:
 *
 * - `zstd` (RFC 8878 frames; the content coding of RFC 9659). The frames are
 *   walked before anything is decoded ({@link scanZstdFrames}). Block headers
 *   carry every block's size, so a truncated frame, trailing junk, a reserved
 *   bit, a Dictionary_ID or a window over RFC 9659's 8 MiB is refused up front
 *   — which matters, because node:zlib's `zstdDecompressSync` returns empty or
 *   partial output for truncated input instead of throwing. The walk also
 *   bounds each frame's output: its declared Frame_Content_Size, or else its
 *   Raw/RLE block sizes plus Block_Maximum_Size (at most 128 KiB) per
 *   Compressed block. zstd has no fixed expansion ratio (a 4-byte RLE block
 *   decodes to 128 KiB), so that bound stands in for DEFLATE's `× 1032`: a
 *   body whose declared floor already passes `maxOutputLength` is refused
 *   without decoding; one whose bound fits `fastPathLimit` is decoded frame by
 *   frame by `Bun.zstdDecompressSync`; anything else by node:zlib, capped at
 *   what is left of `maxOutputLength`. Either way every frame's output must
 *   fit its bound and match its declared size. (`DecompressionStream("zstd")`
 *   could stop at a limit too, but only asynchronously.)
 * - Stacked codings (RFC 9110 §8.4): `Content-Encoding: gzip, br` lists them
 *   in the order they were applied, so they are decoded last to first, each
 *   layer's output held to `maxOutputLength`. At most `maxCodings` may be
 *   stacked (default 5, the limit undici's fetch and curl apply).
 * - `dcb`/`dcz`, Dictionary-Compressed Brotli and Zstandard (RFC 9842): a
 *   fixed header (magic number, then the dictionary's SHA-256) before a
 *   stream compressed against that dictionary as a raw prefix. Decoded by
 *   node:zlib with its `dictionary` option — which Bun forwards to libbrotli
 *   and libzstd, verified once at runtime ({@link dictionaryDecodingSupported})
 *   — and only when the caller supplies `dictionaries`.
 * ------------------------------------------------------------------ */

/**
 * The `Content-Encoding` codings {@link decompressBody} decodes: `gzip` (and
 * its alias `x-gzip`), zlib-wrapped `deflate`, `br`, `zstd`, and — given
 * `dictionaries` — `dcb` and `dcz`. `identity` is the absence of a coding.
 */
export type SupportedContentEncoding =
  | "identity"
  | "gzip"
  | "x-gzip"
  | "deflate"
  | "br"
  | "zstd"
  | "dcb"
  | "dcz";

/**
 * The dictionary-compressed codings of RFC 9842: `dcb` (Dictionary-Compressed
 * Brotli, §4) and `dcz` (Dictionary-Compressed Zstandard, §5).
 */
export type DictionaryContentEncoding = "dcb" | "dcz";

/**
 * Which codings a body may use: `"*"` for every
 * {@link SupportedContentEncoding}, or a list admitting only its members —
 * unless it holds a `"*"` as well. Typed so a misspelt coding is a compile
 * error. (A `*` *sent* in `Content-Encoding` is never a wildcard: RFC 9110
 * defines `*` for `Accept-Encoding` only, so it is an unknown coding.)
 */
export type ContentEncodingAllowlist =
  | "*"
  | readonly (SupportedContentEncoding | "*")[];

/**
 * Finds the dictionary a `dcb`/`dcz` body was compressed with, from the
 * SHA-256 its header carries (a 32-byte copy — `hash.toString("hex")` or
 * `"base64"` makes a map key). Answers the dictionary's bytes, or `undefined`
 * when it has none. Called synchronously, once per body; what it answers is
 * hashed and must match.
 */
export type CompressionDictionaryResolver = (
  hash: Buffer,
  encoding: DictionaryContentEncoding,
) => Uint8Array | undefined;

/**
 * The dictionaries `dcb`/`dcz` bodies may name: the dictionaries themselves,
 * or a {@link CompressionDictionaryResolver}. An array is indexed by SHA-256
 * the first time it is used, so replace it rather than mutating it.
 */
export type CompressionDictionaries =
  | readonly Uint8Array[]
  | CompressionDictionaryResolver;

/** Options for {@link decompressBody}. */
export interface DecompressBodyOptions {
  /**
   * Largest decoded size accepted, in bytes; a body that would inflate past it
   * throws {@link DecompressionLimitError} without being fully inflated (the
   * decompression-bomb guard, body-parser's `limit` applied after inflation).
   * With stacked codings every layer's output is held to it, not only the
   * last. `identity` bodies are held to it too. Default: unbounded
   * (`undefined` or `Infinity`), which still stops at `buffer.kMaxLength`. On
   * the fast path (see `fastPathLimit`) it is checked once Bun has decoded the
   * layer — for `zstd`, each frame.
   */
  maxOutputLength?: number | undefined;
  /**
   * The most memory, in bytes, a single uncapped Bun decode may use in the
   * worst case. `gzip`/`deflate` layers whose `length × 1032` (DEFLATE's
   * maximum expansion) fits take Bun's faster decoder whatever
   * `maxOutputLength` is; larger ones take node:zlib, capped at
   * `maxOutputLength`. A `zstd` layer's worst case is the size its frames
   * declare, or else what their blocks can hold (128 KiB per compressed
   * block). `0` disables the fast path, `Infinity` always takes it (speed over
   * bomb safety). `br`, `dcb` and `dcz` never take it. Applied per layer.
   * Default: {@link DEFAULT_DECOMPRESS_FAST_PATH_LIMIT} (32 MiB).
   */
  fastPathLimit?: number | undefined;
  /**
   * The codings a body may use (see {@link ContentEncodingAllowlist}); a body
   * listing another, in any layer, makes {@link decompressBody} answer
   * `undefined`. `identity` is always admitted, and `"gzip"` admits `x-gzip`.
   * Default `"*"`. An entry that is not a {@link SupportedContentEncoding}
   * throws `RangeError`.
   */
  encodings?: ContentEncodingAllowlist | undefined;
  /**
   * The most codings one `Content-Encoding` may stack — `identity` and empty
   * list elements not counted. More throws {@link ContentCodingLimitError}
   * before anything is decoded, so a many-layered bomb costs nothing. `0`
   * admits only `identity`. Default {@link DEFAULT_MAX_CONTENT_CODINGS} (5); a
   * negative or `NaN` value throws `RangeError`.
   */
  maxCodings?: number | undefined;
  /**
   * Dictionaries for `dcb`/`dcz` bodies (see {@link CompressionDictionaries}).
   * Without it those codings are not decoded (`undefined`); with it, a body
   * whose header names a dictionary it lacks throws
   * {@link UnknownCompressionDictionaryError}. Default: none.
   */
  dictionaries?: CompressionDictionaries | undefined;
}

/**
 * Default {@link DecompressBodyOptions.fastPathLimit}: 32 MiB, which admits
 * compressed bodies up to 32,520 bytes to Bun's decoders.
 */
export const DEFAULT_DECOMPRESS_FAST_PATH_LIMIT = 32 * 1024 * 1024;

/**
 * Default {@link DecompressBodyOptions.maxCodings}: 5 — the limit undici's
 * `fetch` (`maxContentEncodings`) and curl (`MAX_ENCODE_STACK`, since the fix
 * for CVE-2022-32206) put on the codings one response may stack.
 */
export const DEFAULT_MAX_CONTENT_CODINGS: number = 5;

/**
 * Raised by {@link decompressBody} when the decoded body would exceed
 * `maxOutputLength` (map it to `413 Payload Too Large`). Deliberately not a
 * {@link DecompressionError}: the data may be perfectly valid. Its `cause` is
 * node:zlib's `ERR_BUFFER_TOO_LARGE` when node:zlib stopped at the cap, and
 * absent when the size was checked after decoding (the fast path, `identity`).
 */
export class DecompressionLimitError extends RangeError {
  /** Stable machine-readable code: `"ERR_DECOMPRESSION_LIMIT"`. */
  readonly code = "ERR_DECOMPRESSION_LIMIT";
  /** The cap that was exceeded, in bytes. */
  readonly limit: number;
  /** The normalised (trimmed, lower-cased) `Content-Encoding` being decoded. */
  readonly encoding: string;

  constructor(encoding: string, limit: number, options?: ErrorOptions) {
    super(
      `Decoded "${encoding}" body exceeds the ${limit}-byte limit`,
      options,
    );
    this.name = "DecompressionLimitError";
    this.encoding = encoding;
    this.limit = limit;
  }
}

/**
 * Raised by {@link decompressBody} when the body is not valid data for its
 * encoding — corrupt, truncated, trailing junk after a gzip member, or raw
 * DEFLATE sent as `deflate` (map it to `400 Bad Request`). The decoder's own
 * error is the `cause`.
 */
export class DecompressionError extends Error {
  /** Stable machine-readable code: `"ERR_DECOMPRESSION_FAILED"`. */
  readonly code = "ERR_DECOMPRESSION_FAILED";
  /** The normalised (trimmed, lower-cased) `Content-Encoding` being decoded. */
  readonly encoding: string;

  constructor(encoding: string, options?: ErrorOptions) {
    super(`Invalid "${encoding}" compressed body`, options);
    this.name = "DecompressionError";
    this.encoding = encoding;
  }
}

/**
 * Raised by {@link decompressBody} when `Content-Encoding` stacks more codings
 * than `maxCodings` (map it to `415 Unsupported Media Type`: a coding list the
 * server does not accept). Raised before anything is decoded.
 */
export class ContentCodingLimitError extends RangeError {
  /** Stable machine-readable code: `"ERR_CONTENT_CODING_LIMIT"`. */
  readonly code = "ERR_CONTENT_CODING_LIMIT";
  /** How many codings the header stacked, `identity` not counted. */
  readonly count: number;
  /** The most that are accepted (`maxCodings`). */
  readonly limit: number;

  constructor(count: number, limit: number) {
    super(
      `Content-Encoding stacks ${count} codings; at most ${limit} are accepted`,
    );
    this.name = "ContentCodingLimitError";
    this.count = count;
    this.limit = limit;
  }
}

/**
 * Raised by {@link decompressBody} when a `dcb`/`dcz` body names a dictionary
 * `dictionaries` does not hold. RFC 9842 defines these codings for responses
 * and prescribes no status for a request body; like any body that cannot be
 * decoded it is a {@link DecompressionError}, so map it to `400 Bad Request`.
 */
export class UnknownCompressionDictionaryError extends DecompressionError {
  /** The SHA-256 the body's header carries, as lower-case hex. */
  readonly dictionaryHash: string;

  constructor(encoding: DictionaryContentEncoding, hash: Uint8Array) {
    super(encoding);
    this.dictionaryHash = Buffer.from(hash).toString("hex");
    this.message = `No "${encoding}" dictionary has SHA-256 ${this.dictionaryHash}`;
    this.name = "UnknownCompressionDictionaryError";
  }
}

/**
 * The most bytes DEFLATE can emit per input byte (a 258-byte match coded in
 * 2 bits), so no gzip or zlib body inflates past `length * 1032`.
 */
const DEFLATE_MAX_EXPANSION = 1032;

/** A zero-copy `Buffer` view over `bytes`. */
function bufferView(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Validates `maxOutputLength`: `undefined` for unbounded, else whole bytes. */
function resolveOutputLimit(
  maxOutputLength: number | undefined,
): number | undefined {
  if (maxOutputLength === undefined || maxOutputLength === Infinity) {
    return undefined;
  }
  if (!(maxOutputLength >= 0)) {
    throw new RangeError(
      `maxOutputLength must be a non-negative number, got ${maxOutputLength}`,
    );
  }
  return Math.floor(maxOutputLength);
}

/** Validates `fastPathLimit`, defaulting to {@link DEFAULT_DECOMPRESS_FAST_PATH_LIMIT}. */
function resolveFastPathLimit(fastPathLimit: number | undefined): number {
  if (fastPathLimit === undefined) {
    return DEFAULT_DECOMPRESS_FAST_PATH_LIMIT;
  }
  if (!(fastPathLimit >= 0)) {
    throw new RangeError(
      `fastPathLimit must be a non-negative number, got ${fastPathLimit}`,
    );
  }
  return fastPathLimit;
}

/** Whether a Bun (uncappable) decoder's worst case fits `fastPathLimit`. */
function takesFastPath(body: Uint8Array, fastPathLimit: number): boolean {
  return (
    fastPathLimit > 0 && body.length * DEFLATE_MAX_EXPANSION <= fastPathLimit
  );
}

/** `decode()`'s output, or `undefined` if it threw (node:zlib then decides). */
function attemptDecode(decode: () => Uint8Array): Uint8Array | undefined {
  try {
    return decode();
  } catch {
    return undefined;
  }
}

/** A fast-path output as a `Buffer`, held to `limit` after the fact. */
function checkedFastPathOutput(
  output: Uint8Array,
  encoding: string,
  limit: number | undefined,
): Buffer {
  if (limit !== undefined && output.length > limit) {
    throw new DecompressionLimitError(encoding, limit);
  }
  return bufferView(output);
}

/**
 * Whether `output` is the whole of `body`, i.e. `body` was one gzip member.
 * Bun already checked that member's own trailer; its end must also be the
 * body's end. The trailer (CRC-32 and size of `output`) therefore has to be
 * the body's final 8 bytes, and must not occur earlier — an earlier copy is
 * where the decoded member really ended (`gzip(a) + gzip(a)`, or junk that
 * repeats the trailer). A chance earlier match only costs a node:zlib retry.
 */
function isWholeGzipMember(body: Buffer, output: Uint8Array): boolean {
  const end = body.length;
  if (end < 18) {
    return false;
  }
  return (
    body.readUInt32LE(end - 8) === Bun.hash.crc32(output) &&
    body.readUInt32LE(end - 4) === output.length >>> 0 &&
    body.indexOf(body.subarray(end - 8)) === end - 8
  );
}

/**
 * A node:zlib sync decoder or encoder, typed with only the options used here.
 * Bun forwards `dictionary` to its brotli and zstd codecs as well, though
 * `@types/node` declares it for zlib alone.
 */
type ZlibSyncCodec = (
  body: Buffer,
  options?: { maxOutputLength?: number; dictionary?: Uint8Array },
) => Buffer;

/**
 * Decodes with a node:zlib sync decoder, mapping its errors to ours. `cap` is
 * the most output node:zlib may produce; `reportedLimit` is the limit an
 * overflow names — they differ when the cap is what remains of the limit.
 */
function decodeWithZlib(
  decode: ZlibSyncCodec,
  body: Buffer,
  encoding: string,
  cap: number | undefined,
  reportedLimit: number | undefined = cap,
  dictionary?: Uint8Array,
): Buffer {
  const options: { maxOutputLength?: number; dictionary?: Uint8Array } = {};
  if (cap !== undefined) {
    // node:zlib rejects 0; a 1-byte cap plus the check below covers it.
    options.maxOutputLength = Math.min(Math.max(cap, 1), kMaxLength);
  }
  if (dictionary !== undefined) {
    options.dictionary = dictionary;
  }
  let output: Buffer;
  try {
    output = decode(body, options);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new DecompressionLimitError(encoding, reportedLimit ?? kMaxLength, {
        cause: error,
      });
    }
    throw new DecompressionError(encoding, { cause: error });
  }
  if (cap !== undefined && output.length > cap) {
    throw new DecompressionLimitError(encoding, reportedLimit ?? cap);
  }
  return output;
}

/** A {@link DecompressionError} whose `cause` says what is wrong with the data. */
function malformed(encoding: string, detail: string): DecompressionError {
  return new DecompressionError(encoding, { cause: new Error(detail) });
}

/* --- zstd frames (RFC 8878 §3.1) ------------------------------------ */

/** Magic_Number of a Zstandard frame, read little-endian (RFC 8878 §3.1.1). */
const ZSTD_FRAME_MAGIC = 0xfd2fb528;
/** Skippable frames' Magic_Number: 0x184D2A5?, any low nibble (§3.1.2). */
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;
/** The most a block may hold, compressed or decoded: 128 KiB (§3.1.1.2). */
const ZSTD_BLOCK_SIZE_MAX = 128 * 1024;
/** The largest Window_Size the `zstd` content coding allows (RFC 9659 §3). */
const ZSTD_CONTENT_CODING_MAX_WINDOW = 8 * 1024 * 1024;
/** The largest Window_Size a `dcz` body may use (RFC 9842 §5). */
const DCZ_MAX_WINDOW = 128 * 1024 * 1024;

/** What {@link scanZstdFrames} learnt about one frame, without decoding it. */
interface ZstdFrame {
  /** Offset of the frame's Magic_Number in the body. */
  start: number;
  /** Offset just past the frame, its Content_Checksum included. */
  end: number;
  /** Frame_Content_Size, when the header declares one. */
  contentSize: number | undefined;
  /** The fewest bytes the frame decodes to: its Raw and RLE blocks' sizes. */
  minOutput: number;
  /** The most: `minOutput` plus Block_Maximum_Size per Compressed block. */
  maxOutput: number;
}

/**
 * Walks the zstd frames of `body` from `start` without decoding them — each
 * frame's header and block headers — skipping skippable frames. Frames are
 * independent and their outputs concatenate (RFC 8878 §3.1), so a body is any
 * sequence of the two kinds, and nothing else.
 *
 * @throws {DecompressionError} for no frame at all, bytes that are not a
 * frame, a truncated frame, a Reserved_Bit or reserved Block_Type, a
 * Block_Size over 128 KiB, a Dictionary_ID (no dictionary can be named), a
 * Window_Size over `maxWindow`, or a Frame_Content_Size its blocks cannot
 * produce.
 */
function scanZstdFrames(
  body: Buffer,
  start: number,
  encoding: string,
  maxWindow: number,
): ZstdFrame[] {
  if (start >= body.length) {
    throw malformed(encoding, "no zstd frame");
  }
  const frames: ZstdFrame[] = [];
  let offset = start;
  while (offset < body.length) {
    if (body.length - offset < 4) {
      throw malformed(encoding, `truncated frame at byte ${offset}`);
    }
    const magic = body.readUInt32LE(offset);
    if ((magic & 0xfffffff0) === ZSTD_SKIPPABLE_MAGIC) {
      const end =
        body.length - offset < 8
          ? Infinity
          : offset + 8 + body.readUInt32LE(offset + 4);
      if (end > body.length) {
        throw malformed(
          encoding,
          `truncated skippable frame at byte ${offset}`,
        );
      }
      offset = end;
      continue;
    }
    if (magic !== ZSTD_FRAME_MAGIC) {
      throw malformed(encoding, `no zstd frame at byte ${offset}`);
    }
    const frame = scanZstdFrame(body, offset, encoding, maxWindow);
    frames.push(frame);
    offset = frame.end;
  }
  return frames;
}

/** {@link scanZstdFrames} for the one frame whose Magic_Number is at `start`. */
function scanZstdFrame(
  body: Buffer,
  start: number,
  encoding: string,
  maxWindow: number,
): ZstdFrame {
  const fail = (detail: string): DecompressionError =>
    malformed(encoding, `zstd frame at byte ${start}: ${detail}`);

  // Frame_Header_Descriptor (§3.1.1.1.1).
  let offset = start + 4;
  if (offset >= body.length) {
    throw fail("truncated Frame_Header");
  }
  const descriptor = body[offset++];
  const singleSegment = (descriptor & 0x20) !== 0;
  const hasChecksum = (descriptor & 0x04) !== 0;
  const fcsFlag = descriptor >> 6;
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFlag;
  const didSize = [0, 1, 2, 4][descriptor & 0x03];
  if ((descriptor & 0x08) !== 0) {
    throw fail("Reserved_Bit is set");
  }
  if (offset + (singleSegment ? 0 : 1) + didSize + fcsSize > body.length) {
    throw fail("truncated Frame_Header");
  }

  // Window_Descriptor (§3.1.1.1.2), absent from a single-segment frame.
  let windowSize = 0;
  if (!singleSegment) {
    const windowDescriptor = body[offset++];
    const windowBase = 2 ** (10 + (windowDescriptor >> 3));
    windowSize = windowBase + (windowBase / 8) * (windowDescriptor & 0x07);
  }

  // Dictionary_ID (§3.1.1.1.3): 0 means none. A frame needing a formatted
  // dictionary cannot be decoded — no Content-Encoding names one.
  if (didSize > 0 && body.readUIntLE(offset, didSize) !== 0) {
    throw fail("it needs a dictionary by Dictionary_ID");
  }
  offset += didSize;

  // Frame_Content_Size (§3.1.1.1.4); a 2-byte field is offset by 256.
  let contentSize: number | undefined;
  if (fcsSize === 1) {
    contentSize = body[offset];
  } else if (fcsSize === 2) {
    contentSize = body.readUInt16LE(offset) + 256;
  } else if (fcsSize === 4) {
    contentSize = body.readUInt32LE(offset);
  } else if (fcsSize === 8) {
    contentSize = Number(body.readBigUInt64LE(offset));
  }
  offset += fcsSize;
  if (singleSegment) {
    windowSize = contentSize ?? 0;
  }
  if (windowSize > maxWindow) {
    throw fail(`Window_Size ${windowSize} exceeds ${maxWindow} bytes`);
  }

  // Blocks (§3.1.1.2): 3-byte Block_Header, Last_Block in bit 0, Block_Type
  // in bits 1-2, Block_Size above. Block_Maximum_Size bounds a block's
  // decoded size as well as its compressed size.
  const blockMaximum = Math.min(windowSize, ZSTD_BLOCK_SIZE_MAX);
  let minOutput = 0;
  let maxOutput = 0;
  let lastBlock = false;
  while (!lastBlock) {
    if (offset + 3 > body.length) {
      throw fail("truncated Block_Header");
    }
    const blockHeader = body.readUIntLE(offset, 3);
    offset += 3;
    lastBlock = (blockHeader & 1) === 1;
    const blockType = (blockHeader >> 1) & 0x03;
    const blockSize = blockHeader >>> 3;
    if (blockType === 3) {
      throw fail("reserved Block_Type");
    }
    if (blockSize > ZSTD_BLOCK_SIZE_MAX) {
      throw fail(`Block_Size ${blockSize} exceeds 128 KiB`);
    }
    if (blockType === 2) {
      // Compressed_Block: Block_Size bytes, decoding to at most the maximum.
      offset += blockSize;
      maxOutput += blockMaximum;
    } else {
      // Raw_Block holds its Block_Size bytes; RLE_Block one byte repeated.
      offset += blockType === 1 ? 1 : blockSize;
      minOutput += blockSize;
      maxOutput += blockSize;
    }
    if (offset > body.length) {
      throw fail("truncated block");
    }
  }
  if (hasChecksum) {
    offset += 4;
    if (offset > body.length) {
      throw fail("truncated Content_Checksum");
    }
  }
  if (
    contentSize !== undefined &&
    (contentSize < minOutput || contentSize > maxOutput)
  ) {
    throw fail(
      `Frame_Content_Size ${contentSize} is impossible for its blocks (${minOutput} to ${maxOutput} bytes)`,
    );
  }
  return { start, end: offset, contentSize, minOutput, maxOutput };
}

/**
 * Decodes the zstd frames of `input` from `payloadStart` (0, or past a `dcz`
 * header), with `dictionary` as a raw-content dictionary when given. See the
 * section comment for the bomb strategy.
 */
function decodeZstd(
  input: Buffer,
  payloadStart: number,
  encoding: string,
  limit: number | undefined,
  fastPathLimit: number,
  dictionary?: Uint8Array,
): Buffer {
  const maxWindow =
    dictionary === undefined
      ? ZSTD_CONTENT_CODING_MAX_WINDOW
      : Math.min(
          Math.max(ZSTD_CONTENT_CODING_MAX_WINDOW, dictionary.length * 1.25),
          DCZ_MAX_WINDOW,
        );
  const frames = scanZstdFrames(input, payloadStart, encoding, maxWindow);

  let floor = 0;
  let worstCase = 0;
  for (const frame of frames) {
    floor += frame.contentSize ?? frame.minOutput;
    worstCase += frame.contentSize ?? frame.maxOutput;
  }
  // A body certain to overflow is refused before a byte is decoded.
  const cap = limit ?? kMaxLength;
  if (floor > cap) {
    throw new DecompressionLimitError(encoding, cap);
  }

  // Bun's decoder cannot stop at a limit (and allocates a declared size up
  // front), so it runs only while the worst case fits the fast-path budget.
  const fast =
    dictionary === undefined && fastPathLimit > 0 && worstCase <= fastPathLimit;
  const outputs: Buffer[] = [];
  let total = 0;
  for (const frame of frames) {
    const bytes = input.subarray(frame.start, frame.end);
    let output: Buffer;
    if (fast) {
      try {
        output = Bun.zstdDecompressSync(bytes);
      } catch (error) {
        throw new DecompressionError(encoding, { cause: error });
      }
    } else {
      output = decodeWithZlib(
        zstdDecompressSync,
        bytes,
        encoding,
        limit === undefined ? undefined : limit - total,
        limit,
        dictionary,
      );
    }
    if (
      output.length < frame.minOutput ||
      output.length > frame.maxOutput ||
      (frame.contentSize !== undefined && output.length !== frame.contentSize)
    ) {
      throw malformed(
        encoding,
        `zstd frame at byte ${frame.start} decoded to ${output.length} bytes, which its header rules out`,
      );
    }
    total += output.length;
    if (limit !== undefined && total > limit) {
      throw new DecompressionLimitError(encoding, limit);
    }
    outputs.push(output);
  }
  return outputs.length === 1 ? outputs[0] : Buffer.concat(outputs, total);
}

/* --- Dictionary-compressed content (RFC 9842) ----------------------- */

/** The `dcb` header's magic number (RFC 9842 §4). */
const DCB_MAGIC = Buffer.from([0xff, 0x44, 0x43, 0x42]);
/**
 * The `dcz` header's magic number (RFC 9842 §5): a zstd skippable frame
 * (0x184D2A5E) 32 bytes long — the SHA-256 that follows.
 */
const DCZ_MAGIC = Buffer.from([0x5e, 0x2a, 0x4d, 0x18, 0x20, 0x00, 0x00, 0x00]);
/** Length of a SHA-256 digest. */
const SHA256_LENGTH = 32;

/** The magic number starting a `dcb` or `dcz` body. */
function dictionaryMagic(encoding: DictionaryContentEncoding): Buffer {
  return encoding === "dcb" ? DCB_MAGIC : DCZ_MAGIC;
}

/**
 * The SHA-256 of a compression dictionary: how `dcb`/`dcz` headers and the
 * `Available-Dictionary` request header identify it (RFC 9842 §2.2, §4, §5).
 */
export function compressionDictionaryHash(dictionary: Uint8Array): Buffer {
  return createHash("sha256").update(dictionary).digest();
}

/**
 * The length of the fixed header starting a `dcb` (36 bytes) or `dcz` (40
 * bytes) body — where the compressed stream begins.
 */
export function dictionaryCompressedHeaderLength(
  encoding: DictionaryContentEncoding,
): number {
  return dictionaryMagic(encoding).length + SHA256_LENGTH;
}

/**
 * Builds the header that starts a `dcb` or `dcz` body: the coding's magic
 * number, then the dictionary's SHA-256 (RFC 9842 §4, §5). An encoder writes
 * it, then the stream compressed against the dictionary.
 *
 * @throws {RangeError} when `dictionaryHash` is not 32 bytes.
 */
export function dictionaryCompressedHeader(
  encoding: DictionaryContentEncoding,
  dictionaryHash: Uint8Array,
): Buffer {
  if (dictionaryHash.length !== SHA256_LENGTH) {
    throw new RangeError(
      `dictionaryHash must be a 32-byte SHA-256, got ${dictionaryHash.length} bytes`,
    );
  }
  return Buffer.concat([dictionaryMagic(encoding), dictionaryHash]);
}

/**
 * The dictionary SHA-256 a `dcb`/`dcz` body's header carries — a view into
 * `body` — or `undefined` when the body is shorter than the header or does not
 * start with the coding's magic number. The compressed stream starts at
 * {@link dictionaryCompressedHeaderLength}.
 */
export function parseDictionaryCompressedHeader(
  body: Uint8Array,
  encoding: DictionaryContentEncoding,
): Buffer | undefined {
  const magic = dictionaryMagic(encoding);
  const view = bufferView(body);
  if (
    view.length < magic.length + SHA256_LENGTH ||
    !view.subarray(0, magic.length).equals(magic)
  ) {
    return undefined;
  }
  return view.subarray(magic.length, magic.length + SHA256_LENGTH);
}

/**
 * The SHA-256 an `Available-Dictionary` request header names (RFC 9842
 * §2.2): a Structured Field Byte Sequence, `:base64:` (RFC 9651 §3.3.5), whose
 * parameters are ignored. `undefined` for a missing or malformed value, or a
 * digest that is not 32 bytes.
 */
export function parseAvailableDictionary(
  value: string | null | undefined,
): Buffer | undefined {
  const match = /^[ \t]*:([a-z0-9+/]*={0,2}):[ \t]*(?:;.*)?$/i.exec(
    value ?? "",
  );
  if (!match) {
    return undefined;
  }
  const hash = Buffer.from(match[1], "base64");
  return hash.length === SHA256_LENGTH ? hash : undefined;
}

/** Per dictionary array, its dictionaries by lower-case hex SHA-256. */
const dictionaryIndexes = new WeakMap<
  readonly Uint8Array[],
  Map<string, Uint8Array>
>();

/**
 * The dictionary `hash` names, or `undefined` when there is none.
 *
 * @throws {Error} when a resolver answers a dictionary whose SHA-256 is not
 * `hash` — a server misconfiguration, not the client's fault.
 */
function findDictionary(
  dictionaries: CompressionDictionaries,
  hash: Buffer,
  encoding: DictionaryContentEncoding,
): Uint8Array | undefined {
  if (typeof dictionaries === "function") {
    const dictionary = dictionaries(Buffer.from(hash), encoding);
    if (
      dictionary !== undefined &&
      !compressionDictionaryHash(dictionary).equals(hash)
    ) {
      throw new Error(
        `The "${encoding}" dictionary resolver answered a dictionary whose SHA-256 is not ${hash.toString("hex")}`,
      );
    }
    return dictionary;
  }
  let index = dictionaryIndexes.get(dictionaries);
  if (!index) {
    index = new Map();
    for (const dictionary of dictionaries) {
      index.set(
        compressionDictionaryHash(dictionary).toString("hex"),
        dictionary,
      );
    }
    dictionaryIndexes.set(dictionaries, index);
  }
  return index.get(hash.toString("hex"));
}

/** Whether this runtime decodes `dcb` and `dcz` with a dictionary; probed once. */
let dictionarySupport: Record<DictionaryContentEncoding, boolean> | undefined;

/**
 * Whether node:zlib really honours `dictionary` for `encoding`'s format. Bun
 * forwards it to libbrotli and libzstd, but `@types/node` declares it for
 * neither, and a runtime that silently ignored it would reject every such body
 * as corrupt (400) instead of unsupported (415). One tiny round trip decides:
 * it must succeed with the dictionary and fail without it.
 */
function dictionaryDecodingSupported(
  encoding: DictionaryContentEncoding,
): boolean {
  dictionarySupport ??= {
    dcb: roundTripsOnlyWithDictionary(brotliCompressSync, brotliDecompressSync),
    dcz: roundTripsOnlyWithDictionary(zstdCompressSync, zstdDecompressSync),
  };
  return dictionarySupport[encoding];
}

/** See {@link dictionaryDecodingSupported}. */
function roundTripsOnlyWithDictionary(
  compress: ZlibSyncCodec,
  decompress: ZlibSyncCodec,
): boolean {
  const dictionary = Buffer.from(
    "bun-common probe: a sentence only the dictionary holds, twice over.",
  );
  const sample = Buffer.concat([dictionary, Buffer.from("!")]);
  let packed: Buffer;
  try {
    packed = compress(sample, { dictionary });
    if (!decompress(packed, { dictionary }).equals(sample)) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    return !decompress(packed).equals(sample);
  } catch {
    return true;
  }
}

/**
 * Decodes a `dcb`/`dcz` layer: checks the header, finds its dictionary, and
 * decodes the stream after the header against it.
 */
function decodeDictionaryCompressed(
  input: Buffer,
  encoding: DictionaryContentEncoding,
  limit: number | undefined,
  dictionaries: CompressionDictionaries,
): Buffer {
  const hash = parseDictionaryCompressedHeader(input, encoding);
  if (hash === undefined) {
    throw malformed(
      encoding,
      `no ${encoding} header (magic number and dictionary SHA-256)`,
    );
  }
  const dictionary = findDictionary(dictionaries, hash, encoding);
  if (dictionary === undefined) {
    throw new UnknownCompressionDictionaryError(encoding, hash);
  }
  const payloadStart = dictionaryCompressedHeaderLength(encoding);
  if (encoding === "dcz") {
    // The dcz header is itself a skippable frame; the walk starts past it.
    return decodeZstd(input, payloadStart, encoding, limit, 0, dictionary);
  }
  return decodeWithZlib(
    brotliDecompressSync,
    input.subarray(payloadStart),
    encoding,
    limit,
    limit,
    dictionary,
  );
}

/* --- Content-Encoding lists and allowlists -------------------------- */

/** Every coding {@link decompressBody} can decode. */
const DECODABLE_CODINGS: ReadonlySet<string> =
  new Set<SupportedContentEncoding>([
    "identity",
    "gzip",
    "x-gzip",
    "deflate",
    "br",
    "zstd",
    "dcb",
    "dcz",
  ]);

/** A coding's canonical name: `x-gzip` is an alias of `gzip` (RFC 9110 §8.4.1.3). */
function canonicalCoding(coding: string): string {
  return coding === "x-gzip" ? "gzip" : coding;
}

/**
 * The codings a `Content-Encoding` value lists, in the order they were
 * applied (RFC 9110 §8.4) — so a recipient decodes them last to first. Each
 * element is trimmed and lower-cased (codings are case-insensitive); empty
 * elements, which RFC 9110 §5.6.1 requires a recipient to accept, and
 * `identity`, which changes nothing, are dropped. `[]` means no coding.
 */
export function parseContentCodings(value: string): string[] {
  const codings: string[] = [];
  for (const element of value.split(",")) {
    const coding = element.trim().toLowerCase();
    if (coding !== "" && coding !== "identity") {
      codings.push(coding);
    }
  }
  return codings;
}

/**
 * Validates an `encodings` allowlist, answering `undefined` when it admits
 * every coding (`"*"`, a list holding `"*"`, or no allowlist) and otherwise the
 * canonical codings it admits.
 *
 * @throws {RangeError} for a value that is neither `"*"` nor an array, or an
 * entry that is not a {@link SupportedContentEncoding}.
 */
export function resolveContentEncodingAllowlist(
  encodings: ContentEncodingAllowlist | undefined,
): ReadonlySet<string> | undefined {
  if (encodings === undefined || encodings === "*") {
    return undefined;
  }
  if (!Array.isArray(encodings)) {
    throw new RangeError(
      `encodings must be "*" or an array of content codings, got ${safeStringify(encodings)}`,
    );
  }
  const allowed = new Set<string>();
  let wildcard = false;
  for (const entry of encodings as readonly unknown[]) {
    if (entry === "*") {
      wildcard = true;
      continue;
    }
    const coding =
      typeof entry === "string" ? entry.trim().toLowerCase() : undefined;
    if (coding === undefined || !DECODABLE_CODINGS.has(coding)) {
      throw new RangeError(
        `encodings: ${safeStringify(entry)} is not a content coding this library decodes`,
      );
    }
    allowed.add(canonicalCoding(coding));
  }
  return wildcard ? undefined : allowed;
}

/**
 * Whether `coding` (one list element) passes `encodings`: `identity` (or an
 * empty element) always does; a coding {@link decompressBody} cannot decode —
 * a literal `*` included — never does.
 *
 * @throws {RangeError} for an invalid allowlist, as
 * {@link resolveContentEncodingAllowlist}.
 */
export function isContentCodingAllowed(
  coding: string,
  encodings: ContentEncodingAllowlist | undefined,
): boolean {
  const name = coding.trim().toLowerCase();
  if (name === "" || name === "identity") {
    return true;
  }
  const allowed = resolveContentEncodingAllowlist(encodings);
  return (
    DECODABLE_CODINGS.has(name) &&
    (allowed === undefined || allowed.has(canonicalCoding(name)))
  );
}

/** Validates `maxCodings`, defaulting to {@link DEFAULT_MAX_CONTENT_CODINGS}. */
function resolveMaxCodings(maxCodings: number | undefined): number {
  if (maxCodings === undefined) {
    return DEFAULT_MAX_CONTENT_CODINGS;
  }
  if (!(maxCodings >= 0)) {
    throw new RangeError(
      `maxCodings must be a non-negative number, got ${maxCodings}`,
    );
  }
  return Math.floor(maxCodings);
}

/** Decodes one layer; `coding` has been admitted by {@link decompressBody}. */
function decodeLayer(
  input: Buffer,
  coding: string,
  limit: number | undefined,
  fastPathLimit: number,
  dictionaries: CompressionDictionaries | undefined,
): Buffer {
  // Bun's decoders are typed for ArrayBuffer-backed arrays; they read any view.
  const bytes = input as Uint8Array<ArrayBuffer>;

  switch (coding) {
    case "gzip":
    case "x-gzip": {
      // Invalid for Bun, or not one member spanning the body: node:zlib
      // decides, and supplies any error.
      const output = takesFastPath(input, fastPathLimit)
        ? attemptDecode(() => Bun.gunzipSync(bytes, { library: "libdeflate" }))
        : undefined;
      if (output && isWholeGzipMember(input, output)) {
        return checkedFastPathOutput(output, coding, limit);
      }
      return decodeWithZlib(gunzipSync, input, coding, limit);
    }

    case "deflate": {
      const output = takesFastPath(input, fastPathLimit)
        ? attemptDecode(() => Bun.inflateSync(bytes, { windowBits: 15 }))
        : undefined;
      if (output) {
        return checkedFastPathOutput(output, coding, limit);
      }
      return decodeWithZlib(inflateSync, input, coding, limit);
    }

    case "br":
      return decodeWithZlib(brotliDecompressSync, input, coding, limit);

    case "zstd":
      return decodeZstd(input, 0, coding, limit, fastPathLimit);

    case "dcb":
    case "dcz":
      if (dictionaries !== undefined) {
        return decodeDictionaryCompressed(input, coding, limit, dictionaries);
      }
      break;
  }
  throw new Error(`decompressBody admitted "${coding}" without a decoder`);
}

/**
 * Decodes a request body per its `Content-Encoding`: `gzip` (and its RFC 9110
 * alias `x-gzip`), zlib-wrapped `deflate` and `br` with body-parser's
 * semantics — plus `zstd`, `dcb`/`dcz` given `dictionaries`, and stacked
 * codings, all of which body-parser refuses. The value is read as RFC 9110's
 * list ({@link parseContentCodings}) and its codings decoded last to first
 * (§8.4). With no coding left (empty, `identity`) the body is returned as a
 * zero-copy `Buffer` view.
 *
 * Contract:
 * - returns the decoded `Buffer`;
 * - returns `undefined` when a listed coding is one it does not decode
 *   (`compress`, a literal `*`), is outside `encodings`, or is `dcb`/`dcz`
 *   without `dictionaries` — answer `415`. Every layer is checked before any
 *   is decoded;
 * - throws {@link ContentCodingLimitError} (`code: "ERR_CONTENT_CODING_LIMIT"`)
 *   when more than `maxCodings` are stacked — answer `415`;
 * - throws {@link DecompressionLimitError} (`code: "ERR_DECOMPRESSION_LIMIT"`)
 *   when any layer's output would exceed `maxOutputLength` — answer `413`;
 * - throws {@link DecompressionError} (`code: "ERR_DECOMPRESSION_FAILED"`) on
 *   invalid data in any layer, including raw DEFLATE sent as `deflate` and
 *   truncated zstd, or its subclass {@link UnknownCompressionDictionaryError}
 *   for a dictionary `dictionaries` lacks — answer `400`. `encoding` names the
 *   failing layer;
 * - throws `RangeError` for a negative or `NaN` `maxOutputLength`,
 *   `fastPathLimit` or `maxCodings`, or an invalid `encodings`; and lets
 *   through whatever a dictionary resolver throws, or an `Error` when the
 *   dictionary it answers does not match the hash.
 *
 * @example
 * const body = decompressBody(raw, req.headers.get("content-encoding") ?? "", {
 *   maxOutputLength: 100 * 1024,
 * });
 */
export function decompressBody(
  body: Uint8Array,
  encoding: Exclude<SupportedContentEncoding, DictionaryContentEncoding>,
  options?: DecompressBodyOptions & { encodings?: "*" | undefined },
): Buffer;
export function decompressBody(
  body: Uint8Array,
  encoding: string,
  options?: DecompressBodyOptions,
): Buffer | undefined;
export function decompressBody(
  body: Uint8Array,
  encoding: string,
  options?: DecompressBodyOptions,
): Buffer | undefined {
  const codings = parseContentCodings(encoding);
  const limit = resolveOutputLimit(options?.maxOutputLength);
  const fastPathLimit = resolveFastPathLimit(options?.fastPathLimit);
  const maxCodings = resolveMaxCodings(options?.maxCodings);
  const allowed = resolveContentEncodingAllowlist(options?.encodings);
  const dictionaries = options?.dictionaries;
  let output = bufferView(body);

  if (codings.length > maxCodings) {
    throw new ContentCodingLimitError(codings.length, maxCodings);
  }
  for (const coding of codings) {
    if (
      !DECODABLE_CODINGS.has(coding) ||
      (allowed !== undefined && !allowed.has(canonicalCoding(coding)))
    ) {
      return undefined;
    }
    if (
      (coding === "dcb" || coding === "dcz") &&
      (dictionaries === undefined || !dictionaryDecodingSupported(coding))
    ) {
      return undefined;
    }
  }

  if (codings.length === 0) {
    if (limit !== undefined && output.length > limit) {
      throw new DecompressionLimitError("identity", limit);
    }
    return output;
  }
  for (let layer = codings.length - 1; layer >= 0; layer--) {
    output = decodeLayer(
      output,
      codings[layer],
      limit,
      fastPathLimit,
      dictionaries,
    );
  }
  return output;
}
