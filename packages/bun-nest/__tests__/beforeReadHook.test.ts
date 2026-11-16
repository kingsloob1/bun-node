/**
 * bun-nest's `addBeforeReadHook` (PR-S6): bun-common's before-read hook on
 * the Nest adapter, run before the adapter reads anything of a request.
 */
import type { Server } from "bun";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import "reflect-metadata";

/** Adapters a test started listening, closed after it. */
const listening: BunHttpAdapter[] = [];

afterEach(async () => {
  for (const adapter of listening.splice(0)) await adapter.close();
});

/** Exposes the served path, to tell a `Response` from a promise. */
class Probe extends BunHttpAdapter {
  /** `serveNativeRequest` with a stub server reporting no peer. */
  serve(request: Request) {
    return this.serveNativeRequest(request, {
      requestIP: () => null,
      upgrade: () => false,
    } as unknown as Server<never>);
  }
}

/** A body stream that counts its pulls. */
function countingBody(counter: { pulls: number }) {
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        counter.pulls++;
        controller.enqueue(new TextEncoder().encode('{"a":1}'));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

describe("BunHttpAdapter (bun-nest): addBeforeReadHook", () => {
  it("answers before the body is read, and nothing after it runs", async () => {
    const adapter = new BunHttpAdapter();
    const ran: string[] = [];
    adapter.use((_req, _res, next) => {
      ran.push("middleware");
      next();
    });
    adapter.post("/x", (req, res) => res.json(req.body));
    const counter = { pulls: 0 };
    const remove = adapter.addBeforeReadHook(
      (request) => new Response(`refused ${request.method}`, { status: 403 }),
    );
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
    };
    const refused = await adapter.fetch("/x", {
      ...init,
      body: countingBody(counter),
    });
    expect([refused.status, await refused.text()]).toEqual([
      403,
      "refused POST",
    ]);
    expect([counter.pulls, ran]).toEqual([0, []]);
    // Negative control: removed, the same request is read and routed.
    remove();
    remove();
    const read = await adapter.fetch("/x", {
      ...init,
      body: countingBody(counter),
    });
    expect(await read.json()).toEqual({ a: 1 });
    expect([counter.pulls, ran]).toEqual([1, ["middleware"]]);
  });

  it("answers over a socket before the body arrives", async () => {
    const adapter = new BunHttpAdapter();
    adapter.post("/x", (req, res) => res.json(req.body));
    adapter.addBeforeReadHook(() => new Response("no", { status: 403 }));
    listening.push(adapter);
    await adapter.listen(0, "127.0.0.1");
    const port = Number(adapter.getBunServer()?.port);
    const text = await new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      let out = "";
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(out);
      }, 400);
      socket.on("data", (chunk) => (out += chunk.toString()));
      socket.on("close", () => {
        clearTimeout(timer);
        resolve(out);
      });
      socket.write(
        "POST /x HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n",
      );
    });
    expect(text).toStartWith("HTTP/1.1 403");
  });

  it("runs in order, holds on a promise, passes on nothing, and stays synchronous while every hook is", async () => {
    const order: string[] = [];
    const adapter = new Probe();
    adapter.get("/x", (_req, res) => res.send("route"));
    adapter.addBeforeReadHook(() => {
      order.push("a");
    });
    expect(adapter.serve(new Request("http://localhost/x"))).toBeInstanceOf(
      Response,
    );
    adapter.addBeforeReadHook(async (request) => {
      await Bun.sleep(5);
      order.push("b");
      return new URL(request.url).searchParams.has("stop")
        ? new Response("held", { status: 429 })
        : undefined;
    });
    const passed = await adapter.serve(new Request("http://localhost/x"));
    expect(await passed?.text()).toBe("route");
    const stopped = await adapter.serve(new Request("http://localhost/x?stop"));
    expect([stopped?.status, await stopped?.text()]).toEqual([429, "held"]);
    expect(order).toEqual(["a", "a", "b", "a", "b"]);
  });

  it("sends a throw, a rejection or a wrong result to the error handling", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/x", (_req, res) => res.send("route"));
    let mode: "throw" | "status" | "bad" = "throw";
    adapter.addBeforeReadHook(() => {
      if (mode === "throw") throw new Error("boom");
      if (mode === "status")
        return Promise.reject(
          Object.assign(new Error("slow"), { status: 429 }),
        );
      return "nope" as unknown as Response;
    });
    expect((await adapter.fetch("/x")).status).toBe(500);
    mode = "status";
    expect((await adapter.fetch("/x")).status).toBe(429);
    mode = "bad";
    expect((await adapter.fetch("/x")).status).toBe(500);
  });

  it("fails a hold past requestTimeout", async () => {
    const adapter = new BunHttpAdapter(40);
    adapter.get("/x", (_req, res) => res.send("route"));
    adapter.addBeforeReadHook(() => new Promise<undefined>(() => {}));
    expect((await adapter.fetch("/x")).status).toBe(500);
  });

  it("is given the server, which reports the peer of a socket-free request", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/x", (_req, res) => res.send("ok"));
    const peers: (string | undefined)[] = [];
    adapter.addBeforeReadHook((request, server) => {
      peers.push(server.requestIP(request)?.address);
    });
    await adapter.fetch("/x", { remoteAddress: "10.0.0.4" });
    expect(peers).toEqual(["10.0.0.4"]);
  });
});
