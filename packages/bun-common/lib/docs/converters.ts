/**
 * The built-in vendor converters (plan §4.2/§4.3). Every one is
 * **structural**: it reads a method the schema object carries
 * (`toJSONSchema`, `toJsonSchema`, `describe`, `json`) and never imports the
 * vendor's package, so `lib/docs/` has no vendor in its import graph
 * (`__tests__/docs/packaging.test.ts` proves it) and a vendor that adopts the
 * Standard JSON Schema companion spec takes the primary path instead
 * (`convert.ts`'s resolution).
 */
import type {
  ConvertContext,
  JsonSchemaConverter,
  JsonSchemaLike,
} from "./convert";

/** Whether `value` is a plain JSON-Schema-shaped object. */
function isPlainObject(value: unknown): value is JsonSchemaLike {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * zod, through the instance `toJSONSchema` the schema carries since zod 4.2
 * (zod#5477) — the **retry** for when the primary `~standard.jsonSchema` path
 * threw, per §4.2's "fallback path" column. Runs degraded
 * (`unrepresentable: "any"`), matching the primary path: a `z.date()` or a
 * transform becomes `{}` rather than an exception. Pinned against zod 4.6.1.
 */
export const zodConverter: JsonSchemaConverter = (schema, context) => {
  const toJSONSchema = (schema as { toJSONSchema?: unknown }).toJSONSchema;
  if (typeof toJSONSchema !== "function") return undefined;
  let json: unknown;
  try {
    json = toJSONSchema.call(schema, {
      target: context.dialect,
      io: context.direction,
      unrepresentable: "any",
    });
  } catch {
    return undefined;
  }
  return isPlainObject(json) ? json : undefined;
};

/**
 * arktype, through the instance `toJsonSchema` (arktype ≥ 2.1.28 carries the
 * primary `~standard.jsonSchema`; this is the fallback, and the morph
 * recovery for versions whose primary path throws on a morph): a morph
 * degrades to its input side (`{ fallback: { morph: (ctx) => ctx.base } }`,
 * measured: `string.integer.parse` → `{ type: "string", pattern: … }`).
 */
export const arktypeConverter: JsonSchemaConverter = (schema, context) => {
  const toJsonSchema = (schema as { toJsonSchema?: unknown }).toJsonSchema;
  if (typeof toJsonSchema !== "function") return undefined;
  let json: unknown;
  try {
    json = toJsonSchema.call(schema, {
      io: context.direction,
      fallback: { morph: (ctx: { base: unknown }) => ctx.base },
    });
  } catch {
    return undefined;
  }
  return isPlainObject(json) ? json : undefined;
};

/* ------------------------------------------------------------------ *
 * yup: no official converter exists (§4.2 — a grep of yup 1.7.1's
 * published index.js for `jsonSchema` finds nothing), so the JSON
 * Schema is mapped from the schema's own `describe()`.
 * ------------------------------------------------------------------ */

/** The shape yup's `describe()` returns (yup 1.7.1), structurally. */
interface YupDescription {
  /** The yup type: `"string"`, `"number"`, `"boolean"`, `"date"`, `"array"`, `"tuple"`, `"object"`, `"mixed"`. */
  readonly type: string;
  /** Whether the value may be absent (a field with `optional: false` is `required`). */
  readonly optional: boolean;
  /** Whether `null` is allowed. */
  readonly nullable: boolean;
  /** The default, when one is set. */
  readonly default?: unknown;
  /** The allowed values (`oneOf`), mapped to `enum`. */
  readonly oneOf: readonly unknown[];
  /** The forbidden values (`notOneOf`), mapped to `not.enum`. */
  readonly notOneOf: readonly unknown[];
  /** The checks, by name (`min`, `max`, `length`, `email`, `url`, `matches`, `integer`, …). */
  readonly tests: readonly {
    readonly name?: string;
    readonly params?: Record<string, unknown>;
  }[];
  /** An object's fields, by key. */
  readonly fields?: Record<string, YupDescription>;
  /** An array's member description; a tuple's, in order. */
  readonly innerType?: YupDescription | readonly YupDescription[];
}

/**
 * The JSON Schema for a yup `describe()` node. Only what describe() states
 * is emitted; a test whose name or params are not recognised is dropped
 * (degrade, never throw). `matches`'s `params.regex` is a `RegExp`, which
 * `JSON.stringify`s to `{}` — its `.source` is read, never the RegExp
 * itself.
 */
function yupNode(
  desc: YupDescription,
  dialect: ConvertContext["dialect"],
): JsonSchemaLike {
  const json: JsonSchemaLike = {};
  let type: string | undefined;
  switch (desc.type) {
    case "string":
    case "boolean":
      type = desc.type;
      break;
    case "number":
      type = "number";
      break;
    case "date":
      // yup accepts a Date, an ISO string and a timestamp alike (it casts);
      // `format` constrains strings only under ajv, which is the closest a
      // JSON Schema gets. Recorded divergence: a Date instance validates
      // under yup but is not JSON at all.
      json.format = "date-time";
      break;
    case "array":
    case "tuple":
      type = "array";
      break;
    case "object":
      type = "object";
      break;
    default:
      // "mixed" and anything unrecognised: unconstrained.
      break;
  }

  for (const test of desc.tests) {
    const params = test.params ?? {};
    // The numeric tests are keyed off the local `type`, which an `integer`
    // test may already have narrowed — both spellings count as numeric.
    const numeric = type === "number" || type === "integer";
    switch (test.name) {
      case "min":
        if (typeof params.min === "number") {
          if (type === "string") json.minLength = params.min;
          else if (type === "array") json.minItems = params.min;
          else if (numeric) json.minimum = params.min;
        }
        // yup's `moreThan(n)` reports as `min` with `params.more`.
        if (typeof params.more === "number")
          json.exclusiveMinimum = params.more;
        break;
      case "max":
        if (typeof params.max === "number") {
          if (type === "string") json.maxLength = params.max;
          else if (type === "array") json.maxItems = params.max;
          else if (numeric) json.maximum = params.max;
        }
        // yup's `lessThan(n)` reports as `max` with `params.less`.
        if (typeof params.less === "number")
          json.exclusiveMaximum = params.less;
        break;
      case "length":
        if (typeof params.length === "number") {
          if (type === "string") {
            json.minLength = params.length;
            json.maxLength = params.length;
          } else if (type === "array") {
            json.minItems = params.length;
            json.maxItems = params.length;
          }
        }
        break;
      case "integer":
        if (type === "number") type = "integer";
        break;
      case "email":
        if (type === "string") json.format = "email";
        break;
      case "url":
        if (type === "string") json.format = "uri";
        break;
      case "matches": {
        const regex = params.regex;
        if (regex instanceof RegExp && type === "string") {
          json.pattern = regex.source;
        }
        break;
      }
      default:
        break;
    }
  }

  if (type !== undefined) json.type = type;

  if (desc.oneOf.length > 0) {
    json.enum = [...desc.oneOf, ...(desc.nullable ? [null] : [])];
  }
  if (desc.notOneOf.length > 0) {
    json.not = { enum: [...desc.notOneOf] };
  }

  if (desc.type === "object" && desc.fields !== undefined) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, field] of Object.entries(desc.fields)) {
      properties[key] = yupNode(field, dialect);
      if (!field.optional) required.push(key);
    }
    json.properties = properties;
    if (required.length > 0) json.required = required;
  } else if (
    desc.type === "array" &&
    desc.innerType !== undefined &&
    !Array.isArray(desc.innerType)
  ) {
    json.items = yupNode(desc.innerType as YupDescription, dialect);
  } else if (desc.type === "tuple" && Array.isArray(desc.innerType)) {
    json.prefixItems = (desc.innerType as readonly YupDescription[]).map(
      (member) => yupNode(member, dialect),
    );
    json.items = false;
  }

  if (desc.nullable && desc.oneOf.length === 0) {
    if (dialect === "openapi-3.0") {
      json.nullable = true;
    } else if (typeof json.type === "string") {
      json.type = [json.type, "null"];
    } else {
      const base = { ...json };
      for (const key of Object.keys(json)) delete json[key];
      json.anyOf = [base, { type: "null" }];
    }
  }

  if (desc.default !== undefined) json.default = desc.default;
  return json;
}

/**
 * yup, mapped from the schema's own `.describe()` (§4.2 — yup ships no
 * converter of its own). Covers `min`/`max`/`length`/`integer`/`email`/`url`/
 * `matches` (its `params.regex`'s `.source`, never a stringified `RegExp`),
 * `oneOf` → `enum`, `notOneOf` → `not.enum`, objects' `fields` and
 * `required`, arrays' `innerType` and tuples' `prefixItems`. Anything else
 * degrades: the node emits what it has and no more.
 */
export const yupConverter: JsonSchemaConverter = (schema, context) => {
  const describe = (schema as { describe?: unknown }).describe;
  if (typeof describe !== "function") return undefined;
  let desc: unknown;
  try {
    desc = describe.call(schema);
  } catch {
    return undefined;
  }
  if (!isPlainObject(desc) || typeof desc.type !== "string") return undefined;
  return yupNode(desc as unknown as YupDescription, context.dialect);
};

/**
 * bun-jobs' `s`: its schema **is** JSON Schema already, read from `.json`
 * (deep-frozen; returned as-is, which keeps the identity `liftComponents`
 * dedups on — `s.object({ a: A, b: A })` holds `A.json` itself at both
 * positions). A skew fallback only: since V4, `s` carries
 * `~standard.jsonSchema` and takes the primary path, so this runs for a
 * stale bun-jobs or a hand-built lookalike.
 */
export const bunJobsConverter: JsonSchemaConverter = (schema) => {
  const json = (schema as { json?: unknown }).json;
  return isPlainObject(json) ? json : undefined;
};

/**
 * Builds the valibot converter around `@valibot/to-json-schema`'s
 * `toJsonSchema`. valibot core carries no `~standard.jsonSchema` (measured
 * against valibot 1.5.0), so the function is injected rather than imported —
 * the same structural rule the logging adapters follow.
 *
 * Runs degraded (`errorMode: "ignore"`): a transform converts as its input
 * side rather than throwing (measured against `@valibot/to-json-schema`
 * 1.8.0).
 *
 * Not needed if the schema was wrapped with that package's
 * `toStandardJsonSchema`, which adds `~standard.jsonSchema` and so takes the
 * primary path with no registration at all.
 *
 * @example
 * ```ts
 * import { toJsonSchema } from "@valibot/to-json-schema";
 * registerJsonSchemaConverter("valibot", valibotConverter(toJsonSchema));
 * ```
 */
export function valibotConverter<S>(
  toJsonSchema: (
    schema: S,
    config?: {
      readonly target?: "draft-2020-12" | "openapi-3.0";
      readonly errorMode?: "throw" | "warn" | "ignore";
    },
  ) => unknown,
): JsonSchemaConverter {
  return (schema, context) => {
    let json: unknown;
    try {
      // The cast: the converter is registered for the vendor whose schemas
      // the injected function converts — structurally, the rule this whole
      // module follows.
      json = toJsonSchema(schema as S, {
        target: context.dialect,
        errorMode: "ignore",
      });
    } catch {
      return undefined;
    }
    return isPlainObject(json) ? json : undefined;
  };
}
