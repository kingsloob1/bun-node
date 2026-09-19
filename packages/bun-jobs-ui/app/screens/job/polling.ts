import type { JobDto, JobState, QueueEventName } from "../../api/types";
import { QUEUE_EVENT_TYPES } from "@kingsleyweb/bun-jobs/api/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { isFinished, jobKeys } from "../../api/jobs";
import {
  liveChannels,
  useLiveInvalidation,
  useLiveSubscription,
  usePollInterval,
} from "../../live";
import { POLL_INTERVAL_MS } from "../../queryClient";

/**
 * How the job screen stays fresh: events on the job's channel invalidate it
 * (see {@link useJobLive}), and it also polls — at the intervals below while
 * live updates are off, much slower while they are live. Log lines and a
 * child's progress announce nothing on this job's channel, so the logs and
 * the children table keep their own intervals either way.
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

/**
 * The job's refetch interval, given live updates: a function of its state
 * ({@link jobRefetchInterval}, relaxed by `usePollInterval` while live).
 */
export function useJobRefetchInterval(): (
  state: JobState | undefined,
) => number | false {
  const poll = usePollInterval(JOB_POLL_MS);
  return useCallback(
    (state) => (jobRefetchInterval(state) === false ? false : poll),
    [poll],
  );
}

/** Job events that change nothing the job screen shows: progress is patched in place instead, and an add that added nothing is no change. */
const NOT_REFETCHED: ReadonlySet<QueueEventName> = new Set<QueueEventName>([
  "progress",
  "duplicate",
  "throttled",
]);

/** The events on a job's channel that refetch the job, its logs and its children. */
export const JOB_EVENTS: readonly QueueEventName[] = QUEUE_EVENT_TYPES.filter(
  (type) => !NOT_REFETCHED.has(type),
);

/**
 * Whether a `progress` event's value is one the wire declares: a number, or
 * a record of fields. Anything else (an array, `null`, a string from a
 * producer on an older version) refetches the job instead of being written
 * into it, so the screen shows what the store holds.
 */
export function isRunProgress(
  value: unknown,
): value is number | Record<string, unknown> {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "object" && value !== null && !Array.isArray(value))
  );
}

/**
 * The job screen's live updates, on `queue/<q>/job/<id>`. A state change
 * (or a retry, clean, removal, debounce) invalidates the job's key, which is
 * the prefix of its logs, stack traces and children, so all of them refetch.
 * A `progress` event refetches nothing: its value is written into the cached
 * job directly.
 */
export function useJobLive(queue: string, id: string, enabled: boolean): void {
  const queryClient = useQueryClient();
  const channels = [liveChannels.job(queue, id)];
  useLiveInvalidation(channels, [jobKeys.job(queue, id)], {
    events: JOB_EVENTS,
    enabled,
  });
  useLiveSubscription({
    channels,
    events: ["progress"],
    enabled,
    onEvent: (event) => {
      if (event.kind !== "queue" || event.type !== "progress") {
        return;
      }
      const { progress } = event.payload;
      if (!isRunProgress(progress)) {
        void queryClient.invalidateQueries({
          queryKey: jobKeys.job(queue, id),
          exact: true,
        });
        return;
      }
      const patch = (job: JobDto | undefined) =>
        job ? { ...job, progress } : job;
      queryClient.setQueryData<JobDto>(jobKeys.job(queue, id), patch);
    },
  });
}
