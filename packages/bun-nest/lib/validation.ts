/**
 * BunValidate for NestJS, the pipes and the filter (plan
 * `docs/plans/bun-validate/` §4.5.3 and §4.5.5, PR V6):
 *
 * - {@link StandardSchemaPipe}: one parameter, one Standard Schema, for
 *   controllers, gateways and anything Nest runs through its pipes (a job
 *   handler built with Nest's `ExternalContextCreator`).
 * - {@link SchemaDto}: a class whose instance type is a schema's output, so a
 *   parameter is typed from the schema with nothing restated.
 * - {@link StandardValidationPipe}: a global pipe that validates every
 *   parameter typed with a `SchemaDto` class and passes the rest through, as
 *   Nest's `ValidationPipe` does for class-validator DTOs.
 * - {@link ValidationExceptionFilter}: answers BunValidate's errors and the
 *   pipes' with `{ error, issues }` and the error's status. Opt-in.
 * - {@link StandardValidationModule}: registers the global pipe and filter.
 *
 * Every issue comes from bun-common's runner (`validateStandard`), so it has
 * the core's shape and keeps its rule: no received value in an issue, an
 * error or a log line. Everything here works on Nest 11 and 12 alike and
 * reads nothing version-specific; Nest 12's own `StandardSchemaValidationPipe`
 * and `@Body({ schema })` are not read or replaced (composition is V7a's).
 *
 * Decorators are applied by call, not with `@`: Bun reads the decorator
 * options from the working directory's tsconfig (oven-sh/bun#28605), and the
 * call behaves the same under either decorator semantics.
 */
import type {
  GuardOptions,
  StandardOutcome,
  StandardSchemaV1,
  ValidationIssue,
} from "@kingsleyweb/bun-common";
import type {
  ArgumentMetadata,
  ArgumentsHost,
  DynamicModule,
  ExceptionFilter,
  PipeTransform,
  Provider,
} from "@nestjs/common";
import { createRequire } from "node:module";
import {
  ResponseValidationError,
  validateStandard,
  ValidationError,
} from "@kingsleyweb/bun-common";
import {
  BadRequestException,
  Catch,
  Inject,
  Injectable,
  Logger,
  Module,
  Optional,
} from "@nestjs/common";
import { APP_FILTER, APP_PIPE, HttpAdapterHost } from "@nestjs/core";

/* ------------------------------------------------------------------ *
 * Options and the issue shape
 * ------------------------------------------------------------------ */

/**
 * The options of {@link StandardSchemaPipe}, {@link StandardValidationPipe}
 * and `StandardValidationModule.forRoot()`: how the pipes word their issues,
 * with `validate()`'s options of the same names and meaning (plan Q-C2,
 * Q-C3). Both are privacy options, so a value either does not take throws a
 * `TypeError` when the pipe (or the module) is built, rather than leaving
 * messages as they were.
 */
export interface StandardValidationPipeOptions {
  /**
   * `"generic"` replaces every issue's message with `Invalid value` (plus the
   * vendor's issue code when it has one), instead of the default scrub, which
   * withholds only a message found to quote a received value. Default unset:
   * the scrub. Anything else throws a `TypeError` when the pipe is built.
   */
  messages?: GuardOptions["messages"];
  /**
   * Empties every issue's `path` (`""`), for schemas keyed by data the client
   * chose (an e-mail-keyed record). The parameter's own key (`@Query('page')`)
   * is not prefixed either. Default `false`; a value that is not a boolean
   * throws a `TypeError` when the pipe is built.
   */
  redactPaths?: GuardOptions["redactPaths"];
}

/**
 * The part a pipe's issue names, from Nest's `ArgumentMetadata.type`:
 * `"body"` (also a gateway's `@MessageBody()`), `"query"`, `"params"`
 * (Nest's `"param"`, under bun-common's name for it), or `"custom"` (a
 * custom decorator, `@RawBody()`, Nest 12's `@Cookies()`, a direct call).
 */
type PipeTarget = "body" | "query" | "params" | "custom";

/** The issue wording the options ask for, `undefined` when neither is set. */
type IssueFormat = Pick<
  StandardValidationPipeOptions,
  "messages" | "redactPaths"
>;

/**
 * Checks `options` as `validate()` checks its own `messages` and
 * `redactPaths`: both are privacy options, so a typo throws rather than
 * leaving messages as they were.
 */
function issueFormat(
  owner: string,
  options: StandardValidationPipeOptions | undefined,
): IssueFormat | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== "object" || options === null) {
    throw new TypeError(`${owner}: options must be an object`);
  }
  const { messages, redactPaths } = options;
  if (messages !== undefined && messages !== "generic") {
    throw new TypeError(`${owner}: messages must be "generic" or unset`);
  }
  if (redactPaths !== undefined && typeof redactPaths !== "boolean") {
    throw new TypeError(`${owner}: redactPaths must be a boolean`);
  }
  if (messages === undefined && redactPaths === undefined) return undefined;
  return {
    ...(messages === undefined ? {} : { messages }),
    ...(redactPaths === undefined ? {} : { redactPaths }),
  };
}

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

/** The issue target for a parameter of Nest's `type`. */
function targetOf(metadata: ArgumentMetadata | undefined): PipeTarget {
  switch (metadata?.type) {
    case "body":
      return "body";
    case "query":
      return "query";
    case "param":
      return "params";
    default:
      return "custom";
  }
}

/** `issue` as one line of Nest's array message: `path: message`, or the message. */
function issueLine(issue: ValidationIssue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

/* ------------------------------------------------------------------ *
 * The pipes' error
 * ------------------------------------------------------------------ */

/**
 * What {@link StandardSchemaPipe} and {@link StandardValidationPipe} throw
 * when a value fails its schema: a `BadRequestException`, so an app without
 * {@link ValidationExceptionFilter} answers 400 as Nest's own validation
 * pipes do, with Nest's body (`{ statusCode: 400, message: ["path: message",
 * …], error: "Bad Request" }`, one line per issue), and carrying the core's
 * issues for the filter or a filter of the app's own
 * (`@Catch(StandardValidationException)`).
 *
 * Its `message` summarises the issues as `ValidationError`'s does; like the
 * issues, it holds no received value.
 */
export class StandardValidationException extends BadRequestException {
  /**
   * Every issue, in the core's shape `{ target, message, path }`: `target`
   * is the parameter's part (`"body"`, `"query"`, `"params"` or `"custom"`),
   * `path` is prefixed with the parameter's key (`@Query('page')`) unless
   * `redactPaths` is set. No received value in any.
   */
  readonly issues: readonly ValidationIssue<PipeTarget>[];

  /**
   * @param issues Every issue the schema reported, already worded (scrubbed,
   *   and with `messages`/`redactPaths` applied); each becomes one line of
   *   the 400 body's `message` array.
   */
  constructor(issues: readonly ValidationIssue<PipeTarget>[]) {
    super(issues.map(issueLine));
    this.issues = issues;
    this.message = `Validation failed — ${issues
      .map((i) => `${i.target}${i.path ? `.${i.path}` : ""}: ${i.message}`)
      .join("; ")}`;
  }
}

/**
 * Runs `schema` on one parameter's value: the schema's output, or a
 * {@link StandardValidationException}. Synchronous when the vendor is.
 */
function checkParameter<T>(
  schema: StandardSchemaV1,
  value: unknown,
  metadata: ArgumentMetadata | undefined,
  format: IssueFormat | undefined,
): T | Promise<T> {
  const target = targetOf(metadata);
  // The parameter's key (`@Query('page')`) is a name the code chose, never
  // the client's: it prefixes the path, so the issue reads as `validate()`'s
  // would for the same part.
  const key =
    typeof metadata?.data === "string" &&
    metadata.data !== "" &&
    format?.redactPaths !== true
      ? metadata.data
      : undefined;
  const settle = (outcome: StandardOutcome<unknown, PipeTarget>): T => {
    if (outcome.ok) return outcome.value as T;
    const issues =
      key === undefined
        ? outcome.issues
        : outcome.issues.map((issue) => ({
            ...issue,
            path: issue.path ? `${key}.${issue.path}` : key,
          }));
    throw new StandardValidationException(issues);
  };
  const outcome = validateStandard(
    schema,
    value,
    target,
    undefined,
    undefined,
    format,
  );
  return outcome instanceof Promise ? outcome.then(settle) : settle(outcome);
}

/* ------------------------------------------------------------------ *
 * StandardSchemaPipe
 * ------------------------------------------------------------------ */

/**
 * Validates one parameter with a Standard Schema (zod, valibot, arktype,
 * yup, or anything `toStandardSchema` wraps) and hands on the schema's
 * output, coerced and transformed.
 *
 * ```ts
 * @Get(":id")
 * find(@Param("id", new StandardSchemaPipe(z.coerce.number())) id: number) {}
 *
 * @SubscribeMessage("chat")
 * chat(@MessageBody(new StandardSchemaPipe(Chat)) msg: StandardSchemaV1.InferOutput<typeof Chat>) {}
 * ```
 *
 * A failure throws a `BadRequestException` (400 with Nest's body, or `{
 * error, issues }` under {@link ValidationExceptionFilter}). Its issues name
 * the part (`"body"`, `"query"`, `"params"`, `"custom"`) and prefix the
 * path with the parameter's key, and never quote the received value.
 * Synchronous when the vendor is; a Promise only when it answers with one
 * (yup).
 *
 * A pipe cannot type its parameter (Nest gives it no say), so the parameter
 * is annotated: `StandardSchemaV1.InferOutput<typeof S>`, or a
 * {@link SchemaDto} class. Nest never runs pipes on `@Headers()`, `@Req()` or
 * `@Res()`; a custom decorator's value is pipeable.
 */
export class StandardSchemaPipe<
  S extends StandardSchemaV1 = StandardSchemaV1,
> implements PipeTransform<
  unknown,
  StandardSchemaV1.InferOutput<S> | Promise<StandardSchemaV1.InferOutput<S>>
> {
  /** The schema every value is checked against. */
  readonly schema: S;
  /** The issue wording asked for, or `undefined` for the default scrub. */
  readonly #format: IssueFormat | undefined;

  /**
   * @param schema  Any Standard Schema; anything else throws a `TypeError`.
   * @param options How issues are worded: `messages` and `redactPaths`, as
   *   on `validate()`.
   */
  constructor(schema: S, options?: StandardValidationPipeOptions) {
    if (!isStandardSchema(schema)) {
      throw new TypeError(
        "StandardSchemaPipe: the schema must be a Standard Schema (an object with `~standard.validate`)",
      );
    }
    this.schema = schema;
    this.#format = issueFormat("StandardSchemaPipe", options);
  }

  /**
   * Checks `value`, resolving to the schema's output.
   *
   * @param value    The parameter's value, as Nest extracted it.
   * @param metadata Nest's description of the parameter; optional for a
   *   direct call (its issues then name the part `"custom"`).
   */
  transform(
    value: unknown,
    metadata?: ArgumentMetadata,
  ):
    StandardSchemaV1.InferOutput<S> | Promise<StandardSchemaV1.InferOutput<S>> {
    return checkParameter(this.schema, value, metadata, this.#format);
  }
}

/* ------------------------------------------------------------------ *
 * SchemaDto
 * ------------------------------------------------------------------ */

/**
 * Marks a {@link SchemaDto} class. Registered (`Symbol.for`), so a DTO built
 * by another copy of this package is still recognised.
 */
const SCHEMA_DTO: unique symbol = Symbol.for("bun-nest.schemaDto");

/** The class {@link SchemaDto} returns: instances typed as `S`'s output, `S` as `schema`. */
type SchemaDtoClass<S extends StandardSchemaV1> =
  (abstract new () => StandardSchemaV1.InferOutput<S>) & {
    /** The schema the DTO is validated with. */
    readonly schema: S;
  };

/**
 * A class built from a schema, to extend: its instance type is the schema's
 * output, and it carries the schema as `schema`.
 *
 * ```ts
 * class CreateUserDto extends SchemaDto(CreateUser) {}
 *
 * @Post()
 * create(@Body() body: CreateUserDto) {} // body.age: number, from the schema
 * ```
 *
 * With {@link StandardValidationPipe} global, every parameter typed with
 * such a class is validated, and the handler receives the schema's output
 * (a plain value, not an instance of the class). The pipe finds the class
 * through Nest's `design:paramtypes`, so the app compiles with
 * `emitDecoratorMetadata`.
 *
 * A schema whose output is a union cannot be a class's instance type
 * (TypeScript's TS2509 at `extends`): annotate such a parameter with
 * `StandardSchemaV1.InferOutput<typeof S>` and use {@link StandardSchemaPipe}.
 *
 * @param schema Any Standard Schema with an object output; anything that is
 *   not a Standard Schema throws a `TypeError`.
 */
export function SchemaDto<S extends StandardSchemaV1<unknown, object>>(
  schema: S,
): SchemaDtoClass<S> {
  if (!isStandardSchema(schema)) {
    throw new TypeError(
      "SchemaDto(): the schema must be a Standard Schema (an object with `~standard.validate`)",
    );
  }
  abstract class Dto {
    /** The schema the DTO is validated with. */
    static readonly schema: S = schema;
    /** Marks the class as a {@link SchemaDto}. */
    static readonly [SCHEMA_DTO] = true;
  }
  Object.defineProperty(Dto, "name", { value: "SchemaDto" });
  return Dto as unknown as SchemaDtoClass<S>;
}

/**
 * The schema of a {@link SchemaDto} class (or a subclass), or `undefined`
 * for any other type. A marked class whose `schema` is not a Standard Schema
 * (overridden by hand) throws a `TypeError`: it is a declaration error.
 */
function schemaOfDto(metatype: unknown): StandardSchemaV1 | undefined {
  if (typeof metatype !== "function") return undefined;
  const marked = metatype as { [SCHEMA_DTO]?: unknown; schema?: unknown };
  if (marked[SCHEMA_DTO] !== true) return undefined;
  if (!isStandardSchema(marked.schema)) {
    throw new TypeError(
      `${metatype.name || "A SchemaDto class"}: its static \`schema\` is not a Standard Schema`,
    );
  }
  return marked.schema;
}

/* ------------------------------------------------------------------ *
 * StandardValidationPipe
 * ------------------------------------------------------------------ */

/**
 * The global pipe for {@link SchemaDto}: validates every parameter whose
 * declared type is a `SchemaDto` class and hands on the schema's output;
 * passes every other parameter through untouched (a class-validator DTO
 * included, so Nest's `ValidationPipe` can be global beside it).
 *
 * ```ts
 * app.useGlobalPipes(new StandardValidationPipe());
 * // or: imports: [StandardValidationModule]
 * ```
 *
 * Like Nest's `ValidationPipe`, it skips a custom decorator's parameter
 * (`metadata.type === "custom"`); give that parameter a
 * {@link StandardSchemaPipe} of its own. Failures throw what
 * `StandardSchemaPipe` throws. Synchronous when the vendor is, and for
 * every parameter it passes through.
 */
export class StandardValidationPipe implements PipeTransform {
  /** The issue wording asked for, or `undefined` for the default scrub. */
  readonly #format: IssueFormat | undefined;

  /**
   * @param options How issues are worded: `messages` and `redactPaths`, as
   *   on `validate()`.
   */
  constructor(options?: StandardValidationPipeOptions) {
    this.#format = issueFormat("StandardValidationPipe", options);
  }

  /**
   * Checks `value` when its parameter is typed with a {@link SchemaDto}
   * class; returns it unchanged otherwise.
   *
   * @param value    The parameter's value, as Nest extracted it.
   * @param metadata Nest's description of the parameter, `metatype` included.
   */
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type === "custom") return value;
    const schema = schemaOfDto(metadata.metatype);
    if (schema === undefined) return value;
    return checkParameter(schema, value, metadata, this.#format);
  }
}

// Injectable, so `@UsePipes(StandardValidationPipe)` (a class, built by
// Nest's injector with no arguments) works as `new StandardValidationPipe()`.
Injectable()(StandardValidationPipe);

/* ------------------------------------------------------------------ *
 * ValidationExceptionFilter
 * ------------------------------------------------------------------ */

/** The slice of Nest's `HttpServer` the filter answers through. */
interface ReplyAdapter {
  /** Writes `body` with `statusCode`, as the platform does for a handler's return. */
  reply: (response: unknown, body: unknown, statusCode?: number) => unknown;
  /** Whether the response has started. */
  isHeadersSent?: (response: unknown) => boolean;
  /** Ends a started response. */
  end?: (response: unknown, message?: string) => unknown;
}

/** An `HttpAdapterHost`, read when an error is caught: its adapter is set after the filter is built. */
interface ReplyAdapterHost {
  /** The application's HTTP adapter, once Nest has set it. */
  readonly httpAdapter?: ReplyAdapter;
}

/** The Express-style response a filter built without an adapter answers through. */
interface ExpressLikeResponse {
  /** Whether the response has started. */
  headersSent?: boolean;
  /** Sets the status, chaining. */
  status?: (code: number) => ExpressLikeResponse;
  /** Sends a JSON body. */
  json?: (body: unknown) => unknown;
  /** Ends the response. */
  end?: () => unknown;
}

/** The slice of `@nestjs/websockets` the filter answers a gateway through. */
interface NestWebSockets {
  /** Nest's `WsException`: built with an object, emitted verbatim. */
  WsException: new (error: object) => Error;
  /** Nest's base filter, whose `handleError` emits the `exception` event. */
  BaseWsExceptionFilter: new () => {
    /** Emits `exception` to `client`, as Nest does for a thrown `WsException`. */
    handleError: (client: unknown, exception: Error) => void;
  };
}

/** `require` from this file, for the optional `@nestjs/websockets` (see {@link emitWsException}). */
const requireFromHere = createRequire(import.meta.url);

/** What the filter answers: its body, and the status. */
interface Answer {
  /** The status: the error's own. */
  status: number;
  /** `{ error, issues }`. */
  body: { error: string; issues: readonly ValidationIssue[] };
}

/** The answer for one of the errors the filter catches. */
function answerFor(exception: Error): Answer {
  if (exception instanceof ResponseValidationError) {
    return {
      status: exception.status,
      body: { error: "Response validation failed", issues: exception.issues },
    };
  }
  if (exception instanceof ValidationError) {
    return {
      status: exception.status,
      body: { error: "Validation failed", issues: exception.issues },
    };
  }
  const piped = exception as StandardValidationException;
  return {
    status: piped.getStatus(),
    body: { error: "Validation failed", issues: piped.issues },
  };
}

/**
 * Answers BunValidate's errors with `{ error, issues }` and the error's
 * status: a `ValidationError` (a `validate()` middleware's, 400 or its
 * `status`), a `ResponseValidationError` (500, logged once, its message
 * value-free) and the pipes' errors (400). Opt-in and `@Catch`-scoped:
 * every other error goes on to the app's other filters and Nest's own.
 *
 * ```ts
 * app.useGlobalFilters(new ValidationExceptionFilter(app.get(HttpAdapterHost)));
 * // or: @UseFilters(ValidationExceptionFilter), or StandardValidationModule
 * ```
 *
 * Over HTTP it answers through the application's adapter, so the body is
 * the same on any platform (compared with platform-express); built with no
 * adapter (`new ValidationExceptionFilter()`) it writes an Express-style
 * response (`status().json()`, which bun-nest's is too). In a gateway (with
 * `@UseFilters`, since Nest applies no global filter there) it emits an
 * `exception` event with `{ status, code: "VALIDATION", issues }` (the frame
 * shape plan §4.6.2 gives V9's gateway validation), exactly as Nest emits a
 * `WsException` built with that object. In any other
 * context (a job handler, a microservice) it rethrows, so the error fails
 * what it would have failed.
 */
export class ValidationExceptionFilter implements ExceptionFilter<Error> {
  /** The adapter, or the host whose adapter is read when an error is caught. */
  readonly #adapter: ReplyAdapter | ReplyAdapterHost | undefined;
  /** Where a 5xx answer is logged. */
  readonly #logger = new Logger("ValidationExceptionFilter");

  /**
   * @param adapter The application's `HttpAdapterHost` (Nest injects it when
   *   the filter is a class in `@UseFilters` or `APP_FILTER`) or its HTTP
   *   adapter. Optional: without one, an Express-style response is written.
   */
  constructor(adapter?: ReplyAdapter | ReplyAdapterHost) {
    this.#adapter = adapter;
  }

  /**
   * Answers `exception`.
   *
   * @param exception One of the errors this filter is `@Catch`-scoped to.
   * @param host      Nest's arguments host for the request, message or call.
   */
  catch(exception: Error, host: ArgumentsHost): void {
    const answer = answerFor(exception);
    const type = host.getType<string>();
    if (type === "http") {
      if (answer.status >= 500) {
        this.#logger.error(exception.message, exception.stack);
      }
      this.#reply(host.switchToHttp().getResponse<unknown>(), answer);
      return;
    }
    if (type === "ws") {
      emitWsException(host.switchToWs().getClient<unknown>(), {
        status: answer.status,
        code: "VALIDATION",
        issues: answer.body.issues,
      });
      return;
    }
    throw exception;
  }

  /** The adapter to answer through, if the filter has one. */
  #replyAdapter(): ReplyAdapter | undefined {
    const given = this.#adapter;
    if (given === undefined) return undefined;
    if (typeof (given as ReplyAdapter).reply === "function") {
      return given as ReplyAdapter;
    }
    return (given as ReplyAdapterHost).httpAdapter;
  }

  /** Writes `answer` on `response`, or ends it when it has started. */
  #reply(response: unknown, answer: Answer): void {
    const adapter = this.#replyAdapter();
    if (adapter !== undefined) {
      if (adapter.isHeadersSent?.(response) === true) {
        adapter.end?.(response);
        return;
      }
      adapter.reply(response, answer.body, answer.status);
      return;
    }
    const res = response as ExpressLikeResponse;
    if (res.headersSent === true) {
      res.end?.();
      return;
    }
    if (typeof res.status !== "function") {
      throw new TypeError(
        "ValidationExceptionFilter: built without an adapter, it needs an Express-style response (status().json()); pass app.get(HttpAdapterHost)",
      );
    }
    res.status(answer.status).json?.(answer.body);
  }
}

/**
 * Emits `payload` to a gateway client exactly as Nest emits a thrown
 * `new WsException(payload)`: through Nest's own `BaseWsExceptionFilter`, so
 * the frame is the platform's on either major (Nest 11's `client.emit`, Nest
 * 12's `emitMessage`, and bun-nest's adapter's packet either way).
 * `@nestjs/websockets` is an optional peer, required here only, where a
 * gateway is running and it is therefore installed.
 */
function emitWsException(client: unknown, payload: object): void {
  const { BaseWsExceptionFilter, WsException } = requireFromHere(
    "@nestjs/websockets",
  ) as NestWebSockets;
  new BaseWsExceptionFilter().handleError(client, new WsException(payload));
}

Catch(
  ValidationError,
  ResponseValidationError,
  StandardValidationException,
)(ValidationExceptionFilter);
// `@Optional() @Inject(HttpAdapterHost)` on the constructor's parameter, by
// call: Nest injects the host when it builds the filter from its class.
Optional()(ValidationExceptionFilter, undefined, 0);
Inject(HttpAdapterHost)(ValidationExceptionFilter, undefined, 0);

/* ------------------------------------------------------------------ *
 * StandardValidationModule
 * ------------------------------------------------------------------ */

/** The token of `StandardValidationModule.forRoot()`'s options (internal). */
const MODULE_OPTIONS = Symbol.for("bun-nest.standardValidationModuleOptions");

/**
 * Registers {@link StandardValidationPipe} as a global pipe (`APP_PIPE`) and
 * {@link ValidationExceptionFilter} as a global filter (`APP_FILTER`).
 *
 * ```ts
 * @Module({ imports: [StandardValidationModule] })                       // defaults
 * @Module({ imports: [StandardValidationModule.forRoot({ messages: "generic" })] })
 * ```
 *
 * Nest applies global pipes to controllers, and to gateways on Nest 12 only
 * (Nest 11's take `@UsePipes(StandardValidationPipe)`), and global filters to
 * HTTP only: a gateway takes the filter with `@UseFilters`.
 */
export class StandardValidationModule {
  /**
   * The module with the pipe's issue options.
   *
   * @param options How the pipe words its issues: `messages` and
   *   `redactPaths`, as on `validate()`. Checked here: a wrong value throws
   *   a `TypeError`.
   */
  static forRoot(options?: StandardValidationPipeOptions): DynamicModule {
    issueFormat("StandardValidationModule.forRoot()", options);
    return {
      module: StandardValidationModule,
      providers: [{ provide: MODULE_OPTIONS, useValue: options ?? {} }],
    };
  }
}

/** The global pipe and filter; the pipe reads `forRoot()`'s options when given. */
const MODULE_PROVIDERS: Provider[] = [
  {
    provide: APP_PIPE,
    useFactory: (options?: StandardValidationPipeOptions) =>
      new StandardValidationPipe(options),
    inject: [{ token: MODULE_OPTIONS, optional: true }],
  },
  {
    provide: APP_FILTER,
    useFactory: (host: HttpAdapterHost) => new ValidationExceptionFilter(host),
    inject: [HttpAdapterHost],
  },
];

Module({ providers: MODULE_PROVIDERS })(StandardValidationModule);
