/**
 * The client's errors (typed-client plan §4.3, names §16). Every error the
 * client raises itself extends {@link ClientError}; a caller's own abort
 * surfaces as the platform's `AbortError` (the signal's reason), unchanged,
 * so `signal.reason` checks keep working.
 */
import type { ValidationIssue } from "@kingsleyweb/bun-contract";
import type { Jsonify } from "./jsonify";
import type { ErrorStatus, ResponsesOf } from "./types";

/** Options shared by every client error. */
interface ClientErrorOptions {
  /** The route key the call was for (`"GET /users/:id"`), when there is one. */
  key?: string;
  /** What caused it: a `fetch` rejection, a `SyntaxError` from a JSON body, … */
  cause?: unknown;
}

/** The base of every error the client raises. */
export class ClientError extends Error {
  /** The route key the call was for (`"GET /users/:id"`); `undefined` outside a call. */
  readonly key: string | undefined;

  constructor(message: string, options: ClientErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "ClientError";
    this.key = options.key;
  }
}

/** `HttpError`'s status for entry `E`: its declared non-2xx statuses, or any `number`. */
type HttpErrorStatus<E> = unknown extends E ? number : ErrorStatus<E>;

/** `HttpError`'s body for entry `E`: its declared error bodies after JSON, or `unknown`. */
type HttpErrorBody<E> = unknown extends E
  ? unknown
  : Jsonify<ResponsesOf<E>[ErrorStatus<E> & keyof ResponsesOf<E>]>;

/**
 * A declared error status, thrown instead of returned when `throwOnError` is
 * on (§4.4). Name the route's entry to type `status` and `error`:
 * `error as HttpError<Routes["GET /users/:id"]>`.
 *
 * @typeParam E The route's entry; `unknown` (the default) for any route.
 */
export class HttpError<E = unknown> extends ClientError {
  /** The response's status: one the route declares. */
  readonly status: HttpErrorStatus<E>;
  /** The parsed body (problem+json, by the plan's convention). */
  readonly error: HttpErrorBody<E>;
  /** The response, its body already read into {@link error}. */
  readonly response: Response;

  constructor(
    status: number,
    error: unknown,
    response: Response,
    key?: string,
  ) {
    super(`HTTP ${status} from ${key ?? response.url}`, { key });
    this.name = "HttpError";
    this.status = status as HttpErrorStatus<E>;
    this.error = error as HttpErrorBody<E>;
    this.response = response;
  }
}

/**
 * A status the route does not declare (§4.3): thrown by default, since a
 * result with a catch-all member would stop `status` narrowing anything.
 * `undeclaredStatus: "result"` returns it as a result instead.
 */
export class UnexpectedStatusError extends ClientError {
  /** The undeclared status. */
  readonly status: number;
  /** The statuses the route does declare, from the manifest. */
  readonly declared: readonly number[];
  /** The response, its body unread, so the caller may still read it. */
  readonly response: Response;

  constructor(response: Response, declared: readonly number[], key?: string) {
    super(
      `${key ?? response.url} answered ${response.status}, which it does not declare (declared: ${declared.join(", ")})`,
      { key },
    );
    this.name = "UnexpectedStatusError";
    this.status = response.status;
    this.declared = declared;
    this.response = response;
  }
}

/** `fetch` failed: no response at all (DNS, refused connection, CORS, offline). */
export class NetworkError extends ClientError {
  constructor(message: string, options: ClientErrorOptions = {}) {
    super(message, options);
    this.name = "NetworkError";
  }
}

/**
 * The call's `timeout` ran out (retries and their waits included). A
 * caller's own `signal` never produces this: it rejects with the signal's
 * reason, the platform's `AbortError` by default.
 */
export class TimeoutError extends ClientError {
  /** The timeout that ran out, in milliseconds. */
  readonly timeout: number;

  constructor(timeout: number, key?: string) {
    super(`${key ?? "Request"} timed out after ${timeout} ms`, { key });
    this.name = "TimeoutError";
    this.timeout = timeout;
  }
}

/**
 * One issue of a {@link ValidationError}: bun-contract's issue shape (the
 * one the server's checks report: `target`, `message`, `path`, and `key`,
 * the status, on a response), plus which check found it.
 */
export interface ValidationErrorIssue extends ValidationIssue<
  "params" | "query" | "body" | "headers" | "files" | "response"
> {
  /** `"builtin"`: the route's built-in schema; `"custom"`: a BYO schema (§5.4). */
  source: "builtin" | "custom";
}

/**
 * A request or a response failed validation (§5.4). Thrown before the
 * request is sent (a request part, by default) or, under `"throw"`, when a
 * response arrives; under `"warn"` it is only logged, and a hook receives it.
 * Every issue of the call is in it at once, the built-in ones first. No
 * issue carries a value: messages that quote what was checked are replaced
 * (bun-contract's rule, the server's too).
 */
export class ValidationError extends ClientError {
  /** `"request"`: a part about to be sent; `"response"`: a body that arrived. */
  readonly direction: "request" | "response";
  /** The response's status; `undefined` for a request. */
  readonly status: number | undefined;
  /** Every issue, the built-in schema's first, then the BYO schema's. */
  readonly issues: readonly ValidationErrorIssue[];

  constructor(
    key: string,
    direction: "request" | "response",
    issues: readonly ValidationErrorIssue[],
    status?: number,
  ) {
    const summary = issues
      .map(
        (issue) =>
          `${issue.target}${issue.path ? `.${issue.path}` : ""}: ${issue.message}`,
      )
      .join("; ");
    super(
      `${key} ${direction === "request" ? "request" : `response ${status}`} failed validation: ${summary}`,
      { key },
    );
    this.name = "ValidationError";
    this.direction = direction;
    this.status = status;
    this.issues = issues;
  }
}
