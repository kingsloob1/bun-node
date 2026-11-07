/**
 * Server-sent events, typed on both ends — the server's `res.sse()` writer
 * (ids, resume via `Last-Event-ID`, `retry`, heartbeat) and the client's
 * `sse()` from `@kingsleyweb/bun-client/sse`, including a resume after a
 * connection the server dropped. Each behaviour is asserted.
 *
 * ```bash
 * bun 14-typed-client/sse.ts
 * ```
 *
 * - **One declaration**: `sse({ progress, done, gap: null })` (browser-safe,
 *   from `@kingsleyweb/bun-common/sse`) types the writer's `send()` and checks
 *   each event before it is encoded. The client's route map names the same
 *   events under `events`; `bun-client generate` writes that from the
 *   document's `x-sse-events`, here it is written by hand.
 * - **Ids and resume**: every event carries an `id:`. A client that reconnects
 *   sends the last one it saw as `Last-Event-ID`; the writer's `resume`
 *   callback answers with the events it missed, or `"gap"` when it cannot.
 * - **`retry:`** tells the client how long to wait before reconnecting, and
 *   the **heartbeat** is a comment line sent when nothing else was written.
 * - **The client goes through `fetch`**, never `EventSource` (which Bun does
 *   not have and which sends no headers): its base URL and auth apply, and
 *   the reconnection and `Last-Event-ID` are the stream's own.
 */
import type { SseWriter } from "@kingsleyweb/bun-common/sse";
import { createClient } from "@kingsleyweb/bun-client";
import { sse as openStream } from "@kingsleyweb/bun-client/sse";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { sse } from "@kingsleyweb/bun-common/sse";
import { z } from "zod";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

/** The client's route map: the stream's params and events, by name. */
interface Routes {
  "GET /jobs/:id/events": {
    params: { id: string };
    responses: { 200: undefined };
    stream: "sse";
    events: {
      progress: { percent: number };
      done: { result: string };
      gap: undefined;
    };
  };
  "GET /health": { responses: { 200: { ok: boolean } } };
}

title("Server-sent events: res.sse() and the typed sse() client");

/* ------------------------------------------------------------------ */
step("The server: a declaration, a log to resume from, a writer");

/** The route's events, declared once. `gap: null` is an event with no data. */
const JobEvents = sse({
  progress: z.object({ percent: z.number() }),
  done: z.object({ result: z.string() }),
  gap: null,
});

/** One event in the job's log. */
interface Logged {
  id: string;
  event: "progress" | "done";
  data: { percent: number } | { result: string };
}

/** Everything the job has emitted, in order: what a resume replays from. */
const log: Logged[] = [];
/** The streams open now. */
const open = new Set<SseWriter<typeof JobEvents>>();
/** The `Last-Event-ID` of each connection, `null` for a fresh one. */
const connections: (string | null)[] = [];

/** Emits to the log and to everyone connected. */
function emit(event: Omit<Logged, "id">): void {
  const logged = { id: String(log.length + 1), ...event };
  log.push(logged);
  for (const stream of open) void stream.send(logged as never);
}

const adapter = new BunHttpAdapter(0, { logger: noopLogger });
adapter.get("/jobs/:id/events", (req, res) => {
  // Read the header first: it names where this connection resumes from.
  const last = req.get("last-event-id") ?? null;
  connections.push(last);
  const stream = res.sse({
    contract: JobEvents, // send() is typed and checked by it
    retry: 50, // the client's reconnection delay, ms
    heartbeatMs: 40,
    // Called only when the request has a Last-Event-ID: what came after it,
    // or "gap" when the log does not hold it. Live sends wait behind it.
    resume: (lastEventId) => {
      const from = log.findIndex((each) => each.id === lastEventId);
      return from === -1 ? "gap" : (log.slice(from + 1) as never);
    },
  });
  open.add(stream);
  stream.onClose(() => void open.delete(stream));
});
const server = await adapter.listen(0);

try {
  /* ---------------------------------------------------------------- */
  step("What is on the wire: ids, retry, a comment, a heartbeat");

  const raw = await fetch(`http://127.0.0.1:${server.port}/jobs/raw/events`);
  check(
    "the content type is text/event-stream",
    raw.headers.get("content-type")?.startsWith("text/event-stream") === true,
  );
  await waitFor("the raw reader to connect", () => open.size === 1);
  emit({ event: "progress", data: { percent: 10 } });
  let wire = "";
  const reader = (raw.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  // Read until the event has arrived and, nothing else being written, a heartbeat after it.
  while (!/event: progress[\s\S]*\n:\n/.test(wire)) {
    const { value, done } = await reader.read();
    if (done) break;
    wire += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  show("bytes", wire);
  check("an opening comment", wire.startsWith(": ok"), wire);
  check(
    "retry: 50 told the client its delay",
    wire.includes("retry: 50"),
    wire,
  );
  check(
    "the event has an id and a name",
    wire.includes("id: 1\nevent: progress") ||
      wire.includes("event: progress\nid: 1"),
    wire,
  );
  check(
    "a heartbeat comment arrived while idle",
    /event: progress[\s\S]*\n:\n/.test(wire),
    wire,
  );
  log.length = 0;
  connections.length = 0;
  await waitFor("the raw stream to close", () => open.size === 0);

  /* ---------------------------------------------------------------- */
  step("The typed client, and a resume after a dropped connection");

  const api = createClient<Routes>({
    baseUrl: `http://127.0.0.1:${server.port}`,
  });
  const stream = openStream(api, "GET /jobs/:id/events", {
    params: { id: "7" },
  });

  const heard: string[] = [];
  const reading = (async () => {
    for await (const e of stream) {
      // `e.event` narrows `e.data`: progress has a percent, done a result.
      if (e.event === "progress") heard.push(`progress:${e.data.percent}`);
      else if (e.event === "done") {
        heard.push(`done:${e.data.result}`);
        break; // break closes the stream
      }
    }
  })();

  await waitFor("the client to connect", () => open.size === 1);
  emit({ event: "progress", data: { percent: 25 } });
  emit({ event: "progress", data: { percent: 50 } });
  await waitFor("two events to arrive", () => heard.length === 2);
  checkEqual("lastEventId is the last id committed", stream.lastEventId, "2");

  // The server drops the connection (a deploy, a proxy). The client was not told to stop.
  for (const writer of open) writer.close();
  await waitFor("the server to see the drop", () => open.size === 0);
  // While nobody is connected, the job moves on.
  emit({ event: "progress", data: { percent: 75 } });
  emit({ event: "done", data: { result: "ok" } });

  await reading;
  show("heard", heard);
  show("each connection's Last-Event-ID", connections);
  checkEqual("every event, once, in order, across the drop", heard, [
    "progress:25",
    "progress:50",
    "progress:75",
    "done:ok",
  ]);
  checkEqual("the reconnection sent Last-Event-ID: 2", connections, [
    null,
    "2",
  ]);
  checkEqual("lastEventId followed the replay", stream.lastEventId, "4");

  /* ---------------------------------------------------------------- */
  step("An id the server cannot resume from: the declared gap");

  const gaps: string[] = [];
  const lost = openStream(api, "GET /jobs/:id/events", {
    params: { id: "7" },
    lastEventId: "999", // an id this server never issued
  });
  lost.on("$gap", () => void gaps.push("gap"));
  await waitFor("the gap", () => gaps.length === 1);
  checkEqual("the client was told to refetch", gaps, ["gap"]);
  lost.close();
  await lost.closed;

  /* ---------------------------------------------------------------- */
  step("The type-level half");

  const refused = async (): Promise<void> => {
    // @ts-expect-error -- `id` is a string param
    openStream(api, "GET /jobs/:id/events", { params: { id: 7 } });
    // @ts-expect-error -- a plain route is not an event stream
    openStream(api, "GET /health", {});
    // @ts-expect-error -- "finished" is not one of the route's events
    stream.on("finished", () => undefined);
    for await (const e of stream) {
      // @ts-expect-error -- a `progress` event has `percent`, not `result`
      if (e.event === "progress") void e.data.result;
    }
    const [writer] = open;
    // @ts-expect-error -- `send()` is typed by the declaration: percent is a number
    void writer?.send({ event: "progress", data: { percent: "50" } });
  };
  void refused;
  show("five refusals at compile time (see the source)");
} finally {
  await adapter.close();
}

summary();
