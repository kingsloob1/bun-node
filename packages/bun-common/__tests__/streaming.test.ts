import type { BunResponse } from "../lib/BunResponse";
/**
 * Streamed responses at their edges: what a client sees when a handler keeps
 * a stream open, awaits it, goes quiet, or fails part-way through.
 *
 * Each case runs three ways — over a socket, through `adapter.fetch()` and
 * through `router.fetch()` — and asserts the same outcome, since a socket-free
 * test that diverges from production is worse than none.
 *
 * No assertion depends on a short window. "Before the handler returned" is an
 * ordering (a flag the handler sets), with a generous auto-release so the
 * old behaviour fails rather than hangs; "promptly" is a deadline of seconds,
 * not milliseconds; and the idle-timeout case carries its own control.
 */
import type {
  NextFunction,
  RouterErrorMiddlewareHandler,
} from "../lib/types/general";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { BunRouter, FETCH_STUB_SERVER } from "../lib/BunRouter";
import { createTestLogger } from "../lib/logging";
import { makeResponse } from "./helpers";

/** How a test reaches the routes: over a socket, or through either `fetch()`. */
type Mode = "served" | "adapter.fetch()" | "router.fetch()";
const MODES: Mode[] = ["served", "adapter.fetch()", "router.fetch()"];

/** Adapters to close after each test. */
const open: BunHttpAdapter[] = [];

afterEach(async () => {
  while (open.length) {
    await open.pop()?.close();
  }
});

/** A target to request paths from, whichever way `mode` says. */
interface Target {
  /** Requests `path`, resolving once the response (its head) is available. */
  get: (path: string) => Promise<Response>;
  /** The router the routes were registered on (the adapter, for adapter modes). */
  router: BunRouter;
}

/** Registers routes with `build` and returns a {@link Target} for `mode`. */
async function target(
  mode: Mode,
  build: (router: BunRouter) => void,
  options?: ConstructorParameters<typeof BunHttpAdapter>[1],
): Promise<Target> {
  if (mode === "router.fetch()") {
    const router = new BunRouter();
    build(router);
    return { router, get: async (path) => router.fetch(path) };
  }
  const adapter = new BunHttpAdapter(0, options);
  build(adapter);
  if (mode === "adapter.fetch()") {
    return { router: adapter, get: async (path) => adapter.fetch(path) };
  }
  await adapter.listen(0);
  open.push(adapter);
  return {
    router: adapter,
    get: async (path) =>
      fetch(`http://127.0.0.1:${adapter.listeningPort}${path}`),
  };
}

/** What the next read of an event stream produced. */
type Read =
  | { kind: "event"; block: string }
  | { kind: "done" }
  | { kind: "error" }
  | { kind: "timeout" };

/**
 * An event-stream reader: `next()` resolves with the next blank-line-terminated
 * block, the end of the stream, an error (a cut connection), or `timeout`
 * after `deadlineMs`.
 */
function sseReader(body: ReadableStream<Uint8Array> | null) {
  const reader = body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(deadlineMs = 5000): Promise<Read> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(resolve, deadlineMs, "timeout");
      });
      try {
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            return { kind: "event", block };
          }
          const read = await Promise.race([
            reader.read().then(
              (result) => result,
              () => "error" as const,
            ),
            deadline,
          ]);
          if (read === "timeout") {
            void reader.cancel().catch(() => undefined);
            return { kind: "timeout" };
          }
          if (read === "error") {
            return { kind: "error" };
          }
          if (read.done) {
            return { kind: "done" };
          }
          buffer += decoder.decode(read.value, { stream: true });
        }
      } finally {
        clearTimeout(timer);
      }
    },
    cancel: () => reader.cancel().catch(() => undefined),
  };
}

/** Resolves `fetching`, or `undefined` once `deadlineMs` passes first. */
async function within<T>(
  fetching: Promise<T>,
  deadlineMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetching,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, deadlineMs, undefined);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A gate a handler awaits; it opens on `release()` or by itself after `autoMs`. */
function gate(autoMs: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const state = { released: false };
  const timer = setTimeout(() => {
    state.released = true;
    resolve();
  }, autoMs);
  return {
    state,
    wait: promise,
    release() {
      clearTimeout(timer);
      state.released = true;
      resolve();
    },
  };
}

const encoder = new TextEncoder();

describe("headersSent does not count keep-alive as sent", () => {
  it("setKeepAlive(true) leaves headersSent false, and send() still answers", async () => {
    const res = await makeResponse();
    res.req.socket.setKeepAlive(true);

    expect(res.headersSent).toBe(false);
    res.status(500).send("filter");
    expect(res.headersSent).toBe(true);
    const native = await res.getNativeResponse(0);
    expect(native.status).toBe(500);
    expect(await native.text()).toBe("filter");
  });

  for (const mode of MODES) {
    it(`${mode}: an error after setKeepAlive(true) is answered 500, not left hanging`, async () => {
      const seen: boolean[] = [];
      const t = await target(mode, (router) => {
        router.get("/keepalive", (req) => {
          req.socket.setKeepAlive(true);
          throw new Error("before any write");
        });
        router.use(((error, _req, res, _next) => {
          seen.push(res.headersSent);
          res.status(500).json({ error: (error as Error).message });
        }) satisfies RouterErrorMiddlewareHandler);
      });

      const response = await within(t.get("/keepalive"), 5000);
      expect(response?.status).toBe(500);
      expect(await response?.json()).toEqual({ error: "before any write" });
      expect(seen).toEqual([false]);
    });
  }
});

describe("socket.setTimeout(0) exempts the request from idleTimeout", () => {
  it("calls server.timeout(request, 0), and nothing for a non-zero timeout", async () => {
    const calls: [Request, number][] = [];
    const server = {
      ...FETCH_STUB_SERVER,
      timeout: (request: Request, seconds: number) => {
        calls.push([request, seconds]);
      },
    } as Parameters<typeof BunRequest.init>[1];
    const native = new Request("http://localhost/quiet");
    const req = await BunRequest.init(native, server, { parseBody: false });

    req.socket.setTimeout(30_000);
    expect(calls).toEqual([]);
    expect(req.socket.setTimeout(0)).toBe(req.socket);
    expect(calls).toEqual([[native, 0]]);
  });

  it("is a no-op without a server, and on the socket-free stub", async () => {
    expect(typeof FETCH_STUB_SERVER.timeout).toBe("function");
    const router = new BunRouter();
    router.get("/quiet", (req, res) => {
      req.socket.setTimeout(0);
      res.send("ok");
    });
    const response = await router.fetch("/quiet");
    expect(await response.text()).toBe("ok");

    // A request built by hand without a server (the constructor's type asks
    // for one; the getter documents `undefined` for exactly this case).
    const bare = await BunRequest.init(
      new Request("http://localhost/"),
      undefined as unknown as Parameters<typeof BunRequest.init>[1],
      { parseBody: false },
    );
    expect(() => bare.socket.setTimeout(0)).not.toThrow();
  });

  // Bun cuts an idle connection at a 4 s granularity, so `idleTimeout: 1`
  // cuts at ~4 s. The control (a stream nobody exempted) proves the timeout is
  // live in this server, so the exempt streams outliving it is the exemption.
  it("served: an exempt quiet stream outlives idleTimeout; the control is cut", async () => {
    const t = await target(
      "served",
      (router) => {
        const quiet = () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(": open\n\n"));
            },
          });
        router.get("/control", (_req, res) => {
          res.setHeader("Content-Type", "text/event-stream");
          res.send(quiet());
        });
        router.get("/exempt", (req, res) => {
          res.setHeader("Content-Type", "text/event-stream");
          req.socket.setTimeout(0);
          res.send(quiet());
        });
        // `write()` opens the stream the way Node's idiom says: it calls
        // `socket.setTimeout(0)` itself, so it is exempt too.
        router.get("/written", (_req, res) => {
          res.setHeader("Content-Type", "text/event-stream");
          res.write(": open\n\n");
        });
      },
      { server: { idleTimeout: 1 } },
    );

    const WATCH_MS = 9000;
    const watch = async (path: string): Promise<string> => {
      const reader = sseReader((await t.get(path)).body);
      const first = await reader.next();
      if (first.kind !== "event") {
        return `no first event: ${first.kind}`;
      }
      const after = await reader.next(WATCH_MS);
      await reader.cancel();
      return after.kind === "timeout" ? "open" : `cut (${after.kind})`;
    };

    const [control, exempt, written] = await Promise.all([
      watch("/control"),
      watch("/exempt"),
      watch("/written"),
    ]);
    expect(control).toMatch(/^cut/);
    expect(exempt).toBe("open");
    expect(written).toBe("open");
  }, 20_000);
});

describe("a handler that awaits its own stream streams while it runs", () => {
  for (const mode of MODES) {
    it(`${mode}: res.write() events arrive before the handler returns`, async () => {
      const g = gate(4000);
      const t = await target(mode, (router) => {
        router.get("/await-write", async (_req, res) => {
          res.setHeader("Content-Type", "text/event-stream");
          res.write("data: 1\n\n");
          await g.wait;
          await res.end("data: 2\n\n");
        });
      });

      const response = await t.get("/await-write");
      const reader = sseReader(response.body);
      const first = await reader.next();
      // Read while the handler is still parked on its gate.
      const releasedAtFirstEvent = g.state.released;
      g.release();
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(first).toEqual({ kind: "event", block: "data: 1" });
      expect(releasedAtFirstEvent).toBe(false);
      expect(await reader.next()).toEqual({ kind: "event", block: "data: 2" });
      expect(await reader.next()).toEqual({ kind: "done" });
    });

    it(`${mode}: a sent ReadableStream streams before the handler returns`, async () => {
      const g = gate(4000);
      const t = await target(mode, (router) => {
        router.get("/await-send", async (_req, res) => {
          let controller!: ReadableStreamDefaultController<Uint8Array>;
          res.setHeader("Content-Type", "text/event-stream");
          res.send(
            new ReadableStream<Uint8Array>({
              start(c) {
                controller = c;
                c.enqueue(encoder.encode("data: 1\n\n"));
              },
            }),
          );
          await g.wait;
          controller.enqueue(encoder.encode("data: 2\n\n"));
          controller.close();
        });
      });

      const response = await t.get("/await-send");
      const reader = sseReader(response.body);
      const first = await reader.next();
      const releasedAtFirstEvent = g.state.released;
      g.release();
      expect(first).toEqual({ kind: "event", block: "data: 1" });
      expect(releasedAtFirstEvent).toBe(false);
      expect(await reader.next()).toEqual({ kind: "event", block: "data: 2" });
      expect(await reader.next()).toEqual({ kind: "done" });
    });
  }

  it("a buffered response from a still-running handler waits for it, as before", async () => {
    const order: string[] = [];
    const router = new BunRouter();
    router.get("/buffered", async (_req, res) => {
      res.send("body");
      await Bun.sleep(20);
      order.push("handler returned");
    });
    const response = await router.fetch("/buffered");
    order.push("response");
    expect(await response.text()).toBe("body");
    expect(order).toEqual(["handler returned", "response"]);
  });
});

describe("an error after the headers were sent (Express 5)", () => {
  /** How the route fails after its first event. */
  const SHAPES = {
    "write, then throw": (res: BunResponse) => {
      res.write("data: e1\n\n");
      throw new Error("boom");
    },
    "write, then next(err)": (res: BunResponse, next: NextFunction) => {
      res.write("data: e1\n\n");
      next(new Error("boom"));
    },
    "write, await, throw": async (res: BunResponse) => {
      res.write("data: e1\n\n");
      await Bun.sleep(30);
      throw new Error("boom");
    },
  } as const;

  for (const mode of MODES) {
    for (const [shape, fail] of Object.entries(SHAPES)) {
      it(`${mode}: ${shape} runs the error handler (headersSent true), then cuts the stream`, async () => {
        const seen: boolean[] = [];
        const t = await target(mode, (router) => {
          router.get("/fail", (_req, res, next) => fail(res, next));
          router.use(((error, _req, res, next) => {
            seen.push(res.headersSent);
            // The documented pattern: once headers are out, delegate.
            next(error as Error);
          }) satisfies RouterErrorMiddlewareHandler);
        });

        const response = await within(t.get("/fail"), 5000);
        expect(response?.status).toBe(200);
        const reader = sseReader(response!.body);
        expect(await reader.next()).toEqual({
          kind: "event",
          block: "data: e1",
        });
        // Cut, as Express's finalhandler destroys the socket: not a clean end
        // (a client must not take it for a completed stream), not left open.
        expect(await reader.next()).toEqual({ kind: "error" });
        expect(seen).toEqual([true]);
      });
    }

    it(`${mode}: an error handler that ends the stream itself closes it cleanly`, async () => {
      const t = await target(mode, (router) => {
        router.get("/fail", (_req, res) => {
          res.write("data: e1\n\n");
          throw new Error("boom");
        });
        router.use(((error, _req, res, _next) => {
          void res.end(`event: error\ndata: ${(error as Error).message}\n\n`);
        }) satisfies RouterErrorMiddlewareHandler);
      });

      const reader = sseReader((await t.get("/fail")).body);
      expect(await reader.next()).toEqual({ kind: "event", block: "data: e1" });
      expect(await reader.next()).toEqual({
        kind: "event",
        block: "event: error\ndata: boom",
      });
      expect(await reader.next()).toEqual({ kind: "done" });
    });

    it(`${mode}: with no error handler the stream is cut, not left open`, async () => {
      const t = await target(mode, (router) => {
        router.get("/fail", async (_req, res) => {
          res.write("data: e1\n\n");
          await Bun.sleep(30);
          throw new Error("boom");
        });
      });

      const reader = sseReader((await t.get("/fail")).body);
      expect(await reader.next()).toEqual({ kind: "event", block: "data: e1" });
      expect(await reader.next()).toEqual({ kind: "error" });
    });

    it(`${mode}: send(), then throw: the handler runs and the sent body stands`, async () => {
      const seen: boolean[] = [];
      const t = await target(mode, (router) => {
        router.get("/sent", (_req, res) => {
          res.send("sent");
          throw new Error("late");
        });
        router.use(((error, _req, res, next) => {
          seen.push(res.headersSent);
          next(error as Error);
        }) satisfies RouterErrorMiddlewareHandler);
      });

      const response = await within(t.get("/sent"), 5000);
      expect(response?.status).toBe(200);
      expect(await response?.text()).toBe("sent");
      expect(seen).toEqual([true]);
    });
  }

  it("logs the unhandled error, outside NODE_ENV=test", async () => {
    const { logger, events } = createTestLogger();
    const router = new BunRouter({ logger });
    router.get("/fail", (_req, res) => {
      res.write("data: e1\n\n");
      throw new Error("boom");
    });

    const previous = Bun.env.NODE_ENV;
    Bun.env.NODE_ENV = "production";
    try {
      const reader = sseReader((await router.fetch("/fail")).body);
      expect(await reader.next()).toEqual({ kind: "event", block: "data: e1" });
      expect(await reader.next()).toEqual({ kind: "error" });
    } finally {
      Bun.env.NODE_ENV = previous;
    }
    const logged = events.filter((event) => event.level === "error");
    expect(logged).toHaveLength(1);
    expect(logged[0]?.error).toMatchObject({ message: "boom" });
    expect(logged[0]?.fields).toMatchObject({ method: "GET", path: "/fail" });
  });
});

describe("writableEnded", () => {
  it("is false until a body is sent, as Node's", async () => {
    const res = await makeResponse();
    expect(res.writableEnded).toBe(false);
    res.send("x");
    expect(res.writableEnded).toBe(true);
  });

  it("on a stream, is false while open and true once end() is called", async () => {
    const res = await makeResponse();
    res.write("a");
    expect(res.writableEnded).toBe(false);
    void res.end();
    expect(res.writableEnded).toBe(true);
  });

  it("is unaffected by setKeepAlive(true)", async () => {
    const res = await makeResponse();
    res.req.socket.setKeepAlive(true);
    expect(res.writableEnded).toBe(false);
  });
});
