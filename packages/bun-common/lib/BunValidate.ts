import type { BunRequest } from "./BunRequest";
import type { BunResponse } from "./BunResponse";
import type { NextFunction, RouterHandler } from "./types/general";
import type { StandardSchemaV1 } from "./types/standardSchema";

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

/** The parsed shapes a set of schemas produces, for the typed handler view. */
export type InferValidatedShape<S extends ValidationSchemas> = {
  [K in keyof S & ValidationTarget as S[K] extends StandardSchemaV1
    ? K
    : never]: S[K] extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<S[K]>
    : never;
};

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

/** Hooks applied around validation for a single target. */
export interface TargetHooks<In = unknown, Out = unknown> {
  /**
   * Runs **before** validation, to reshape raw input into what the schema
   * expects — trimming strings, splitting a comma-separated query value,
   * dropping empties. Never sees a validated value.
   */
  normalize?: (value: In, req: BunRequest) => unknown;
  /**
   * Runs **after** a successful validation, to derive the final value the
   * handler sees. Use for enrichment that a schema cannot express.
   */
  transform?: (value: Out, req: BunRequest) => unknown;
}

/** Configuration for a {@link BunValidate} instance. */
export interface BunValidateOptions<
  S extends ValidationSchemas = ValidationSchemas,
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
   */
  replace?: boolean;
  /** Per-target `normalize`/`transform` hooks. */
  hooks?: { [K in ValidationTarget]?: TargetHooks };
  /**
   * Builds the body sent by `"respond"`. Defaults to
   * `{ error: "Validation failed", issues }`.
   */
  formatError?: (error: ValidationError, req: BunRequest) => unknown;
}

/** Reads a target off the request. */
function readTarget(req: BunRequest, target: ValidationTarget): unknown {
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

/** Writes a validated value back onto the request. */
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
 * Works with any conforming library — Zod 3.24+, Valibot, ArkType — with no
 * dependency on any of them, because Standard Schema is a spec the schema
 * object itself implements.
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
export class BunValidate<S extends ValidationSchemas = ValidationSchemas> {
  /** Targets that have a schema, in a fixed order for predictable reporting. */
  readonly #targets: ValidationTarget[];
  readonly #options: Required<
    Pick<
      BunValidateOptions<S>,
      "onFailure" | "status" | "abortEarly" | "replace"
    >
  > &
    BunValidateOptions<S>;

  constructor(options: BunValidateOptions<S>) {
    this.#options = {
      onFailure: "next",
      status: 400,
      abortEarly: false,
      replace: true,
      ...options,
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
  public middleware(): ValidatorMiddleware<InferValidatedShape<S>> {
    const {
      onFailure,
      status,
      abortEarly,
      replace,
      schemas,
      hooks,
      formatError,
    } = this.#options;
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
        const body = formatError
          ? formatError(error, req)
          : { error: "Validation failed", issues: error.issues };
        return res.status(status).json(body as Record<string, unknown>);
      }
      return next(error);
    };

    return handler as ValidatorMiddleware<InferValidatedShape<S>>;
  }

  /** Shorthand for `new BunValidate(options).middleware()`. */
  public static middleware<S extends ValidationSchemas>(
    options: BunValidateOptions<S>,
  ): ValidatorMiddleware<InferValidatedShape<S>> {
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
  readonly __shape?: TShape;
}

/** Convenience wrapper matching the example in {@link BunValidate}. */
export function validate<S extends ValidationSchemas>(
  schemas: S,
  options?: Omit<BunValidateOptions<S>, "schemas">,
): ValidatorMiddleware<InferValidatedShape<S>> {
  return new BunValidate({ ...options, schemas }).middleware();
}
