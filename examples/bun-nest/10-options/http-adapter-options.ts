/**
 * Option tour: every `BunHttpAdapter` constructor option and every public
 * adapter method, each asserted.
 *
 * ```bash
 * bun 10-options/http-adapter-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - Most sections use a plain adapter and `adapter.fetch()`, which runs a
 *   request through the pipeline `Bun.serve` would use, with no socket. The
 *   sections about the server itself — `listen`, the `server` option,
 *   `setErrorHandler` — listen on port 0.
 * - `requestOpts` is the very object the adapter was given, and `BunRequest`
 *   normalises it in place on the first request, so it is compared before any
 *   request is made.
 * - `setNotFoundHandler` handlers run in registration order until one returns
 *   nothing; `setErrorHandler` handlers run from `Bun.serve`'s `error`
 *   callback.
 */
import type {
  BunRequest,
  BunResponse,
  JsonValue,
  RouterHandler,
  RouterVerbMethod,
} from "@kingsleyweb/bun-common";
import type {
  BunWebSocketServerType,
  MiddlewareFactoryRespType,
  VersionedRoute,
} from "@kingsleyweb/bun-nest";
import type { RawBodyRequest, VersioningOptions } from "@nestjs/common";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gunzipSync, gzipSync } from "node:zlib";
import { BunRouter, compression } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunNestHttpAdapter,
  BunNestWebsocketAdapter,
} from "@kingsleyweb/bun-nest";
import {
  Controller,
  Get,
  HttpCode,
  Logger,
  Module,
  Post,
  Req,
  RequestMethod,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title } from "../shared/console";
import "reflect-metadata";

@Controller()
class TourController {
  @Post("raw")
  @HttpCode(200)
  raw(@Req() req: RawBodyRequest<BunRequest>) {
    return { raw: req.rawBody?.toString() ?? null, body: req.body };
  }

  @Get("hello")
  hello() {
    return { hello: "world" };
  }
}

@Module({ controllers: [TourController] })
class TourModule {}

/** Reads a response's JSON body as `T`. */
async function json<T = JsonValue>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** The named headers of a response, `null` where absent. */
function pick(response: Response, names: string[]) {
  return Object.fromEntries(
    names.map((name) => [name, response.headers.get(name)]),
  );
}

/** A route answering with the raw body it saw and the parsed one. */
const rawEcho: RouterHandler = (req, res) => {
  const raw = (req as RawBodyRequest<BunRequest>).rawBody;
  return res.json({ raw: raw?.toString() ?? null, body: req.body });
};

/** `RequestInit` for a JSON `POST`. */
function postJson(body: JsonValue, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

title("Option tour: BunHttpAdapter options and methods");

const scratch = await mkdtemp(join(tmpdir(), "bun-nest-adapter-tour-"));

/* ------------------------------------------------------------------ */
step("constructor: requestTimeout");
{
  checkEqual("defaults to 0 (no timeout)", new BunHttpAdapter().timeout, 0);

  const adapter = new BunHttpAdapter(150);
  checkEqual("timeout reports it", adapter.timeout, 150);

  adapter.get("/silent", () => {
    // Neither responds nor calls next(): only the timeout ends this request.
  });
  // A timeout carries no request, so with no error handler it is answered as
  // Express's `finalhandler` would: a 500 HTML page, never a rejection.
  const timedOut = await adapter.fetch("/silent");
  checkEqual(
    "a response not produced within requestTimeout answers 500",
    [
      timedOut.status,
      (await timedOut.text()).includes("Internal Server Error"),
    ],
    [500, true],
  );
}

/* ------------------------------------------------------------------ */
step("constructor: request");
{
  checkEqual(
    "defaults to { parseBody: true, parseCookies: true }",
    new BunHttpAdapter().requestOpts,
    { parseBody: true, parseCookies: true },
  );

  const adapter = new BunHttpAdapter(0, {
    request: { parseBody: { maxContentLength: 64 }, parseCookies: false },
  });
  checkEqual("requestOpts is the option given", adapter.requestOpts, {
    parseBody: { maxContentLength: 64 },
    parseCookies: false,
  });

  adapter.post("/echo", (req, res) => {
    return res.json({ body: req.body, cookies: req.cookies ?? null });
  });

  const small = await json<{
    body: JsonValue;
    cookies: Record<string, string> | null;
  }>(
    await adapter.fetch("/echo", postJson({ a: 1 }, { cookie: "theme=dark" })),
  );
  checkEqual("a body within parseBody.maxContentLength is parsed", small.body, {
    a: 1,
  });
  checkEqual("parseCookies: false leaves cookies unparsed", small.cookies, {});

  const big = await adapter.fetch("/echo", postJson({ text: "x".repeat(200) }));
  checkEqual("a body over maxContentLength is answered 413", big.status, 413);
  checkEqual(
    "…with a JSON error, before any handler",
    (await json<{ error: string }>(big)).error,
    "Payload Too Large",
  );

  check(
    "setRequestOpts() returns the adapter",
    adapter.setRequestOpts({ parseBody: true, parseCookies: true }) === adapter,
  );
  const after = await json<{ cookies: Record<string, string> | null }>(
    await adapter.fetch(
      "/echo",
      postJson({ text: "x".repeat(200) }, { cookie: "theme=dark" }),
    ),
  );
  checkEqual("setRequestOpts() applies to later requests", after.cookies, {
    theme: "dark",
  });
}

/* ------------------------------------------------------------------ */
step("constructor: router and routeCacheMax");
{
  const strict = new BunHttpAdapter();
  strict.get("/hello", (_req, res) => {
    return res.send("hi");
  });
  checkEqual(
    "router.caseSensitive defaults to true",
    (await strict.fetch("/HELLO")).status,
    404,
  );
  check(
    "instance is the BunRouter underneath",
    strict.instance instanceof BunRouter,
  );

  const relaxed = new BunHttpAdapter(0, { router: { caseSensitive: false } });
  relaxed.get("/hello", (_req, res) => {
    return res.send("hi");
  });
  checkEqual(
    "router.caseSensitive: false matches any case",
    (await relaxed.fetch("/HELLO")).status,
    200,
  );

  /** Matches `path` against an adapter's router the way a request would. */
  function match(adapter: BunHttpAdapter, path: string) {
    return adapter.instance.getMatchedLayers({
      requestHost: "localhost",
      requestMethod: "GET",
      requestUrl: path,
    });
  }

  /** An adapter with `/x` and `/y`, built with the given `routeCacheMax`. */
  function withRoutes(routeCacheMax?: number) {
    const adapter = new BunHttpAdapter(0, { routeCacheMax });
    adapter.get("/x", () => undefined);
    adapter.get("/y", () => undefined);
    return adapter;
  }

  const cached = withRoutes();
  const first = match(cached, "/x");
  match(cached, "/y");
  check(
    "by default a matched pipeline is reused",
    match(cached, "/x") === first,
  );

  const tiny = withRoutes(1);
  const tinyFirst = match(tiny, "/x");
  match(tiny, "/y");
  check(
    "routeCacheMax: 1 evicts the oldest entry",
    match(tiny, "/x") !== tinyFirst,
  );

  const uncached = withRoutes(0);
  const firstMatch = match(uncached, "/x");
  const secondMatch = match(uncached, "/x");
  check("routeCacheMax: 0 disables the cache", firstMatch !== secondMatch);
}

/* ------------------------------------------------------------------ */
step("constructor: etag");
{
  const plain = new BunHttpAdapter();
  plain.get("/doc", (_req, res) => {
    return res.send({ v: 1 });
  });
  checkEqual(
    "no ETag by default",
    (await plain.fetch("/doc")).headers.get("etag"),
    null,
  );

  const tagged = new BunHttpAdapter(0, { etag: true });
  tagged.get("/doc", (_req, res) => {
    return res.send({ v: 1 });
  });
  tagged.get("/json", (_req, res) => {
    return res.json({ v: 1 });
  });
  const tag = (await tagged.fetch("/doc")).headers.get("etag");
  check("etag: true adds an ETag to a sent body", !!tag, tag);

  check(
    "…and to a json() body",
    !!(await tagged.fetch("/json")).headers.get("etag"),
  );

  const again = await tagged.fetch("/doc", {
    headers: { "if-none-match": tag ?? "" },
  });
  checkEqual("a matching If-None-Match is answered 304", again.status, 304);
}

/* ------------------------------------------------------------------ */
step("constructor: logger, and setLogger()");
{
  check(
    "defaults to a NestJS Logger",
    new BunHttpAdapter().logger instanceof Logger,
  );

  const logger = new Logger("Tour");
  const adapter = new BunHttpAdapter(0, { logger });
  check("the logger option is used", adapter.logger === logger);

  const other = new Logger("Other");
  check(
    "setLogger() returns the adapter",
    adapter.setLogger(other) === adapter,
  );
  check("setLogger() replaces the logger", adapter.logger === other);
}

/* ------------------------------------------------------------------ */
step("constructor: websocket (covered by websocket-adapter-options.ts)");
check(
  "a BunNestWebsocketAdapter is built in",
  new BunHttpAdapter().webSocketAdapter instanceof BunNestWebsocketAdapter,
);

/* ------------------------------------------------------------------ */
step("constructor: server, and setListenOptions()");
{
  const adapter = new BunHttpAdapter(0, {
    server: { maxRequestBodySize: 256 },
  });
  adapter.post("/upload", (_req, res) => {
    return res.send("ok");
  });
  await adapter.listen(0);
  const tooBig = await fetch(`${adapter.url}/upload`, {
    method: "POST",
    body: "x".repeat(1024),
  });
  checkEqual(
    "server options reach Bun.serve (maxRequestBodySize)",
    tooBig.status,
    413,
  );
  await adapter.close();

  const other = new BunHttpAdapter();
  other.post("/upload", (_req, res) => {
    return res.send("ok");
  });
  const server = await other.setListenOptions({
    port: 0,
    hostname: "127.0.0.1",
    maxRequestBodySize: 128,
  });
  check(
    "setListenOptions() listens and resolves the server",
    !!server && server === other.getBunServer(),
  );
  const rejected = await fetch(`${other.url}/upload`, {
    method: "POST",
    body: "x".repeat(512),
  });
  checkEqual(
    "setListenOptions() merges Bun.serve options",
    rejected.status,
    413,
  );
  await other.close();
}

/* ------------------------------------------------------------------ */
step("listen(), addresses, setTimeout() and close()");
{
  const adapter = new BunHttpAdapter();
  adapter.get("/ip", (req, res) => {
    return res.json({ ip: req.ip });
  });

  const events: string[] = [];
  adapter.eventEmitter.on("listening", () => events.push("listening"));
  adapter.eventEmitter.on("close", () => events.push("close"));

  check(
    "not listening before listen()",
    !adapter.isListening && !adapter.listening,
  );
  checkEqual(
    "no Bun server before listen()",
    adapter.getBunServer(),
    undefined,
  );
  checkEqual(
    "fetch() without a server has no peer address",
    await json(await adapter.fetch("/ip")),
    { ip: "" },
  );

  let calledBackWith: BunWebSocketServerType | undefined;
  const server = await adapter.listen(0, (listening) => {
    calledBackWith = listening;
  });
  check(
    "listen() resolves the Bun server",
    server === adapter.getBunServer() && server === adapter.server,
  );
  check("listen(port, callback) calls back with it", calledBackWith === server);
  check("isListening and listening", adapter.isListening && adapter.listening);
  checkEqual("'listening' is emitted", events, ["listening"]);
  checkEqual(
    "listeningHost defaults to 127.0.0.1",
    adapter.listeningHost,
    "127.0.0.1",
  );
  check(
    "port 0 gives an OS-assigned port",
    adapter.listeningPort > 0 && adapter.listeningPort === server?.port,
    { listeningPort: adapter.listeningPort, serverPort: server?.port },
  );
  checkEqual("url", adapter.url, `http://127.0.0.1:${adapter.listeningPort}`);
  checkEqual("address()", adapter.address(), {
    address: "127.0.0.1",
    family: "IPv4",
    port: adapter.listeningPort,
  });
  checkEqual(
    "getListenAddress() resolves the server URL",
    (await adapter.getListenAddress()).href,
    `${adapter.url}/`,
  );

  // Declared as the Bun server, which has neither method; the proxy answers both.
  const httpServer = adapter.getHttpServer() as unknown as {
    /** Node's `server.address()`. */
    address: typeof adapter.address;
    /** Node's `server.once()`. */
    once: (event: string, listener: () => void) => void;
  };
  checkEqual(
    "getHttpServer() answers address() like a Node server",
    httpServer.address(),
    adapter.address(),
  );
  check(
    "defineHttpServer() returns the same object",
    adapter.defineHttpServer() === adapter.getHttpServer(),
  );
  check(
    "initHttpServer() resolves it too",
    (await adapter.initHttpServer()) === adapter.getHttpServer(),
  );

  checkEqual(
    "a served request has the peer address",
    await json(await fetch(`${adapter.url}/ip`)),
    { ip: "127.0.0.1" },
  );

  let reusedWith: BunWebSocketServerType | undefined;
  const again = await adapter.listen(
    adapter.listeningPort,
    "127.0.0.1",
    (listening) => {
      reusedWith = listening;
    },
  );
  check(
    "listen() on the same address reuses the server and calls back",
    again === server && reusedWith === server,
  );

  let timedWith: BunWebSocketServerType | undefined;
  await adapter.setTimeout(250, (listening) => {
    timedWith = listening;
  });
  checkEqual("setTimeout() sets the request timeout", adapter.timeout, 250);
  check("setTimeout() calls back once a server exists", timedWith === server);

  httpServer.once("close", () => events.push("close (getHttpServer().once)"));
  const url = adapter.url;
  await adapter.close();
  check("close() stops listening", !adapter.isListening);
  checkEqual("close() drops the Bun server", adapter.getBunServer(), undefined);
  checkEqual("'close' is emitted, also to getHttpServer() listeners", events, [
    "listening",
    "close",
    "close (getHttpServer().once)",
  ]);
  await checkRejects("the port is released", () => fetch(`${url}/ip`));
  await adapter.close();
  check("close() twice is harmless", !adapter.isListening);

  const replacement = adapter.getHttpServer();
  check(
    "setHttpServer() returns the adapter",
    adapter.setHttpServer(replacement) === adapter,
  );
}

/* ------------------------------------------------------------------ */
step("listen() on a taken port");
{
  const holder = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("taken"),
  });
  const busy = new BunHttpAdapter(0, { logger: new Logger("TakenPort") });

  await checkRejects("without an `error` listener it rejects", async () => {
    await busy.listen(Number(holder.port));
  });

  const errors: unknown[] = [];
  busy.eventEmitter.once("error", (error) => errors.push(error));
  checkEqual(
    "with one (as app.listen() attaches) it resolves undefined",
    await busy.listen(Number(holder.port)),
    undefined,
  );
  check(
    "…and the listener receives the error",
    errors.length === 1 && errors[0] instanceof Error,
    errors,
  );

  await holder.stop(true);
  await busy.close();
}

/* ------------------------------------------------------------------ */
step("a bare WebSocket upgrade records the accepting port");
{
  const bare = new BunHttpAdapter();
  // Upgrade data of the handler's own, with no port.
  bare.get("/bare", (req, res) => {
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
  const port = new Promise<number | undefined>((resolve) => {
    bare.webSocketAdapter.once("connect", (client) => {
      resolve(client.data.port);
    });
  });
  await bare.listen(0);
  const socket = new WebSocket(`ws://127.0.0.1:${bare.listeningPort}/bare`);
  checkEqual(
    "client.data.port is the server's port",
    await port,
    bare.listeningPort,
  );
  socket.close();
  await bare.close();
}

/* ------------------------------------------------------------------ */
step("fetch(input, init?)");
{
  const adapter = new BunHttpAdapter();
  adapter.all("/echo", (req, res) => {
    return res.json({ method: req.method, url: req.originalUrl });
  });
  adapter.post("/body", (req, res) => {
    return res.json({ body: req.body });
  });

  checkEqual(
    "a path string is a GET",
    await json(await adapter.fetch("/echo?q=1")),
    { method: "GET", url: "/echo?q=1" },
  );
  checkEqual(
    "a path and a RequestInit",
    await json(await adapter.fetch("/body", postJson({ n: 1 }))),
    { body: { n: 1 } },
  );
  checkEqual(
    "an object with url",
    await json(await adapter.fetch({ url: "/echo", method: "PUT" })),
    { method: "PUT", url: "/echo" },
  );
  checkEqual(
    "a URL",
    await json(await adapter.fetch(new URL("http://localhost/echo"))),
    { method: "GET", url: "/echo" },
  );
  checkEqual(
    "a Request",
    await json(
      await adapter.fetch(
        new Request("http://localhost/echo", { method: "DELETE" }),
      ),
    ),
    { method: "DELETE", url: "/echo" },
  );
}

/* ------------------------------------------------------------------ */
step("request and response helpers");
{
  const adapter = new BunHttpAdapter();
  let sentAfterReply: boolean | undefined;
  let endAfterSent: ReturnType<typeof adapter.end> | "not called" =
    "not called";
  let appendReturned: typeof adapter | undefined;

  adapter.get("/helpers", (req, res) => {
    const seen = {
      hostname: adapter.getRequestHostname(req),
      method: adapter.getRequestMethod(req),
      url: adapter.getRequestUrl(req),
      sentBefore: adapter.isHeadersSent(res),
    };
    adapter.status(res, 202);
    adapter.setHeader(res, "x-one", "1");
    appendReturned = adapter.appendHeader(res, "x-many", "a");
    adapter.appendHeader(res, "x-many", "b");
    adapter.reply(res, { ...seen, header: adapter.getHeader(res, "x-one") });
    sentAfterReply = adapter.isHeadersSent(res);
    endAfterSent = adapter.end(res, "ignored");
  });

  const response = await adapter.fetch("/helpers?x=1");
  checkEqual("status()", response.status, 202);
  checkEqual(
    "reply(), getRequestHostname/Method/Url(), getHeader(), isHeadersSent() before",
    await json(response),
    {
      hostname: "localhost",
      method: "GET",
      url: "/helpers?x=1",
      sentBefore: false,
      header: "1",
    },
  );
  checkEqual("setHeader()", response.headers.get("x-one"), "1");
  checkEqual("appendHeader() appends", response.headers.get("x-many"), "a, b");
  check("appendHeader() returns the adapter", appendReturned === adapter);
  checkEqual("isHeadersSent() after reply()", sentAfterReply, true);
  checkEqual(
    "end() once a response is sent does nothing",
    endAfterSent,
    undefined,
  );

  adapter.get("/reply-status", (_req, res) => {
    adapter.reply(res, "created", 201);
  });
  const created = await adapter.fetch("/reply-status");
  checkEqual(
    "reply(res, body, statusCode)",
    [created.status, await created.text()],
    [201, "created"],
  );

  adapter.get("/end", (_req, res) => {
    adapter.end(res, "bye");
  });
  checkEqual(
    "end(res, message)",
    await (await adapter.fetch("/end")).text(),
    "bye",
  );

  adapter.get("/redirect", (_req, res) => {
    adapter.redirect(res, 301, "/elsewhere");
    adapter.end(res);
  });
  const moved = await adapter.fetch("/redirect");
  checkEqual(
    "redirect(res, statusCode, url) sets the status and Location",
    [moved.status, moved.headers.get("location")],
    [301, "/elsewhere"],
  );

  adapter.get("/redirect-default", (_req, res) => {
    adapter.redirect(res, 0, "/elsewhere");
    adapter.end(res);
  });
  checkEqual(
    "redirect() defaults to 302",
    (await adapter.fetch("/redirect-default")).status,
    302,
  );

  const page = join(scratch, "page.html");
  await Bun.write(page, "<p>rendered</p>");
  adapter.get("/render", (_req, res) => {
    adapter.render(res, page, { status: 203 });
  });
  const rendered = await adapter.fetch("/render");
  checkEqual(
    "render(res, file, { status }) sends the file",
    [rendered.status, await rendered.text()],
    [203, "<p>rendered</p>"],
  );
  check(
    "…with the file's content type",
    rendered.headers.get("content-type")?.startsWith("text/html") === true,
    rendered.headers.get("content-type"),
  );

  // What `@Render()` passes when the handler returns nothing.
  adapter.get("/render-bare", (_req, res) => {
    adapter.render(res, page, undefined);
  });
  checkEqual(
    "render(res, file, undefined) is a 200",
    (await adapter.fetch("/render-bare")).status,
    200,
  );

  checkEqual("getType() reports 'express'", adapter.getType(), "express");
  check(
    "setViewEngine() returns the adapter",
    adapter.setViewEngine("hbs") === adapter,
  );
}

/* ------------------------------------------------------------------ */
step("setNotFoundHandler() and setErrorHandler()");
{
  const adapter = new BunHttpAdapter();
  const bare = await adapter.fetch("/nowhere");
  checkEqual(
    "without a handler, an unmatched request is a bare 404",
    [bare.status, await bare.text()],
    [404, ""],
  );

  const calls: string[] = [];
  adapter.setNotFoundHandler((req, res) => {
    calls.push("first");
    return res.status(404).json({ missing: req.path });
  });
  adapter.setNotFoundHandler(() => {
    calls.push("second");
  });
  adapter.setNotFoundHandler(() => {
    calls.push("third");
  });

  const handled = await adapter.fetch("/nowhere");
  checkEqual(
    "setNotFoundHandler() answers an unmatched request",
    [handled.status, await json(handled)],
    [404, { missing: "/nowhere" }],
  );
  checkEqual("handlers run in order until one returns nothing", calls, [
    "first",
    "second",
  ]);

  adapter.get("/boom", () => {
    throw new Error("kaboom");
  });
  adapter.setErrorHandler((error, req, res, _next) => {
    res.status(500).json({
      handled: error instanceof Error ? error.message : String(error),
      path: req.path,
    });
  });

  await adapter.listen(0);
  const served = await fetch(`${adapter.url}/boom`);
  checkEqual(
    "setErrorHandler() answers an error the router did not handle",
    [served.status, await json(served)],
    [500, { handled: "kaboom", path: "/boom" }],
  );

  const viaFetch = await adapter.fetch("/boom").then(
    (response) => response.status,
    (error: unknown) => {
      return `rejected: ${error instanceof Error ? error.message : String(error)}`;
    },
  );
  checkEqual("fetch() applies setErrorHandler() as well", viaFetch, 500);
  await adapter.close();

  // Without an error handler, an error raised before routing is answered as
  // Express's `finalhandler` would (a Nest app registers its exception layer
  // here, so this is a bare adapter): a status-message HTML page, never a
  // rejected fetch().
  const strict = new BunHttpAdapter(0, {
    request: { parseBody: { inflate: false } },
  });
  strict.post("/in", (_req, res) => res.send("routed"));
  const refused = await strict.fetch("/in", {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body: gzipSync('{"a":1}'),
  });
  checkEqual(
    "without setErrorHandler(), a refused Content-Encoding answers 415",
    [
      refused.status,
      refused.headers.get("content-type"),
      (await refused.text()).includes("<pre>Unsupported Media Type</pre>"),
    ],
    [415, "text/html; charset=utf-8", true],
  );
}

/* ------------------------------------------------------------------ */
step("useStaticAssets(path, options)");
{
  const root = join(scratch, "public");
  await Bun.write(join(root, "index.html"), "<h1>home</h1>");
  await Bun.write(join(root, "about.html"), "<h1>about</h1>");
  await Bun.write(join(root, "app.css"), "body{}");
  await Bun.write(join(root, "docs", "index.htm"), "<h1>docs</h1>");
  await Bun.write(join(root, ".env"), "SECRET=1");

  const adapter = new BunHttpAdapter();
  adapter.useStaticAssets(root, {
    prefix: "/static",
    maxAge: "1h",
    immutable: true,
    extensions: ["html"],
    dotfiles: "deny",
    index: ["index.html", "index.htm"],
    setHeaders: (res: BunResponse, path: string) => {
      res.setHeader("x-served-file", path.split("/").pop() ?? "");
    },
  });

  const css = await adapter.fetch("/static/app.css");
  checkEqual(
    "serves a file under the prefix",
    [css.status, await css.text()],
    [200, "body{}"],
  );
  check(
    "content type from the extension",
    css.headers.get("content-type")?.startsWith("text/css") === true,
    css.headers.get("content-type"),
  );
  checkEqual(
    "maxAge + immutable set Cache-Control",
    css.headers.get("cache-control"),
    "public, max-age=3600, immutable",
  );
  check(
    "etag and lastModified default to on",
    !!css.headers.get("etag") && !!css.headers.get("last-modified"),
    pick(css, ["etag", "last-modified"]),
  );
  checkEqual(
    "setHeaders is called for the file",
    css.headers.get("x-served-file"),
    "app.css",
  );
  checkEqual(
    "a matching If-None-Match is answered 304",
    (
      await adapter.fetch("/static/app.css", {
        headers: { "if-none-match": css.headers.get("etag") ?? "" },
      })
    ).status,
    304,
  );
  checkEqual(
    "extensions are tried for a missing file",
    await (await adapter.fetch("/static/about")).text(),
    "<h1>about</h1>",
  );
  checkEqual(
    "index serves a directory",
    await (await adapter.fetch("/static/")).text(),
    "<h1>home</h1>",
  );
  checkEqual(
    "index names are tried in order",
    await (await adapter.fetch("/static/docs/")).text(),
    "<h1>docs</h1>",
  );
  checkEqual(
    "dotfiles: 'deny' falls through by default (serve-static), so 404",
    (await adapter.fetch("/static/.env")).status,
    404,
  );
  const strictStatic = new BunHttpAdapter();
  strictStatic.useStaticAssets(root, {
    prefix: "/static",
    dotfiles: "deny",
    fallthrough: false,
  });
  checkEqual(
    "dotfiles: 'deny' with fallthrough: false forwards a 403",
    (await strictStatic.fetch("/static/.env")).status,
    403,
  );
  checkEqual(
    "a missing file is 404",
    (await adapter.fetch("/static/missing.css")).status,
    404,
  );

  const quiet = new BunHttpAdapter();
  quiet.useStaticAssets(root, {
    prefix: "/assets",
    etag: false,
    lastModified: false,
    fallthrough: true,
  });
  quiet.get("/assets/*", (_req, res) => {
    return res.status(404).json({ fellThrough: true });
  });

  const plain = await quiet.fetch("/assets/app.css");
  checkEqual(
    "etag: false and lastModified: false drop the validators",
    pick(plain, ["etag", "last-modified"]),
    { etag: null, "last-modified": null },
  );
  checkEqual(
    "fallthrough: true hands a miss to the next route",
    await json(await quiet.fetch("/assets/nope.css")),
    { fellThrough: true },
  );
  checkEqual(
    "dotfiles defaults to 'ignore': treated as missing",
    await json(await quiet.fetch("/assets/.env")),
    { fellThrough: true },
  );

  const script = `export const rows = ${JSON.stringify(
    Array.from({ length: 100 }, (_, i) => ({ i, label: `row ${i}` })),
  )};\n`;
  const brSibling = brotliCompressSync(script);
  await Bun.write(join(root, "bundle.js"), script);
  await Bun.write(join(root, "bundle.js.br"), brSibling);
  const packed = new BunHttpAdapter();
  packed.useStaticAssets(root, { prefix: "/static", precompressed: true });
  const sibling = await packed.fetch("/static/bundle.js", {
    headers: { "accept-encoding": "gzip, br" },
  });
  checkEqual(
    "precompressed: true serves bundle.js.br to a br client",
    [
      sibling.headers.get("content-encoding"),
      sibling.headers.get("vary"),
      Buffer.from(await sibling.bytes()).equals(brSibling),
    ],
    ["br", "Accept-Encoding", true],
  );
  check(
    "…with bundle.js's Content-Type",
    sibling.headers.get("content-type")?.startsWith("text/javascript") === true,
    sibling.headers.get("content-type"),
  );
  const gzipped = await packed.fetch("/static/bundle.js", {
    headers: { "accept-encoding": "gzip" },
  });
  checkEqual(
    "no .gz sibling: gzipped on the fly instead",
    [
      gzipped.headers.get("content-encoding"),
      gunzipSync(await gzipped.bytes()).toString(),
    ],
    ["gzip", script],
  );
}

/* ------------------------------------------------------------------ */
step("registerParserMiddleware() and useBodyParser()");
{
  const adapter = new BunHttpAdapter();
  check(
    "registerParserMiddleware(prefix, rawBody) returns the adapter",
    adapter.registerParserMiddleware("/hooks", true) === adapter,
  );
  adapter.post("/hooks/in", rawEcho);
  adapter.post("/other", rawEcho);

  checkEqual(
    "rawBody is kept under the prefix, and the body still parsed",
    await json(await adapter.fetch("/hooks/in", postJson('{"a":1}'))),
    { raw: '{"a":1}', body: { a: 1 } },
  );
  checkEqual(
    "no rawBody outside the prefix",
    await json(await adapter.fetch("/other", postJson('{"a":1}'))),
    { raw: null, body: { a: 1 } },
  );

  const noRaw = new BunHttpAdapter();
  noRaw.registerParserMiddleware();
  noRaw.post("/in", rawEcho);
  checkEqual(
    "rawBody defaults to false",
    await json(await noRaw.fetch("/in", postJson('{"a":1}'))),
    { raw: null, body: { a: 1 } },
  );

  const viaUse = new BunHttpAdapter();
  viaUse.useBodyParser("json", true, { limit: "1mb" });
  viaUse.post("/in", rawEcho);
  checkEqual(
    "useBodyParser(type, rawBody, options) keeps rawBody",
    await json(await viaUse.fetch("/in", postJson('{"b":2}'))),
    { raw: '{"b":2}', body: { b: 2 } },
  );

  /** POSTs `body` as `type`. */
  const postAs = (type: string, body: string): RequestInit => ({
    method: "POST",
    headers: { "content-type": type },
    body,
  });

  checkEqual(
    "useBodyParser('json'): a request of another type is skipped (no rawBody)",
    (
      await json<{ raw: string | null }>(
        await viaUse.fetch("/in", postAs("text/plain", "plain")),
      )
    ).raw,
    null,
  );

  const kinds = new BunHttpAdapter();
  kinds.useBodyParser("json", true, { limit: 16 });
  kinds.useBodyParser("text", true, { limit: "1kb" });
  kinds.useBodyParser("json", true, { limit: "1mb" }); // ignored: json is registered
  kinds.post("/in", rawEcho);
  kinds.setErrorHandler((error, _req, res) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return res.status(status).json({ status });
  });
  const big = "x".repeat(64);
  checkEqual(
    "useBodyParser: a body over `limit` is a 413 PayloadTooLargeError",
    (
      await kinds.fetch(
        "/in",
        postAs("application/json", JSON.stringify({ big })),
      )
    ).status,
    413,
  );
  checkEqual(
    "…and a second registration of the same kind is ignored",
    (await kinds.fetch("/in", postAs("application/json", `"${big}"`))).status,
    413,
  );
  checkEqual(
    "useBodyParser: kinds stack, each with its own options",
    (
      await json<{ raw: string | null }>(
        await kinds.fetch("/in", postAs("text/plain", big)),
      )
    ).raw,
    big,
  );
}

/* ------------------------------------------------------------------ */
step("enableCors(options | delegate, prefix?)");
{
  const corsHeaders = [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-max-age",
  ];

  const adapter = new BunHttpAdapter();
  check(
    "enableCors() returns the adapter",
    adapter.enableCors({
      origin: "https://app.example.com",
      credentials: true,
      methods: ["GET", "POST"],
      allowedHeaders: ["X-Token"],
      exposedHeaders: ["X-Total"],
      maxAge: 600,
      optionsSuccessStatus: 200,
    }) === adapter,
  );
  adapter.get("/items", (_req, res) => {
    return res.json({ items: [] });
  });

  const preflight = await adapter.fetch("/items", {
    method: "OPTIONS",
    headers: {
      origin: "https://app.example.com",
      "access-control-request-method": "GET",
    },
  });
  checkEqual("preflight answers optionsSuccessStatus", preflight.status, 200);
  checkEqual("preflight headers", pick(preflight, corsHeaders), {
    "access-control-allow-origin": "https://app.example.com",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST",
    "access-control-allow-headers": "X-Token",
    "access-control-max-age": "600",
  });

  const simple = await adapter.fetch("/items", {
    headers: { origin: "https://app.example.com" },
  });
  checkEqual(
    "an actual request gets origin, credentials and exposed headers",
    pick(simple, [
      "access-control-allow-origin",
      "access-control-allow-credentials",
      "access-control-expose-headers",
    ]),
    {
      "access-control-allow-origin": "https://app.example.com",
      "access-control-allow-credentials": "true",
      "access-control-expose-headers": "X-Total",
    },
  );
  check(
    "…and Vary: Origin",
    (simple.headers.get("vary") ?? "").includes("Origin"),
    simple.headers.get("vary"),
  );

  const defaults = new BunHttpAdapter();
  defaults.enableCors({});
  const defaultPreflight = await defaults.fetch("/anything", {
    method: "OPTIONS",
    headers: {
      origin: "https://x.test",
      "access-control-request-method": "PUT",
    },
  });
  checkEqual(
    "defaults: any origin, the common methods, 204",
    [
      defaultPreflight.status,
      defaultPreflight.headers.get("access-control-allow-origin"),
      defaultPreflight.headers.get("access-control-allow-methods"),
    ],
    [204, "*", "GET,HEAD,PUT,PATCH,POST,DELETE"],
  );

  const listed = new BunHttpAdapter();
  listed.enableCors({ origin: [/\.example\.org$/, "https://exact.example"] });
  listed.get("/items", (_req, res) => {
    return res.json({ items: [] });
  });
  /** The allowed origin `listed` answers `origin` with. */
  const allowedFor = async (origin: string) => {
    const response = await listed.fetch("/items", { headers: { origin } });
    return response.headers.get("access-control-allow-origin");
  };
  checkEqual(
    "an origin list: a RegExp match is echoed",
    await allowedFor("https://shop.example.org"),
    "https://shop.example.org",
  );
  checkEqual(
    "an origin list: an exact match is echoed",
    await allowedFor("https://exact.example"),
    "https://exact.example",
  );
  checkEqual(
    "an origin list: anything else gets no header",
    await allowedFor("https://evil.test"),
    null,
  );

  const delegated = new BunHttpAdapter();
  delegated.enableCors((req, callback) => {
    callback(null, { origin: req.getHeader("x-tenant") === "trusted" });
  });
  delegated.get("/items", (_req, res) => {
    return res.json({ items: [] });
  });
  const trusted = await delegated.fetch("/items", {
    headers: { origin: "https://tenant.test", "x-tenant": "trusted" },
  });
  const untrusted = await delegated.fetch("/items", {
    headers: { origin: "https://tenant.test" },
  });
  checkEqual(
    "a delegate decides per request",
    [
      trusted.headers.get("access-control-allow-origin"),
      untrusted.headers.get("access-control-allow-origin"),
    ],
    ["https://tenant.test", null],
  );

  const failing = new BunHttpAdapter();
  failing.enableCors((_req, callback) => {
    callback(new Error("no tenant"), {});
  });
  failing.get("/items", (_req, res) => {
    return res.json({ items: [] });
  });
  checkEqual(
    "a delegate error is answered 400",
    (await failing.fetch("/items", { headers: { origin: "https://x.test" } }))
      .status,
    400,
  );

  const prefixed = new BunHttpAdapter();
  prefixed.enableCors({ origin: "*" }, "/public");
  prefixed.get("/public/data", (_req, res) => {
    return res.json({ public: true });
  });
  prefixed.get("/private/data", (_req, res) => {
    return res.json({ public: false });
  });
  checkEqual(
    "with a prefix: CORS headers under the prefix only",
    [
      (
        await prefixed.fetch("/public/data", {
          headers: { origin: "https://x.test" },
        })
      ).headers.get("access-control-allow-origin"),
      (
        await prefixed.fetch("/private/data", {
          headers: { origin: "https://x.test" },
        })
      ).headers.get("access-control-allow-origin"),
    ],
    ["*", null],
  );
  checkEqual(
    "with a prefix: preflight under the prefix is answered",
    (
      await prefixed.fetch("/public/data", {
        method: "OPTIONS",
        headers: {
          origin: "https://x.test",
          "access-control-request-method": "GET",
        },
      })
    ).status,
    204,
  );
}

/* ------------------------------------------------------------------ */
step("createMiddlewareFactory(requestMethod)");
{
  const adapter = new BunHttpAdapter();
  const ran: string[] = [];

  const posts: MiddlewareFactoryRespType = adapter.createMiddlewareFactory(
    RequestMethod.POST,
  );
  const returned = posts(
    "/scoped",
    (req: BunRequest, _res: BunResponse, next: () => void) => {
      ran.push(`${req.method} ${req.path}`);
      next();
    },
  );
  check("the factory returns the adapter", returned === adapter);
  adapter.all("/scoped/*", (req, res) => {
    return res.json({ method: req.method });
  });
  adapter.all("/scoped", (req, res) => {
    return res.json({ method: req.method });
  });

  await adapter.fetch("/scoped");
  await adapter.fetch("/scoped", { method: "POST" });
  await adapter.fetch("/scoped/child", { method: "POST" });
  checkEqual(
    "middleware runs for its method only, prefix-matched, before the route",
    ran,
    ["POST /scoped", "POST /scoped/child"],
  );

  const everything = adapter.createMiddlewareFactory(RequestMethod.ALL);
  const order: string[] = [];
  everything(
    "/ordered",
    (_req: BunRequest, _res: BunResponse, next: () => void) => {
      order.push("middleware");
      next();
    },
  );
  adapter.delete("/ordered", (_req, res) => {
    order.push("route");
    return res.json({ order });
  });
  checkEqual(
    "RequestMethod.ALL applies to every method",
    await json(await adapter.fetch("/ordered", { method: "DELETE" })),
    { order: ["middleware", "route"] },
  );
}

/* ------------------------------------------------------------------ */
step("getRequestMethodStr(requestMethod)");
{
  const adapter = new BunHttpAdapter();
  const names = [
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "PATCH",
    "ALL",
    "OPTIONS",
    "HEAD",
    "SEARCH",
    "PROPFIND",
    "PROPPATCH",
    "MKCOL",
    "COPY",
    "MOVE",
    "LOCK",
    "UNLOCK",
  ] as const;
  checkEqual(
    "maps every RequestMethod to its router verb",
    Object.fromEntries(
      names.map((name) => [
        name,
        adapter.getRequestMethodStr(RequestMethod[name]),
      ]),
    ),
    Object.fromEntries(names.map((name) => [name, name.toLowerCase()])),
  );
  await checkRejects(
    "an unknown method throws",
    () => adapter.getRequestMethodStr(999 as RequestMethod),
    { name: "InternalServerErrorException" },
  );
}

/* ------------------------------------------------------------------ */
step("applyVersionFilter(handler, version, versioningOptions)");
{
  const adapter = new BunHttpAdapter();

  /** The handler every filter wraps. */
  const handler = (_req: BunRequest, res: BunResponse) => {
    return res.json({ via: "handler" });
  };

  /** Registers `path` as filter → fallback, so a mismatch shows as `next`. */
  function route(
    path: string,
    version: Parameters<BunHttpAdapter["applyVersionFilter"]>[1],
    options: VersioningOptions,
  ) {
    const filter: VersionedRoute = adapter.applyVersionFilter(
      handler,
      version,
      options,
    );
    adapter.get(path, filter, (_req, res) => {
      return res.json({ via: "next" });
    });
  }

  /** Which callback answered `path` for these headers. */
  async function via(path: string, headers: Record<string, string> = {}) {
    const response = await adapter.fetch(path, { headers });
    return (await json<{ via: string }>(response)).via;
  }

  const header: VersioningOptions = {
    type: VersioningType.HEADER,
    header: "X-API-Version",
  };
  const media: VersioningOptions = {
    type: VersioningType.MEDIA_TYPE,
    key: "v=",
  };
  const custom: VersioningOptions = {
    type: VersioningType.CUSTOM,
    extractor: (request: unknown) => {
      const value = (request as BunRequest).getHeader("x-v") ?? "";
      return value.includes(",") ? value.split(",") : value;
    },
  };

  route("/header", "2", header);
  route("/header-neutral", ["1", VERSION_NEUTRAL], header);
  route("/media", "2", media);
  route("/media-list", ["1", "2"], media);
  route("/media-neutral", [VERSION_NEUTRAL, "1"], media);
  route("/custom", "2", custom);
  route("/custom-list", ["2", "3"], custom);
  route("/uri", "2", { type: VersioningType.URI });
  route("/neutral", VERSION_NEUTRAL, header);

  checkEqual(
    "HEADER: the matching version runs the handler",
    await via("/header", { "X-API-Version": "2" }),
    "handler",
  );
  checkEqual(
    "HEADER: another version calls next()",
    await via("/header", { "X-API-Version": "1" }),
    "next",
  );
  checkEqual("HEADER: no header calls next()", await via("/header"), "next");
  checkEqual(
    "HEADER: no header runs a handler whose versions include VERSION_NEUTRAL",
    await via("/header-neutral"),
    "handler",
  );
  checkEqual(
    "MEDIA_TYPE: <key><version> in Accept runs the handler",
    await via("/media", { Accept: "application/json;v=2" }),
    "handler",
  );
  checkEqual(
    "MEDIA_TYPE: another version calls next()",
    await via("/media", { Accept: "application/json;v=3" }),
    "next",
  );
  checkEqual(
    "MEDIA_TYPE: a version list matches any member",
    await via("/media-list", { Accept: "application/json;v=1" }),
    "handler",
  );
  checkEqual(
    "MEDIA_TYPE: no parameter runs a VERSION_NEUTRAL handler",
    await via("/media-neutral", { Accept: "application/json" }),
    "handler",
  );
  checkEqual(
    "CUSTOM: an extracted string must equal the version",
    await via("/custom", { "x-v": "2" }),
    "handler",
  );
  checkEqual(
    "CUSTOM: an extracted list must include the version",
    await via("/custom", { "x-v": "3,2" }),
    "handler",
  );
  checkEqual(
    "CUSTOM: a version list and an extracted list must intersect",
    await via("/custom-list", { "x-v": "1,3" }),
    "handler",
  );
  checkEqual(
    "CUSTOM: no match calls next()",
    await via("/custom", { "x-v": "1" }),
    "next",
  );
  checkEqual(
    "URI: the filter always passes (the version is in the path)",
    await via("/uri"),
    "handler",
  );
  checkEqual(
    "VERSION_NEUTRAL: the filter always passes",
    await via("/neutral", { "X-API-Version": "9" }),
    "handler",
  );
  await checkRejects(
    "an unknown versioning type throws",
    () => {
      return adapter.applyVersionFilter(handler, "1", {
        type: 99,
      } as unknown as VersioningOptions);
    },
    { message: /Unsupported versioning options/ },
  );
}

/* ------------------------------------------------------------------ */
step("verb methods: get, post, … all, use");
{
  const adapter = new BunHttpAdapter();
  const verbs = [
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "options",
    "search",
    "propfind",
    "proppatch",
    "mkcol",
    "copy",
    "move",
    "lock",
    "unlock",
  ] as const;

  const returned: boolean[] = [];
  for (const verb of verbs) {
    // A union of overloaded (generated) methods has no callable signature, but
    // it assigns, uncast, to the one signature every verb shares.
    const register: RouterVerbMethod<BunHttpAdapter> = adapter[verb];
    const result = register.call(adapter, `/verbs/${verb}`, (req, res) => {
      return res.json({ method: req.method });
    });
    returned.push(result === adapter);
  }

  const answered: Record<string, string> = {};
  for (const verb of verbs) {
    const response = await adapter.fetch(`/verbs/${verb}`, {
      method: verb.toUpperCase(),
    });
    answered[verb] = (await json<{ method: string }>(response)).method;
  }
  check(
    "every verb method returns the adapter",
    returned.every(Boolean),
    returned,
  );
  checkEqual(
    "every verb method registers a route for its method",
    answered,
    Object.fromEntries(verbs.map((verb) => [verb, verb.toUpperCase()])),
  );
  checkEqual(
    "a route answers its own method only",
    (await adapter.fetch("/verbs/get", { method: "POST" })).status,
    404,
  );

  adapter.head("/head", (_req, res) => {
    res.setHeader("x-head", "yes");
    return res.send("");
  });
  checkEqual(
    "head()",
    (await adapter.fetch("/head", { method: "HEAD" })).headers.get("x-head"),
    "yes",
  );

  adapter.all("/all", (req, res) => {
    return res.json({ method: req.method });
  });
  checkEqual(
    "all() answers every method",
    [
      (await json<{ method: string }>(await adapter.fetch("/all"))).method,
      (
        await json<{ method: string }>(
          await adapter.fetch("/all", { method: "DELETE" }),
        )
      ).method,
    ],
    ["GET", "DELETE"],
  );

  const seen: string[] = [];
  check(
    "use(path, …) returns the adapter",
    adapter.use("/mounted", (req, _res, next) => {
      seen.push(`use(path) ${req.path}`);
      next();
    }) === adapter,
  );
  adapter.use((req, _res, next) => {
    seen.push(`use() ${req.path}`);
    next();
  });
  adapter.get("/mounted/child", (_req, res) => {
    return res.json({ ok: true });
  });
  adapter.get("/elsewhere", (_req, res) => {
    return res.json({ ok: true });
  });
  await adapter.fetch("/mounted/child");
  await adapter.fetch("/elsewhere");
  checkEqual("use(path) is a prefix match; use() matches everything", seen, [
    "use(path) /mounted/child",
    "use() /mounted/child",
    "use() /elsewhere",
  ]);
}

/* ------------------------------------------------------------------ */
step("with NestFactory: BunNestHttpAdapter");
{
  const adapter = new BunNestHttpAdapter();
  check(
    "BunNestHttpAdapter is a BunHttpAdapter",
    adapter instanceof BunHttpAdapter,
  );
  // Both generics, as BunHttpAdapter takes them: client data, then routes.
  const routed = new BunNestHttpAdapter<{ room: string }, "/health">();
  check(
    "BunNestHttpAdapter takes BunHttpAdapter's generics",
    routed instanceof BunNestHttpAdapter,
  );

  const app = await NestFactory.create(TourModule, adapter, {
    logger: false,
    abortOnError: false,
    rawBody: true,
  });
  check(
    "app.getHttpAdapter() is the adapter",
    // Nest types it as its `HttpServer` interface, unrelated to the class.
    (app.getHttpAdapter() as unknown) === adapter,
  );
  app.enableCors({ origin: "https://nest.example" });
  // bun-common's compression() is plain router middleware, so app.use takes it.
  app.use(compression({ threshold: 0 }));

  await app.listen(0);
  checkEqual(
    "app.getUrl() is the adapter's url",
    await app.getUrl(),
    adapter.url,
  );
  check(
    "app.getHttpServer() is the adapter's HTTP server",
    app.getHttpServer() === adapter.getHttpServer(),
  );

  const posted = await fetch(
    `${adapter.url}/raw`,
    postJson('{"a":1}', { origin: "https://nest.example" }),
  );
  checkEqual(
    "app.enableCors() reaches the adapter",
    posted.headers.get("access-control-allow-origin"),
    "https://nest.example",
  );
  const compressed = await fetch(`${adapter.url}/hello`, {
    headers: { "accept-encoding": "gzip" },
    decompress: false,
  });
  checkEqual(
    "app.use(compression()) compresses a Nest controller's response",
    [
      compressed.headers.get("content-encoding"),
      JSON.parse(gunzipSync(await compressed.bytes()).toString()),
    ],
    ["gzip", { hello: "world" }],
  );
  checkEqual(
    "…adding Accept-Encoding to the Vary that enableCors() started",
    compressed.headers.get("vary"),
    "Origin, Accept-Encoding",
  );
  checkEqual(
    "rawBody: true keeps the raw bytes beside the parsed body",
    await json(posted),
    { raw: '{"a":1}', body: { a: 1 } },
  );
  checkEqual(
    "Nest's not-found handler is registered on the adapter",
    await json(await fetch(`${adapter.url}/missing`)),
    { message: "Cannot GET /missing", error: "Not Found", statusCode: 404 },
  );

  await app.close();
  check("app.close() closes the adapter", !adapter.isListening);
}

await rm(scratch, { recursive: true, force: true });
summary();
