/**
 * `BunHttpAdapter.close()` drains, as bun-nest's adapter does (PR-6b, #447):
 * `stop(false)`, a wait for `pendingRequests` to reach 0 of at most the
 * `closeDrainTimeout` option (10 s; shortened here), then always
 * `stop(true)`.
 *
 * - An in-flight request finishes before `close()` resolves; with
 *   `closeDrainTimeout: 0` the same request is cut at once (its control).
 * - A server-sent events stream is in flight until it ends, so a finite one
 *   is waited for and an endless one is cut at the cap. Its control: the
 *   stream was still flowing past the cap before `close()` was called.
 * - WebSockets are not waited for: they are closed by the final stop.
 * - The port-release rule (CLAUDE.md): nothing of the closed server answers
 *   once `close()` has resolved, even with a new server on the same port and
 *   a stream and a WebSocket left open. Its control: the same probe after a
 *   graceful `stop(false)` alone finds both still served by the old server.
 *
 * The shape of bun-nest's `shutdown.nest.test.ts`, on a bare adapter. Every
 * request is served (these are socket behaviours, so `testServer` and the
 * socket-free `fetch()` do not apply), every server binds port 0, and the
 * waits are gated on handler-written markers rather than timing, except the
 * drain cap, which is the timing. Every stream's reader is held in a binding
 * until the test ends: an unreferenced response can be garbage-collected,
 * and Bun 1.4.3 and later then abort its fetch (the lifecycle spike's S6).
 */
import type { BunResponse } from "../lib/BunResponse";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { noopLogger } from "../lib/logging";

/** A promise with its resolver, for gating a handler. */
function gate(): { promise: Promise<void>; open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

/** Per-test gates, reset in `afterEach`. */
let gates = {
  /** Opened by `/slow` and `/finite` once they are running. */
  entered: gate(),
  /** `/slow` answers, and `/finite` ends, once this is opened. */
  release: gate(),
};

/** Intervals the endless streams started, cleared after each test. */
const timers = new Set<Timer>();

/** Adapters to close after each test. */
const toClose: BunHttpAdapter[] = [];

afterEach(async () => {
  // Release anything a failed test left gated, so its close can finish.
  gates.release.open();
  for (const timer of timers) {
    clearInterval(timer);
  }
  timers.clear();
  for (const adapter of toClose.splice(0)) {
    await adapter.close();
  }
  gates = { entered: gate(), release: gate() };
});

/** Writes an SSE `tick` every 20 ms until the response closes. */
function endless(res: BunResponse): void {
  res.setHeader("Content-Type", "text/event-stream");
  const timer = setInterval(() => res.write("data: tick\n\n"), 20);
  timers.add(timer);
  res.on("close", () => {
    clearInterval(timer);
    timers.delete(timer);
  });
  res.write("data: open\n\n");
}

/**
 * An adapter with `/fast`, `/slow` (answers once `release` opens), `/finite`
 * (an SSE stream that ends once `release` opens), `/endless` (an SSE stream
 * that never ends) and `/ws` (a WebSocket that echoes `A:<message>`),
 * listening on 127.0.0.1:0. `closeDrainTimeout` is passed through when given.
 */
async function serve(closeDrainTimeout?: number) {
  const adapter = new BunHttpAdapter(0, {
    logger: noopLogger,
    ...(closeDrainTimeout === undefined ? {} : { closeDrainTimeout }),
  });
  adapter.get("/fast", (_req, res) => res.send("fast"));
  adapter.get("/slow", async (_req, res) => {
    gates.entered.open();
    await gates.release.promise;
    res.send("slow done");
  });
  adapter.get("/finite", (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write("data: 1\n\n");
    gates.entered.open();
    void gates.release.promise.then(async () => {
      res.write("data: 2\n\n");
      await res.end();
    });
  });
  adapter.get("/endless", (_req, res) => endless(res));
  adapter.ws("/ws", {
    message: (ws, message) => {
      ws.send(`A:${String(message)}`);
    },
  });
  toClose.push(adapter);
  await adapter.listen(0, "127.0.0.1");
  const server = adapter.getBunServer()!;
  return { adapter, server, url: `http://127.0.0.1:${server.port}` };
}

/** How a fetch settled: `answered <status> <body>`, or `failed: <error>`. */
function settle(response: Promise<Response>): Promise<string> {
  return response.then(
    async (r) => `answered ${r.status} ${await r.text()}`,
    (error: unknown) => `failed: ${String(error)}`,
  );
}

/** Reads `reader` to its end: `"ended"` when it ends or errors. */
async function readToEnd(reader: {
  read: () => Promise<{ done: boolean }>;
}): Promise<string> {
  try {
    while (!(await reader.read()).done) {
      // drain
    }
  } catch {
    // A cut stream errors instead of ending: the same thing here.
  }
  return "ended";
}

/** Opens a WebSocket on `url`'s `/ws`, resolving once it is open. */
async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(`${url.replace("http", "ws")}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("no upgrade")), {
      once: true,
    });
  });
  return socket;
}

/** Sends `ping` on `socket`: its answer, or `"no answer"` after `ms`. */
async function ping(socket: WebSocket, ms = 500): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  const onMessage = (event: MessageEvent) => resolve(String(event.data));
  socket.addEventListener("message", onMessage, { once: true });
  try {
    socket.send("ping");
  } catch {
    resolve("no answer");
  }
  const timer = setTimeout(() => resolve("no answer"), ms);
  const answer = await promise;
  clearTimeout(timer);
  socket.removeEventListener("message", onMessage);
  return answer;
}

describe("BunHttpAdapter close(): draining in-flight requests", () => {
  it("lets an in-flight request finish before resolving", async () => {
    const { adapter, url } = await serve();
    const inflight = settle(fetch(`${url}/slow`));
    await gates.entered.promise;

    let closed = false;
    const closing = adapter.close().then(() => {
      closed = true;
    });
    // Not resolved while the request is still running.
    await Bun.sleep(100);
    expect(closed).toBe(false);

    gates.release.open();
    expect(await inflight).toBe("answered 200 slow done");
    await closing;
    expect(closed).toBe(true);
  });

  it("cuts an in-flight request at once with closeDrainTimeout: 0 (the control)", async () => {
    const { adapter, url } = await serve(0);
    const inflight = settle(fetch(`${url}/slow`));
    await gates.entered.promise;

    const started = performance.now();
    await adapter.close();
    // Nowhere near the 10 s default: nothing was waited for.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await inflight).toStartWith("failed:");
  });

  it("cuts an in-flight request once a custom closeDrainTimeout passes", async () => {
    const { adapter, url } = await serve(250);
    const inflight = settle(fetch(`${url}/slow`));
    await gates.entered.promise;

    const started = performance.now();
    await adapter.close();
    const took = performance.now() - started;

    // Never released: cut once the 250 ms cap passed, not after 10 s.
    expect(took).toBeGreaterThanOrEqual(240);
    expect(took).toBeLessThan(5000);
    expect(await inflight).toStartWith("failed:");
  });

  it("waits for a server-sent events stream that ends within the cap", async () => {
    const { adapter, server, url } = await serve();
    const response = await fetch(`${url}/finite`);
    const body = response.text();
    await gates.entered.promise;

    let closed = false;
    const closing = adapter.close().then(() => {
      closed = true;
    });
    // A streamed response is in flight until it ends.
    await Bun.sleep(100);
    expect(server.pendingRequests).toBe(1);
    expect(closed).toBe(false);

    gates.release.open();
    expect(await body).toBe("data: 1\n\ndata: 2\n\n");
    await closing;
    expect(server.pendingRequests).toBe(0);
  });

  it("cuts a stream that never ends once the drain cap passes", async () => {
    const { adapter, server, url } = await serve(300);
    const reader = (await fetch(`${url}/endless`)).body!.getReader();
    await reader.read();

    // The control: on its own the stream outlives the cap, still delivering.
    const flowing = performance.now();
    while (performance.now() - flowing < 400) {
      expect((await reader.read()).done).toBe(false);
    }
    expect(server.pendingRequests).toBe(1);

    // Keep reading, as a live client does, until the stream is cut.
    const ended = readToEnd(reader);
    const started = performance.now();
    await adapter.close();
    const took = performance.now() - started;

    // The cap was waited for, then the stream cut, before close() resolved.
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(5000);
    expect(server.pendingRequests).toBe(0);
    expect(await ended).toBe("ended");
  });

  it("does not wait for an open WebSocket, and closes it", async () => {
    const { adapter, server, url } = await serve();
    const socket = await openSocket(url);
    const socketClosed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    );
    expect(await ping(socket)).toBe("A:ping");
    // The control: the socket is open, and not counted as a request.
    expect(server.pendingWebSockets).toBe(1);
    expect(server.pendingRequests).toBe(0);

    const started = performance.now();
    await adapter.close();
    // Nowhere near the 10 s default cap.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(server.pendingWebSockets).toBe(0);
    await socketClosed;
  });

  it("resolves at once when nothing is in flight", async () => {
    const { adapter, url } = await serve();
    expect(await (await fetch(`${url}/fast`)).text()).toBe("fast");
    const started = performance.now();
    await adapter.close();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("refuses a negative or non-finite closeDrainTimeout at construction", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new BunHttpAdapter(0, { closeDrainTimeout: bad })).toThrow(
        RangeError,
      );
    }
    expect(
      () =>
        new BunHttpAdapter(0, {
          closeDrainTimeout: "100" as unknown as number,
        }),
    ).toThrow(RangeError);
    // The control: 0, a positive value and the default are accepted.
    for (const good of [0, 1, 250.5, undefined]) {
      expect(
        () => new BunHttpAdapter(0, { closeDrainTimeout: good }),
      ).not.toThrow();
    }
  });
});

describe("BunHttpAdapter close(): the port-release rule", () => {
  /**
   * After `stop` has stopped the adapter's server, binds a new server on the
   * same port and reports what the old one still serves: what a pooled
   * client gets, whether the old SSE stream still flows, and whether the old
   * WebSocket still answers.
   */
  async function probe(stop: (adapter: BunHttpAdapter) => Promise<unknown>) {
    const { adapter, url } = await serve(200);
    const port = adapter.getBunServer()!.port;

    // A keep-alive client, an open stream and a WebSocket on the old server.
    expect(await (await fetch(`${url}/fast`)).text()).toBe("fast");
    const reader = (await fetch(`${url}/endless`)).body!.getReader();
    await reader.read();
    const socket = await openSocket(url);
    expect(await ping(socket)).toBe("A:ping");

    await stop(adapter);

    const next = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: () => new Response("next"),
    });
    try {
      const pooled: string[] = [];
      for (let i = 0; i < 4; i++) {
        pooled.push(await (await fetch(`${url}/fast`)).text());
      }
      const stream = await Promise.race([
        readToEnd(reader),
        Bun.sleep(1000).then(() => "still flowing"),
      ]);
      const websocket = await ping(socket);
      return { pooled, stream, websocket };
    } finally {
      socket.close();
      await reader.cancel().catch(() => undefined);
      await next.stop(true);
    }
  }

  it("leaves nothing of the closed server answering on its port", async () => {
    expect(await probe((adapter) => adapter.close())).toEqual({
      pooled: ["next", "next", "next", "next"],
      stream: "ended",
      websocket: "no answer",
    });
  });

  it("the control: a graceful stop alone leaves the stream and the WebSocket on the old server", async () => {
    const outcome = await probe(async (adapter) => {
      // Not awaited: it waits for the stream and the socket, which never end.
      void adapter.getBunServer()!.stop(false);
    });
    expect(outcome).toEqual({
      pooled: ["next", "next", "next", "next"],
      stream: "still flowing",
      websocket: "A:ping",
    });
  });
});
