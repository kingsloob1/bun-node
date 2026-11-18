/**
 * The security app's `ApiError`: a problem (`urn:bun-security:problem:<code>`)
 * the management API answered, or a network failure (status 0). The kit's
 * error views recognise it through `isApiError`.
 */
import type {
  ApiProblemLike,
  ProblemIssueLike,
} from "../../kit/components/apiProblem";

/** A failed call. */
export class ApiError extends Error implements ApiProblemLike {
  /** The HTTP status, `0` when no answer arrived. */
  readonly status: number;
  /** The problem's code (`forbidden`, `step_up_required`, `NETWORK_ERROR`). */
  readonly code: string;
  /** Short summary. */
  readonly title: string;
  /** The problem's detail. */
  readonly detail: string | undefined;
  /** Validation issues. */
  readonly issues: readonly ProblemIssueLike[];
  /** Safe context: `stepUpUrl` for a step-up, `dangerous` (what made a change dangerous) for a `428`, `current` for a `409`. */
  readonly context: Readonly<Record<string, unknown>>;

  /**
   * @param init The error's fields.
   */
  constructor(init: {
    status: number;
    code: string;
    title: string;
    detail?: string;
    issues?: readonly ProblemIssueLike[];
    context?: Readonly<Record<string, unknown>>;
  }) {
    super(init.detail ?? init.title);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.issues = init.issues ?? [];
    this.context = init.context ?? {};
  }

  /** The step-up URL a `401 step_up_required` names, else `undefined`. */
  get stepUpUrl(): string | undefined {
    const url = this.context.stepUpUrl;
    return this.code === "step_up_required" && typeof url === "string"
      ? url
      : undefined;
  }
}

/** Whether `value` is this app's `ApiError`. */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** A path segment as text (a string or a number; anything else is unreadable). */
function segmentText(segment: unknown): string {
  return typeof segment === "string" || typeof segment === "number"
    ? String(segment)
    : "";
}

/** The `ApiError` of a failed response (a problem body, or the status alone). */
export async function errorFromResponse(response: Response): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.clone().json()) as Record<string, unknown>;
  } catch {
    // Not JSON: the status alone.
  }
  const issues = Array.isArray(body.issues)
    ? (body.issues as { message?: unknown; path?: unknown }[]).map((issue) => ({
        target: "request",
        path: Array.isArray(issue.path)
          ? issue.path.map(segmentText).join(".")
          : segmentText(issue.path),
        message: typeof issue.message === "string" ? issue.message : "",
      }))
    : [];
  return new ApiError({
    status: response.status,
    code: typeof body.code === "string" ? body.code : `HTTP_${response.status}`,
    title:
      typeof body.title === "string"
        ? body.title
        : response.statusText || `HTTP ${response.status}`,
    ...(typeof body.detail === "string" ? { detail: body.detail } : {}),
    issues,
    context: {
      ...(typeof body.stepUpUrl === "string"
        ? { stepUpUrl: body.stepUpUrl }
        : {}),
      // What made a change dangerous (`428 confirmation_required`).
      ...(Array.isArray(body.dangerous) &&
      body.dangerous.every((item) => typeof item === "string")
        ? { dangerous: body.dangerous as string[] }
        : {}),
      // The current state of what changed under the request (a `409`).
      ...(body.current === undefined ? {} : { current: body.current }),
    },
  });
}
