/**
 * The Standard Schema → JSON Schema converter (AD phase (b), plan
 * `docs/plans/api-docs-generation/` §4): turns any `StandardSchemaV1` into a
 * JSON Schema document, never throwing for a content problem — a schema that
 * cannot be converted yields `{}` plus a {@link ConversionWarning}.
 *
 * Resolution, per schema (§4.3):
 *
 * 1. a converter attached with {@link withJsonSchema} (the author's explicit
 *    JSON Schema wins over everything automatic);
 * 2. the schema's own `~standard.jsonSchema` converter (the Standard JSON
 *    Schema companion spec), asked for the wanted direction and dialect —
 *    zod ≥ 4.2 and arktype ≥ 2.1.28 answer here already. A throw falls
 *    through with a warning, since the spec allows one;
 * 3. a converter for the schema's `~standard.vendor`: the caller's
 *    {@link ToJsonSchemaOptions.converters}, else the process registry
 *    ({@link registerJsonSchemaConverter}), else the built-ins;
 * 4. `{}` plus a warning.
 *
 * Nothing in `lib/docs/` imports a vendor package: every converter is
 * structural, reading methods the schema object happens to carry (`__tests__/
 * docs/packaging.test.ts` proves the import graph).
 */
import type { Schema } from "../contract/model";
import { jsonSchemaOf, toConverter } from "../contract/schemas";
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "../types/standardSchema";
import { isSchema } from "../contract/transport";
import {
  arktypeConverter,
  bunJobsConverter,
  yupConverter,
  zodConverter,
} from "./converters";
import type { JsonSchemaLike } from "./types";

/** A JSON Schema document (or fragment), as the converters produce it. */
export type { JsonSchemaLike } from "./types";

/** Which side of a schema a conversion describes. */
export type SchemaDirection = "input" | "output";

/**
 * The dialect a conversion targets (plan §4.3): `"draft-2020-12"` (the
 * default, and OpenAPI 3.1's dialect) or `"openapi-3.0"` (OpenAPI 3.0's
 * dialect, a superset of draft-04 — `nullable: true` instead of
 * `type: ["x", "null"]`, boolean `exclusiveMinimum`). Passed to the schema's
 * own `~standard.jsonSchema` as its `target`; the structural converters honor
 * it as far as the vendor's emit allows.
 */
export type JsonSchemaDialect = "draft-2020-12" | "openapi-3.0";

/** A problem a conversion ran into and degraded past; nothing throws. */
export interface ConversionWarning {
  /** The schema's `~standard.vendor`. */
  readonly vendor: string;
  /**
   * The step of the resolution that produced the warning: `"jsonSchema"` —
   * the schema's own `~standard.jsonSchema` threw; `"converter"` — the vendor
   * converter returned nothing or threw; `"unsupported"` — no path could
   * convert the schema and `{}` was emitted; `"lift"` —
   * `liftComponents` renamed a colliding or anonymous component.
   */
  readonly stage: "jsonSchema" | "converter" | "unsupported" | "lift";
  /** What happened, naming what the vendor reported where it said anything. */
  readonly message: string;
}

/** Context a {@link JsonSchemaConverter} is given. */
export interface ConvertContext {
  /** `"input"` for requests, `"output"` for responses. */
  readonly direction: SchemaDirection;
  /** The dialect the caller wants; see {@link JsonSchemaDialect}. */
  readonly dialect: JsonSchemaDialect;
  /**
   * Converts a nested schema, for a converter that recurses; `undefined` when
   * the nested schema converts to nothing (unlike {@link toJsonSchema}, which
   * emits `{}` for the same).
   */
  readonly convert: (
    schema: StandardSchemaV1,
    direction?: SchemaDirection,
  ) => JsonSchemaLike | undefined;
}

/**
 * Turns one vendor's schema into JSON Schema.
 *
 * Return `undefined` when this converter cannot describe the schema at all;
 * the resolution then records a warning and emits `{}`. Never throw for an
 * unrepresentable *part* — degrade.
 */
export type JsonSchemaConverter = (
  schema: StandardSchemaV1,
  context: ConvertContext,
) => JsonSchemaLike | undefined;

/** What {@link toJsonSchema} takes. */
export interface ToJsonSchemaOptions {
  /**
   * The side converted (plan §4.2's measured asymmetry: a defaulted field is
   * absent from `input`'s `required` but present in `output`'s, and zod's
   * `output` adds `additionalProperties: false`). Requests convert with
   * `"input"` — the wire side — and responses with `"input"` too, except
   * under V13's `responseOutput: "parsed"`, where what the client receives is
   * the schema's output and `"output"` is right. Default `"input"`.
   */
  readonly direction?: SchemaDirection;
  /** The dialect wanted. Default `"draft-2020-12"`. */
  readonly dialect?: JsonSchemaDialect;
  /**
   * Converters for this call only, keyed by `~standard.vendor`; a vendor's
   * entry replaces the registered and built-in ones for the call.
   */
  readonly converters?: Readonly<Record<string, JsonSchemaConverter>>;
  /** Receives every warning the conversion records. */
  readonly onWarning?: (warning: ConversionWarning) => void;
}

/**
 * The process-wide converter registry, keyed by `~standard.vendor`
 * (plan §4.3). Registration **replaces** the built-in for the vendor; prefer
 * {@link ToJsonSchemaOptions.converters} for a per-call override.
 */
const registry = new Map<string, JsonSchemaConverter>();

/** The built-in converters, by the `~standard.vendor` they answer. */
const builtins: Readonly<Record<string, JsonSchemaConverter>> = {
  zod: zodConverter,
  arktype: arktypeConverter,
  yup: yupConverter,
  "bun-jobs": bunJobsConverter,
};

/**
 * Registers a converter for a `~standard.vendor`, replacing any built-in one.
 * Process-wide; prefer {@link ToJsonSchemaOptions.converters} for a per-call
 * override. There is deliberately no public unregister: pass a per-call
 * converter to step around a registration, and tests restore by
 * re-registering the built-in (they are exported for exactly this). The one
 * internal exception is {@link unregisterJsonSchemaConverter}, for
 * `useClassDtos`' test reset — the `"class-validator"` converter is not a
 * built-in, so nothing can be re-registered to remove it.
 */
export function registerJsonSchemaConverter(
  vendor: string,
  converter: JsonSchemaConverter,
): void {
  registry.set(vendor, converter);
}

/**
 * Removes a registered converter. Internal, for `lib/classDto.ts`'s test
 * reset; never re-exported from `lib/docs/index.ts` or the package root.
 *
 * @internal
 */
export function unregisterJsonSchemaConverter(vendor: string): void {
  registry.delete(vendor);
}

/**
 * The converters attached with {@link withJsonSchema} whose stamp could not
 * land (a frozen `~standard`): consulted before every other path, so the
 * author's explicit JSON Schema still wins for them — here, though the core's
 * own `jsonSchemaOf` readers cannot see it.
 */
const stamped = new WeakMap<Schema, StandardJSONSchemaV1.Converter>();

/**
 * Attaches an explicit JSON Schema to a Standard Schema, so a conversion
 * emits it instead of deriving one. The schema still validates as before.
 *
 * The attachment is stamped onto the schema's `~standard` as a non-enumerable
 * `jsonSchema` converter (spec 1.1.0's shape), so the core's existing
 * `jsonSchemaOf` readers — `describeContract`'s comparison,
 * `bodyPlacement`'s requiredness probe, the response checks — see it too.
 * When `~standard` is frozen and the stamp cannot land, a `WeakMap` fallback
 * holds it for {@link toJsonSchema} alone.
 *
 * @example
 * ```ts
 * const Page = withJsonSchema(toStandardSchema<{ page: number }>(check), {
 *   type: "object",
 *   properties: { page: { type: "integer", minimum: 1 } },
 *   required: ["page"],
 * });
 * ```
 */
export function withJsonSchema<S extends StandardSchemaV1>(
  schema: S,
  json: JsonSchemaLike,
): S {
  if (!isSchema(schema)) {
    throw new TypeError("withJsonSchema(): expected a Standard Schema");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new TypeError("withJsonSchema(): expected a JSON Schema object");
  }
  const converter = toConverter(json);
  try {
    Object.defineProperty(schema["~standard"], "jsonSchema", {
      value: converter,
      enumerable: false,
      configurable: true,
    });
  } catch {
    stamped.set(schema, converter);
  }
  return schema;
}

/** Whether `value` is a plain JSON-Schema-shaped object. */
function isPlainObject(value: unknown): value is JsonSchemaLike {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * The converter chain for a vendor (plan §4.3 step 3): the call's own, else
 * the registered, else the built-in — the first the chain holds, not one per
 * stage, so a registration *replaces* the built-in rather than falling
 * through to it.
 */
function chainFor(
  vendor: string,
  options: ToJsonSchemaOptions,
): JsonSchemaConverter | undefined {
  return (
    options.converters?.[vendor] ?? registry.get(vendor) ?? builtins[vendor]
  );
}

/**
 * The conversion itself, shared by {@link toJsonSchema} and the context's
 * nested `convert`. Returns `undefined` where nothing could convert the
 * schema; the top-level call turns that into `{}` (with its warning already
 * recorded).
 */
function convertInternal(
  schema: StandardSchemaV1,
  direction: SchemaDirection,
  dialect: JsonSchemaDialect,
  options: ToJsonSchemaOptions,
): JsonSchemaLike | undefined {
  const vendor = schema["~standard"].vendor;
  const warn = (warning: ConversionWarning): void => {
    options.onWarning?.(warning);
  };

  // 1. The WeakMap half of withJsonSchema (a frozen `~standard`).
  const explicit = stamped.get(schema);

  // 2. The schema's own ~standard.jsonSchema — which a successful
  //    withJsonSchema stamp also lands on, so jsonSchemaOf covers both.
  const carried = jsonSchemaOf(schema);
  const own = explicit ?? carried;
  if (own !== undefined) {
    try {
      const json = own[direction]({
        target: dialect,
        // V3c's degraded zod options on the primary path (the option is
        // opaque per the spec, so a vendor that takes none ignores it):
        // an unrepresentable node degrades to `{}` rather than throwing.
        // Pinned against zod 4.6.1 — 4.5.4→4.6.5's constraint-dropping
        // regression (zod#6613) does not apply to this checkout.
        libraryOptions: { unrepresentable: "any" },
      });
      if (isPlainObject(json)) return json;
      warn({
        vendor,
        stage: "jsonSchema",
        message: `~standard.jsonSchema.${direction}() returned a non-object; falling back to the vendor converters`,
      });
    } catch (error) {
      warn({
        vendor,
        stage: "jsonSchema",
        message: `~standard.jsonSchema.${direction}() threw: ${(error as Error).message}; falling back to the vendor converters`,
      });
    }
  }

  // 3. The vendor converters.
  const context: ConvertContext = {
    direction,
    dialect,
    convert: (nested, nestedDirection) =>
      isSchema(nested)
        ? convertInternal(
            nested,
            nestedDirection ?? direction,
            dialect,
            options,
          )
        : undefined,
  };
  const converter = chainFor(vendor, options);
  if (converter !== undefined) {
    let json: JsonSchemaLike | undefined;
    try {
      json = converter(schema, context);
    } catch (error) {
      warn({
        vendor,
        stage: "converter",
        message: `the "${vendor}" converter threw: ${(error as Error).message}`,
      });
      return undefined;
    }
    if (json === undefined) {
      warn({
        vendor,
        stage: "converter",
        message: `the "${vendor}" converter could not describe the schema`,
      });
      return undefined;
    }
    return json;
  }

  return undefined;
}

/**
 * Converts a Standard Schema to a JSON Schema document (AD phase (b)). Never
 * throws for a content problem: a schema no path can convert yields `{}` plus
 * a {@link ConversionWarning} (there is no `strict` mode — that is the
 * document generator's, phase (a)). A non-schema argument is a programmer
 * error and does throw.
 *
 * @param schema The schema to convert.
 * @param options See {@link ToJsonSchemaOptions}.
 */
export function toJsonSchema(
  schema: StandardSchemaV1,
  options: ToJsonSchemaOptions = {},
): JsonSchemaLike {
  if (!isSchema(schema)) {
    throw new TypeError("toJsonSchema(): expected a Standard Schema");
  }
  const direction = options.direction ?? "input";
  const dialect = options.dialect ?? "draft-2020-12";
  const json = convertInternal(schema, direction, dialect, options);
  if (json !== undefined) return json;
  options.onWarning?.({
    vendor: schema["~standard"].vendor,
    stage: "unsupported",
    message:
      "no conversion path could describe the schema; `{}` (any value) was emitted",
  });
  return {};
}
