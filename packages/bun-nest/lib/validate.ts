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
  MessageEvent,
  NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import type {
  AllowedStatus,
  InferResponses,
  JsonBodyFor,
  ResponseChecker,
  ResponseCheckerOptions,
  ResponseCheckView,
  ResponseReplacement,
  ResponseSchemas,
  ResponseStreamCheck,
  ResponseValidationMode,
  StandardOutcome,
  StandardSchemaV1,
  ValidationIssue,
  ValidationSchemas,
  VariantNames,
} from "@kingsleyweb/bun-common";
import type { BunBeforeWriteContext, BunHttpAdapter } from "./BunHttpAdapter";
import { createRequire } from "node:module";
import {
  createParamDecorator,
  HttpException,
  Injectable,
  Inject,
  Logger,
  Optional,
  SetMetadata,
  UseInterceptors,
} from "@nestjs/common";
import { ApplicationConfig, HttpAdapterHost } from "@nestjs/core";
import { catchError, concatMap, mergeMap } from "rxjs";
import {
  attachContract,
  createResponseChecker,
  getContract,
  ResponseValidationError,
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
 * The `schemas` argument of {@link Validate}: the request parts to check
 * (bun-common's `ValidationSchemas`), the responses to check
 * (`responses`, the same `ResponseSchemas` as bun-common's `validate()`),
 * and the responses' policy (`responseValidation`, default `"off"`, as
 * `validate()`'s).
 */
export type ValidateSchemas = ValidationSchemas & {
  /** The response contract, per status — checked in the interceptor and, for what `map()` cannot see (plain `@Res()`, `StreamableFile`, redirects), the adapter's before-write hook. */
  responses?: ResponseSchemas;
  /** The responses' policy: `"warn"` logs and sends, `"error"` refuses (500), `"off"` (the default) checks nothing but still applies a named variant's adjust. */
  responseValidation?: ResponseValidationMode;
};

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
 * Checks the `schemas` argument of {@link Validate}: known keys only, each
 * part a Standard Schema, `responses` checked by bun-common's `validate()`
 * (a bad declaration throws here, at decoration), `responseValidation` one
 * of the three policies.
 */
function checkSchemas(schemas: ValidateSchemas): void {
  if (typeof schemas !== "object" || schemas === null) {
    throw new TypeError("@Validate: the schemas must be an object");
  }
  for (const key of Object.keys(schemas)) {
    if (key === "responses") {
      if (!isResponseSchemas(schemas.responses)) {
        throw new TypeError(
          "@Validate: the responses must be a ResponseSchemas declaration (a record of statuses to response specs)",
        );
      }
      continue;
    }
    if (key === "responseValidation") {
      if (
        schemas.responseValidation !== "off" &&
        schemas.responseValidation !== "warn" &&
        schemas.responseValidation !== "error"
      ) {
        throw new TypeError(
          '@Validate: responseValidation must be "off", "warn" or "error"',
        );
      }
      continue;
    }
    if (!VALIDATE_PARTS.includes(key as ValidatePart)) {
      throw new TypeError(
        `@Validate: unknown part "${key}"; the parts are ${[...VALIDATE_PARTS, "responses", "responseValidation"].join(", ")}`,
      );
    }
    if (!isStandardSchema(schemas[key as ValidatePart])) {
      throw new TypeError(
        `@Validate: the "${key}" schema must be a Standard Schema (an object with \`~standard.validate\`)`,
      );
    }
  }
}

/** Whether `value` looks like a `ResponseSchemas` declaration (an object of statuses); `validate()` checks it in full. */
function isResponseSchemas(value: unknown): value is ResponseSchemas {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
): ValidateSchemas | undefined {
  const onMethod = Reflect.getMetadata(VALIDATE_SCHEMAS, handler) as
    ValidateSchemas | undefined;
  const onClass = Reflect.getMetadata(VALIDATE_SCHEMAS, classRef) as
    ValidateSchemas | undefined;
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
  /** The host whose adapter the before-write hook is registered on, when it can take one. */
  readonly #adapterHost: HttpAdapterHost | undefined;
  /** The skip rule's answer per route handler, computed once. */
  readonly #skipped = new WeakMap<object, ReadonlySet<ValidatePart>>();
  /** The response checker per route handler, built once. */
  readonly #checkers = new WeakMap<object, ResponseChecker>();

  /**
   * @param config      The application's `ApplicationConfig`, injected by Nest;
   *   `undefined` when the interceptor is built by hand, and the global
   *   pipes then cannot be read, so no part is skipped on their account.
   * @param adapterHost The application's `HttpAdapterHost`, injected by Nest;
   *   without it (built by hand, or another platform) a plain `@Res()` or
   *   `StreamableFile` response is checked only as far as `map()` reaches.
   */
  constructor(config?: ApplicationConfig, adapterHost?: HttpAdapterHost) {
    this.#config = config;
    this.#adapterHost = adapterHost;
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
      return this.handOff(context, next, handler, classRef, schemas);
    };
    return chain === undefined ? finish() : chain.then(finish);
  }

  /** Where a `"warn"` mismatch and a failed check are logged (shared by every route's checker). */
  readonly #logger = new Logger("ValidateInterceptor");

  /** The route's response checker, built once from its `responses`. */
  #checkerFor(handler: object, schemas: ValidateSchemas): ResponseChecker {
    let checker = this.#checkers.get(handler);
    if (checker === undefined) {
      const options: ResponseCheckerOptions = {
        mode: schemas.responseValidation ?? "off",
        logger: this.#logger,
      };
      checker = createResponseChecker(schemas.responses!, options);
      this.#checkers.set(handler, checker);
    }
    return checker;
  }

  /**
   * Hands the route on after the request phase: plainly when it declares no
   * `responses`; through the response phase when it does — `map()` and
   * `catchError` for what they see (the status, the `@Header()` headers and
   * the returned body, a thrown non-2xx), the adapter's before-write hook
   * for what they cannot (a plain `@Res()`, a `StreamableFile`, a redirect),
   * and per event for `@Sse()`.
   */
  protected handOff(
    context: ExecutionContext,
    next: CallHandler,
    handler: object,
    classRef: object,
    schemas: ValidateSchemas,
  ): Observable<unknown> {
    if (schemas.responses === undefined) {
      return next.handle();
    }
    const checker = this.#checkerFor(handler, schemas);
    if (isPlainResRoute(classRef, handler)) {
      // `map()` runs after the response is sent, with a discarded value
      // (measured on both majors): the before-write hook covers it.
      this.#registerHook(context, checker);
      return next.handle();
    }
    if (isRedirectRoute(handler)) {
      // The redirect's status and `location` are applied at reply, after
      // `map()`: the hook checks them.
      this.#registerHook(context, checker);
      return next.handle();
    }
    if (isSseRoute(handler)) {
      return this.#ssePipe(context, next, checker);
    }
    return next.handle().pipe(
      mergeMap((value) => this.#checkReturned(context, checker, value)),
      catchError((error: unknown) =>
        this.#checkThrown(context, checker, error),
      ),
    );
  }

  /**
   * Checks a returned value in `map()`: unwraps a `reply()` (its status,
   * headers and variant are applied to the response first), lets a
   * `StreamableFile` through to the before-write hook, and checks the
   * status, the `@Header()` headers and the body against the route's
   * `responses`. A refused response throws a `ResponseValidationError`;
   * a variant's adjust comes back as a replacement and is applied.
   */
  async #checkReturned(
    context: ExecutionContext,
    checker: ResponseChecker,
    value: unknown,
  ): Promise<unknown> {
    const res = context.switchToHttp().getResponse<NestResponseView>();
    const req = context.switchToHttp().getRequest();
    let body = value;
    let variant: string | undefined;
    if (isReply(value)) {
      body = value.body;
      variant = value.variant;
      res.statusCode = value.status;
      if (value.headers !== undefined) {
        for (const [name, headerValue] of Object.entries(value.headers)) {
          res.set(name, headerValue);
        }
      }
    }
    if (isStreamableFile(body)) {
      // Its headers are applied in `reply()`, after `map()`: the hook checks.
      this.#registerHook(context, checker);
      return body;
    }
    const kind =
      body === undefined || body === null
        ? "empty"
        : typeof body === "string"
          ? "text"
          : body instanceof Uint8Array || ArrayBuffer.isView(body)
            ? "bytes"
            : "json";
    const headers = responseHeaders(res);
    const verdict = await checker.check({
      req: req as ResponseCheckView["req"],
      status: res.statusCode,
      headers,
      kind,
      body,
      contentType:
        headers.get("content-type") ??
        (kind === "json" ? "application/json" : undefined),
      variant,
    });
    if (verdict instanceof ResponseValidationError) {
      throw verdict;
    }
    if (verdict !== undefined && "replacement" in verdict) {
      return applyReplacement(res, verdict);
    }
    return body;
  }

  /**
   * Checks a thrown non-2xx in `catchError`: a declared status's body is
   * checked as the JSON Nest will send. Our own errors are rethrown
   * unchecked; anything that is not an `HttpException` too.
   */
  async #checkThrown(
    context: ExecutionContext,
    checker: ResponseChecker,
    error: unknown,
  ): Promise<never> {
    if (
      error instanceof StandardValidationException ||
      error instanceof ResponseValidationError ||
      !(error instanceof HttpException)
    ) {
      throw error;
    }
    const req = context.switchToHttp().getRequest();
    const verdict = await checker.check({
      req: req as ResponseCheckView["req"],
      status: error.getStatus(),
      headers: new Headers(),
      kind: "json",
      body: error.getResponse(),
      contentType: "application/json",
    });
    if (verdict instanceof ResponseValidationError) {
      throw verdict;
    }
    throw error;
  }

  /**
   * Checks each `@Sse()` event before Nest writes it: the status and headers
   * once (with the first event, still refusable before the commit), then
   * each event against its `sse()` event map, fed with the exact wire text
   * Nest will write. A refused event after the commit reaches the client as
   * Nest's `event: error` with the scrubbed message (measured, plan §4.7.2).
   */
  #ssePipe(
    context: ExecutionContext,
    next: CallHandler,
    checker: ResponseChecker,
  ): Observable<unknown> {
    const res = context.switchToHttp().getResponse<NestResponseView>();
    const req = context.switchToHttp().getRequest();
    let opened = false;
    let stream: ResponseStreamCheck | undefined;
    // `concatMap`, not `mergeMap`: each event's check settles before the next
    // begins, so a synchronous burst is checked in order and can neither
    // overtake the open check nor slip past it (`stream` is set by then).
    return next.handle().pipe(
      concatMap(async (event: MessageEvent) => {
        if (!opened) {
          opened = true;
          const verdict = await checker.check({
            req: req as ResponseCheckView["req"],
            status: res.statusCode,
            headers: responseHeaders(res),
            kind: "native",
            body: null,
            contentType: "text/event-stream",
          });
          if (verdict instanceof ResponseValidationError) {
            throw verdict;
          }
          stream =
            verdict !== undefined && "chunk" in verdict ? verdict : undefined;
        }
        // Heartbeats and comments are not events and are never checked.
        if (stream !== undefined && !isCommentOnly(event)) {
          const error = await stream.chunk(formatSseMessage(event));
          if (error !== undefined) {
            throw error;
          }
        }
        return event;
      }),
    );
  }

  /**
   * Registers a one-request before-write hook for what `map()` cannot see:
   * a plain `@Res()` response, a `StreamableFile`, a redirect. The hook
   * checks the final status, headers and body against the route's
   * `responses`; a refusal throws the `ResponseValidationError`, and the
   * adapter answers a fresh 500 through Nest's filters. Without an adapter
   * that takes hooks (built by hand, or another platform), the response is
   * checked only as far as `map()` reached.
   */
  #registerHook(context: ExecutionContext, checker: ResponseChecker): void {
    const adapter = this.#adapterHost?.httpAdapter;
    if (!hasBeforeWriteHooks(adapter)) {
      return;
    }
    const req = context.switchToHttp().getRequest();
    const remove = adapter.addBeforeWriteHook(
      async (write: BunBeforeWriteContext) => {
        if (write.phase !== "response" || write.response?.req !== req) {
          return;
        }
        remove();
        const verdict = await checker.check(hookView(write));
        if (verdict instanceof ResponseValidationError) {
          throw verdict;
        }
        if (verdict !== undefined && "replacement" in verdict) {
          throw new ResponseValidationError(
            [
              {
                target: "body",
                key: String(write.status),
                path: "",
                message:
                  "A variant's adjust cannot be applied outside the router; set the variant's fields on the response itself",
              },
            ],
            write.status,
          );
        }
      },
    );
  }
}

// `@Optional() @Inject(...)` on the constructor's parameters, by call: Bun
// reads the decorator options from the working directory's tsconfig
// (oven-sh/bun#28605), and the call behaves the same under either decorator
// semantics (validation.ts has the same pattern).
Injectable()(ValidateInterceptor);
Optional()(ValidateInterceptor, undefined, 0);
Inject(ApplicationConfig)(ValidateInterceptor, undefined, 0);
Optional()(ValidateInterceptor, undefined, 1);
Inject(HttpAdapterHost)(ValidateInterceptor, undefined, 1);

/* ------------------------------------------------------------------ *
 * The response phase's helpers
 * ------------------------------------------------------------------ */

/** The slice of the Nest-facing response the response phase reads and writes (bun-nest's `BunResponse`, and Express's). */
interface NestResponseView {
  /** The status Nest set (`@HttpCode`, POST's 201, `@Res()`'s own). */
  statusCode: number;
  /** Sets one header. */
  set: (name: string, value: string) => unknown;
  /** A snapshot of the headers set so far, `set-cookie` an array of lines. */
  getHeaders: () => Record<string, string | string[]>;
}

/** The final headers as a native `Headers`, each `Set-Cookie` its own line. */
function responseHeaders(res: NestResponseView): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.getHeaders())) {
    if (Array.isArray(value)) {
      for (const line of value) {
        headers.append(name, line);
      }
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

/** Applies a variant's adjusted response (the checker's replacement verdict) to the response, and answers the body to send. */
async function applyReplacement(
  res: NestResponseView,
  verdict: ResponseReplacement,
): Promise<unknown> {
  const { replacement, body } = verdict;
  res.statusCode = replacement.status;
  replacement.headers.forEach((value, name) => {
    void res.set(name, value);
  });
  if (body !== undefined) {
    return body;
  }
  const contentType = replacement.headers.get("content-type") ?? "";
  return contentType.includes("json") ? replacement.json() : replacement.text();
}

/** Whether `adapter` takes before-write hooks (bun-nest's `BunHttpAdapter`). */
function hasBeforeWriteHooks(
  adapter: unknown,
): adapter is Pick<BunHttpAdapter, "addBeforeWriteHook"> {
  return (
    typeof adapter === "object" &&
    adapter !== null &&
    typeof (adapter as { addBeforeWriteHook?: unknown }).addBeforeWriteHook ===
      "function"
  );
}

/** Whether the route's handler is a plain `@Res()` (or `@Next()`) route: `map()` runs there after the response is sent, so the before-write hook checks it instead. */
function isPlainResRoute(
  classRef: object,
  handler: { name?: string },
): boolean {
  const metadata = Reflect.getMetadata(
    "__routeArguments__",
    classRef,
    handler.name as string | symbol,
  ) as Record<string, RouteArgsEntry> | undefined;
  if (metadata === undefined) return false;
  const hasResponseParam = Object.keys(metadata).some((key) => {
    const paramtype = Number(key.split(":")[0]);
    // RESPONSE 1, NEXT 2 (`@nestjs/common`'s RouteParamtypes).
    return paramtype === 1 || paramtype === 2;
  });
  if (!hasResponseParam) return false;
  return (
    Reflect.getMetadata(
      "__responsePassthrough__",
      classRef,
      handler.name as string | symbol,
    ) !== true
  );
}

/** Whether the route is an `@Redirect()` route (its status and `location` are applied at reply, after `map()`; Nest stores the marker on the handler). */
function isRedirectRoute(handler: object): boolean {
  return Reflect.getMetadata("__redirect__", handler) !== undefined;
}

/** Whether the route is an `@Sse()` route (Nest stores the marker on the handler). */
function isSseRoute(handler: object): boolean {
  return Reflect.getMetadata("__sse__", handler) === true;
}

/** Whether `value` is Nest's `StreamableFile` (its headers are applied at reply, after `map()`). */
function isStreamableFile(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { getHeaders?: unknown }).getHeaders === "function" &&
    typeof (value as { getStream?: unknown }).getStream === "function"
  );
}

/** A comment-only SSE message (a heartbeat): not an event, never checked. `comment` is read structurally: Nest 11's `MessageEvent` type has no `comment`. */
function isCommentOnly(event: MessageEvent): boolean {
  const comment = (event as { comment?: unknown }).comment;
  return (
    comment !== undefined &&
    event.data === undefined &&
    event.type === undefined &&
    event.retry === undefined
  );
}

/**
 * The exact wire text Nest's `SseStream` writes for a `MessageEvent`
 * (`@nestjs/core`'s `formatMessage`, mirrored), so the per-event check reads
 * what the client will. `comment` is read structurally: Nest 11's
 * `MessageEvent` type has no `comment`.
 */
function formatSseMessage(message: MessageEvent): string {
  const sanitize = (value: unknown): string =>
    String(value).replace(/[\r\n]/g, "");
  const comment = (message as { comment?: unknown }).comment;
  let text =
    message.type !== undefined ? `event: ${sanitize(message.type)}\n` : "";
  if (message.id !== undefined && message.id !== null) {
    text += `id: ${sanitize(message.id)}\n`;
  }
  if (message.retry !== undefined && message.retry !== null) {
    text += `retry: ${sanitize(message.retry)}\n`;
  }
  if (comment !== undefined && comment !== null) {
    text += String(comment)
      .split(/\r\n|\r|\n/)
      .map((line) => `: ${line}\n`)
      .join("");
  }
  if (message.data !== undefined && message.data !== null) {
    const data =
      typeof message.data === "object"
        ? JSON.stringify(message.data)
        : String(message.data);
    text += data
      .split(/\r\n|\r|\n/)
      .map((line) => `data: ${line}\n`)
      .join("");
  }
  return `${text}\n`;
}

/** The `BunBeforeWriteContext` of a plain `@Res()`/`StreamableFile`/redirect response, as a check view. */
function hookView(write: BunBeforeWriteContext): ResponseCheckView {
  const body = write.body;
  let kind: ResponseCheckView["kind"];
  let value: unknown;
  switch (body.kind) {
    case "empty":
      kind = "empty";
      break;
    case "json":
    case "text":
      // A 3xx with a Location is a redirect: its generated text is exempt
      // and its status and `location` are what is checked.
      kind =
        write.status >= 300 &&
        write.status < 400 &&
        write.headers.has("location")
          ? "redirect"
          : body.kind;
      value = body.value;
      break;
    case "binary":
      kind = "bytes";
      value = body.value;
      break;
    case "blob":
      kind = "blob";
      value = body.value;
      break;
    case "stream":
      // Never buffered, as Q-H4 says; a chunks()/sse() declaration on a
      // hand-written stream cannot be fed through the hook.
      kind = "stream";
      break;
    case "response":
      kind = "native";
      value = body.value.body;
      break;
    case "form":
      kind = "native";
      value = body.value;
      break;
    case "streamable-file":
      // Its stream, teed by the checker's clone, so what is sent is untouched.
      kind = "native";
      value = body.file.getStream();
      break;
  }
  return {
    req: write.request,
    status: write.status,
    headers: write.headers,
    kind,
    body: value,
    contentType:
      write.headers.get("content-type") ??
      (kind === "json" ? "application/json" : undefined),
  };
}

/* ------------------------------------------------------------------ *
 * reply()
 * ------------------------------------------------------------------ */

/** Marks a {@link reply} value. Registered (`Symbol.for`), so a value built by another copy of this package is still recognised. */
const REPLY: unique symbol = Symbol.for("bun-nest.reply");

/**
 * What {@link reply} returns, and the interceptor unwraps. Opaque: build it
 * with `reply()`, never by hand.
 *
 * @typeParam S The status.
 */
export interface ReplyValue<S extends number = number> {
  /** The marker the interceptor reads. */
  readonly [REPLY]: true;
  /** The status to answer. */
  readonly status: S;
  /** The body to answer, checked against the status's declaration. */
  readonly body: unknown;
  /** Headers to set before the check. */
  readonly headers?: Record<string, string>;
  /** The variant to answer as (`variants()` in the route's `responses`). */
  readonly variant?: string;
}

/** The `options` of {@link reply}: headers to set, and the variant to answer as. */
export interface ReplyOptions<RS, S extends number = number> {
  /** Headers to set before the check. */
  headers?: Record<string, string>;
  /** The variant to answer as: one the status declares (its literals are filled and its undeclared body fields stripped, as `res.variant()` does). */
  variant?: [
    VariantNames<Pick<InferResponses<RS>, S & keyof InferResponses<RS>>>,
  ] extends [never]
    ? never
    : VariantNames<Pick<InferResponses<RS>, S & keyof InferResponses<RS>>>;
}

/** Whether `value` is a {@link reply} value. */
function isReply(value: unknown): value is ReplyValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [REPLY]?: unknown })[REPLY] === true
  );
}

/**
 * Answers a route's declared response, per status (plan
 * `docs/plans/bun-validate/` Q-N2, V7b): the status, body and variant are
 * typed from the route's `responses` declaration, and `@Validate`'s
 * interceptor unwraps it — the status and headers are applied, the body is
 * checked against the declaration (and adjusted, for a variant), and a
 * refusal is a `ResponseValidationError` (500).
 *
 * ```ts
 * const responses = {
 *   201: { content: { "application/json": User } },
 *   409: Problem,
 * } as const;
 *
 * @Validate({ responses, responseValidation: "error" })
 * @Post()
 * create() {
 *   return reply<typeof responses>(201, user);        // user: the 201 body
 *   return reply<typeof responses>(418, user);        // a type error
 * }
 * ```
 *
 * @param status  A declared status.
 * @param body    What that status declares (the schema's wire input, field by field).
 * @param options Headers to set, and the variant to answer as.
 */
export function reply<
  RS,
  const S extends AllowedStatus<InferResponses<RS>> = AllowedStatus<
    InferResponses<RS>
  >,
>(
  status: S,
  body: JsonBodyFor<Pick<InferResponses<RS>, S & keyof InferResponses<RS>>>,
  options?: ReplyOptions<RS, S & number>,
): ReplyValue<S & number> {
  return {
    [REPLY]: true,
    status: status as S & number,
    body,
    ...(options?.headers === undefined ? {} : { headers: options.headers }),
    ...(options?.variant === undefined ? {} : { variant: options.variant }),
  };
}

/* ------------------------------------------------------------------ *
 * ResponseValidationInterceptor
 * ------------------------------------------------------------------ */

/**
 * The global response-checking interceptor (plan
 * `docs/plans/bun-validate/` §4.5.4, V7b): checks every route that declares
 * `responses` (with `@Validate`), with its own policy — so one line turns
 * checks on in development, without editing the routes:
 *
 * ```ts
 * app.useGlobalInterceptors(new ResponseValidationInterceptor());
 * ```
 *
 * The routes' own `@Validate` still checks under its `responseValidation`
 * (the default `"off"`, which only adjusts a named variant): with both
 * registered, this interceptor's check (default `"error"`) runs after it, on
 * the route interceptor's output. A refused response throws a
 * `ResponseValidationError`, which `ValidationExceptionFilter` answers with
 * `{ error, issues }`.
 */
export class ResponseValidationInterceptor extends ValidateInterceptor {
  /** The policy every route is checked under. */
  readonly #mode: ResponseValidationMode;

  /**
   * @param mode        The policy: `"warn"` logs and sends, `"error"` (the
   *   default) refuses. Anything else throws a `TypeError`.
   * @param config      Injected by Nest; hand-built, the global pipes cannot
   *   be read for the skip rule.
   * @param adapterHost Injected by Nest; without it, a plain `@Res()` or
   *   `StreamableFile` response is checked only as far as `map()` reaches.
   */
  constructor(
    mode?: ResponseValidationMode,
    config?: ApplicationConfig,
    adapterHost?: HttpAdapterHost,
  ) {
    if (
      mode !== undefined &&
      mode !== "off" &&
      mode !== "warn" &&
      mode !== "error"
    ) {
      throw new TypeError(
        'ResponseValidationInterceptor: mode must be "off", "warn" or "error"',
      );
    }
    super(config, adapterHost);
    this.#mode = mode ?? "error";
  }

  /**
   * Checks the route's `responses`, under this interceptor's policy; routes
   * without any pass through unchecked.
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
    if (schemas?.responses === undefined) {
      return next.handle();
    }
    return this.handOff(context, next, handler, classRef, {
      ...schemas,
      responseValidation: this.#mode,
    });
  }
}

// `@Optional() @Inject(...)` on the constructor's second and third
// parameters, by call (the first is the mode, never injected).
Injectable()(ResponseValidationInterceptor);
Optional()(ResponseValidationInterceptor, undefined, 1);
Inject(ApplicationConfig)(ResponseValidationInterceptor, undefined, 1);
Optional()(ResponseValidationInterceptor, undefined, 2);
Inject(HttpAdapterHost)(ResponseValidationInterceptor, undefined, 2);

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
  schemas: ValidateSchemas,
): MethodDecorator & ClassDecorator {
  checkSchemas(schemas);
  // The route's contract, recorded so documents read every schema — the one
  // bun-common's `validate()` builds for the same parts and responses. The
  // two non-target keys go in its options, not its schemas.
  const { responses, responseValidation: _mode, ...parts } = schemas;
  const contract = getContract(
    validate(parts, {
      ...(responses === undefined ? {} : { responses }),
    }),
  );
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
