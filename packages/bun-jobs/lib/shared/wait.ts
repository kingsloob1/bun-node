/**
 * Waits for whichever comes first — `ms` passing, `signal` aborting, or any of
 * `others` settling — and leaves nothing behind.
 *
 * Built from a plain timer and one listener rather than `sleep` with an
 * `AbortController`, and that is the point of it. The worker and the Redis
 * driver wait like this between every job, on a signal that lives as long as
 * the worker. A sleep bound to that signal and abandoned when a job arrived
 * kept its listener until its timer fired, so a busy worker carried thousands
 * and every new one cost a walk of the rest. Aborting a controller of its own
 * instead fixed the leak but rejected the sleep each time, and building that
 * `AbortError` measured 687ms per 5,000 Redis round trips — on the path
 * between a job arriving and being claimed. This resolves rather than rejects,
 * and a `finally` clears the timer and the listener however the race ends.
 *
 * Never rejects: a promise in `others` that rejects counts as settled.
 */
export async function waitForAny(
  ms: number,
  options: {
    /** Ends the wait early when aborted. */
    signal?: AbortSignal;
    /**
     * Promises whose settling ends the wait. Each gets a reaction that stays
     * attached until *it* settles, however the wait ended — so never pass a
     * long-lived promise here on every pass of a loop; use `pulse` instead.
     */
    others?: Iterable<Promise<unknown>>;
    /**
     * Ends the wait at its next `notify()`. Unlike a promise in `others`, the
     * wait unsubscribes when it ends, so a pulse that fires rarely (or never)
     * accumulates nothing however many waits it outlives.
     */
    pulse?: Pulse;
    /** Whether the timer should hold the process open. Defaults to `false`. */
    ref?: boolean;
  } = {},
): Promise<void> {
  const { signal, others = [], pulse, ref = false } = options;

  if (signal?.aborted) {
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let onPulse: (() => void) | undefined;

  const elapsed = new Promise<void>((resolve) => {
    if (pulse) {
      onPulse = resolve;
      pulse.subscribe(onPulse);
    }

    timer = setTimeout(resolve, Math.max(0, ms));
    if (!ref) {
      timer.unref?.();
    }

    if (signal) {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  try {
    const racers = Array.from(others, async (settles) => {
      await settles.catch(() => {});
    });
    await (racers.length === 0 ? elapsed : Promise.race([elapsed, ...racers]));
  } finally {
    clearTimeout(timer);
    if (pulse && onPulse) {
      pulse.unsubscribe(onPulse);
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * A repeatable, edge-triggered wake-up: `notify()` ends every wait subscribed
 * at that moment, and a wait that ends any other way unsubscribes itself.
 *
 * The worker's full-slot wait is the reason it exists. It used to pass every
 * running job's promise to `waitForAny`, which left a reaction on each job
 * that outlived the wait: a long job beside a stream of short ones collected
 * one per completion for as long as it ran. A pulse that the completions fire
 * is O(1) per wait and leaves nothing behind.
 */
export class Pulse {
  /** The resolvers of the waits currently subscribed. */
  readonly #waiters = new Set<() => void>();

  /** How many waits are currently subscribed. */
  get size(): number {
    return this.#waiters.size;
  }

  /** Ends every wait subscribed right now. Costs nothing when none is. */
  notify(): void {
    if (this.#waiters.size === 0) {
      return;
    }

    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) {
      wake();
    }
  }

  /** Subscribes `wake` to the next `notify()`. */
  subscribe(wake: () => void): void {
    this.#waiters.add(wake);
  }

  /** Removes `wake`, if it is still subscribed. */
  unsubscribe(wake: () => void): void {
    this.#waiters.delete(wake);
  }
}
