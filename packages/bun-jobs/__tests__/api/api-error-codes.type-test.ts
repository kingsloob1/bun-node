import type * as Contract from "@kingsleyweb/bun-jobs/api/contract";
import type * as ServerErrors from "../../lib/api/errors";
import type { ProblemDto as ServerProblemDto } from "../../lib/api/serialize";
import { ApiError } from "../../lib/api/errors";
import { defineRoute } from "../../lib/api/routes/define";

/**
 * Compile-time assertions that a problem's `code` is a closed union.
 *
 * `ApiErrorCode` was `ApiOwnErrorCode | (string & {})` until the typed-client
 * pilot: any string passed, so a misspelt code compared or raised compiled.
 * Now an unknown code is refused wherever a code is written — an `ApiError`,
 * a route's `errors`, a `ProblemDto` — and the browser contract carries the
 * same union as the server. Checked by `bun check`, not `bun test`.
 *
 * Every `@ts-expect-error` here is a negative control: with the open union
 * back, each directive would be unused, and that is itself the error.
 */

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/* --- one union, server and browser ----------------------------------- */

export type SameUnion = Expect<
  Equal<ServerErrors.ApiErrorCode, Contract.ApiErrorCode>
>;
export type SameOwn = Expect<
  Equal<ServerErrors.ApiOwnErrorCode, Contract.ApiOwnErrorCode>
>;
export type SameProblem = Expect<
  Equal<ServerProblemDto["code"], Contract.ProblemDto["code"]>
>;

/** Closed: a string is not an `ApiErrorCode`. */
type StringIsCode = string extends Contract.ApiErrorCode ? true : false;
export type Closed = Expect<Equal<StringIsCode, false>>;

/* --- what it holds ----------------------------------------------------- */

export const own: Contract.ApiErrorCode = "QUEUE_NOT_FOUND";
export const internal: Contract.ApiErrorCode = "JOB_TIMEOUT";
export const foreign: Contract.ApiErrorCode = "RATE_LIMITED";
export const foreignStatus: Contract.ApiErrorCode = "HTTP_418";

// @ts-expect-error an unknown code is refused.
export const unknownCode: Contract.ApiErrorCode = "QUEUE_MISSING";

// @ts-expect-error `HTTP_` takes a number.
export const badStatus: Contract.ApiErrorCode = "HTTP_teapot";

/* --- where codes are written ------------------------------------------- */

export const raised = new ApiError("JOB_NOT_FOUND", 404, "gone");
export const raisedCode: Contract.ApiErrorCode = raised.code;

// @ts-expect-error an ApiError takes only a known code.
export const misspelt = new ApiError("JOB_NOT_FUOND", 404, "gone");

export const problem: Contract.ProblemDto = {
  type: "urn:bun-jobs:error:JOB_NOT_FOUND",
  title: "Job not found",
  status: 404,
  code: "JOB_NOT_FOUND",
};

export const unknownProblem: Contract.ProblemDto = {
  type: "urn:bun-jobs:error:NOPE",
  title: "Nope",
  status: 404,
  // @ts-expect-error a problem's code is an ApiErrorCode.
  code: "NOPE",
};

/** A comparison against a code that does not exist no longer compiles. */
export function isMissing(problem: Contract.ProblemDto): boolean {
  // @ts-expect-error no overlap: "QUEUE_MISSING" is no ApiErrorCode.
  return problem.code === "QUEUE_MISSING";
}

/** The remote protocol names its own codes; `ProblemDto<string>` stays open. */
export const remote: Contract.ProblemDto<string> = {
  type: "urn:bun-jobs:error:SIGNATURE_INVALID",
  title: "Signature invalid",
  status: 401,
  code: "SIGNATURE_INVALID",
};

/* --- a route's `errors` --------------------------------------------- */

const route = {
  operationId: "typeTestRoute",
  method: "GET",
  path: "/type-test",
  summary: "A route for the type test",
  tags: ["meta"],
  action: "meta.read",
  mode: "any",
  responses: { 200: null },
  handler: () => ({ body: undefined }),
} as const;

export const documented = defineRoute({
  ...route,
  errors: ["QUEUE_NOT_FOUND"],
});

export const internalDocumented = defineRoute({
  ...route,
  // @ts-expect-error a route documents only codes with a status of their own.
  errors: ["JOB_TIMEOUT"],
});
