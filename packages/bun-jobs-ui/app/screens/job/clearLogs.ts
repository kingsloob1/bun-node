import type { JobState } from "../../api/types";

/** Why the button is disabled on an active job. */
export const CLEAR_LOGS_ACTIVE_REASON =
  "Clear logs once the job finishes — a running job is still writing to them.";

/** Why the button is disabled on a job whose log is empty. */
export const CLEAR_LOGS_EMPTY_REASON = "No lines to clear.";

/**
 * Why clearing is not possible now, or `null` when it is: an active job is
 * still writing its log (the API answers 409 `JOB_ACTIVE`), and an empty log
 * has nothing to clear.
 */
export function clearLogsBlocker(
  state: JobState,
  total: number | null,
): string | null {
  if (state === "active") {
    return CLEAR_LOGS_ACTIVE_REASON;
  }
  if (total === 0) {
    return CLEAR_LOGS_EMPTY_REASON;
  }
  return null;
}
