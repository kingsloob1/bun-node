/**
 * The Standard Schema v1 interfaces, vendored as types only, at
 * `@standard-schema/spec` 1.1.0 (published 2025-12-15): `StandardTypedV1`
 * (the base), `StandardSchemaV1` (validation) and `StandardJSONSchemaV1`
 * (JSON Schema conversion).
 *
 * Standard Schema is a specification, not a library — a schema "implements" it
 * by exposing a `~standard` property. Zod (3.24+), Valibot, ArkType and others
 * already do, so validating against them needs no dependency at all, only this
 * shape. Vendoring it keeps the dependency surface at zero, per the repo's
 * dependency policy.
 *
 * @see https://standardschema.dev
 */

/** The Standard Typed interface: the base type the other specs extend. */
export interface StandardTypedV1<Input = unknown, Output = Input> {
  /** The Standard properties. */
  readonly "~standard": StandardTypedV1.Props<Input, Output>;
}

/*
 * The specification publishes its supporting types inside a namespace merged
 * with the interface, so users write `StandardSchemaV1.InferOutput<T>` exactly
 * as the spec documents. Flattening them into standalone exports would rename
 * every one of them and break that correspondence, so the namespaces stay.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace StandardTypedV1 {
  /** The Standard Typed properties. */
  export interface Props<Input = unknown, Output = Input> {
    /** Version number of the specification this schema implements. */
    readonly version: 1;
    /** Identifier of the library that produced the schema (e.g. `"zod"`). */
    readonly vendor: string;
    /** Phantom carrier for the input/output types; never present at runtime. */
    readonly types?: Types<Input, Output> | undefined;
  }

  /** Phantom input/output carrier. */
  export interface Types<Input = unknown, Output = Input> {
    /** The type the schema accepts. */
    readonly input: Input;
    /** The type the schema produces. */
    readonly output: Output;
  }

  /** The type a schema accepts. */
  export type InferInput<Schema extends StandardTypedV1> = NonNullable<
    Schema["~standard"]["types"]
  >["input"];

  /** The type a schema produces. */
  export type InferOutput<Schema extends StandardTypedV1> = NonNullable<
    Schema["~standard"]["types"]
  >["output"];
}

/** A schema that can validate an `Input` into an `Output`. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema properties. */
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace StandardSchemaV1 {
  /** The properties a Standard Schema exposes. */
  export interface Props<
    Input = unknown,
    Output = Input,
  > extends StandardTypedV1.Props<Input, Output> {
    /**
     * Validates `value`, returning either the parsed output or the issues that
     * prevented it. May be async — a schema is free to do IO.
     */
    readonly validate: (
      value: unknown,
      options?: Options,
    ) => Result<Output> | Promise<Result<Output>>;
  }

  /** The options a `validate` may be given. */
  export interface Options {
    /** Vendor-specific parameters, when the library documents any. */
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }

  /** The outcome of a validation. */
  export type Result<Output> = SuccessResult<Output> | FailureResult;

  /** A validation that produced a value. */
  export interface SuccessResult<Output> {
    /** The parsed (and possibly transformed) value. */
    readonly value: Output;
    /** Absent on success — its absence is what distinguishes the two results. */
    readonly issues?: undefined;
  }

  /** A validation that produced issues. */
  export interface FailureResult {
    /** Non-empty list of what prevented the value from validating. */
    readonly issues: ReadonlyArray<Issue>;
  }

  /** A single validation problem. */
  export interface Issue {
    /** Human-readable description of the problem. */
    readonly message: string;
    /** Where in the value the problem occurred; absent for the root. */
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  /** A path element, when the library reports more than a key. */
  export interface PathSegment {
    /** The key at this level of the value. */
    readonly key: PropertyKey;
  }

  /** Phantom input/output carrier. */
  export interface Types<
    Input = unknown,
    Output = Input,
  > extends StandardTypedV1.Types<Input, Output> {}

  /** The type a schema accepts. */
  export type InferInput<Schema extends StandardTypedV1> =
    StandardTypedV1.InferInput<Schema>;

  /** The type a schema produces. */
  export type InferOutput<Schema extends StandardTypedV1> =
    StandardTypedV1.InferOutput<Schema>;
}

/** A schema that can also convert its input and output types to JSON Schema. */
export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  /** The Standard JSON Schema properties. */
  readonly "~standard": StandardJSONSchemaV1.Props<Input, Output>;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace StandardJSONSchemaV1 {
  /** The properties a Standard JSON Schema exposes. */
  export interface Props<
    Input = unknown,
    Output = Input,
  > extends StandardTypedV1.Props<Input, Output> {
    /** Converts the input/output types to JSON Schema. */
    readonly jsonSchema: Converter;
  }

  /** The JSON Schema converter. */
  export interface Converter {
    /** The input type as JSON Schema; throws when the conversion is unsupported. */
    readonly input: (options: Options) => Record<string, unknown>;
    /** The output type as JSON Schema; throws when the conversion is unsupported. */
    readonly output: (options: Options) => Record<string, unknown>;
  }

  /**
   * The target version of the generated JSON Schema. Implementers are strongly
   * recommended to support `"draft-2020-12"` and `"draft-07"` (both in wide
   use); any other target is best-effort, and an unsupported one throws.
   * `"openapi-3.0"` names OpenAPI 3.0's dialect (a superset of `"draft-04"`).
   */
  export type Target =
    "draft-2020-12" | "draft-07" | "openapi-3.0" | ({} & string);

  /** The options the converter's `input`/`output` take. */
  export interface Options {
    /** The JSON Schema target version. */
    readonly target: Target;
    /** Vendor-specific parameters, when the library documents any. */
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }

  /** Phantom input/output carrier. */
  export interface Types<
    Input = unknown,
    Output = Input,
  > extends StandardTypedV1.Types<Input, Output> {}

  /** The type a schema accepts. */
  export type InferInput<Schema extends StandardTypedV1> =
    StandardTypedV1.InferInput<Schema>;

  /** The type a schema produces. */
  export type InferOutput<Schema extends StandardTypedV1> =
    StandardTypedV1.InferOutput<Schema>;
}
