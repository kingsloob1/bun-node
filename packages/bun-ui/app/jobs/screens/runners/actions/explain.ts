import type { TriggerOutcomeDto } from "../../../api/types";
import { ApiError, isApiError } from "../../../api/errors";
import { formatNumber, plural } from "../../../format";

/** Why a trigger was skipped. */
export type SkipReason = Extract<
  TriggerOutcomeDto,
  { outcome: "skipped" }
>["reason"];

/**
 * A skipped trigger's reason in words. Verified against
 * `BunRunner.trigger()` / `RunnerController.trigger()`: `busy`, `lock-held` and
 * `max-concurrency` are skips only because the runner does not queue
 * triggers (`queueRuns: false`); with queueing on they come back `queued`.
 */
export const SKIP_REASONS: Readonly<Record<SkipReason, string>> = {
  paused:
    "The runner is paused. Tick “Run even while paused” to run it anyway, or resume it.",
  busy: "A run is already in progress, and this runner does not queue triggers.",
  "lock-held":
    "Another process holds the runner's lock (a run is in progress there), and this runner does not queue triggers.",
  "max-concurrency":
    "The runner is at its concurrency limit, and it does not queue triggers.",
  "queue-full":
    "The runner's trigger queue is full (maxQueuedRuns). Try again once some queued runs have started.",
  stopped: "The runner has stopped, so nothing runs.",
};

/** A runner write whose failures get a plain-language explanation. */
export type RunnerAction =
  | "trigger"
  | "pause"
  | "resume"
  | "reschedule"
  | "kill"
  | "resetStats"
  | "clearHistory"
  | "configure";

/** What each local-only action does, for the `RUNNER_NOT_LOCAL` explanation. */
const LOCAL_ONLY: Partial<Record<RunnerAction, string>> = {
  kill: "Only the process executing a run can kill it",
  resetStats: "Only the process that registered the runner can reset its stats",
};

/**
 * The plain-language explanation of a failed runner write, or `null` when
 * the API's own detail says it well enough.
 */
export function explainRunnerError(
  error: ApiError,
  action: RunnerAction,
): string | null {
  switch (error.code) {
    case "RUNNER_NOT_LOCAL":
      return `${LOCAL_ONLY[action] ?? "This action needs the runner registered in the API's process"}, and this runner is registered only in another process. Use the management API of the process that runs it.`;
    case "RUN_NOT_FOUND":
      return "That run is no longer active in this process: it finished, or was killed already. Refresh to see the runs in flight now.";
    case "RUNNER_STOPPED":
      return "The runner has stopped (its process is shutting down, or it was stopped), so it cannot be triggered.";
    case "ARGS_NOT_ALLOWED":
      return "This API does not accept run arguments (it was created without runnerTriggerArgs). Trigger without arguments.";
    case "RUNNER_NOT_CONFIGURABLE":
      return "This runner cannot be configured from the API yet: no process running it has started since remote configuration shipped, so a setting would be stored and never adopted. Restart the runner on the current version, or change its settings where the runner is defined.";
    case "CONFIG_NOT_ALLOWED":
      return "The runner's own code does not permit that setting — usually an execution mode outside its `allowedOverrides.executionModes`. Choose one of the modes offered, or widen the list where the runner is defined.";
    case "RUNNER_NOT_FOUND":
      return action === "clearHistory"
        ? "The runner no longer exists in this namespace (it was unregistered, or its state was removed), so it has no history left to clear."
        : "The runner no longer exists in this namespace: it was unregistered, or its state was removed.";
    default:
      return null;
  }
}

/**
 * The error to show in a dialog: an `ApiError` whose detail is the
 * explanation when there is one (code, status and context kept), else the
 * error unchanged.
 */
export function explained(error: unknown, action: RunnerAction): unknown {
  if (!isApiError(error)) {
    return error;
  }
  const detail = explainRunnerError(error, action);
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

/** The success toast of a history clear: how many runs went, and how many in progress were kept. */
export function clearHistoryMessage(removed: number, kept: readonly string[]) {
  const keptPart =
    kept.length > 0 ? `, kept ${formatNumber(kept.length)} in progress` : "";
  return `Cleared ${plural(removed, "run")}${keptPart}`;
}
