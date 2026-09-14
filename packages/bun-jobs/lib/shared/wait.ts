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
    /** Promises whose settling ends the wait. */
    others?: Iterable<Promise<unknown>>;
    /** Whether the timer should hold the process open. Defaults to `false`. */
    ref?: boolean;
  } = {},
): Promise<void> {
  const { signal, others = [], ref = false } = options;

  if (signal?.aborted) {
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const elapsed = new Promise<void>((resolve) => {
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
    await Promise.race([
      elapsed,
      ...Array.from(others, async (settles) => {
        await settles.catch(() => {});
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
