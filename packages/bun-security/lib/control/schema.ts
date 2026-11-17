/**
 * A small schema builder for the management API's requests and responses
 * (control-plane.md §2.3, §4): each schema is a Standard Schema that also
 * carries its JSON Schema (the Standard JSON Schema converter, through
 * bun-common's `withJsonSchema`), so bun-common's `validate()` checks a
 * route both ways and `generateOpenApi()` documents it, with no dependency.
 *
 * It covers what the API's documents need and no more: strings, whole
 * numbers, booleans, literals, arrays, records, objects with optional keys
 * (no unknown key accepted), nullables, any JSON value, and query objects
 * whose values arrive as strings.
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import { withJsonSchema } from "@kingsleyweb/bun-common";

/** A JSON Schema object, as the documents carry it. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** One problem a schema found, at `path`. */
interface Issue {
  /** What is wrong. */
  readonly message: string;
  /** Where, from the validated value's root. */
  readonly path: readonly (string | number)[];
}

/** A schema: a Standard Schema with its JSON Schema and a direct checker. */
export interface Schema<T> extends StandardSchemaV1<unknown, T> {
  /** The JSON Schema it documents. */
  readonly json: JsonSchema;
  /** Checks `value` at `path`, adding issues; the value it produces. */
  readonly check: (
    value: unknown,
    path: readonly (string | number)[],
    issues: Issue[],
  ) => T;
  /** Whether an object may leave this key out (set by {@link s.optional}). */
  readonly optional?: boolean;
  /** Whether a query string's text is converted for it (numbers, booleans, lists). */
  readonly coerce?: "number" | "boolean" | "list";
}

/** The value a schema produces. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

/** An object shape: a schema per key. */
type Shape = Readonly<Record<string, Schema<unknown>>>;

/** The keys of `S` an object may leave out. */
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends { readonly optional: true } ? K : never;
}[keyof S];

/** The object a shape produces. */
export type InferShape<S extends Shape> = {
  readonly [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]>;
} & {
  readonly [K in OptionalKeys<S>]?: Infer<S[K]>;
};

/** Describes a value for a message. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object"
    ? "an object"
    : `${typeof value} ${JSON.stringify(value)}`;
}

/** A schema from its JSON Schema and checker. */
function make<T>(
  json: JsonSchema,
  check: Schema<T>["check"],
  extra: { optional?: boolean; coerce?: Schema<T>["coerce"] } = {},
): Schema<T> {
  const schema = {
    json,
    check,
    ...(extra.optional === true ? { optional: true as const } : {}),
    ...(extra.coerce === undefined ? {} : { coerce: extra.coerce }),
    "~standard": {
      version: 1 as const,
      vendor: "bun-security",
      validate: (value: unknown): StandardSchemaV1.Result<T> => {
        const issues: Issue[] = [];
        const out = check(value, [], issues);
        return issues.length === 0
          ? { value: out }
          : {
              issues: issues.map((issue) => ({
                message: issue.message,
                path: [...issue.path],
              })),
            };
      },
    },
  };
  return withJsonSchema(schema, json);
}

/** String options. */
interface StringOptions {
  /** The shortest. Default 0. */
  readonly min?: number;
  /** The longest. Default 10,000. */
  readonly max?: number;
  /** A pattern the whole string must match. */
  readonly pattern?: RegExp;
  /** A description for the document. */
  readonly description?: string;
}

/** Number options. */
interface NumberOptions {
  /** The least. */
  readonly min?: number;
  /** The most. */
  readonly max?: number;
  /** A description for the document. */
  readonly description?: string;
}

/** The builder. */
export const s = {
  /** A string. */
  string(options: StringOptions = {}): Schema<string> {
    const max = options.max ?? 10_000;
    return make<string>(
      {
        type: "string",
        ...(options.min === undefined ? {} : { minLength: options.min }),
        maxLength: max,
        ...(options.pattern === undefined
          ? {}
          : { pattern: options.pattern.source }),
        ...(options.description === undefined
          ? {}
          : { description: options.description }),
      },
      (value, path, issues) => {
        if (typeof value !== "string") {
          issues.push({
            message: `must be a string; got ${describe(value)}`,
            path,
          });
        } else if (value.length < (options.min ?? 0) || value.length > max) {
          issues.push({
            message: `must be ${options.min ?? 0} to ${max} characters long`,
            path,
          });
        } else if (
          options.pattern !== undefined &&
          !options.pattern.test(value)
        ) {
          issues.push({
            message: `must match ${options.pattern.source}`,
            path,
          });
        }
        return value as string;
      },
    );
  },

  /** A whole number. */
  int(options: NumberOptions = {}): Schema<number> {
    return make<number>(
      {
        type: "integer",
        ...(options.min === undefined ? {} : { minimum: options.min }),
        ...(options.max === undefined ? {} : { maximum: options.max }),
        ...(options.description === undefined
          ? {}
          : { description: options.description }),
      },
      (value, path, issues) => {
        if (!Number.isSafeInteger(value)) {
          issues.push({
            message: `must be a whole number; got ${describe(value)}`,
            path,
          });
        } else if (
          (options.min !== undefined && (value as number) < options.min) ||
          (options.max !== undefined && (value as number) > options.max)
        ) {
          issues.push({
            message: `must be from ${options.min ?? "-∞"} to ${options.max ?? "∞"}`,
            path,
          });
        }
        return value as number;
      },
      { coerce: "number" },
    );
  },

  /** `true` or `false`. */
  boolean(description?: string): Schema<boolean> {
    return make<boolean>(
      {
        type: "boolean",
        ...(description === undefined ? {} : { description }),
      },
      (value, path, issues) => {
        if (typeof value !== "boolean") {
          issues.push({
            message: `must be true or false; got ${describe(value)}`,
            path,
          });
        }
        return value as boolean;
      },
      { coerce: "boolean" },
    );
  },

  /** One of `values`. */
  enum<const T extends string>(
    values: readonly T[],
    description?: string,
  ): Schema<T> {
    return make<T>(
      {
        type: "string",
        enum: [...values],
        ...(description === undefined ? {} : { description }),
      },
      (value, path, issues) => {
        if (!values.includes(value as T)) {
          issues.push({
            message: `must be one of ${values.join(", ")}; got ${describe(value)}`,
            path,
          });
        }
        return value as T;
      },
    );
  },

  /** An array of `item`, at most `max` long. */
  array<T>(item: Schema<T>, max = 1_000): Schema<T[]> {
    return make<T[]>(
      { type: "array", items: item.json, maxItems: max },
      (value, path, issues) => {
        if (!Array.isArray(value)) {
          issues.push({
            message: `must be an array; got ${describe(value)}`,
            path,
          });
          return value as T[];
        }
        if (value.length > max) {
          issues.push({ message: `must have at most ${max} items`, path });
          return value as T[];
        }
        return value.map((entry, at) =>
          item.check(entry, [...path, at], issues),
        );
      },
      { coerce: "list" },
    );
  },

  /** An object of string keys to `value`, at most `max` keys. */
  record<T>(value: Schema<T>, max = 100): Schema<Record<string, T>> {
    return make<Record<string, T>>(
      { type: "object", additionalProperties: value.json, maxProperties: max },
      (input, path, issues) => {
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input)
        ) {
          issues.push({
            message: `must be an object; got ${describe(input)}`,
            path,
          });
          return input as Record<string, T>;
        }
        const entries = Object.entries(input);
        if (entries.length > max) {
          issues.push({ message: `must have at most ${max} keys`, path });
        }
        const out: Record<string, T> = {};
        for (const [key, entry] of entries)
          out[key] = value.check(entry, [...path, key], issues);
        return out;
      },
    );
  },

  /** An object with exactly `shape`'s keys (optional ones may be absent); no other key. */
  object<const S extends Shape>(
    shape: S,
    description?: string,
  ): Schema<InferShape<S>> {
    const required = Object.entries(shape)
      .filter(([, schema]) => schema.optional !== true)
      .map(([key]) => key);
    return make<InferShape<S>>(
      {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(shape).map(([key, schema]) => [key, schema.json]),
        ),
        ...(required.length === 0 ? {} : { required }),
        additionalProperties: false,
        ...(description === undefined ? {} : { description }),
      },
      (value, path, issues) => {
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value)
        ) {
          issues.push({
            message: `must be an object; got ${describe(value)}`,
            path,
          });
          return value as InferShape<S>;
        }
        const input = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(input)) {
          if (!(key in shape))
            issues.push({
              message: "is not a known key",
              path: [...path, key],
            });
        }
        for (const [key, schema] of Object.entries(shape)) {
          if (input[key] === undefined) {
            if (schema.optional !== true)
              issues.push({ message: "is required", path: [...path, key] });
            continue;
          }
          out[key] = schema.check(input[key], [...path, key], issues);
        }
        return out as InferShape<S>;
      },
    );
  },

  /**
   * A query object: `shape`'s keys, each read from its string (a whole
   * number, a boolean, a comma-separated list) before it is checked.
   */
  query<const S extends Shape>(shape: S): Schema<InferShape<S>> {
    const inner = s.object(shape);
    return make<InferShape<S>>(inner.json, (value, path, issues) => {
      if (typeof value !== "object" || value === null)
        return inner.check(value, path, issues);
      const coerced: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(
        value as Record<string, unknown>,
      )) {
        const schema = shape[key];
        const text = Array.isArray(raw) ? raw.join(",") : raw;
        if (
          schema?.coerce === "number" &&
          typeof text === "string" &&
          /^-?\d+$/.test(text)
        ) {
          coerced[key] = Number(text);
        } else if (
          schema?.coerce === "boolean" &&
          (text === "true" || text === "false")
        ) {
          coerced[key] = text === "true";
        } else if (schema?.coerce === "list" && typeof text === "string") {
          coerced[key] = text === "" ? [] : text.split(",");
        } else {
          coerced[key] = text;
        }
      }
      return inner.check(coerced, path, issues);
    });
  },

  /** `schema`, or absent from its object. */
  optional<T>(schema: Schema<T>): Schema<T> & { readonly optional: true } {
    return make<T>(schema.json, schema.check, {
      optional: true,
      ...(schema.coerce === undefined ? {} : { coerce: schema.coerce }),
    }) as Schema<T> & { readonly optional: true };
  },

  /** `schema`, or `null`. */
  nullable<T>(schema: Schema<T>): Schema<T | null> {
    return make<T | null>(
      { anyOf: [schema.json, { type: "null" }] },
      (value, path, issues) =>
        value === null ? null : schema.check(value, path, issues),
      schema.coerce === undefined ? {} : { coerce: schema.coerce },
    );
  },

  /** Any JSON value; `description` says what it is. */
  json(description: string): Schema<unknown> {
    return make<unknown>({ description }, (value) => value);
  },

  /** A JSON object, checked only for being one; `description` says what it is. */
  anyObject(description: string): Schema<Readonly<Record<string, unknown>>> {
    return make<Readonly<Record<string, unknown>>>(
      { type: "object", description },
      (value, path, issues) => {
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value)
        ) {
          issues.push({
            message: `must be an object; got ${describe(value)}`,
            path,
          });
        }
        return value as Readonly<Record<string, unknown>>;
      },
    );
  },
};
