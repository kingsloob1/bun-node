/**
 * The caller leaving, without a socket as with one: `req.signal`, a streamed
 * body the caller cancels, and a caller signal that aborts — asserted served
 * (a real socket on port 0) and through `router.fetch()`, side by side.
 *
 * ```bash
 * bun 02-routing/fetch-aborts.ts
 * ```
 *
 * - `req.signal` is the signal to read to learn that the client left. Served,
 *   it is the native request's own `request.signal`. Under `fetch()` it also
 *   aborts when the caller cancels a streamed body, with the same reason a
 *   served disconnect has: Bun's `AbortError`, "The connection was closed.".
 *   `res`, `req` and `req.socket` then emit `close`, as served.
 * - `req.request.signal` stays the caller's own: under `fetch()` a cancelled
 *   body does not abort it.
 * - A `RequestInit` signal that is aborted already rejects `fetch()` with its
 *   reason, and no handler runs. One that aborts while a handler is pending
 *   rejects the call. A `Request`'s own signal is honoured once the pipeline
 *   waits on a handler or middleware.
 * - Not shown, because it is not so: an abort while only the request body is
 *   being read, or only an adapter's not-found handler is running, takes
 *   effect once that step ends. Cancelling a buffered body leaves `req.signal`
 *   alone, as served. The package README's
 *   [Testing without a socket](../../../packages/bun-common/README.md#testing-without-a-socket)
 *   lists the differences that remain.
 *
 * Every wait here is on an event, with a deadline, so a signal that never
 * aborts or a call that never settles is a failed check, not a hang.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import { BunHttpAdapter, BunRouter } from "@kingsleyweb/bun-common";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("The caller leaving: req.signal and aborts under fetch()");

/** What `within()` answers when its deadline passes first. */
const TIMED_OUT = "timed out";

/**
 * How long a wait may take before it counts as never happening. Generous: a
 * working run settles in milliseconds, so only a broken one reaches it.
 */
const DEADLINE_MS = 3000;

/** `promise`'s value, or {@link TIMED_OUT} once `ms` pass first. */
async function within<T>(
  promise: Promise<T>,
  ms = DEADLINE_MS,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(resolve, ms, TIMED_OUT);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** What a call's promise settled to: its rejection, or `"resolved"`. */
async function settled(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (error: unknown) => error,
  );
}

/** `reason` as `"name: message"`. */
function describeReason(reason: unknown): string {
  return reason instanceof Error
    ? `${reason.name}: ${reason.message}`
    : String(reason);
}

/** What Bun aborts a served request's signal with when its client leaves. */
const DISCONNECTED = "AbortError: The connection was closed.";

/** What one `/ticks` handler saw of its client. */
interface Seen {
  /** The handler's `req.signal`. */
  signal: AbortSignal;
  /** The native request's own signal, `req.request.signal`. */
  requestSignal: AbortSignal;
  /** Settles on `req.signal`'s `abort` event. */
  aborted: Promise<void>;
  /** Settles on `res` `'close'`. */
  resClosed: Promise<void>;
  /** Settles on `req.socket` `'close'`. */
  socketClosed: Promise<void>;
  /** How many chunks the handler wrote. */
  ticks: number;
}

/** Waiters for the next `/ticks` request to reach its handler. */
const arrivals: ((seen: Seen) => void)[] = [];

/** The next `/ticks` request to reach its handler. */
function nextArrival(): Promise<Seen> {
  return new Promise((resolve) => arrivals.push(resolve));
}

/** Releases each `/hold` handler still waiting. */
const holds: (() => void)[] = [];

/** Settles when the next `/hold` handler starts waiting. */
let holdStarted = Promise.withResolvers<void>();

/** Every interval a `/ticks` handler started, cleared at the end regardless. */
const intervals = new Set<ReturnType<typeof setInterval>>();

/** How many times `/count`'s handler ran. */
let handled = 0;

/** The same app, served and socket-free. */
function build(app: BunRouter): void {
  // A slow stream: a chunk now, then one every 25 ms until the client leaves.
  // It stops on `req.signal`, the idiom this example is about.
  app.get("/ticks", (req: BunRequest, res: BunResponse) => {
    const signal = req.signal;
    const seen: Seen = {
      signal,
      requestSignal: req.request.signal,
      aborted: new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
      resClosed: new Promise((resolve) => res.once("close", () => resolve())),
      socketClosed: new Promise((resolve) =>
        req.socket.once("close", () => resolve()),
      ),
      ticks: 0,
    };
    // A stream the client leaves reports the disconnect as a stream error too.
    res.on("error", () => {});
    const tick = () => res.write(`tick ${seen.ticks++}\n`);
    tick();
    const interval = setInterval(tick, 25);
    intervals.add(interval);
    signal.addEventListener("abort", () => clearInterval(interval), {
      once: true,
    });
    arrivals.shift()?.(seen);
  });
  app.get("/count", (_req, res) => {
    handled++;
    res.send(`handled ${handled}`);
  });
  // Waits until the example releases it, reading nothing of its client.
  app.get("/hold", async (_req, res) => {
    const held = Promise.withResolvers<void>();
    holds.push(held.resolve);
    holdStarted.resolve();
    await held.promise;
    void res.status(204).end();
  });
}

const served = new BunHttpAdapter();
build(served.instance);
const server = await served.listen(0);
const origin = `http://127.0.0.1:${server.port}`;

const router = new BunRouter();
build(router);

/** How a check reaches the app. */
type Client = (path: string, init?: RequestInit) => Promise<Response>;

/** Served first, as the reference, then socket-free. */
const clients: [name: string, client: Client][] = [
  ["served", (path, init) => fetch(`${origin}${path}`, init)],
  ["router.fetch()", (path, init) => router.fetch(path, init)],
];

/* ------------------------------------------------------------------ */
step("A client leaving a slow stream aborts req.signal and closes res");

for (const [name, client] of clients) {
  for (const leaving of ["cancels the body", "aborts its fetch"] as const) {
    const label = `${name}, the client ${leaving}`;
    const controller = new AbortController();
    const arrival = nextArrival();
    const response = await client("/ticks", { signal: controller.signal });
    const seen = await within(arrival);
    if (seen === TIMED_OUT) {
      check(`${label}: the handler ran`, false, TIMED_OUT);
      continue;
    }
    const reader = response.body!.getReader();
    const firstChunk = (await reader.read()).value as Uint8Array;
    const first = new TextDecoder().decode(firstChunk);
    show(`${label}: first read`, JSON.stringify(first));

    let readOutcome: unknown = "not read";
    const reason = new Error("left mid-stream");
    if (leaving === "cancels the body") {
      await reader.cancel();
    } else {
      const reading = reader.read();
      controller.abort(reason);
      readOutcome = await within(settled(reading));
    }

    const aborted = await within(seen.aborted);
    const resClosed = await within(seen.resClosed);
    const socketClosed = await within(seen.socketClosed);
    show(`${label}: chunks written before it stopped`, seen.ticks);
    checkEqual(
      `${label}: req.signal aborted with Bun's disconnect reason`,
      aborted === TIMED_OUT ? TIMED_OUT : describeReason(seen.signal.reason),
      DISCONNECTED,
    );
    checkEqual(`${label}: res emitted 'close'`, resClosed, undefined);
    checkEqual(`${label}: req.socket emitted 'close'`, socketClosed, undefined);
    if (leaving === "aborts its fetch") {
      check(
        `${label}: the read in progress rejected with the caller's reason`,
        readOutcome === reason,
        describeReason(readOutcome),
      );
    }
  }
}

/* ------------------------------------------------------------------ */
step("req.request.signal is the caller's own; req.signal is the one to read");

{
  const request = new Request("http://localhost/ticks");
  const arrival = nextArrival();
  const response = await router.fetch(request);
  const seen = await within(arrival);
  if (seen === TIMED_OUT) {
    check("router.fetch(Request): the handler ran", false, TIMED_OUT);
  } else {
    check(
      "router.fetch(Request): req.request.signal is the caller's Request's signal",
      seen.requestSignal === request.signal,
    );
    check(
      "router.fetch(Request): req.signal is not that signal",
      seen.signal !== request.signal,
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    const aborted = await within(seen.aborted);
    checkEqual(
      "router.fetch(Request), body cancelled: req.signal aborted",
      aborted === TIMED_OUT ? TIMED_OUT : describeReason(seen.signal.reason),
      DISCONNECTED,
    );
    checkEqual(
      "router.fetch(Request), body cancelled: the caller's own signal did not abort",
      seen.requestSignal.aborted,
      false,
    );
  }
}

{
  // Served there is one signal: the native request's.
  const arrival = nextArrival();
  const response = await fetch(`${origin}/ticks`);
  const seen = await within(arrival);
  if (seen === TIMED_OUT) {
    check("served: the handler ran", false, TIMED_OUT);
  } else {
    check(
      "served: req.signal is req.request.signal",
      seen.signal === seen.requestSignal,
    );
    await response.body!.cancel();
    await within(seen.aborted);
  }
}

/* ------------------------------------------------------------------ */
step("A RequestInit signal aborted already: rejected, and nothing runs");

for (const [name, client] of clients) {
  const before = handled;
  const reason = new Error("left before asking");
  const outcome = await within(
    settled(client("/count", { signal: AbortSignal.abort(reason) })),
  );
  check(
    `${name}: rejected with the signal's own reason`,
    outcome === reason,
    describeReason(outcome),
  );
  checkEqual(`${name}: the handler never ran`, handled - before, 0);
}
// The control for the counter: an ordinary call does reach the handler.
const counted = handled;
await (await router.fetch("/count")).text();
checkEqual(
  "router.fetch() with no signal: the handler ran",
  handled,
  counted + 1,
);

/* ------------------------------------------------------------------ */
step("An abort while the handler is pending rejects the call");

/** Each way of passing a signal: a `RequestInit`, or a `Request`'s own. */
const pendingClients: [
  name: string,
  call: (signal: AbortSignal) => Promise<Response>,
][] = [
  ["served", (signal) => fetch(`${origin}/hold`, { signal })],
  [
    "router.fetch(path, { signal })",
    (signal) => router.fetch("/hold", { signal }),
  ],
  [
    "router.fetch(new Request(url, { signal }))",
    (signal) => router.fetch(new Request("http://localhost/hold", { signal })),
  ],
];

for (const [name, call] of pendingClients) {
  holdStarted = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new Error("left while waiting");
  const pending = settled(call(controller.signal));
  const started = await within(holdStarted.promise);
  checkEqual(`${name}: the handler started waiting`, started, undefined);
  controller.abort(reason);
  const outcome = await within(pending);
  check(
    `${name}: rejected with the abort's reason`,
    outcome === reason,
    outcome === TIMED_OUT
      ? `still pending after ${DEADLINE_MS}ms`
      : describeReason(outcome),
  );
  for (const release of holds.splice(0)) {
    release();
  }
}

/* ------------------------------------------------------------------ */
for (const interval of intervals) {
  clearInterval(interval);
}
for (const release of holds.splice(0)) {
  release();
}
await served.close();

summary();
