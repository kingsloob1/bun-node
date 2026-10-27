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
 */

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
}

/** The flight map of one cache, shared by its namespace views (flights are keyed by namespace + stored key). */
export class FlightMap {
  readonly #flights = new Map<string, Flight<unknown>>();

  /** The flight for `key`, when one is running. */
  get<T>(key: string): Flight<T> | undefined {
    return this.#flights.get(key) as Flight<T> | undefined;
  }

  /** Registers a new flight led by this caller; `undefined` when one already runs for `key`. */
  lead<T>(key: string): Flight<T> | undefined {
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

  /** Removes the flight for `key`, only when it is still `flight` itself. */
  settle(key: string, flight: Flight<unknown>): void {
    flight.settled = true;
    if (this.#flights.get(key) === (flight as Flight<unknown>)) {
      this.#flights.delete(key);
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
