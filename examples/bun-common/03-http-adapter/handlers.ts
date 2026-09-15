/**
 * The adapter's handlers and switches — `setErrorHandler`,
 * `setNotFoundHandler`, `enableCors`, `useStaticAssets`,
 * `registerParserMiddleware` / `useBodyParser`, `setRequestOpts`, `setLogger`,
 * `setTimeout`, and the payload guard.
 *
 * ```bash
 * bun 03-http-adapter/handlers.ts
 * ```
 *
 * - `setErrorHandler` is the last resort for an error no 4-argument
 *   middleware handled. Served requests and `adapter.fetch()` go through the
 *   same error handling, so it applies to both.
 * - `enableCors` and `registerParserMiddleware` register middleware *where they
 *   are called* — call them before the routes they should cover.
 * - `registerParserMiddleware` parses every body type; `useBodyParser(kind)`
 *   parses one kind (`json` → `application/json`, …, or `options.type`) with
 *   its own `limit`/`inflate`. Each is registered once per kind; different
 *   kinds stack.
 * - An error no handler claims is answered as Express's finalhandler does: the
 *   error's 4xx/5xx `status` (413 for a body over `limit`), else 500.
 * - `setTimeout(ms, callback)` sets the request timeout at once, and calls
 *   `callback` with the server once one is listening.
 */
import type {
  BunRequest,
  BunServer,
  WebSocketClientData,
} from "@kingsleyweb/bun-common";
import type { Buffer } from "node:buffer";
import { join } from "node:path";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("Adapter handlers");

/** Summarises a response as `"<status> <body>"`. */
async function summary(response: Response): Promise<string> {
  return `${response.status} ${await response.text()}`;
}

/* ------------------------------------------------------------------ */
step("setNotFoundHandler(): what an unmatched request gets");

const plain = new BunHttpAdapter();
show(
  "without one — an empty 404",
  await summary(await plain.fetch("/nothing")),
);

const friendly = new BunHttpAdapter();
friendly.setNotFoundHandler((req, res) => {
  res.status(404).json({ error: "not found", path: req.path });
});
show("with one", await summary(await friendly.fetch("/nothing")));

/* ------------------------------------------------------------------ */
step("setErrorHandler(): the last resort, served or fetched");

const fragile = new BunHttpAdapter();
fragile.get("/boom", () => {
  throw Object.assign(new Error("database unavailable"), { status: 503 });
});
fragile.setErrorHandler((error, req, res) => {
  const status = (error as { status?: number }).status ?? 500;
  res.status(status).json({ error: (error as Error).message, path: req.path });
});
await fragile.listen(0);

show("served GET /boom", await summary(await fetch(`${fragile.url}/boom`)));
show("adapter.fetch('/boom')", await summary(await fragile.fetch("/boom")));
await fragile.close();

/* ------------------------------------------------------------------ */
step("enableCors(): every route, or one prefix");

const open = new BunHttpAdapter();
open.enableCors({
  origin: ["https://app.example.test"],
  methods: ["GET", "POST"],
  exposedHeaders: ["X-Total"],
  credentials: true,
  maxAge: 600,
});
open.get("/items", (_req, res) => {
  res.setHeader("X-Total", "3");
  res.send("three items");
});

const simple = await open.fetch("/items", {
  headers: { Origin: "https://app.example.test" },
});
show("a simple request", {
  status: simple.status,
  allowOrigin: simple.headers.get("Access-Control-Allow-Origin"),
  credentials: simple.headers.get("Access-Control-Allow-Credentials"),
  expose: simple.headers.get("Access-Control-Expose-Headers"),
});

const preflight = await open.fetch("/items", {
  method: "OPTIONS",
  headers: {
    Origin: "https://app.example.test",
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type",
  },
});
show("a preflight", {
  status: preflight.status,
  methods: preflight.headers.get("Access-Control-Allow-Methods"),
  headers: preflight.headers.get("Access-Control-Allow-Headers"),
  maxAge: preflight.headers.get("Access-Control-Max-Age"),
});

const stranger = await open.fetch("/items", {
  headers: { Origin: "https://evil.example.test" },
});
show(
  "an origin not on the list",
  stranger.headers.get("Access-Control-Allow-Origin") ?? "no Allow-Origin",
);

// A delegate decides per request, and a prefix limits where CORS applies.
const partners = new Set(["https://partner.example.test"]);
const scoped = new BunHttpAdapter();
scoped.enableCors((req, callback) => {
  callback(null, { origin: partners.has(req.getHeader("Origin") ?? "") });
}, "/partner");
scoped.get("/partner/feed", (_req, res) => res.send("feed"));
scoped.get("/internal", (_req, res) => res.send("internal"));

for (const path of ["/partner/feed", "/internal"]) {
  const response = await scoped.fetch(path, {
    headers: { Origin: "https://partner.example.test" },
  });
  show(
    `${path}: Allow-Origin`,
    response.headers.get("Access-Control-Allow-Origin") ?? "none",
  );
}

/* ------------------------------------------------------------------ */
step("useStaticAssets(): a directory under a prefix");

const assets = new BunHttpAdapter();
assets.useStaticAssets(join(import.meta.dir, "fixtures", "public"), {
  prefix: "/static",
  maxAge: 3_600_000,
});

const file = await assets.fetch("/static/hello.txt");
const fileTag = file.headers.get("ETag");
show("GET /static/hello.txt", {
  status: file.status,
  type: file.headers.get("Content-Type"),
  cacheControl: file.headers.get("Cache-Control"),
  body: (await file.text()).trim(),
});
show(
  "…again with If-None-Match",
  (
    await assets.fetch("/static/hello.txt", {
      headers: { "If-None-Match": fileTag ?? "" },
    })
  ).status,
);
show(
  "GET /static/ — the directory index",
  (await assets.fetch("/static/")).headers.get("Content-Type"),
);
show(
  "GET /static/missing.txt",
  (await assets.fetch("/static/missing.txt")).status,
);

/* ------------------------------------------------------------------ */
step("registerParserMiddleware() and useBodyParser(): req.rawBody");

const parsed = new BunHttpAdapter();
parsed.registerParserMiddleware(undefined, true);
const routesBefore = parsed.routes().length;
parsed.registerParserMiddleware(undefined, true); // already registered: a no-op
show(
  "registerParserMiddleware twice added a route?",
  parsed.routes().length !== routesBefore,
);
parsed.useBodyParser("json", true, { limit: "1kb" }); // another kind: added
show(
  "useBodyParser('json') after it added a route?",
  parsed.routes().length !== routesBefore,
);

parsed.post("/webhook", (req, res) => {
  // rawBody holds the exact bytes, for signature checks; body is parsed.
  const raw = (req as BunRequest & { rawBody?: Buffer }).rawBody;
  res.json({ body: req.body ?? null, raw: raw?.toString() ?? null });
});
show(
  "POST /webhook",
  await summary(
    await parsed.fetch("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"event":"paid","amount":10}',
    }),
  ),
);

/* ------------------------------------------------------------------ */
step("setRequestOpts(): the payload guard, switched on at runtime");

const guarded = new BunHttpAdapter();
guarded.post("/notes", (req, res) => res.json({ saved: req.body ?? null }));

/** A JSON POST carrying `size` characters. */
const note = (size: number): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "n".repeat(size) }),
});

show("default request options", guarded.requestOpts);
show(
  "a 2kb note, uncapped",
  (await guarded.fetch("/notes", note(2_000))).status,
);

guarded.setRequestOpts({
  parseBody: { maxContentLength: 512 },
  parseCookies: true,
});
show(
  "after setRequestOpts({ parseBody: { maxContentLength: 512 } })",
  await summary(await guarded.fetch("/notes", note(2_000))),
);
show(
  "a small note still passes",
  (await guarded.fetch("/notes", note(10))).status,
);

/* ------------------------------------------------------------------ */
step("setLogger() and setTimeout()");

const tuned = new BunHttpAdapter(0, { router: { debug: true } });
const { logger, events } = createTestLogger();
tuned.setLogger(logger);
tuned.get("/ping", (_req, res) => res.send("pong"));
tuned.get("/stuck", () => {
  // Never responds: the timeout set below is what ends it.
});

await tuned.fetch("/ping");
show("the new logger received the router's debug records", events.length);

let handedServer: BunServer<WebSocketClientData> | undefined;
const ready = tuned.setTimeout(100, (server) => {
  handedServer = server;
});
show("timeout, set immediately", tuned.timeout);

await tuned.listen(0);
await ready;
show(
  "…and the callback got the server once it listened",
  handedServer === tuned.server,
);
const stuck = await tuned.fetch("/stuck");
show(
  "GET /stuck, once the timeout fired",
  `${stuck.status} ${stuck.statusText}`,
);
await tuned.close();
