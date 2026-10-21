/**
 * Shutting down — `close()` drains: the requests in flight finish, capped by
 * the adapter's `closeDrainTimeout` option, before the server is stopped.
 *
 * ```bash
 * bun 03-http-adapter/shutdown.ts
 * ```
 *
 * Worth knowing:
 *
 * - `close()` runs in three steps: `server.stop(false)`, so the server
 *   accepts no new connections and closes its idle keep-alive ones; a wait
 *   until no request is in flight, for at most `closeDrainTimeout`
 *   milliseconds (10 s by default); then `server.stop(true)`, always, which
 *   cuts whatever is still open. Nothing of the old server answers on its
 *   port once `close()` resolves.
 * - `closeDrainTimeout: 0` skips the wait: requests in flight are cut at once,
 *   as `close()` did before the drain. A negative, non-finite or non-number
 *   value throws a `RangeError` when the adapter is built, not on the first
 *   `close()`.
 * - A streamed response (`res.write()`, server-sent events, any streamed
 *   body) is in flight until it ends. A stream that never ends therefore
 *   holds `close()` for the whole cap, then is cut: end your streams when
 *   shutting down, or lower the cap.
 * - WebSockets are not requests and are not waited for; the final
 *   `stop(true)` closes them.
 * - A server you stop yourself drains the same way with the exported
 *   `drainAndStop(server, ms)`, its cap checked by
 *   `validateCloseDrainTimeout(ms)`, which gives the 10 s default for
 *   `undefined`.
 * - `bun-nest`'s adapter drains the same way (its `02-http-adapter/shutdown.ts`
 *   and `10-options/http-adapter-options.ts`).
 * - The checks measure no duration tightly. The slow request finishes on its
 *   own; the endless stream's `close()` must take at least the 300 ms cap
 *   (load can only lengthen it) and under 5 s, half the 10 s default an
 *   ignored option would wait; the WebSocket's `close()` under 5 s too.
 */
import type { BunResponse } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  drainAndStop,
  noopLogger,
  validateCloseDrainTimeout,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { connect } from "../09-websocket/helpers/client";

/** A promise with its opener, for holding a handler until the script says. */
function gate(): { promise: Promise<void>; open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

/** A request's outcome: its status and body, or that the connection failed. */
function outcome(request: Promise<Response>): Promise<string> {
  return request.then(
    async (response) => `${response.status} ${await response.text()}`,
    () => "failed",
  );
}

/**
 * `work`, or a rejection once `ms` have passed: so a `close()` that hangs
 * reads as a failed check, not a run that never ends. The timer is cleared
 * either way.
 */
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`hung for ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, hung]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a streamed body to its end, collecting the text. A stream cut by the
 * server errors rather than ending; that is reported as `cut`.
 */
async function readAll(
  reader: {
    /** The next chunk, as a stream reader's `read()` resolves it. */
    read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  },
  into: string[],
): Promise<"ended" | "cut"> {
  const decoder = new TextDecoder();
  try {
    for (let chunk = await reader.read(); !chunk.done;) {
      into.push(decoder.decode(chunk.value));
      chunk = await reader.read();
    }
    return "ended";
  } catch {
    return "cut";
  }
}

/** Starts an SSE response: the headers, then one `data:` event. */
function openEvents(res: BunResponse, first: string): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.write(`data: ${first}\n\n`);
}

/** The cap the endless stream is cut at, in milliseconds. */
const SHORT_CAP = 300;

/** Room for a broken `close()` to resolve early, before it is looked at. */
const SETTLE_MS = 200;

title("Shutting down: close() drains");

/* ------------------------------------------------------------------ */
step("A slow request (about 1 s) finishes during close()");
{
  const adapter = new BunHttpAdapter(0, { logger: noopLogger });
  const entered = gate();
  /** Whether `close()` had resolved when the handler finished its work. */
  let closedBeforeAnswer: boolean | undefined;
  let closed = false;

  adapter.get("/slow", async (_req, res) => {
    entered.open();
    await Bun.sleep(1000);
    closedBeforeAnswer = closed;
    res.send("slow done");
  });
  await adapter.listen(0);
  const url = adapter.url;

  const slow = outcome(fetch(`${url}/slow`));
  await entered.promise;
  show("GET /slow is in flight; close() begins");
  const closing = adapter.close().then(() => {
    closed = true;
  });

  await Bun.sleep(SETTLE_MS);
  check("close() is still waiting while the request runs", !closed);
  await checkRejects("…and the server takes no new connection meanwhile", () =>
    fetch(`${url}/slow`, { headers: { connection: "close" } }),
  );

  await within(15_000, closing);
  checkEqual(
    "the client receives the whole response, and close() resolved only after the handler answered",
    { slow: await slow, closedBeforeAnswer },
    { slow: "200 slow done", closedBeforeAnswer: false },
  );
  await checkRejects("after close(), the old address refuses", () =>
    fetch(url),
  );
}

/* ------------------------------------------------------------------ */
step("closeDrainTimeout: 0 cuts the request in flight at once");
{
  const adapter = new BunHttpAdapter(0, {
    logger: noopLogger,
    closeDrainTimeout: 0,
  });
  const entered = gate();
  const release = gate();
  adapter.get("/hang", async (_req, res) => {
    entered.open();
    await release.promise;
    res.send("answered");
  });
  await adapter.listen(0);

  const hanging = outcome(fetch(`${adapter.url}/hang`));
  await entered.promise;
  // `/hang` is released only after close(): with no drain nothing waits.
  const closed = await within(5000, adapter.close()).then(
    () => "resolved",
    (error: unknown) => String(error),
  );
  checkEqual(
    "close() resolves with the request still running; the client's connection is cut",
    { closed, request: await hanging },
    { closed: "resolved", request: "failed" },
  );
  release.open();
}

/* ------------------------------------------------------------------ */
step(`An endless SSE stream holds close() for the cap (${SHORT_CAP} ms)`);
{
  const adapter = new BunHttpAdapter(0, {
    logger: noopLogger,
    closeDrainTimeout: SHORT_CAP,
  });
  let serverSawClose = false;
  adapter.get("/events", (_req, res) => {
    openEvents(res, "open");
    const timer = setInterval(() => res.write("data: tick\n\n"), 20);
    res.on("close", () => {
      clearInterval(timer);
      serverSawClose = true;
    });
  });
  await adapter.listen(0);

  const events = await fetch(`${adapter.url}/events`);
  // Held in a binding until the end: an unreferenced response can be
  // garbage-collected, and Bun then aborts its fetch.
  const reader = events.body!.getReader();
  const received: string[] = [];
  const first = await reader.read();
  received.push(
    new TextDecoder().decode(first.value as Uint8Array | undefined),
  );
  const reading = readAll(reader, received);

  const started = performance.now();
  await within(15_000, adapter.close());
  const took = performance.now() - started;
  show(`close() took ${took.toFixed(0)} ms`);
  check(
    `close() waits for the stream for the cap, at least ${SHORT_CAP} ms less the timer's slack`,
    took >= SHORT_CAP - 50,
    { took },
  );
  check("…and then cuts it, well before the 10 s default", took < 5000, {
    took,
  });
  const how = await within(5000, reading).catch(() => "still open");
  show(
    `the client read ${received.join("").split("\n\n").length - 1} events, then the stream ${how}`,
  );
  check(
    "the stream flowed during the drain: the client read more than the first event",
    received.join("").split("\n\n").length - 1 > 1,
    received,
  );
  checkEqual(
    "the client's stream is over, and the server saw the response close",
    { over: how !== "still open", serverSawClose },
    { over: true, serverSawClose: true },
  );
}

/* ------------------------------------------------------------------ */
step("A stream that ends during close() is delivered whole");
{
  // The default cap. On shutdown the app tells its streams to finish (here
  // by hand, after close() began); each ends with a last event.
  const adapter = new BunHttpAdapter(0, { logger: noopLogger });
  const open = new Set<BunResponse>();
  adapter.get("/events", (_req, res) => {
    openEvents(res, "hello");
    open.add(res);
  });
  await adapter.listen(0);

  const events = await fetch(`${adapter.url}/events`);
  const reader = events.body!.getReader();
  const received: string[] = [];
  const reading = readAll(reader, received);
  while (open.size === 0) {
    await Bun.sleep(5);
  }

  let closed = false;
  const started = performance.now();
  const closing = adapter.close().then(() => {
    closed = true;
  });
  await Bun.sleep(SETTLE_MS);
  check("close() waits while the stream is open", !closed);

  for (const res of open) {
    res.write("data: bye\n\n");
    await res.end();
  }
  await within(15_000, closing);
  const took = performance.now() - started;
  checkEqual(
    "the client reads every event, to the stream's own end",
    {
      how: await within(5000, reading).catch(() => "still open"),
      body: received.join(""),
    },
    { how: "ended", body: "data: hello\n\ndata: bye\n\n" },
  );
  check(
    "close() resolved once the stream ended, not at the 10 s cap",
    took < 5000,
    { took },
  );
}

/* ------------------------------------------------------------------ */
step("An open WebSocket does not hold close()");
{
  // The default 10 s cap: a close() that waited for the socket would show.
  const adapter = new BunHttpAdapter(0, { logger: noopLogger });
  adapter.ws("/echo", {
    message(ws, message) {
      ws.sendText(`echo: ${String(message)}`);
    },
  });
  await adapter.listen(0);

  const client = await connect(`${adapter.url.replace("http", "ws")}/echo`);
  client.socket.send("hi");
  await client.waitForText("the echo", (text) => text === "echo: hi");
  checkEqual(
    "the socket is open, and not counted as a request",
    [
      adapter.getBunServer()!.pendingWebSockets,
      adapter.getBunServer()!.pendingRequests,
    ],
    [1, 0],
  );

  const closed = await within(5000, adapter.close()).then(
    () => "resolved",
    (error: unknown) => String(error),
  );
  checkEqual("close() resolves well inside the cap", closed, "resolved");
  const how = await client.waitClosed({ timeout: 5000 }).then(
    () => "closed",
    () => "still open",
  );
  checkEqual("…and the final stop closes the socket", how, "closed");
}

/* ------------------------------------------------------------------ */
step("drainAndStop(): the same drain, for a server you stop yourself");
{
  // A plain Bun.serve, no adapter: validateCloseDrainTimeout() checks the
  // option as the adapters do, and drainAndStop() runs their three steps.
  checkEqual(
    "validateCloseDrainTimeout(undefined) is the 10 s default; a number is kept",
    [validateCloseDrainTimeout(undefined), validateCloseDrainTimeout(250)],
    [10_000, 250],
  );
  await checkRejects(
    "…and a bad value is the adapters' RangeError",
    () => validateCloseDrainTimeout(-1),
    { name: "RangeError", message: /closeDrainTimeout must be/ },
  );

  const entered = gate();
  const server = Bun.serve({
    port: 0,
    async fetch() {
      entered.open();
      await Bun.sleep(500);
      return new Response("own server done");
    },
  });
  const url = server.url.href;
  const slow = outcome(fetch(url));
  await entered.promise;
  check("one request is in flight", server.pendingRequests === 1, {
    pending: server.pendingRequests,
  });

  await within(
    15_000,
    drainAndStop(server, validateCloseDrainTimeout(undefined)),
  );
  checkEqual(
    "drainAndStop() resolved after the request finished, and the client got it",
    await slow,
    "200 own server done",
  );
  await checkRejects("after drainAndStop(), the old address refuses", () =>
    fetch(url),
  );
}

/* ------------------------------------------------------------------ */
step("A bad closeDrainTimeout is a RangeError at construction");
for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "100"]) {
  await checkRejects(
    `closeDrainTimeout: ${typeof bad === "string" ? `"${bad}"` : String(bad)} throws`,
    () => new BunHttpAdapter(0, { closeDrainTimeout: bad as number }),
    { name: "RangeError", message: /closeDrainTimeout must be/ },
  );
}
check(
  "0 and a finite number of milliseconds are accepted",
  [0, SHORT_CAP, 10_000].every(
    (ms) =>
      new BunHttpAdapter(0, { closeDrainTimeout: ms }) instanceof
      BunHttpAdapter,
  ),
);

summary();
