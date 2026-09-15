import type { BunRequest } from "./BunRequest";
import type { BunResponse } from "./BunResponse";
import type { NextFunction, RouterHandler } from "./types/general";
import type { EmptyShape } from "./types/routeTyping";
import type { StandardSchemaV1 } from "./types/standardSchema";
import type { JsonValue } from "./utils/native";

/** The request members `BunValidate` can validate. */
export type ValidationTarget = "params" | "query" | "body" | "headers";

/** Schemas to apply, keyed by target. Every one is optional. */
export interface ValidationSchemas {
  /** Validates `req.params` — the values matched out of the path. */
  params?: StandardSchemaV1;
  /** Validates `req.query` — note every value starts as a string. */
  query?: StandardSchemaV1;
  /** Validates `req.body`. Requires body parsing to be enabled. */
  body?: StandardSchemaV1;
  /** Validates the request headers as a plain object. */
  headers?: StandardSchemaV1;
}

/**
 * What each target holds on the request **before** validation — the value a
 * `normalize` hook receives. These are the request's own declared types; a
 * validator earlier in the chain may already have replaced `query`/`body`
 * with its output.
 */
export interface ValidationTargetValues {
  /** `req.params`: the values matched out of the path, all strings. */
  params: BunRequest["params"];
  /** `req.query`: the parsed query string. */
  query: BunRequest["query"];
  /** `req.body`: whatever the body parser produced. */
  body: BunRequest["body"];
  /** `req.headers`, as a plain object. */
  headers: BunRequest["headers"];
}

/** The output type of a target's schema, or `unknown` when it has none. */
export type ValidationSchemaOutput<T> = T extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<T>
  : unknown;

/**
 * The targets `S` gives a schema — the only ones a hook can be attached to.
 * For the wide `ValidationSchemas` every target may have one, so all four.
 */
export type SchemaTargets<S extends ValidationSchemas> = {
  [K in keyof S & ValidationTarget]: S[K] extends undefined ? never : K;
}[keyof S & ValidationTarget];

/**
 * Per-target hooks, typed from the schemas: `normalize` receives the target's
 * raw value ({@link ValidationTargetValues}) and `transform` the schema's
 * parsed output. Only targets with a schema ({@link SchemaTargets}) take
 * hooks: hooks run around validation, so one on a target without a schema
 * would never run.
 *
 * Every target is listed, a schema-less one typed `never`, rather than
 * leaving it out: `hooks` is an inferred type parameter, which is not checked
 * for excess properties, so an absent key would be silently accepted.
 */
export type ValidationHooks<S extends ValidationSchemas = ValidationSchemas> = {
  [K in ValidationTarget]?: K extends SchemaTargets<S>
    ? TargetHooks<ValidationTargetValues[K], ValidationSchemaOutput<S[K]>>
    : never;
};

/**
 * The value a target ends up with: a `transform` hook's return type when one
 * is given, the schema's output otherwise. Headers are never written back, so
 * their `transform` does not change what a handler reads.
 */
type TargetResult<
  S extends ValidationSchemas,
  H,
  K extends ValidationTarget,
> = K extends "headers"
  ? ValidationSchemaOutput<S[K]>
  : H extends {
        [P in K]: { transform: (...args: never[]) => infer R };
      }
    ? R
    : ValidationSchemaOutput<S[K]>;

/**
 * The parsed shapes a set of schemas produces, for the typed handler view.
 *
 * `H` is the `hooks` option as passed; a target's `transform` hook, when
 * present, decides that target's type, because its return value is what gets
 * written onto the request.
 */
export type InferValidatedShape<S extends ValidationSchemas, H = unknown> = {
  [K in keyof S & ValidationTarget as S[K] extends StandardSchemaV1
    ? K
    : never]: TargetResult<S, H, K>;
};

/**
 * What a validator's middleware tells the following handler, given its
 * `replace` option `R`.
 *
 * Only `replace: true` (the default) writes the validated values onto the
 * request, so only then does the handler see {@link InferValidatedShape}.
 * With `replace: false` the request is left exactly as it was, and the shape
 * is empty — the handler keeps the request's own types. A `replace` that is
 * only known to be a `boolean` claims nothing, since it may be `false`.
 */
export type ValidatedShapeFor<
  S extends ValidationSchemas,
  H = unknown,
  R extends boolean = true,
> = [R] extends [true] ? InferValidatedShape<S, H> : EmptyShape;

/** What to do when a target fails validation. */
export type ValidationFailureMode =
  /** Pass a {@link ValidationError} to `next`, entering the error pipeline. */
  | "next"
  /** Throw a {@link ValidationError} for the adapter's final error handler. */
  | "throw"
  /** Respond immediately with `status` and a JSON body of the issues. */
  | "respond";

/** A validation issue, flattened with the target that produced it. */
export interface ValidationIssue {
  /** Which part of the request failed. */
  target: ValidationTarget;
  /** Human-readable description from the schema. */
  message: string;
  /** Dotted path within the target, or `""` for the target itself. */
  path: string;
}

/**
 * Raised when a request fails validation.
 *
 * Carries the flattened issues so an error handler can render whatever shape
 * the application wants, rather than being handed a library-specific error.
 */
export class ValidationError extends Error {
  /** Every issue found, across all validated targets. */
  public readonly issues: ValidationIssue[];
  /** The targets that produced at least one issue. */
  public readonly targets: ValidationTarget[];
  /** Suggested HTTP status; `422` when configured, `400` by default. */
  public readonly status: number;

  constructor(issues: ValidationIssue[], status: number) {
    const summary = issues
      .map(
        (issue) =>
          `${issue.target}${issue.path ? `.${issue.path}` : ""}: ${issue.message}`,
      )
      .join("; ");
    super(`Request validation failed — ${summary}`);
    this.name = "ValidationError";
    this.issues = issues;
    this.targets = [...new Set(issues.map((issue) => issue.target))];
    this.status = status;
  }
}

/**
 * Hooks applied around validation for a single target.
 *
 * @typeParam In      The target's raw value, as `normalize` receives it.
 * @typeParam Out     The schema's parsed output, as `transform` receives it.
 * @typeParam TResult What `transform` returns — the value written back.
 *
 * All three default to `unknown` so a bare `TargetHooks` stays the widest
 * hook; inside `hooks` they are filled in from the schemas.
 */
export interface TargetHooks<In = unknown, Out = unknown, TResult = unknown> {
  /**
   * Runs **before** validation, to reshape raw input into what the schema
   * expects — trimming strings, splitting a comma-separated query value,
   * dropping empties. Never sees a validated value.
   *
   * Returns `unknown` on purpose: whatever it produces is untrusted input that
   * the schema then validates.
   */
  normalize?: (value: In, req: BunRequest) => unknown;
  /**
   * Runs **after** a successful validation, to derive the final value the
   * handler sees. Use for enrichment that a schema cannot express. Its return
   * type becomes the handler's type for this target.
   */
  transform?: (value: Out, req: BunRequest) => TResult;
}

/**
 * Configuration for a {@link BunValidate} instance.
 *
 * @typeParam S The schemas, keyed by target.
 * @typeParam H The `hooks` as passed; a `transform` decides its target's type.
 * @typeParam R The `replace` option as passed: `false` leaves the handler's
 *   request types unchanged ({@link ValidatedShapeFor}).
 */
export interface BunValidateOptions<
  S extends ValidationSchemas = ValidationSchemas,
  H extends ValidationHooks<S> = ValidationHooks<S>,
  R extends boolean = true,
> {
  /** Schemas to apply, keyed by request target. */
  schemas: S;
  /**
   * What to do when validation fails. Defaults to `"next"`, which hands a
   * {@link ValidationError} to the Express-style error pipeline so the
   * application controls the response shape.
   */
  onFailure?: ValidationFailureMode;
  /** Status used by `"respond"`, and reported on the error. Defaults to 400. */
  status?: number;
  /**
   * Stop at the first target that fails, instead of collecting issues from
   * every target. Defaults to `false` — reporting everything at once is
   * usually more useful to an API client.
   */
  abortEarly?: boolean;
  /**
   * Write the parsed value back onto the request, so handlers see the
   * validated and transformed shape. Defaults to `true`.
   *
   * `params` is written back as a plain object; a schema that coerces
   * `"42"` to `42` therefore changes what later middleware reads.
   *
   * With `false` nothing is written, so the handler that follows keeps the
   * request's own types rather than the validated ones — read the parsed
   * values by running the schema yourself if you need them. `transform` hooks
   * still run (their result is discarded).
   */
  replace?: R;
  /**
   * Per-target `normalize`/`transform` hooks, typed from `schemas`: see
   * {@link ValidationHooks}. A `transform`'s return type is what the handler's
   * `req` reports for that target.
   *
   * Only a target with a schema takes hooks — naming any other is a compile
   * error, because hooks run around validation and so would never run there.
   */
  hooks?: H;
  /**
   * Builds the body sent by `"respond"`, as JSON. Defaults to
   * `{ error: "Validation failed", issues }`.
   *
   * Any JSON value is sent as it is — an array, a string or `null` included,
   * not only an object.
   */
  formatError?: (error: ValidationError, req: BunRequest) => JsonValue;
}

/** Reads a target off the request. */
function readTarget(
  req: BunRequest,
  target: ValidationTarget,
): ValidationTargetValues[ValidationTarget] {
  switch (target) {
    case "params":
      return req.params;
    case "query":
      return req.query;
    case "body":
      return req.body;
    default:
      return req.headers;
  }
}

/**
 * Writes a validated value back onto the request.
 *
 * `value` is `unknown` because the schemas are erased by this point: it is the
 * output (or transformed output) of whichever schema matched `target`.
 */
function writeTarget(
  req: BunRequest,
  target: ValidationTarget,
  value: unknown,
): void {
  switch (target) {
    case "params":
      req.params = value as Record<string, string>;
      break;
    case "query":
      req.query = value as Record<string, unknown>;
      break;
    case "body":
      req.body = value as never;
      break;
    default:
      // Headers are validated for their shape but never replaced: the parsed
      // view is a plain object, while `req.headers` is backed by the live
      // header store that the response pipeline still reads.
      break;
  }
}

/**
 * A plain validate function {@link toStandardSchema} can wrap: given whatever
 * arrived, it returns (or resolves) a Standard Schema result — `{ value }` on
 * success, `{ issues }` on failure.
 */
export type StandardValidateFunction<TOutput> = (
  value: unknown,
) =>
  | StandardSchemaV1.Result<TOutput>
  | Promise<StandardSchemaV1.Result<TOutput>>;

/** Options for {@link toStandardSchema}. */
export interface ToStandardSchemaOptions {
  /** Name reported as the schema's vendor. Defaults to `"custom"`. */
  vendor?: string;
}

/**
 * Wraps a plain validate function as a
 * [Standard Schema](https://standardschema.dev), for a library that does not
 * implement one itself.
 *
 * zod, yup, valibot and arktype all expose `~standard` natively and can be
 * passed to {@link validate} directly. Others (superstruct, joi, a bespoke
 * check) need one line:
 *
 * ```ts
 * const Page = toStandardSchema<{ page: number }>((input) => {
 *   const page = Number((input as { page?: unknown })?.page);
 *   return Number.isInteger(page)
 *     ? { value: { page } }
 *     : { issues: [{ message: "page must be a whole number", path: ["page"] }] };
 * });
 * ```
 *
 * The type arguments name what the schema produces:
 *
 * - none — the output is inferred from what `validate` returns;
 * - `<TOutput>` — the output, with an `unknown` input (a validator is handed
 *   whatever arrived, so that is almost always the honest input);
 * - `<TInput, TOutput>` — both, when the input type matters to a consumer of
 *   `StandardSchemaV1.InferInput`.
 *
 * The returned schema is a real Standard Schema, so it works anywhere one is
 * accepted — not just here.
 */
export function toStandardSchema<TOutput>(
  validate: StandardValidateFunction<TOutput>,
  options?: ToStandardSchemaOptions,
): StandardSchemaV1<unknown, TOutput>;
export function toStandardSchema<TInput, TOutput>(
  validate: StandardValidateFunction<TOutput>,
  options?: ToStandardSchemaOptions,
): StandardSchemaV1<TInput, TOutput>;
export function toStandardSchema<TInput, TOutput>(
  validate: StandardValidateFunction<TOutput>,
  options?: ToStandardSchemaOptions,
): StandardSchemaV1<TInput, TOutput> {
  return {
    "~standard": {
      version: 1,
      vendor: options?.vendor ?? "custom",
      validate,
      types: undefined as unknown as StandardSchemaV1.Types<TInput, TOutput>,
    },
  };
}

/** Renders a Standard Schema issue path as a dotted string. */
function formatPath(issue: StandardSchemaV1.Issue): string {
  if (!issue.path || issue.path.length === 0) {
    return "";
  }
  return issue.path
    .map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String(segment.key)
        : String(segment),
    )
    .join(".");
}

/**
 * Validates, transforms and normalizes parts of a request against
 * [Standard Schema](https://standardschema.dev) schemas, as middleware.
 *
 * Works with any conforming library, with no dependency on any of them,
 * because Standard Schema is a spec the schema object itself implements.
 * Verified against zod 4, yup 1.7, valibot 1 and arktype 2, each passed in
 * directly; a library without `~standard` (superstruct 2) is wrapped with
 * {@link toStandardSchema}.
 *
 * The produced middleware is an ordinary router handler, so it works on
 * `BunRouter`, `bun-common`'s adapter and `bun-nest`'s adapter alike.
 *
 * @example
 * ```ts
 * const validate = new BunValidate({
 *   schemas: { query: z.object({ page: z.coerce.number() }) },
 * });
 * router.get("/posts", validate.middleware(), (req, res) => {
 *   res.json({ page: req.query.page }); // number, not string
 * });
 * ```
 */
export class BunValidate<
  S extends ValidationSchemas = ValidationSchemas,
  H extends ValidationHooks<S> = ValidationHooks<S>,
  R extends boolean = true,
> {
  /** Targets that have a schema, in a fixed order for predictable reporting. */
  readonly #targets: ValidationTarget[];
  /** The options given, with every behavioural default filled in. */
  readonly #options: Required<
    Pick<BunValidateOptions<S, H, R>, "onFailure" | "status" | "abortEarly">
  > &
    Omit<BunValidateOptions<S, H, R>, "replace"> & {
      /** Whether validated values are written back; defaults to `true`. */
      replace: boolean;
    };

  /**
   * @param options Schemas, hooks and failure behaviour; see
   *   {@link BunValidateOptions}.
   */
  constructor(options: BunValidateOptions<S, H, R>) {
    this.#options = {
      onFailure: "next",
      status: 400,
      abortEarly: false,
      ...options,
      replace: options.replace ?? true,
    };

    const order: ValidationTarget[] = ["headers", "params", "query", "body"];
    this.#targets = order.filter((target) => !!options.schemas[target]);
  }

  /** The schemas this instance validates against. */
  public get schemas(): S {
    return this.#options.schemas;
  }

  /**
   * Builds the middleware. The returned function carries the validated shapes
   * as a phantom type, so a verb method registering it can narrow the
   * following handler's `req` without the caller restating anything.
   */
  public middleware(): ValidatorMiddleware<ValidatedShapeFor<S, H, R>> {
    const { onFailure, status, abortEarly, replace, schemas, formatError } =
      this.#options;
    // Erased for the loop, which handles every target through one code path:
    // each hook only ever receives its own target's raw value and its own
    // schema's output, which is what `ValidationHooks<S>` promised the caller.
    const hooks = this.#options.hooks as
      | {
          [K in ValidationTarget]?: TargetHooks<
            ValidationTargetValues[ValidationTarget]
          >;
        }
      | undefined;
    const targets = this.#targets;

    const handler: RouterHandler = async (
      req: BunRequest,
      res: BunResponse,
      next: NextFunction,
    ) => {
      const issues: ValidationIssue[] = [];

      for (const target of targets) {
        const schema = schemas[target] as StandardSchemaV1 | undefined;
        if (!schema) {
          continue;
        }

        const targetHooks = hooks?.[target];
        const raw = readTarget(req, target);
        const input = targetHooks?.normalize
          ? targetHooks.normalize(raw, req)
          : raw;

        const result = await schema["~standard"].validate(input);

        if (result.issues) {
          for (const issue of result.issues) {
            issues.push({
              target,
              message: issue.message,
              path: formatPath(issue),
            });
          }
          if (abortEarly) {
            break;
          }
          continue;
        }

        const value = targetHooks?.transform
          ? targetHooks.transform(result.value, req)
          : result.value;

        if (replace) {
          writeTarget(req, target, value);
        }
      }

      if (issues.length === 0) {
        return next();
      }

      const error = new ValidationError(issues, status);

      if (onFailure === "throw") {
        throw error;
      }
      if (onFailure === "respond") {
        if (!formatError) {
          return res
            .status(status)
            .json({ error: "Validation failed", issues: error.issues });
        }
        const body = formatError(error, req);
        // `res.json` takes objects only; any other JSON value is serialised
        // the same way and sent with the same Content-Type.
        return typeof body === "object" && body !== null && !Array.isArray(body)
          ? res.status(status).json(body)
          : res.status(status).type("json").send(JSON.stringify(body));
      }
      return next(error);
    };

    return handler as ValidatorMiddleware<ValidatedShapeFor<S, H, R>>;
  }

  /** Shorthand for `new BunValidate(options).middleware()`. */
  public static middleware<
    S extends ValidationSchemas,
    H extends ValidationHooks<S> = ValidationHooks<S>,
    R extends boolean = true,
  >(
    options: BunValidateOptions<S, H, R>,
  ): ValidatorMiddleware<ValidatedShapeFor<S, H, R>> {
    return new BunValidate(options).middleware();
  }
}

/**
 * A router handler that additionally advertises which request members it
 * validated, and into what types.
 *
 * The `__shape` property never exists at runtime — it is a phantom carrier the
 * verb overloads read to narrow the handlers that follow this middleware.
 */
export interface ValidatorMiddleware<TShape> extends RouterHandler {
  /** Phantom carrier of the validated shapes; never present at runtime. */
  readonly __shape?: TShape;
}

/** Convenience wrapper matching the example in {@link BunValidate}. */
export function validate<
  S extends ValidationSchemas,
  H extends ValidationHooks<S> = ValidationHooks<S>,
  R extends boolean = true,
>(
  schemas: S,
  options?: Omit<BunValidateOptions<S, H, R>, "schemas">,
): ValidatorMiddleware<ValidatedShapeFor<S, H, R>> {
  return new BunValidate({ ...options, schemas }).middleware();
}
