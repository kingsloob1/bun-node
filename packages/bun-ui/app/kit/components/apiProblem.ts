/**
 * What the kit's error views (`ErrorView`, `ProblemBanner`, `ConfirmDialog`)
 * read from a failed request, and how they recognise one. Each UI has its own
 * `ApiError` class (`app/<ui>/api/errors.ts`) and passes its own `isApiError`
 * through a one-line binding (`app/<ui>/components/ErrorView.tsx`, …), so a
 * view recognises exactly the errors that UI raises, as before the kit.
 */

/** One validation issue inside a problem. */
export interface ProblemIssueLike {
  /** Which part of the request failed. */
  readonly target: string;
  /** Dotted path within the target, or `""` for the target itself. */
  readonly path: string;
  /** Human-readable description. */
  readonly message: string;
}

/** The fields of a UI's `ApiError` the kit's views read. */
export interface ApiProblemLike {
  /** The HTTP status, or `0` when no response arrived. */
  readonly status: number;
  /** The problem's code (`VALIDATION`, `HTTP_502`, `NETWORK_ERROR`, …). */
  readonly code: string;
  /** Short, human-readable summary. */
  readonly title: string;
  /** Human-readable explanation of this occurrence, when there is one. */
  readonly detail: string | undefined;
  /** Validation issues, empty when there are none. */
  readonly issues: readonly ProblemIssueLike[];
  /** Safe, whitelisted context values, empty when there are none. */
  readonly context: Readonly<Record<string, unknown>>;
}

/** A UI's `isApiError`: whether a value is that UI's own `ApiError`. */
export type IsApiError = (value: unknown) => value is ApiProblemLike;
