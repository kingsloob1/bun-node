/**
 * The adapter's two request-path hooks (bun-security PR-P2):
 * `addBeforeReadHook`, run before the adapter reads anything of a request,
 * and `addBeforeWriteHook`, run on every response before it is written.
 */
import type { BeforeWriteContext, BeforeWritePhase } from "../lib/index";
import type { Server } from "bun";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter, BunRequest, createTestLogger } from "../lib/index";

/** Adapters a test started listening, closed after it. */
const listening: BunHttpAdapter[] = [];

afterEach(async () => {
  for (const adapter of listening.splice(0)) {
    await adapter.close();
  }
});

/** Starts `adapter` on an OS-assigned loopback port; closed after the test. */
async function serve(adapter: BunHttpAdapter): Promise<number> {
  listening.push(adapter);
  const server = await adapter.listen(0, "127.0.0.1");
  return Number(server.port);
}

/**
 * Writes `payload` to a raw TCP connection to `port` and collects what comes
 * back until the server closes it or `waitMs` passes.
 */
function rawExchange(
  port: number,
  payload: string,
  waitMs = 400,
): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let text = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (closed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ text, closed });
    };
    timer = setTimeout(() => finish(false), waitMs);
    socket.on("data", (chunk) => (text += chunk.toString()));
    socket.on("close", () => finish(true));
    socket.on("error", () => finish(true));
    socket.write(payload);
  });
}

/** Exposes the served request path, to tell a `Response` from a promise. */
class Probe extends BunHttpAdapter {
  /** `serveNativeRequest` with a stub server reporting no peer. */
  serve(request: Request) {
    return this.serveNativeRequest(request, {
      requestIP: () => null,
      upgrade: () => false,
    } as unknown as Server<never>);
  }
}

/** A `Response` whose body errors before its first byte: `Bun.serve` closes the connection. */
function dropResponse(): Response {
  return new Response(
    new ReadableStream({
      pull(controller) {
        controller.error();
      },
    }),
  );
}

describe("addBeforeReadHook: before the request is read", () => {
  it("answers before the body arrives: a POST whose body is never sent", async () => {
    const adapter = new BunHttpAdapter();
    adapter.post("/upload", (req, res) => res.json(req.body));
    adapter.addBeforeReadHook(
      (request) =>
        new Response("refused", {
          status: 403,
          headers: { "x-m": request.method },
        }),
    );
    const port = await serve(adapter);
    const { text } = await rawExchange(
      port,
      "POST /upload HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n",
    );
    expect(text).toStartWith("HTTP/1.1 403");
    expect(text).toContain("x-m: POST");
    expect(text).toEndWith("refused");
  });

  it("negative control: without the hook the same request waits for its body", async () => {
    const adapter = new BunHttpAdapter();
    adapter.post("/upload", (req, res) => res.json(req.body));
    const port = await serve(adapter);
    const { text, closed } = await rawExchange(
      port,
      "POST /upload HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n",
    );
    expect(text).toBe("");
    expect(closed).toBe(false);
  });

  it("never pulls the request body when it answers (socket-free)", async () => {
    let pulls = 0;
    const body = () =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new TextEncoder().encode('{"a":1}'));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
    const adapter = new BunHttpAdapter();
    adapter.post("/x", (req, res) => res.json(req.body));
    const remove = adapter.addBeforeReadHook(
      () => new Response(null, { status: 403 }),
    );
    const refused = await adapter.fetch("/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body(),
    });
    expect(refused.status).toBe(403);
    expect(pulls).toBe(0);
    // Negative control: let through, the same body is read.
    remove();
    const read = await adapter.fetch("/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body(),
    });
    expect(await read.json()).toEqual({ a: 1 });
    expect(pulls).toBe(1);
  });

  it("runs ahead of the payload guard and body parsing: a refusal, not a 413 or a 400", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: { maxContentLength: 10 } },
    });
    adapter.post("/x", (req, res) => res.json(req.body));
    const big = {
      method: "POST",
      body: "x".repeat(100),
      headers: { "content-type": "text/plain" },
    };
    const malformed = {
      method: "POST",
      body: "{nope",
      headers: { "content-type": "application/json" },
    };
    // Negative controls first: what the adapter answers once it reads them.
    expect((await adapter.fetch("/x", big)).status).toBe(413);
    expect((await adapter.fetch("/x", malformed)).status).toBe(400);
    adapter.addBeforeReadHook(() => new Response(null, { status: 403 }));
    expect((await adapter.fetch("/x", big)).status).toBe(403);
    expect((await adapter.fetch("/x", malformed)).status).toBe(403);
  });

  it("runs before every middleware, route, throttle and not-found handler", async () => {
    const ran: string[] = [];
    const adapter = new BunHttpAdapter(0, {
      throttle: { limits: { default: { limit: 1, window: "1m" } } },
    });
    adapter.use((_req, _res, next) => {
      ran.push("middleware");
      next();
    });
    adapter.get("/x", (_req, res) => {
      ran.push("route");
      res.send("ok");
    });
    adapter.setNotFoundHandler((_req, res) => {
      ran.push("not-found");
      res.status(404).send("nf");
    });
    adapter.addBeforeReadHook(() => new Response("early", { status: 451 }));
    for (const path of ["/x", "/x", "/missing"]) {
      const res = await adapter.fetch(path);
      expect(res.status).toBe(451);
      expect(await res.text()).toBe("early");
    }
    expect(ran).toEqual([]);
  });

  it("lets the request through when it returns nothing, and the route sees the same Request object", async () => {
    const seen = new WeakMap<Request, string>();
    const adapter = new BunHttpAdapter();
    adapter.post("/x", (req, res) => {
      res.json({ note: seen.get(req.request), body: req.body });
    });
    adapter.addBeforeReadHook((request) => {
      seen.set(request, `${request.method} ${new URL(request.url).pathname}`);
    });
    const res = await adapter.fetch("/x", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(await res.json()).toEqual({ note: "POST /x", body: { a: 1 } });
  });

  it("runs hooks in registration order; the first answer ends the request", async () => {
    const order: string[] = [];
    const adapter = new BunHttpAdapter();
    adapter.get("/x", (_req, res) => res.send("route"));
    adapter.addBeforeReadHook(() => {
      order.push("a");
    });
    adapter.addBeforeReadHook(() => {
      order.push("b");
      return new Response("b", { status: 403 });
    });
    adapter.addBeforeReadHook(() => {
      order.push("c");
    });
    const res = await adapter.fetch("/x");
    expect(await res.text()).toBe("b");
    expect(order).toEqual(["a", "b"]);
  });

  it("holds the request while a promise is pending (a delay), then continues or answers", async () => {
    const order: string[] = [];
    const adapter = new BunHttpAdapter();
    adapter.get("/x", (_req, res) => {
      order.push("route");
      res.send("route");
    });
    adapter.addBeforeReadHook(async () => {
      await Bun.sleep(30);
      order.push("held");
    });
    adapter.addBeforeReadHook((request) => {
      order.push("second");
      return new URL(request.url).searchParams.has("refuse")
        ? Promise.resolve(new Response("later", { status: 429 }))
        : undefined;
    });
    const started = performance.now();
    const passed = await adapter.fetch("/x");
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    expect(await passed.text()).toBe("route");
    expect(order).toEqual(["held", "second", "route"]);
    order.length = 0;
    const refused = await adapter.fetch("/x?refuse");
    expect(refused.status).toBe(429);
    expect(await refused.text()).toBe("later");
    expect(order).toEqual(["held", "second"]);
  });

  it("keeps the synchronous path synchronous while every hook is", async () => {
    const adapter = new Probe(0);
    adapter.get("/x", (_req, res) => res.send("sync"));
    adapter.addBeforeReadHook(() => undefined);
    const served = adapter.serve(new Request("http://localhost/x"));
    expect(served).toBeInstanceOf(Response);
    const answered = new Probe(0);
    answered.addBeforeReadHook(() => new Response("early"));
    const early = answered.serve(new Request("http://localhost/x"));
    expect(early).toBeInstanceOf(Response);
    expect(await (early as Response).text()).toBe("early");
  });

  it("sends a throw or rejection to the final error handling, without the error handlers", async () => {
    const handled: unknown[] = [];
    const adapter = new BunHttpAdapter();
    adapter.get("/x", (_req, res) => res.send("route"));
    adapter.setErrorHandler((error, _req, res) => {
      handled.push(error);
      res.status(599).send("handler");
    });
    let mode: "throw" | "status" | "reject" | "bad" = "throw";
    adapter.addBeforeReadHook(() => {
      if (mode === "throw") throw new Error("boom");
      if (mode === "status")
        throw Object.assign(new Error("slow"), { status: 429 });
      if (mode === "reject") return Promise.reject(new Error("later"));
      return "not a response" as unknown as Response;
    });
    expect((await adapter.fetch("/x")).status).toBe(500);
    mode = "status";
    expect((await adapter.fetch("/x")).status).toBe(429);
    mode = "reject";
    expect((await adapter.fetch("/x")).status).toBe(500);
    // A result that is neither a Response nor nothing is an error, not a pass.
    mode = "bad";
    const bad = await adapter.fetch("/x");
    expect(bad.status).toBe(500);
    expect(handled).toEqual([]);
  });

  it("fails a hold past the adapter's requestTimeout as a timed-out handler is answered", async () => {
    const adapter = new BunHttpAdapter(40);
    adapter.get("/hang", () => {});
    adapter.get("/x", (_req, res) => res.send("route"));
    const handler = await adapter.fetch("/hang");
    adapter.addBeforeReadHook((request) =>
      new URL(request.url).pathname === "/x"
        ? new Promise<undefined>(() => {})
        : undefined,
    );
    const held = await adapter.fetch("/x");
    expect(held.status).toBe(handler.status);
    expect(held.status).toBe(500);
  });

  it("is removed by the function it returns; removing twice is harmless", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/x", (_req, res) => res.send("route"));
    // The same function added twice: one remover takes one registration.
    let calls = 0;
    const counting = () => {
      calls++;
    };
    const removeFirst = adapter.addBeforeReadHook(counting);
    const removeSecond = adapter.addBeforeReadHook(counting);
    await adapter.fetch("/x");
    expect(calls).toBe(2);
    removeFirst();
    await adapter.fetch("/x");
    expect(calls).toBe(3);
    removeSecond();
    const removeA = adapter.addBeforeReadHook(() => new Response("a"));
    const removeB = adapter.addBeforeReadHook(() => new Response("b"));
    expect(await (await adapter.fetch("/x")).text()).toBe("a");
    removeA();
    removeA();
    expect(await (await adapter.fetch("/x")).text()).toBe("b");
    removeB();
    expect(await (await adapter.fetch("/x")).text()).toBe("route");
  });

  it("is given the server, which reports the peer: a socket-free one, and a served one", async () => {
    const peers: (string | undefined)[] = [];
    const adapter = new BunHttpAdapter();
    adapter.get("/x", (_req, res) => res.send("ok"));
    adapter.addBeforeReadHook((request, server) => {
      peers.push(server.requestIP(request)?.address);
    });
    await adapter.fetch("/x", { remoteAddress: "10.0.0.4" });
    await adapter.fetch("/x");
    const port = await serve(adapter);
    await fetch(`http://127.0.0.1:${port}/x`);
    expect(peers).toEqual(["10.0.0.4", undefined, "127.0.0.1"]);
  });

  it("closes the connection with no answer when it answers with a body that errors (a drop)", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/x", (_req, res) => res.send("ok"));
    adapter.addBeforeReadHook((request) =>
      new URL(request.url).pathname === "/drop" ? dropResponse() : undefined,
    );
    const port = await serve(adapter);
    const dropped = await rawExchange(
      port,
      "GET /drop HTTP/1.1\r\nHost: a\r\n\r\n",
    );
    expect(dropped).toEqual({ text: "", closed: true });
    // Negative control: the same connection shape, let through, is answered.
    const answered = await rawExchange(
      port,
      "GET /x HTTP/1.1\r\nHost: a\r\n\r\n",
    );
    expect(answered.text).toStartWith("HTTP/1.1 200");
  });

  it("keeps a connection serving after answering a request whose body it never read", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/next", (_req, res) => res.send("next"));
    adapter.addBeforeReadHook((request) =>
      request.method === "POST"
        ? new Response("refused", { status: 403 })
        : undefined,
    );
    const port = await serve(adapter);
    const body = "a".repeat(65536);
    const { text } = await rawExchange(
      port,
      `POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: ${body.length}\r\n\r\n${body}GET /next HTTP/1.1\r\nHost: a\r\n\r\n`,
    );
    expect(text).toStartWith("HTTP/1.1 403");
    expect(text).toContain("refused");
    expect(text).toContain("HTTP/1.1 200");
    expect(text).toEndWith("next");
  });

  it("sees WebSocket upgrade requests, and can refuse one", async () => {
    const adapter = new BunHttpAdapter();
    adapter.ws("/socket", {
      open(ws) {
        ws.send("hello");
      },
      message() {},
    });
    const upgrades: string[] = [];
    adapter.addBeforeReadHook((request) => {
      if (request.headers.get("upgrade") === "websocket") {
        const url = new URL(request.url);
        upgrades.push(url.pathname + url.search);
        if (url.searchParams.has("refuse")) {
          return new Response(null, { status: 403 });
        }
      }
    });
    const port = await serve(adapter);
    const opened = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`);
      socket.onmessage = (event) => {
        resolve(String(event.data));
        socket.close();
      };
      socket.onerror = () => reject(new Error("refused"));
    });
    expect(opened).toBe("hello");
    const refused = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/socket?refuse`);
      socket.onopen = () => resolve("open");
      socket.onerror = () => resolve("error");
    });
    expect(refused).toBe("error");
    expect(upgrades).toEqual(["/socket", "/socket?refuse"]);
  });
});

describe("addBeforeWriteHook: every response before it is written", () => {
  /** An adapter recording each check's phase, status and whether it carried a req/res. */
  function recording(adapter: BunHttpAdapter) {
    const seen: {
      phase: BeforeWritePhase;
      status: number;
      req: boolean;
      res: boolean;
    }[] = [];
    adapter.addBeforeWriteHook(({ phase, response, req, res }) => {
      seen.push({
        phase,
        status: response.status,
        req: req !== undefined,
        res: res !== undefined,
      });
      response.headers.set("x-checked", phase);
    });
    return seen;
  }

  it("reaches every kind of answer: a route's, the bare 404, a not-found handler's, an error's, the 413, an early one", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: { maxContentLength: 10 } },
    });
    adapter.get("/ok", (_req, res) => res.send("ok"));
    adapter.get("/boom", () => {
      throw new Error("boom");
    });
    adapter.post("/big", (_req, res) => res.send("never"));
    adapter.addBeforeReadHook((request) =>
      new URL(request.url).pathname === "/early"
        ? new Response("early", { status: 403 })
        : undefined,
    );
    const seen = recording(adapter);
    const answers: [string, number, string][] = [];
    for (const [path, init] of [
      ["/ok", undefined],
      ["/missing", undefined],
      ["/boom", undefined],
      [
        "/big",
        {
          method: "POST",
          body: "x".repeat(100),
          headers: { "content-type": "text/plain" },
        },
      ],
      ["/early", undefined],
    ] as const) {
      const res = await adapter.fetch(path, init);
      answers.push([path, res.status, res.headers.get("x-checked") ?? ""]);
    }
    expect(answers).toEqual([
      ["/ok", 200, "response"],
      ["/missing", 404, "response"],
      ["/boom", 500, "error"],
      ["/big", 413, "error"],
      ["/early", 403, "early"],
    ]);
    expect(seen).toEqual([
      { phase: "response", status: 200, req: true, res: true },
      { phase: "response", status: 404, req: true, res: true },
      { phase: "error", status: 500, req: true, res: false },
      { phase: "error", status: 413, req: true, res: false },
      { phase: "early", status: 403, req: false, res: false },
    ]);
    // A not-found handler's answer is the request's own.
    adapter.setNotFoundHandler((_req, res) => {
      res.status(404).send("custom");
    });
    const custom = await adapter.fetch("/missing");
    expect(await custom.text()).toBe("custom");
    expect(custom.headers.get("x-checked")).toBe("response");
  });

  it("writes a header changed in place over a real socket, on a route's answer and on an error's", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/ok", (_req, res) => res.send("ok"));
    adapter.get("/redirect", (_req, res) => res.redirect("/ok"));
    adapter.get("/boom", () => {
      throw new Error("boom");
    });
    const requests: string[] = [];
    adapter.addBeforeWriteHook(({ response, request, phase }) => {
      requests.push(`${phase} ${new URL(request.url).pathname}`);
      response.headers.set("x-content-type-options", "nosniff");
    });
    const port = await serve(adapter);
    for (const path of ["/ok", "/redirect", "/boom"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        redirect: "manual",
      });
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(requests).toEqual([
      "response /ok",
      "response /redirect",
      "error /boom",
    ]);
  });

  it("over a real socket, sees the answer to an error raised before the request was built", async () => {
    const adapter = new BunHttpAdapter();
    adapter.addBeforeReadHook(() => {
      throw Object.assign(new Error("engine failed"), { status: 503 });
    });
    const seen: [BeforeWritePhase, string, boolean][] = [];
    adapter.addBeforeWriteHook(({ phase, request, req, response }) => {
      seen.push([phase, new URL(request.url).pathname, req === undefined]);
      response.headers.set("x-checked", phase);
    });
    const port = await serve(adapter);
    const res = await fetch(`http://127.0.0.1:${port}/x`);
    expect(res.status).toBe(503);
    expect(res.headers.get("x-checked")).toBe("error");
    expect(seen).toEqual([["error", "/x", true]]);
  });

  it("replaces the response with one it returns; later hooks see the replacement", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/x", (_req, res) => res.status(201).send("original"));
    const statuses: number[] = [];
    adapter.addBeforeWriteHook(
      ({ response }) =>
        new Response(response.body, {
          status: 202,
          headers: { "x-replaced": "1" },
        }),
    );
    adapter.addBeforeWriteHook(({ response }) => {
      statuses.push(response.status);
    });
    const res = await adapter.fetch("/x");
    expect(res.status).toBe(202);
    expect(res.headers.get("x-replaced")).toBe("1");
    expect(await res.text()).toBe("original");
    expect(statuses).toEqual([202]);
  });

  it("refuses a response with a throw: the error handlers get the error and the request, and their answer is checked in phase error", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/x", (_req, res) => res.send("secret"));
    const handled: { message: string; path: string }[] = [];
    adapter.setErrorHandler((error, req, res) => {
      handled.push({ message: (error as Error).message, path: req.path });
      res.status(502).send("handled");
    });
    const phases: BeforeWritePhase[] = [];
    adapter.addBeforeWriteHook(({ phase }) => {
      phases.push(phase);
      if (phase === "response") throw new Error("leaks a secret");
    });
    const res = await adapter.fetch("/x");
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("handled");
    expect(handled).toEqual([{ message: "leaks a secret", path: "/x" }]);
    expect(phases).toEqual(["response", "error"]);
  });

  it("refuses with a rejection too, answered by the final handling with the error's status when nothing handles it", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/x", (_req, res) => res.send("x"));
    adapter.addBeforeWriteHook(({ phase }) =>
      phase === "response"
        ? Promise.reject(Object.assign(new Error("no"), { status: 422 }))
        : undefined,
    );
    const res = await adapter.fetch("/x");
    expect(res.status).toBe(422);
  });

  it("logs a refusal in phases early and error, never applying it", async () => {
    const { logger, events } = createTestLogger();
    const adapter = new BunHttpAdapter(0, { logger });
    adapter.get("/boom", () => {
      throw Object.assign(new Error("boom"), { status: 503 });
    });
    adapter.addBeforeReadHook((request) =>
      new URL(request.url).pathname === "/early"
        ? new Response("early", { status: 403 })
        : undefined,
    );
    adapter.addBeforeWriteHook(({ phase, response }) => {
      response.headers.set("x-before", "1");
      if (phase !== "response") throw new Error(`refuse ${phase}`);
    });
    const ran: string[] = [];
    adapter.addBeforeWriteHook(({ phase }) => {
      ran.push(phase);
    });
    const early = await adapter.fetch("/early");
    expect([
      early.status,
      await early.text(),
      early.headers.get("x-before"),
    ]).toEqual([403, "early", "1"]);
    const error = await adapter.fetch("/boom");
    expect([error.status, error.headers.get("x-before")]).toEqual([503, "1"]);
    expect(ran).toEqual([]);
    const refusals = events.filter((event) =>
      event.message.startsWith("A before-write hook refused"),
    );
    expect(refusals.map((event) => event.error?.message)).toEqual([
      "refuse early",
      "refuse error",
    ]);
  });

  it("sees a stream as it opens, before its first byte, and the stream still arrives whole", async () => {
    const adapter = new BunHttpAdapter();
    let checked = 0;
    adapter.get("/stream", async (_req, res) => {
      res.setHeader("content-type", "text/plain");
      for (let i = 0; i < 3; i++) {
        void res.write(`chunk${i};`);
        await Bun.sleep(5);
      }
      void res.end();
    });
    adapter.addBeforeWriteHook(({ response }) => {
      checked++;
      // A header set here arrives, so the check came before the head was written.
      response.headers.set("x-checked", "stream");
    });
    const port = await serve(adapter);
    const res = await fetch(`http://127.0.0.1:${port}/stream`);
    expect(res.headers.get("x-checked")).toBe("stream");
    expect(await res.text()).toBe("chunk0;chunk1;chunk2;");
    // Once, as it opened: its chunks are not seen.
    expect(checked).toBe(1);
  });

  it("refuses a stream as it opens: it is destroyed and the error handling answers", async () => {
    const adapter = new BunHttpAdapter();
    const handlerSaw = Promise.withResolvers<boolean>();
    adapter.get("/stream", async (_req, res) => {
      void res.write("secret");
      await Bun.sleep(30);
      // What the handler finds once the check has run: its stream gone.
      handlerSaw.resolve(res.destroyed);
      void res.end();
    });
    adapter.addBeforeWriteHook(({ phase }) => {
      if (phase === "response")
        throw Object.assign(new Error("no stream"), { status: 451 });
    });
    const port = await serve(adapter);
    const res = await fetch(`http://127.0.0.1:${port}/stream`);
    expect(res.status).toBe(451);
    expect(await res.text()).not.toContain("secret");
    expect(await handlerSaw.promise).toBe(true);
  });

  it("holds a response while a promise is pending; past requestTimeout it is refused as timed out", async () => {
    const adapter = new BunHttpAdapter(60);
    adapter.get("/x", (_req, res) => res.send("x"));
    let hold = 10;
    adapter.addBeforeWriteHook(async ({ phase, response }) => {
      if (phase !== "response") return;
      await Bun.sleep(hold);
      response.headers.set("x-held", String(hold));
    });
    const quick = await adapter.fetch("/x");
    expect([
      quick.status,
      quick.headers.get("x-held"),
      await quick.text(),
    ]).toEqual([200, "10", "x"]);
    hold = 500;
    const slow = await adapter.fetch("/x");
    expect(slow.status).toBe(500);
    expect(slow.headers.get("x-held")).toBeNull();
  });

  it("keeps the synchronous path synchronous while every hook is", () => {
    const adapter = new Probe(0);
    adapter.get("/x", (_req, res) => res.send("sync"));
    adapter.addBeforeWriteHook(({ response }) => {
      response.headers.set("x-sync", "1");
    });
    const served = adapter.serve(new Request("http://localhost/x"));
    expect(served).toBeInstanceOf(Response);
    expect((served as Response).headers.get("x-sync")).toBe("1");
  });

  it("sees a HEAD answer as the route produced it, and the body is still dropped", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/x", (_req, res) => res.send("body"));
    const seen: [string, number][] = [];
    adapter.addBeforeWriteHook(({ request, response }) => {
      seen.push([request.method, response.status]);
    });
    const res = await adapter.fetch("/x", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(seen).toEqual([["HEAD", 200]]);
  });

  it("treats a result that is neither a Response nor nothing as a refusal", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/x", (_req, res) => res.send("x"));
    adapter.addBeforeWriteHook(({ phase }) =>
      phase === "response" ? ("oops" as unknown as Response) : undefined,
    );
    expect((await adapter.fetch("/x")).status).toBe(500);
  });

  it("runs in registration order, the first refusal stopping the rest, and is removed by its remover", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/x", (_req, res) => res.send("x"));
    const order: string[] = [];
    const removeA = adapter.addBeforeWriteHook(({ phase }) => {
      if (phase === "response") order.push("a");
    });
    const removeB = adapter.addBeforeWriteHook(({ phase }) => {
      if (phase !== "response") return;
      order.push("b");
      throw new Error("b refuses");
    });
    adapter.addBeforeWriteHook(({ phase }) => {
      if (phase === "response") order.push("c");
    });
    expect((await adapter.fetch("/x")).status).toBe(500);
    expect(order).toEqual(["a", "b"]);
    order.length = 0;
    removeB();
    removeB();
    removeA();
    expect((await adapter.fetch("/x")).status).toBe(200);
    expect(order).toEqual(["c"]);
  });

  it("is not called for a successful WebSocket upgrade, which writes no response", async () => {
    const adapter = new BunHttpAdapter();
    adapter.ws("/socket", {
      open(ws) {
        ws.send("hi");
      },
      message() {},
    });
    const checked: string[] = [];
    adapter.addBeforeWriteHook(({ request }) => {
      checked.push(new URL(request.url).pathname);
    });
    const port = await serve(adapter);
    const message = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`);
      socket.onmessage = (event) => {
        resolve(String(event.data));
        socket.close();
      };
      socket.onerror = () => reject(new Error("upgrade failed"));
    });
    expect(message).toBe("hi");
    expect(checked).toEqual([]);
  });

  it("gives the context the request as received and the adapter's BunRequest", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/x", (_req, res) => res.send("x"));
    let context: BeforeWriteContext | undefined;
    let native: Request | undefined;
    adapter.addBeforeReadHook((request) => {
      native = request;
    });
    adapter.addBeforeWriteHook((ctx) => {
      context = ctx;
    });
    await adapter.fetch("/x");
    expect(native).toBeInstanceOf(Request);
    expect(context?.request).toBe(native);
    expect(context?.req).toBeInstanceOf(BunRequest);
    expect(context?.req?.request).toBe(native);
    expect(context?.res?.req).toBe(context?.req);
  });
});
