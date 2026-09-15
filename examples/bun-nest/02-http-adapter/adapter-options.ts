/**
 * Adapter options: what `new BunHttpAdapter(requestTimeout, options)` takes,
 * and the adapter methods a NestJS app reaches for — CORS, static files, body
 * parsing and raw bodies, logging, server introspection, socket-free requests
 * and shutdown.
 *
 * ```bash
 * bun 02-http-adapter/adapter-options.ts
 * ```
 *
 * Worth knowing:
 *
 * - Bodies are parsed while the request is built, by `BunRequest`, following
 *   the adapter's `request` option — not by a body-parser middleware. Size caps
 *   therefore belong in `request.parseBody.maxContentLength`, and an oversized
 *   body is answered `413` before any middleware runs.
 * - `rawBody: true` in `NestFactory.create()` — or
 *   `registerParserMiddleware(prefix, true)` — keeps the unparsed bytes on
 *   `req.rawBody`, which is what a webhook signature is computed over.
 * - `INestApplication` types `enableCors` but not `useStaticAssets`, so the
 *   latter is called on the adapter.
 * - After `app.init()`, `adapter.fetch()` runs a request through the whole
 *   adapter pipeline without binding a port.
 */
import type { BunRequest, DefaultRequestBody } from "@kingsleyweb/bun-common";
import type { RawBodyRequest } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Ip,
  Logger,
  Module,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

/** The secret a payment provider signs its webhooks with. */
const WEBHOOK_SECRET = "whsec_example";

@Controller()
class AppController {
  @Get("items")
  items() {
    return [{ id: 1, name: "pen" }];
  }

  @Post("echo")
  @HttpCode(200)
  echo(@Body() body: DefaultRequestBody) {
    return { received: typeof body };
  }

  /** Verifies an HMAC over the exact bytes that arrived. */
  @Post("webhooks/payments")
  @HttpCode(200)
  webhook(
    @Req() req: RawBodyRequest<BunRequest>,
    @Headers("x-signature") signature: string | undefined,
  ) {
    const expected = createHmac("sha256", WEBHOOK_SECRET)
      .update(req.rawBody ?? "")
      .digest("hex");
    if (signature !== expected) {
      throw new UnauthorizedException("bad signature");
    }

    return { verified: true, bytes: req.rawBody?.length };
  }

  @Get("whoami")
  whoami(@Ip() ip: string) {
    return { ip };
  }
}

@Module({ controllers: [AppController] })
class AppModule {}

title("BunHttpAdapter options and methods");

const scratch = await mkdtemp(join(tmpdir(), "bun-nest-adapter-options-"));
const publicDir = join(scratch, "public");
await Bun.write(join(publicDir, "index.html"), "<h1>Shop</h1>\n");
await Bun.write(join(publicDir, "app.css"), "body { margin: 0 }\n");
await Bun.write(join(publicDir, ".env"), "SECRET=do-not-serve\n");

/* ------------------------------------------------------------------ */
step("Constructor options");

const logger = new Logger("BunHttp");
const adapter = new BunHttpAdapter(
  // requestTimeout: how long a response may take once routing is done.
  10_000,
  {
    // Forwarded to every BunRequest: parse bodies up to 16kb, and cookies.
    request: {
      parseBody: { maxContentLength: "16kb" },
      parseCookies: true,
    },
    // Forwarded to the BunRouter underneath.
    router: { caseSensitive: false },
    // Size of the router's matched-pipeline cache.
    routeCacheMax: 10_000,
    // Compute an ETag for every response (off by default).
    etag: true,
    // Adapter diagnostics.
    logger,
    // Merged into Bun.serve() at listen time.
    server: { idleTimeout: 30, maxRequestBodySize: 1024 * 1024 },
  },
);
show("requestTimeout", adapter.timeout);
show("request options", adapter.requestOpts);
show("logger is the one passed", adapter.logger === logger);
show("reported type (for libraries that branch on it)", adapter.getType());

// Plain adapter routes live alongside Nest's controllers, with params typed
// from the path literal.
adapter.get("/raw/:id", (req, res) => {
  return res.json({ id: req.params.id, from: "an adapter route" });
});

adapter.useStaticAssets(publicDir, {
  prefix: "/static",
  maxAge: "1d",
  immutable: true,
  extensions: ["html"],
  dotfiles: "deny",
});

const app = await NestFactory.create(AppModule, adapter, {
  logger: false,
  abortOnError: false,
  rawBody: true,
});
app.enableCors({
  origin: ["https://shop.example.com", /\.example\.dev$/],
  credentials: true,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "X-Signature"],
  exposedHeaders: ["ETag"],
  maxAge: 600,
});

const closed = new Promise<void>((resolve) => {
  adapter.eventEmitter.once("close", () => resolve());
});

await app.listen(0);
const url = await app.getUrl();
show("listening on", url);

/** The headers of a response that are worth printing, by name. */
function pick(response: Response, names: string[]) {
  return Object.fromEntries(
    names.map((name) => [name, response.headers.get(name)]),
  );
}

/* ------------------------------------------------------------------ */
step("router.caseSensitive: false, etag: true, parseBody.maxContentLength");

const items = await fetch(`${url}/ITEMS`);
const etag = items.headers.get("etag");
show("GET /ITEMS", { status: items.status, etag, body: await items.json() });

const revalidated = await fetch(`${url}/items`, {
  headers: { "if-none-match": etag ?? "" },
});
// The automatic ETag matches, so the revalidation is answered 304.
show("GET /items with If-None-Match", revalidated.status);

show("adapter route", await (await fetch(`${url}/raw/42`)).json());

const oversized = await fetch(`${url}/echo`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ blob: "x".repeat(32 * 1024) }),
});
show("POST 32kb to /echo", {
  status: oversized.status,
  body: await oversized.json(),
});

/* ------------------------------------------------------------------ */
step("enableCors(options)");

const preflight = await fetch(`${url}/echo`, {
  method: "OPTIONS",
  headers: {
    origin: "https://shop.example.com",
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  },
});
show("preflight from an allowed origin", {
  status: preflight.status,
  ...pick(preflight, [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-max-age",
  ]),
});

const matched = await fetch(`${url}/items`, {
  headers: { origin: "https://preview.example.dev" },
});
show(
  "GET from an origin matching the RegExp",
  pick(matched, [
    "access-control-allow-origin",
    "access-control-expose-headers",
    "vary",
  ]),
);

const refused = await fetch(`${url}/items`, {
  headers: { origin: "https://evil.example.com" },
});
show(
  "GET from an origin not on the list",
  pick(refused, ["access-control-allow-origin"]),
);

/* ------------------------------------------------------------------ */
step(
  "useStaticAssets(dir, { prefix, maxAge, immutable, extensions, dotfiles })",
);

const css = await fetch(`${url}/static/app.css`);
show("GET /static/app.css", {
  status: css.status,
  ...pick(css, [
    "content-type",
    "cache-control",
    "etag",
    "last-modified",
    "accept-ranges",
  ]),
});
const cssAgain = await fetch(`${url}/static/app.css`, {
  headers: { "if-none-match": css.headers.get("etag") ?? "" },
});
show("…revalidated", cssAgain.status);
show("GET /static/ (index)", await (await fetch(`${url}/static/`)).text());
show(
  "GET /static/index (extensions)",
  (await fetch(`${url}/static/index`)).status,
);
show(
  "GET /static/.env (dotfiles: deny)",
  (await fetch(`${url}/static/.env`)).status,
);
show(
  "GET /static/missing.css",
  (await fetch(`${url}/static/missing.css`)).status,
);

/* ------------------------------------------------------------------ */
step("rawBody: true — verifying a webhook signature");

const event = JSON.stringify({ type: "payment.succeeded", amount: 999 });
const signature = createHmac("sha256", WEBHOOK_SECRET)
  .update(event)
  .digest("hex");
for (const [label, sent] of [
  ["correct signature", signature],
  ["tampered signature", `${signature.slice(0, -1)}0`],
] as const) {
  const response = await fetch(`${url}/webhooks/payments`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": sent },
    body: event,
  });
  show(label, { status: response.status, body: await response.json() });
}

/* ------------------------------------------------------------------ */
step("registerParserMiddleware(prefix, rawBody) on a plain adapter");

const hooks = new BunHttpAdapter();
// Nest calls this at init with the global prefix and `rawBody`. Only the first
// call registers anything; later ones (and useBodyParser) are no-ops.
hooks.registerParserMiddleware("/hooks", true);
hooks.post("/hooks/github", (req, res) => {
  const raw = (req as RawBodyRequest<BunRequest>).rawBody;
  return res.json({ rawBody: raw?.toString() ?? null });
});
hooks.post("/elsewhere", (req, res) => {
  const raw = (req as RawBodyRequest<BunRequest>).rawBody;
  return res.json({ rawBody: raw?.toString() ?? null });
});
for (const path of ["/hooks/github", "/elsewhere"]) {
  const response = await hooks.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"zen":"Keep it logically awesome."}',
  });
  show(`POST ${path}`, await response.json());
}

/* ------------------------------------------------------------------ */
step("Logger");

const httpLogger = new Logger("Http");
show(
  "setLogger() returns the adapter",
  adapter.setLogger(httpLogger) === adapter,
);
show("…and replaces the logger", adapter.logger === httpLogger);

/* ------------------------------------------------------------------ */
step("Server introspection");

show("getListenAddress()", (await adapter.getListenAddress()).href);
show("url / listeningHost / listeningPort", {
  url: adapter.url,
  host: adapter.listeningHost,
  port: adapter.listeningPort,
  isListening: adapter.isListening,
});
show("address()", adapter.address());
// What Nest holds as its "HTTP server": a proxy answering the Node server
// calls Nest makes (`address`, `once`, …) from the adapter and the Bun server.
// Its declared type is the Bun server, which has no `address`, hence the cast.
const httpServer = adapter.getHttpServer() as unknown as {
  /** The listening address, as Node's `server.address()` reports it. */
  address: typeof adapter.address;
};
show("getHttpServer().address()", httpServer.address());
const bunServer = adapter.getBunServer();
show("getBunServer()", {
  port: bunServer?.port,
  hostname: bunServer?.hostname,
  development: bunServer?.development,
  pendingRequests: bunServer?.pendingRequests,
});

/* ------------------------------------------------------------------ */
step("fetch() without a socket");

const offline = new BunHttpAdapter();
const offlineApp = await NestFactory.create(AppModule, offline, {
  logger: false,
  abortOnError: false,
});
await offlineApp.init();
show("GET /items", await (await offline.fetch("/items")).json());
show(
  "GET /whoami over the socket",
  await (await fetch(`${url}/whoami`)).json(),
);
show(
  "GET /whoami through fetch() (no peer)",
  await (await offline.fetch("/whoami")).json(),
);
show("GET /nope", (await offline.fetch("/nope")).status);
await offlineApp.close();

/* ------------------------------------------------------------------ */
step("close()");

await app.close();
await closed;
show("'close' was emitted; isListening", adapter.isListening);
try {
  await fetch(`${url}/items`);
  show("the old URL still answers (unexpected)");
} catch (error) {
  show("the old URL refuses connections", (error as Error).name);
}

await rm(scratch, { recursive: true, force: true });
