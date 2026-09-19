import type { JobState } from "../../api/types";
import { JOB_STATES } from "../../api/contract";
import { ApiError, isApiError } from "../../api/errors";
import { STATE_LABELS } from "../../format";

/** A job action whose failures get a plain-language explanation. */
export type JobAction =
  | "retry"
  | "promote"
  | "remove"
  | "update"
  | "add"
  | "fail";

/** The past participle of each action, for "cannot be …". */
const VERBS: Readonly<Record<JobAction, string>> = {
  retry: "retried",
  promote: "promoted",
  remove: "removed",
  update: "updated",
  add: "added",
  fail: "failed",
};

/** What the action needs, said after a state conflict. */
const REQUIREMENTS: Readonly<Record<JobAction, string>> = {
  retry: "Only a completed, failed, dead or delayed job can be retried.",
  promote: "Only a delayed job can be promoted.",
  remove: "Refresh to see where it is now.",
  update:
    "A new run time applies only to a waiting or delayed job, and “only in” limits the change to the states you picked.",
  add: "",
  fail: "Only a job that has not completed or died can be failed.",
};

/** The job's state from a problem's `context.state`, when it names one. */
export function conflictState(error: ApiError): JobState | null {
  const state = error.context.state;
  return typeof state === "string" &&
    (JOB_STATES as readonly string[]).includes(state)
    ? (state as JobState)
    : null;
}

/**
 * The plain-language explanation of a failed job action, or `null` when the
 * API's own detail says it well enough.
 */
export function explainJobError(
  error: ApiError,
  action: JobAction,
): string | null {
  switch (error.code) {
    case "JOB_ACTIVE":
      return "It's running: a worker is processing this job right now, so it cannot be removed. Wait for it to finish, then try again.";
    case "JOB_STATE_CONFLICT": {
      const state = conflictState(error);
      if (action === "fail" && state === "active") {
        // The API buries an active job only under the lock it read it with.
        return "A worker claimed the job again while it was being failed, so nothing changed. Refresh and try again.";
      }
      const where = state
        ? `The job is ${STATE_LABELS[state].toLowerCase()} now`
        : "The job is in another state now";
      return `${where}, so it cannot be ${VERBS[action]}. ${REQUIREMENTS[action]}`.trim();
    }
    case "JOB_NOT_FOUND":
      return "The job no longer exists: it finished and was cleaned up, or somebody removed it.";
    case "NAME_NOT_ADDABLE": {
      const name = error.context.name;
      return `Jobs named “${typeof name === "string" ? name : "this"}” may not be added over this API. Pick one of the names it allows.`;
    }
    case "SERIALIZATION":
      return "The data cannot be stored: it is not serialisable for this queue's backend.";
    default:
      return null;
  }
}

/**
 * The same error with its detail replaced by the explanation, so a toast or
 * a `ProblemBanner` reads it while keeping the code, status and context.
 * Anything that is not an `ApiError`, or has no better explanation, is
 * returned unchanged.
 */
export function friendlyJobError(error: unknown, action: JobAction): unknown {
  if (!isApiError(error)) {
    return error;
  }
  const detail = explainJobError(error, action);
  if (detail === null) {
    return error;
  }
  return new ApiError({
    kind: error.kind,
    status: error.status,
    code: error.code,
    title: error.title,
    detail,
    type: error.type,
    issues: error.issues,
    context: error.context,
    instance: error.instance,
    cause: error,
  });
}

/** Runs an API call, rethrowing its failure through {@link friendlyJobError}. */
export async function withFriendlyErrors<T>(
  action: JobAction,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw friendlyJobError(error, action);
  }
}
