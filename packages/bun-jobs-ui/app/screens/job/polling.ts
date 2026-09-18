import type { JobState } from "../../api/types";
import { isFinished } from "../../api/jobs";
import { POLL_INTERVAL_MS } from "../../queryClient";

/**
 * How the job screen stays fresh. Until live updates land (milestone 4, the
 * WebSocket), it polls; every interval the screen uses is chosen here, so
 * switching to socket-driven invalidation means changing this one module.
 */

/** How often an unfinished job is re-read, ms. */
export const JOB_POLL_MS = POLL_INTERVAL_MS;

/** How often the log page is re-read while the job is active or waiting, ms. */
export const LOG_POLL_MS = 3_000;

/** States during which new log lines can appear, so the log page refreshes. */
const LOGGING_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "active",
  "waiting",
]);

/** The job's refetch interval: {@link JOB_POLL_MS} until it has finished, then none. */
export function jobRefetchInterval(
  state: JobState | undefined,
): number | false {
  return state === undefined || isFinished(state) ? false : JOB_POLL_MS;
}

/** The logs' refetch interval: {@link LOG_POLL_MS} while the job is active or waiting, else none. */
export function logsRefetchInterval(
  state: JobState | undefined,
): number | false {
  return state !== undefined && LOGGING_STATES.has(state) ? LOG_POLL_MS : false;
}

/** Whether the log page auto-refreshes for a job in `state`. */
export function logsFollow(state: JobState | undefined): boolean {
  return logsRefetchInterval(state) !== false;
}

/** Page sizes offered for logs; those above `limits.maxLogPage` are dropped by the pager. */
export const LOG_PAGE_SIZES: readonly number[] = [50, 100, 200, 500];

/** The API's default log page: `min(100, maxLogPage)`. */
export function defaultLogLimit(maxLogPage: number): number {
  return Math.max(1, Math.min(100, maxLogPage));
}
