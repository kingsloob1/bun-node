/**
 * Class DTOs (AD phase (b2), plan `docs/plans/api-docs-generation/` §3.6):
 * a class-validator / class-transformer DTO class works wherever a Standard
 * Schema is accepted — `validate({ query: PageQuery })`, a `responses`
 * status, `.describe()`'s `request.*` and response `schema`.
 *
 * Neither library is a dependency, a peer or a declaration import of
 * bun-common (plan risk 1f): the consumer injects the surface it already
 * installed through {@link useClassDtos}, once at startup, and
 * `class-validator`'s and `class-transformer`'s types never appear here.
 * The classes themselves are plain constructors; a DTO in a schema slot is
 * told apart from a Standard Schema structurally — a Standard Schema has
 * `~standard`, a DTO is a function.
 *
 * DTO validation is **always asynchronous** — class-validator's `validate`
 * returns a Promise — so a DTO is never usable where a synchronous schema is
 * required (the WebSocket upgrade check, `defineChannel`). Every HTTP target
 * and the response checks already await an async vendor.
 *
 * Requirements on the consumer's side (the README's class-DTO section states
 * them as requirements): `experimentalDecorators` (and, for implicit
 * conversion, `emitDecoratorMetadata`) on, and `reflect-metadata` imported
 * before the DTO module — under TypeScript 5+ standard decorators,
 * class-validator crashes at class-definition time (**measured** on
 * class-validator 0.15.1: `TypeError: undefined is not an object` from its
 * `ValidateBy`), so the DTO path cannot degrade gracefully there.
 */
import { ConfigError } from "./errors";
import type { JsonSchemaLike } from "./docs/types";
import {
  registerJsonSchemaConverter,
  unregisterJsonSchemaConverter,
} from "./docs/convert";
import type { StandardSchemaV1 } from "./types/standardSchema";
import { isSchema } from "./contract/transport";

/** The vendor a wrapped DTO reports, and the converter {@link useClassDtos} registers. */
const DTO_VENDOR = "class-validator";

/**
 * A DTO class: a constructor `plainToInstance` can build. `T` is the
 * instance — what a validated target (or a response declaration of the
 * class) is typed as.
 */
export type DtoClass<T = object> = new (...args: never[]) => T;

/**
 * One class-validator validation error, structurally: the property (relative
 * to the instance `validate` was given), the failed constraints (name to
 * message), and the nested errors of a `@ValidateNested` property.
 *
 * Exported from this module but not from the package root: it is the
 * structural shape the injected `validate` answers with, not API surface.
 */
export interface ClassValidationError {
  /** The property the error is about. */
  readonly property: string;
  /** The failed constraints: constraint name (`"isString"`) to its message. */
  readonly constraints?: Readonly<Record<string, string>>;
  /** Nested errors, for a `@ValidateNested` property. */
  readonly children?: readonly ClassValidationError[];
}

/**
 * The class-validator / class-transformer surface, injected rather than
 * imported — the structural rule the logging adapters and the `lib/docs/`
 * converters follow. Neither library, nor `reflect-metadata`, becomes a
 * bun-common dependency or appears in a shipped declaration.
 */
export interface ClassValidatorAdapter {
  /** `class-transformer`'s `plainToInstance`. */
  plainToInstance: (cls: DtoClass, plain: unknown, options?: object) => object;
  /**
   * `class-validator`'s `validate`. Async; the issues are mapped to Standard
   * Schema issues, one per failed constraint, nested errors under their
   * property's path.
   */
  validate: (
    instance: object,
    options?: object,
  ) => Promise<readonly ClassValidationError[]>;
}

/**
 * Options for {@link useClassDtos}, and per class for {@link fromDto} (a
 * `fromDto` option wins over the registration's for that schema).
 */
export interface ClassDtoOptions {
  /**
   * Passed to `plainToInstance`. Defaults to
   * `{ enableImplicitConversion: true }`, which is what makes a DTO usable on
   * `query` and `params`, where every value arrives as a string
   * (**measured**: `"42"` → `42` for an `@IsInt()` property).
   */
  transform?: Record<string, unknown>;
  /**
   * Passed to class-validator's `validate`. Defaults to
   * `{ whitelist: true, forbidNonWhitelisted: false }`.
   *
   * Note `whitelist` strips undeclared properties from the instance
   * (**measured** on class-validator 0.15.1 — an `extra` key does not
   * survive): pass `validate: { whitelist: false }` to keep them.
   */
  validate?: Record<string, unknown>;
  /**
   * Converts a DTO class to JSON Schema for the generated document — e.g.
   * `class-validator-jsonschema`'s `targetConstructorToSchema`. Without it a
   * DTO validates correctly and documents as `{}` plus a warning.
   *
   * Typed `object`, not `JsonSchemaLike`, so `targetConstructorToSchema`'s
   * `SchemaObject` (an interface without an index signature) fits without a
   * cast (**measured** on class-validator-jsonschema 5.2.0).
   */
  toJsonSchema?: (cls: DtoClass) => object;
}

/** `plainToInstance`'s defaults, when neither the registration nor the call overrides them. */
const DEFAULT_TRANSFORM: Record<string, unknown> = {
  enableImplicitConversion: true,
};
/** `validate`'s defaults, on the same rule. */
const DEFAULT_VALIDATE: Record<string, unknown> = {
  whitelist: true,
  forbidNonWhitelisted: false,
};

/** The registered adapter and its options; `undefined` until {@link useClassDtos}. */
let registered:
  { adapter: ClassValidatorAdapter; options: ClassDtoOptions } | undefined;

/**
 * The class each wrapped DTO was built from, so the `"class-validator"`
 * converter can hand the injected `toJsonSchema` the constructor it needs —
 * a schema object no longer names its class.
 */
let dtoClasses = new WeakMap<StandardSchemaV1, DtoClass>();

/**
 * Whether `value` is a DTO class rather than a schema: a Standard Schema has
 * `~standard` (an arktype schema is a function *with* one), a DTO is a plain
 * constructor.
 */
export function isDtoClass(value: unknown): value is DtoClass {
  return typeof value === "function" && !isSchema(value);
}

/** The registration, or the deliberate error for a DTO used without one. */
function adapterFor(where: string): {
  adapter: ClassValidatorAdapter;
  options: ClassDtoOptions;
} {
  if (registered === undefined) {
    throw new ConfigError(
      `${where}: a DTO class was used as a schema, but no class-validator adapter is registered — call useClassDtos({ plainToInstance, validate }) once at startup`,
    );
  }
  return registered;
}

/** class-validator's nested errors, flattened to Standard Schema issues. */
function dtoIssues(
  errors: readonly ClassValidationError[],
  path: readonly PropertyKey[] = [],
): StandardSchemaV1.Issue[] {
  const issues: StandardSchemaV1.Issue[] = [];
  for (const error of errors) {
    const here = [...path, error.property];
    for (const [code, constraint] of Object.entries(error.constraints ?? {})) {
      issues.push({ message: constraint, path: here, ...({ code } as object) });
    }
    issues.push(...dtoIssues(error.children ?? [], here));
  }
  return issues;
}

/**
 * Wraps one DTO class as a Standard Schema, for a caller who wants it
 * explicitly rather than through the global registration. The result's
 * `~standard.vendor` is `"class-validator"`; its `validate` builds the
 * instance with `plainToInstance` and validates it with the registered
 * adapter, so it is always a Promise. `~standard.jsonSchema` is present only
 * when the effective options carry {@link ClassDtoOptions.toJsonSchema}.
 *
 * The schema → class pairing is remembered (a `WeakMap`), so the registered
 * `"class-validator"` converter can still reach the class a schema was
 * wrapped from.
 *
 * @param cls      The DTO class.
 * @param options  Per-class overrides of the registration's options.
 */
export function fromDto<T>(
  cls: DtoClass<T>,
  options?: ClassDtoOptions,
): StandardSchemaV1<unknown, T> {
  if (!isDtoClass(cls)) {
    throw new TypeError("fromDto(): expected a DTO class (a constructor)");
  }
  const { adapter, options: registeredOptions } = adapterFor("fromDto()");
  const transform =
    options?.transform ?? registeredOptions.transform ?? DEFAULT_TRANSFORM;
  const validateOptions =
    options?.validate ?? registeredOptions.validate ?? DEFAULT_VALIDATE;
  const toJsonSchema = options?.toJsonSchema ?? registeredOptions.toJsonSchema;
  const schema: StandardSchemaV1<unknown, T> = {
    "~standard": {
      version: 1,
      vendor: DTO_VENDOR,
      validate: async (value: unknown): Promise<StandardSchemaV1.Result<T>> => {
        const instance = adapter.plainToInstance(cls, value, transform);
        const errors = await adapter.validate(instance, validateOptions);
        return errors.length === 0
          ? { value: instance as T }
          : { issues: dtoIssues(errors) };
      },
      types: undefined,
      ...(toJsonSchema === undefined
        ? {}
        : {
            jsonSchema: {
              input: () => toJsonSchema(cls) as JsonSchemaLike,
              output: () => toJsonSchema(cls) as JsonSchemaLike,
            },
          }),
    },
  };
  dtoClasses.set(schema, cls);
  return schema;
}

/**
 * Teaches bun-common to accept DTO classes wherever a schema is accepted.
 * Call once at startup, before any validator wrapping a class is built:
 *
 * ```ts
 * import "reflect-metadata";
 * import { plainToInstance } from "class-transformer";
 * import { validate } from "class-validator";
 * import { targetConstructorToSchema } from "class-validator-jsonschema";
 *
 * useClassDtos(
 *   { plainToInstance, validate },
 *   { toJsonSchema: (cls) => targetConstructorToSchema(cls) },
 * );
 * ```
 *
 * Stores the adapter module-globally and registers the `"class-validator"`
 * converter (`registerJsonSchemaConverter`), so a wrapped DTO also reaches
 * the generated documents. Calling again replaces the registration.
 */
export function useClassDtos(
  adapter: ClassValidatorAdapter,
  options?: ClassDtoOptions,
): void {
  if (typeof adapter?.plainToInstance !== "function") {
    throw new TypeError(
      "useClassDtos(): adapter.plainToInstance must be class-transformer's plainToInstance",
    );
  }
  if (typeof adapter.validate !== "function") {
    throw new TypeError(
      "useClassDtos(): adapter.validate must be class-validator's validate",
    );
  }
  registered = { adapter, options: options ?? {} };
  registerJsonSchemaConverter(DTO_VENDOR, (schema) => {
    const cls = dtoClasses.get(schema);
    const produce = registered?.options.toJsonSchema;
    return cls === undefined || produce === undefined
      ? undefined
      : (produce(cls) as JsonSchemaLike);
  });
}

/**
 * Removes the registration and every schema → class pairing, so a test that
 * registered an adapter cannot leak it into the next file. The
 * `"class-validator"` converter is not a built-in, so `registerJsonSchemaConverter`
 * has nothing to restore over it — this is why a reset exists at all.
 *
 * Internal (never re-exported from the package root): tests import it from
 * `lib/classDto` directly.
 *
 * @internal
 */
export function resetClassDtos(): void {
  registered = undefined;
  dtoClasses = new WeakMap();
  unregisterJsonSchemaConverter(DTO_VENDOR);
}
