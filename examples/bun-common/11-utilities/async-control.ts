/**
 * Async control — sleeping, timeouts, polling, deferreds, retries with
 * backoff, locks, and finding a free port.
 *
 * ```bash
 * bun 11-utilities/async-control.ts
 * ```
 *
 * The points worth knowing:
 *
 * - **Cancellation is an `AbortSignal`, and `isAbortError` recognises it.**
 *   `sleep` and `retry` reject with the signal's `reason` when that is an
 *   `Error` (a `DOMException` for a plain `abort()`), and otherwise with an
 *   `Error` named `AbortError` whose `cause` is the reason.
 * - **`withTimeout` does not cancel the work** — nothing can cancel a promise.
 *   It stops *waiting*, calls `onTimeout` so you can abort what drives the
 *   work, and keeps a handler on the late result so it never goes unhandled.
 * - **Timers that are unref'd do not hold the process open.** `withTimeout`'s
 *   timer is unref'd by default; `sleep` and `retry`'s waits are unref'd only
 *   when asked (`unref: true`). A script whose only pending work is an unref'd
 *   timer can exit early.
 * - **`computeBackoff` is pure**: attempt number in, milliseconds out. `retry`
 *   uses it, and so can anything else that schedules its own retries.
 */
import {
  computeBackoff,
  createDeferred,
  getPort,
  isAbortError,
  Mutex,
  retry,
  Semaphore,
  sleep,
  TimeoutError,
  waitUntil,
  withTimeout,
} from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("Async control");

/* ------------------------------------------------------------------ */
step("sleep: a promise-based setTimeout that can be cancelled");

let started = performance.now();
await sleep(50);
show("slept", `${Math.round(performance.now() - started)}ms`);

const controller = new AbortController();
const cancelled = sleep(10_000, { signal: controller.signal });
setTimeout(() => controller.abort(), 20);
const abortError = await cancelled.catch((error: unknown) => error);
show("aborted mid-wait", {
  name: (abortError as Error).name,
  isAbortError: isAbortError(abortError),
});

const reasoned = new AbortController();
const shutdown = new Error("shutting down");
reasoned.abort(shutdown);
show(
  "an already-aborted signal rejects at once, with its Error reason",
  (await sleep(10_000, { signal: reasoned.signal }).catch(
    (error: unknown) => error,
  )) === shutdown,
);

// `unref: true` for a wait that must not, by itself, keep the process up —
// a background poll, say. The promise still resolves while something else
// holds the process — here, the ref'd interval below.
const holder = setInterval(() => {}, 1_000);
await sleep(10, { unref: true });
clearInterval(holder);
show("an unref'd sleep still resolves while something else holds the process");

/* ------------------------------------------------------------------ */
step("isAbortError: 'the caller cancelled' vs a real failure");

const named = new Error("stop");
named.name = "AbortError";
show("isAbortError", {
  "name AbortError": isAbortError(named),
  "code ABORT_ERR": isAbortError(
    Object.assign(new Error("x"), { code: "ABORT_ERR" }),
  ),
  "DOMException code 20": isAbortError({ code: 20 }),
  "a TypeError": isAbortError(new TypeError("x")),
  "a string": isAbortError("AbortError"),
});

/* ------------------------------------------------------------------ */
step("withTimeout: a budget for work that might hang");

show(
  "in time",
  await withTimeout(
    sleep(10).then(() => "done"),
    1_000,
  ),
);
show("a function is called for you", await withTimeout(() => 42, 1_000));
show(
  "ms <= 0 means no timeout",
  await withTimeout(Promise.resolve("no budget"), 0),
);

const work = new AbortController();
started = performance.now();
const late = await withTimeout(sleep(5_000, { signal: work.signal }), 50, {
  message: "the report took too long",
  onTimeout: () => work.abort(), // stop the work too, not just the waiting
  unref: false, // hold the process open for the timeout itself
}).catch((error: unknown) => error);
show("timed out", {
  isTimeoutError: late instanceof TimeoutError,
  name: (late as TimeoutError).name,
  message: (late as TimeoutError).message,
  ms: (late as TimeoutError).ms,
  after: `${Math.round(performance.now() - started)}ms`,
  workAborted: work.signal.aborted,
});
show("TimeoutError's default message", new TimeoutError(250).message);

/* ------------------------------------------------------------------ */
step("waitUntil and createDeferred");

let jobsDone = 0;
const ticker = setInterval(() => {
  jobsDone++;
}, 10);
const seen = await waitUntil(
  () => jobsDone,
  (count) => count >= 3,
  { interval: 5, timeout: 2_000 },
);
clearInterval(ticker);
show("waitUntil resolved with the value that passed", seen);

const never = await waitUntil(
  async () => "pending",
  (state) => state === "ready",
  { interval: 5, timeout: 40 },
).catch((error: unknown) => (error as Error).message);
show("and rejects when its timeout passes", never);

const ready = createDeferred<string>();
setTimeout(() => ready.resolve("connected"), 10);
show("createDeferred: resolved from outside", await ready.promise);
const failed = createDeferred<never>();
failed.reject(new Error("refused"));
show(
  "or rejected",
  await failed.promise.catch((error: unknown) => (error as Error).message),
);

/* ------------------------------------------------------------------ */
step("computeBackoff: every strategy, attempts 1 to 6, base 100ms");

for (const type of ["fixed", "exponential", "linear", "fibonacci"] as const) {
  show(
    type.padEnd(19),
    [1, 2, 3, 4, 5, 6].map((attempt) =>
      computeBackoff(attempt, { type, delay: 100 }),
    ),
  );
}
for (const type of ["full-jitter", "decorrelated-jitter"] as const) {
  show(
    type.padEnd(19),
    [1, 2, 3, 4, 5, 6].map((attempt) =>
      Math.round(computeBackoff(attempt, { type, delay: 100 })),
    ),
  );
}
show(
  "factor 3",
  [1, 2, 3, 4].map((attempt) =>
    computeBackoff(attempt, { type: "exponential", delay: 100, factor: 3 }),
  ),
);
show(
  "max 500",
  [1, 2, 3, 4, 5, 6].map((attempt) =>
    computeBackoff(attempt, { type: "exponential", delay: 100, max: 500 }),
  ),
);
show(
  "jitter true (±10%)",
  [1, 2, 3].map(() =>
    Math.round(computeBackoff(1, { delay: 1_000, jitter: true })),
  ),
);
show(
  "jitter 0.5 (±50%)",
  [1, 2, 3].map(() =>
    Math.round(computeBackoff(1, { delay: 1_000, jitter: 0.5 })),
  ),
);
show("a number is a fixed delay", computeBackoff(9, 250));
show("no options: fixed 1000ms", computeBackoff(1));

/* ------------------------------------------------------------------ */
step("retry: a flaky call, with every option");

let calls = 0;
const value = await retry(
  async (attempt, signal) => {
    calls++;
    if (signal?.aborted) {
      throw new Error("aborted");
    }
    if (attempt < 3) {
      throw Object.assign(new Error(`attempt ${attempt} failed`), {
        status: 503,
      });
    }
    return `succeeded on attempt ${attempt}`;
  },
  {
    attempts: 5,
    backoff: { type: "exponential", delay: 10, factor: 2, max: 1_000 },
    shouldRetry: (error) => (error as { status?: number }).status === 503,
    onRetry: (error, attempt, delayMs) => {
      show(
        `  retrying after attempt ${attempt} in ${delayMs}ms`,
        (error as Error).message,
      );
    },
    signal: new AbortController().signal,
  },
);
show("result", { value, calls });

const permanent = await retry(
  () => {
    throw Object.assign(new Error("not found"), { status: 404 });
  },
  {
    attempts: 5,
    backoff: 10,
    shouldRetry: (error) => (error as { status?: number }).status !== 404,
  },
).catch((error: unknown) => (error as Error).message);
show("shouldRetry false: the error is thrown at once", permanent);

const stopRetrying = new AbortController();
setTimeout(() => stopRetrying.abort(), 30);
const stopped = await retry(
  () => {
    throw new Error("down");
  },
  { attempts: 10, backoff: 5_000, signal: stopRetrying.signal },
).catch((error: unknown) => error);
show("aborted during a wait", { isAbortError: isAbortError(stopped) });

/* ------------------------------------------------------------------ */
step("Mutex: one at a time, first come first served");

const mutex = new Mutex();
const order: string[] = [];
await Promise.all(
  ["a", "b", "c"].map(async (name) => {
    await mutex.runExclusive(async () => {
      order.push(`${name}:in`);
      await sleep(5);
      order.push(`${name}:out`);
    });
  }),
);
show("runExclusive never interleaves", order.join(" "));

const release = await mutex.acquire();
const waiter = mutex.acquire();
show("held, with a waiter", { locked: mutex.locked, waiting: mutex.waiting });
release();
release(); // a second call is a no-op
(await waiter)();
show("released", { locked: mutex.locked, waiting: mutex.waiting });

/* ------------------------------------------------------------------ */
step("Semaphore: at most N at once, adjustable");

const semaphore = new Semaphore(2);
let active = 0;
let peak = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    await semaphore.runExclusive(async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(10);
      active--;
    });
  }),
);
show("six tasks, two permits: peak concurrency", peak);

const held = semaphore.tryAcquire();
const alsoHeld = semaphore.tryAcquire();
show("tryAcquire never waits", {
  third: semaphore.tryAcquire(),
  available: semaphore.available,
});
const queued = semaphore.acquire();
show("a waiter", { waiting: semaphore.waiting, permits: semaphore.permits });
semaphore.setPermits(3); // raising wakes the waiter at once
(await queued)();
held?.();
alsoHeld?.();
show("after setPermits(3) and releasing", {
  available: semaphore.available,
  permits: semaphore.permits,
});

/* ------------------------------------------------------------------ */
step("getPort: a free TCP port");

const port = await getPort();
show("any free port", port);
show(
  "the same port is not handed out again within a second",
  (await getPort({ port })) !== port,
);

const busy = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response("busy"),
});
show(
  "a busy preferred port falls back to a free one",
  (await getPort({ host: "127.0.0.1", port: [busy.port!] })) !== busy.port,
);
await busy.stop(true);
