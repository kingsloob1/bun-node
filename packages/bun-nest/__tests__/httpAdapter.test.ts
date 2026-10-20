import type { RouterMiddlewareHandler } from "@kingsleyweb/bun-common";
import type { App } from "supertest/types";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  BunRouter,
  finalErrorResponse,
  mergeBunRequestOptions,
  RouteClass,
  signCookie,
} from "@kingsleyweb/bun-common";
import {
  BadRequestException,
  Logger,
  RequestMethod,
  StreamableFile,
} from "@nestjs/common";
import { AbstractHttpAdapter } from "@nestjs/core/adapters/http-adapter.js";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import request from "supertest";
import * as httpAdapterModule from "../lib/BunHttpAdapter";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { coreRunsMiddlewareOnce } from "./coreMiddlewareOnce";

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

  httpAdapter.setNotFoundHandler((req, res) => {
    res.status(404).json({ message: "Route not found" });
  });

  // Port 0: the OS assigns one, so two runs of this suite never clash.
  await httpAdapter.listen(0);

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

  it("gET /api/v1/files/:filename - Invalid filename with a nested path", async () => {
    const response = await request(app).get("/api/v1/files/men/image.jpg");
    expect(response.status).toBe(404);
  });

  it("gET /api/v1/files/:filename - Invalid filename with an unlisted extension", async () => {
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

/**
 * A client never sends a URL's fragment, so a served request never has one;
 * `fetch()` must drop it too, or a route matches offline that 404s served.
 */
describe("BunHttpAdapter.fetch: drops the URL fragment, as a served request", () => {
  /** Echoes what the route saw, minus the host (which differs). */
  function build(adapter: BunHttpAdapter): void {
    for (const path of ["/p/:id", "/p/:id/v"]) {
      adapter.get(path, (req, res) => {
        res.json({
          route: path,
          id: req.params.id,
          url: req.url,
          hash: req.hash,
          query: req.query,
        });
      });
    }
  }

  it("answers what a served request gets, for a string, a { url } and a Request", async () => {
    const served = new BunHttpAdapter();
    build(served);
    await served.listen(0);

    const offline = new BunHttpAdapter();
    build(offline);

    try {
      for (const target of ["/p/a@1#1/v", "/p/x?q=1#frag", "/p/a%231"]) {
        const overSocket = await fetch(
          `http://127.0.0.1:${served.listeningPort}${target}`,
        );
        const expected = {
          target,
          status: overSocket.status,
          body: await overSocket.text(),
        };
        expect(expected.status).toBe(200);

        for (const input of [
          target,
          { url: target },
          new Request(`http://localhost${target}`),
        ]) {
          const response = await offline.fetch(input);
          expect({
            target,
            status: response.status,
            body: await response.text(),
          }).toEqual(expected);
        }
      }
    } finally {
      await served.close();
    }
  });
});

describe("BunHttpAdapter: responses NestJS sends", () => {
  it("redirect() finishes the response (no wait for the request timeout)", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/old", (_req, res) => {
      adapter.redirect(res, 301, "/new");
    });

    const response = await adapter.fetch("/old");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/new");
  });

  it("reply() streams a StreamableFile with its headers", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/file", (_req, res) => {
      return adapter.reply(
        res,
        new StreamableFile(Buffer.from("id,total\n1,2\n"), {
          type: "text/csv",
          disposition: 'attachment; filename="r.csv"',
        }),
      );
    });

    const response = await adapter.fetch("/file");
    expect(response.headers.get("content-type")).toStartWith("text/csv");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="r.csv"',
    );
    expect(await response.text()).toBe("id,total\n1,2\n");
  });

  it("reply() keeps a Content-Type the handler set over the file's", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/file", (_req, res) => {
      res.setHeader("Content-Type", "text/plain");
      return adapter.reply(
        res,
        new StreamableFile(Buffer.from("x"), { type: "text/csv" }),
      );
    });

    const response = await adapter.fetch("/file");
    expect(response.headers.get("content-type")).toStartWith("text/plain");
  });

  it("fetch() applies setErrorHandler() handlers", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/boom", () => {
      throw new Error("kaboom");
    });
    adapter.setErrorHandler((error, _req, res, _next) => {
      res.status(503).json({ handled: (error as Error).message });
    });

    const response = await adapter.fetch("/boom");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ handled: "kaboom" });
  });
});

/**
 * `setErrorHandler` handlers are Express error middleware on
 * `@nestjs/platform-express` (`app.use(handler)`), so only `next` moves the
 * chain and a return value means nothing.
 */
describe("BunHttpAdapter: setErrorHandler() chain, as Express error middleware", () => {
  /** An adapter whose `/boom` route throws `Error("first")`. */
  function throwing() {
    const adapter = new BunHttpAdapter();
    adapter.get("/boom", () => {
      throw new Error("first");
    });
    return adapter;
  }

  it("next(err) hands the new error to the next handler, whatever the handler returns", async () => {
    const adapter = throwing();
    adapter.setErrorHandler((_error, _req, res, next) => {
      next(new Error("second"));
      return res;
    });
    adapter.setErrorHandler((error, _req, res, _next) => {
      res.status(502).json({ seen: (error as Error).message });
    });

    const response = await adapter.fetch("/boom");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ seen: "second" });
  });

  it("a handler that responds and returns a value (Nest's exception layer) ends the chain", async () => {
    const adapter = throwing();
    let laterRan = false;
    adapter.setErrorHandler((_error, _req, res, _next) => {
      res.status(503).send("handled");
      return res;
    });
    adapter.setErrorHandler((_error, _req, res, _next) => {
      laterRan = true;
      res.status(500).send("overwritten");
    });

    const response = await adapter.fetch("/boom");
    expect(await response.text()).toBe("handled");
    expect(response.status).toBe(503);
    expect(laterRan).toBe(false);
  });

  it("next(err) past the last handler is answered as finalhandler, for that error", async () => {
    const adapter = throwing();
    adapter.setErrorHandler((_error, _req, _res, next) => {
      next(Object.assign(new Error("teapot"), { status: 418 }));
    });

    const response = await adapter.fetch("/boom");
    expect(response.status).toBe(418);
    expect(await response.text()).toContain("<pre>I&#39;m a Teapot</pre>");
  });

  it("next() leaves error mode: nothing follows, so 404", async () => {
    const adapter = throwing();
    let laterRan = false;
    adapter.setErrorHandler((_error, _req, _res, next) => {
      next();
    });
    adapter.setErrorHandler((_error, _req, res, _next) => {
      laterRan = true;
      res.status(500).send("error handler");
    });

    const response = await adapter.fetch("/boom");
    expect(response.status).toBe(404);
    expect(laterRan).toBe(false);
  });

  it("next(err) called from a callback after the handler returned still moves on", async () => {
    const adapter = throwing();
    adapter.setErrorHandler((error, _req, _res, next) => {
      setTimeout(next, 5, error);
    });
    adapter.setErrorHandler((error, _req, res, _next) => {
      res.status(503).json({ late: (error as Error).message });
    });

    const response = await adapter.fetch("/boom");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ late: "first" });
  });
});

describe("BunHttpAdapter: close()", () => {
  it("keeps error and not-found handlers for a later listen() or fetch()", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/boom", () => {
      throw new Error("kaboom");
    });
    adapter.setErrorHandler((_error, _req, res, _next) => {
      res.status(503).send("handled");
    });
    adapter.setNotFoundHandler((_req, res) => {
      res.status(404).send("custom not found");
    });

    await adapter.listen(0);
    await adapter.close();

    expect((await adapter.fetch("/boom")).status).toBe(503);
    expect(await (await adapter.fetch("/nowhere")).text()).toBe(
      "custom not found",
    );
  });

  it("returns the running server when listen(0) is called again", async () => {
    const adapter = new BunHttpAdapter();
    const first = await adapter.listen(0);
    try {
      expect(await adapter.listen(0)).toBe(first);
    } finally {
      await adapter.close();
    }
  });
});

describe("BunHttpAdapter: listen()", () => {
  it("binds the hostname it is given", async () => {
    const adapter = new BunHttpAdapter();
    await adapter.listen(0, "localhost");
    try {
      expect(adapter.listeningHost).toBe("localhost");
    } finally {
      await adapter.close();
    }
  });

  it("rejects a busy port instead of binding another one", async () => {
    const holder = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("taken"),
    });
    const adapter = new BunHttpAdapter();
    try {
      await expect(adapter.listen(Number(holder.port))).rejects.toThrow();
      expect(adapter.isListening).toBe(false);
    } finally {
      await holder.stop(true);
      await adapter.close();
    }
  });
});

describe("BunHttpAdapter: listen() with an `error` listener", () => {
  it("hands a bind failure to the listener and resolves undefined, as node:http does", async () => {
    const holder = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("taken"),
    });
    const adapter = new BunHttpAdapter();
    const errors: unknown[] = [];
    adapter.eventEmitter.once("error", (error) => errors.push(error));
    let calledBack = false;

    try {
      const server = await adapter.listen(Number(holder.port), () => {
        calledBack = true;
      });

      expect(server).toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect(calledBack).toBe(false);
    } finally {
      await holder.stop(true);
      await adapter.close();
    }
  });
});

describe("BunHttpAdapter: a bare WebSocket upgrade", () => {
  it("records the accepting server's port on ws.data", async () => {
    const adapter = new BunHttpAdapter();
    // A handler upgrading with data of its own, which carries no port.
    adapter.get("/bare", (req, res) => {
      return res.upgradeToWebsocket({
        host: req.host,
        path: req.path,
        search: req.search,
        hash: req.hash,
        originalUrl: req.originalUrl,
        headers: req.headersObj,
        user: undefined,
        custom: undefined,
        route: "/bare",
        params: {},
      });
    });
    const connected = new Promise<number | undefined>((resolve) => {
      adapter.webSocketAdapter.once("connect", (client) => {
        resolve(client.data.port);
      });
    });
    await adapter.listen(0);

    try {
      const socket = new WebSocket(
        `ws://127.0.0.1:${adapter.listeningPort}/bare`,
      );
      expect(await connected).toBe(adapter.listeningPort);
      socket.close();
    } finally {
      await adapter.close();
    }
  });
});

describe("BunHttpAdapter: an app that never listens", () => {
  it("resolves initHttpServer() without waiting for a server", async () => {
    const adapter = new BunHttpAdapter();
    const server = await Promise.race([
      adapter.initHttpServer(),
      Bun.sleep(500).then(() => "timed out"),
    ]);

    expect(server).toBe(adapter.getHttpServer());
    expect((adapter.getHttpServer() as { then?: unknown }).then).toBe(
      undefined,
    );
  });
});

describe("BunHttpAdapter: a Content-Encoding refused while the request is built", () => {
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

  /**
   * An adapter with `request` options, a `POST /echo` route that records it
   * ran, and an error handler answering the error's own status, as Nest's
   * exception filter does for an `HttpException`-like error.
   */
  function adapterWith(
    request?: ConstructorParameters<typeof BunHttpAdapter>[1],
  ) {
    const adapter = new BunHttpAdapter(0, request);
    const state = { routed: false };
    adapter.post("/echo", (_req, res) => {
      state.routed = true;
      return res.send("routed");
    });
    adapter.setErrorHandler((error, _req, res, _next) => {
      const status =
        error instanceof Error && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
      return res.status(status).json({ status });
    });
    return { adapter, state };
  }

  it("parseBody.inflate: false answers 415 for a gzip body, before any route runs", async () => {
    const { adapter, state } = adapterWith({
      request: { parseBody: { inflate: false } },
    });

    const refused = await adapter.fetch("/echo", gzipped(zippedJson));
    expect(refused.status).toBe(415);
    expect(await refused.json()).toEqual({ status: 415 });
    expect(state.routed).toBe(false);

    // An identity body is still parsed and routed.
    const plain = await adapter.fetch("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"plain":true}',
    });
    expect(plain.status).toBe(200);
    expect(state.routed).toBe(true);
  });

  it("a declared empty body with no stream is refused by the body parser, after routing starts", async () => {
    // Bun serves `Content-Length: 0` with no body stream; such a request is
    // built without reading its headers, so the encoding is checked when the
    // body is first read — here by Nest's json parser — and its 415 reaches
    // the same error handler.
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: { inflate: false } },
    });
    adapter.useBodyParser("json", false, {});
    const state = { routed: false };
    adapter.post("/echo", (_req, res) => {
      state.routed = true;
      return res.send("routed");
    });
    adapter.setErrorHandler((error, _req, res, _next) => {
      return res
        .status(Number((error as { statusCode?: number }).statusCode ?? 500))
        .json({ status: (error as { statusCode?: number }).statusCode });
    });
    const refused = await adapter.fetch("/echo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Content-Length": "0",
      },
    });
    expect(refused.status).toBe(415);
    expect(await refused.json()).toEqual({ status: 415 });
    expect(state.routed).toBe(false);
  });

  it("a corrupt gzip body answers 400", async () => {
    const { adapter, state } = adapterWith();
    const corrupt = Buffer.from(zippedJson);
    corrupt.fill(0xff, 10, 20);

    const refused = await adapter.fetch("/echo", gzipped(corrupt));
    expect(refused.status).toBe(400);
    expect(state.routed).toBe(false);
  });

  it("with no error handler, fetch() answers the refused encoding finalhandler-style", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: { inflate: false } },
    });
    let routed = false;
    adapter.post("/echo", (_req, res) => {
      routed = true;
      return res.send("routed");
    });

    const refused = await adapter.fetch("/echo", gzipped(zippedJson));
    expect(refused.status).toBe(415);
    expect(refused.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(refused.headers.get("content-security-policy")).toBe(
      "default-src 'none'",
    );
    expect(refused.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await refused.text()).toContain("<pre>Unsupported Media Type</pre>");
    expect(routed).toBe(false);

    const corrupt = Buffer.from(zippedJson);
    corrupt.fill(0xff, 10, 20);
    const lenient = new BunHttpAdapter(0);
    lenient.post("/echo", (_req, res) => res.send("routed"));
    const bad = await lenient.fetch("/echo", gzipped(corrupt));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("<pre>Bad Request</pre>");
  });
});

describe("BunHttpAdapter: no error handler (finalhandler fallback)", () => {
  const zipped = gzipSync(Buffer.from('{"zipped":true}'));
  const corrupt = Buffer.from(zipped);
  corrupt.fill(0xff, 10, 20);

  /** A JSON `POST` whose body is sent with `Content-Encoding: gzip`. */
  function gzipInit(body: Uint8Array): RequestInit {
    return {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body,
    };
  }

  /** Routes whose errors nothing handles. */
  function build(adapter: BunHttpAdapter) {
    adapter.useBodyParser("json", false, { limit: 10 });
    adapter.all("/boom", () => {
      throw new Error("secret detail");
    });
    adapter.get("/teapot", () => {
      throw Object.assign(new Error("short and stout"), {
        status: 418,
        headers: { "X-Brew": "refused" },
      });
    });
    adapter.get("/primitive", () => {
      // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
      throw "a bare string";
    });
    adapter.post("/json", (_req, res) => res.send("parsed"));
    adapter.get("/hang", () => undefined);
  }

  /** One request and the status its unhandled error must answer with. */
  interface Case {
    /** Path requested. */
    target: string;
    /** `RequestInit` for the request; a plain `GET` when absent. */
    init?: RequestInit;
    /** Expected status. */
    status: number;
  }
  const lenientCases: Case[] = [
    { target: "/boom", status: 500 },
    { target: "/boom", init: { method: "HEAD" }, status: 500 },
    { target: "/teapot", status: 418 },
    { target: "/primitive", status: 500 },
    { target: "/json", init: gzipInit(corrupt), status: 400 },
    {
      target: "/json",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(100) }),
      },
      status: 413,
    },
    // A timeout carries no request, so it takes the fallback too.
    { target: "/hang", status: 500 },
  ];
  const strictCases: Case[] = [
    { target: "/json", init: gzipInit(zipped), status: 415 },
  ];

  /** Compares a served request with `fetch()` for every case. */
  async function expectParity(
    request: ConstructorParameters<typeof BunHttpAdapter>[1],
    cases: Case[],
  ) {
    const served = new BunHttpAdapter(100, request);
    build(served);
    await served.listen(0);

    const offline = new BunHttpAdapter(100, request);
    build(offline);

    try {
      for (const { target, init, status } of cases) {
        const overSocket = await fetch(`${served.url}${target}`, init);
        const offlineResponse = await offline.fetch(target, init);

        expect([target, offlineResponse.status]).toEqual([target, status]);
        expect(offlineResponse.status).toBe(overSocket.status);
        expect(offlineResponse.statusText).toBe(overSocket.statusText);
        for (const header of [
          "content-type",
          "content-security-policy",
          "x-content-type-options",
          "x-brew",
        ]) {
          expect(offlineResponse.headers.get(header)).toBe(
            overSocket.headers.get(header),
          );
        }
        expect(await offlineResponse.text()).toBe(await overSocket.text());
      }
    } finally {
      await served.close();
    }
  }

  it("a served request and fetch() get the same 400, 413, 500 and HEAD responses", async () => {
    await expectParity(undefined, lenientCases);
  });

  it("a served request and fetch() get the same 415 for a refused encoding", async () => {
    await expectParity(
      { request: { parseBody: { inflate: false } } },
      strictCases,
    );
  });

  it("sends the status message as an HTML page, never the error's detail", async () => {
    const adapter = new BunHttpAdapter(100);
    build(adapter);

    const response = await adapter.fetch("/boom");
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("<pre>Internal Server Error</pre>");
    expect(body).not.toContain("secret detail");
    expect(body).not.toContain("at ");

    const tooLarge = await adapter.fetch("/json", lenientCases[5]?.init);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.text()).toContain("<pre>Payload Too Large</pre>");

    const teapot = await adapter.fetch("/teapot");
    expect(teapot.headers.get("x-brew")).toBe("refused");

    const head = await adapter.fetch("/boom", { method: "HEAD" });
    expect(head.status).toBe(500);
    expect(await head.text()).toBe("");
  });

  it("setErrorHandler still wins, and a handler that throws takes the fallback", async () => {
    const handled = new BunHttpAdapter(100);
    build(handled);
    handled.setErrorHandler((error, _req, res, _next) => {
      return res.status(503).json({ handled: String(error) });
    });
    const answered = await handled.fetch("/boom");
    expect(answered.status).toBe(503);
    expect(await answered.json()).toEqual({
      handled: "Error: secret detail",
    });

    const throwing = new BunHttpAdapter(100);
    build(throwing);
    throwing.setErrorHandler(() => {
      throw Object.assign(new Error("handler failed"), { status: 502 });
    });
    const fallback = await throwing.fetch("/boom");
    expect(fallback.status).toBe(502);
    expect(await fallback.text()).toContain("<pre>Bad Gateway</pre>");
  });
});

describe("BunHttpAdapter: getInstance()", () => {
  it("returns the adapter's BunRouter, the same object as `instance`", () => {
    const adapter = new BunHttpAdapter();
    const router = adapter.getInstance();
    expect(router).toBe(adapter.instance);
    expect(router).toBeInstanceOf(BunRouter);
    // The router's installed BunWebSocket is the adapter's own until swapped.
    expect(router.getBunWebsocket()).toBe(adapter.webSocketAdapter);
  });
});

describe("BunHttpAdapter module exports", () => {
  it("does not export the stray `man` constant", () => {
    expect(Object.keys(httpAdapterModule)).not.toContain("man");
  });
});

describe("BunHttpAdapter: routeCacheMax option", () => {
  it("forwards routeCacheMax to the underlying router (FIFO eviction)", () => {
    const adapter = new BunHttpAdapter(0, { routeCacheMax: 1 });
    adapter.get("/x", () => {});
    adapter.get("/y", () => {});

    const match = (path: string) =>
      adapter.instance.getMatchedLayers({
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
      adapter.instance.getMatchedLayers({
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
      adapter.instance.getMatchedLayers({
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

describe("BunHttpAdapter: request options merge over the defaults", () => {
  /** A JSON `POST` carrying `body`, with optional extra headers. */
  function jsonPost(
    body: unknown,
    headers: Record<string, string> = {},
  ): RequestInit {
    return {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    };
  }

  it("a partial request option ({ cookieSecret }) keeps body and cookie parsing on", async () => {
    const adapter = new BunHttpAdapter(0, { request: { cookieSecret: "k" } });
    expect(adapter.requestOpts).toEqual({
      parseBody: true,
      parseCookies: true,
      cookieSecret: "k",
    });
    adapter.post("/echo", (req, res) => {
      res.json({
        body: req.body ?? null,
        secret: req.secret ?? null,
        signed: req.signedCookies,
      });
    });

    const cookie = `session=${encodeURIComponent(`s:${signCookie("user-42", "k")}`)}`;
    const response = await adapter.fetch(
      "/echo",
      jsonPost({ n: 1 }, { Cookie: cookie }),
    );
    expect(await response.json()).toEqual({
      body: { n: 1 },
      secret: "k",
      signed: { session: "user-42" },
    });
  });

  it("setRequestOpts() and the setter merge over the defaults, not over the previous options", async () => {
    const adapter = new BunHttpAdapter(0, { request: { cookieSecret: "k" } });

    expect(adapter.setRequestOpts({ parseQuery: false })).toBe(adapter);
    expect(adapter.requestOpts).toEqual({
      parseBody: true,
      parseCookies: true,
      parseQuery: false,
    });
    adapter.post("/echo", (req, res) => res.json({ body: req.body ?? null }));
    const response = await adapter.fetch("/echo", jsonPost({ n: 2 }));
    expect(await response.json()).toEqual({ body: { n: 2 } });

    adapter.requestOpts = { parseCookies: false };
    expect(adapter.requestOpts).toEqual({
      parseBody: true,
      parseCookies: false,
    });
    const afterSetter = await adapter.fetch("/echo", jsonPost({ n: 3 }));
    expect(await afterSetter.json()).toEqual({ body: { n: 3 } });
  });

  it("an explicit parseBody: false still turns body parsing off", async () => {
    const adapter = new BunHttpAdapter(0, { request: { parseBody: false } });
    expect(adapter.requestOpts).toEqual({
      parseBody: false,
      parseCookies: true,
    });
    adapter.post("/echo", (req, res) => res.json({ body: req.body ?? null }));
    const response = await adapter.fetch("/echo", jsonPost({ n: 4 }));
    expect(await response.json()).toEqual({ body: null });

    adapter.setRequestOpts({ parseBody: false, parseCookies: false });
    expect(adapter.requestOpts).toEqual({
      parseBody: false,
      parseCookies: false,
    });
  });

  it("a nested parseBody object is kept whole beside the other defaults and merges as mergeBunRequestOptions does", async () => {
    const nested = {
      parseBody: {
        maxContentLength: 20,
        contentTypes: { json: true, text: false },
      },
    };
    const adapter = new BunHttpAdapter(0, { request: nested });
    expect(adapter.requestOpts).toEqual({
      parseBody: {
        maxContentLength: 20,
        contentTypes: { json: true, text: false },
      },
      parseCookies: true,
    });
    expect(adapter.requestOpts).toEqual(mergeBunRequestOptions(nested));
    // The caller's object is not modified.
    expect(nested).toEqual({
      parseBody: {
        maxContentLength: 20,
        contentTypes: { json: true, text: false },
      },
    });

    adapter.post("/echo", (req, res) => res.json({ body: req.body ?? null }));
    const small = await adapter.fetch("/echo", jsonPost({ n: 5 }));
    expect(await small.json()).toEqual({ body: { n: 5 } });
    const large = await adapter.fetch("/echo", jsonPost({ x: "y".repeat(50) }));
    expect(large.status).toBe(413);

    // Nested objects merge field by field over an object base. (The live
    // `requestOpts` is not used as the base: `BunRequest` fills its parsing
    // defaults into that object once a request has been built.)
    expect(
      mergeBunRequestOptions(
        { parseBody: { contentTypes: { text: true } } },
        mergeBunRequestOptions(nested),
      ),
    ).toEqual({
      parseBody: {
        maxContentLength: 20,
        contentTypes: { json: true, text: true },
      },
      parseCookies: true,
    });
  });
});

describe("BunHttpAdapter.fetch: a Request from before a DOM shim replaced globalThis.Request", () => {
  it("keeps the request's method and body", async () => {
    const adapter = new BunHttpAdapter();
    adapter.post("/echo", (req, res) => {
      res.json({ method: req.method, body: req.body });
    });
    const native = globalThis.Request;
    const built = new Request("http://localhost/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "hello" }),
    });

    // As happy-dom's `GlobalRegistrator` does: a working `Request`, but a
    // different class, so `built` is no longer an `instanceof` the global.
    globalThis.Request = class ShimRequest extends native {};
    let response: Response;
    try {
      response = await adapter.fetch(built);
    } finally {
      globalThis.Request = native;
    }

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      method: "POST",
      body: { title: "hello" },
    });
  });
});

describe("BunHttpAdapter: a JSON body and rawBody", () => {
  const body = '{"n":7}';
  /** A served-shaped JSON POST: it carries its Content-Length. */
  const post = () =>
    new Request("http://h/j", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "7" },
      body,
    });

  it("keeps the bytes by default; retainBuffer: false reads JSON with request.json()", async () => {
    for (const [retainBuffer, kept] of [
      [undefined, true],
      [false, false],
    ] as const) {
      const adapter = new BunHttpAdapter(0, { request: { retainBuffer } });
      adapter.useBodyParser("json", false, {});
      adapter.post("/j", (req, res) => {
        res.json({ body: req.body, kept: req.buffer !== undefined });
      });
      expect(await (await adapter.fetch(post())).json()).toEqual({
        body: { n: 7 },
        kept,
      });
    }
  });

  it("with rawBody (Nest's rawBody: true), keeps every body's bytes", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.registerParserMiddleware(undefined, true);
    adapter.post("/j", (req, res) => {
      res.json({
        body: req.body,
        raw: (req as unknown as { rawBody?: Buffer }).rawBody?.toString(),
      });
    });
    expect(adapter.requestOpts.retainBuffer).toBe(true);
    adapter.setRequestOpts({ parseCookies: false });
    expect(adapter.requestOpts.retainBuffer).toBe(true);
    expect(await (await adapter.fetch(post())).json()).toEqual({
      body: { n: 7 },
      raw: body,
    });
  });
});

describe("BunHttpAdapter: one BunViews for the adapter and its router", () => {
  it("gives its bun-common router the adapter's views, so the router's fetch() renders the same", async () => {
    const adapter = new BunHttpAdapter();
    const router = adapter.getInstance();
    expect(router.views).toBe(adapter.views);

    adapter.engine("txt", (_path, options, callback) => {
      callback(null, `site=${String(options.site)}`);
    });
    adapter.setLocal("site", "S");
    const dir = await mkdtemp(join(tmpdir(), "bun-nest-views-"));
    await writeFile(join(dir, "page.txt"), "");
    adapter.views.root = dir;
    router.get("/page", (_req, res) => res.render("page.txt"));
    try {
      expect(await (await router.fetch("/page")).text()).toBe("site=S");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Whether the installed `@nestjs/core` is 12 or later, by the capability the
 * adapter reads (`mapException`, added in 12.0.0), never a version string.
 */
const NEST_12 =
  typeof (AbstractHttpAdapter.prototype as { mapException?: unknown })
    .mapException === "function";

describe("BunHttpAdapter.mapException (Nest 12's exception layer calls it)", () => {
  const adapter = new BunHttpAdapter();

  it("maps a SyntaxError or URIError to a BadRequestException with its message, as Express", () => {
    for (const error of [
      new SyntaxError("Unexpected end of JSON input"),
      new URIError("Failed to decode param '%FF'"),
    ]) {
      const mapped = adapter.mapException(error);
      expect(mapped).toBeInstanceOf(BadRequestException);
      expect((mapped as BadRequestException).getStatus()).toBe(400);
      expect((mapped as BadRequestException).getResponse()).toEqual({
        message: error.message,
        error: "Bad Request",
        statusCode: 400,
      });
    }
  });

  it("returns anything else as it is", () => {
    const typeError = new TypeError("nope");
    const plain = { statusCode: 409, message: "conflict" };
    expect(adapter.mapException(typeError)).toBe(typeError);
    expect(adapter.mapException(plain)).toBe(plain);
    expect(adapter.mapException("text")).toBe("text");
    expect(adapter.mapException(undefined)).toBeUndefined();
  });
});

describe("BunHttpAdapter.isRouteOrderSensitive", () => {
  it("is true: routes match in registration order, as on Express", () => {
    expect(new BunHttpAdapter().isRouteOrderSensitive()).toBe(true);
  });
});

describe("BunHttpAdapter.set: x-powered-by", () => {
  /** An adapter whose logger's `warn` is recorded. */
  function withWarnings() {
    const logger = new Logger("test");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    return { adapter: new BunHttpAdapter(0, { logger }), warn };
  }

  it("turning it off is silent: the adapter never sends the header (Nest 12's useSecurityHeaders)", () => {
    const { adapter, warn } = withWarnings();
    adapter.disable("x-powered-by");
    adapter.set("x-powered-by", false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("turning it on, or any other setting, still warns once", () => {
    const { adapter, warn } = withWarnings();
    adapter.enable("x-powered-by");
    adapter.enable("x-powered-by");
    adapter.set("trust proxy", true);
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining('app.set("x-powered-by")'),
      expect.stringContaining('app.set("trust proxy")'),
    ]);
  });
});

describe("BunHttpAdapter.createMiddlewareFactory: the core's exact-match `$`", () => {
  /** An adapter with routes under `/api`, and the middleware calls it saw. */
  function withMiddleware(method: RequestMethod, path: string) {
    const adapter = new BunHttpAdapter();
    const seen: string[] = [];
    adapter.createMiddlewareFactory(method)(
      path,
      (
        req: { method: string; path: string },
        res: { setHeader: (name: string, value: string) => void },
        next: () => void,
      ) => {
        seen.push(`${req.method} ${req.path}`);
        res.setHeader("x-mw", "ran");
        next();
      },
    );
    adapter.get("/api/x", (_req, res) => {
      res.send("x");
    });
    adapter.post("/api", (_req, res) => {
      res.send("posted");
    });
    return { adapter, seen };
  }

  it("runs on exactly that path, not below it; with a trailing slash only where the core runs a middleware once (12.2.0)", async () => {
    // Nest 12.2.0's core runs a middleware once per request, so, as
    // platform-express 12.2.0, `/api/` runs it too; on an earlier core it is
    // skipped there, as platform-express 12.1.3 skips it, since the wildcard
    // path beside it may run it again.
    const once = await coreRunsMiddlewareOnce();
    const { adapter, seen } = withMiddleware(RequestMethod.ALL, "/api$");
    // The middleware runs, and alone does not make a route: still a miss.
    expect((await adapter.fetch("/api")).status).toBe(404);
    expect(seen).toEqual(["GET /api"]);
    // A miss answers without the middleware's headers: read `seen`.
    await adapter.fetch("/api/");
    expect(seen).toEqual(once ? ["GET /api", "GET /api/"] : ["GET /api"]);
    expect((await adapter.fetch("/api/x")).headers.get("x-mw")).toBeNull();
    expect((await adapter.fetch("/apix")).headers.get("x-mw")).toBeNull();
    expect((await adapter.fetch("/api$")).headers.get("x-mw")).toBeNull();
    const posted = await adapter.fetch("/api", { method: "POST" });
    expect([await posted.text(), posted.headers.get("x-mw")]).toEqual([
      "posted",
      "ran",
    ]);
    expect(seen).toEqual(
      once ? ["GET /api", "GET /api/", "POST /api"] : ["GET /api", "POST /api"],
    );
  });

  it("keeps a method: GET middleware skips a POST", async () => {
    const { adapter, seen } = withMiddleware(RequestMethod.GET, "/api$");
    await adapter.fetch("/api", { method: "POST" });
    await adapter.fetch("/api");
    expect(seen).toEqual(["GET /api"]);
  });

  it("control: a path without the marker is still a prefix", async () => {
    const { adapter, seen } = withMiddleware(RequestMethod.ALL, "/api");
    await adapter.fetch("/api/x");
    await adapter.fetch("/api");
    expect(seen).toEqual(["GET /api/x", "GET /api"]);
  });
});

describe("BunHttpAdapter.setNotFoundHandler: scoped to the global prefix on Nest 12", () => {
  /** A not-found handler like Nest's, answering JSON with its name. */
  function notFound(name: string): RouterMiddlewareHandler {
    return (req, res) => {
      res.status(404).json({ by: name, path: req.path });
    };
  }

  /** Status, `by` (which handler answered, `"html"` for the page) and body. */
  async function answer(adapter: BunHttpAdapter, path: string, init = {}) {
    const res = await adapter.fetch(path, init);
    const text = await res.text();
    const type = res.headers.get("content-type") ?? "";
    return {
      status: res.status,
      by: type.startsWith("text/html")
        ? "html"
        : (JSON.parse(text) as { by: string }).by,
      text,
    };
  }

  it("answers outside the prefix with finalhandler's page on 12, its handler on 11", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/api/hello", (_req, res) => {
      res.send("hi");
    });
    adapter.setNotFoundHandler(notFound("api"), "api/");

    const inside = await answer(adapter, "/api/nope");
    expect([inside.status, inside.by]).toEqual([404, "api"]);
    // On whole segments, case-insensitively, as Express's `use("/api")`.
    expect((await answer(adapter, "/api")).by).toBe("api");
    expect((await answer(adapter, "/API/nope")).by).toBe("api");

    const outside = await answer(adapter, "/apiary?x=1");
    if (NEST_12) {
      expect([outside.status, outside.by]).toEqual([404, "html"]);
      expect(outside.text).toContain("<pre>Cannot GET /apiary</pre>");
    } else {
      expect([outside.status, outside.by]).toEqual([404, "api"]);
    }
  });

  it("builds the page from bun-common's 404, with finalhandler's text, escaped", async () => {
    if (!NEST_12) {
      return;
    }
    const adapter = new BunHttpAdapter();
    adapter.setNotFoundHandler(notFound("api"), "/api");
    const res = await adapter.fetch("/it's&<odd>?q=1", { method: "DELETE" });
    const base = finalErrorResponse({ status: 404 }, { method: "GET" });
    expect(res.status).toBe(404);
    expect(Object.fromEntries(res.headers)).toEqual(
      Object.fromEntries(base.headers),
    );
    expect(await res.text()).toBe(
      (await base.text()).replace(
        "<pre>Not Found</pre>",
        "<pre>Cannot DELETE /it&#39;s&amp;%3Codd%3E</pre>",
      ),
    );

    const head = await adapter.fetch("/nope", { method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([404, ""]);
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("keeps the headers middleware set, less the three finalhandler removes", async () => {
    if (!NEST_12) {
      return;
    }
    const adapter = new BunHttpAdapter();
    adapter.use((_req, res, next) => {
      res.setHeader("x-custom", "kept");
      res.setHeader("content-language", "fr");
      res.setHeader("content-encoding", "gzip");
      res.setHeader("content-range", "bytes 0-1/2");
      res.setHeader("content-type", "application/json");
      res.append("set-cookie", "a=1");
      res.append("set-cookie", "b=2");
      next();
    });
    adapter.setNotFoundHandler(notFound("api"), "api");
    const res = await adapter.fetch("/other");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-custom")).toBe("kept");
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    for (const removed of [
      "content-language",
      "content-encoding",
      "content-range",
    ]) {
      expect(res.headers.get(removed)).toBeNull();
    }
    // The page's own headers win over what middleware set.
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("<pre>Cannot GET /other</pre>");
  });

  it("matches a parameterised prefix as Express's use() does: any first segment", async () => {
    const adapter = new BunHttpAdapter();
    adapter.setNotFoundHandler(notFound("tenant"), ":tenant");
    for (const path of ["/t1/missing", "/other", "/T2"]) {
      expect((await answer(adapter, path)).by).toBe("tenant");
    }
    expect((await answer(adapter, "/")).by).toBe(NEST_12 ? "html" : "tenant");
  });

  it("answers every method on an excluded route's path, as Express 12.1.3", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/health", (_req, res) => {
      res.send("healthy");
    });
    adapter.setNotFoundHandler(notFound("api"), "api", [
      { path: "health", method: RequestMethod.GET },
    ]);
    expect(await (await adapter.fetch("/health")).text()).toBe("healthy");
    const post = await answer(adapter, "/health", { method: "POST" });
    expect([post.status, post.by]).toEqual([404, "api"]);
    const below = await answer(adapter, "/health/x");
    expect(below.by).toBe(NEST_12 ? "html" : "api");
  });

  it("several applications on one adapter: an unprefixed handler leaves other prefixes alone", async () => {
    const adapter = new BunHttpAdapter();
    // Registered first, as when the unprefixed application initialises first.
    adapter.setNotFoundHandler(notFound("root"));
    adapter.setNotFoundHandler(notFound("api"), "api");
    adapter.setNotFoundHandler(notFound("admin"), "/admin/");

    const by = async (path: string) => (await answer(adapter, path)).by;
    if (NEST_12) {
      expect(await by("/api/x")).toBe("api");
      expect(await by("/admin")).toBe("admin");
      expect(await by("/elsewhere")).toBe("root");
      expect(await by("/apiary")).toBe("root");
    } else {
      // Nest 11: every handler is global; the first registered answers.
      for (const path of ["/api/x", "/admin", "/elsewhere"]) {
        expect(await by(path)).toBe("root");
      }
    }
  });

  it("reads a non-string prefix (an array from setGlobalPrefix) as none, as Express", async () => {
    const adapter = new BunHttpAdapter();
    // Nest hands `setGlobalPrefix(["api", "v1"])`'s array over as it is.
    adapter.setNotFoundHandler(notFound("root"), [
      "api",
      "v1",
    ] as unknown as string);
    for (const path of ["/api/x", "/v1", "/elsewhere"]) {
      expect((await answer(adapter, path)).by).toBe("root");
    }
  });

  it("without a prefix answers everywhere, on 11 and 12", async () => {
    const adapter = new BunHttpAdapter();
    adapter.setNotFoundHandler(notFound("root"), "");
    expect((await answer(adapter, "/anything")).by).toBe("root");
    expect((await answer(adapter, "/")).by).toBe("root");
  });

  it("matches a plain prefix exactly as the routejs prefix regex it skips would", async () => {
    // A plain prefix is compared without the regex; this pins the two
    // together, the regex built here as bun-common compiles a `use()` group.
    const prefix = "/Api.v-1_x~y/v2";
    const regexp = new RegExp(
      (
        new RouteClass({ group: prefix, callbacks: [] }) as unknown as {
          pathRegexp: RegExp;
        }
      ).pathRegexp.source,
      "i",
    );
    const adapter = new BunHttpAdapter();
    adapter.setNotFoundHandler(notFound("api"), prefix);
    const paths = [
      "/Api.v-1_x~y/v2",
      "/api.v-1_x~y/v2",
      "/API.V-1_X~Y/V2/",
      "/api.v-1_x~y/v2/x",
      "/api.v-1_x~y/v2//x",
      "/api.v-1_x~y/v2?q=1",
      "/api.v-1_x~y/v2x",
      "/api.v-1_x~y/v",
      "/api.v-1_x~y",
      "/apixv-1_x~y/v2",
      "/api.v-1_x~y/v2%2Fx",
      "/%41pi.v-1_x~y/v2",
      "/",
    ];
    for (const path of paths) {
      const expected =
        NEST_12 && !regexp.test(path.split("?")[0]) ? "html" : "api";
      expect([path, (await answer(adapter, path)).by]).toEqual([
        path,
        expected,
      ]);
    }
  });

  it("answers each combination of handlers in turn, and sees a handler added after a miss", async () => {
    const adapter = new BunHttpAdapter();
    adapter.setNotFoundHandler(notFound("root"));
    const by = async (path: string) => (await answer(adapter, path)).by;
    // Unscoped only (every handler, on Nest 11): no path read.
    expect(await by("/api/x")).toBe("root");
    adapter.setNotFoundHandler(notFound("api"), "api");
    // Alternating, so a remembered list is reused and never answers for
    // another combination.
    for (let round = 0; round < 3; round++) {
      expect(await by("/api/x")).toBe(NEST_12 ? "api" : "root");
      expect(await by("/elsewhere")).toBe("root");
    }
    adapter.setNotFoundHandler(notFound("admin"), "admin");
    expect(await by("/admin/x")).toBe(NEST_12 ? "admin" : "root");
    expect(await by("/api/x")).toBe(NEST_12 ? "api" : "root");
    expect(await by("/elsewhere")).toBe("root");
  });
});

describe("BunHttpAdapter.query (HTTP QUERY, RFC 10008), on every Nest version", () => {
  it("registers a QUERY route that reads the body; GET and HEAD are not it", async () => {
    const adapter = new BunHttpAdapter();
    adapter.query("/search", (req, res) => {
      res.json({ method: req.method, body: req.body });
    });
    const res = await adapter.fetch("/search", {
      method: "QUERY",
      headers: { "content-type": "application/json" },
      body: '{"q":"bun"}',
    });
    expect([res.status, await res.json()]).toEqual([
      200,
      { method: "QUERY", body: { q: "bun" } },
    ]);
    for (const method of ["GET", "HEAD"]) {
      expect((await adapter.fetch("/search", { method })).status).toBe(404);
    }
  });

  it("maps RequestMethod.QUERY where Nest has it (11.2+), and refuses it nowhere else", () => {
    const adapter = new BunHttpAdapter();
    const query = (
      RequestMethod as unknown as Record<string, RequestMethod | undefined>
    ).QUERY;
    if (query !== undefined) {
      expect(adapter.getRequestMethodStr(query)).toBe("query");
    }
    // An unknown value still fails, as before.
    expect(() => adapter.getRequestMethodStr(999 as RequestMethod)).toThrow(
      "An invalid request method was encountered with value 999",
    );
  });
});
