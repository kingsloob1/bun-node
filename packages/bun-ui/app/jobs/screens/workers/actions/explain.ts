import { ApiError, isApiError } from "../../../api/errors";

/** One thing the UI asks of a worker. */
export type WorkerAction = "pause" | "resume" | "stop" | "start" | "configure";

/** How each action reads in a sentence about what was refused. */
const WHAT: Readonly<Record<WorkerAction, string>> = {
  pause: "pause this worker",
  resume: "resume this worker",
  stop: "stop this worker",
  start: "start this worker",
  configure: "change this worker's settings",
};

/**
 * A worker error in the user's terms, or `null` to leave the API's own text.
 * The codes come from the management API's worker routes.
 */
export function explainWorkerError(
  error: ApiError,
  action: WorkerAction,
): string | null {
  switch (error.code) {
    case "WORKER_NOT_FOUND":
      return "This worker is not in the registry: it was never there, or its record was removed. Refresh to see the workers reporting now.";
    case "WORKER_GONE":
      return "This worker's record lapsed before the instruction reached it — its process stopped reporting. Refresh; if it comes back it will have a new id.";
    case "WORKER_STATE_CONFLICT":
      return `Could not ${WHAT[action]}: it is no longer in the state that action needs. Refresh and look at its state — a stopped worker is started, not resumed.`;
    case "WORKER_NOT_CONTROLLABLE":
      return "This API cannot control this worker: remote control is off for it, or it runs an older release that does not listen for instructions.";
    case "WORKER_PERSISTENCE_NOT_ALLOWED":
      return "This deployment does not let a stop's persistence be chosen per request. Stop it with the behaviour the deployment configured.";
    case "CONTROL_CONTENDED":
      return "Somebody else changed this worker while the dialog was open, so nothing was written. Refresh to see their change, then apply yours again.";
    case "CONFIG_NOT_ALLOWED":
      return "The API refused these settings: a value is outside what it allows, or this deployment does not allow that setting to be overridden.";
    default:
      return null;
  }
}

/**
 * The error to show in a dialog: an `ApiError` whose detail is the
 * explanation when there is one (its code, status and context kept), else the
 * error unchanged.
 */
export function explained(error: unknown, action: WorkerAction): unknown {
  if (!isApiError(error)) {
    return error;
  }
  const detail = explainWorkerError(error, action);
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
