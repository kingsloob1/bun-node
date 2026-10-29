/**
 * The in-process single-flight behind `getOrSet` (plan §3.4): the first
 * caller for a key leads the load; everyone else awaits the leader's promise.
 *
 * The rules that make it safe (Go's singleflight, moka, HybridCache):
 *
 * - **A flight deletes only itself**: the map entry is removed only if it is
 *   still the flight's own entry, so a finished flight never removes the next
 *   one.
 * - **Delete and invalidation forget the flight** (`forget`/`forgetAll`):
 *   callers arriving afterwards start a new load instead of joining one whose
 *   result is already stale; the forgotten leader's write is dropped by the
 *   core (it checks the flight is still current before storing).
 * - **Cancellation is collective**: the loader's `AbortSignal` aborts only
 *   when *every* waiter has aborted, so one impatient caller cannot cancel
 *   work others wait on (HybridCache's rule).
 * - **A rejection is shared, never cached**: every waiter rejects with the
 *   one error, and the next call runs the loader again.
 * - **The read before a load is shared too** (`shareRead`): the callers that
 *   ask while one read of a key runs await that read, and a read that a
 *   flight for its key settled under is told so (it may have missed the
 *   flight's write) and reads again. Without this, a backend whose reads
 *   queue for longer than the load (MongoDB under a 1,000-caller stampede)
 *   answered some callers' misses after the first flight had settled, and
 *   they led a second load (found by the bench, PR-B1).
 */

/** The suffixes `shareRead` keys a read under: none for a read through the L1 tier, `"\nl2"` for one that bypasses it. */
export const READ_SUFFIXES = ["", "\nl2"] as const;

/** One in-flight load. */
export interface Flight<T> {
  /** What every waiter awaits. */
  promise: Promise<T>;
  /** Aborts the loader's signal; fired when every waiter aborted, or on the hard timeout. */
  abort: () => void;
  /** The loader's signal. */
  signal: AbortSignal;
  /** How many callers wait on this flight right now. */
  waiters: number;
  /** How many callers have aborted their wait. */
  aborted: number;
  /** Whether the leader's own work has settled (its write may still be pending). */
  settled: boolean;
  /** A background refresh (stale-while-revalidate, eager refresh): a caller is served the stale value rather than joining it. */
  background: boolean;
}

/** One driver read shared by the callers that asked for its key while it ran. */
interface SharedRead {
  /** What every caller of the read awaits. */
  promise: Promise<unknown>;
  /** Set when a flight for the read's key settled while it ran: its write may have landed after the read looked. */
  overtaken: boolean;
}

/** The flight map of one cache, shared by its namespace views (flights are keyed by namespace + stored key). */
export class FlightMap {
  readonly #flights = new Map<string, Flight<unknown>>();
  /** The reads running, by flight key plus the read's tier suffix. */
  readonly #reads = new Map<string, SharedRead>();

  /** The flight for `key`, when one is running. */
  get<T>(key: string): Flight<T> | undefined {
    return this.#flights.get(key) as Flight<T> | undefined;
  }

  /** Registers a new flight led by this caller; `undefined` when one already runs for `key`. */
  lead<T>(key: string, background = false): Flight<T> | undefined {
    if (this.#flights.has(key)) {
      return undefined;
    }
    const controller = new AbortController();
    const flight: Flight<T> = {
      promise: undefined as unknown as Promise<T>,
      abort: () => controller.abort(),
      signal: controller.signal,
      waiters: 1,
      aborted: 0,
      settled: false,
      background,
    };
    this.#flights.set(key, flight as Flight<unknown>);
    return flight;
  }

  /** What {@link lead}'s flight resolves to; binds the promise after the leader's work is built. */
  bind<T>(key: string, flight: Flight<T>, promise: Promise<T>): void {
    flight.promise = promise;
    // The promise's rejection reaches every waiter through the flight; keep
    // it from reading as unhandled when nobody is attached yet.
    promise.catch(() => {});
  }

  /** Joins a running flight: one more waiter. */
  join<T>(flight: Flight<T>): Promise<T> {
    flight.waiters++;
    return flight.promise;
  }

  /**
   * A caller with an `AbortSignal` stops waiting. When every waiter has
   * aborted, the flight's own signal aborts — the loader's cue that nobody
   * wants the result.
   */
  leaveOnAbort(flight: Flight<unknown>, signal: AbortSignal): void {
    if (signal.aborted) {
      this.#aborted(flight);
      return;
    }
    signal.addEventListener("abort", () => this.#aborted(flight), {
      once: true,
    });
  }

  /**
   * The read running for `key` (a flight key, plus `suffix` when the read
   * differs by tier), joined; or a new one, started by `run`. `run` gets
   * `overtaken()`, which answers whether a flight for `key` has settled since
   * the read began — its write may have landed after the read looked, so a
   * miss is not to be trusted — and clears the mark.
   */
  shareRead<T>(
    key: string,
    suffix: string,
    run: (overtaken: () => boolean) => Promise<T>,
  ): Promise<T> {
    const readKey = key + suffix;
    const running = this.#reads.get(readKey);
    if (running !== undefined) {
      return running.promise as Promise<T>;
    }
    const read: SharedRead = { promise: Promise.resolve(), overtaken: false };
    this.#reads.set(readKey, read);
    const promise = (async () => {
      try {
        return await run(() => {
          const overtaken = read.overtaken;
          read.overtaken = false;
          return overtaken;
        });
      } finally {
        if (this.#reads.get(readKey) === read) {
          this.#reads.delete(readKey);
        }
      }
    })();
    read.promise = promise;
    return promise;
  }

  /** Removes the flight for `key`, only when it is still `flight` itself, and tells the reads running for `key` that it settled. */
  settle(key: string, flight: Flight<unknown>): void {
    flight.settled = true;
    if (this.#flights.get(key) === (flight as Flight<unknown>)) {
      this.#flights.delete(key);
    }
    for (const suffix of READ_SUFFIXES) {
      const read = this.#reads.get(key + suffix);
      if (read !== undefined) {
        read.overtaken = true;
      }
    }
  }

  /** Forgets the flight for `key` (a delete landed): its leader's write is dropped by the core. */
  forget(key: string): void {
    this.#flights.delete(key);
  }

  /** Forgets every flight whose key carries the `prefix` (a namespace's, on `clear`/`invalidateTags`). */
  forgetAll(prefix: string): void {
    for (const key of [...this.#flights.keys()]) {
      if (key.startsWith(prefix)) {
        this.#flights.delete(key);
      }
    }
  }

  #aborted(flight: Flight<unknown>): void {
    flight.aborted++;
    if (flight.aborted >= flight.waiters && !flight.settled) {
      flight.abort();
    }
  }
}
