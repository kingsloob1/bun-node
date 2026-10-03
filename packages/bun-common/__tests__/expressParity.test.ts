import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import net from "node:net";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { createTestLogger } from "../lib/logging";

/**
 * Express 5 behaviours the pipeline once departed from, each checked against
 * Express 5.1 on Node's http server when it was fixed:
 *
 * - `HEAD` to a route with only a GET handler runs the GET handler, and the
 *   server sends its headers without the body (it was a 404);
 * - a middleware may call `next()` later, from a callback (the request hung);
 * - an error raised after the response started still reaches the error
 *   handlers; with none to take it, a streamed response is cut off (the
 *   error was dropped and the stream left open).
 */

/** Sends one raw HTTP/1.1 request and returns everything the server wrote. */
function raw(port: number, head: string, waitMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(`TIMEOUT ${data}`);
    }, waitMs);
    socket.on("data", (chunk) => {
      data += chunk;
    });
    const done = () => {
      clearTimeout(timer);
      resolve(data);
    };
    socket.on("end", done);
    socket.on("close", done);
    socket.on("error", done);
    socket.write(`${head}\r\nHost: x\r\nConnection: close\r\n\r\n`);
  });
}

describe("Express parity: HEAD on a GET route", () => {
  it("answers HEAD with the GET handler's status and headers, and no body", async () => {
    const adapter = new BunHttpAdapter(0);
    let ran = 0;
    adapter.get("/g", (_req, res) => {
      ran++;
      res.set("x-h", "1").send("body-of-get");
    });
    const server = await adapter.listen(0);
    try {
      const served = await raw(server.port!, "HEAD /g HTTP/1.1");
      expect(served).toStartWith("HTTP/1.1 200");
      expect(served.toLowerCase()).toContain("x-h: 1");
      expect(served.toLowerCase()).toContain("content-length: 11");
      expect(served.split("\r\n\r\n")[1]).toBe("");

      // Socket-free fetch() answers as the served request does.
      const fetched = await adapter.fetch("/g", { method: "HEAD" });
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get("x-h")).toBe("1");
      expect(await fetched.text()).toBe("");
      expect(ran).toBe(2);
    } finally {
      await adapter.close();
    }
  });

  it("prefers a HEAD handler registered first, and keeps registration order", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.head("/h", (_req, res) => {
      res.set("x-which", "head").end();
    });
    adapter.get("/h", (_req, res) => {
      res.set("x-which", "get").send("get");
    });
    adapter.get("/only-get", (_req, res) => {
      res.set("x-which", "get").send("get");
    });
    const head = await adapter.fetch("/h", { method: "HEAD" });
    expect(head.headers.get("x-which")).toBe("head");
    const getOnly = await adapter.fetch("/only-get", { method: "HEAD" });
    expect(getOnly.headers.get("x-which")).toBe("get");
    // A POST route still does not answer HEAD.
    adapter.post("/p", (_req, res) => res.send("p"));
    expect((await adapter.fetch("/p", { method: "HEAD" })).status).toBe(404);
  });
});

describe("Express parity: next() called later", () => {
  it("continues the pipeline when a middleware calls next() from a timer", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.use((_req, _res, next) => {
      setTimeout(next, 10);
    });
    adapter.get("/async", (_req, res) => res.send("after-async-next"));
    const response = await adapter.fetch("/async");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("after-async-next");
  });

  it("serves it over a socket too", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.use((_req, _res, next) => {
      setTimeout(next, 5);
    });
    adapter.get("/async", (_req, res) => res.send("served"));
    const server = await adapter.listen(0);
    try {
      const served = await raw(server.port!, "GET /async HTTP/1.1");
      expect(served).toStartWith("HTTP/1.1 200");
      expect(served.endsWith("served")).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("answers 404 through the not-found handlers when a late next() runs out", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.use((_req, _res, next) => {
      setTimeout(next, 5);
    });
    expect((await adapter.fetch("/nothing")).status).toBe(404);
  });

  it("still times out a handler that never finishes, as before", async () => {
    // The first argument is the request timeout, in ms.
    const adapter = new BunHttpAdapter(30);
    const seen: unknown[] = [];
    adapter.setErrorHandler(((err, _req, res, _next) => {
      seen.push(err);
      res.status(503).send("handled");
    }) satisfies RouterErrorMiddlewareHandler);
    adapter.get("/stuck", () => {});
    const response = await adapter.fetch("/stuck");
    // Answered as a timed-out response wait always was: by the final
    // handling, without the request, so the error handlers do not see it.
    expect(response.status).toBe(500);
    expect(seen).toEqual([]);
  });
});

describe("Express parity: errors after the response started", () => {
  it("runs the error handlers with headersSent true", async () => {
    const adapter = new BunHttpAdapter(0);
    const seen: { message: string; headersSent: boolean }[] = [];
    adapter.get("/after", (_req, res, next) => {
      res.write("partial");
      next(new Error("late"));
    });
    adapter.use(((err, _req, res, next) => {
      seen.push({
        message: (err as Error).message,
        headersSent: res.headersSent,
      });
      next(err as Error);
    }) satisfies RouterErrorMiddlewareHandler);
    const { logger, events } = createTestLogger();
    adapter.setLogger(logger);
    const server = await adapter.listen(0);
    try {
      const served = await raw(server.port!, "GET /after HTTP/1.1", 3000);
      // The client sees the response cut off (here before its first byte,
      // as the error came before Bun took the stream), not a hang, and
      // never a complete chunked body.
      expect(served.startsWith("TIMEOUT")).toBe(false);
      expect(served).not.toContain("\r\n0\r\n\r\n");
      expect(seen).toEqual([{ message: "late", headersSent: true }]);
      expect(
        events.some(
          (event) =>
            event.level === "error" &&
            event.message === "Unhandled error after the response was sent",
        ),
      ).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("lets an error handler finish a stream it can still write to", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.get("/recover", (_req, res) => {
      res.write("partial;");
      throw new Error("boom");
    });
    adapter.use(((err, _req, res, _next) => {
      void res.end(`recovered:${(err as Error).message}`);
    }) satisfies RouterErrorMiddlewareHandler);
    const response = await adapter.fetch("/recover");
    expect(await response.text()).toBe("partial;recovered:boom");
  });
});
