/**
 * Option tour: every `BunHttpAdapter` constructor option and every public
 * `BunHttpAdapter` method, each asserted.
 *
 * ```bash
 * bun 12-options/http-adapter-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - `request` replaces the default `{ parseBody: true, parseCookies: true }`
 *   whole; `setRequestOpts()` swaps it at runtime, for the next request on.
 * - `listen()` binds `127.0.0.1` unless given a hostname, rejects on a busy
 *   port rather than moving, and resolves with the running server when asked
 *   for the address it already has (or for port `0`).
 * - `setErrorHandler` runs for served requests and `adapter.fetch()` alike.
 * - The Nest-shaped helpers (`reply`, `status`, `end`, `render`, `redirect`,
 *   `setHeader`, …) take the response as their first argument; `redirect`
 *   sends the response itself.
 * - `close()` keeps routes and the error/not-found handlers.
 * - Static files and the rendered view live in a temporary directory, removed
 *   at the end.
 */
import type {
  BunServer,
  JsonValue,
  WebSocketClientData,
} from "@kingsleyweb/bun-common";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BunHttpAdapter,
  BunRouter,
  BunWebSocket,
  createTestLogger,
  noopLogger,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title } from "../shared/console";

title("Option tour: BunHttpAdapter options and every BunHttpAdapter method");

/** Everything listening, closed at the end. */
const opened: BunHttpAdapter[] = [];

/** Listens on port 0 and remembers the adapter for cleanup. */
async function serve(adapter: BunHttpAdapter): Promise<BunHttpAdapter> {
  opened.push(adapter);
  await adapter.listen(0);
  return adapter;
}

/** A JSON POST of `value`. */
function postJson(value: JsonValue): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}

const dir = mkdtempSync(join(tmpdir(), "bun-common-adapter-tour-"));
await Bun.write(join(dir, "public", "hello.txt"), "hello, static\n");
await Bun.write(join(dir, "view.html"), "<h1>rendered</h1>\n");

/* ------------------------------------------------------------------ */
step("Defaults");

const defaults = new BunHttpAdapter();
checkEqual("timeout defaults to 0", defaults.timeout, 0);
checkEqual("requestOpts default", defaults.requestOpts, {
  parseBody: true,
  parseCookies: true,
});
checkEqual("getType()", defaults.getType(), "express");
checkEqual("instance is the adapter itself", defaults.instance, defaults);
checkEqual("getInstance() too", defaults.getInstance(), defaults);
check(
  "webSocketAdapter is a BunWebSocket",
  defaults.webSocketAdapter instanceof BunWebSocket,
);
checkEqual(
  "…shared with the router",
  defaults.getBunWebsocket(),
  defaults.webSocketAdapter,
);
checkEqual(
  "not listening",
  [defaults.isListening, defaults.listening, defaults.server],
  [false, false, undefined],
);
checkEqual("init() before listening", await defaults.init(), undefined);
defaults.get("/tagged", (_req, res) => res.send({ a: 1 }));
checkEqual(
  "etag is off by default",
  (await defaults.fetch("/tagged")).headers.get("ETag"),
  null,
);

/* ------------------------------------------------------------------ */
step("requestTimeout");

const timed = new BunHttpAdapter(100);
timed.get("/stuck", () => undefined);
timed.get("/fine", (_req, res) => res.send("fine"));
checkEqual("timeout", timed.timeout, 100);
checkEqual(
  "a prompt response is unaffected",
  await (await timed.fetch("/fine")).text(),
  "fine",
);
// The timeout error reaches the adapter's final error handling; with no
// setErrorHandler, that answers as Express's finalhandler: a 500 page.
const stuck = await timed.fetch("/stuck");
checkEqual(
  "a response slower than it fails with a 500",
  [stuck.status, /<pre>Internal Server Error<\/pre>/.test(await stuck.text())],
  [500, true],
);

/* ------------------------------------------------------------------ */
step("request: parsing and the payload guard");

let reachedHandler = false;
const parsing = new BunHttpAdapter(0, {
  request: {
    parseBody: { maxContentLength: 64 },
    parseCookies: true,
    parseQuery: true,
  },
});
parsing.post("/body", (req, res) => {
  reachedHandler = true;
  res.json({ body: req.body ?? null });
});
parsing.get("/meta", (req, res) => {
  res.json({ cookies: req.cookies, query: req.query });
});

checkEqual("requestOpts is the option given", parsing.requestOpts?.parseBody, {
  maxContentLength: 64,
});
checkEqual(
  "a body under the cap is parsed",
  await (await parsing.fetch("/body", postJson({ n: 1 }))).json(),
  { body: { n: 1 } },
);
reachedHandler = false;
const tooLarge = await parsing.fetch(
  "/body",
  postJson({ text: "x".repeat(200) }),
);
checkEqual("a body over the cap is 413", tooLarge.status, 413);
const tooLargeBody = (await tooLarge.json()) as {
  statusCode: number;
  message: string;
};
checkEqual("…with a JSON explanation", tooLargeBody.statusCode, 413);
check("…naming the limit", /64 bytes/.test(tooLargeBody.message), tooLargeBody);
checkEqual("…before any handler ran", reachedHandler, false);
checkEqual(
  "cookies and a nested query are parsed",
  await (
    await parsing.fetch("/meta?filter[state]=open", {
      headers: { Cookie: "sid=abc" },
    })
  ).json(),
  { cookies: { sid: "abc" }, query: { filter: { state: "open" } } },
);

/* ------------------------------------------------------------------ */
step("setRequestOpts()");

const runtime = new BunHttpAdapter();
runtime.post("/body", (req, res) => res.json({ body: req.body ?? null }));
checkEqual(
  "uncapped by default",
  (await runtime.fetch("/body", postJson({ text: "x".repeat(500) }))).status,
  200,
);
checkEqual(
  "setRequestOpts() returns the adapter",
  runtime.setRequestOpts({ parseBody: { maxContentLength: 128 } }),
  runtime,
);
checkEqual(
  "…and applies to the next request",
  (await runtime.fetch("/body", postJson({ text: "x".repeat(500) }))).status,
  413,
);
runtime.requestOpts = { parseBody: true };
checkEqual(
  "the requestOpts setter does the same",
  (await runtime.fetch("/body", postJson({ text: "x".repeat(500) }))).status,
  200,
);

/* ------------------------------------------------------------------ */
step("websocket");

const sockets = new BunHttpAdapter(0, {
  websocket: { wsOptions: { idleTimeout: 45, maxPayloadLength: 2048 } },
});
checkEqual(
  "wsOptions reach the handler",
  [
    sockets.webSocketAdapter.wsHandler.idleTimeout,
    sockets.webSocketAdapter.wsHandler.maxPayloadLength,
  ],
  [45, 2048],
);
checkEqual(
  "…merged over the defaults",
  sockets.webSocketAdapter.wsHandler.perMessageDeflate,
  true,
);

/* ------------------------------------------------------------------ */
step("logger, router and setLogger()");

const { logger, events } = createTestLogger();
const routed = new BunHttpAdapter(0, {
  logger,
  router: { debug: true, routeSpecificity: true },
});
checkEqual("logger is used as it is", routed.logger, logger);
routed.get("/r/:id", (_req, res) => res.send("param"));
routed.get("/r/fixed", (_req, res) => res.send("static"));
checkEqual(
  "router.routeSpecificity reaches the router",
  await (await routed.fetch("/r/fixed")).text(),
  "static",
);
check(
  "router.debug logs through the adapter's logger",
  events.some((event) => event.message === "pipeline layer executed"),
  events,
);

const second = createTestLogger();
checkEqual(
  "setLogger() returns the adapter",
  routed.setLogger(second.logger),
  routed,
);
checkEqual("…and replaces the logger", routed.logger, second.logger);
await routed.fetch("/r/1");
check("…which now receives the records", second.events.length > 0);

/* ------------------------------------------------------------------ */
step("etag and routeCacheMax");

const tagged = new BunHttpAdapter(0, { etag: true });
tagged.get("/doc", (_req, res) => res.send({ version: 3 }));
const tag = (await tagged.fetch("/doc")).headers.get("ETag");
check(
  "etag: true adds an ETag",
  typeof tag === "string" && tag.length > 0,
  tag,
);
// As Express's res.send: the ETag is set first, then a matching
// If-None-Match is fresh and answers 304.
checkEqual(
  "…that answers a matching If-None-Match with 304",
  (await tagged.fetch("/doc", { headers: { "If-None-Match": tag ?? "" } }))
    .status,
  304,
);

const signature = {
  requestHost: "localhost",
  requestMethod: "GET",
  requestUrl: "/x",
};
const uncached = new BunHttpAdapter(0, { routeCacheMax: 0 });
uncached.get("/x", (_req, res) => res.send("x"));
const uncachedFirst = uncached.getMatchedLayers(signature);
const uncachedSecond = uncached.getMatchedLayers(signature);
check("routeCacheMax: 0 disables the cache", uncachedFirst !== uncachedSecond);
const capped = new BunHttpAdapter(0, { routeCacheMax: 1 });
capped.get("/x", (_req, res) => res.send("x"));
capped.get("/y", (_req, res) => res.send("y"));
const x1 = capped.getMatchedLayers(signature);
capped.getMatchedLayers({ ...signature, requestUrl: "/y" });
check(
  "routeCacheMax: 1 evicts the older signature",
  capped.getMatchedLayers(signature) !== x1,
);

/* ------------------------------------------------------------------ */
step("server: Bun.serve options");

const limited = await serve(
  new BunHttpAdapter(0, { server: { maxRequestBodySize: 1024 } }),
);
limited.post("/upload", (_req, res) => res.send("accepted"));
checkEqual(
  "a body within maxRequestBodySize",
  (
    await fetch(`${limited.url}/upload`, {
      method: "POST",
      body: "x".repeat(100),
    })
  ).status,
  200,
);
let refused: number | string;
try {
  refused = (
    await fetch(`${limited.url}/upload`, {
      method: "POST",
      body: "x".repeat(16_000),
    })
  ).status;
} catch (error) {
  refused = (error as Error).message;
}
check("a body beyond it never reaches the route", refused !== 200, refused);

/* ------------------------------------------------------------------ */
step("listen(), its events, and the address getters");

/** The server an adapter with no custom WebSocket data listens with. */
type AdapterServer = BunServer<WebSocketClientData>;

const listening: AdapterServer[] = [];
const main = new BunHttpAdapter();
// `eventEmitter` is an untyped EventEmitter, so the payload is named here.
main.eventEmitter.on("listening", (server: AdapterServer) => {
  listening.push(server);
});
main.get("/", (_req, res) => res.send("main"));
opened.push(main);

const server = await main.listen(0);
checkEqual("listen(0) resolves with the server", main.server, server);
checkEqual("…emitting listening with it", listening, [server]);
check(
  "listeningPort is the OS-assigned port",
  main.listeningPort > 0 && main.listeningPort === server.port,
  main.listeningPort,
);
checkEqual("listeningHost", main.listeningHost, "127.0.0.1");
checkEqual("url", main.url, `http://127.0.0.1:${main.listeningPort}`);
checkEqual(
  "getListenAddress()",
  (await main.getListenAddress()).port,
  String(main.listeningPort),
);
checkEqual("address().port", main.address().port, main.listeningPort);
checkEqual("serverAddress is address()", main.serverAddress, main.address());
checkEqual(
  "isListening and listening",
  [main.isListening, main.listening],
  [true, true],
);
checkEqual("getBunServer()", main.getBunServer(), server);
checkEqual("init() once listening", await main.init(), server);
checkEqual("it serves", await (await fetch(main.url)).text(), "main");

let callbackServer: AdapterServer | undefined;
const same = await main.listen(main.listeningPort, "127.0.0.1", (running) => {
  callbackServer = running;
});
checkEqual("listen() on its own address returns the same server", same, server);
checkEqual("…and still calls back with it", callbackServer, server);
checkEqual("…without a second listening event", listening.length, 1);
checkEqual(
  "listen(0) while listening keeps the server too",
  await main.listen(0),
  server,
);

const withCallback = new BunHttpAdapter();
opened.push(withCallback);
let handed: AdapterServer | undefined;
await withCallback.listen(0, (running) => {
  handed = running;
});
checkEqual("listen(port, callback)", handed, withCallback.server);

const byName = new BunHttpAdapter();
opened.push(byName);
await byName.listen(0, "localhost");
checkEqual(
  "listen(port, hostname): a hostname is bound as given",
  byName.listeningHost,
  "localhost",
);

const blocker = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response("taken"),
});
const displaced = new BunHttpAdapter(0, { logger: noopLogger });
opened.push(displaced);
await checkRejects("a busy port rejects rather than moving on", async () => {
  await displaced.listen(blocker.port!, "127.0.0.1");
});
checkEqual("…leaving the adapter not listening", displaced.isListening, false);
await blocker.stop(true);

const viaOptions = new BunHttpAdapter();
opened.push(viaOptions);
viaOptions.get("/", (_req, res) => res.send("options"));
const optionsServer = await viaOptions.setListenOptions({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 5,
});
checkEqual(
  "setListenOptions() listens and resolves with the server",
  optionsServer,
  viaOptions.server,
);
checkEqual(
  "…and serves",
  await (await fetch(viaOptions.url)).text(),
  "options",
);

const nodeView = main.nodeHttpServer();
checkEqual(
  "nodeHttpServer() is one proxy",
  nodeView,
  main.initNodeHttpServer(),
);
checkEqual("…reading through to the adapter", nodeView.listening, true);

/* ------------------------------------------------------------------ */
step("setTimeout()");

const slow = new BunHttpAdapter();
opened.push(slow);
slow.get("/stuck", () => undefined);
let timeoutServer: AdapterServer | undefined;
const ready = slow.setTimeout(80, (running) => {
  timeoutServer = running;
});
checkEqual("sets the timeout at once", slow.timeout, 80);
await slow.listen(0);
await ready;
checkEqual(
  "calls back with the server once listening",
  timeoutServer,
  slow.server,
);
checkEqual(
  "…and the timeout applies: answered 500",
  (await slow.fetch("/stuck")).status,
  500,
);

/* ------------------------------------------------------------------ */
step("setNotFoundHandler() and setErrorHandler()");

const handlers = await serve(new BunHttpAdapter());
handlers.get("/boom", () => {
  throw new Error("exploded");
});
checkEqual(
  "without a not-found handler: an empty 404",
  [
    (await handlers.fetch("/nope")).status,
    await (await handlers.fetch("/nope")).text(),
  ],
  [404, ""],
);
handlers.setNotFoundHandler((req, res) => {
  res.status(404).json({ missing: req.path });
});
checkEqual(
  "setNotFoundHandler()",
  await (await handlers.fetch("/nope")).json(),
  { missing: "/nope" },
);
checkEqual("…served too", await (await fetch(`${handlers.url}/nope`)).json(), {
  missing: "/nope",
});

handlers.setErrorHandler((error, req, res) => {
  res.status(502).json({ error: (error as Error).message, path: req.path });
});
const failed = await fetch(`${handlers.url}/boom`);
checkEqual(
  "setErrorHandler() answers an unhandled error on a served request",
  [failed.status, await failed.json()],
  [502, { error: "exploded", path: "/boom" }],
);

const offlineFailure = await handlers.fetch("/boom");
checkEqual(
  "…and on adapter.fetch(), as fetch() documents",
  [offlineFailure.status, await offlineFailure.json()],
  [502, { error: "exploded", path: "/boom" }],
);

/* ------------------------------------------------------------------ */
step("enableCors()");

const cors = new BunHttpAdapter();
checkEqual(
  "enableCors() returns the adapter",
  cors.enableCors({
    origin: "https://app.test",
    methods: ["GET", "PUT"],
    allowedHeaders: ["content-type"],
    credentials: true,
    maxAge: 60,
  }),
  cors,
);
cors.get("/items", (_req, res) => res.send("items"));
const corsGet = await cors.fetch("/items", {
  headers: { Origin: "https://app.test" },
});
checkEqual(
  "a simple request is tagged",
  [
    corsGet.status,
    corsGet.headers.get("Access-Control-Allow-Origin"),
    corsGet.headers.get("Access-Control-Allow-Credentials"),
  ],
  [200, "https://app.test", "true"],
);
const corsPreflight = await cors.fetch("/items", {
  method: "OPTIONS",
  headers: {
    Origin: "https://app.test",
    "Access-Control-Request-Method": "PUT",
  },
});
checkEqual(
  "a preflight is answered",
  [
    corsPreflight.status,
    corsPreflight.headers.get("Access-Control-Allow-Methods"),
    corsPreflight.headers.get("Access-Control-Allow-Headers"),
    corsPreflight.headers.get("Access-Control-Max-Age"),
  ],
  [204, "GET,PUT", "content-type", "60"],
);

const delegated = new BunHttpAdapter();
delegated.enableCors((req, callback) => {
  callback(null, {
    origin: req.getHeader("Origin") === "https://partner.test",
  });
}, "/partner");
delegated.get("/partner/feed", (_req, res) => res.send("feed"));
delegated.get("/private", (_req, res) => res.send("private"));
const partnerHeaders = { headers: { Origin: "https://partner.test" } };
checkEqual(
  "a delegate decides per request",
  (await delegated.fetch("/partner/feed", partnerHeaders)).headers.get(
    "Access-Control-Allow-Origin",
  ),
  "https://partner.test",
);
checkEqual(
  "…and a prefix limits where CORS applies",
  (await delegated.fetch("/private", partnerHeaders)).headers.get(
    "Access-Control-Allow-Origin",
  ),
  null,
);
checkEqual(
  "…a refused origin gets no Allow-Origin",
  (
    await delegated.fetch("/partner/feed", {
      headers: { Origin: "https://x.test" },
    })
  ).headers.get("Access-Control-Allow-Origin"),
  null,
);

/* ------------------------------------------------------------------ */
step("useStaticAssets()");

const statics = new BunHttpAdapter();
statics.useStaticAssets(join(dir, "public"), {
  prefix: "/assets",
  maxAge: 60_000,
});
const staticFile = await statics.fetch("/assets/hello.txt");
checkEqual(
  "serves a file under the prefix",
  [staticFile.status, await staticFile.text()],
  [200, "hello, static\n"],
);
checkEqual(
  "…with Cache-Control from maxAge",
  staticFile.headers.get("Cache-Control"),
  "public, max-age=60",
);
checkEqual(
  "a missing file is 404",
  (await statics.fetch("/assets/nope.txt")).status,
  404,
);
checkEqual(
  "…and nothing outside the prefix",
  (await statics.fetch("/hello.txt")).status,
  404,
);

/* ------------------------------------------------------------------ */
step("registerParserMiddleware() and useBodyParser()");

/** A route answering with the raw body the parser middleware attached. */
function rawRoute(adapter: BunHttpAdapter): void {
  adapter.post("/raw", (req, res) => {
    const raw = req.rawBody;
    res.json({ raw: raw ? raw.toString() : null, body: req.body ?? null });
  });
}

const parser = new BunHttpAdapter();
checkEqual(
  "registerParserMiddleware() returns the adapter",
  parser.registerParserMiddleware(undefined, true),
  parser,
);
const parserRoutes = parser.routes().length;
checkEqual(
  "useBodyParser() returns the adapter",
  parser.useBodyParser("json", true, {}),
  parser,
);
checkEqual(
  "…adding its own kind beside the untyped parser",
  parser.routes().length,
  parserRoutes + 1,
);
parser.useBodyParser("json", true, {});
parser.registerParserMiddleware(undefined, true);
checkEqual(
  "…while the same kind registers nothing a second time",
  parser.routes().length,
  parserRoutes + 1,
);
rawRoute(parser);
checkEqual(
  "rawBody holds the exact bytes",
  await (
    await parser.fetch("/raw", { ...postJson({ a: 1 }), body: '{ "a": 1 }' })
  ).json(),
  { raw: '{ "a": 1 }', body: { a: 1 } },
);

const bodyParser = new BunHttpAdapter();
bodyParser.useBodyParser("json", true, {});
rawRoute(bodyParser);
checkEqual(
  "useBodyParser() on its own does the same",
  (
    (await (await bodyParser.fetch("/raw", postJson({ b: 2 }))).json()) as {
      raw: string;
    }
  ).raw,
  '{"b":2}',
);

const limitedParser = new BunHttpAdapter();
limitedParser.useBodyParser("json", false, { limit: 10 });
limitedParser.post("/raw", (_req, res) => res.send("parsed"));
// The PayloadTooLargeError carries status 413; with no setErrorHandler the
// adapter's finalhandler-style fallback answers with it.
checkEqual(
  "useBodyParser()'s limit refuses a larger body",
  (await limitedParser.fetch("/raw", postJson({ text: "x".repeat(100) })))
    .status,
  413,
);
checkEqual(
  "…but only for its own type: text is left to other parsers",
  (
    await limitedParser.fetch("/raw", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x".repeat(100),
    })
  ).status,
  200,
);
const twoKinds = new BunHttpAdapter();
twoKinds.useBodyParser("json", false, { limit: 10 });
twoKinds.useBodyParser("text", false, { limit: 1000 });
twoKinds.post("/raw", (_req, res) => res.send("parsed"));
checkEqual(
  "two kinds stack, each with its own limit",
  [
    (await twoKinds.fetch("/raw", postJson({ text: "x".repeat(100) }))).status,
    (
      await twoKinds.fetch("/raw", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "x".repeat(100),
      })
    ).status,
  ],
  [413, 200],
);

const noRaw = new BunHttpAdapter();
noRaw.registerParserMiddleware("/raw");
rawRoute(noRaw);
checkEqual(
  "without rawBody: true, no rawBody",
  (
    (await (await noRaw.fetch("/raw", postJson({ c: 3 }))).json()) as {
      raw: string | null;
    }
  ).raw,
  null,
);

/* ------------------------------------------------------------------ */
step("setInstance() and getInstance()");

const delegate = new BunRouter();
delegate.get("/delegated", (_req, res) => res.send("from the delegate"));
const host = new BunHttpAdapter();
checkEqual(
  "setInstance() returns the adapter",
  host.setInstance(delegate),
  host,
);
checkEqual("getInstance()", host.getInstance(), delegate);
checkEqual(
  "requests now run through it",
  await (await host.fetch("/delegated")).text(),
  "from the delegate",
);
const hostAgain = new BunHttpAdapter();
hostAgain.instance = delegate;
checkEqual(
  "the instance setter does the same",
  await (await hostAgain.fetch("/delegated")).text(),
  "from the delegate",
);
const corsHost = new BunHttpAdapter();
const corsDelegate = new BunRouter();
corsHost.setInstance(corsDelegate);
corsHost.enableCors({ origin: "https://app.test" });
corsDelegate.get("/data", (_req, res) => res.send("data"));
checkEqual(
  "enableCors() after setInstance() registers on the new instance",
  (
    await corsHost.fetch("/data", { headers: { Origin: "https://app.test" } })
  ).headers.get("Access-Control-Allow-Origin"),
  "https://app.test",
);

/* ------------------------------------------------------------------ */
step("The Nest-shaped response helpers");

const helpers = new BunHttpAdapter();
/** What the `/reply` handler observed through the helpers. */
const seen: {
  /** `getHeader(res, "X-One")`. */
  header?: string | null;
  /** `isHeadersSent(res)` before replying. */
  sentBefore?: boolean;
  /** `getRequestHostname`, `getRequestMethod` and `getRequestUrl`. */
  request?: [string, string, string];
  /** `isHeadersSent(res)` after replying. */
  sentAfter?: boolean;
} = {};
helpers.get("/reply", (req, res) => {
  helpers.setHeader(res, "X-One", "1");
  helpers.appendHeader(res, "X-Many", "a");
  helpers.appendHeader(res, "X-Many", "b");
  seen.header = helpers.getHeader(res, "X-One");
  seen.sentBefore = helpers.isHeadersSent(res);
  seen.request = [
    helpers.getRequestHostname(req),
    helpers.getRequestMethod(req),
    helpers.getRequestUrl(req),
  ];
  helpers.reply(res, { replied: true }, 202);
  seen.sentAfter = helpers.isHeadersSent(res);
});
helpers.get("/status", (_req, res) => {
  helpers.status(res, 418);
  void helpers.end(res, "teapot");
});
helpers.get("/redirect", (_req, res) => {
  helpers.redirect(res, 301, "/elsewhere");
});
helpers.get("/render", (_req, res) => {
  helpers.render(res, join(dir, "view.html"), { status: 203 });
});

const replied = await helpers.fetch("/reply?x=1");
checkEqual(
  "reply(res, body, status)",
  [replied.status, await replied.json()],
  [202, { replied: true }],
);
checkEqual(
  "setHeader() and appendHeader()",
  [replied.headers.get("X-One"), replied.headers.get("X-Many")],
  ["1", "a, b"],
);
checkEqual("getHeader()", seen.header, "1");
checkEqual(
  "isHeadersSent() before and after",
  [seen.sentBefore, seen.sentAfter],
  [false, true],
);
checkEqual(
  "getRequestHostname(), getRequestMethod(), getRequestUrl()",
  seen.request,
  ["localhost", "GET", "/reply?x=1"],
);
const teapot = await helpers.fetch("/status");
checkEqual(
  "status() and end()",
  [teapot.status, await teapot.text()],
  [418, "teapot"],
);
const moved = await helpers.fetch("/redirect");
checkEqual(
  "redirect() sends the response itself",
  [moved.status, moved.headers.get("Location")],
  [301, "/elsewhere"],
);
const rendered = await helpers.fetch("/render");
checkEqual(
  "render() streams the file",
  [rendered.status, await rendered.text()],
  [203, "<h1>rendered</h1>\n"],
);
check(
  "…with its content type",
  String(rendered.headers.get("Content-Type")).startsWith("text/html"),
  rendered.headers.get("Content-Type"),
);

/* ------------------------------------------------------------------ */
step("close()");

const closing = await serve(new BunHttpAdapter());
closing.get("/", (_req, res) => res.send("bye"));
closing.setNotFoundHandler((_req, res) => {
  res.status(404).send("still handled");
});
const closeEvents: string[] = [];
closing.eventEmitter.on("close", () => closeEvents.push("eventEmitter"));
closing.nodeHttpServer().on("close", () => closeEvents.push("nodeHttpServer"));
const closedUrl = closing.url;
await (await fetch(closedUrl)).text();

await closing.close();
checkEqual("close emits close", closeEvents, [
  "eventEmitter",
  "nodeHttpServer",
]);
checkEqual(
  "…and stops listening",
  [closing.isListening, closing.server],
  [false, undefined],
);
await checkRejects("…force-closing, so the old address refuses", async () => {
  await fetch(closedUrl);
});
checkEqual(
  "…keeping its not-found handler",
  await (await closing.fetch("/nope")).text(),
  "still handled",
);
await closing.listen(0);
checkEqual(
  "an adapter can listen again after close()",
  await (await fetch(closing.url)).text(),
  "bye",
);

/* ------------------------------------------------------------------ */
step("Cleaning up");

for (const adapter of opened) {
  await adapter.close();
}
check(
  "everything closed",
  opened.every((adapter) => !adapter.isListening),
);
rmSync(dir, { recursive: true, force: true });

summary();
