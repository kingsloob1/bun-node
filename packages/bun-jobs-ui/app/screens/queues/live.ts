import type { QueueEventName } from "../../api/types";
import { QUEUE_EVENT_TYPES } from "@kingsleyweb/bun-jobs/api/contract";
import { queryKeys } from "../../api/queryKeys";
import { queueKeys } from "../../api/queues";
import { liveChannels, useLiveInvalidation, usePollInterval } from "../../live";
import { POLL_INTERVAL_MS } from "../../queryClient";

/**
 * How the queue screens stay current: events from the API's socket
 * invalidate the reads they change (see {@link useQueueLive}), and every read
 * also polls — at its base interval below while live updates are off, much
 * slower while they are live (`usePollInterval`), as a safety net for a lost
 * event.
 */
export const QUEUE_REFRESH = {
  /** Counts per state (the tabs and the header). */
  counts: POLL_INTERVAL_MS,
  /** The jobs page on screen. */
  jobs: POLL_INTERVAL_MS,
  /** The queue list. */
  list: POLL_INTERVAL_MS,
  /** The queue's detail (paused, limits): it changes rarely, and every mutation invalidates it. */
  detail: POLL_INTERVAL_MS * 3,
  /** Workers' heartbeats. */
  workers: POLL_INTERVAL_MS * 2,
  /** Throughput buckets are a minute wide. */
  throughput: 30_000,
  /** Repeatables' next runs. */
  repeatables: POLL_INTERVAL_MS * 6,
} as const satisfies Record<string, number | false>;

/** A kind of queue read. */
export type QueueRefreshKind = keyof typeof QUEUE_REFRESH;

/**
 * Reads no event announces (a worker's heartbeat, a throughput bucket), so
 * they keep polling at their base interval even while live.
 */
const POLLED_ONLY: ReadonlySet<QueueRefreshKind> = new Set<QueueRefreshKind>([
  "workers",
  "throughput",
]);

/** The base refetch interval of one kind of queue read (while live updates are off). */
export function refreshInterval(kind: QueueRefreshKind): number | false {
  return QUEUE_REFRESH[kind];
}

/**
 * The refetch interval of one kind of queue read now: its base while live
 * updates are off, relaxed while they are live — except for the reads no
 * event announces, which always poll at their base.
 */
export function useRefreshInterval(kind: QueueRefreshKind): number | false {
  const relaxed = usePollInterval(QUEUE_REFRESH[kind]);
  return POLLED_ONLY.has(kind) ? QUEUE_REFRESH[kind] : relaxed;
}

/**
 * Queue events that do not change what a list or count shows: progress
 * (the jobs page shows none), and adds that added nothing or only replaced
 * data. Everything else moves a job between states, or adds or removes one.
 */
const NOT_COUNTED: ReadonlySet<QueueEventName> = new Set<QueueEventName>([
  "progress",
  "duplicate",
  "throttled",
  "debounced",
]);

/** The queue events that change counts, the jobs pages and the queue lists. */
export const COUNT_EVENTS: readonly QueueEventName[] = QUEUE_EVENT_TYPES.filter(
  (type) => !NOT_COUNTED.has(type),
);

/** The queue events that change a queue's detail (paused, totals): its lifecycle. */
export const DETAIL_EVENTS: readonly QueueEventName[] = [
  "paused",
  "resumed",
  "drained",
  "cleaned",
  "retried",
];

/** The queue events that change its repeatables (a series' next run). */
export const REPEATABLE_EVENTS: readonly QueueEventName[] = ["repeatScheduled"];

/** What {@link useQueueLive} may refresh. */
export interface QueueLiveOptions {
  /** Whether the queue's detail and counts are readable (`queues.read`, settled). Nothing subscribes otherwise. */
  enabled: boolean;
  /** Whether the jobs pages are on screen (`jobs.list`). */
  jobs: boolean;
  /** Whether the repeatables panel may be (`repeatables.list`). */
  repeatables: boolean;
}

/**
 * The queue screen's live updates, on `queue/<q>`: counts on every event
 * that moves a job (progress excluded, so a job reporting progress never
 * refetches the jobs page), the jobs pages likewise, the detail on
 * pause/resume/drain/clean/retry-all, and the repeatables when a series
 * schedules its next run. Workers and throughput stay polled.
 */
export function useQueueLive(queue: string, options: QueueLiveOptions): void {
  const channels = [liveChannels.queue(queue)];
  useLiveInvalidation(
    channels,
    options.jobs
      ? [queueKeys.counts(queue), queueKeys.jobsAll(queue)]
      : [queueKeys.counts(queue)],
    { events: COUNT_EVENTS, enabled: options.enabled },
  );
  useLiveInvalidation(channels, [queueKeys.detail(queue)], {
    events: DETAIL_EVENTS,
    enabled: options.enabled,
  });
  useLiveInvalidation(channels, [queueKeys.repeatables(queue)], {
    events: REPEATABLE_EVENTS,
    enabled: options.enabled && options.repeatables,
  });
}

/** The Queues list's live updates: any counted event on `queues` refreshes its pages. */
export function useQueueListLive(enabled: boolean): void {
  useLiveInvalidation([liveChannels.queues], [queueKeys.pages], {
    events: COUNT_EVENTS,
    enabled,
  });
}

/** What {@link useOverviewLive} refreshes. */
export interface OverviewLiveOptions {
  /** Whether the totals card is on screen (`metrics.read`). */
  overview: boolean;
  /** The queue card's search, when it is on screen (`queues.list`); `null` otherwise. */
  search: string | null;
}

/**
 * The Overview's live updates, on `queues`: the namespace totals and the
 * queue table (the one search on screen). The sparklines stay polled.
 */
export function useOverviewLive({
  overview,
  search,
}: OverviewLiveOptions): void {
  const keys = [
    ...(overview ? [queryKeys.overview()] : []),
    ...(search !== null ? [queryKeys.queues(search)] : []),
  ];
  useLiveInvalidation([liveChannels.queues], keys, {
    events: COUNT_EVENTS,
    enabled: keys.length > 0,
  });
}
