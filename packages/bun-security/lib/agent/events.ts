/**
 * The event batch's contract: PR-CP1's own types (`./analytics`,
 * `./store`), re-exported here as the one place the agent takes them from.
 * The agent adds only the route its body is bound to (`route: "events"`).
 */
import type { AgentEventBatch as Cp1Batch } from "../analytics/batch";
import type { AnalyticsRecorder } from "../analytics/recorder";
import type { EventRing } from "../analytics/ring";
import type { CounterRow } from "../store/types";
import { EVENT_BATCH_LIMITS } from "../analytics/batch";

export { EVENT_BATCH_FORMAT, EVENT_BATCH_LIMITS } from "../analytics/batch";
export { MAX_BATCH_COUNTERS } from "../store/types";
export type { CounterRow, SecurityEvent } from "../store/types";

/** At most this many events a batch (CP1's bound). */
export const MAX_BATCH_EVENTS = EVENT_BATCH_LIMITS.events;

/** What `POST /agent/events` takes (gzip JSON): CP1's batch, bound to its route. */
export type AgentEventBatch = Cp1Batch & {
  /** The route the body is bound to (control-plane.md §7, PR-CP4). */
  readonly route: "events";
};

/** Where the batcher takes events and counters from: CP1's ring and recorder. */
export interface AgentEventSource {
  /** The EP's event ring (`createEventRing`). */
  readonly ring: Pick<EventRing, "take" | "size">;
  /** The EP's recorder (`createAnalyticsRecorder`), flushed once per batch. */
  readonly recorder: Pick<AnalyticsRecorder, "flush">;
}

/** The counter row recording batches the agent's queue dropped: `events.dropped`, `{ reason: "agent-queue" }`. */
export function droppedCounter(
  count: number,
  at: number,
  service: string,
): CounterRow {
  return Object.freeze({
    service,
    at,
    metric: "events.dropped",
    dims: Object.freeze({ reason: "agent-queue" }),
    value: count,
  });
}
