/**
 * `sse()` (typed-client plan, `sse.md` §3, §5, PR-S1) against real streams:
 * `Bun.serve` on port 0 with a plain handler writing the event-stream
 * format, as §5 says (the server's writer, BNR PR-sse2, is not built), and,
 * for backpressure, a custom `fetch` whose body counts its pulls.
 *
 * Covered: typed iteration and listeners; `Last-Event-ID` on reconnection
 * (control: none sent when no id was seen); `retry:` honoured and the
 * doubling; the declared `gap` as `$gap`; validation in each mode
 * (control: production checks nothing); a 401 before the stream as
 * `HttpError`, an undeclared fatal status as `StreamClosedError`, a 503
 * reconnected; `204`; abort and `close()`; the heartbeat watchdog; pull-based
 * reading; auth per connection.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import type { RouteManifest } from "../lib/index";
import {
  createClient,
  HttpError,
  NetworkError,
  ValidationError,
} from "../lib/index";
import { sse, StreamClosedError } from "../lib/sse";

interface Progress {
  percent: number;
}

interface Routes {
  "GET /jobs/:id/events": {
    params: { id: string };
    responses: { 200: undefined; 401: { code: "UNAUTHORIZED" } };
    stream: "sse";
    events: {
      progress: Progress;
      done: { result: string };
      gap: undefined;
    };
  };
  "GET /plain": { responses: { 200: undefined }; stream: "sse" };
  "GET /users/:id": {
    params: { id: string };
    responses: { 200: { id: string } };
  };
}

const manifest: RouteManifest<Routes> = {
  "GET /jobs/:id/events": { statuses: [200, 401] },
};

const encoder = new TextEncoder();

/** A controllable event stream body: write text, end it, see it cancelled. */
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const whenCancelled = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>({
    start: (c) => void (controller = c),
    cancel: () => {
      cancelled = true;
      whenCancelled.resolve();
    },
  });
  return {
    response: (headers: Record<string, string> = {}) =>
      new Response(body, {
        headers: { "content-type": "text/event-stream", ...headers },
      }),
    write: (text: string) => {
      try {
        controller.enqueue(encoder.encode(text));
      } catch {
        // Already cancelled by the client.
      }
    },
    end: () => {
      try {
        controller.close();
      } catch {
        // Already cancelled.
      }
    },
    get cancelled() {
      return cancelled;
    },
    /**
     * Settles when the server cancels the body: the client's close travels
     * over the socket, so a test waits for this rather than for a time.
     */
    whenCancelled: whenCancelled.promise,
  };
}

/** A whole event-stream answer that ends after `text`. */
const answer = (text: string, init: ResponseInit = {}) =>
  new Response(text, {
    ...init,
    headers: { "content-type": "text/event-stream", ...init.headers },
  });

const servers: { stop: (force?: boolean) => unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true);
});

/**
 * Serves `handler` on port 0; returns the client over it, every request
 * it saw (with when it arrived) and the logger's lines.
 */
function serve(
  handler: (request: Request, n: number) => Response | Promise<Response>,
  config: Parameters<typeof createClient<Routes>>[0] = {},
) {
  const requests: { url: string; headers: Headers; at: number }[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: (request) => {
      // A copy: Bun empties a served request's url and headers once it is
      // answered, unless they were read first (oven-sh/bun#40483, an open
      // fix; reproduced on 1.4.4-canary.1+11c367163).
      requests.push({
        url: request.url,
        headers: new Headers(request.headers),
        at: performance.now(),
      });
      return handler(request, requests.length);
    },
  });
  servers.push(server);
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const api = createClient<Routes>({
    baseUrl: server.url.href.replace(/\/$/, ""),
    manifest,
    logger: {
      warn: (message: string) => void warnings.push(message),
      error: (...args: unknown[]) => void errors.push(args),
      debug: () => {},
    },
    ...config,
  });
  return { api, requests, warnings, errors };
}

/** Collects `count` events from an iterator, then closes the stream. */
async function take<T>(
  iterable: AsyncIterable<T>,
  count: number,
): Promise<T[]> {
  const out: T[] = [];
  if (count === 0) return out;
  for await (const event of iterable) {
    out.push(event);
    if (out.length === count) break;
  }
  return out;
}

describe("typed iteration and listeners", () => {
  it("delivers the events in order, typed by name, asking for text/event-stream", async () => {
    const body = stream();
    const { api, requests } = serve(() => {
      queueMicrotask(() => {
        body.write('event: progress\ndata: {"percent":10}\n\n');
        body.write('event: progress\ndata: {"percent":90}\nid: 2\n\n');
        body.write('event: done\ndata: {"result":"ok"}\n\n');
      });
      return body.response();
    });
    const events = sse(api, "GET /jobs/:id/events", { params: { id: "7" } });
    const seen: unknown[] = [];
    for await (const event of events) {
      if (event.event === "progress") seen.push(event.data.percent);
      else if (event.event === "done") {
        seen.push(event.data.result);
        break;
      }
    }
    expect(seen).toEqual([10, 90, "ok"]);
    expect(events.lastEventId).toBe("2");
    expect(new URL(requests[0].url).pathname).toBe("/jobs/7/events");
    expect(requests[0].headers.get("accept")).toBe("text/event-stream");
    // Breaking out closes the stream: the server sees the body cancelled.
    await events.closed;
    await body.whenCancelled;
    expect(body.cancelled).toBe(true);
  });

  it("gives each event its id (the last one set), absent before any", async () => {
    const { api } = serve(() =>
      answer("data: 1\n\nid: a\ndata: 2\n\ndata: 3\n\nid\ndata: 4\n\n"),
    );
    const got = await take(sse(api, "GET /plain", { reconnect: false }), 4);
    expect(got).toEqual([
      { event: "message", data: 1 },
      { event: "message", data: 2, id: "a" },
      { event: "message", data: 3, id: "a" },
      { event: "message", data: 4 },
    ]);
  });

  it("calls listeners eagerly, removes one, and settles closed on close()", async () => {
    const body = stream();
    const { api } = serve(() => {
      queueMicrotask(() => {
        body.write('event: progress\ndata: {"percent":1}\n\n');
        body.write('event: progress\ndata: {"percent":2}\n\n');
        body.write('event: done\ndata: {"result":"r"}\n\n');
      });
      return body.response();
    });
    const events = sse(api, "GET /jobs/:id/events", { params: { id: "1" } });
    const percents: number[] = [];
    const { promise: done, resolve } = Promise.withResolvers<string>();
    const off = events.on("progress", (data, event) => {
      percents.push(data.percent);
      expect(event.event).toBe("progress");
      off();
    });
    events.on("done", (data) => resolve(data.result));
    expect(await done).toBe("r");
    expect(percents).toEqual([1]);
    events.close();
    await events.closed;
  });

  it("logs a listener that throws and carries on", async () => {
    const { api, errors } = serve(() =>
      answer(
        'event: done\ndata: {"result":"a"}\n\nevent: done\ndata: {"result":"b"}\n\n',
      ),
    );
    const events = sse(api, "GET /jobs/:id/events", {
      params: { id: "1" },
      reconnect: false,
    });
    const results: string[] = [];
    events.on("done", (data) => {
      results.push(data.result);
      throw new Error("listener bug");
    });
    await events.closed;
    expect(results).toEqual(["a", "b"]);
    expect(errors).toHaveLength(2);
  });

  it("is iterated once", () => {
    const { api } = serve(() => answer(""));
    const events = sse(api, "GET /plain");
    events[Symbol.asyncIterator]();
    expect(() => events[Symbol.asyncIterator]()).toThrow(/iterated once/);
    events.close();
  });

  it("sends nothing until it is read", async () => {
    const { api, requests } = serve(() => answer("data: 1\n\n"));
    const events = sse(api, "GET /plain");
    await Bun.sleep(30);
    expect(requests).toHaveLength(0);
    events.close();
    await events.closed;
  });

  it('decodes data as text with data: "text"; JSON that does not parse is delivered as its text', async () => {
    const { api } = serve(() => answer("data: 123\n\ndata: {oops\n\n"));
    expect(
      await take(sse(api, "GET /plain", { data: "text", reconnect: false }), 2),
    ).toEqual([
      { event: "message", data: "123" },
      { event: "message", data: "{oops" },
    ]);
    expect(await take(sse(api, "GET /plain", { reconnect: false }), 2)).toEqual(
      [
        { event: "message", data: 123 },
        { event: "message", data: "{oops" },
      ],
    );
  });
});

describe("resume and reconnection (sse.md §3.2)", () => {
  it("sends the last id as Last-Event-ID on every reconnection", async () => {
    const { api, requests } = serve((_request, n) =>
      n === 1
        ? answer("retry: 10\nid: 1\ndata: 1\n\nid: 2\ndata: 2\n\n")
        : n === 2
          ? answer("data: 3\n\n")
          : answer("id: 9\ndata: 4\n\n"),
    );
    const events = sse(api, "GET /plain");
    const got = await take(events, 4);
    expect(got.map((event) => event.data)).toEqual([1, 2, 3, 4]);
    expect(requests.map(({ headers }) => headers.get("last-event-id"))).toEqual(
      [null, "2", "2"],
    );
    expect(events.lastEventId).toBe("9");
  });

  it("control: sends no Last-Event-ID when no id was seen", async () => {
    const { api, requests } = serve(() => answer("retry: 10\ndata: 1\n\n"));
    await take(sse(api, "GET /plain"), 2);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[1].headers.has("last-event-id")).toBe(false);
  });

  it("starts from the lastEventId option", async () => {
    const { api, requests } = serve(() => answer("data: 1\n\n"));
    await take(sse(api, "GET /plain", { lastEventId: "40" }), 1);
    expect(requests[0].headers.get("last-event-id")).toBe("40");
  });

  it("honours retry:, doubling it on consecutive failures", async () => {
    const ends: number[] = [];
    const { api, requests } = serve(() => {
      ends.push(performance.now());
      return answer("retry: 60\n\n");
    });
    const events = sse(api, "GET /plain");
    events.on("message", () => {});
    while (requests.length < 4) await Bun.sleep(5);
    events.close();
    const gaps = [1, 2, 3].map((i) => requests[i].at - requests[i - 1].at);
    // Each wait is between half of its delay and all of it: 60, 120, 240.
    expect(gaps[0]).toBeGreaterThanOrEqual(30 - 5);
    expect(gaps[0]).toBeLessThan(1000);
    expect(gaps[1]).toBeGreaterThanOrEqual(60 - 5);
    expect(gaps[2]).toBeGreaterThanOrEqual(120 - 5);
  });

  it("control: without retry: waits reconnect.initialMs", async () => {
    const { api, requests } = serve(() => answer(""));
    const events = sse(api, "GET /plain", { reconnect: { initialMs: 600 } });
    events.on("message", () => {});
    while (requests.length < 2) await Bun.sleep(5);
    events.close();
    expect(requests[1].at - requests[0].at).toBeGreaterThanOrEqual(300 - 5);
  });

  it("reconnects after a 503, waiting its Retry-After", async () => {
    const { api, requests } = serve((_request, n) =>
      n === 1
        ? new Response("busy", {
            status: 503,
            headers: { "retry-after": "0" },
          })
        : answer('event: done\ndata: {"result":"back"}\n\n'),
    );
    const got = await take(
      sse(api, "GET /jobs/:id/events", { params: { id: "1" } }),
      1,
    );
    expect(got).toEqual([{ event: "done", data: { result: "back" } }]);
    expect(requests).toHaveLength(2);
  });

  it("reconnects after the network fails, and surfaces NetworkError with reconnection off", async () => {
    const dead = createClient<Routes>({ baseUrl: "http://127.0.0.1:1" });
    const off = sse(dead, "GET /plain", { reconnect: false });
    await expect(take(off, 1)).rejects.toBeInstanceOf(NetworkError);
    await expect(off.closed).rejects.toBeInstanceOf(NetworkError);
    let attempts = 0;
    const { promise: third, resolve } = Promise.withResolvers<void>();
    const retrying = sse(dead, "GET /plain", {
      reconnect: { initialMs: 5, maxMs: 5 },
      middleware: [
        (_ctx, next) => {
          if (++attempts === 3) resolve();
          return next();
        },
      ],
    });
    retrying.on("message", () => {});
    await third;
    retrying.close();
    await retrying.closed;
  });

  it("applies a refreshed token to the next connection", async () => {
    let token = 0;
    const { api, requests } = serve(() => answer("retry: 5\ndata: 1\n\n"), {
      auth: { token: () => `t${++token}` },
    });
    await take(sse(api, "GET /plain"), 2);
    expect(
      requests.slice(0, 2).map(({ headers }) => headers.get("authorization")),
    ).toEqual(["Bearer t1", "Bearer t2"]);
  });

  it("drops a connection that goes quiet for twice heartbeatMs plus 5 s, and reconnects", async () => {
    const quiet = stream();
    const { api, requests } = serve((_request, n) => {
      if (n === 1) {
        queueMicrotask(() => quiet.write("retry: 1\ndata: 1\n\n"));
        return quiet.response();
      }
      return answer("data: 2\n\n");
    });
    const started = performance.now();
    const got = await take(sse(api, "GET /plain", { heartbeatMs: 10 }), 2);
    expect(got.map((event) => event.data)).toEqual([1, 2]);
    expect(requests[1].at - started).toBeGreaterThanOrEqual(5_020 - 50);
    await quiet.whenCancelled;
    expect(quiet.cancelled).toBe(true);
  }, 15_000);
});

describe("stops and errors (sse.md §3.2, §3.3)", () => {
  it("a declared 401 before the stream is the client's HttpError, typed, and ends it", async () => {
    const { api, requests } = serve(() =>
      Response.json({ code: "UNAUTHORIZED" }, { status: 401 }),
    );
    const events = sse(api, "GET /jobs/:id/events", { params: { id: "1" } });
    const error = await take(events, 1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    const http = error as HttpError<Routes["GET /jobs/:id/events"]>;
    expect(http.status).toBe(401);
    expect(http.error).toEqual({ code: "UNAUTHORIZED" });
    await expect(events.closed).rejects.toBe(error);
    await Bun.sleep(30);
    expect(requests).toHaveLength(1);
  });

  it("an undeclared fatal status is a StreamClosedError", async () => {
    const { api } = serve(() => new Response("no", { status: 403 }));
    const events = sse(api, "GET /jobs/:id/events", { params: { id: "1" } });
    const error = (await take(events, 1).catch(
      (caught: unknown) => caught,
    )) as StreamClosedError;
    expect(error).toBeInstanceOf(StreamClosedError);
    expect(error.status).toBe(403);
    expect(error.key).toBe("GET /jobs/:id/events");
  });

  it("fatalStatuses replaces the default: a 503 ends it, a 404 is retried", async () => {
    const { api, requests } = serve((_request, n) =>
      n === 1
        ? new Response("gone", { status: 404 })
        : new Response("busy", { status: 503 }),
    );
    const events = sse(api, "GET /plain", {
      fatalStatuses: [503],
      reconnect: { initialMs: 5 },
    });
    const error = await take(events, 1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
    expect(requests).toHaveLength(2);
  });

  it("a 204 ends the stream cleanly, without reconnecting", async () => {
    const { api, requests } = serve(() => new Response(null, { status: 204 }));
    const events = sse(api, "GET /plain");
    expect(await take(events, 5)).toEqual([]);
    await events.closed;
    await Bun.sleep(30);
    expect(requests).toHaveLength(1);
  });

  it("a success that is not an event stream is a StreamClosedError", async () => {
    const { api } = serve(() => Response.json({ hello: 1 }));
    const error = await take(sse(api, "GET /plain"), 1).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(StreamClosedError);
    expect(String((error as Error).message)).toContain(
      "not a text/event-stream",
    );
  });

  it("with reconnection off, a stream the server ends ends the iterator cleanly", async () => {
    const { api, requests } = serve(() => answer("data: 1\n\n"));
    const events = sse(api, "GET /plain", { reconnect: false });
    expect(await take(events, 5)).toEqual([{ event: "message", data: 1 }]);
    await events.closed;
    expect(requests).toHaveLength(1);
  });

  it("the signal ends it with the signal's reason, the server's body cancelled", async () => {
    const body = stream();
    const { api } = serve(() => {
      queueMicrotask(() => body.write("data: 1\n\n"));
      return body.response();
    });
    const controller = new AbortController();
    const events = sse(api, "GET /plain", { signal: controller.signal });
    const got: unknown[] = [];
    const reading = (async () => {
      for await (const event of events) {
        got.push(event);
        controller.abort();
      }
    })();
    const error = await reading.catch((caught: unknown) => caught);
    expect((error as Error).name).toBe("AbortError");
    expect(got).toHaveLength(1);
    await expect(events.closed).rejects.toBe(error);
    await body.whenCancelled;
    expect(body.cancelled).toBe(true);
  });

  it("a signal aborted before the start ends it at once, sending nothing", async () => {
    const { api, requests } = serve(() => answer("data: 1\n\n"));
    const events = sse(api, "GET /plain", { signal: AbortSignal.abort() });
    await expect(take(events, 1)).rejects.toHaveProperty("name", "AbortError");
    await expect(events.closed).rejects.toHaveProperty("name", "AbortError");
    expect(requests).toHaveLength(0);
  });

  it("close() while waiting for an event ends the iterator", async () => {
    const body = stream();
    const { api } = serve(() => body.response());
    const events = sse(api, "GET /plain");
    const reading = take(events, 1);
    await Bun.sleep(30);
    events.close();
    expect(await reading).toEqual([]);
    await events.closed;
  });
});

describe("the gap event (S-D4)", () => {
  it("is delivered like any event, and fires $gap", async () => {
    const { api } = serve(() =>
      answer('event: gap\ndata:\n\nevent: done\ndata: {"result":"x"}\n\n'),
    );
    const events = sse(api, "GET /jobs/:id/events", {
      params: { id: "1" },
      reconnect: false,
    });
    const gaps: unknown[] = [];
    events.on("$gap", (data, event) => gaps.push([data, event.event]));
    const got: unknown[] = [];
    for await (const event of events) got.push(event.event);
    expect(got).toEqual(["gap", "done"]);
    expect(gaps).toEqual([[undefined, "gap"]]);
  });
});

describe("validation (sse.md §3.3, TC §5.6)", () => {
  /** The route's built-in event schemas, as a generated module holds them. */
  const schemas = {
    schemas: {
      "GET /jobs/:id/events": {
        events: {
          progress: z.object({ percent: z.number() }),
          done: z.object({ result: z.string() }),
          gap: null,
        },
      },
    },
  };
  /** Two good events around four bad ones: wrong data, undeclared, data on a null event, not JSON. */
  const MIXED =
    'event: progress\ndata: {"percent":1}\n\n' +
    'event: progress\ndata: {"percent":"x"}\n\n' +
    "event: oops\ndata: 1\n\n" +
    "event: gap\ndata: 5\n\n" +
    "event: done\ndata: {nope\n\n" +
    'event: done\ndata: {"result":"ok"}\n\n';

  it("warns and delivers by default in development, one warning per bad event", async () => {
    const { api, warnings } = serve(() => answer(MIXED), {
      mode: "development",
      schemas,
    });
    const got = await take(
      sse(api, "GET /jobs/:id/events", {
        params: { id: "1" },
        reconnect: false,
      }),
      6,
    );
    expect(got.map((event): string => event.event)).toEqual([
      "progress",
      "progress",
      "oops",
      "gap",
      "done",
      "done",
    ]);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain("data.percent");
    expect(warnings[1]).toContain("This event is not declared");
    expect(warnings[2]).toContain("No data is declared for this event");
    expect(warnings[3]).toContain("not valid JSON");
  });

  it('"drop" discards a bad event and fires $invalid with the ValidationError', async () => {
    const { api, warnings } = serve(() => answer(MIXED), {
      mode: "development",
      schemas,
    });
    const events = sse(api, "GET /jobs/:id/events", {
      params: { id: "1" },
      reconnect: false,
      validate: { onFailure: { response: "drop" } },
    });
    const invalid: ValidationError[] = [];
    events.on("$invalid", (error) => invalid.push(error));
    const got: unknown[] = [];
    for await (const event of events) got.push(event);
    expect(got).toEqual([
      { event: "progress", data: { percent: 1 } },
      { event: "done", data: { result: "ok" } },
    ]);
    expect(invalid.map((error) => error.issues[0].key)).toEqual([
      "progress",
      "oops",
      "gap",
      "done",
    ]);
    expect(invalid[0]).toBeInstanceOf(ValidationError);
    expect(invalid[0].direction).toBe("response");
    expect(invalid[0].status).toBe(200);
    expect(invalid[0].issues[0]).toMatchObject({
      target: "data",
      key: "progress",
      path: "percent",
      source: "builtin",
    });
    expect(warnings).toEqual([]);
  });

  it('"throw" ends the stream with the ValidationError at the first bad event', async () => {
    const { api } = serve(() => answer(MIXED), {
      mode: "development",
      schemas,
      validate: { onFailure: { response: "throw" } },
    });
    const events = sse(api, "GET /jobs/:id/events", { params: { id: "1" } });
    const got: unknown[] = [];
    const error = await (async () => {
      for await (const event of events) got.push(event.event);
    })().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect(got).toEqual(["progress"]);
    await expect(events.closed).rejects.toBe(error);
  });

  it("a hook receives each failure and the event is delivered", async () => {
    const seen: string[] = [];
    const { api } = serve(() => answer(MIXED), {
      mode: "development",
      schemas,
    });
    const got = await take(
      sse(api, "GET /jobs/:id/events", {
        params: { id: "1" },
        reconnect: false,
        validate: {
          onFailure: {
            response: (error) => void seen.push(error.issues[0].key!),
          },
        },
      }),
      6,
    );
    expect(got).toHaveLength(6);
    expect(seen).toEqual(["progress", "oops", "gap", "done"]);
  });

  it("control: production checks nothing (and loads no schemas)", async () => {
    let loads = 0;
    const { api, warnings } = serve(() => answer(MIXED), {
      mode: "production",
      schemas: async () => {
        loads++;
        return schemas;
      },
    });
    const got = await take(
      sse(api, "GET /jobs/:id/events", {
        params: { id: "1" },
        reconnect: false,
      }),
      6,
    );
    expect(got).toHaveLength(6);
    expect(warnings).toEqual([]);
    expect(loads).toBe(0);
  });

  it("validate: false at the call turns it off; a route's level applies", async () => {
    const { api, warnings } = serve(() => answer(MIXED), {
      mode: "development",
      schemas,
      routes: {
        "GET /jobs/:id/events": {
          validate: { onFailure: { response: "throw" } },
        },
      },
    });
    const off = await take(
      sse(api, "GET /jobs/:id/events", {
        params: { id: "1" },
        reconnect: false,
        validate: false,
      }),
      6,
    );
    expect(off).toHaveLength(6);
    expect(warnings).toEqual([]);
    const error = await take(
      sse(api, "GET /jobs/:id/events", {
        params: { id: "1" },
        reconnect: false,
      }),
      6,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
  });

  it("a BYO schema checks the whole event, and its output is delivered", async () => {
    const { api } = serve(() =>
      answer(
        'event: done\ndata: {"result":"ok"}\n\nevent: done\ndata: {"result":""}\n\n',
      ),
    );
    const invalid: string[] = [];
    const events = sse(api, "GET /jobs/:id/events", {
      params: { id: "1" },
      reconnect: false,
      validate: {
        response: {
          200: {
            custom: z
              .object({
                event: z.literal("done"),
                data: z.object({ result: z.string().min(1) }),
              })
              .transform((event) => ({
                ...event,
                data: { result: event.data.result.toUpperCase() },
              })),
          },
        },
        onFailure: { response: "drop" },
      },
    });
    events.on("$invalid", (error) =>
      invalid.push(`${error.issues[0].source}:${error.issues[0].path}`),
    );
    const got: unknown[] = [];
    for await (const event of events) got.push(event);
    expect(got).toEqual([{ event: "done", data: { result: "OK" } }]);
    expect(invalid).toEqual(["custom:data.result"]);
  });

  it("reads a bun-common sse() declaration as the stream's events (a server's own schema module)", async () => {
    const { sse: declare } = await import("@kingsleyweb/bun-common");
    const { api, warnings } = serve(() => answer(MIXED), {
      mode: "development",
      schemas: {
        schemas: {
          "GET /jobs/:id/events": {
            responses: {
              200: declare({
                progress: z.object({ percent: z.number() }),
                done: z.object({ result: z.string() }),
                gap: null,
              }),
            },
          },
        },
      },
    });
    await take(
      sse(api, "GET /jobs/:id/events", {
        params: { id: "1" },
        reconnect: false,
      }),
      6,
    );
    expect(warnings).toHaveLength(4);
  });
});

describe("backpressure (sse.md §3.4)", () => {
  /** A client whose fetch answers a body that makes one event per pull. */
  function pulled() {
    let pulls = 0;
    const api = createClient<Routes>({
      baseUrl: "http://app.test",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              // A tick per pull, as a socket gives: a synchronous source
              // would starve the timers this test waits on.
              pull: async (controller) => {
                await Bun.sleep(0);
                pulls++;
                controller.enqueue(encoder.encode(`data: ${pulls}\n\n`));
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    return { api, pulls: () => pulls };
  }

  it("the iterator reads only as fast as it is consumed", async () => {
    const { api, pulls } = pulled();
    const events = sse(api, "GET /plain");
    const iterator = events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({
      event: "message",
      data: 1,
    });
    expect((await iterator.next()).value).toEqual({
      event: "message",
      data: 2,
    });
    await Bun.sleep(30);
    const after = pulls();
    expect(after).toBeLessThanOrEqual(3);
    await Bun.sleep(30);
    expect(pulls()).toBe(after);
    events.close();
    await events.closed;
  });

  it("control: a listener reads eagerly", async () => {
    const { api, pulls } = pulled();
    const events = sse(api, "GET /plain");
    events.on("message", () => {});
    // Read on with no one taking anything, as far as a loaded machine lets
    // it (a tick per pull): well past the iterator's 3, within 5 s.
    const deadline = performance.now() + 5_000;
    while (pulls() <= 20 && performance.now() < deadline) await Bun.sleep(5);
    expect(pulls()).toBeGreaterThan(20);
    events.close();
    await events.closed;
  });
});
