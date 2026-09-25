import type {
  BunRequest,
  BunResponse,
  Logger,
  RouterErrorMiddlewareHandler,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import type { JobsApiAction } from "./config";
import type { ProblemDto, ProblemIssueDto } from "./serialize";
import { PayloadTooLargeError, ValidationError } from "@kingsleyweb/bun-common";
import {
  ChildExitError,
  ChildFailedError,
  ConfigError,
  DriverError,
  InvalidHandlerError,
  JobsError,
  JobTimeoutError,
  LockLostError,
  LockUnavailableError,
  NotSupportedError,
  ProtocolError,
  QueueClosedError,
  QueueFullError,
  RunKilledError,
  RunnerNotFoundError,
  RunnerStoppedError,
  SerializationError,
  UnrecoverableJobError,
  WorkerClosedError,
} from "../shared/errors";

/**
 * The API's error model: one body shape (RFC 9457 problem details), one table
 * from failures to statuses, and the handlers that apply them.
 *
 * Two rules run through all of it. A 5xx never carries the error's message —
 * a driver error's message names the backend and the operation, and an
 * internal one can say anything — so its `detail` is always the generic title.
 * And nothing is matched on message text: a class, a `code`, or the call site
 * decides, because a message is prose and prose gets edited.
 */

/**
 * The status each of the API's own codes is answered with. The OpenAPI
 * generator reads it to document a route's `errors` under the right status.
 */
export const API_ERROR_STATUS = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  QUEUE_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  RUNNER_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  REPEATABLE_NOT_FOUND: 404,
  WORKER_NOT_FOUND: 404,
  WORKER_GONE: 410,
  ROUTE_NOT_FOUND: 404,
  INVALID_NAME: 400,
  INVALID_JSON: 400,
  INVALID_SCHEDULE: 400,
  JOB_STATE_CONFLICT: 409,
  JOB_ACTIVE: 409,
  RUNNER_NOT_LOCAL: 409,
  WORKER_STATE_CONFLICT: 409,
  WORKER_NOT_CONTROLLABLE: 409,
  WORKER_PERSISTENCE_NOT_ALLOWED: 409,
  CONTROL_CONTENDED: 409,
  CONFIG_NOT_ALLOWED: 409,
  RUNNER_NOT_CONFIGURABLE: 409,
  LOGS_NOT_RETAINED: 409,
  OPERATION_IN_PROGRESS: 409,
  DEFAULTS_CHANGED: 409,
  BULK_LIMIT: 400,
  RANGE_NOT_RETAINED: 400,
  ARGS_NOT_ALLOWED: 400,
  NAME_NOT_ADDABLE: 403,
  CSRF_REJECTED: 403,
  ORIGIN_REJECTED: 403,
  CONNECTION_LIMIT: 429,
  UNSUPPORTED_SUBPROTOCOL: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  LIMITS_CONTENDED: 409,
  INVALID_ARGUMENT: 400,
  NOT_SUPPORTED: 501,
  VALIDATION: 400,
  SERIALIZATION: 400,
  QUEUE_CLOSED: 503,
  WORKER_CLOSED: 503,
  QUEUE_FULL: 503,
  DRIVER_ERROR: 503,
  RUNNER_STOPPED: 409,
  LOCK_UNAVAILABLE: 409,
  LOCK_LOST: 409,
  INTERNAL: 500,
} as const;

/** Codes the API itself raises, or maps a bun-jobs error to. */
export type ApiOwnErrorCode = keyof typeof API_ERROR_STATUS;

/** Every code a problem may carry: the API's own, or a bun-jobs `JobsError.code`. */
export type ApiErrorCode = ApiOwnErrorCode | (string & {});

/** Titles by code: short, stable, and safe to show for any occurrence. */
const TITLES: Record<string, string> = {
  UNAUTHORIZED: "Authentication required",
  FORBIDDEN: "Forbidden",
  QUEUE_NOT_FOUND: "Queue not found",
  JOB_NOT_FOUND: "Job not found",
  RUNNER_NOT_FOUND: "Runner not found",
  RUN_NOT_FOUND: "Run not found",
  REPEATABLE_NOT_FOUND: "Repeatable job not found",
  WORKER_NOT_FOUND: "Worker not found",
  WORKER_GONE: "Worker is no longer running",
  ROUTE_NOT_FOUND: "Route not found",
  INVALID_NAME: "Invalid name",
  INVALID_JSON: "Malformed JSON body",
  INVALID_SCHEDULE: "Invalid schedule",
  JOB_STATE_CONFLICT: "Job is not in a state that allows this",
  JOB_ACTIVE: "Job is active",
  RUNNER_NOT_LOCAL: "Runner is not registered in this process",
  WORKER_STATE_CONFLICT: "Worker is not in a state that allows this",
  WORKER_NOT_CONTROLLABLE: "Worker cannot be controlled remotely",
  WORKER_PERSISTENCE_NOT_ALLOWED:
    "Worker does not allow the stop persistence to be overridden",
  CONTROL_CONTENDED: "Control state changed concurrently",
  CONFIG_NOT_ALLOWED: "Configuration is not allowed for this runner",
  RUNNER_NOT_CONFIGURABLE: "Runner cannot be configured remotely",
  LOGS_NOT_RETAINED: "Run logs are not retained",
  OPERATION_IN_PROGRESS: "Operation already in progress",
  DEFAULTS_CHANGED: "Job defaults changed since they were confirmed",
  BULK_LIMIT: "Too many ids",
  RANGE_NOT_RETAINED: "Range is older than the backend keeps",
  ARGS_NOT_ALLOWED: "Arguments are not allowed",
  NAME_NOT_ADDABLE: "Job name may not be added",
  CSRF_REJECTED: "Cross-site request rejected",
  ORIGIN_REJECTED: "Origin not allowed",
  CONNECTION_LIMIT: "Too many live-event connections",
  UNSUPPORTED_SUBPROTOCOL: "Unsupported WebSocket subprotocol",
  UNSUPPORTED_MEDIA_TYPE: "Unsupported media type",
  PAYLOAD_TOO_LARGE: "Payload too large",
  LIMITS_CONTENDED: "Limits changed concurrently",
  INVALID_ARGUMENT: "Invalid argument",
  NOT_SUPPORTED: "Not supported by this backend",
  VALIDATION: "Request validation failed",
  INTERNAL: "Internal server error",
  SERIALIZATION: "Value is not JSON-serialisable",
  QUEUE_CLOSED: "Queue is closed",
  WORKER_CLOSED: "Worker is closed",
  RUNNER_STOPPED: "Runner is stopped",
  LOCK_UNAVAILABLE: "Lock is held elsewhere",
  LOCK_LOST: "Lock was lost",
  QUEUE_FULL: "Capacity exhausted",
  DRIVER_ERROR: "Backend unavailable",
  RATE_LIMITED: "Too many requests",
};

/** Titles by status, for codes with none of their own. */
const STATUS_TITLES: Record<number, string> = {
  400: "Bad request",
  401: "Authentication required",
  403: "Forbidden",
  404: "Not found",
  405: "Method not allowed",
  409: "Conflict",
  410: "Gone",
  413: "Payload too large",
  415: "Unsupported media type",
  422: "Unprocessable content",
  429: "Too many requests",
  500: "Internal server error",
  501: "Not implemented",
  502: "Bad gateway",
  503: "Service unavailable",
  504: "Gateway timeout",
};

/** The title for a code, falling back to the status's. */
export function problemTitle(code: string, status: number): string {
  // A 5xx with a bun-jobs code of its own (JOB_TIMEOUT, CHILD_EXIT...) is not
  // something a management call produces on purpose; a specific title would
  // hint at internals the generic one does not.
  return (
    TITLES[code] ??
    STATUS_TITLES[status] ??
    (status >= 500 ? "Internal server error" : "Request failed")
  );
}

/** The problem `type` URI for a code. */
export function problemType(code: string): string {
  return `urn:bun-jobs:error:${code}`;
}

/** Options for an {@link ApiError}. */
export interface ApiErrorOptions {
  /** Safe, client-visible context. Never put secrets or causes here. */
  context?: Record<string, unknown>;
  /** Extra response headers, e.g. `Retry-After`. */
  headers?: Record<string, string>;
  /** Validation issues, for `VALIDATION`. */
  issues?: ProblemIssueDto[];
  /** The underlying error, for logs. Never sent. */
  cause?: unknown;
}

/**
 * A failure the API answers with a specific problem. Thrown inside handlers.
 *
 * Carries `status` as well as `code`, so that if one escapes the API router —
 * thrown from a user's `middleware`, say — the host adapter's final handler
 * still answers with the right status.
 */
export class ApiError extends JobsError {
  /** The HTTP status to answer with. */
  readonly status: number;
  /** Extra response headers. */
  readonly headers?: Record<string, string>;
  /** Validation issues, for `VALIDATION`. */
  readonly issues?: ProblemIssueDto[];

  constructor(
    code: ApiErrorCode,
    status: number,
    detail: string,
    options?: ApiErrorOptions,
  ) {
    super(detail, code, options?.context, { cause: options?.cause });
    this.status = status;
    this.headers = options?.headers;
    this.issues = options?.issues;
  }
}

/**
 * The status a foreign error asks for: its `status` or `statusCode` when that
 * is a 4xx/5xx number, else `500`.
 *
 * TODO: import `errorStatusCode` from `@kingsleyweb/bun-common` once it is
 * exported there (it is landing with the adapters' final error handler); this
 * is the same rule, kept local until then.
 */
export function errorStatusCode(error: unknown): number {
  if (typeof error === "object" && error !== null) {
    for (const key of ["status", "statusCode"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 400 &&
        value < 600
      ) {
        return value;
      }
    }
  }
  return 500;
}

/**
 * Whether an error means "this backend cannot do that": the
 * {@link NotSupportedError} a capability check throws for a missing driver
 * method.
 */
export function isNotSupportedError(
  error: unknown,
): error is NotSupportedError {
  return error instanceof NotSupportedError;
}

/** Whether a value is bun-common's `ValidationError`, even across module copies. */
function isValidationError(error: unknown): error is ValidationError {
  return (
    error instanceof ValidationError ||
    (error instanceof Error &&
      error.name === "ValidationError" &&
      Array.isArray((error as { issues?: unknown }).issues))
  );
}

/**
 * Call sites whose errors mean something narrower than their class says.
 *
 * - `"setLimits"`: a `ConfigError` from `queue.setLimits()` means the stored
 *   limits kept changing underneath (409). Only valid when the input was
 *   already checked with `normalizeLimits`, which throws `ConfigError` too for
 *   bad input — wrap the `setLimits` call alone.
 * - `"jobInput"`: a `SerializationError` or `ConfigError` from `add()`/`update()`
 *   describes the caller's payload (400, with its message), not a server fault.
 * - `"limitsInput"`: a `ConfigError` from `normalizeLimits()` describes the
 *   caller's limits (400, with its message).
 * - `"jobDefaults"`: a `ConfigError` from `queue.setJobDefaults()` or
 *   `queue.applyJobDefaults()` describes the caller's request — a value out of
 *   bounds, an unknown or un-overridden key, an override with nothing to
 *   apply, a malformed cursor or states list (400, with its message). Their
 *   messages are written from the request and the stored override alone.
 *
 * These are the only places a `ConfigError`'s message reaches a client: its
 * text is known to describe input there. Anywhere else it may name internals
 * — a connection string, a driver's configuration — so it is answered with
 * the generic title.
 */
export type ProblemCallSite =
  | "setLimits"
  | "jobInput"
  | "limitsInput"
  | "jobDefaults";

/**
 * Narrows an error by where it was thrown. Returns an {@link ApiError} when the
 * call site changes its meaning, else the error unchanged.
 */
export function mapCallSiteError(
  error: unknown,
  site: ProblemCallSite,
): unknown {
  if (
    site === "setLimits" &&
    error instanceof ConfigError &&
    !isNotSupportedError(error)
  ) {
    return new ApiError(
      "LIMITS_CONTENDED",
      409,
      "The queue's limits kept changing; retry",
      { cause: error },
    );
  }
  if (site === "jobInput" && error instanceof SerializationError) {
    return new ApiError("SERIALIZATION", 400, error.message, { cause: error });
  }
  if (
    (site === "jobInput" || site === "limitsInput" || site === "jobDefaults") &&
    error instanceof ConfigError &&
    !isNotSupportedError(error)
  ) {
    return new ApiError("INVALID_ARGUMENT", 400, error.message, {
      cause: error,
    });
  }
  return error;
}

/** How an error is answered. */
export interface ProblemResult {
  /** The HTTP status. */
  status: number;
  /** The body. */
  problem: ProblemDto;
  /** Extra response headers. */
  headers: Record<string, string>;
}

/** An error, classified. */
interface Classified {
  /** The HTTP status. */
  status: number;
  /** The code. */
  code: string;
  /** A client-visible detail, used only below 500. */
  detail?: string;
  /** Safe context. */
  context?: Record<string, unknown>;
  /** Extra headers. */
  headers?: Record<string, string>;
  /** Validation issues. */
  issues?: ProblemIssueDto[];
}

/** Foreign 4xx statuses with a conventional code. */
const FOREIGN_CODES: Record<number, string> = {
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  413: "PAYLOAD_TOO_LARGE",
  429: "RATE_LIMITED",
};

/** Applies the mapping table. */
function classify(error: unknown): Classified {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      detail: error.message,
      context: error.context,
      headers: error.headers,
      issues: error.issues,
    };
  }
  if (isValidationError(error)) {
    return {
      status: errorStatusCode(error) < 500 ? errorStatusCode(error) : 400,
      code: "VALIDATION",
      detail: "The request did not match the schema",
      issues: error.issues.map((issue) => ({
        target: issue.target,
        path: issue.path,
        message: issue.message,
      })),
    };
  }
  if (error instanceof PayloadTooLargeError) {
    return {
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      detail: `The request body exceeds ${error.limit} bytes`,
      context: { limit: error.limit },
    };
  }
  if (isNotSupportedError(error)) {
    return {
      status: 501,
      code: "NOT_SUPPORTED",
      context: { method: error.context.method },
    };
  }
  if (error instanceof ConfigError) {
    // Usually bad input, but its message is prose from anywhere in the
    // package and can name internals. Only a known input-validating call
    // site shows it (`mapCallSiteError`); here the title stands in.
    return { status: 400, code: "INVALID_ARGUMENT" };
  }
  if (error instanceof RunnerNotFoundError) {
    // Raised by a runner controller when the runner vanished (was purged)
    // between the lookup and the call. The id is the caller's own input; the
    // namespace in the message is not repeated back.
    return {
      status: 404,
      code: "RUNNER_NOT_FOUND",
      detail: `Runner "${error.context.id}" was not found`,
      context: { runner: error.context.id },
    };
  }
  if (error instanceof SerializationError) {
    return { status: 500, code: "SERIALIZATION" };
  }
  if (error instanceof JobsError && error.code === "WORKER_STATE_CONFLICT") {
    // `WorkerStateConflictError` from `WorkerController.pause()`/`resume()`, when
    // a worker changed state between a lifecycle route's own check and the
    // call — answered as that check answers: 409, naming the first worker.
    const workers = (
      error.context as { workers?: { id: string; state: string }[] }
    ).workers;
    const first = workers?.[0];
    return {
      status: 409,
      code: "WORKER_STATE_CONFLICT",
      detail: error.message,
      ...(first ? { context: { worker: first.id, state: first.state } } : {}),
    };
  }
  if (error instanceof JobsError && error.code === "DEFAULTS_CHANGED") {
    // `JobDefaultsChangedError`, matched by its code so this module need not
    // load the queue. Its message names only the queue and the two versions,
    // all of them the caller's own request or what it may read.
    return {
      status: 409,
      code: "DEFAULTS_CHANGED",
      detail: error.message,
      context: error.context,
    };
  }
  if (error instanceof QueueClosedError) {
    return {
      status: 503,
      code: "QUEUE_CLOSED",
      headers: { "Retry-After": "1" },
    };
  }
  if (error instanceof WorkerClosedError) {
    return { status: 503, code: "WORKER_CLOSED" };
  }
  if (error instanceof QueueFullError) {
    return { status: 503, code: "QUEUE_FULL", headers: { "Retry-After": "1" } };
  }
  if (error instanceof DriverError) {
    return { status: 503, code: "DRIVER_ERROR" };
  }
  if (
    error instanceof RunnerStoppedError ||
    error instanceof LockUnavailableError ||
    error instanceof LockLostError
  ) {
    // Their messages carry internal key text (`r:<id>`, lock names); the
    // title says what happened without it.
    return { status: 409, code: error.code };
  }
  if (
    error instanceof ProtocolError ||
    error instanceof JobTimeoutError ||
    error instanceof UnrecoverableJobError ||
    error instanceof ChildExitError ||
    error instanceof ChildFailedError ||
    error instanceof RunKilledError ||
    error instanceof InvalidHandlerError ||
    error instanceof JobsError
  ) {
    return { status: 500, code: error.code };
  }

  const status = errorStatusCode(error);
  if (status === 500) {
    return { status, code: "INTERNAL" };
  }
  // A foreign error that named its own status — an auth middleware throwing
  // `{ status: 401 }`. Below 500 its message is shown, as http-errors does,
  // unless it says it should not be (`expose: false`).
  const exposed =
    status < 500 &&
    error instanceof Error &&
    error.message !== "" &&
    (error as { expose?: unknown }).expose !== false;
  return {
    status,
    code: FOREIGN_CODES[status] ?? `HTTP_${status}`,
    detail: exposed ? (error as Error).message : undefined,
  };
}

/** Options for {@link toProblem}. */
export interface ToProblemOptions {
  /** The request path, reported as `instance`. */
  instance?: string;
}

/**
 * Maps any thrown value to a problem. A 5xx always carries its generic title as
 * `detail`, never the error's message.
 */
export function toProblem(
  error: unknown,
  options?: ToProblemOptions,
): ProblemResult {
  const classified = classify(error);
  const title = problemTitle(classified.code, classified.status);
  const problem: ProblemDto = {
    type: problemType(classified.code),
    title,
    status: classified.status,
    code: classified.code,
    detail: classified.status >= 500 ? title : (classified.detail ?? title),
  };
  if (options?.instance !== undefined) {
    problem.instance = options.instance;
  }
  if (classified.issues && classified.issues.length > 0) {
    problem.issues = classified.issues;
  }
  if (classified.context && Object.keys(classified.context).length > 0) {
    problem.context = classified.context;
  }
  return {
    status: classified.status,
    problem,
    headers: { ...classified.headers },
  };
}

/**
 * Writes a problem to the response as `application/problem+json`. Returns
 * `false` (writing nothing) when the response has already started.
 */
export function sendProblem(res: BunResponse, result: ProblemResult): boolean {
  if (res.headersSent) {
    return false;
  }
  res.status(result.status);
  for (const [name, value] of Object.entries(result.headers)) {
    res.setHeader(name, value);
  }
  res.setHeader("Content-Type", "application/problem+json");
  res.setHeader("Cache-Control", "no-store");
  res.send(JSON.stringify(result.problem));
  return true;
}

/** The action each request is attempting, recorded by the authorize step, for logs. */
const REQUEST_ACTIONS = new WeakMap<BunRequest, JobsApiAction>();

/** Records the action a request is attempting. */
export function tagRequestAction(req: BunRequest, action: JobsApiAction): void {
  REQUEST_ACTIONS.set(req, action);
}

/** The action a request was attempting, when one was recorded. */
export function requestActionOf(req: BunRequest): JobsApiAction | undefined {
  return REQUEST_ACTIONS.get(req);
}

/** Options for {@link createApiErrorHandler}. */
export interface ApiErrorHandlerOptions {
  /** Where failures are logged: `error` level for 5xx, `debug` for 4xx. */
  logger: Logger;
}

/**
 * The API router's final error handler. Every error inside the API ends here
 * and is answered as a problem, so none falls through to the host's HTML error
 * page.
 */
export function createApiErrorHandler(
  options: ApiErrorHandlerOptions,
): RouterErrorMiddlewareHandler {
  const { logger } = options;
  return ((error, req, res, _next) => {
    const result = toProblem(error, { instance: req.path });
    const fields = {
      error,
      code: result.problem.code,
      status: result.status,
      action: requestActionOf(req),
      method: req.method,
      path: req.path,
    };
    if (result.status >= 500) {
      logger.error("jobs api request failed", fields);
    } else {
      logger.debug("jobs api request failed", fields);
    }
    sendProblem(res, result);
  }) satisfies RouterErrorMiddlewareHandler;
}

/**
 * The API router's catch-all: registered last, it answers any request under
 * `basePath` that no route claimed with a JSON `ROUTE_NOT_FOUND`.
 */
export function createNotFoundHandler(): RouterHandler {
  return (req, res) => {
    sendProblem(
      res,
      toProblem(
        new ApiError(
          "ROUTE_NOT_FOUND",
          404,
          `No route for ${req.method} ${req.path}`,
        ),
        { instance: req.path },
      ),
    );
  };
}
