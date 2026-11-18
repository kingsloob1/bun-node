/**
 * The management API's problems (RFC 9457): an error a route throws, with
 * its status and code, answered as `application/problem+json`.
 */
import type { SecurityApiErrorCode } from "./contract/constants";
import type { ProblemDto } from "./contract/types";

/** Titles by status. */
const TITLES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  428: "Precondition Required",
  429: "Too Many Requests",
  500: "Internal Server Error",
};

/** An error a route throws to answer a problem. */
export class ApiProblem extends Error {
  /**
   * @param status The HTTP status.
   * @param code The problem's code.
   * @param detail What went wrong, for a person.
   * @param extra More members of the problem body (`issues`, `current`, `dangerous`, `stepUpUrl`).
   * @param headers Headers the answer carries (`retry-after` on a `429`).
   */
  constructor(
    readonly status: number,
    readonly code: SecurityApiErrorCode,
    detail: string,
    readonly extra: Readonly<
      Partial<Omit<ProblemDto, "type" | "title" | "status" | "code" | "detail">>
    > = {},
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(detail);
    this.name = "ApiProblem";
  }

  /** The problem body. */
  toBody(): ProblemDto {
    return {
      type: `urn:bun-security:problem:${this.code}`,
      title: TITLES[this.status] ?? "Error",
      status: this.status,
      code: this.code,
      detail: this.message,
      ...this.extra,
    };
  }
}

/** A `404` for `what`. */
export function notFound(what: string): ApiProblem {
  return new ApiProblem(404, "not_found", `${what} was not found`);
}

/** A `409` with the current state of what was raced. */
export function conflict(detail: string, current: unknown): ApiProblem {
  return new ApiProblem(409, "conflict", detail, { current });
}
