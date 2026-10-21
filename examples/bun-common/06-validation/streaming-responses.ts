/**
 * Checking streamed responses against their contract: `chunks()`, `sse()`
 * and `opaque()` in `validate()`'s `responses`, each asserted, through
 * `router.fetch()` and over a real socket.
 *
 * ```bash
 * bun 06-validation/streaming-responses.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - A `content` map's value can say how a body is read.
 *   `chunks(schema, { framing })` checks each chunk as it streams (`"raw"`,
 *   the default) or each NDJSON line (`"ndjson"`, lines split across chunks).
 *   `sse(events, { data })` checks each server-sent event, choosing the
 *   schema by the event's name (`message` when it has none); an undeclared
 *   name is a mismatch. `opaque()` declares a media type whose body is
 *   never read, and `200: opaque("image/png")` is shorthand for
 *   `200: { content: { "image/png": opaque() } }`. A media type mapped to
 *   `null` allows that type with an empty body only.
 * - Under `"error"`, **before the body has started a mismatch is a clean
 *   500**: a `write()` stream's opening is checked with its first chunk.
 *   **After it has started, a mismatch can only cut the stream off**: the bad
 *   chunk is not sent, the stream is destroyed (or errored, when piped), and
 *   the issues are logged at `error`. A client of `router.fetch()` reads a
 *   `ResponseValidationError` from the body; a client over a socket sees the
 *   connection drop mid-body. Bun's server also prints that error, with a
 *   source frame, to stderr for each cut over a socket: the
 *   `ResponseValidationError` traces in the output are expected (they carry
 *   the issues, never the value).
 * - **A piped stream whose first chunk fails** is cut before Bun has written
 *   the headers: a socket client gets no response at all, not even a 500.
 * - `"warn"` sends everything and logs a stream's first mismatch, once per
 *   stream.
 * - **A stream is never buffered.** Against a whole-body schema its body is
 *   skipped, with one warning per route (its status, headers and media type
 *   are still checked); `sendFile()`'s bytes, though, are read under one.
 *
 * Streams are timing-sensitive, so nothing here asserts on a duration. Each
 * read has a deadline, so a hang fails its check instead of stalling the
 * run, and where a socket client must see the good part of a stream before
 * the bad part is written, the route waits for the client to have read it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BunResponse,
  LogEvent,
  RouterErrorMiddlewareHandler,
  StandardSchemaV1,
} from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunRouter,
  chunks,
  createTestLogger,
  describeContract,
  getContract,
  opaque,
  ResponseValidationError,
  sse,
  validate,
} from "@kingsleyweb/bun-common";
import { z } from "zod";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Checking streamed responses against their contract");

/** How long any one read, request or hand-off may take before it counts as a hang. */
const DEADLINE = 5000;

const encoder = new TextEncoder();

/**
 * Settles with `work`, or rejects naming `what` once `ms` have passed, so a
 * stream that never ends fails a check instead of stalling the run.
 */
async function deadline<T>(
  what: string,
  work: Promise<T>,
  ms = DEADLINE,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms} ms: ${what}`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `predicate` holds within `ms`, checked every millisecond. */
async function eventually(
  predicate: () => boolean,
  ms = DEADLINE,
): Promise<boolean> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) return false;
    await Bun.sleep(1);
  }
  return true;
}

/**
 * The hand-off between a route and the client reading it: the route writes
 * the good part of a stream, then waits here until the client has read it,
 * so a socket client has those bytes in hand before the bad part cuts the
 * connection. Without it, Bun can reset a socket before flushing the chunk
 * that passed (plan V3b's note). The route stops waiting at the deadline,
 * so a client that never signals still ends the stream.
 */
let handOff = Promise.withResolvers<void>();

/** Waits, in a route, for the client to have read what it expects. */
async function clientHasRead(): Promise<void> {
  await deadline("the client to read the good part", handOff.promise).catch(
    () => {},
  );
}

/** What a client saw of a response. */
interface Seen {
  /** The status, or `"reset"` when the request failed with no response. */
  status: number | "reset";
  /** The body text read, up to wherever it ended. */
  text: string;
  /** `"done"` for a body that ended cleanly, `"error"` for one cut off, `"timeout"` for a hang. */
  end: "done" | "error" | "timeout";
  /** What the body (or, for `"reset"`, the request) failed with. */
  error?: unknown;
}

/**
 * Reads `response`'s body to its end, with a deadline. Once the text read so
 * far contains `release`, the route waiting in {@link clientHasRead} goes on.
 */
async function drain(response: Response, release?: string): Promise<Seen> {
  if (response.body === null) {
    return { status: response.status, text: "", end: "done" };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const timeout = Date.now() + DEADLINE;
  try {
    for (;;) {
      const left = timeout - Date.now();
      const next = await deadline("the body's next chunk", reader.read(), left);
      if (next.done) return { status: response.status, text, end: "done" };
      text += decoder.decode(next.value, { stream: true });
      if (release !== undefined && text.includes(release)) handOff.resolve();
    }
  } catch (error) {
    const timedOut =
      error instanceof Error && error.message.startsWith("timed out");
    if (timedOut) await reader.cancel().catch(() => {});
    return {
      status: response.status,
      text,
      end: timedOut ? "timeout" : "error",
      error,
    };
  }
}

/** Something a request can be sent through: a router, or a listening adapter by URL. */
interface Target {
  /** Sends `GET path` and resolves the response. */
  fetch: (path: string) => Promise<Response>;
}

/**
 * Sends `GET path` through `target` and reads the whole answer. A request
 * that fails with no response at all (a reset socket, or an error
 * `router.fetch()` rejects with) comes back as status `"reset"`.
 */
async function call(
  target: Target,
  path: string,
  release?: string,
): Promise<Seen> {
  handOff = Promise.withResolvers<void>();
  let response: Response;
  try {
    response = await deadline(`GET ${path}`, target.fetch(path));
  } catch (error) {
    return { status: "reset", text: "", end: "error", error };
  }
  return drain(response, release);
}

/**
 * A listening adapter as a {@link Target}: requests go over a real socket,
 * each on a fresh connection. On a kept-alive one, Bun's `fetch` retries a
 * GET whose connection is reset before any response (measured: the handler
 * runs twice, and the cut is logged twice), which would blur the
 * no-response case below.
 */
function overSocket(adapter: BunHttpAdapter): Target {
  return {
    fetch: async (path) => fetch(`${adapter.url}${path}`, { keepalive: false }),
  };
}

/** `[status, text, end]` of what a client saw, for one comparison. */
function seen(answer: Seen): [number | "reset", string, Seen["end"]] {
  return [answer.status, answer.text, answer.end];
}

/** The issues a cut-off `router.fetch()` body failed with, as `target.path`. */
function cutIssues(answer: Seen): string[] | undefined {
  if (!(answer.error instanceof ResponseValidationError)) return undefined;
  return answer.error.issues.map((issue) =>
    issue.path === "" ? issue.target : `${issue.target}.${issue.path}`,
  );
}

/** The log lines a stream's mismatch wrote at `level`. */
function streamLogs(events: LogEvent[], level: "warn" | "error"): LogEvent[] {
  return events.filter(
    (event) =>
      event.level === level && event.message.startsWith("streamed response"),
  );
}

/** Each logged issue as `target.path`, for the lines `streamLogs` picks. */
function loggedIssues(lines: LogEvent[]): string[][] {
  return lines.map((line) =>
    (line.fields.issues as { target: string; path: string }[]).map((issue) =>
      issue.path === "" ? issue.target : `${issue.target}.${issue.path}`,
    ),
  );
}

/**
 * Renders a `ResponseValidationError` as a JSON 500 with each issue as
 * `target.path` (never the refused value).
 */
const renderRefusal = ((error, _req, res, _next) => {
  if (error instanceof ResponseValidationError) {
    res.status(500).json({
      error: error.name,
      issues: error.issues.map((issue) =>
        issue.path === "" ? issue.target : `${issue.target}.${issue.path}`,
      ),
    });
    return;
  }
  res.status(500).json({ error: String(error) });
}) satisfies RouterErrorMiddlewareHandler;

/**
 * The same response as a bare `BunResponse`: a typed `res` under a
 * `chunks()`/`opaque()`/`null` media type narrows what `send()` takes, and
 * the bad bodies below are sent on purpose, so only the runtime check sees
 * them.
 */
function untyped(res: unknown): BunResponse {
  return res as BunResponse;
}

/** Every adapter started below, closed at the end. */
const servers: BunHttpAdapter[] = [];

/**
 * A router and a listening adapter with the same routes, both under
 * `"error"` and logging into one test sink, so each case can be read
 * through `router.fetch()` and over a socket.
 */
async function bothWays(
  build: (router: BunRouter) => void,
  mode: "warn" | "error" = "error",
): Promise<{ router: BunRouter; socket: Target; events: LogEvent[] }> {
  const { logger, events } = createTestLogger();
  const router = new BunRouter({ logger, responseValidation: mode });
  build(router);
  const adapter = new BunHttpAdapter(0, { logger, responseValidation: mode });
  build(adapter);
  await adapter.listen(0);
  servers.push(adapter);
  return { router, socket: overSocket(adapter), events };
}

/* ------------------------------------------------------------------ */
step('chunks(Row, { framing: "ndjson" }): every line checked as it streams');

/** One NDJSON row. */
const Row = z.object({ id: z.number().int(), name: z.string() });

const rows = await bothWays((router) => {
  router.get(
    "/rows/:which",
    validate(
      {},
      {
        responses: {
          200: {
            content: {
              "application/x-ndjson": chunks(Row, { framing: "ndjson" }),
            },
          },
        },
      },
    ),
    async (req, res) => {
      res.type("application/x-ndjson");
      res.write('{"id":1,"name":"Ada"}\n');
      // One line split across two writes: framed, then checked whole.
      res.write('{"id":2,"na');
      res.write('me":"Grace"}\n');
      if (req.params.which === "bad") {
        await clientHasRead();
        // An id that is not a number: the third line breaks the contract.
        res.write('{"id":"LEAK-3","name":"Edsger"}\n');
      }
      res.write('{"id":4,"name":"Barbara"}\n');
      await res.end();
    },
  );
});

const goodLines = '{"id":1,"name":"Ada"}\n{"id":2,"name":"Grace"}\n';

checkEqual(
  "good lines, one split across two writes: every line arrives, the stream ends cleanly",
  seen(await call(rows.router, "/rows/good")),
  [200, `${goodLines}{"id":4,"name":"Barbara"}\n`, "done"],
);
check("…and nothing was logged", rows.events.length === 0, rows.events);

const cutByFetch = await call(rows.router, "/rows/bad", goodLines);
checkEqual(
  "a bad third line, router.fetch(): status 200, the two good lines, then the body errors",
  seen(cutByFetch),
  [200, goodLines, "error"],
);
checkEqual(
  "…with a ResponseValidationError naming body.id, not the value",
  [
    cutIssues(cutByFetch),
    String((cutByFetch.error as Error | undefined)?.message).includes("LEAK"),
  ],
  [["body.id"], false],
);
const cutLogs = streamLogs(rows.events, "error");
checkEqual(
  "…logged once at error: the stream was cut off, at body.id",
  [cutLogs.map((line) => line.message), loggedIssues(cutLogs)],
  [
    ["streamed response does not match its contract; the stream was cut off"],
    [["body.id"]],
  ],
);
show("the cut-off line's fields", cutLogs[0]?.fields);

rows.events.length = 0;
const cutBySocket = await call(rows.socket, "/rows/bad", goodLines);
checkEqual(
  "the same over a socket: status 200, the two good lines, then the connection drops",
  seen(cutBySocket),
  [200, goodLines, "error"],
);
show("the socket client's error", String(cutBySocket.error));
checkEqual(
  "…the line after the bad one never arrives, and the cut is logged once",
  [
    cutBySocket.text.includes("Barbara"),
    loggedIssues(streamLogs(rows.events, "error")),
  ],
  [false, [["body.id"]]],
);
check(
  "…and no log line carries the bad value",
  !JSON.stringify(rows.events).includes("LEAK"),
  rows.events,
);

/* ------------------------------------------------------------------ */
step("sse({ tick, done: null }): each event checked by its name");

/** A `tick` event's data. */
const Tick = z.object({ n: z.number() });

const events = await bothWays((router) => {
  router.get(
    "/events/:which",
    validate(
      {},
      {
        responses: {
          200: {
            content: { "text/event-stream": sse({ tick: Tick, done: null }) },
          },
        },
      },
    ),
    async (req, res) => {
      res.set("Content-Type", "text/event-stream");
      res.write(": a comment is not an event\n\n");
      res.write('event: tick\ndata: {"n":1}\n\n');
      switch (req.params.which) {
        case "undeclared":
          await clientHasRead();
          // No such event in the contract.
          res.write('event: tock\ndata: {"n":2}\n\n');
          break;
        case "bad-data":
          await clientHasRead();
          res.write('event: tick\ndata: {"n":"LEAK-2"}\n\n');
          break;
        case "unnamed":
          await clientHasRead();
          // No `event:` line: its name is `message`, which is not declared.
          res.write('data: {"n":2}\n\n');
          break;
        default:
          res.write('event: tick\ndata: {"n":2}\n\n');
      }
      res.write("event: done\n\n");
      await res.end();
    },
  );
});

const firstTick =
  ': a comment is not an event\n\nevent: tick\ndata: {"n":1}\n\n';

checkEqual(
  "declared events with good data: all sent, the stream ends cleanly",
  seen(await call(events.router, "/events/good")),
  [200, `${firstTick}event: tick\ndata: {"n":2}\n\nevent: done\n\n`, "done"],
);

/** One `sse()` case read through `router.fetch()`, with its issues and log. */
async function sseCase(which: string) {
  events.events.length = 0;
  const answer = await call(events.router, `/events/${which}`, firstTick);
  const logged = streamLogs(events.events, "error");
  return {
    seen: seen(answer),
    issues: cutIssues(answer),
    messages: logged.map(
      (line) => (line.fields.issues as { message: string }[])[0]?.message ?? "",
    ),
  };
}

checkEqual(
  "an undeclared event name: a mismatch; the stream stops before it",
  await sseCase("undeclared"),
  {
    seen: [200, firstTick, "error"],
    issues: ["body"],
    messages: ["This event is not declared (tick, done)"],
  },
);
checkEqual(
  "an event with no event: line is `message`, also undeclared here",
  (await sseCase("unnamed")).seen,
  [200, firstTick, "error"],
);
const badTick = await sseCase("bad-data");
checkEqual(
  "a declared event with bad data: cut at that event, located at body.tick.data.n",
  [badTick.seen, badTick.issues],
  [[200, firstTick, "error"], ["body.tick.data.n"]],
);
check(
  "…and the done event after it is never sent",
  !badTick.seen[1].includes("event: done"),
  badTick.seen,
);

events.events.length = 0;
checkEqual(
  "over a socket: the first tick, then the connection drops at the undeclared event",
  seen(await call(events.socket, "/events/undeclared", firstTick)),
  [200, firstTick, "error"],
);
check(
  "…logged once at error",
  streamLogs(events.events, "error").length === 1,
  events.events,
);

/** A route sending `data: 123` as a `message` event under `data` decoding `format`. */
function sseData(format: "json" | "text"): BunRouter {
  const router = new BunRouter({
    logger: createTestLogger().logger,
    responseValidation: "error",
  });
  router.get(
    "/count",
    validate(
      {},
      {
        responses: {
          200: {
            content: {
              "text/event-stream": sse(
                { message: z.string() },
                { data: format },
              ),
            },
          },
        },
      },
    ),
    async (_req, res) => {
      res.set("Content-Type", "text/event-stream");
      res.write(": open\n\n");
      res.write("data: 123\n\n");
      await res.end();
    },
  );
  return router;
}

checkEqual(
  'data: "text" hands the schema the string: data 123 passes z.string()',
  (await call(sseData("text"), "/count")).end,
  "done",
);
checkEqual(
  'data: "json" (the default) parses it: the number 123 fails z.string()',
  (await call(sseData("json"), "/count")).end,
  "error",
);

/* ------------------------------------------------------------------ */
step("A write() stream's bad first chunk: still a clean 500");

const opening = await bothWays((router) => {
  router.get(
    "/opening",
    validate(
      {},
      {
        responses: {
          200: {
            content: { "text/plain": chunks(z.string().startsWith("ok")) },
          },
        },
      },
    ),
    async (_req, res) => {
      res.type("text/plain");
      // The first write is the stream's opening: checked before anything goes out.
      res.write("LEAK-first");
      res.write("ok-second");
      await res.end();
    },
  );
  router.use(renderRefusal);
});

/** The expected answer: the error handler's 500, with the issue and no value. */
const cleanRefusal = JSON.stringify({
  error: "ResponseValidationError",
  issues: ["body"],
});

checkEqual(
  "router.fetch(): 500 from the error handler, and nothing of the stream",
  seen(await call(opening.router, "/opening")),
  [500, cleanRefusal, "done"],
);
checkEqual(
  "over a socket: the same clean 500",
  seen(await call(opening.socket, "/opening")),
  [500, cleanRefusal, "done"],
);

/* ------------------------------------------------------------------ */
step("A piped stream's bad first chunk: the connection resets, no response");

const piped = await bothWays((router) => {
  router.get(
    "/piped/:which",
    validate(
      {},
      {
        responses: {
          200: {
            content: { "text/plain": chunks(z.string().startsWith("ok")) },
          },
        },
      },
    ),
    (req, res) => {
      const which = req.params.which;
      res.type("text/plain");
      let pulls = 0;
      res.send(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            pulls++;
            if (pulls === 1) {
              controller.enqueue(
                encoder.encode(which === "bad-first" ? "LEAK-first" : "ok-1"),
              );
            } else if (pulls === 2) {
              if (which === "bad-later") await clientHasRead();
              controller.enqueue(
                encoder.encode(which === "bad-later" ? "LEAK-2" : "ok-2"),
              );
            } else {
              controller.close();
            }
          },
        }),
      );
    },
  );
  router.use(renderRefusal);
});

checkEqual(
  "a good piped stream passes under error",
  seen(await call(piped.socket, "/piped/good")),
  [200, "ok-1ok-2", "done"],
);
piped.events.length = 0;
const reset = await call(piped.socket, "/piped/bad-first");
checkEqual(
  "over a socket: the request fails with no response at all (not even a 500)",
  [reset.status, reset.text],
  ["reset", ""],
);
show("the socket client's error", String(reset.error));
check(
  "…logged at error, without the value",
  (await eventually(() => streamLogs(piped.events, "error").length === 1)) &&
    !JSON.stringify(piped.events).includes("LEAK"),
  piped.events,
);
// router.fetch() hands the Response on as Bun would, so the cut shows on the
// body instead: there is no socket to reset.
const pipedFetch = await call(piped.router, "/piped/bad-first");
checkEqual(
  "through router.fetch(): status 200, an empty body that errors with the ResponseValidationError",
  [...seen(pipedFetch), cutIssues(pipedFetch)],
  [200, "", "error", ["body"]],
);
checkEqual(
  "a piped stream's bad LATER chunk, over a socket: the good chunk, then the cut",
  seen(await call(piped.socket, "/piped/bad-later", "ok-1")),
  [200, "ok-1", "error"],
);

/* ------------------------------------------------------------------ */
step('"warn": everything is sent, one warning per stream');

const lenient = await bothWays((router) => {
  router.get(
    "/noisy",
    validate(
      {},
      {
        responses: {
          200: {
            content: { "text/plain": chunks(z.string().startsWith("ok")) },
          },
        },
      },
    ),
    async (_req, res) => {
      res.type("text/plain");
      for (const part of ["ok1 ", "bad ", "bad ", "ok4 ", "bad"]) {
        res.write(part);
      }
      await res.end();
    },
  );
}, "warn");

checkEqual(
  "three bad chunks: all five chunks are sent, the stream ends cleanly",
  seen(await call(lenient.router, "/noisy")),
  [200, "ok1 bad bad ok4 bad", "done"],
);
checkEqual(
  "…and one warning, not three, with no cut-off logged",
  [
    streamLogs(lenient.events, "warn").map((line) => line.message),
    streamLogs(lenient.events, "error").length,
  ],
  [
    [
      "streamed response does not match its contract (reported once per stream)",
    ],
    0,
  ],
);
await call(lenient.router, "/noisy");
checkEqual(
  "a second stream on the same route gets its own warning",
  streamLogs(lenient.events, "warn").length,
  2,
);

/* ------------------------------------------------------------------ */
step("A whole-body schema against a stream: skipped, one warning per route");

const wholeLog = createTestLogger();
const whole = new BunRouter({
  logger: wholeLog.logger,
  responseValidation: "error",
});
/** How many times the whole-body schema ran: never, for a stream. */
let wholeRuns = 0;
/** A whole-body schema that refuses everything, counting its runs. */
const RefuseAll = z.string().refine(() => {
  wholeRuns++;
  return false;
});
for (const path of ["/a", "/b"]) {
  whole.get(
    path,
    validate(
      {},
      { responses: { 200: { content: { "text/plain": RefuseAll } } } },
    ),
    (_req, res) => {
      res.type("text/plain");
      // The typed `res` takes only a string here (the schema's input), so a
      // stream is a type error: this case is reached by a helper taking a
      // bare `BunResponse`, as a shared streaming helper would.
      untyped(res).send(
        (async function* () {
          yield "streamed ";
          await Bun.sleep(1);
          yield "whole";
        })(),
      );
    },
  );
}

/** The Q-H4 warnings logged so far. */
function unread(): LogEvent[] {
  return wholeLog.events.filter((event) =>
    event.message.includes("is not checked against a whole-body schema"),
  );
}

const wholeAnswers = [
  await call(whole, "/a"),
  await call(whole, "/a"),
  await call(whole, "/b"),
].map(seen);
checkEqual(
  "/a, /a, /b: each sent whole under error, though the schema refuses everything",
  wholeAnswers,
  [
    [200, "streamed whole", "done"],
    [200, "streamed whole", "done"],
    [200, "streamed whole", "done"],
  ],
);
checkEqual(
  "…one warning per route, naming it: /a once, /b once",
  unread().map((event) => [event.level, event.fields.route]),
  [
    ["warn", "/a"],
    ["warn", "/b"],
  ],
);
show("the warning", unread()[0]?.message);
check(
  "…which says what to declare instead: chunks() or sse()",
  unread().every((event) =>
    event.message.includes("declare chunks() or sse()"),
  ),
  unread(),
);
checkEqual("…and the schema never ran", wholeRuns, 0);

/* ------------------------------------------------------------------ */
step("sendFile() under a whole-body schema: its bytes are read and checked");

const dir = mkdtempSync(join(tmpdir(), "bun-common-v3b-example-"));
const goodFile = join(dir, "good.txt");
const badFile = join(dir, "bad.txt");
writeFileSync(goodFile, "ok: the file's contents");
writeFileSync(badFile, "LEAK: not what the contract says");

try {
  const files = new BunRouter({
    logger: createTestLogger().logger,
    responseValidation: "error",
  });
  /** A file is sent as text/plain under `spec`. */
  const fileRoute = (path: string, body: StandardSchemaV1) =>
    files.get(
      `${path}/:name`,
      validate({}, { responses: { 200: { content: { "text/plain": body } } } }),
      async (req, res) =>
        res.sendFile(req.params.name === "bad" ? badFile : goodFile, {
          headers: { "Content-Type": "text/plain" },
        }),
    );
  fileRoute("/checked", z.string().startsWith("ok"));
  fileRoute("/opaque", opaque());
  files.get(
    "/range",
    validate(
      {},
      {
        responses: {
          206: { content: { "text/plain": z.string().startsWith("ok") } },
        },
      },
    ),
    async (_req, res) =>
      res.sendFile(goodFile, { headers: { "Content-Type": "text/plain" } }),
  );
  files.use(renderRefusal);

  checkEqual(
    "a file that matches: sent",
    seen(await call(files, "/checked/good")),
    [200, "ok: the file's contents", "done"],
  );
  checkEqual(
    "a file that does not: refused with a clean 500 before any byte of it",
    seen(await call(files, "/checked/bad")),
    [500, cleanRefusal, "done"],
  );
  checkEqual(
    "the same bad file under opaque(): not read, so sent",
    seen(await call(files, "/opaque/bad")),
    [200, "LEAK: not what the contract says", "done"],
  );

  /** `GET /range` with a `Range` header: the 206 slice is what is checked. */
  async function range(bytes: string): Promise<[number, string]> {
    const response = await deadline(
      "GET /range",
      files.fetch({ url: "/range", headers: { range: `bytes=${bytes}` } }),
    );
    return [response.status, await response.text()];
  }
  checkEqual(
    "a 206 range: checked on the bytes it sends (0-1 is `ok`, 4-6 is not)",
    [await range("0-1"), (await range("4-6"))[0]],
    [[206, "ok"], 500],
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
step("opaque() and opaque(mediaType): the same contract, the body never read");

/** A PNG's first four bytes. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** Counts the reads of a Blob's bytes: opaque() never reads them. */
let blobReads = 0;

/** A PNG Blob whose `arrayBuffer()` is counted. */
function countedBlob(): Blob {
  const blob = new Blob([PNG], { type: "image/png" });
  const read = blob.arrayBuffer.bind(blob);
  blob.arrayBuffer = async () => {
    blobReads++;
    return read();
  };
  return blob;
}

/** Bytes that are not a PNG at all, streamed. */
function notAPng(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("LEAK: plainly not a PNG"));
      controller.close();
    },
  });
}

/** A chunk check that only a PNG's bytes would pass. */
const PngChunk = z.custom<Uint8Array>(
  (value) =>
    value instanceof Uint8Array && PNG.every((byte, at) => value[at] === byte),
);

const images = new BunRouter({
  logger: createTestLogger().logger,
  responseValidation: "error",
});
const specs = {
  keyed: { content: { "image/png": opaque() } },
  shorthand: opaque("image/png"),
  // Negative control: a bare opaque() at status level is an application/json body.
  bare: opaque(),
  // Controls: the same bodies checked, chunk by chunk and whole.
  chunked: { content: { "image/png": chunks(PngChunk) } },
  whole: {
    content: { "image/png": z.instanceof(Uint8Array).refine(() => false) },
  },
} as const;
for (const [name, spec] of Object.entries(specs)) {
  images.get(
    `/${name}/:body`,
    validate({}, { responses: { 200: spec } }),
    (req, res) => {
      const body = req.params.body;
      untyped(res).type(body === "text" ? "text/plain" : "image/png");
      untyped(res).send(
        body === "blob"
          ? countedBlob()
          : body === "stream"
            ? notAPng()
            : body === "text"
              ? "LEAK"
              : PNG,
      );
    },
  );
}
images.use(renderRefusal);

/** The status and end of each body kind on `/<spec>/<body>`. */
async function imageAnswers(spec: string): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  for (const body of ["png", "blob", "stream", "text"]) {
    const answer = await call(images, `/${spec}/${body}`);
    answers[body] = `${String(answer.status)} ${answer.end}`;
  }
  return answers;
}

const keyedAnswers = await imageAnswers("keyed");
checkEqual(
  'content: { "image/png": opaque() }: any PNG-typed body passes, unread; text/plain is refused',
  keyedAnswers,
  {
    png: "200 done",
    blob: "200 done",
    stream: "200 done",
    text: "500 done",
  },
);
checkEqual(
  '200: opaque("image/png") answers exactly the same',
  await imageAnswers("shorthand"),
  keyedAnswers,
);
checkEqual("…and neither read the Blob", blobReads, 0);
checkEqual(
  "control: the not-a-PNG stream under chunks() is cut off at its only chunk",
  seen(await call(images, "/chunked/stream")),
  [200, "", "error"],
);
checkEqual(
  "control: under a whole-body schema the Blob is read (and refused)",
  [(await call(images, "/whole/blob")).status, blobReads],
  [500, 1],
);
checkEqual(
  "negative control: a bare opaque() at status level means application/json, so image/png is refused",
  (await call(images, "/bare/png")).status,
  500,
);

/** The outbound rows `describeContract` lists for a route declaring `200: spec`. */
function rowsOf(spec: StandardSchemaV1 | object) {
  const contract = getContract(
    validate({}, { responses: { 200: spec as never } }),
  );
  return contract === undefined
    ? undefined
    : describeContract(contract)
        .entries.filter((entry) => entry.side === "outbound")
        .map(({ key, part, mediaType, kind }) => ({
          key,
          part,
          mediaType,
          kind,
        }));
}
checkEqual(
  "describeContract: the shorthand's rows are the keyed form's",
  rowsOf(specs.shorthand),
  rowsOf(specs.keyed),
);
show("their rows", rowsOf(specs.shorthand));

/* ------------------------------------------------------------------ */
step("A media type mapped to null: that type, with an empty body only");

const empty = new BunRouter({
  logger: createTestLogger().logger,
  responseValidation: "error",
});
empty.get(
  "/ack/:how",
  validate(
    {},
    {
      responses: {
        200: {
          content: {
            "text/plain": null,
            "application/json": z.object({ ok: z.literal(true) }),
          },
        },
      },
    },
  ),
  (req, res) => {
    switch (req.params.how) {
      case "empty-text":
        void res.type("text/plain").end();
        return;
      case "no-type":
        void res.end();
        return;
      case "json":
        res.json({ ok: true });
        return;
      default:
        untyped(res).type("text/plain").send("LEAK: a body");
    }
  },
);
empty.use(renderRefusal);

/** The status of `/ack/<how>`. */
async function ackStatus(how: string): Promise<number | "reset"> {
  return (await call(empty, `/ack/${how}`)).status;
}

checkEqual(
  "text/plain with an empty body: passes",
  await ackStatus("empty-text"),
  200,
);
checkEqual(
  "an empty body with no Content-Type: passes, since a media type maps to null",
  await ackStatus("no-type"),
  200,
);
checkEqual(
  "the JSON body beside it: still held to its schema, and passes",
  await ackStatus("json"),
  200,
);
checkEqual(
  "text/plain with a body: refused at body",
  seen(await call(empty, "/ack/text")),
  [500, cleanRefusal, "done"],
);

for (const server of servers) await server.close();

summary();
