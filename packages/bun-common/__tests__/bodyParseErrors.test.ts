import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { requestParsing } from "../lib";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { createTestLogger } from "../lib/logging";
import { testServer } from "./helpers";

/**
 * A body declared JSON that does not parse is a client error, answered 400
 * as Express's body-parser answers it (`type: "entity.parse.failed"`, the
 * text in `body`), and such an error is logged as a warning without the
 * request it carries.
 */

const JSON_HEADERS = { "content-type": "application/json" };

describe("invalid JSON in a body declared JSON", () => {
  it("is answered 400 before routing, through the error handlers", async () => {
    const app = new BunHttpAdapter(0);
    let routed = false;
    app.post("/e", (_req, res) => {
      routed = true;
      res.send("routed");
    });
    const response = await app.fetch("/e", {
      method: "POST",
      headers: JSON_HEADERS,
      body: '{"a":',
    });
    expect(response.status).toBe(400);
    expect(routed).toBe(false);
  });

  it("reaches the adapter's error handlers as body-parser's error, with req", async () => {
    // A body read while the request is built fails before any middleware, so
    // its error goes to setErrorHandler()'s handlers (with deferBody, to the
    // pipeline's — see the requestParsing() case below).
    const app = new BunHttpAdapter(0);
    app.post("/e", (_req, res) => res.send("routed"));
    const seen: Record<string, unknown>[] = [];
    app.setErrorHandler(((err, req, res, _next) => {
      const error = err as Error & Record<string, unknown>;
      seen.push({
        status: error.status,
        statusCode: error.statusCode,
        expose: error.expose,
        type: error.type,
        body: error.body,
        hasReq: error.req === req,
        reqEnumerable: Object.keys(error).includes("req"),
      });
      res.status(error.status as number).json({ type: error.type });
    }) satisfies RouterErrorMiddlewareHandler);
    const response = await app.fetch("/e", {
      method: "POST",
      headers: { "content-type": "application/vnd.api+json" },
      body: "{nope",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ type: "entity.parse.failed" });
    expect(seen).toEqual([
      {
        status: 400,
        statusCode: 400,
        expose: true,
        type: "entity.parse.failed",
        body: "{nope",
        hasReq: true,
        reqEnumerable: false,
      },
    ]);
  });

  it("is recorded on the request, which never completes", async () => {
    const req = await BunRequest.init(
      new Request("http://h/", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "[1,",
      }),
      testServer,
      { parseBody: true, parseCookies: false },
    );
    expect(req.body).toBeUndefined();
    expect(req.bodyDecodingError).toMatchObject({
      status: 400,
      type: "entity.parse.failed",
    });
    expect(req.complete).toBe(false);
    // A second parse answers from the cached (failed) read.
    expect((await req.parseBody()).body).toBeUndefined();
  });

  it("is passed to next(err) by requestParsing() on a deferred body", async () => {
    const app = new BunHttpAdapter(0, { request: { deferBody: true } });
    app.use("/e", requestParsing({ parseBody: { maxContentLength: "1kb" } }));
    app.post("/e", (_req, res) => res.send("routed"));
    app.use(((err, _req, res, _next) => {
      const error = err as Error & { status: number; type: string };
      res.status(error.status).send(error.type);
    }) satisfies RouterErrorMiddlewareHandler);
    const response = await app.fetch("/e", {
      method: "POST",
      headers: JSON_HEADERS,
      body: '{"a":',
    });
    expect([response.status, await response.text()]).toEqual([
      400,
      "entity.parse.failed",
    ]);
  });

  it("leaves valid JSON, empty JSON and undeclared bodies as they were", async () => {
    const app = new BunHttpAdapter(0);
    app.post("/e", (req, res) => res.json({ body: req.body ?? null }));
    const valid = await app.fetch("/e", {
      method: "POST",
      headers: JSON_HEADERS,
      body: '"just a string"',
    });
    expect(await valid.json()).toEqual({ body: "just a string" });
    const empty = await app.fetch("/e", {
      method: "POST",
      headers: { ...JSON_HEADERS, "content-length": "0" },
      body: "",
    });
    expect(await empty.json()).toEqual({ body: {} });
    // No content type: JSON is only a guess, so a miss tries the other kinds.
    const undeclared = await app.fetch("/e", {
      method: "POST",
      body: "a=1",
    });
    expect([undeclared.status, await undeclared.json()]).toEqual([
      200,
      { body: { a: "1" } },
    ]);
    // A JSON kind turned off leaves the body raw rather than refusing it.
    const rawApp = new BunHttpAdapter(0, {
      request: { parseBody: { contentTypes: { text: true } } },
    });
    rawApp.post("/e", (req, res) => {
      res.send(String(req.body instanceof Uint8Array));
    });
    const raw = await rawApp.fetch("/e", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{nope",
    });
    expect([raw.status, await raw.text()]).toEqual([200, "true"]);
  });
});

describe("logging an unhandled client error", () => {
  let previous: string | undefined;
  beforeEach(() => {
    // The adapters stay quiet under NODE_ENV=test, as Express does.
    previous = Bun.env.NODE_ENV;
    Bun.env.NODE_ENV = "development";
  });
  afterEach(() => {
    Bun.env.NODE_ENV = previous;
  });

  it("logs a 4xx as a warning and a 5xx as an error", async () => {
    const app = new BunHttpAdapter(0);
    const { logger, events } = createTestLogger();
    app.setLogger(logger);
    app.post("/e", (_req, res) => res.send("routed"));
    app.get("/boom", () => {
      throw new Error("boom");
    });
    await app.fetch("/e", { method: "POST", headers: JSON_HEADERS, body: "{" });
    await app.fetch("/boom");
    const levels = events
      .filter((e) => e.message === "Unhandled error while handling a request")
      .map((e) => [e.level, e.fields?.status]);
    expect(levels).toEqual([
      ["warn", 400],
      ["error", 500],
    ]);
  });

  it("does not print the request riding on the error", async () => {
    const app = new BunHttpAdapter(0);
    const { logger, events } = createTestLogger();
    app.setLogger(logger);
    app.get("/boom", () => {
      throw new Error("boom");
    });
    await app.fetch("/boom");
    const event = events.find((e) => e.level === "error");
    expect(event?.error?.message).toBe("boom");
    const printed = Bun.inspect(event?.error);
    expect(printed).not.toContain("BunRequest");
    expect(printed.length).toBeLessThan(2000);
  });
});
