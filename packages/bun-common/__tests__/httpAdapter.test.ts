import type { App } from "supertest/types";
import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import { Buffer } from "node:buffer";
import process from "node:process";
import {
  brotliCompressSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import request from "supertest";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { noopLogger } from "../lib/logging";
import {
  compressionDictionaryHash,
  dictionaryCompressedHeader,
} from "../lib/utils/native";

let httpAdapter!: BunHttpAdapter;
let app!: Parameters<typeof request>[0];

beforeAll(async () => {
  httpAdapter = new BunHttpAdapter(30000, {
    router: {
      debug: false,
    },
  });
  httpAdapter.registerParserMiddleware(undefined, true); // Register body parsing middleware
  httpAdapter.post("/test", async (req, res) => {
    return res.json(req.body as Record<string, unknown>);
  });

  httpAdapter.get("/api/v1/users", (req, res) => {
    return res.status(200).json({ message: "List of users" });
  });

  httpAdapter.post("/api/v1/users", (req, res) => {
    const user = req.body;
    return res.status(201).json({ message: "User created", user });
  });

  httpAdapter.get("/api/v1/users/:id(\\d+)", (req, res) => {
    res.status(200).json({ message: `User details for ID: ${req.params.id}` });
  });

  httpAdapter.put("/api/v1/users/:id(\\d+)", (req, res) => {
    const { id } = req.params;
    const updatedData = req.body;
    res.status(200).json({ message: `User ${id} updated`, updatedData });
  });

  httpAdapter.delete("/api/v1/users/:id(\\d+)", (req, res) => {
    res.status(200).json({ message: `User ${req.params.id} deleted` });
  });

  httpAdapter.get("/api/v1/users/:id(\\d+)/posts", (req, res) => {
    res.status(200).json({ message: `Posts for user ${req.params.id}` });
  });

  httpAdapter.get("/api/v1/admin(/settings)?", (req, res) => {
    if (req.path.endsWith("settings")) {
      res.status(200).json({ message: "Admin settings" });
    } else {
      res.status(200).json({ message: "Admin dashboard" });
    }
  });

  const fileNameKeyRegexpStr = `[a-zA-Z0-9_-]+\\.`;
  httpAdapter.get(
    `/api/v1/files/:filename(${fileNameKeyRegexpStr}jpg|${fileNameKeyRegexpStr}gif|${fileNameKeyRegexpStr}webp)`,
    (req, res) => {
      res.status(200).json({ message: `File: ${req.params.filename}` });
    },
  );

  httpAdapter.get("/api/v1/search/:query(.*)", (req, res) => {
    res
      .status(200)
      .json({ message: `Search results for: ${req.params.query}` });
  });

  httpAdapter.get("/api/v1/users/:other(.*)", (req, res) => {
    res.status(404).json({ message: "Catch all for USERS API endpoint" });
  });

  // Bun-native body types sent straight through `res.send`.
  httpAdapter.get("/native/buffer", (req, res) => {
    res.send(Buffer.from([0x00, 0x01, 0x02, 0xff]));
  });

  httpAdapter.get("/native/typed-array", (req, res) => {
    res.send(new TextEncoder().encode("typed array body"));
  });

  httpAdapter.get("/native/array-buffer", (req, res) => {
    res.send(
      new TextEncoder().encode("array buffer body").buffer as ArrayBuffer,
    );
  });

  httpAdapter.get("/native/png", (req, res) => {
    res.type("image/png").send(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  httpAdapter.get("/native/urlencoded", (req, res) => {
    res.send(new URLSearchParams({ a: "1", b: "two" }));
  });

  httpAdapter.get("/native/async-generator", (req, res) => {
    res.send(async function* () {
      yield "streamed-";
      yield "body";
    });
  });

  httpAdapter.setNotFoundHandler((req, res) => {
    res.status(404).json({ message: "Route not found" });
  });

  await httpAdapter.listen(10000);

  app = httpAdapter as unknown as App;
});

afterAll(async () => {
  await httpAdapter?.close();
});

describe("Http Adapter Routing - Complex Paths", () => {
  it("gET /api/v1/users - List of users", async () => {
    const response = await request(app)
      .get("/api/v1/users")
      .set("Accept", "application/json");

    expect(response.status).toEqual(200);
    expect(response.body).toEqual({ message: "List of users" });
  });

  it("pOST /api/v1/users - Create a user", async () => {
    const newUser = { name: "John", email: "john@example.com" };
    const response = await request(app)
      .post("/api/v1/users")
      .send(newUser)
      .set("Content-Type", "application/json");
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ message: "User created", user: newUser });
  });

  it("gET /api/v1/users/:id - Valid user ID", async () => {
    const response = await request(app).get("/api/v1/users/123");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "User details for ID: 123" });
  });

  it("gET /api/v1/users/:id - Invalid user ID (non-numeric)", async () => {
    const response = await request(app).get("/api/v1/users/abc");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      message: "Catch all for USERS API endpoint",
    });
  });

  it("pUT /api/v1/users/:id - Update user", async () => {
    const updatedData = { name: "Jane", email: "jane@example.com" };
    const response = await request(app)
      .put("/api/v1/users/456")
      .send(updatedData)
      .set("Content-Type", "application/json");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message: "User 456 updated",
      updatedData,
    });
  });

  it("dELETE /api/v1/users/:id - Delete user", async () => {
    const response = await request(app).delete("/api/v1/users/789");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "User 789 deleted" });
  });

  it("gET /api/v1/users/:id/posts - User posts", async () => {
    const response = await request(app).get("/api/v1/users/123/posts");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "Posts for user 123" });
  });

  it("gET /api/v1/admin - Admin dashboard", async () => {
    const response = await request(app).get("/api/v1/admin");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "Admin dashboard" });
  });

  it("gET /api/v1/admin/settings - Admin settings", async () => {
    const response = await request(app).get("/api/v1/admin/settings");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "Admin settings" });
  });

  it("gET /api/v1/files/:filename - Valid filename with webp", async () => {
    const response = await request(app).get("/api/v1/files/image.webp");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "File: image.webp" });
  });

  it("gET /api/v1/files/:filename - Valid filename with gif", async () => {
    const response = await request(app).get("/api/v1/files/image.gif");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "File: image.gif" });
  });

  it("gET /api/v1/files/:filename - Valid filename with jpg", async () => {
    const response = await request(app).get("/api/v1/files/image.jpg");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "File: image.jpg" });
  });

  it("gET /api/v1/files/:filename - Invalid filename", async () => {
    const response = await request(app).get("/api/v1/files/men/image.jpg");
    expect(response.status).toBe(404);
  });

  it("gET /api/v1/files/:filename - Invalid filename", async () => {
    const response = await request(app).get("/api/v1/files/image.pdf");
    expect(response.status).toBe(404);
  });

  it("gET /api/v1/search/:query - Search with query", async () => {
    const query = "example+query";
    const response = await request(app).get(`/api/v1/search/${query}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: `Search results for: ${query}` });
  });

  it("gET /api/v1/search/ - Search with empty query", async () => {
    const response = await request(app).get("/api/v1/search/");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "Search results for: " });
  });

  it("gET /nonexistent - Undefined route", async () => {
    const response = await request(app).get("/nonexistent");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: "Route not found" });
  });

  // Add more cases as needed for edge conditions.
});

describe("BunHttpAdapter: routeCacheMax option", () => {
  it("forwards routeCacheMax to the router (FIFO eviction)", () => {
    const adapter = new BunHttpAdapter(0, { routeCacheMax: 1 });
    adapter.get("/x", () => {});
    adapter.get("/y", () => {});

    const match = (path: string) =>
      adapter.getMatchedLayers({
        requestHost: "localhost",
        requestMethod: "GET",
        requestUrl: path,
      });

    const x1 = match("/x");
    match("/y"); // evicts "/x" — cache cap is 1
    expect(match("/x")).not.toBe(x1);
  });

  it("keeps the signature cached when routeCacheMax is unset (default)", () => {
    const adapter = new BunHttpAdapter(0);
    adapter.get("/x", () => {});
    adapter.get("/y", () => {});

    const match = (path: string) =>
      adapter.getMatchedLayers({
        requestHost: "localhost",
        requestMethod: "GET",
        requestUrl: path,
      });

    const x1 = match("/x");
    match("/y");
    expect(match("/x")).toBe(x1);
  });

  it("disables the router cache for routeCacheMax: 0", () => {
    const adapter = new BunHttpAdapter(0, { routeCacheMax: 0 });
    adapter.get("/x", () => {});

    const match = (path: string) =>
      adapter.getMatchedLayers({
        requestHost: "localhost",
        requestMethod: "GET",
        requestUrl: path,
      });

    const first = match("/x");
    const second = match("/x");
    // Nothing is cached, so each call rebuilds an equal but distinct array.
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(second).toHaveLength(1);
  });
});

describe("BunHttpAdapter: Bun-native response bodies", () => {
  it("serves a Buffer as application/octet-stream", async () => {
    const response = await request(app).get("/native/buffer");

    expect(response.status).toEqual(200);
    expect(response.headers["content-type"]).toContain(
      "application/octet-stream",
    );
    expect(Buffer.from(response.body)).toEqual(
      Buffer.from([0x00, 0x01, 0x02, 0xff]),
    );
  });

  it("serves a typed array", async () => {
    const response = await request(app).get("/native/typed-array");

    expect(response.status).toEqual(200);
    expect(Buffer.from(response.body).toString()).toBe("typed array body");
  });

  it("serves an ArrayBuffer", async () => {
    const response = await request(app).get("/native/array-buffer");

    expect(response.status).toEqual(200);
    expect(Buffer.from(response.body).toString()).toBe("array buffer body");
  });

  it("keeps an explicit Content-Type for a binary body", async () => {
    const response = await request(app).get("/native/png");

    expect(response.headers["content-type"]).toContain("image/png");
    expect(Buffer.from(response.body)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it("serves URLSearchParams as urlencoded", async () => {
    const response = await request(app).get("/native/urlencoded");

    expect(response.headers["content-type"]).toContain(
      "application/x-www-form-urlencoded",
    );
    expect(response.text).toBe("a=1&b=two");
  });

  it("streams an async generator body", async () => {
    const response = await request(app).get("/native/async-generator");

    expect(response.status).toEqual(200);
    expect(response.text).toBe("streamed-body");
  });
});

describe("BunHttpAdapter: listen()", () => {
  it("rejects on a busy port instead of moving to another", async () => {
    const blocker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("taken"),
    });
    const adapter = new BunHttpAdapter(0, { logger: noopLogger });

    try {
      let caught: unknown;
      try {
        await adapter.listen(blocker.port!, "127.0.0.1");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(adapter.isListening).toBe(false);
    } finally {
      await adapter.close();
      await blocker.stop(true);
    }
  });

  it("binds a non-IP hostname as given", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.get("/", (_req, res) => res.send("named"));

    try {
      await adapter.listen(0, "localhost");
      expect(adapter.listeningHost).toBe("localhost");
      const response = await fetch(
        `http://localhost:${adapter.listeningPort}/`,
      );
      expect(await response.text()).toBe("named");
    } finally {
      await adapter.close();
    }
  });

  it("keeps the running server when asked for port 0 again", async () => {
    const adapter = new BunHttpAdapter(0);
    let listeningEvents = 0;
    adapter.eventEmitter.on("listening", () => listeningEvents++);

    try {
      const first = await adapter.listen(0);
      const port = adapter.listeningPort;
      let calledBackWith: unknown;
      const second = await adapter.listen(0, (server) => {
        calledBackWith = server;
      });

      expect(second).toBe(first);
      expect(calledBackWith).toBe(first);
      expect(adapter.listeningPort).toBe(port);
      expect(listeningEvents).toBe(1);
    } finally {
      await adapter.close();
    }
  });

  it("moves to a different hostname when asked", async () => {
    const adapter = new BunHttpAdapter(0);

    try {
      const first = await adapter.listen(0, "127.0.0.1");
      const second = await adapter.listen(0, "localhost");
      expect(second).not.toBe(first);
      expect(adapter.listeningHost).toBe("localhost");
    } finally {
      await adapter.close();
    }
  });

  it("rejects a port outside 0-65535", async () => {
    const adapter = new BunHttpAdapter(0);
    let caught: unknown;
    try {
      await adapter.listen(70000);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
  });
});

describe("BunHttpAdapter: handlers, helpers and instance", () => {
  it("redirect() ends the response", async () => {
    // A short request timeout, so a redirect that never sends fails fast.
    const adapter = new BunHttpAdapter(500);
    adapter.get("/old", (_req, res) => {
      adapter.redirect(res, 301, "/new");
    });

    const response = await adapter.fetch("/old");
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("/new");
  });

  it("close() keeps the error and not-found handlers", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.get("/boom", () => {
      throw new Error("exploded");
    });
    adapter.setNotFoundHandler((_req, res) => {
      res.status(404).send("custom not found");
    });
    adapter.setErrorHandler((_error, _req, res) => {
      res.status(502).send("custom error");
    });

    await adapter.listen(0);
    await adapter.close();

    const missing = await adapter.fetch("/missing");
    expect([missing.status, await missing.text()]).toEqual([
      404,
      "custom not found",
    ]);
    const boom = await adapter.fetch("/boom");
    expect([boom.status, await boom.text()]).toEqual([502, "custom error"]);
  });

  it("matches case-sensitively by default, as the router option documents", async () => {
    for (const adapter of [
      new BunHttpAdapter(0),
      new BunHttpAdapter(0, { router: { debug: false } }),
    ]) {
      adapter.get("/Users", (_req, res) => res.send("hit"));
      expect((await adapter.fetch("/users")).status).toBe(404);
      expect((await adapter.fetch("/Users")).status).toBe(200);
    }

    const insensitive = new BunHttpAdapter(0, {
      router: { caseSensitive: false },
    });
    insensitive.get("/Users", (_req, res) => res.send("hit"));
    expect((await insensitive.fetch("/users")).status).toBe(200);
  });

  it("enableCors() and registerParserMiddleware() apply after setInstance()", async () => {
    const adapter = new BunHttpAdapter(0);
    const delegate = new BunRouter();
    adapter.setInstance(delegate);
    // Middleware first: the pipeline runs in registration order.
    adapter.enableCors({ origin: "https://app.test" });
    adapter.registerParserMiddleware(undefined, true);
    delegate.get("/x", (_req, res) => res.send("x"));
    delegate.post("/echo", (req, res) => {
      const raw = req.rawBody;
      res.json({ hasRaw: !!raw });
    });

    const cors = await adapter.fetch("/x", {
      headers: { Origin: "https://app.test" },
    });
    expect(cors.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.test",
    );

    const echo = await adapter.fetch("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(await echo.json()).toEqual({ hasRaw: true });
  });

  it("enableCors() passes a delegate's error to the error handlers", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.enableCors((_req, callback) => {
      callback(new Error("origin refused"));
    });
    adapter.get("/x", (_req, res) => res.send("x"));
    adapter.setErrorHandler((error, _req, res) => {
      res.status(403).json({ error: (error as Error).message });
    });

    const response = await adapter.fetch("/x", {
      headers: { Origin: "https://evil.test" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin refused" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("ws() registers on the adapter's own BunWebSocket", () => {
    const adapter = new BunHttpAdapter<{ userId: string }>(0);
    const before = adapter.routes().length;

    expect(adapter.ws("/chat", { message: () => undefined })).toBe(adapter);
    expect(adapter.routes().length).toBe(before + 1);
  });

  it("a bare upgrade it serves carries the server's port on ws.data", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.get("/bare", (_req, res) => res.upgradeToWebsocket());
    const ports: (number | undefined)[] = [];
    adapter.webSocketAdapter.on("open", (socket) => {
      ports.push(socket.data.port);
    });
    await adapter.listen(0);

    const client = new WebSocket(
      `ws://127.0.0.1:${adapter.listeningPort}/bare`,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        client.addEventListener("open", () => resolve(), { once: true });
        client.addEventListener(
          "error",
          () => reject(new Error("no upgrade")),
          {
            once: true,
          },
        );
      });
      const deadline = Date.now() + 2000;
      while (ports.length === 0 && Date.now() < deadline) {
        await Bun.sleep(5);
      }
      expect(ports).toEqual([adapter.listeningPort]);
    } finally {
      client.close();
      await adapter.close();
    }
  });
});

describe("BunHttpAdapter: body parsers", () => {
  /** A JSON body of `size` characters' worth of text. */
  function json(size: number): RequestInit {
    return {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(size) }),
    };
  }

  /** A plain-text body of `size` characters. */
  function text(size: number): RequestInit {
    return {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x".repeat(size),
    };
  }

  it("useBodyParser() leaves a request of another type alone", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.useBodyParser("json", true, { limit: 10 });
    adapter.post("/echo", (req, res) => {
      const raw = req.rawBody;
      res.json({ hasRaw: raw !== undefined });
    });

    // Text is not JSON: the parser, and so its limit, never applies.
    const skipped = await adapter.fetch("/echo", text(100));
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toEqual({ hasRaw: false });

    // JSON is, and the same size is over the limit.
    const refused = await adapter.fetch("/echo", json(100));
    expect(refused.status).toBe(413);
    expect(await refused.text()).toContain("<pre>Payload Too Large</pre>");
  });

  it("honours options.type over the kind's default", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.useBodyParser("json", false, {
      type: "application/vnd.api+json",
      limit: 10,
    });
    adapter.post("/echo", (_req, res) => res.send("ok"));

    expect((await adapter.fetch("/echo", json(100))).status).toBe(200);
    const vendor = await adapter.fetch("/echo", {
      ...json(100),
      headers: { "Content-Type": "application/vnd.api+json" },
    });
    expect(vendor.status).toBe(413);
  });

  it("registers two kinds side by side, each with its own options", async () => {
    const adapter = new BunHttpAdapter(0);
    const before = adapter.routes().length;
    adapter.useBodyParser("json", false, { limit: 10 });
    adapter.useBodyParser("text", false, { limit: 1000 });
    expect(adapter.routes().length).toBe(before + 2);
    adapter.post("/echo", (_req, res) => res.send("ok"));

    expect((await adapter.fetch("/echo", json(100))).status).toBe(413);
    expect((await adapter.fetch("/echo", text(100))).status).toBe(200);
    expect((await adapter.fetch("/echo", text(2000))).status).toBe(413);
  });

  it("registers each kind once", () => {
    const adapter = new BunHttpAdapter(0);
    const before = adapter.routes().length;
    adapter.useBodyParser("json", false, { limit: 10 });
    adapter.useBodyParser("json", true, { limit: 99 });
    adapter.registerParserMiddleware();
    adapter.registerParserMiddleware(undefined, true);
    expect(adapter.routes().length).toBe(before + 2);
  });
});

describe("BunHttpAdapter: parseBody decoding options, for the body parsed at build time", () => {
  /** A gzip-encoded JSON POST of `body`. */
  function gzipped(body: Uint8Array): RequestInit {
    return {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body,
    };
  }

  const zippedJson = gzipSync(Buffer.from('{"zipped":true}'));

  it("parseBody.inflate: false answers 415 for a gzip body, before any route runs", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: { inflate: false } },
      logger: noopLogger,
    });
    let routed = false;
    adapter.post("/echo", (req, res) => {
      routed = true;
      res.json({ body: req.body ?? null });
    });

    const refused = await adapter.fetch("/echo", gzipped(zippedJson));
    expect(refused.status).toBe(415);
    expect(await refused.text()).toContain("<pre>Unsupported Media Type</pre>");
    expect(routed).toBe(false);

    // An identity body is parsed and routed as usual.
    const plain = await adapter.fetch("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"plain":true}',
    });
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ body: { plain: true } });
  });

  it("the refused encoding reaches setErrorHandler with the request, as body-parser's next(err)", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: { inflate: false } },
    });
    adapter.post("/echo", (_req, res) => res.send("routed"));
    adapter.setErrorHandler(((error, req, res, _next) => {
      const status =
        error instanceof Error && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
      res.status(status).json({ status, path: req.path });
      return res;
    }) satisfies RouterErrorMiddlewareHandler);

    const refused = await adapter.fetch("/echo", gzipped(zippedJson));
    expect(refused.status).toBe(415);
    expect(await refused.json()).toEqual({ status: 415, path: "/echo" });
  });

  it("a corrupt gzip body is a 400 at build time", async () => {
    const adapter = new BunHttpAdapter(0, { logger: noopLogger });
    adapter.post("/echo", (_req, res) => res.send("routed"));
    const corrupt = Buffer.from(zippedJson);
    corrupt.fill(0xff, 10, 20);
    expect((await adapter.fetch("/echo", gzipped(corrupt))).status).toBe(400);
  });

  it("decompressionFastPathLimit: 0 and a small limit answer 413 for a bomb, decoded by node:zlib", async () => {
    // 10 MiB of zeros: a few KB on the wire; its worst case fits the default
    // 32 MiB fast path, so only the option keeps Bun's uncapped decoder out.
    const bomb = gzipSync(Buffer.alloc(10 * 1024 * 1024));
    const adapter = new BunHttpAdapter(0, {
      request: {
        parseBody: { maxContentLength: "64kb", decompressionFastPathLimit: 0 },
      },
    });
    let routed = false;
    adapter.post("/echo", (_req, res) => {
      routed = true;
      res.send("routed");
    });

    const gunzip = spyOn(Bun, "gunzipSync");
    try {
      const refused = await adapter.fetch("/echo", gzipped(bomb));
      expect(refused.status).toBe(413);
      expect(await refused.json()).toMatchObject({ statusCode: 413 });
      expect(gunzip).not.toHaveBeenCalled();
      expect(routed).toBe(false);
    } finally {
      gunzip.mockRestore();
    }
  });

  it("the defaults still inflate: parseBody: true, and the object form without inflate", async () => {
    for (const parseBody of [true, { maxContentLength: "1kb" }] as const) {
      const adapter = new BunHttpAdapter(0, { request: { parseBody } });
      adapter.post("/echo", (req, res) => res.json({ body: req.body ?? null }));
      const response = await adapter.fetch("/echo", gzipped(zippedJson));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ body: { zipped: true } });
    }
  });

  it("setRequestOpts() carries the decoding options to later requests", async () => {
    const adapter = new BunHttpAdapter(0, { logger: noopLogger });
    adapter.post("/echo", (req, res) => res.json({ body: req.body ?? null }));
    expect((await adapter.fetch("/echo", gzipped(zippedJson))).status).toBe(
      200,
    );

    adapter.setRequestOpts({ parseBody: { inflate: false } });
    expect((await adapter.fetch("/echo", gzipped(zippedJson))).status).toBe(
      415,
    );
  });

  /** A JSON POST of `body` sent with `Content-Encoding: encoding`. */
  function encodedPost(body: Uint8Array, encoding: string): RequestInit {
    return {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": encoding,
      },
      body,
    };
  }

  const json = Buffer.from('{"zipped":true}');

  it("zstd and stacked codings answer 200; truncated zstd 400; a bomb 413; an unknown, literal * or too-deep coding 415", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: { maxContentLength: "64kb" } },
      logger: noopLogger,
    });
    let routed = 0;
    adapter.post("/echo", (req, res) => {
      routed++;
      res.json({ body: req.body ?? null });
    });

    for (const [encoding, body] of [
      ["zstd", Bun.zstdCompressSync(json)],
      ["gzip, br", brotliCompressSync(gzipSync(json))],
      ["deflate, zstd", Bun.zstdCompressSync(deflateSync(json))],
    ] as const) {
      const response = await adapter.fetch(
        "/echo",
        encodedPost(body, encoding),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ body: { zipped: true } });
    }
    expect(routed).toBe(3);

    const frame = Bun.zstdCompressSync(json);
    const refusals: Array<[Uint8Array, string, number]> = [
      [frame.subarray(0, frame.length - 2), "zstd", 400],
      [Bun.zstdCompressSync(Buffer.alloc(8 * 1024 * 1024)), "zstd", 413],
      [json, "compress", 415],
      [json, "*", 415],
      [
        [1, 2, 3, 4, 5, 6].reduce<Buffer>((body) => gzipSync(body), json),
        "gzip, gzip, gzip, gzip, gzip, gzip",
        415,
      ],
    ];
    for (const [body, encoding, status] of refusals) {
      const response = await adapter.fetch(
        "/echo",
        encodedPost(body, encoding),
      );
      expect([encoding, response.status]).toEqual([encoding, status]);
    }
    expect(routed).toBe(3);
  });

  it("parseBody.encodings answers 415 for a coding outside the allowlist, before routing", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: { encodings: ["gzip", "zstd"] } },
      logger: noopLogger,
    });
    adapter.post("/echo", (req, res) => res.json({ body: req.body ?? null }));

    expect(
      (await adapter.fetch("/echo", encodedPost(gzipSync(json), "gzip")))
        .status,
    ).toBe(200);
    expect(
      (
        await adapter.fetch(
          "/echo",
          encodedPost(brotliCompressSync(json), "br"),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await adapter.fetch(
          "/echo",
          encodedPost(brotliCompressSync(gzipSync(json)), "gzip, br"),
        )
      ).status,
    ).toBe(415);
  });

  it("parseBody.compressionDictionaries decodes dcz; an unknown dictionary answers 400", async () => {
    const dictionary = Buffer.from('{"zipped":true,"shared":"dictionary"}');
    const compress: (
      bytes: Uint8Array,
      options: { dictionary: Uint8Array; maxOutputLength?: number },
    ) => Buffer = zstdCompressSync;
    const dcz = Buffer.concat([
      dictionaryCompressedHeader("dcz", compressionDictionaryHash(dictionary)),
      compress(json, { dictionary }),
    ]);

    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: { compressionDictionaries: [dictionary] } },
      logger: noopLogger,
    });
    adapter.post("/echo", (req, res) => res.json({ body: req.body ?? null }));
    const decoded = await adapter.fetch("/echo", encodedPost(dcz, "dcz"));
    expect(decoded.status).toBe(200);
    expect(await decoded.json()).toEqual({ body: { zipped: true } });

    adapter.setRequestOpts({
      parseBody: { compressionDictionaries: [Buffer.from("another")] },
    });
    expect((await adapter.fetch("/echo", encodedPost(dcz, "dcz"))).status).toBe(
      400,
    );

    adapter.setRequestOpts({ parseBody: {} });
    expect((await adapter.fetch("/echo", encodedPost(dcz, "dcz"))).status).toBe(
      415,
    );
  });
});

describe("BunHttpAdapter: nodeHttpServer()", () => {
  it("is not thenable, so awaiting it settles at once", async () => {
    const adapter = new BunHttpAdapter(0);
    const view = adapter.nodeHttpServer();

    expect(Reflect.get(view, "then")).toBeUndefined();
    const started = performance.now();
    expect(await Promise.resolve(view)).toBe(view);
    expect(performance.now() - started).toBeLessThan(100);
    // The rest of the proxy still reads through to the adapter.
    expect(view.listening).toBe(false);
  });

  it("lets a process that never listened exit after close()", async () => {
    const adapterModule = new URL("../lib/BunHttpAdapter.ts", import.meta.url)
      .pathname;
    const script = [
      `import { BunHttpAdapter } from ${JSON.stringify(adapterModule)};`,
      "const adapter = new BunHttpAdapter(0);",
      "await Promise.resolve(adapter.nodeHttpServer());",
      "await adapter.close();",
      'console.log("closed");',
    ].join("\n");

    const child = Bun.spawn([process.execPath, "--eval", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    // The old proxy polled for a server forever, keeping the process alive.
    const killer = setTimeout(() => child.kill(), 10_000);
    const code = await child.exited;
    clearTimeout(killer);

    expect(await new Response(child.stdout).text()).toContain("closed");
    expect(child.signalCode).toBeNull();
    expect(code).toBe(0);
  }, 15_000);
});
