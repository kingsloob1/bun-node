/**
 * Strips the prototype-pollution keys from a received value before a schema
 * runs on it, as Nest 12.2.0's `stripProtoKeys`
 * (`@nestjs/common/utils/strip-proto-keys.util.js`) does in its
 * `ValidationPipe` and `StandardSchemaValidationPipe`.
 *
 * `JSON.parse('{"__proto__":{…}}')` makes an own `__proto__` key, and a
 * vendor that copies keys with plain assignment either crashes on it (yup:
 * `field.resolve is not a function`, a 500) or sets the output's prototype
 * from it. Stripping it first makes the schema see what Nest's pipes let it
 * see (the default rule, `"nest"`), or, under `"minimal"`, removes only the
 * keys that pollute.
 *
 * Browser-safe, like the rest of `lib/contract/`: no `node:util`, so a
 * typed array is told apart with `ArrayBuffer.isView` (a `DataView` aside,
 * which `util.types.isTypedArray` also rejects; Nest's walk finds nothing to
 * strip in one either way).
 */

import type { GuardOptions } from "./model";

/**
 * Built-in types whose instances are neither stripped nor walked, Nest's
 * `BUILT_IN_TYPES`: their own state is not data a client sent.
 */
const BUILT_IN_TYPES: readonly unknown[] = [
  Date,
  RegExp,
  Error,
  Map,
  Set,
  WeakMap,
  WeakSet,
];

/** Whether `value` is an instance of one of {@link BUILT_IN_TYPES}. */
function isBuiltIn(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet
  );
}

/**
 * Which prototype-pollution keys are stripped (the `stripProtoKeys` option):
 * `"nest"`, Nest 12.2.0's rule, or `"minimal"`, only the keys that pollute.
 */
export type ProtoKeyRule = NonNullable<GuardOptions["stripProtoKeys"]>;

/**
 * `value` as a {@link ProtoKeyRule}, `undefined` for unset; anything else
 * throws a `TypeError` naming `owner`, as `messages` and `redactPaths`
 * refuse a value they do not take.
 */
export function checkProtoKeyRule(
  owner: string,
  value: unknown,
): ProtoKeyRule | undefined {
  if (value === undefined || value === "nest" || value === "minimal") {
    return value;
  }
  throw new TypeError(
    `${owner}: stripProtoKeys must be "nest" or "minimal" (or unset)`,
  );
}

/**
 * Deletes, in place and recursively, the prototype-pollution keys of
 * `value`, by `rule`:
 *
 * - `"nest"` (the default): exactly Nest 12.2.0's `stripProtoKeys`, every
 *   own `__proto__` and `prototype` key and every own `constructor` key
 *   (unless the object's `constructor` is one of the built-in types),
 *   whatever their values, so a legitimate `prototype` or `constructor`
 *   field goes too.
 * - `"minimal"`: only every own `__proto__` key, and every own
 *   `constructor` key whose value is an object with an own `prototype` key
 *   (`{"constructor":{"prototype":{…}}}`); a `prototype` field, and a
 *   `constructor` that is a string, a number or an object without
 *   `prototype`, are kept.
 *
 * Under either, `null`, primitives, typed arrays and instances of `Date`,
 * `RegExp`, `Error`, `Map`, `Set`, `WeakMap` and `WeakSet` are left alone;
 * an array's items are walked (only those present, so a sparse array's
 * length costs nothing); any other object's keys are deleted and its
 * enumerable values (`for…in`) walked.
 *
 * Allocates nothing and deletes nothing when there is nothing to strip (each
 * key is looked up before it is deleted, so an object's shape is left as it
 * was), and is synchronous. Like Nest's, it walks without a cycle check: the
 * values it is given are parsed input, which cannot be cyclic.
 */
export function stripProtoKeys(
  value: unknown,
  rule: ProtoKeyRule = "nest",
): void {
  if (
    value === null ||
    typeof value !== "object" ||
    (ArrayBuffer.isView(value) && !(value instanceof DataView))
  ) {
    return;
  }
  if (isBuiltIn(value)) return;
  const record = value as Record<string, unknown>;
  if (Array.isArray(value)) {
    // `for…in` visits the items present, as Nest's `Object.values()` does,
    // without allocating the array of them.
    for (const index in record) stripProtoKeys(record[index], rule);
    return;
  }
  if (Object.hasOwn(record, "__proto__")) {
    Reflect.deleteProperty(record, "__proto__");
  }
  if (rule === "nest") {
    if (Object.hasOwn(record, "prototype")) {
      Reflect.deleteProperty(record, "prototype");
    }
    // Whatever its value: a falsy one (null, 0, false, "") shadows the
    // prototype's all the same (Nest's comment).
    if (
      Object.hasOwn(record, "constructor") &&
      !BUILT_IN_TYPES.includes(record.constructor)
    ) {
      Reflect.deleteProperty(record, "constructor");
    }
  } else if (Object.hasOwn(record, "constructor")) {
    const constructor: unknown = record.constructor;
    if (
      typeof constructor === "object" &&
      constructor !== null &&
      Object.hasOwn(constructor, "prototype")
    ) {
      Reflect.deleteProperty(record, "constructor");
    }
  }
  for (const key in record) stripProtoKeys(record[key], rule);
}
