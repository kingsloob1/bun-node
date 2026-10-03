import { join } from "node:path";
/**
 * Adapter options — `new BunHttpAdapter(requestTimeout, options)`, field by
 * field.
 *
 * ```bash
 * bun 03-http-adapter/adapter-options.ts
 * ```
 *
 * - `requestTimeout` bounds the wait for a handler's response. A handler that
 *   never responds then fails with a `Request Timedout` error instead of
 *   hanging, which the adapter answers as `500` unless `setErrorHandler`
 *   says otherwise; `0`, the default, waits forever.
 * - `request` is **merged over** the default
 *   `{ parseBody: true, parseCookies: true }`, so a partial object such as
 *   `{ parseQuery: { nesting: false } }` keeps body and cookie parsing on; set
 *   a flag to `false` to turn it off. `parseBody`, `parseQuery` and
 *   `parseCookies` each take `true`, `false` or their options
 *   (`parseCookies: { secret, decode }`).
 *   `parseBody: true` is uncapped; the object form caps bodies (100kb by
 *   default, 10mb for multipart and raw) and answers 413 before any
 *   middleware runs.
 * - `server` is merged into `Bun.serve`; `port`, `hostname`, `fetch`,
 *   `websocket` and `development` stay the adapter's.
 * - `server.routes` (opt-in) serves constants natively, ahead of the router:
 *   a `Response` or `Bun.file` answers **every method**, runs **no
 *   middleware**, gets an `ETag` from Bun, and wins over a router route on
 *   the same path. It matches Bun's way — case-sensitive, strict trailing
 *   slash — and only over a socket: `adapter.fetch()` never sees it. Use it
 *   for health checks and `robots.txt`; anything needing the pipeline belongs
 *   on the router.
 * - `router` goes to the underlying `BunRouter`; `logger`, `etag` and
 *   `routeCacheMax` sit beside it.
 */
import {
  BunHttpAdapter,
  createTestLogger,
  DEFAULT_PARSE_QUERY_OPTS,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Adapter options");

/* ------------------------------------------------------------------ */
step("requestTimeout (the first constructor argument)");

const timed = new BunHttpAdapter(150);
timed.get("/quick", (_req, res) => res.send("in time"));
timed.get("/forgotten", () => {
  // Neither responds nor calls next(): only the timeout ends this request.
});

show("timeout", timed.timeout);
show("GET /quick", await (await timed.fetch("/quick")).text());
const waitedFrom = performance.now();
const forgotten = await timed.fetch("/forgotten");
show(
  `GET /forgotten gave up after ~${(performance.now() - waitedFrom).toFixed(0)}ms`,
  `${forgotten.status} ${forgotten.statusText}`,
);

/* ------------------------------------------------------------------ */
step("request: body, cookie and query parsing, and the payload guard");

const parsing = new BunHttpAdapter(0, {
  request: {
    parseBody: { maxContentLength: "1kb", contentTypes: "all" },
    parseCookies: { decode: (value) => decodeURIComponent(value) },
    parseQuery: { ...DEFAULT_PARSE_QUERY_OPTS },
  },
});
let handlerRan = false;
parsing.post("/echo", (req, res) => {
  handlerRan = true;
  res.json({ body: req.body ?? null });
});
parsing.get("/inspect", (req, res) => {
  res.json({ cookies: req.cookies, query: req.query });
});

/** A JSON POST of roughly `bytes` bytes. */
function postOf(bytes: number): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(bytes) }),
  };
}

const small = await parsing.fetch("/echo", postOf(20));
show("a 20-byte body", `${small.status}, handler ran: ${handlerRan}`);
handlerRan = false;
const large = await parsing.fetch("/echo", postOf(4_000));
show(
  "a 4kb body",
  `${large.status} ${await large.text()}, handler ran: ${handlerRan}`,
);

const inspected = await parsing.fetch(
  "/inspect?filter[status]=open&tag=a&tag=b",
  {
    headers: { Cookie: "session=abc123; theme=dark" },
  },
);
show("parsed cookies and query", await inspected.json());

/* ------------------------------------------------------------------ */
step("websocket: options for the built-in BunWebSocket");

const sockets = new BunHttpAdapter(0, {
  websocket: { wsOptions: { idleTimeout: 60, maxPayloadLength: 64 * 1024 } },
});
const handler = sockets.webSocketAdapter.wsHandler;
show("merged over the defaults", {
  idleTimeout: handler.idleTimeout,
  maxPayloadLength: handler.maxPayloadLength,
  perMessageDeflate: handler.perMessageDeflate,
});
show(
  "and the router shares it",
  sockets.getBunWebsocket() === sockets.webSocketAdapter,
);

/* ------------------------------------------------------------------ */
step("logger and router: debug logging of every pipeline step");

const { logger, events } = createTestLogger();
const debugged = new BunHttpAdapter(0, {
  logger,
  router: { debug: true, routeSpecificity: true },
});
debugged.use((_req, _res, next) => next());
debugged.get("/items/:id", (_req, res) => res.send("the param route"));
debugged.get("/items/new", (_req, res) => res.send("the static route"));

show("adapter.logger is the logger given", debugged.logger === logger);
show(
  "routeSpecificity: GET /items/new",
  await (await debugged.fetch("/items/new")).text(),
);
show(
  "debug: one record per layer run",
  events.map(
    (event) =>
      `${event.level} ${event.message} (${String(event.fields?.state)})`,
  ),
);

/* ------------------------------------------------------------------ */
step("etag: a validator on every response");

const tagged = new BunHttpAdapter(0, { etag: true });
tagged.get("/report", (_req, res) => res.send({ total: 42 }));
const firstReport = await tagged.fetch("/report");
const etag = firstReport.headers.get("ETag");
show("ETag", etag);
// Known issue: send() checks freshness before it generates the ETag, so this
// answers 200 where Express would answer 304.
const revalidated = await tagged.fetch("/report", {
  headers: { "If-None-Match": etag ?? "" },
});
show("If-None-Match with it", revalidated.status);

const untagged = new BunHttpAdapter();
untagged.get("/report", (_req, res) => res.send({ total: 42 }));
show(
  "without etag: true",
  (await untagged.fetch("/report")).headers.get("ETag") ?? "no ETag",
);

/* ------------------------------------------------------------------ */
step("routeCacheMax: forwarded to the router");

const noCache = new BunHttpAdapter(0, { routeCacheMax: 0 });
noCache.get("/x", (_req, res) => res.send("x"));
const signature = {
  requestHost: "localhost",
  requestMethod: "GET",
  requestUrl: "/x",
};
const firstLookup = noCache.getMatchedLayers(signature);
const secondLookup = noCache.getMatchedLayers(signature);
show(
  "routeCacheMax: 0 — every lookup rebuilds the pipeline",
  firstLookup !== secondLookup,
);

/* ------------------------------------------------------------------ */
step("server: Bun.serve options, such as maxRequestBodySize");

const capped = new BunHttpAdapter(0, { server: { maxRequestBodySize: 1024 } });
capped.post("/upload", (_req, res) => res.send("accepted"));
await capped.listen(0);
for (const bytes of [100, 8_000]) {
  try {
    const response = await fetch(`${capped.url}/upload`, {
      method: "POST",
      body: "x".repeat(bytes),
    });
    show(
      `${bytes} bytes over the socket`,
      `${response.status} ${await response.text()}`,
    );
  } catch (error) {
    show(
      `${bytes} bytes over the socket`,
      `refused: ${(error as Error).message}`,
    );
  }
}
await capped.close();

/* ------------------------------------------------------------------ */
step("server.routes: native static routes, served by Bun ahead of the router");

const helloFile = join(import.meta.dir, "fixtures", "public", "hello.txt");
const native = new BunHttpAdapter(0, {
  server: {
    routes: {
      "/health": new Response("ok", {
        headers: { "Content-Type": "text/plain" },
      }),
      "/hello.txt": Bun.file(helloFile),
    },
  },
});
const nativeTrail: string[] = [];
native.use((req, _res, next) => {
  nativeTrail.push(req.path);
  next();
});
native.get("/health", (_req, res) => res.send("the router's /health"));
native.get("/Health", (_req, res) => res.send("the router's /Health"));
native.get("/status", (_req, res) => res.send("the router's /status"));
await native.listen(0);

/** One served request, summarised. */
async function served(path: string, init?: RequestInit) {
  const response = await fetch(`${native.url}${path}`, init);
  return {
    status: response.status,
    body: await response.text(),
    etag: response.headers.get("ETag"),
  };
}

const health = await served("/health");
show("GET /health", health);
checkEqual(
  "GET /health is the native Response, not the router's",
  health.body,
  "ok",
);
check("…with an ETag Bun added", typeof health.etag === "string", health);
for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
  checkEqual(
    `${method} /health: every method gets the constant`,
    (await served("/health", { method })).body,
    "ok",
  );
}
checkEqual(
  "HEAD /health: the headers, no body",
  (await served("/health", { method: "HEAD" })).body,
  "",
);
checkEqual(
  "If-None-Match with that ETag is a 304",
  (await served("/health", { headers: { "If-None-Match": health.etag! } }))
    .status,
  304,
);
checkEqual(
  "a query string still matches it",
  (await served("/health?probe=1")).body,
  "ok",
);
checkEqual(
  "GET /hello.txt: a Bun.file, served natively",
  (await served("/hello.txt")).body,
  await Bun.file(helloFile).text(),
);
checkEqual("…and no middleware ran for any of them", nativeTrail, []);

// The caveats: Bun's matching, not the router's.
checkEqual(
  "GET /Health: case-sensitive, so the router answers",
  (await served("/Health")).body,
  "the router's /Health",
);
checkEqual(
  "GET /health/: strict trailing slash, so the router answers",
  (await served("/health/")).body,
  "the router's /health",
);
checkEqual(
  "GET /status: not a native route, so the pipeline runs",
  (await served("/status")).body,
  "the router's /status",
);
checkEqual("…and the middleware ran for those", nativeTrail, [
  "/Health",
  "/health/",
  "/status",
]);
checkEqual(
  "adapter.fetch('/health') has no socket, so no native routes: the router",
  await (await native.fetch("/health")).text(),
  "the router's /health",
);
await native.close();

summary();
