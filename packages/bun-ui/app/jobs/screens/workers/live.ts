import { workerKeys } from "../../api/workers";
import { liveChannels, useLiveInvalidation, usePollInterval } from "../../live";

/**
 * How the worker views stay current.
 *
 * Worker events travel on their own channels — `workers`, and
 * `queue/<queue>/workers` — deliberately kept off `all` and `queues` so a
 * dashboard does not receive control traffic. A worker event (a state change,
 * an adopted config, a recorded control) refreshes the worker reads; without
 * a socket, every worker read polls at {@link WORKER_REFRESH.list}.
 */
export const WORKER_REFRESH = {
  /** Every worker read: a state change should show up quickly. */
  list: 5_000,
} as const satisfies Record<string, number | false>;

/**
 * The Workers page's live updates: any worker event in the namespace
 * refreshes every worker read. `enabled` is the caller's `workers.list`.
 */
export function useWorkerListLive(enabled: boolean): void {
  useLiveInvalidation([liveChannels.workers], [workerKeys.all], { enabled });
}

/**
 * One queue's worker panel: only that queue's worker events, so a busy
 * namespace does not refresh a panel watching one queue.
 */
export function useQueueWorkersLive(queue: string, enabled: boolean): void {
  useLiveInvalidation(
    [liveChannels.queueWorkers(queue)],
    [workerKeys.ofQueue(queue), workerKeys.all],
    { enabled },
  );
}

/** How often worker reads poll: the base interval, relaxed while live updates carry the changes. */
export function useWorkerRefetchInterval(): number | false {
  return usePollInterval(WORKER_REFRESH.list);
}
