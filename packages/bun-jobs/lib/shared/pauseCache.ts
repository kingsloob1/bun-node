import type { QueueRef } from "../drivers/driver";

/**
 * A queue's pause flag, remembered for a moment.
 *
 * Claiming must honour a paused queue, so every driver that keeps the flag in
 * ordinary storage was reading it once per claim — measured on Postgres, 0.12ms
 * of a 1.16ms claim, to answer "no" almost every time. `BunQueueWorker` already
 * caches the same flag for a second before it even calls the driver
 * (`#queuePaused`), so this is the same trade one layer down, and a quarter of
 * the window.
 *
 * What it costs: a pause set in *another* process takes effect within the TTL
 * rather than instantly. A pause set on this instance is immediate, because the
 * driver calls {@link PauseCache.write} when it writes the flag.
 *
 * Redis needs none of this — its claim script reads the flag inside the same
 * script, so there is no round trip to save.
 */

/** How long a flag is trusted before it is read again. */
export const DEFAULT_PAUSE_TTL_MS = 250;

/** Pause flags by queue, with the time each was read. */
export class PauseCache {
  /** How long an entry is trusted, in milliseconds. */
  readonly #ttl: number;
  /** The cached flags, keyed by namespace and queue. */
  readonly #entries = new Map<string, { paused: boolean; readAt: number }>();

  constructor(
    /** How long a flag is trusted. Defaults to {@link DEFAULT_PAUSE_TTL_MS}. */
    ttlMs: number = DEFAULT_PAUSE_TTL_MS,
  ) {
    this.#ttl = ttlMs;
  }

  /** The flag for one queue, calling `load` only when nothing fresh is held. */
  async read(q: QueueRef, load: () => Promise<boolean>): Promise<boolean> {
    const key = this.#key(q);
    const cached = this.#entries.get(key);
    const now = Date.now();

    if (cached && now - cached.readAt < this.#ttl) {
      return cached.paused;
    }

    const paused = await load();
    this.#entries.set(key, { paused, readAt: now });
    return paused;
  }

  /** Records a flag this process just wrote, so it reads back at once. */
  write(q: QueueRef, paused: boolean): void {
    this.#entries.set(this.#key(q), { paused, readAt: Date.now() });
  }

  /** Forgets everything, for a driver that is closing or purging. */
  clear(): void {
    this.#entries.clear();
  }

  /**
   * A key for one queue.
   *
   * A colon separates the halves, which cannot collide: `assertNamespace` and
   * `assertSegment` restrict both to `[A-Za-z0-9_.-]`, so neither can contain
   * one.
   */
  #key(q: QueueRef): string {
    return `${q.ns}:${q.queue}`;
  }
}
