import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "bun:test";
import { requestParsing, signCookie } from "../lib";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { testServer } from "./helpers";

/** A JSON POST of `bytes` bytes (a `{"pad":"xxx…"}` object). */
function jsonBody(bytes: number): string {
  const overhead = '{"pad":""}'.length;
  return JSON.stringify({ pad: "x".repeat(Math.max(0, bytes - overhead)) });
}

function post(
  adapter: BunHttpAdapter,
  path: string,
  body: string,
  headers: Record<string, string> = {},
) {
  return adapter.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

/** An error handler answering with the error's status and message as JSON. */
const errorsAsJson = ((err, _req, res, _next) => {
  const status = (err as { status?: number }).status ?? 500;
  res.status(status).json({ status, message: (err as Error).message });
}) satisfies RouterErrorMiddlewareHandler;

describe("deferBody", () => {
  it("routes a request with a body unread, and reads it before the first route handler", async () => {
    const adapter = new BunHttpAdapter(0, { request: { deferBody: true } });
    const seen: unknown[] = [];
    adapter.use((req, _res, next) => {
      seen.push({ deferred: req.hasDeferredBody, body: req.body });
      next();
    });
    adapter.post("/echo", (req, res) => res.json({ body: req.body }));
    const response = await post(adapter, "/echo", '{"n":1}');
    expect(await response.json()).toEqual({ body: { n: 1 } });
    expect(seen).toEqual([{ deferred: true, body: undefined }]);
  });

  it("leaves a request without a body as it was: synchronous, nothing deferred", () => {
    const created = BunRequest.init(
      new Request("http://localhost/"),
      testServer,
      {
        parseBody: true,
        deferBody: true,
      },
    );
    expect(created).toBeInstanceOf(BunRequest);
    expect((created as BunRequest).hasDeferredBody).toBe(false);
    expect((created as BunRequest).complete).toBe(true);
  });

  it("returns the request synchronously even with a body, which ready() then reads", async () => {
    const created = BunRequest.init(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"a":true}',
      }),
      testServer,
      { parseBody: true, deferBody: true },
    );
    expect(created).toBeInstanceOf(BunRequest);
    const req = created as BunRequest;
    expect(req.hasDeferredBody).toBe(true);
    expect(req.complete).toBe(false);
    const settled = await req.ready();
    expect(settled.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    expect(req.body).toEqual({ a: true });
    expect(req.complete).toBe(true);
    expect(req.hasDeferredBody).toBe(false);
  });

  it("reports a failed deferred read through ready() as a rejection", async () => {
    const req = BunRequest.init(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: jsonBody(64),
      }),
      testServer,
      { parseBody: { maxContentLength: 16 }, deferBody: true },
    ) as BunRequest;
    const settled = await req.ready();
    expect(settled[1].status).toBe("rejected");
    expect(req.isPayloadTooLarge).toBe(true);
  });

  it("hands a body over the cap to the error handlers as a 413, after the middleware ran", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: { maxContentLength: 32 }, deferBody: true },
    });
    let middlewareRan = false;
    let routeRan = false;
    adapter.use((_req, _res, next) => {
      middlewareRan = true;
      next();
    });
    adapter.post("/small", (_req, res) => {
      routeRan = true;
      res.send("ok");
    });
    adapter.use(errorsAsJson);
    const response = await post(adapter, "/small", jsonBody(200));
    expect(response.status).toBe(413);
    expect(middlewareRan).toBe(true);
    expect(routeRan).toBe(false);
  });

  it("emits end once a deferred body is read", async () => {
    const adapter = new BunHttpAdapter(0, { request: { deferBody: true } });
    const events: string[] = [];
    adapter.use((req, _res, next) => {
      req.on("data", () => events.push("data"));
      req.on("end", () => events.push("end"));
      next();
    });
    adapter.post("/e", (req, res) => {
      res.json({ complete: req.complete });
    });
    const response = await post(adapter, "/e", '{"x":1}');
    expect(await response.json()).toEqual({ complete: true });
    await Promise.resolve();
    expect(events).toEqual(["data", "end"]);
  });

  it("works with the adapter's body-parser middleware, whose limit applies to the read", async () => {
    const adapter = new BunHttpAdapter(0, { request: { deferBody: true } });
    adapter.useBodyParser("json", false, { limit: 64 });
    adapter.post("/p", (req, res) => res.json(req.body));
    adapter.use(errorsAsJson);
    expect(await (await post(adapter, "/p", '{"ok":1}')).json()).toEqual({
      ok: 1,
    });
    expect((await post(adapter, "/p", jsonBody(500))).status).toBe(413);
  });
});

describe("requestParsing: body", () => {
  it("raises the cap for its route only, with deferBody", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: { maxContentLength: 64 }, deferBody: true },
    });
    adapter.use(
      "/upload",
      requestParsing({ parseBody: { maxContentLength: 4096 } }),
    );
    adapter.post("/upload", (req, res) => {
      res.json({ length: (req.body as { pad: string }).pad.length });
    });
    adapter.post("/other", (_req, res) => res.send("ok"));
    adapter.use(errorsAsJson);

    const big = jsonBody(1000);
    const upload = await post(adapter, "/upload", big);
    expect(upload.status).toBe(200);
    expect(await upload.json()).toEqual({ length: 1000 - 10 });
    expect((await post(adapter, "/other", big)).status).toBe(413);
    // Over the route's own cap too.
    expect((await post(adapter, "/upload", jsonBody(5000))).status).toBe(413);
  });

  it("isolates concurrent requests on different routes", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: { maxContentLength: 64 }, deferBody: true },
    });
    adapter.use("/big", requestParsing({ parseBody: true }));
    adapter.post("/big", (_req, res) => res.send("big"));
    adapter.post("/small", (_req, res) => res.send("small"));
    adapter.use(errorsAsJson);
    const body = jsonBody(800);
    const statuses = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const response = await post(adapter, i % 2 ? "/big" : "/small", body);
        return response.status;
      }),
    );
    expect(statuses).toEqual(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? 200 : 413)),
    );
  });

  it("lowers the cap of a body already read (without deferBody)", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: { maxContentLength: 4096 } },
    });
    adapter.use(
      "/strict",
      requestParsing({ parseBody: { maxContentLength: 50 } }),
    );
    adapter.post("/strict", (req, res) => res.json(req.body));
    adapter.post("/loose", (req, res) => res.json(req.body));
    adapter.use(errorsAsJson);
    const body = jsonBody(200);
    const strict = await post(adapter, "/strict", body);
    expect(strict.status).toBe(413);
    expect(((await strict.json()) as { status: number }).status).toBe(413);
    expect((await post(adapter, "/loose", body)).status).toBe(200);
    expect(await (await post(adapter, "/strict", '{"a":1}')).json()).toEqual({
      a: 1,
    });
  });

  it("cannot raise a cap the adapter already enforced, without deferBody", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: { maxContentLength: 32 } },
    });
    let reached = false;
    adapter.use("/upload", (req, res, next) => {
      reached = true;
      requestParsing({ parseBody: true })(req, res, next);
    });
    adapter.post("/upload", (_req, res) => res.send("ok"));
    // Refused while the request was built, before any middleware.
    expect((await post(adapter, "/upload", jsonBody(200))).status).toBe(413);
    expect(reached).toBe(false);
  });

  it("parseBody: false leaves the body unparsed for its route", async () => {
    for (const deferBody of [false, true]) {
      const adapter = new BunHttpAdapter(0, { request: { deferBody } });
      adapter.use("/raw", requestParsing({ parseBody: false }));
      adapter.post("/raw", (req, res) => {
        res.json({ body: req.body ?? null, deferred: req.hasDeferredBody });
      });
      adapter.post("/parsed", (req, res) => res.json({ body: req.body }));
      expect(await (await post(adapter, "/raw", '{"a":1}')).json()).toEqual({
        body: null,
        deferred: false,
      });
      expect(await (await post(adapter, "/parsed", '{"a":1}')).json()).toEqual({
        body: { a: 1 },
      });
    }
  });

  it("restricts content types for its route", async () => {
    const adapter = new BunHttpAdapter(0, { request: { deferBody: true } });
    adapter.use(
      "/json-only",
      requestParsing({ parseBody: { contentTypes: { json: true } } }),
    );
    adapter.post("/json-only", (req, res) => {
      res.json({ isBuffer: Buffer.isBuffer(req.body) });
    });
    const response = await adapter.fetch("/json-only", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    expect(await response.json()).toEqual({ isBuffer: true });
  });

  it("passes an encoding the route refuses to next(err) as a 415", async () => {
    const adapter = new BunHttpAdapter(0, { request: { deferBody: true } });
    adapter.use("/plain", requestParsing({ parseBody: { inflate: false } }));
    adapter.post("/plain", (_req, res) => res.send("ok"));
    adapter.use(errorsAsJson);
    const gz = Bun.gzipSync(Buffer.from('{"a":1}'));
    const response = await adapter.fetch("/plain", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: gz,
    });
    expect(response.status).toBe(415);
  });

  it("makes the body visible to the middleware after it", async () => {
    const adapter = new BunHttpAdapter(0, { request: { deferBody: true } });
    let seen: unknown;
    adapter.use(requestParsing({ parseBody: true }), (req, _res, next) => {
      seen = req.body;
      next();
    });
    adapter.post("/x", (_req, res) => res.send("ok"));
    await post(adapter, "/x", '{"early":true}');
    expect(seen).toEqual({ early: true });
  });
});

describe("requestParsing: query and cookies", () => {
  it("re-parses the query with the route's options", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.use("/flat", requestParsing({ parseQuery: { nesting: false } }));
    adapter.use("/off", requestParsing({ parseQuery: false }));
    for (const path of ["/flat", "/off", "/nested"]) {
      adapter.get(path, (req, res) => res.json(req.query));
    }
    expect(await (await adapter.fetch("/flat?a[b]=1")).json()).toEqual({
      "a[b]": "1",
    });
    expect(await (await adapter.fetch("/off?a=1")).json()).toEqual({});
    expect(await (await adapter.fetch("/nested?a[b]=1")).json()).toEqual({
      a: { b: "1" },
    });
  });

  it("verifies signed cookies with the route's secret, and only on that route", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.use(
      "/secure",
      requestParsing({ parseCookies: { secret: ["new", "old"] } }),
    );
    for (const path of ["/secure", "/plain"]) {
      adapter.get(path, (req, res) => {
        const { cookies, signedCookies: signed, secret } = req;
        res.json({ cookies, signed, secret: secret ?? null });
      });
    }
    const cookie = `sid=s:${signCookie("abc", "old")}; theme=dark`;
    const secure = await adapter.fetch("/secure", { headers: { cookie } });
    expect(await secure.json()).toEqual({
      cookies: { theme: "dark" },
      signed: { sid: "abc" },
      secret: "new",
    });
    const plain = await adapter.fetch("/plain", { headers: { cookie } });
    expect(await plain.json()).toEqual({
      cookies: { sid: `s:${signCookie("abc", "old")}`, theme: "dark" },
      signed: {},
      secret: null,
    });
  });

  it("parseCookies: true parses again with no secret, even if the adapter has one", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseCookies: { secret: "s" } },
    });
    adapter.use("/plain", requestParsing({ parseCookies: true }));
    adapter.get("/plain", (req, res) => {
      res.json({ signed: req.signedCookies, secret: req.secret ?? null });
    });
    adapter.get("/secure", (req, res) => {
      res.json({ signed: req.signedCookies });
    });
    const cookie = `sid=s:${signCookie("abc", "s")}`;
    const plain = await adapter.fetch("/plain", { headers: { cookie } });
    expect(await plain.json()).toEqual({ signed: {}, secret: null });
    const secure = await adapter.fetch("/secure", { headers: { cookie } });
    expect(await secure.json()).toEqual({ signed: { sid: "abc" } });
  });

  it("parseCookies: false empties the cookies for its route", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.use("/nocookies", requestParsing({ parseCookies: false }));
    adapter.get("/nocookies", (req, res) => res.json(req.cookies));
    const response = await adapter.fetch("/nocookies", {
      headers: { cookie: "a=1" },
    });
    expect(await response.json()).toEqual({});
  });

  it("applies the cookie parser's options", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.use(
      requestParsing({
        parseCookies: { decode: (value: string) => value.toUpperCase() },
      }),
    );
    adapter.get("/c", (req, res) => res.json(req.cookies));
    const response = await adapter.fetch("/c", { headers: { cookie: "a=hi" } });
    expect(await response.json()).toEqual({ a: "HI" });
  });
});

describe("requestParsing: options", () => {
  it("rejects options of the wrong type when created", () => {
    const bad: unknown[] = [
      null,
      { parseQuery: "yes" },
      { parseQuery: [] },
      { parseCookies: 1 },
      { parseCookies: { secret: 5 } },
      { parseCookies: { secret: ["a", 1] } },
      { parseCookies: { decode: "x" } },
      { parseBody: "all" },
      // The request options' deprecated spellings are not options here.
      { parseQueryOpts: { nesting: false } },
      { cookieParseOptions: {} },
      { cookieSecret: "s" },
    ];
    for (const options of bad) {
      expect(() => requestParsing(options as never)).toThrow(TypeError);
    }
    expect(() => requestParsing({})).not.toThrow();
  });

  it("never changes the adapter's options", async () => {
    const request = {
      parseBody: { maxContentLength: 64 },
      deferBody: true,
      cookieSecret: "s",
    };
    const adapter = new BunHttpAdapter(0, { request });
    adapter.use(
      requestParsing({
        parseBody: true,
        parseCookies: { secret: "other" },
        parseQuery: { nesting: false },
      }),
    );
    adapter.post("/x", (_req, res) => res.send("ok"));
    const before = structuredClone(adapter.requestOpts);
    await post(adapter, "/x", jsonBody(500));
    expect(adapter.requestOpts).toEqual(before);
  });
});
