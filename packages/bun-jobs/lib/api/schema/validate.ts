import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import { coerceForTypes } from "./coerce";

/**
 * An interpreter for the JSON Schema subset the builder emits — and nothing
 * more. Every keyword below is one `builder.ts` can produce; a keyword it
 * cannot produce is ignored rather than half-supported, so the two files stay
 * a matched pair.
 *
 * Results follow Standard Schema: `{ value }` on success, `{ issues }` on
 * failure, with each issue's `path` a list of plain keys. That is what
 * bun-common's `validate()` flattens into `{ target, path, message }`, so the
 * API's validation problems read the same as any other library's.
 */

/** The JSON types a node may name. */
export type JsonSchemaType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "null";

/** A JSON primitive, as `const` and `enum` hold. */
export type JsonPrimitive = string | number | boolean | null;

/** One JSON Schema node, restricted to the keywords the builder emits. */
export interface JsonSchema {
  /** The JSON type(s) the value must have. */
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  /** Human description; ignored by validation. */
  readonly description?: string;
  /** Value used when the input is absent; applied before any other check. */
  readonly default?: unknown;
  /** Exactly this value. */
  readonly const?: JsonPrimitive;
  /** One of these values. */
  readonly enum?: readonly JsonPrimitive[];
  /** Smallest number allowed, inclusive. */
  readonly minimum?: number;
  /** Largest number allowed, inclusive. */
  readonly maximum?: number;
  /** Fewest code points a string may have. */
  readonly minLength?: number;
  /** Most code points a string may have. */
  readonly maxLength?: number;
  /** A regular expression a string must match (unanchored, `u` flag). */
  readonly pattern?: string;
  /** A format a string must satisfy. */
  readonly format?: "date-time";
  /** Schema of every array item. */
  readonly items?: JsonSchema;
  /** Fewest items an array may have. */
  readonly minItems?: number;
  /** Most items an array may have. */
  readonly maxItems?: number;
  /** Schemas of known object properties. */
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  /** Properties that must be present (unless they have a default). */
  readonly required?: readonly string[];
  /** Unlisted properties: rejected (`false`), passed (`true`), or validated. */
  readonly additionalProperties?: boolean | JsonSchema;
  /** The value must match at least one of these; the first match wins. */
  readonly anyOf?: readonly JsonSchema[];
  /** A reference to a component; only present in emitted documents, never validated. */
  readonly $ref?: string;
}

/** Options for {@link validateJson}. */
export interface ValidateJsonOptions {
  /** Coerce string input (query and path values) before type checks. Defaults to `false`. */
  coerce?: boolean;
}

/** Why an issue was raised; used to pick the most relevant member of a failed `anyOf`. */
type IssueKind = "type" | "discriminator" | "required" | "other";

/** An issue while it is being collected, before it is handed out. */
interface InternalIssue {
  /** Human-readable description. */
  message: string;
  /** Where in the value it was found. */
  path: PropertyKey[];
  /** What kind of check raised it. */
  kind: IssueKind;
}

/** State threaded through one validation. */
interface WalkContext {
  /** Whether string input is coerced. */
  coerce: boolean;
  /** Issues found so far. */
  issues: InternalIssue[];
}

/** Returned by {@link walk} when the value failed. */
const FAIL: unique symbol = Symbol("fail");

/** Compiled `pattern`s, by node. */
const PATTERNS = new WeakMap<JsonSchema, RegExp>();

/**
 * The compiled `pattern` of a node, compiled once and cached. Patterns only
 * ever come from this package's own schema definitions, never from a request,
 * which is what makes compiling them safe.
 */
export function compilePattern(node: JsonSchema): RegExp {
  let compiled = PATTERNS.get(node);
  if (!compiled) {
    compiled = new RegExp(node.pattern ?? "", "u");
    PATTERNS.set(node, compiled);
  }
  return compiled;
}

/** RFC 3339 `date-time`, with the calendar checked separately. */
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i;

/** Whether a string is a real RFC 3339 `date-time` (not just date-shaped). */
export function isDateTime(value: string): boolean {
  const match = DATE_TIME.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    return false;
  }
  // RFC 3339 admits a leap second (60), but nothing downstream can hold one:
  // `Date.parse` answers NaN for it. The final check refuses any time that no
  // `Date` can represent, so a validated value is always usable.
  if (hour > 23 || minute > 59 || second > 60) {
    return false;
  }
  if (match[7] !== undefined) {
    if (Number(match[8]) > 23 || Number(match[9]) > 59) {
      return false;
    }
  }
  return Number.isFinite(Date.parse(value));
}

/** Counts Unicode code points, which is what JSON Schema lengths measure. */
function codePoints(value: string): number {
  let count = 0;
  for (const _ of value) {
    count++;
  }
  return count;
}

/** A value's JSON type, for messages. */
function typeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? "integer"
      : Number.isFinite(value)
        ? "number"
        : String(value);
  }
  return typeof value;
}

/** Whether a value is a plain JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value has one JSON type. */
function hasType(type: JsonSchemaType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      // Safe integers only: past 2^53 a number no longer holds the integer
      // the client wrote, and ids, counts and offsets would silently shift.
      return typeof value === "number" && Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    default:
      return isPlainObject(value);
  }
}

/** A default, copied so no caller can mutate the frozen schema's value. */
function cloneDefault(value: unknown): unknown {
  return value !== null && typeof value === "object"
    ? structuredClone(value)
    : value;
}

/**
 * Sets an own property. `__proto__` is defined rather than assigned: assigning
 * it would replace the output's prototype with whatever the request sent.
 */
function define(target: Record<string, unknown>, key: string, value: unknown) {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

/** A short description of what a node accepts, for a failed `anyOf`. */
function describe(node: JsonSchema): string {
  if (node.const !== undefined) {
    return JSON.stringify(node.const);
  }
  if (node.anyOf) {
    return node.anyOf.map(describe).join(" or ");
  }
  if (node.enum) {
    return node.enum.map((value) => JSON.stringify(value)).join(" or ");
  }
  if (node.type === undefined) {
    return "any value";
  }
  return (Array.isArray(node.type) ? node.type : [node.type]).join(" or ");
}

/** Records an issue. */
function fail(
  ctx: WalkContext,
  path: PropertyKey[],
  message: string,
  kind: IssueKind = "other",
): typeof FAIL {
  ctx.issues.push({ message, path, kind });
  return FAIL;
}

/** Validates a value against `anyOf`: the first member that accepts it wins. */
function walkAnyOf(
  members: readonly JsonSchema[],
  node: JsonSchema,
  value: unknown,
  path: PropertyKey[],
  ctx: WalkContext,
): unknown {
  let best: InternalIssue[] | undefined;

  for (const member of members) {
    const attempt: WalkContext = { coerce: ctx.coerce, issues: [] };
    const result = walk(member, value, path, attempt);
    if (result !== FAIL) {
      return result;
    }

    // A member rejected on its type, or on a discriminating constant one level
    // down, is not what the caller was aiming for; its issues would only
    // confuse. Of the rest, the one with the fewest issues is the likeliest.
    const aimedElsewhere = attempt.issues.some(
      (issue) =>
        (issue.kind === "type" && issue.path.length === path.length) ||
        (issue.kind === "discriminator" &&
          issue.path.length <= path.length + 1),
    );
    if (!aimedElsewhere && (!best || attempt.issues.length < best.length)) {
      best = attempt.issues;
    }
  }

  if (best) {
    ctx.issues.push(...best);
    return FAIL;
  }
  return fail(
    ctx,
    path,
    `Expected ${describe(node)}, received ${typeOf(value)}`,
    "type",
  );
}

/** Validates a string's length, pattern and format. */
function checkString(
  node: JsonSchema,
  value: string,
  path: PropertyKey[],
  ctx: WalkContext,
): boolean {
  let ok = true;
  if (node.minLength !== undefined || node.maxLength !== undefined) {
    // `length` counts UTF-16 units, never fewer than code points: only a
    // string long enough to fail needs counting properly.
    const length =
      (node.maxLength !== undefined && value.length > node.maxLength) ||
      node.minLength !== undefined
        ? codePoints(value)
        : value.length;
    if (node.minLength !== undefined && length < node.minLength) {
      fail(ctx, path, `Expected at least ${node.minLength} characters`);
      ok = false;
    }
    if (node.maxLength !== undefined && length > node.maxLength) {
      fail(ctx, path, `Expected at most ${node.maxLength} characters`);
      ok = false;
    }
  }
  // The length is checked first, and a pattern is never run on a value that
  // already failed it, so an oversized input cannot reach the regex.
  if (ok && node.pattern !== undefined && !compilePattern(node).test(value)) {
    fail(ctx, path, `Expected a value matching ${node.pattern}`);
    ok = false;
  }
  if (node.format === "date-time" && !isDateTime(value)) {
    fail(ctx, path, "Expected an RFC 3339 date-time");
    ok = false;
  }
  return ok;
}

/** Validates an array and its items, producing a new array. */
function walkArray(
  node: JsonSchema,
  value: unknown[],
  path: PropertyKey[],
  ctx: WalkContext,
): unknown {
  if (node.minItems !== undefined && value.length < node.minItems) {
    return fail(ctx, path, `Expected at least ${node.minItems} items`);
  }
  if (node.maxItems !== undefined && value.length > node.maxItems) {
    // Refused before any item is walked, so a huge array costs one comparison.
    return fail(ctx, path, `Expected at most ${node.maxItems} items`);
  }
  if (!node.items) {
    return [...value];
  }
  const out: unknown[] = [];
  let failed = false;
  for (let index = 0; index < value.length; index++) {
    const item = walk(node.items, value[index], [...path, index], ctx);
    if (item === FAIL) {
      failed = true;
    } else {
      out.push(item);
    }
  }
  return failed ? FAIL : out;
}

/** Validates an object's properties, producing a new object. */
function walkObject(
  node: JsonSchema,
  value: Record<string, unknown>,
  path: PropertyKey[],
  ctx: WalkContext,
): unknown {
  const properties = node.properties ?? {};
  const required = node.required ?? [];
  const out: Record<string, unknown> = {};
  let failed = false;

  for (const key of Object.keys(properties)) {
    const child = properties[key]!;
    const present = Object.hasOwn(value, key) && value[key] !== undefined;
    if (!present && child.default === undefined) {
      if (required.includes(key)) {
        fail(ctx, [...path, key], "Required", "required");
        failed = true;
      }
      continue;
    }
    const result = walk(
      child,
      present ? value[key] : undefined,
      [...path, key],
      ctx,
    );
    if (result === FAIL) {
      failed = true;
    } else {
      define(out, key, result);
    }
  }

  const additional = node.additionalProperties;
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(properties, key)) {
      continue;
    }
    if (additional === false) {
      if (ctx.coerce) {
        // Query and path values (`s.query`): an unknown key — a cache-buster,
        // a `utm_*` tag — is dropped rather than refused. Bodies still refuse.
        continue;
      }
      fail(ctx, [...path, key], "Unknown property");
      failed = true;
    } else if (additional && typeof additional === "object") {
      const result = walk(additional, value[key], [...path, key], ctx);
      if (result === FAIL) {
        failed = true;
      } else {
        define(out, key, result);
      }
    } else {
      define(out, key, value[key]);
    }
  }

  return failed ? FAIL : out;
}

/** Validates one value against one node. */
function walk(
  node: JsonSchema,
  input: unknown,
  path: PropertyKey[],
  ctx: WalkContext,
): unknown {
  if (input === undefined && node.default !== undefined) {
    return cloneDefault(node.default);
  }

  if (node.anyOf) {
    return walkAnyOf(node.anyOf, node, input, path, ctx);
  }

  let value = input;
  if (node.type !== undefined) {
    const types: readonly JsonSchemaType[] = Array.isArray(node.type)
      ? node.type
      : [node.type as JsonSchemaType];
    if (ctx.coerce) {
      value = coerceForTypes(value, types);
    }
    if (!types.some((type) => hasType(type, value))) {
      if (value === undefined) {
        return fail(ctx, path, "Required", "required");
      }
      const message =
        ctx.coerce && Array.isArray(value)
          ? "Expected a single value, received several"
          : `Expected ${types.join(" or ")}, received ${typeOf(value)}`;
      return fail(ctx, path, message, "type");
    }
  }

  if (node.const !== undefined && value !== node.const) {
    return fail(
      ctx,
      path,
      `Expected ${JSON.stringify(node.const)}`,
      "discriminator",
    );
  }
  if (node.enum && !node.enum.includes(value as JsonPrimitive)) {
    return fail(
      ctx,
      path,
      `Expected one of ${node.enum.map((entry) => JSON.stringify(entry)).join(", ")}`,
      "discriminator",
    );
  }

  if (typeof value === "string") {
    return checkString(node, value, path, ctx) ? value : FAIL;
  }
  if (typeof value === "number") {
    if (node.minimum !== undefined && value < node.minimum) {
      return fail(ctx, path, `Expected a value of at least ${node.minimum}`);
    }
    if (node.maximum !== undefined && value > node.maximum) {
      return fail(ctx, path, `Expected a value of at most ${node.maximum}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return walkArray(node, value, path, ctx);
  }
  if (
    isPlainObject(value) &&
    (node.properties || node.additionalProperties !== undefined)
  ) {
    return walkObject(node, value, path, ctx);
  }
  return value;
}

/**
 * Validates a value against a JSON Schema node, returning a Standard Schema
 * result. The output is a new value with defaults filled in (and, with
 * `coerce`, strings converted); the input is never mutated.
 */
export function validateJson(
  schema: JsonSchema,
  value: unknown,
  options?: ValidateJsonOptions,
): StandardSchemaV1.Result<unknown> {
  const ctx: WalkContext = { coerce: options?.coerce ?? false, issues: [] };
  const result = walk(schema, value, [], ctx);
  if (result === FAIL) {
    return {
      issues: ctx.issues.map((issue) =>
        issue.path.length > 0
          ? { message: issue.message, path: issue.path }
          : { message: issue.message },
      ),
    };
  }
  return { value: result };
}
