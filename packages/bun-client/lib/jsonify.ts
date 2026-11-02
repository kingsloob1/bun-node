/**
 * `Jsonify<T>`: the type `JSON.parse(JSON.stringify(value))` produces for a
 * `T`, which is what a response body is once it has crossed the wire
 * (typed-client plan §4.1, D5).
 *
 * A copy of bun-common's `Jsonify` (`bun-common/lib/utils/native.ts`), not an
 * import: the client must not pull bun-common into a frontend (plan D17).
 * `__tests__/jsonify.type-test.ts` asserts the two agree over a corpus, so
 * a change to one that the other lacks fails the check.
 */

/** `true` when `T` is `any`, the one type every conditional must special-case. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** A value `JSON.parse` can produce: what survives a JSON round trip. */
type JsonPrimitive = string | number | boolean | null;

/** Any JSON document: a primitive, an array of them, or an object of them. */
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

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
 * leaving `undefined` in its place (the key may be absent), and `unknown` is
 * any JSON value or `undefined`.
 */
type JsonifyProperty<V> =
  IsAny<V> extends true
    ? V
    : unknown extends V
      ? JsonValue | undefined
      : | JsonifyValue<Exclude<V, JsonUnrepresentable>>
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
 * `| undefined`.
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
 * The type `JSON.parse(JSON.stringify(value))` produces for a `T`.
 *
 * It follows `JSON.stringify`: `toJSON()` is honoured (so a `Date` is a
 * `string`); a function, symbol or `undefined` property is dropped (optional
 * when only part of its type is), and the same value in an array is `null`;
 * a `Map` or `Set` is an empty object; `readonly` is gone; a symbol key is
 * gone. A top-level function, symbol or `undefined` is `undefined`, and a
 * `bigint` is `never`, because stringifying one throws. `unknown` becomes
 * `JsonValue` (plus `undefined` at the top level); `any` stays `any`.
 *
 * A type already made of JSON values comes back unchanged.
 */
export type Jsonify<T> =
  IsAny<T> extends true
    ? T
    : unknown extends T
      ? JsonValue | undefined
      : JsonifyValue<T>;
