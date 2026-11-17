/**
 * The agent's event batcher (topologies.md §5, PR-CP1's contract): one
 * batch a second, or sooner once 500 events are queued, posted to the
 * control plane's `/agent/events` (gzip JSON, signed by the agent).
 *
 * - `200` (`{ duplicate }`): stored, dropped from the queue.
 * - `429` (honouring `Retry-After`), `5xx` or a network error: kept and
 *   retried with the same `batchId`, backing off.
 * - Any other `4xx`: not retried; counted in {@link EventBatcher.rejected}.
 *
 * The retry queue is bounded (60 batches or 8 MiB, whichever first); past
 * it the oldest batch is dropped and counted as `events.dropped`
 * (`{ reason: "agent-queue" }`) in the next batch's counters, never
 * silently.
 */
import { randomUUID } from "node:crypto";
import type { AgentEventBatch, AgentEventSource, CounterRow } from "./events";
import { droppedCounter, EVENT_BATCH_FORMAT, MAX_BATCH_EVENTS } from "./events";

/** What sending a batch answered. */
export interface BatchAnswer {
  /** The HTTP status; `0` for a network error. */
  readonly status: number;
  /** `Retry-After`, seconds, with a `429`. */
  readonly retryAfterSeconds?: number;
}

/** Options of {@link createEventBatcher}. */
export interface EventBatcherOptions {
  /** The agent's service. */
  readonly service: string;
  /** Where events and counters come from. */
  readonly source: AgentEventSource;
  /** Sends a batch (the agent signs and gzips it). */
  readonly send: (batch: AgentEventBatch) => Promise<BatchAnswer>;
  /** How often a batch goes, ms. Default 1,000. */
  readonly intervalMs?: number;
  /** Batches the retry queue holds. Default 60. */
  readonly maxQueueBatches?: number;
  /** Bytes (JSON) the retry queue holds. Default 8 MiB. */
  readonly maxQueueBytes?: number;
  /** The clock. Default `Date.now`. */
  readonly now?: () => number;
}

/** The batcher. */
export interface EventBatcher {
  /** Sends what is due now: queued batches first, then a new one. */
  readonly flush: () => Promise<void>;
  /** Batches waiting for a retry. */
  readonly queued: () => number;
  /** Batches dropped at the queue's bound so far. */
  readonly dropped: () => number;
  /** Batches the control plane refused for good (a 4xx other than 429). */
  readonly rejected: () => number;
  /** Stops the timer. */
  readonly close: () => void;
}

/** A queued batch and its size. */
interface Queued {
  /** The batch. */
  readonly batch: AgentEventBatch;
  /** Its JSON size, bytes. */
  readonly bytes: number;
}

/** The `events.dropped` count a batch carries. */
function droppedIn(batch: AgentEventBatch): number {
  let total = 0;
  for (const row of batch.counters) {
    if (row.metric === "events.dropped" && row.dims?.reason === "agent-queue") {
      total += row.value;
    }
  }
  return total;
}

/** A batcher; see the module's description. */
export function createEventBatcher(options: EventBatcherOptions): EventBatcher {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 1_000;
  const maxBatches = options.maxQueueBatches ?? 60;
  const maxBytes = options.maxQueueBytes ?? 8 * 1024 * 1024;
  const queue: Queued[] = [];
  let queuedBytes = 0;
  let droppedTotal = 0;
  let droppedUnreported = 0;
  let rejected = 0;
  let notBefore = 0;
  let backoffMs = intervalMs;
  let running: Promise<void> | undefined;

  /** Queues `batch`, dropping the oldest past the bound. */
  const enqueue = (batch: AgentEventBatch) => {
    const bytes = JSON.stringify(batch).length;
    queue.push({ batch, bytes });
    queuedBytes += bytes;
    while (
      queue.length > maxBatches ||
      (queuedBytes > maxBytes && queue.length > 1)
    ) {
      const gone = queue.shift()!;
      queuedBytes -= gone.bytes;
      droppedTotal++;
      // Its own drop count, if it carried one, is carried again: never lost.
      droppedUnreported += 1 + droppedIn(gone.batch);
    }
  };

  /** A new batch from the source, with the drop counter when due. */
  const next = (): AgentEventBatch | undefined => {
    const events = options.source.ring.take(MAX_BATCH_EVENTS);
    // Every minute, the open one too (CP5's live overview), so it is never a minute behind:
    // the recorder forgets what it flushed, and the store adds, so nothing counts twice.
    const counters: CounterRow[] = [
      ...options.source.recorder.flush({ all: true }),
    ];
    if (droppedUnreported > 0) {
      counters.push(droppedCounter(droppedUnreported, now(), options.service));
      droppedUnreported = 0;
    }
    if (events.length === 0 && counters.length === 0) return undefined;
    return Object.freeze({
      route: "events",
      format: EVENT_BATCH_FORMAT,
      batchId: randomUUID(),
      service: options.service,
      sentAt: now(),
      events,
      counters,
    });
  };

  /** Sends the queue's head until one fails. */
  const drain = async () => {
    while (queue.length > 0 && now() >= notBefore) {
      const head = queue[0]!;
      let answer: BatchAnswer;
      try {
        answer = await options.send(head.batch);
      } catch {
        answer = { status: 0 };
      }
      if (answer.status >= 200 && answer.status < 300) {
        queue.shift();
        queuedBytes -= head.bytes;
        backoffMs = intervalMs;
        continue;
      }
      if (
        answer.status === 429 ||
        answer.status === 0 ||
        answer.status >= 500
      ) {
        const wait =
          answer.status === 429 && answer.retryAfterSeconds !== undefined
            ? answer.retryAfterSeconds * 1000
            : backoffMs;
        notBefore = now() + wait;
        backoffMs = Math.min(backoffMs * 2, 60_000);
        return;
      }
      // Refused for good: never retried, counted.
      queue.shift();
      queuedBytes -= head.bytes;
      rejected++;
    }
  };

  const flush = async () => {
    running ??= (async () => {
      try {
        const batch = next();
        if (batch !== undefined) enqueue(batch);
        await drain();
      } finally {
        running = undefined;
      }
    })();
    await running;
  };

  const timer = setInterval(() => {
    void flush();
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  /** A full ring sends at once rather than at the next tick. */
  const eager = setInterval(
    () => {
      if (options.source.ring.size() >= MAX_BATCH_EVENTS) void flush();
    },
    Math.max(50, Math.floor(intervalMs / 10)),
  );
  (eager as { unref?: () => void }).unref?.();

  return Object.freeze({
    flush,
    queued: () => queue.length,
    dropped: () => droppedTotal,
    rejected: () => rejected,
    close: () => {
      clearInterval(timer);
      clearInterval(eager);
    },
  });
}
