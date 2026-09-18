import { POLL_INTERVAL_MS } from "../../queryClient";

/**
 * How the queue screens stay current. Today every live read polls; M4's
 * WebSocket replaces this one module (an interval of `false` plus event
 * invalidations), and nothing else in the screens changes.
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

/** The refetch interval of one kind of queue read. */
export function refreshInterval(
  kind: keyof typeof QUEUE_REFRESH,
): number | false {
  return QUEUE_REFRESH[kind];
}
