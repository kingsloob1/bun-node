/**
 * Follows a log of events numbered by a sequence, without losing one that
 * becomes visible after a later one.
 *
 * A sequence number is taken when an event is written and seen when the write
 * lands, and those two orders differ whenever publishers run concurrently: the
 * later event lands first, a poll reads it and moves past the earlier number,
 * which then lands — and asking only for numbers above the cursor never returns
 * it. Reproduced on Postgres and MariaDB with one open transaction, and the
 * reason a `stalled` event went missing there.
 *
 * So each number passed over is remembered and asked for again on every poll
 * until it turns up, or until it is old enough that it never will — a write
 * that failed or rolled back leaves its number unused for good.
 */

/** How long a passed-over number is looked for, in milliseconds. */
export const EVENT_HOLE_TTL_MS = 30_000;

/** The most passed-over numbers one follower keeps looking for. */
export const EVENT_HOLE_LIMIT = 500;

export class EventGaps {
  /** The highest number delivered so far. */
  #cursor: number;
  /** Numbers passed over and not yet seen, with when each was first missed. */
  readonly #holes = new Map<number, number>();

  constructor(
    /** The number to start after: the log's latest when following begins. */
    start: number,
  ) {
    this.#cursor = start;
  }

  /** The highest number delivered so far. */
  get cursor(): number {
    return this.#cursor;
  }

  /**
   * The passed-over numbers to ask for again this poll, after forgetting those
   * too old to still arrive.
   */
  retry(now: number): number[] {
    for (const [seq, missedAt] of this.#holes) {
      if (now - missedAt > EVENT_HOLE_TTL_MS) {
        this.#holes.delete(seq);
      }
    }

    return [...this.#holes.keys()];
  }

  /**
   * Records a number a poll returned, and says whether its event should be
   * delivered: `true` for one past the cursor or a late arrival, `false` for
   * one already delivered.
   */
  accept(seq: number, now: number): boolean {
    if (this.#holes.delete(seq)) {
      return true;
    }

    if (seq <= this.#cursor) {
      return false;
    }

    for (let missing = this.#cursor + 1; missing < seq; missing++) {
      this.#holes.set(missing, now);
    }
    this.#cursor = seq;

    // Oldest first, so a burst of failed writes cannot grow the query forever.
    while (this.#holes.size > EVENT_HOLE_LIMIT) {
      this.#holes.delete(this.#holes.keys().next().value!);
    }

    return true;
  }
}
