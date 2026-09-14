/**
 * Keeping a stored event log from growing for as long as the queue runs.
 *
 * Three drivers write events down — a row, a document, a line — and until
 * recently none of them removed one. That is a table that only grows, on a
 * path nobody looks at, holding notifications whose whole value expired
 * seconds after they were published.
 *
 * Events are a live channel, not an audit trail. A subscriber that has been
 * down long enough to care about an hour-old event has a larger problem than
 * the event, and anything that genuinely needs a history of what ran should be
 * reading the jobs themselves, which have retention rules of their own.
 *
 * Pruning is opportunistic rather than scheduled: it rides on a publish that
 * was happening anyway, and at most once per interval however many events go
 * past. A queue publishing nothing never sweeps, which is right — it is also
 * not accumulating anything.
 */

/** How long a stored event is kept, unless the driver is told otherwise. */
export const DEFAULT_EVENT_RETENTION_MS = 60 * 60 * 1000;

/** How much of the retention window passes between sweeps. */
const SWEEP_FRACTION = 0.25;

/** Decides when a driver should next prune its event log. */
export class EventRetention {
  /** How long an event is kept. */
  readonly #retentionMs: number;
  /** The shortest gap between two sweeps. */
  readonly #intervalMs: number;
  /** When each namespace was last swept. */
  readonly #swept = new Map<string, number>();

  constructor(
    /** How long to keep an event. Zero or less disables pruning entirely. */
    retentionMs: number = DEFAULT_EVENT_RETENTION_MS,
  ) {
    this.#retentionMs = retentionMs;
    this.#intervalMs = Math.max(1_000, retentionMs * SWEEP_FRACTION);
  }

  /**
   * The cutoff to prune to, or `null` when it is not yet worth sweeping.
   *
   * Records the attempt before returning, so a caller that fails still waits a
   * full interval rather than retrying on every publish — a driver whose
   * delete is failing should not turn that into a write per event.
   */
  due(ns: string, now = Date.now()): number | null {
    if (this.#retentionMs <= 0) {
      return null;
    }

    const last = this.#swept.get(ns);

    if (last !== undefined && now - last < this.#intervalMs) {
      return null;
    }

    this.#swept.set(ns, now);
    return now - this.#retentionMs;
  }

  /** Forgets what it has swept, for a driver that is closing or purging. */
  clear(): void {
    this.#swept.clear();
  }
}
