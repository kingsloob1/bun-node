import type { ProblemDto, ProblemIssueDto } from "./types";

/** Where an {@link ApiError} came from. */
export type ApiErrorKind =
  /** The API answered with an `application/problem+json` body. */
  | "problem"
  /** The API (or something in front of it) answered an error that was not problem+json. */
  | "http"
  /** No response arrived: offline, DNS, CORS, connection reset. */
  | "network"
  /** A 2xx whose body was not the JSON it should have been. */
  | "parse";

/** Fields an {@link ApiError} is built from. */
export interface ApiErrorInit {
  /** Where the error came from. */
  kind: ApiErrorKind;
  /** HTTP status, or `0` for a network error. */
  status: number;
  /** Machine code: the problem's `code`, or `NETWORK_ERROR` / `HTTP_<status>` / `INVALID_RESPONSE`. */
  code: string;
  /** Short title. */
  title: string;
  /** Human detail, when there is one. */
  detail?: string;
  /** The problem's `type` URI, when it was a problem. */
  type?: string;
  /** Validation issues, for `VALIDATION`. */
  issues?: ProblemIssueDto[];
  /** The problem's whitelisted context. */
  context?: Record<string, unknown>;
  /** The request path that failed. */
  instance?: string;
  /** The underlying error (network/parse failures). */
  cause?: unknown;
}

/**
 * Every failed API call, whatever went wrong. A problem+json response keeps
 * its fields verbatim; anything else is mapped onto the same shape so a
 * screen has one thing to render.
 */
export class ApiError extends Error {
  /** Where the error came from. */
  readonly kind: ApiErrorKind;
  /** HTTP status, or `0` for a network error. */
  readonly status: number;
  /** Machine code, e.g. `QUEUE_NOT_FOUND`. */
  readonly code: string;
  /** Short, stable title. */
  readonly title: string;
  /** Human detail for this occurrence. */
  readonly detail: string | undefined;
  /** The problem's `type` URI (`urn:bun-jobs:error:<CODE>`), when it was a problem. */
  readonly type: string | undefined;
  /** Validation issues, for `VALIDATION`. */
  readonly issues: ProblemIssueDto[];
  /** Whitelisted context, e.g. `{ queue: "emails" }`. */
  readonly context: Record<string, unknown>;
  /** The request path that failed. */
  readonly instance: string | undefined;

  constructor(init: ApiErrorInit) {
    super(init.detail ?? init.title, { cause: init.cause });
    this.name = "ApiError";
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.type = init.type;
    this.issues = init.issues ?? [];
    this.context = init.context ?? {};
    this.instance = init.instance;
  }

  /** Builds one from a problem body. */
  static fromProblem(problem: ProblemDto): ApiError {
    return new ApiError({
      kind: "problem",
      status: problem.status,
      code: problem.code,
      title: problem.title,
      detail: problem.detail,
      type: problem.type,
      issues: problem.issues,
      context: problem.context,
      instance: problem.instance,
    });
  }

  /** Whether the caller is not signed in or not allowed (401/403). */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Whether a value is an {@link ApiError}. */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Whether a parsed body has the fields a problem must carry. */
export function isProblem(value: unknown): value is ProblemDto {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.status === "number" &&
    typeof record.code === "string" &&
    typeof record.title === "string"
  );
}
