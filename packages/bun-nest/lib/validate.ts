/**
 * BunValidate for NestJS, the `@Validate` decorator's request side (plan
 * `docs/plans/bun-validate/` §4.5.1–§4.5.2, PR V7a):
 *
 * - {@link Validate}: a method or class decorator checking a route's request
 *   parts (`params`, `query`, `headers`, `cookies`, `signedCookies`, `body`)
 *   against Standard Schemas, before the handler and before Nest's pipes.
 *   Parsed parts are written back in place (headers excepted, which are never
 *   written back, as on bun-common's `validate()`) and recorded on the
 *   request's `valid` view. A failure throws a
 *   `StandardValidationException` (400), which `ValidationExceptionFilter`
 *   answers with `{ error, issues }`.
 * - {@link Validated} and its per-part aliases ({@link ValidBody},
 *   {@link ValidQuery}, {@link ValidParams}, {@link ValidHeaders},
 *   {@link ValidCookies}, {@link ValidSignedCookies}): parameter decorators
 *   reading one part of the request's `valid` view, so a coerced value
 *   arrives coerced.
 *
 * On Nest 12 the interceptor **composes** with `@Body({ schema })` and the
 * other parameter decorators' `{ schema }`: it skips a part only when a
 * whole-part parameter decorator for it carries a schema **and** Nest's own
 * `StandardSchemaValidationPipe` applies to that parameter (from the
 * parameter's, the method's or the class's `@UsePipes`, or the global pipes).
 * The pipe's class is read once from the installed `@nestjs/common` — the
 * capability, never a version; where it does not exist (Nest 11) nothing is
 * skipped. A keyed decorator (`@Body("field", { schema })`) covers one
 * property, never the part. Headers can never be skipped: Nest runs no pipes
 * on them. Every schema, skipped or not, is recorded on the route's contract
 * (`getContract` on the handler or the class), so documents see it.
 *
 * Everything here works on Nest 11 and 12 alike, on any adapter: the request
 * is read and written through plain properties (Express 5's getter-only
 * `query` is defined over, as plan §4.5.6 says).
 */
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import type {
  StandardOutcome,
  StandardSchemaV1,
  ValidationIssue,
  ValidationSchemas,
} from "@kingsleyweb/bun-common";
import { createRequire } from "node:module";
import {
  createParamDecorator,
  Injectable,
  Inject,
  Optional,
  SetMetadata,
  UseInterceptors,
} from "@nestjs/common";
import { ApplicationConfig } from "@nestjs/core";
import {
  attachContract,
  getContract,
  validate,
  validateStandard,
} from "@kingsleyweb/bun-common";
import { StandardValidationException } from "./validation";

/**
 * A request part {@link Validate} checks, and {@link Validated} reads from
 * the request's `valid` view.
 */
type ValidatePart =
  "headers" | "cookies" | "signedCookies" | "params" | "query" | "body";

/**
 * The parts in the order they are checked: a cheap header or session check
 * fails before a body is parsed (bun-common's order).
 */
const VALIDATE_PARTS: readonly ValidatePart[] = [
  "headers",
  "cookies",
  "signedCookies",
  "params",
  "query",
  "body",
];

/** The metadata key {@link Validate} stores its schemas under. Registered (`Symbol.for`), so a route decorated by another copy of this package is still recognised. */
const VALIDATE_SCHEMAS: unique symbol = Symbol.for("bun-nest.validateSchemas");

/**
 * The strip rule for a part checked here: Nest 12's own (`"nest"`), as the
 * pipes'. A `params` schema checks without it, as bun-common's `validate()`
 * runs them: the keys are the route's own, and the matched-pipeline cache
 * shares the object across requests.
 */
const STRIP: { stripProtoKeys: "nest" } = Object.freeze({
  stripProtoKeys: "nest",
});

/** Whether `value` is a Standard Schema (has a `~standard.validate`). */
function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return false;
  }
  const props = (value as { "~standard"?: { validate?: unknown } })[
    "~standard"
  ];
  return typeof props?.validate === "function";
}

/**
 * Checks the `schemas` argument of {@link Validate}: known parts only, each a
 * Standard Schema. A mistake throws at decoration, not on the first request
 * — as `validate()` throws for an unknown target.
 */
function checkSchemas(schemas: ValidationSchemas): void {
  if (typeof schemas !== "object" || schemas === null) {
    throw new TypeError("@Validate: the schemas must be an object");
  }
  for (const key of Object.keys(schemas)) {
    if (!VALIDATE_PARTS.includes(key as ValidatePart)) {
      throw new TypeError(
        `@Validate: unknown part "${key}"; the parts are ${VALIDATE_PARTS.join(", ")}`,
      );
    }
    if (!isStandardSchema(schemas[key as ValidatePart])) {
      throw new TypeError(
        `@Validate: the "${key}" schema must be a Standard Schema (an object with \`~standard.validate\`)`,
      );
    }
  }
}

/** The part's raw value on the request; `{}` for cookies when nothing parsed them. */
function readPart(req: Record<string, unknown>, part: ValidatePart): unknown {
  switch (part) {
    case "cookies":
    case "signedCookies":
      return req[part] ?? {};
    default:
      return req[part];
  }
}

/**
 * Writes a parsed part back onto the request, in place. bun-common's
 * `BunRequest` has a setter for each of these; Express 5's `query` is a
 * getter with no setter, which a plain assignment cannot override, so that
 * one is defined over (plan §4.5.6).
 */
function writePart(
  req: Record<string, unknown>,
  part: ValidatePart,
  value: unknown,
): void {
  let owner: object | null = req;
  let descriptor: PropertyDescriptor | undefined;
  while (owner !== null) {
    descriptor = Object.getOwnPropertyDescriptor(owner, part);
    if (descriptor !== undefined) break;
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  if (
    descriptor !== undefined &&
    descriptor.set === undefined &&
    descriptor.get !== undefined
  ) {
    Object.defineProperty(req, part, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    return;
  }
  req[part] = value;
}

/** Records a parsed part on the request's `valid` view (allocated on first read on a `BunRequest`, here otherwise). */
function recordValid(
  req: Record<string, unknown>,
  part: ValidatePart,
  value: unknown,
): void {
  const valid = (req.valid ??= {}) as Record<string, unknown>;
  valid[part] = value;
}

/* ------------------------------------------------------------------ *
 * The skip rule: what Nest 12's own schema pipe already checks
 * ------------------------------------------------------------------ */

/** A route's argument metadata entry, as `@nestjs/common`'s `assignMetadata` writes it. */
interface RouteArgsEntry {
  /** The parameter's position. */
  index: number;
  /** The decorator's key (`@Query("page")`); `undefined` for a whole-part decorator. */
  data?: string;
  /** The parameter's own pipes. */
  pipes?: readonly unknown[];
  /** The decorator's `{ schema }`, present only on Nest 12. */
  schema?: StandardSchemaV1;
}

/** A structural slice of Nest's `ApplicationConfig` (the global pipes, plain and request-scoped). */
interface GlobalPipes {
  /** The application's global pipes, as instances. */
  getGlobalPipes: () => readonly unknown[];
  /** The request-scoped global pipes, as instance wrappers (their `metatype` is the class). */
  getGlobalRequestPipes?: () => readonly {
    metatype?: unknown;
    instance?: unknown;
  }[];
}

/**
 * `require` from this file, for reading Nest 12's own schema pipe off the
 * installed `@nestjs/common` (the capability the skip rule gates on).
 */
const requireFromHere = createRequire(import.meta.url);

/** The read of {@link nestSchemaPipe}, done once: `undefined` until then. */
let schemaPipeClass: { current: unknown } | undefined;

/**
 * Nest's own `StandardSchemaValidationPipe` class where the installed Nest
 * has one (12.0 and later), `undefined` where it does not — the capability,
 * read once, never a version string.
 */
function nestSchemaPipe(): unknown {
  if (schemaPipeClass === undefined) {
    schemaPipeClass = {
      current: (requireFromHere("@nestjs/common") as Record<string, unknown>)
        .StandardSchemaValidationPipe,
    };
  }
  return schemaPipeClass.current;
}

/** Whether `pipe` (a class or an instance) is Nest's own schema pipe. */
function isNestSchemaPipe(pipe: unknown, pipeClass: unknown): boolean {
  return (
    typeof pipeClass === "function" &&
    (pipe === pipeClass ||
      pipe instanceof (pipeClass as abstract new (...args: never[]) => object))
  );
}

/** Whether `pipe` (a class or an instance) is a constructor parameter marker. */
function pipesOn(target: object): readonly unknown[] {
  const pipes = Reflect.getMetadata("__pipes__", target) as
    readonly unknown[] | undefined;
  return pipes ?? [];
}

/**
 * Whether Nest's own schema pipe applies to a parameter, from any of the
 * four sources: the parameter's own pipes, the method's `@UsePipes`, the
 * class's, or the application's global pipes (plain and request-scoped). A
 * source that cannot be read is treated as absent: when in doubt, the part
 * is checked.
 */
function pipeApplies(
  classRef: object,
  handler: object,
  entryPipes: readonly unknown[],
  config: GlobalPipes | undefined,
): boolean {
  const pipeClass = nestSchemaPipe();
  if (pipeClass === undefined) return false;
  for (const pipe of entryPipes) {
    if (isNestSchemaPipe(pipe, pipeClass)) return true;
  }
  for (const pipe of pipesOn(handler)) {
    if (isNestSchemaPipe(pipe, pipeClass)) return true;
  }
  for (const pipe of pipesOn(classRef)) {
    if (isNestSchemaPipe(pipe, pipeClass)) return true;
  }
  if (config !== undefined) {
    for (const pipe of config.getGlobalPipes()) {
      if (isNestSchemaPipe(pipe, pipeClass)) return true;
    }
    for (const wrapper of config.getGlobalRequestPipes?.() ?? []) {
      if (
        isNestSchemaPipe(wrapper.metatype, pipeClass) ||
        isNestSchemaPipe(wrapper.instance, pipeClass)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** No part is skipped; the set {@link skippedParts} answers where there is nothing to read. */
const NONE_SKIPPED: ReadonlySet<ValidatePart> = new Set();

/**
 * The parts of a route that Nest's own schema pipe already checks: those
 * with a whole-part parameter decorator carrying a `{ schema }` (a keyed one
 * covers one property, never the part; `RAW_BODY` is never `body`), where
 * the pipe applies to that parameter. Empty wherever the installed Nest has
 * no such pipe (Nest 11 never skips).
 */
function skippedParts(
  classRef: object & { name?: string },
  handler: object & { name?: string },
  config: GlobalPipes | undefined,
): ReadonlySet<ValidatePart> {
  if (nestSchemaPipe() === undefined) return NONE_SKIPPED;
  const metadata = Reflect.getMetadata(
    "__routeArguments__",
    classRef,
    handler.name as string | symbol,
  ) as Record<string, RouteArgsEntry> | undefined;
  if (metadata === undefined) return NONE_SKIPPED;
  const skipped = new Set<ValidatePart>();
  for (const key of Object.keys(metadata)) {
    const paramtype = Number(key.split(":")[0]);
    // BODY 3, QUERY 4, PARAM 5 (`@nestjs/common`'s RouteParamtypes, both
    // majors); RAW_BODY (12) is a raw-body part, never `body`, and no other
    // paramtype carries a `{ schema }`.
    const part: ValidatePart | undefined =
      paramtype === 3
        ? "body"
        : paramtype === 4
          ? "query"
          : paramtype === 5
            ? "params"
            : undefined;
    if (part === undefined) continue;
    const entry = metadata[key];
    if (entry.schema === undefined || entry.data !== undefined) continue;
    if (pipeApplies(classRef, handler, entry.pipes ?? [], config)) {
      skipped.add(part);
    }
  }
  return skipped.size === 0 ? NONE_SKIPPED : skipped;
}

/**
 * The route's merged schemas: the class's under the method's, per part (a
 * part both declare is the method's).
 */
function mergedSchemas(
  classRef: object,
  handler: object,
): ValidationSchemas | undefined {
  const onMethod = Reflect.getMetadata(VALIDATE_SCHEMAS, handler) as
    ValidationSchemas | undefined;
  const onClass = Reflect.getMetadata(VALIDATE_SCHEMAS, classRef) as
    ValidationSchemas | undefined;
  if (onMethod === undefined) return onClass;
  if (onClass === undefined) return onMethod;
  return { ...onClass, ...onMethod };
}

/* ------------------------------------------------------------------ *
 * The interceptor
 * ------------------------------------------------------------------ */

/**
 * The interceptor {@link Validate} wires: checks the route's declared parts
 * and replaces them in place with their parsed outputs, records every parsed
 * part on the request's `valid` view, and throws a
 * `StandardValidationException` on the first failure's issues (all parts are
 * checked first, so the error carries every issue, as `validate()`'s does).
 * Internal: `Validate` applies it; Nest builds it with the application's
 * `ApplicationConfig` when it can (the global-pipes source of the skip
 * rule), and the skip rule errs on the side of checking when it cannot.
 */
class ValidateInterceptor implements NestInterceptor {
  /** The application's config, for the global pipes; `undefined` when built by hand. */
  readonly #config: ApplicationConfig | undefined;
  /** The skip rule's answer per route handler, computed once. */
  readonly #skipped = new WeakMap<object, ReadonlySet<ValidatePart>>();

  /**
   * @param config The application's `ApplicationConfig`, injected by Nest;
   *   `undefined` when the interceptor is built by hand, and the global
   *   pipes then cannot be read, so no part is skipped on their account.
   */
  constructor(config?: ApplicationConfig) {
    this.#config = config;
  }

  /**
   * Checks the route's parts, in `VALIDATE_PARTS` order, then hands on.
   * Synchronous when every schema answers synchronously; a Promise only when
   * one answers with one (yup). Not an HTTP context (a gateway's): nothing
   * is checked — gateway validation is V9's.
   */
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> | Promise<Observable<unknown>> {
    if (context.getType<string>() !== "http") {
      return next.handle();
    }
    const classRef = context.getClass();
    const handler = context.getHandler();
    const schemas = mergedSchemas(classRef, handler);
    if (schemas === undefined) {
      return next.handle();
    }
    let skipped = this.#skipped.get(handler);
    if (skipped === undefined) {
      skipped = skippedParts(classRef, handler, this.#config);
      this.#skipped.set(handler, skipped);
    }

    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    const issues: ValidationIssue<ValidatePart>[] = [];
    const runPart = (
      part: ValidatePart,
      schema: StandardSchemaV1,
    ): void | Promise<void> => {
      const outcome = validateStandard(
        schema,
        readPart(req, part),
        part,
        undefined,
        undefined,
        part === "params" ? undefined : STRIP,
      );
      const settle = (
        settled: StandardOutcome<unknown, ValidatePart>,
      ): void => {
        if (settled.ok) {
          // Headers are never written back (bun-common's rule: the live
          // header store feeds `accepts`, `type-is` and the body parsers);
          // their parsed view is on `req.valid` alone.
          if (part !== "headers") {
            writePart(req, part, settled.value);
          }
          recordValid(req, part, settled.value);
        } else {
          issues.push(...settled.issues);
        }
      };
      return outcome instanceof Promise
        ? outcome.then(settle)
        : settle(outcome);
    };

    let chain: Promise<void> | undefined;
    for (const part of VALIDATE_PARTS) {
      const schema = schemas[part];
      if (schema === undefined || skipped.has(part)) continue;
      if (chain === undefined) {
        const ran = runPart(part, schema);
        if (ran instanceof Promise) {
          chain = ran;
        }
      } else {
        chain = chain.then(() => runPart(part, schema));
      }
    }
    const finish = (): Observable<unknown> => {
      if (issues.length > 0) {
        throw new StandardValidationException<ValidatePart>(issues);
      }
      return next.handle();
    };
    return chain === undefined ? finish() : chain.then(finish);
  }
}

// `@Optional() @Inject(ApplicationConfig)` on the constructor's parameter, by
// call: Bun reads the decorator options from the working directory's tsconfig
// (oven-sh/bun#28605), and the call behaves the same under either decorator
// semantics (validation.ts has the same pattern).
Injectable()(ValidateInterceptor);
Optional()(ValidateInterceptor, undefined, 0);
Inject(ApplicationConfig)(ValidateInterceptor, undefined, 0);

/* ------------------------------------------------------------------ *
 * @Validate
 * ------------------------------------------------------------------ */

/**
 * Validates a route's request parts with Standard Schemas — an interceptor,
 * method or class level, merged per part when both (a part both declare is
 * the method's):
 *
 * ```ts
 * @Validate({ params: IdParams, query: Page, headers: ApiHeaders, body: CreateUser })
 * @Post(":id")
 * create(@Validated("body") body: Infer<typeof CreateUser>) { … }
 * ```
 *
 * Each part is checked before the handler and before Nest's pipes, and the
 * parsed output is written back in place (`req.query`, `req.body`, …) and
 * recorded on the request's `valid` view, which `@Validated(part)` reads.
 * Headers are the exception: they are checked and typed on `valid.headers`,
 * never written back. A failure throws a `StandardValidationException`
 * (400), carrying every part's issues with no received value;
 * `ValidationExceptionFilter` answers it with `{ error, issues }`.
 *
 * On Nest 12 a part is left to Nest's own `StandardSchemaValidationPipe`
 * when a whole-part parameter decorator (`@Body({ schema })`, and `@Query` /
 * `@Param` alike) covers it and the pipe applies — the part is checked once,
 * by whichever runs; the schema is still recorded on the route's contract
 * (`getContract` on the handler, or on the class for a class-level
 * `@Validate`), so documents see it. On Nest 11 `@Validate` checks every
 * part itself.
 *
 * @param schemas The parts to check, keyed by part; an unknown key, or a
 *   value that is not a Standard Schema, throws a `TypeError` at decoration.
 */
export function Validate(
  schemas: ValidationSchemas,
): MethodDecorator & ClassDecorator {
  checkSchemas(schemas);
  // The route's contract, recorded so documents read every schema — the one
  // bun-common's `validate()` builds for the same parts.
  const contract = getContract(validate(schemas));
  const decorator = (
    target: object,
    key?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    if (key !== undefined && descriptor !== undefined) {
      SetMetadata(VALIDATE_SCHEMAS, schemas)(target, key, descriptor);
      UseInterceptors(ValidateInterceptor)(target, key, descriptor);
      attachContract(descriptor.value as object, contract);
      return;
    }
    // The class form's target is the constructor, which TS's `ClassDecorator`
    // types as `Function` (a construct signature is one).
    SetMetadata(VALIDATE_SCHEMAS, schemas)(target as new () => object);
    UseInterceptors(ValidateInterceptor)(target as new () => object);
    attachContract(target, contract);
  };
  return decorator as MethodDecorator & ClassDecorator;
}

/* ------------------------------------------------------------------ *
 * @Validated and its per-part aliases
 * ------------------------------------------------------------------ */

/**
 * A parameter decorator reading one part of the request's `valid` view —
 * what `@Validate` (or a `validate()` middleware) parsed — so a coerced
 * header arrives coerced:
 *
 * ```ts
 * @Get()
 * list(@Validated("query") query: Infer<typeof Page>) { … }
 * ```
 *
 * The value is `undefined` when nothing validated that part. An unknown part
 * throws a `TypeError` at decoration.
 *
 * @param part The part to read: `"params"`, `"query"`, `"headers"`,
 *   `"cookies"`, `"signedCookies"` or `"body"`.
 */
export function Validated(part: ValidatePart): ParameterDecorator {
  if (!VALIDATE_PARTS.includes(part)) {
    throw new TypeError(
      `@Validated: unknown part "${part}"; the parts are ${VALIDATE_PARTS.join(", ")}`,
    );
  }
  return createParamDecorator((_data: unknown, context: ExecutionContext) => {
    const req = context
      .switchToHttp()
      .getRequest<{ valid?: Record<string, unknown> }>();
    return req.valid?.[part];
  })();
}

/** `@Validated("body")`: the parsed body. */
export function ValidBody(): ParameterDecorator {
  return Validated("body");
}

/** `@Validated("query")`: the parsed query. */
export function ValidQuery(): ParameterDecorator {
  return Validated("query");
}

/** `@Validated("params")`: the parsed route params. */
export function ValidParams(): ParameterDecorator {
  return Validated("params");
}

/** `@Validated("headers")`: the parsed headers (the only typed view of them; `req.headers` stays raw). */
export function ValidHeaders(): ParameterDecorator {
  return Validated("headers");
}

/** `@Validated("cookies")`: the parsed cookies. */
export function ValidCookies(): ParameterDecorator {
  return Validated("cookies");
}

/** `@Validated("signedCookies")`: the parsed signed cookies (a tampered one is `false`, so it fails its schema). */
export function ValidSignedCookies(): ParameterDecorator {
  return Validated("signedCookies");
}
