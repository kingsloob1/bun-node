/**
 * `res.sse()` and `sseResponse()` (bun-native-routes plan §16.3, §16.6,
 * §16.7): each case served over a socket, through `adapter.fetch()` and
 * through `router.fetch()`, asserting the same outcome (`fetch()` parity),
 * plus what only a socket shows: the idle-timeout exemption, with its
 * control, and a native `Bun.serve` route.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunHttpAdapter } from "../../lib/BunHttpAdapter";
import { BunRouter } from "../../lib/BunRouter";
import { validate } from "../../lib/BunValidate";
import { compression } from "../../lib/compression";
import { createTestLogger } from "../../lib/logging";
import { sse } from "../../lib/responseBodies";
import { ResponseValidationError } from "../../lib/responseValidation";
import { readSse, sseResponse } from "../../lib/sse";

type Mode = "served" | "adapter.fetch()" | "router.fetch()";
const MODES: Mode[] = ["served", "adapter.fetch()", "router.fetch()"];

/** Adapters and servers to close after each test. */
const open: { close: () => unknown }[] = [];

afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

/** Requests on routes `build` registers, the way `mode` says. */
async function target(
  mode: Mode,
  build: (router: BunRouter) => void,
  options?: ConstructorParameters<typeof BunHttpAdapter>[1],
): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  if (mode === "router.fetch()") {
    const router = new BunRouter();
    build(router);
    return async (path, init) => router.fetch(path, init);
  }
  const adapter = new BunHttpAdapter(0, options);
  build(adapter);
  if (mode === "adapter.fetch()") {
    return async (path, init) => adapter.fetch(path, init);
  }
  await adapter.listen(0);
  open.push(adapter);
  return async (path, init) =>
    fetch(`http://127.0.0.1:${adapter.listeningPort}${path}`, init);
}

/** The items (events and comments) of a body, read to its end. */
async function items(response: Response) {
  const out = [];
  for await (const item of readSse(response.body!)) out.push(item);
  return out;
}

/** A gate a handler parks on, released by the test (or after `ms`, so a regression fails rather than hangs). */
function gate(ms: number) {
  let release!: () => void;
  const state = { released: false };
  const wait = new Promise<void>((resolve) => {
    release = () => {
      state.released = true;
      resolve();
    };
  });
  setTimeout(() => release(), ms);
  return { wait, release, state };
}

const Events = sse({ tick: z.object({ n: z.number() }), gap: null });

describe("res.sse()", () => {
  for (const mode of MODES) {
    it(`${mode}: the headers, the opening and the events`, async () => {
      const get = await target(mode, (router) => {
        router.get("/events", (_req, res) => {
          const stream = res.sse({ contract: Events, ids: "auto" });
          void (async () => {
            for (let n = 1; n <= 3; n++) {
              await stream.send({ event: "tick", data: { n } });
            }
            stream.close();
          })();
        });
      });
      const response = await get("/events");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("cache-control")).toBe(
        "no-cache, no-transform",
      );
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      expect(response.headers.get("connection")).not.toBe("keep-alive-forced");
      expect(await items(response)).toEqual([
        { kind: "comment", text: " ok" },
        { kind: "event", event: "tick", data: '{"n":1}', id: "1" },
        { kind: "event", event: "tick", data: '{"n":2}', id: "2" },
        { kind: "event", event: "tick", data: '{"n":3}', id: "3" },
      ]);
    });

    it(`${mode}: keeps headers the handler set`, async () => {
      const get = await target(mode, (router) => {
        router.get("/events", (_req, res) => {
          res.setHeader("Cache-Control", "private");
          res.setHeader("X-Custom", "1");
          res.sse({ heartbeatMs: 0 }).close();
        });
      });
      const response = await get("/events");
      expect(response.headers.get("cache-control")).toBe("private");
      expect(response.headers.get("x-custom")).toBe("1");
      await response.text();
    });

    it(`${mode}: streams while the handler is still awaiting`, async () => {
      const g = gate(4000);
      const get = await target(mode, (router) => {
        router.get("/events", async (_req, res) => {
          const stream = res.sse({ heartbeatMs: 0 });
          void stream.send({ data: "first" });
          await g.wait;
          stream.close();
        });
      });
      const response = await get("/events");
      const reader = readSse(response.body!);
      expect((await reader.next()).value).toEqual({
        kind: "comment",
        text: " ok",
      });
      expect((await reader.next()).value).toMatchObject({ data: "first" });
      // Read while the handler is still parked.
      expect(g.state.released).toBe(false);
      g.release();
      expect((await reader.next()).done).toBe(true);
    });

    it(`${mode}: the client leaving closes the writer`, async () => {
      let closed!: () => void;
      const sawClose = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const get = await target(mode, (router) => {
        router.get("/events", (_req, res) => {
          const stream = res.sse({ heartbeatMs: 0 });
          stream.onClose(closed);
        });
      });
      const abort = new AbortController();
      const response = await get("/events", { signal: abort.signal });
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      abort.abort();
      expect(
        await Promise.race([
          sawClose.then(() => "closed"),
          Bun.sleep(5000).then(() => "open"),
        ]),
      ).toBe("closed");
    });

    it(`${mode}: resumes from Last-Event-ID, and sends the gap`, async () => {
      const get = await target(mode, (router) => {
        router.get("/events", (_req, res) => {
          const stream = res.sse({
            contract: Events,
            ids: "auto",
            resume: (id) =>
              id === "2" ? [{ event: "tick", data: { n: 3 } }] : "gap",
          });
          void stream.send({ event: "tick", data: { n: 100 } });
          stream.close();
        });
      });
      const resumed = await items(
        await get("/events", { headers: { "Last-Event-ID": "2" } }),
      );
      expect(resumed.filter((i) => i.kind === "event")).toEqual([
        { kind: "event", event: "tick", data: '{"n":3}', id: "3" },
        { kind: "event", event: "tick", data: '{"n":100}', id: "4" },
      ]);
      const gapped = await items(
        await get("/events", { headers: { "Last-Event-ID": "unknown" } }),
      );
      expect(
        gapped
          .filter((i) => i.kind === "event")
          .map((i) => i.kind === "event" && i.event),
      ).toEqual(["gap", "tick"]);
    });
  }

  it("throws when a response was already sent", async () => {
    const router = new BunRouter();
    let thrown: unknown;
    router.get("/x", (_req, res) => {
      res.send("done");
      try {
        res.sse();
      } catch (error) {
        thrown = error;
      }
    });
    expect(await (await router.fetch("/x")).text()).toBe("done");
    expect(thrown).toBeInstanceOf(Error);
  });

  it("compress: true lets compression() gzip it, flushed per event; the default opts out", async () => {
    const build = (compress: boolean) => (router: BunRouter) => {
      router.use(compression({ threshold: 0 }));
      router.get("/events", (_req, res) => {
        const stream = res.sse({ heartbeatMs: 0, compress });
        void stream.send({ data: "x".repeat(2000) }).then(() => stream.close());
      });
    };
    for (const compress of [true, false]) {
      const get = await target("served", build(compress));
      const response = await get("/events", {
        headers: { "Accept-Encoding": "gzip" },
      });
      expect(response.headers.get("content-encoding")).toBe(
        compress ? "gzip" : null,
      );
      expect(response.headers.get("cache-control")).toBe(
        compress ? "no-cache" : "no-cache, no-transform",
      );
      const events = (await items(response)).filter((i) => i.kind === "event");
      expect(events).toHaveLength(1);
    }
  });

  it("a declared response contract still checks the stream: the writer's refusal keeps it open where the gate's cuts it", async () => {
    const { logger, events } = createTestLogger();
    const router = new BunRouter({ logger, responseValidation: "error" });
    const declared = validate(
      {},
      { responses: { 200: { content: { "text/event-stream": Events } } } },
    );
    let refusedByWriter: unknown;
    router.get("/typed", declared, (_req, res) => {
      const stream = res.sse({ contract: Events, heartbeatMs: 0 });
      void (async () => {
        await stream.send({ event: "tick", data: { n: 1 } });
        try {
          void stream.send({
            event: "tick",
            data: { n: "bad" } as unknown as { n: number },
          });
        } catch (error) {
          refusedByWriter = error;
        }
        await stream.send({ event: "tick", data: { n: 2 } });
        stream.close();
      })();
    });
    // The control: the same bad event through an untyped writer reaches
    // the gate, which cuts the stream at it.
    router.get("/untyped", declared, (_req, res) => {
      const stream = res.sse({ heartbeatMs: 0 });
      void (async () => {
        await stream.send({ event: "tick", data: { n: 1 } });
        await stream.send({ event: "tick", data: { n: "bad" } });
        await stream.send({ event: "tick", data: { n: 2 } });
        stream.close();
      })();
    });
    router.get(
      "/undeclared",
      validate(
        {},
        {
          responses: { 200: { content: { "application/json": z.object({}) } } },
        },
      ),
      (_req, res) => {
        res.sse({ heartbeatMs: 0 }).close();
      },
    );

    const typed = await router.fetch("/typed");
    expect(typed.status).toBe(200);
    expect(
      (await items(typed))
        .filter((i) => i.kind === "event")
        .map((i) => i.kind === "event" && i.data),
    ).toEqual(['{"n":1}', '{"n":2}']);
    expect(refusedByWriter).toBeInstanceOf(Error);

    const untyped = await router.fetch("/untyped");
    const seen: string[] = [];
    try {
      for await (const item of readSse(untyped.body!)) {
        if (item.kind === "event") seen.push(item.data);
      }
    } catch {
      // Cut off at the bad event.
    }
    expect(seen).toEqual(['{"n":1}']);
    expect(events.some((e) => e.level === "error")).toBe(true);

    // The media type is not declared for the status: refused at the commit,
    // before anything was sent.
    // With no error handler, `router.fetch()` rejects with the refusal (an
    // adapter answers 500); the writer's body is cancelled with it, so the
    // orphaned writer closes rather than running on.
    let orphan: { closed: boolean } | undefined;
    router.get(
      "/undeclared-orphan",
      validate(
        {},
        {
          responses: { 200: { content: { "application/json": z.object({}) } } },
        },
      ),
      (_req, res) => {
        orphan = res.sse({ heartbeatMs: 0 });
      },
    );
    expect(
      await router.fetch("/undeclared").then(
        () => "resolved",
        (e: unknown) => e,
      ),
    ).toBeInstanceOf(ResponseValidationError);
    await router.fetch("/undeclared-orphan").catch(() => undefined);
    await Bun.sleep(0);
    expect(orphan?.closed).toBe(true);
  });
});

describe("the idle-timeout exemption", () => {
  // Bun sweeps idle connections on a 4 s tick that runs while any socket is
  // open. An `idleTimeout` of 1 to 4 cuts at the next tick, which can be
  // milliseconds after a connection opens (oven-sh/bun#46211); 5 cuts 4 to 8 s
  // after, so both clients get their first read whatever the tick's phase. The
  // control (a quiet stream nobody exempted) proves the timeout is live in this
  // server.
  it("served: a quiet res.sse() stream outlives idleTimeout; the control is cut", async () => {
    const get = await target(
      "served",
      (router) => {
        router.get("/control", (_req, res) => {
          res.setHeader("Content-Type", "text/event-stream");
          res.send(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(": open\n\n"));
              },
            }),
          );
        });
        router.get("/sse", (_req, res) => {
          res.sse({ heartbeatMs: 0 });
        });
      },
      { server: { idleTimeout: 5 } },
    );
    const watch = async (path: string): Promise<string> => {
      const reader = (await get(path)).body!.getReader();
      await reader.read();
      const after = await Promise.race([
        reader.read().then(
          (r) => (r.done ? "done" : "data"),
          () => "error",
        ),
        // Past the latest cut, 8 s, with room for a client slow to see it.
        Bun.sleep(13_000).then(() => "open"),
      ]);
      await reader.cancel().catch(() => undefined);
      return after;
    };
    const [control, exempt] = await Promise.all([
      watch("/control"),
      watch("/sse"),
    ]);
    expect(control).not.toBe("open");
    expect(exempt).toBe("open");
  }, 30_000);
});

describe("sseResponse()", () => {
  for (const mode of MODES) {
    it(`${mode}: an async iterable through res.send(), ending with it`, async () => {
      const get = await target(mode, (router) => {
        router.get("/ticks", (req, res) => {
          async function* ticks() {
            for (let n = 1; n <= 2; n++)
              yield { event: "tick" as const, data: { n } };
          }
          res.send(
            sseResponse(ticks(), {
              contract: Events,
              heartbeatMs: 0,
              request: req.request,
              headers: { "X-Feed": "ticks" },
            }),
          );
        });
      });
      const response = await get("/ticks");
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("x-feed")).toBe("ticks");
      expect(
        (await items(response)).filter((i) => i.kind === "event"),
      ).toHaveLength(2);
    });
  }

  it("a function source, a status, and an error that closes the stream (logged), or goes to onError", async () => {
    const { logger, events } = createTestLogger();
    const failing = sseResponse(
      async () => {
        throw new Error("source");
      },
      { heartbeatMs: 0, logger },
    );
    expect((await items(failing)).filter((i) => i.kind === "event")).toEqual(
      [],
    );
    expect(events.filter((e) => e.level === "error")).toHaveLength(1);

    const handled = sseResponse(
      // eslint-disable-next-line require-yield
      (async function* () {
        throw new Error("source");
      })(),
      {
        heartbeatMs: 0,
        status: 201,
        onError: (_error, writer) => {
          void writer.send({ event: "error", data: "unavailable" });
          writer.close();
        },
      },
    );
    expect(handled.status).toBe(201);
    expect((await items(handled)).filter((i) => i.kind === "event")).toEqual([
      { kind: "event", event: "error", data: "unavailable", id: "" },
    ]);
  });

  it("a native Bun.serve route, exempted through its server", async () => {
    let exempted = 0;
    const server = Bun.serve({
      port: 0,
      // Not 1 to 4, which can cut the connection before its first read.
      idleTimeout: 5,
      routes: {
        "/raw": (req, srv) =>
          sseResponse(
            (writer) => {
              void writer.send({ data: "hi" });
            },
            {
              heartbeatMs: 0,
              request: req,
              server: {
                timeout: (request, seconds) => {
                  exempted++;
                  srv.timeout(request, seconds);
                },
              },
            },
          ),
      },
    });
    open.push({ close: () => server.stop(true) });
    const response = await fetch(`http://127.0.0.1:${server.port}/raw`);
    const reader = readSse(response.body!);
    expect((await reader.next()).value).toEqual({
      kind: "comment",
      text: " ok",
    });
    expect((await reader.next()).value).toMatchObject({ data: "hi" });
    expect(exempted).toBe(1);
    await reader.return(undefined);
  });
});
