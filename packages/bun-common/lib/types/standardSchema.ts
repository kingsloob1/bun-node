/**
 * The Standard Schema v1 interface, vendored as types only.
 *
 * Standard Schema is a specification, not a library — a schema "implements" it
 * by exposing a `~standard` property. Zod (3.24+), Valibot, ArkType and others
 * already do, so validating against them needs no dependency at all, only this
 * shape. Vendoring it keeps the dependency surface at zero, per the repo's
 * dependency policy.
 *
 * @see https://standardschema.dev
 */

/** A schema that can validate an `Input` into an `Output`. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema properties. */
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

/*
 * The specification publishes its supporting types inside a namespace merged
 * with the interface, so users write `StandardSchemaV1.InferOutput<T>` exactly
 * as the spec documents. Flattening them into standalone exports would rename
 * every one of them and break that correspondence, so the namespace stays.
 */
// eslint-disable-next-line ts/no-namespace
export declare namespace StandardSchemaV1 {
  /** The properties a Standard Schema exposes. */
  export interface Props<Input = unknown, Output = Input> {
    /** Version number of the specification this schema implements. */
    readonly version: 1;
    /** Identifier of the library that produced the schema (e.g. `"zod"`). */
    readonly vendor: string;
    /**
     * Validates `value`, returning either the parsed output or the issues that
     * prevented it. May be async — a schema is free to do IO.
     */
    readonly validate: (
      value: unknown,
    ) => Result<Output> | Promise<Result<Output>>;
    /** Phantom carrier for the input/output types; never present at runtime. */
    readonly types?: Types<Input, Output> | undefined;
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
  export interface Types<Input = unknown, Output = Input> {
    /** The type the schema accepts. */
    readonly input: Input;
    /** The type the schema produces. */
    readonly output: Output;
  }

  /** The type a schema accepts. */
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema["~standard"]["types"]
  >["input"];

  /** The type a schema produces. */
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema["~standard"]["types"]
  >["output"];
}
