/**
 * The client's errors (typed-client plan §4.3, names §16). Every error the
 * client raises itself extends {@link ClientError}; a caller's own abort
 * surfaces as the platform's `AbortError` (the signal's reason), unchanged,
 * so `signal.reason` checks keep working.
 */
import type {
  ChannelErrorCode,
  ValidationIssue,
} from "@kingsleyweb/bun-contract";
import type { Jsonify } from "./jsonify";
import type { ErrorStatus, ResponsesOf } from "./types";

/**
 * What a {@link ChannelError} says failed: the contract's codes, and
 * `"EXCEPTION"`, which only the `"bun-nest"` codec raises: a gateway handler
 * that threw (a `WsException` or any error) for an event that asked for an
 * ack, which will not come.
 */
export type ChannelFailureCode = ChannelErrorCode | "EXCEPTION";

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
 * the status, on a response; on an event stream's event, target `data` and
 * `key` the event's name, `sse.md` §3.3; on a channel message, target `data`
 * and `key` the message type, `websocket.md` §5), plus which check found it.
 */
export interface ValidationErrorIssue extends ValidationIssue<
  "params" | "query" | "body" | "headers" | "files" | "response" | "data"
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
  /**
   * `"request"`: a part about to be sent; `"response"`: a body that arrived;
   * on a channel (`./channel`), `"send"`: a message about to be written,
   * `"receive"`: a frame that arrived.
   */
  readonly direction: "request" | "response" | "send" | "receive";
  /** The response's status; `undefined` for a request. */
  readonly status: number | undefined;
  /** Every issue, the built-in schema's first, then the BYO schema's. */
  readonly issues: readonly ValidationErrorIssue[];

  constructor(
    key: string,
    direction: "request" | "response" | "send" | "receive",
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
      `${key} ${direction === "response" ? `response ${status}` : direction} failed validation: ${summary}`,
      { key },
    );
    this.name = "ValidationError";
    this.direction = direction;
    this.status = status;
    this.issues = issues;
  }
}

/* ------------------------------------------------------------------------ */
/* The channel client's errors (`./channel`, `websocket.md` §6).            */
/* ------------------------------------------------------------------------ */

/**
 * The server answered with an error frame (`websocket.md` §6): an invalid
 * message (`VALIDATION`, with the server's value-free issues), an unknown
 * message type (`UNKNOWN_MESSAGE`) or an undeclared binary frame
 * (`UNSUPPORTED_DATA`). A request whose id the frame echoes rejects with it;
 * any other reaches the channel's `on("$error")`.
 */
export class ChannelError extends ClientError {
  /** What failed, as the server's error frame says. */
  readonly code: ChannelFailureCode;
  /** The frame's status (400 from bun-common). */
  readonly status: number;
  /** The server's issues, value-free, for a `VALIDATION`; empty otherwise. */
  readonly issues: readonly ValidationIssue[];
  /** What went wrong, for a non-validation error; `undefined` when the frame has none. */
  readonly detail: string | undefined;
  /** The message type of the request it answers; `undefined` for an error frame no request is waiting for. */
  readonly type: string | undefined;

  /**
   * @param key   The channel's path.
   * @param frame The error frame's fields.
   * @param type  The request's message type, when one is waiting.
   */
  constructor(
    key: string,
    frame: {
      readonly code: ChannelFailureCode;
      readonly status: number;
      readonly issues?: readonly ValidationIssue[];
      readonly detail?: string;
    },
    type?: string,
  ) {
    super(
      `${key}${type === undefined ? "" : ` ${type}`}: the server answered ${frame.code}${frame.detail === undefined ? "" : ` (${frame.detail})`}`,
      { key },
    );
    this.name = "ChannelError";
    this.code = frame.code;
    this.status = frame.status;
    this.issues = frame.issues ?? [];
    this.detail = frame.detail;
    this.type = type;
  }
}

/** A channel request (`request()`) had no reply within its `timeout`. */
export class RequestTimeoutError extends ClientError {
  /** The request's message type. */
  readonly type: string;
  /** The id the request carried. */
  readonly id: string;
  /** The timeout that ran out, in milliseconds. */
  readonly timeout: number;

  /**
   * @param key     The channel's path.
   * @param type    The request's message type.
   * @param id      Its correlation id.
   * @param timeout The timeout, ms.
   */
  constructor(key: string, type: string, id: string, timeout: number) {
    super(`${key} ${type}: no reply within ${timeout} ms`, { key });
    this.name = "RequestTimeoutError";
    this.type = type;
    this.id = id;
    this.timeout = timeout;
  }
}

/**
 * The socket dropped while a channel request was waiting for its reply: it
 * is rejected rather than sent again, since a request may not be
 * idempotent (`retry: true` on the call sends it again after a reconnect).
 */
export class DisconnectedError extends ClientError {
  /** The close code. */
  readonly code: number;
  /** The close reason (often `""`). */
  readonly reason: string;

  /**
   * @param key    The channel's path.
   * @param code   The close code.
   * @param reason The close reason.
   */
  constructor(key: string, code: number, reason: string) {
    super(
      `${key}: the socket closed (${code}${reason ? ` ${reason}` : ""}) before the reply`,
      { key },
    );
    this.name = "DisconnectedError";
    this.code = code;
    this.reason = reason;
  }
}

/**
 * The channel is closed for good, or cannot take the message: a send or a
 * request after `close()` or after a close the client will not retry (a
 * fatal close code, or reconnection off), a send while disconnected with
 * `offline: "fail"`, or past the offline buffer's limit.
 */
export class ChannelClosedError extends ClientError {
  /** The close code; `undefined` when no socket closed (`close()`, a full offline buffer). */
  readonly code: number | undefined;
  /** The close reason, or why the message was refused. */
  readonly reason: string;

  /**
   * @param key    The channel's path.
   * @param reason Why.
   * @param code   The close code, when a socket closed.
   */
  constructor(key: string, reason: string, code?: number) {
    super(`${key}: ${reason}${code === undefined ? "" : ` (${code})`}`, {
      key,
    });
    this.name = "ChannelClosedError";
    this.code = code;
    this.reason = reason;
  }
}
