/**
 * Schemas the core builds: `recordOf` (a schema over a record of schemas),
 * `documented` (a JSON Schema that documents and never checks), and the
 * markers describeContract reads.
 */
import type { StandardSchemaV1 } from "../types/standardSchema";
import type { ContractKind, MaybePromise, Schema } from "./model";

/**
 * The options a JSON Schema converter takes, as the Standard JSON Schema
 * spec (`StandardJSONSchemaV1.Options`) defines them. To be replaced by the
 * vendored spec types (AD (b0)); its name is not approved.
 *
 * @internal
 */
export interface JsonSchemaOptions {
  /** The JSON Schema dialect wanted: `"draft-2020-12"`, `"draft-07"`, `"openapi-3.0"`, or another. */
  readonly target: string;
  /** Vendor-specific options, passed through. */
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

/**
 * A Standard JSON Schema converter (`~standard.jsonSchema`): one JSON Schema
 * for what a schema accepts, one for what it produces. To be replaced by the
 * vendored spec types (AD (b0)); its name is not approved.
 *
 * @internal
 */
export interface JsonSchemaConverter {
  /** The JSON Schema of the schema's input. */
  readonly input: (options: JsonSchemaOptions) => Record<string, unknown>;
  /** The JSON Schema of the schema's output. */
  readonly output: (options: JsonSchemaOptions) => Record<string, unknown>;
}

/**
 * A JSON Schema given to `documented()` or `toStandardSchema()`: one JSON
 * Schema object (the same for input and output, whatever the target), or a
 * {@link JsonSchemaConverter}. Its name is not approved.
 *
 * @internal
 */
export type JsonSchemaSource = Record<string, unknown> | JsonSchemaConverter;

/** A Standard Schema whose `~standard` also carries a JSON Schema converter. */
export interface SchemaWithJson<
  Input = unknown,
  Output = Input,
> extends StandardSchemaV1<Input, Output> {
  /** The Standard Schema properties, with the converter. */
  readonly "~standard": StandardSchemaV1.Props<Input, Output> & {
    /** The JSON Schema converter (Standard JSON Schema). */
    readonly jsonSchema: JsonSchemaConverter;
  };
}

/** Marks a schema as documentation only (`documented()`). */
const DOCUMENTED: unique symbol = Symbol.for("bun-validate.documented");
/** Marks a schema with its body kind (V3a/V3b's `chunks()`, `sse()`, `opaque()`). */
const KIND: unique symbol = Symbol.for("bun-validate.kind");
/** Marks a schema the framework declared on its own (plan §4.12 m5). */
const IMPLICIT: unique symbol = Symbol.for("bun-validate.implicit");

/** Whether `source` is a converter rather than one JSON Schema object. */
function isConverter(source: JsonSchemaSource): source is JsonSchemaConverter {
  return (
    typeof (source as Partial<JsonSchemaConverter>).input === "function" &&
    typeof (source as Partial<JsonSchemaConverter>).output === "function"
  );
}

/** A converter from a {@link JsonSchemaSource}; a plain object is returned as a copy each call. */
export function toConverter(source: JsonSchemaSource): JsonSchemaConverter {
  if (isConverter(source)) return source;
  const copy = (): Record<string, unknown> =>
    structuredClone<Record<string, unknown>>(source);
  return { input: copy, output: copy };
}

/** The converter a schema carries in `~standard.jsonSchema`, if any. */
export function jsonSchemaOf(schema: Schema): JsonSchemaConverter | undefined {
  const converter = (schema["~standard"] as { jsonSchema?: unknown })
    .jsonSchema;
  return typeof converter === "object" &&
    converter !== null &&
    typeof (converter as Partial<JsonSchemaConverter>).input === "function" &&
    typeof (converter as Partial<JsonSchemaConverter>).output === "function"
    ? (converter as JsonSchemaConverter)
    : undefined;
}

/** Whether `schema` came from `documented()`: it documents, and never checks. */
export function isDocumented(schema: unknown): boolean {
  return (
    typeof schema === "object" &&
    schema !== null &&
    (schema as { [DOCUMENTED]?: unknown })[DOCUMENTED] === true
  );
}

/**
 * Marks `schema` as a body of `kind`, read by `describeContract`. Returns
 * `schema`. For V3a/V3b's `chunks()`, `sse()` and `opaque()`; not exported.
 *
 * @internal
 */
export function markKind<S extends object>(schema: S, kind: ContractKind): S {
  Object.defineProperty(schema, KIND, {
    value: kind,
    enumerable: false,
    configurable: true,
  });
  return schema;
}

/**
 * Marks `schema` as declared by the framework rather than the app (a
 * validator's own failure status, plan §4.12 m5): `describeContract` flags
 * its rows `implicit`, and `mergeContracts` lets any declared schema for the
 * same part win over it. Returns `schema`. Not exported.
 *
 * @internal
 */
export function markImplicit<S extends object>(schema: S): S {
  Object.defineProperty(schema, IMPLICIT, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return schema;
}

/** Whether `markImplicit` marked `schema`. */
export function isImplicit(schema: unknown): boolean {
  return (
    typeof schema === "object" &&
    schema !== null &&
    (schema as { [IMPLICIT]?: unknown })[IMPLICIT] === true
  );
}

/** The kind `markKind` recorded on `schema`; `"value"` when none. */
export function kindOf(schema: unknown): ContractKind {
  if (typeof schema !== "object" || schema === null) return "value";
  const kind = (schema as { [KIND]?: unknown })[KIND];
  return kind === "chunks" || kind === "sse" || kind === "opaque"
    ? kind
    : "value";
}

/**
 * A pass-through Standard Schema for a part known only as JSON Schema
 * (docs-only responses, routes documented for Swagger): it **documents and
 * never checks**. Its `validate` hands back what it is given, and a guard
 * skips it entirely; its `~standard.jsonSchema` returns `jsonSchema` for
 * input and output (plan Q-C12). When layers are merged, a checking schema
 * for the same part wins over it, with a warning if the two disagree.
 *
 * @typeParam T The type it claims (nothing checks it). Default `unknown`.
 * @param jsonSchema One JSON Schema object, or a converter.
 *
 * @example
 * ```ts
 * const Legacy = documented<{ id: string }>({
 *   type: "object",
 *   properties: { id: { type: "string" } },
 *   required: ["id"],
 * });
 * ```
 */
export function documented<T = unknown>(
  jsonSchema: JsonSchemaSource,
): SchemaWithJson<T, T> {
  if (typeof jsonSchema !== "object" || jsonSchema === null) {
    throw new TypeError(
      "documented(): expected a JSON Schema object or converter",
    );
  }
  const schema: SchemaWithJson<T, T> = {
    "~standard": {
      version: 1,
      vendor: "bun-common/documented",
      validate: (value: unknown) => ({ value: value as T }),
      jsonSchema: toConverter(jsonSchema),
    },
  };
  Object.defineProperty(schema, DOCUMENTED, { value: true, enumerable: false });
  return schema;
}

/** `$schema` taken off a member's JSON Schema, since the record states it once. */
function withoutDialect(
  json: Record<string, unknown>,
): [Record<string, unknown>, unknown] {
  const { $schema, ...rest } = json;
  return [rest, $schema];
}

/** The record's JSON Schema in one direction, composed from its members'. */
function composeJson(
  members: readonly (readonly [string, JsonSchemaConverter])[],
  direction: "input" | "output",
  options: JsonSchemaOptions,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  let dialect: unknown;
  for (const [key, converter] of members) {
    const [json, $schema] = withoutDialect(converter[direction](options));
    properties[key] = json;
    dialect ??= $schema;
  }
  return {
    ...(dialect === undefined ? {} : { $schema: dialect }),
    type: "object",
    properties,
    required: members.map(([key]) => key),
  };
}

/**
 * A Standard Schema over a record of schemas (a flow's children results, a
 * gRPC metadata map): each key is checked by its own schema, and the output
 * holds the declared keys only. Synchronous when every member is. When every
 * member carries `~standard.jsonSchema`, so does the record, composed from
 * theirs (plan §4.12 m10); otherwise it carries none.
 *
 * @param schemas The member schemas, by key.
 * @param options The record schema's options.
 * @param options.vendor The vendor it reports; default `"bun-common"`.
 */
export function recordOf<const M extends Readonly<Record<string, Schema>>>(
  schemas: M,
  options: {
    /** The vendor the record schema reports. Default `"bun-common"`. */
    readonly vendor?: string;
  } = {},
): StandardSchemaV1<
  { -readonly [K in keyof M]: StandardSchemaV1.InferInput<M[K]> },
  { -readonly [K in keyof M]: StandardSchemaV1.InferOutput<M[K]> }
> {
  type Out = { -readonly [K in keyof M]: StandardSchemaV1.InferOutput<M[K]> };
  const entries = Object.entries(schemas);
  const validate = (
    value: unknown,
  ): MaybePromise<StandardSchemaV1.Result<Out>> => {
    if (typeof value !== "object" || value === null) {
      return { issues: [{ message: "Expected an object", path: [] }] };
    }
    const results = entries.map(([key, schema]) =>
      schema["~standard"].validate((value as Record<string, unknown>)[key]),
    );
    const finish = (
      settled: readonly StandardSchemaV1.Result<unknown>[],
    ): StandardSchemaV1.Result<Out> => {
      const out: Record<string, unknown> = {};
      const issues: StandardSchemaV1.Issue[] = [];
      settled.forEach((result, i) => {
        const key = entries[i][0];
        if (result.issues) {
          for (const issue of result.issues) {
            const code = (issue as { code?: unknown }).code;
            issues.push({
              message: issue.message,
              path: [key, ...(issue.path ?? [])],
              ...(typeof code === "string" ? { code } : {}),
            });
          }
        } else out[key] = result.value;
      });
      return issues.length > 0 ? { issues } : { value: out as Out };
    };
    return results.some((r) => r instanceof Promise)
      ? Promise.all(results).then(finish)
      : finish(results as StandardSchemaV1.Result<unknown>[]);
  };
  const converters = entries.map(
    ([key, schema]) => [key, jsonSchemaOf(schema)] as const,
  );
  const props: StandardSchemaV1.Props<unknown, Out> & {
    jsonSchema?: JsonSchemaConverter;
  } = {
    version: 1,
    vendor: options.vendor ?? "bun-common",
    validate,
  };
  if (converters.every(([, c]) => c !== undefined)) {
    const members = converters as readonly (readonly [
      string,
      JsonSchemaConverter,
    ])[];
    props.jsonSchema = {
      input: (o) => composeJson(members, "input", o),
      output: (o) => composeJson(members, "output", o),
    };
  }
  return { "~standard": props } as StandardSchemaV1<
    { -readonly [K in keyof M]: StandardSchemaV1.InferInput<M[K]> },
    Out
  >;
}
