import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type { JsonSchema, JsonSchemaType } from "./validate";
import { ConfigError } from "../../shared/errors";
import { compilePattern, registerEnumHints, validateJson } from "./validate";

/**
 * The management API's schema builder.
 *
 * One definition feeds three consumers: the request validator (through
 * Standard Schema, so bun-common's `validate()` accepts it unchanged), the
 * TypeScript types handlers see (through {@link Infer}), and the OpenAPI and
 * AsyncAPI documents (through {@link Schema.json}). Writing the types and the
 * JSON Schema separately is exactly how the two drift apart, and a spec that
 * describes a different API from the one routed is worse than no spec.
 *
 * Deliberately small: it emits only the JSON Schema keywords the validator in
 * `validate.ts` interprets, and nothing a draft-07 (AsyncAPI) reader would
 * misread. Anything richer is a sign the route wants a simpler contract.
 */

/** Marks a {@link Schema} that fills in a value when its input is absent. */
declare const HAS_DEFAULT: unique symbol;

/**
 * A validator, a TypeScript type and a JSON Schema in one value.
 *
 * `TOut` is what validation produces (after defaults and coercion), `TIn` what
 * it accepts. Implements Standard Schema V1, so it can be handed to
 * bun-common's `validate()` or to anything else that speaks the spec.
 */
export interface Schema<TOut, TIn = TOut> extends StandardSchemaV1<TIn, TOut> {
  /**
   * The JSON Schema, deep-frozen. Nested schemas appear inlined by identity:
   * `s.object({ a: A })` holds `A.json` itself under `properties.a`, which is
   * how {@link toJsonSchema} recognises a named component to emit as `$ref`.
   */
  readonly json: JsonSchema;
  /** Component name, when registered with `s.named`; emitted as `$ref`. */
  readonly ref?: string;
  /**
   * Whether string input is coerced before validation (`s.query`): numbers and
   * booleans from strings, arrays from repeated keys or comma-separated values.
   */
  readonly coerce: boolean;
  /** Type-only marker: `true` when the schema supplies a default. Never set at runtime. */
  readonly [HAS_DEFAULT]?: boolean;
}

/** A schema that supplies a default, so an optional property of it is never absent in the output. */
export type DefaultedSchema<TOut, TIn = TOut> = Schema<TOut, TIn> & {
  /** Type-only marker; see {@link Schema}. */
  readonly [HAS_DEFAULT]?: true;
};

/** The output type a schema validates into. */
export type Infer<S> = S extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<S>
  : never;

/** Wraps a property schema to make the property optional in `s.object`. */
export interface Optional<S extends Schema<any, any>> {
  /** Discriminates an optional wrapper from a schema. */
  readonly optional: true;
  /** The property's schema. */
  readonly schema: S;
}

/** Anything `s.object` accepts as a property. */
export type PropertySchema = Schema<any, any> | Optional<Schema<any, any>>;

/** Flattens an intersection into one object type, so equality checks see a plain shape. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Keys whose property is optional and has no default to fill it. */
type OptionalKeys<P> = {
  [K in keyof P]: P[K] extends Optional<infer S>
    ? S extends { readonly [HAS_DEFAULT]?: true }
      ? never
      : K
    : never;
}[keyof P];

/** The value type of one property, unwrapping `Optional`. */
type PropertyOut<T> = T extends Optional<infer S> ? Infer<S> : Infer<T>;

/** The output type of `s.object(props)`. */
export type ObjectOut<P extends Record<string, PropertySchema>> = Simplify<
  {
    [K in Exclude<keyof P, OptionalKeys<P>>]: PropertyOut<P[K]>;
  } & {
    [K in OptionalKeys<P>]?: PropertyOut<P[K]>;
  }
>;

/** Options every builder accepts. */
interface BaseOptions {
  /** Human description, emitted into the JSON Schema and the docs. */
  description?: string;
}

/** Options for `s.string`. */
export interface StringOptions extends BaseOptions {
  /** Fewest characters (Unicode code points) allowed. */
  minLength?: number;
  /** Most characters (Unicode code points) allowed. */
  maxLength?: number;
  /**
   * A regular expression the whole value must match somewhere in (JSON Schema
   * semantics: unanchored unless the pattern anchors itself). Compiled once
   * here with the `u` flag. Must come from this package's code — never from
   * request input — and a `RegExp` may carry no flags, since JSON Schema cannot
   * express them.
   */
  pattern?: string | RegExp;
  /** A format the value must also satisfy. Only RFC 3339 `date-time` is supported. */
  format?: "date-time";
  /** Value used when the input is absent. */
  default?: string;
}

/** Options for `s.integer` and `s.number`. */
export interface NumberOptions extends BaseOptions {
  /** Smallest value allowed, inclusive. */
  minimum?: number;
  /** Largest value allowed, inclusive. */
  maximum?: number;
  /** Value used when the input is absent. */
  default?: number;
}

/** Options for `s.boolean`. */
export interface BooleanOptions extends BaseOptions {
  /** Value used when the input is absent. */
  default?: boolean;
}

/** Options for `s.enum`. */
export interface EnumOptions<T extends string> extends BaseOptions {
  /** Value used when the input is absent. */
  default?: T;
  /**
   * Text appended to the validation message when the input is one of these
   * refused strings — a retired spelling pointing at its replacement. Only
   * the message changes: the value is still refused, and the hints are not
   * emitted into the OpenAPI document.
   */
  hints?: Readonly<Record<string, string>>;
}

/** Options for `s.array`. */
export interface ArrayOptions extends BaseOptions {
  /** Fewest items allowed. */
  minItems?: number;
  /** Most items allowed. */
  maxItems?: number;
}

/** Options for `s.object`. */
export interface ObjectOptions extends BaseOptions {
  /**
   * What to do with properties not listed. `false` (the default) rejects them,
   * `true` passes them through untouched, a schema validates each one.
   */
  additionalProperties?: boolean | Schema<any, any>;
}

/** Schema names are OpenAPI component keys, which allow only these characters. */
const COMPONENT_NAME = /^[\w.-]+$/;

/** Freezes a JSON Schema node and everything it holds that is not already frozen. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

/** Drops `undefined` entries, so an unset option never appears as a keyword. */
function compact(node: Record<string, unknown>): JsonSchema {
  for (const key of Object.keys(node)) {
    if (node[key] === undefined) {
      delete node[key];
    }
  }
  return node as JsonSchema;
}

/** Checks a numeric bound given to a builder is a finite number. */
function assertBound(value: number | undefined, what: string): void {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new ConfigError(`${what} must be a finite number`, { value });
  }
}

/** Checks a length or count bound is a non-negative integer. */
function assertCount(value: number | undefined, what: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new ConfigError(`${what} must be a non-negative integer`, { value });
  }
}

/** Builds the schema object around a JSON Schema node. */
function make<TOut, TIn = TOut>(
  json: JsonSchema,
  extra?: { ref?: string; coerce?: boolean },
): Schema<TOut, TIn> {
  const frozen = deepFreeze(json);
  const coerce = extra?.coerce ?? false;
  // Compile any pattern now, so a bad one fails where it is written rather
  // than on the first request that reaches it.
  if (typeof frozen.pattern === "string") {
    compilePattern(frozen);
  }

  const schema: Schema<TOut, TIn> = {
    json: frozen,
    coerce,
    ...(extra?.ref === undefined ? {} : { ref: extra.ref }),
    "~standard": {
      version: 1,
      vendor: "bun-jobs",
      validate: (value: unknown) =>
        validateJson(frozen, value, {
          coerce,
        }) as StandardSchemaV1.Result<TOut>,
    },
  };
  return Object.freeze(schema);
}

/** Component names by JSON node, so `toJsonSchema` can emit `$ref`s. */
const NAMED = new WeakMap<JsonSchema, string>();

/**
 * Keywords emitted into the documents but not validated, by JSON node: see
 * {@link s.documented}.
 */
const DOCUMENTED = new WeakMap<JsonSchema, Readonly<Record<string, unknown>>>();

/** The component name registered for a JSON node, if any. */
export function namedSchemaOf(json: JsonSchema): string | undefined {
  return NAMED.get(json);
}

/** Resolves a property entry to its schema. */
function unwrap(entry: PropertySchema): {
  schema: Schema<any, any>;
  optional: boolean;
} {
  return "optional" in entry && entry.optional === true
    ? { schema: entry.schema, optional: true }
    : { schema: entry as Schema<any, any>, optional: false };
}

/** Builds the JSON node for a scalar type, with a description and default. */
function scalar(
  type: JsonSchemaType,
  options: BaseOptions & { default?: unknown },
  keywords: Record<string, unknown>,
): JsonSchema {
  return compact({
    type,
    ...keywords,
    description: options.description,
    default: options.default,
  });
}

/** The builder. */
export const s = {
  /** A string. */
  string<const O extends StringOptions>(
    options?: O,
  ): O extends { default: string } ? DefaultedSchema<string> : Schema<string> {
    const o: StringOptions = options ?? {};
    assertCount(o.minLength, "minLength");
    assertCount(o.maxLength, "maxLength");
    let pattern: string | undefined;
    if (o.pattern instanceof RegExp) {
      if (o.pattern.flags !== "" && o.pattern.flags !== "u") {
        throw new ConfigError(
          "A schema pattern may carry no flags: JSON Schema cannot express them",
          { pattern: String(o.pattern) },
        );
      }
      pattern = o.pattern.source;
    } else {
      pattern = o.pattern;
    }
    return make(
      scalar("string", o, {
        minLength: o.minLength,
        maxLength: o.maxLength,
        pattern,
        format: o.format,
      }),
    ) as never;
  },

  /** A whole number. */
  integer<const O extends NumberOptions>(
    options?: O,
  ): O extends { default: number } ? DefaultedSchema<number> : Schema<number> {
    const o: NumberOptions = options ?? {};
    assertBound(o.minimum, "minimum");
    assertBound(o.maximum, "maximum");
    return make(
      scalar("integer", o, { minimum: o.minimum, maximum: o.maximum }),
    ) as never;
  },

  /** A finite number. */
  number<const O extends NumberOptions>(
    options?: O,
  ): O extends { default: number } ? DefaultedSchema<number> : Schema<number> {
    const o: NumberOptions = options ?? {};
    assertBound(o.minimum, "minimum");
    assertBound(o.maximum, "maximum");
    return make(
      scalar("number", o, { minimum: o.minimum, maximum: o.maximum }),
    ) as never;
  },

  /** `true` or `false`. */
  boolean<const O extends BooleanOptions>(
    options?: O,
  ): O extends { default: boolean }
    ? DefaultedSchema<boolean>
    : Schema<boolean> {
    return make(scalar("boolean", options ?? {}, {})) as never;
  },

  /** Exactly one value. */
  literal<const T extends string | number | boolean>(
    value: T,
    options?: BaseOptions,
  ): Schema<T> {
    const type: JsonSchemaType =
      typeof value === "string"
        ? "string"
        : typeof value === "boolean"
          ? "boolean"
          : Number.isInteger(value)
            ? "integer"
            : "number";
    return make(
      compact({ type, const: value, description: options?.description }),
    );
  },

  /** One of a fixed list of strings. */
  enum<
    const T extends readonly [string, ...string[]],
    const O extends EnumOptions<T[number]> = EnumOptions<T[number]>,
  >(
    values: T,
    options?: O,
  ): O extends { default: string }
    ? DefaultedSchema<T[number]>
    : Schema<T[number]> {
    if (new Set(values).size !== values.length) {
      throw new ConfigError("An enum schema may not repeat a value", {
        values: [...values],
      });
    }
    const schema = make(scalar("string", options ?? {}, { enum: [...values] }));
    if (options?.hints) {
      registerEnumHints(schema.json, options.hints);
    }
    return schema as never;
  },

  /** A list of one item type. */
  array<S extends Schema<any, any>>(
    item: S,
    options?: ArrayOptions,
  ): Schema<Infer<S>[]> {
    const o = options ?? {};
    assertCount(o.minItems, "minItems");
    assertCount(o.maxItems, "maxItems");
    return make(
      compact({
        type: "array",
        items: item.json,
        minItems: o.minItems,
        maxItems: o.maxItems,
        description: o.description,
      }),
    );
  },

  /** An object with known properties. */
  object<const P extends Record<string, PropertySchema>>(
    properties: P,
    options?: ObjectOptions,
  ): Schema<ObjectOut<P>> {
    const props: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, entry] of Object.entries(properties)) {
      const { schema, optional } = unwrap(entry);
      props[key] = schema.json;
      // A property with a default is filled in when absent, so a client need
      // not send it: it is not `required` in the JSON Schema either.
      if (!optional && schema.json.default === undefined) {
        required.push(key);
      }
    }
    const additional = options?.additionalProperties ?? false;
    return make(
      compact({
        type: "object",
        properties: props,
        required: required.length > 0 ? required : undefined,
        additionalProperties:
          typeof additional === "boolean" ? additional : additional.json,
        description: options?.description,
      }),
    );
  },

  /** An object whose keys are free and whose values share one schema. */
  record<S extends Schema<any, any>>(
    value: S,
    options?: BaseOptions,
  ): Schema<Record<string, Infer<S>>> {
    return make(
      compact({
        type: "object",
        additionalProperties: value.json,
        description: options?.description,
      }),
    );
  },

  /** Marks an `s.object` property optional. */
  optional<S extends Schema<any, any>>(schema: S): Optional<S> {
    return Object.freeze({ optional: true as const, schema });
  },

  /** Also accepts `null`. */
  nullable<S extends Schema<any, any>>(schema: S): Schema<Infer<S> | null> {
    return make(compact({ anyOf: [schema.json, { type: "null" }] }));
  },

  /**
   * Any one of several schemas (`anyOf`). The first member that accepts the
   * value produces the output, so list the most specific first.
   */
  union<const S extends readonly [Schema<any, any>, ...Schema<any, any>[]]>(
    ...members: S
  ): Schema<Infer<S[number]>> {
    return make(compact({ anyOf: members.map((member) => member.json) }));
  },

  /** Anything at all (`{}`). */
  unknown(options?: BaseOptions): Schema<unknown> {
    return make(compact({ description: options?.description }));
  },

  /**
   * Registers a schema as a named component: the specs emit it once under
   * `components.schemas.<name>` and reference it with `$ref` everywhere else.
   * Returns a new schema; the one passed in is unchanged.
   */
  named<S extends Schema<any, any>>(name: string, schema: S): S {
    if (!COMPONENT_NAME.test(name)) {
      throw new ConfigError(
        `Schema name "${name}" may only contain letters, digits, "_", "." and "-"`,
        { name },
      );
    }
    // A copy, so the node's identity is this component's alone: naming a
    // shared schema twice must not make one of the names disappear.
    const json = deepFreeze({ ...schema.json });
    NAMED.set(json, name);
    return make(json, { ref: name, coerce: schema.coerce }) as S;
  },

  /**
   * Adds keywords to what the documents say about a schema **without the
   * validator enforcing them**, for a rule a route enforces itself with its
   * own error. A `:queue` path segment is the case: the route checks it with
   * the drivers' key rule and answers 400 `INVALID_NAME`, and the document
   * should still state the pattern a client must follow. Only for keywords
   * that describe exactly what the route enforces — or, like `deprecated`,
   * that describe the field rather than constrain it. Returns a new schema;
   * the one passed in is unchanged.
   */
  documented<S extends Schema<any, any>>(
    schema: S,
    keywords: {
      /** A pattern the route enforces itself, with its own error. */
      pattern?: string;
      /** Marks the property deprecated in the documents; still sent and accepted. */
      deprecated?: boolean;
    },
  ): S {
    if (keywords.pattern !== undefined) {
      // Compiled now, so a bad pattern fails where it is written.
      compilePattern({ pattern: keywords.pattern });
    }
    const json = deepFreeze({ ...schema.json });
    const name = NAMED.get(schema.json);
    if (name !== undefined) {
      NAMED.set(json, name);
    }
    DOCUMENTED.set(json, Object.freeze({ ...keywords }));
    return make(json, { ref: schema.ref, coerce: schema.coerce }) as S;
  },

  /**
   * Coerces string input before validating: `"42"` to `42` where a number is
   * expected, `"true"`/`"false"` (and `"1"`/`"0"`) to booleans, and a
   * comma-separated value or a single value into an array. Use for `query` and
   * `params`, whose values always arrive as strings.
   */
  query<S extends Schema<any, any>>(schema: S): S {
    return make(schema.json, { ref: schema.ref, coerce: true }) as S;
  },
};

/** Options for {@link toJsonSchema}. */
export interface ToJsonSchemaOptions {
  /** Prefix a component name is appended to. Defaults to `"#/components/schemas/"`. */
  refPrefix?: string;
  /**
   * Collects every component reached, by name. Pass one map across several
   * calls to gather a document's `components.schemas`.
   */
  components?: Map<string, JsonSchema>;
  /** Emit the root in full even when it is a named component. Defaults to `false`. */
  inlineRoot?: boolean;
  /**
   * The schema each component name stands for, shared across calls. Pass one
   * map for a whole document: two different schemas registered under one
   * name anywhere in it then throw `ConfigError`, instead of the later one
   * silently replacing the earlier. Defaults to a map for this call alone.
   */
  names?: Map<string, JsonSchema>;
}

/**
 * Emits a schema for a document: every named component replaced by a `$ref`,
 * and its body collected into `options.components`. Returns fresh, unfrozen
 * objects, safe to hand to a caller.
 */
export function toJsonSchema(
  schema: Schema<any, any> | JsonSchema,
  options?: ToJsonSchemaOptions,
): JsonSchema {
  const prefix = options?.refPrefix ?? "#/components/schemas/";
  const components = options?.components ?? new Map<string, JsonSchema>();
  const root =
    "~standard" in schema ? (schema as Schema<any, any>).json : schema;
  /** Nodes already emitted as components, to tell a name clash from a revisit. */
  const bodies = options?.names ?? new Map<string, JsonSchema>();

  const emit = (node: JsonSchema, inline: boolean): JsonSchema => {
    const name = NAMED.get(node);
    if (name !== undefined && !inline) {
      const seen = bodies.get(name);
      if (seen === undefined) {
        bodies.set(name, node);
        components.set(name, emit(node, true));
      } else if (seen !== node) {
        throw new ConfigError(
          `Two different schemas are both named "${name}"`,
          { name },
        );
      }
      return { $ref: `${prefix}${name}` };
    }

    const out: Record<string, unknown> = {
      ...node,
      ...DOCUMENTED.get(node),
    };
    if (node.properties) {
      out.properties = Object.fromEntries(
        Object.entries(node.properties).map(([key, child]) => [
          key,
          emit(child, false),
        ]),
      );
    }
    if (
      node.additionalProperties &&
      typeof node.additionalProperties === "object"
    ) {
      out.additionalProperties = emit(node.additionalProperties, false);
    }
    if (node.items) {
      out.items = emit(node.items, false);
    }
    if (node.anyOf) {
      out.anyOf = node.anyOf.map((member) => emit(member, false));
    }
    for (const key of ["required", "enum"] as const) {
      if (Array.isArray(node[key])) {
        out[key] = [...(node[key] as unknown[])];
      }
    }
    return out as JsonSchema;
  };

  const inlineRoot = options?.inlineRoot ?? false;
  const rootName = NAMED.get(root);
  if (inlineRoot && rootName !== undefined) {
    // An inlined root is still that component's body: claim the name, so a
    // different schema under the same name elsewhere in the document clashes.
    const claimed = bodies.get(rootName);
    if (claimed !== undefined && claimed !== root) {
      throw new ConfigError(
        `Two different schemas are both named "${rootName}"`,
        { name: rootName },
      );
    }
    bodies.set(rootName, root);
  }
  return emit(root, inlineRoot);
}
