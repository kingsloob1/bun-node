/**
 * Security headers, CSRF protection and errors raised outside a route, on
 * `BunHttpAdapter`: what the `403` and the error answers carry, and when the
 * body is read.
 *
 * ```bash
 * bun 02-http-adapter/security.ts
 * ```
 *
 * Worth knowing:
 *
 * - `app.useSecurityHeaders()` and `app.enableCsrfProtection()` arrived in
 *   Nest 12.1. Their hook runs as a middleware where it is enabled, ahead of
 *   Nest's body parsers, guards and routes. A refused request's `403` goes
 *   through Nest's exception filters on the request's own response, so it
 *   carries the security headers and every header an earlier middleware set,
 *   CORS included.
 * - With either feature on, the adapter defers reading the body until
 *   something needs it, so a refused request is answered before its body is
 *   read: a malformed or oversized body gets the `403`, not a `400` or `413`.
 *   An allowed body is read by the body parser as before. The adapter's
 *   `request: { deferBody: false }` turns the deferral off, and an
 *   application with neither feature never defers.
 * - Nest below 12.1 has neither feature, so this example asks
 *   `NestApplication.prototype` for `enableCsrfProtection`, runs those steps
 *   only where it is there, and prints a line starting `skipped:`, naming the
 *   installed version, where they sit out. The other steps run on every Nest.
 * - On every Nest, an error raised outside a route (a middleware's
 *   `next(err)`, a body the body parser refused) is answered on the response
 *   the request was building, so the headers already set on it stay: CORS, a
 *   middleware's own. A body refused while the request is built, before any
 *   middleware ran (the default, without `deferBody`), has nothing set yet.
 * - A `StreamableFile` whose source fails before its first byte goes to the
 *   file's `errorHandler`, as on Express: by default Nest's, a `400` (with
 *   the error's message before Nest 12.2.0; from 12.2.0 the text
 *   `Bad Request`, the message only logged), or whatever a
 *   `setErrorHandler()` answers. The response waits for the first chunk, so
 *   the status can still change.
 * - Requests go through `adapter.fetch()`, the pipeline `Bun.serve` runs,
 *   with no socket; one `403` is also served, to show the same over a socket.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { INestApplication } from "@nestjs/common";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Module,
  Post,
  StreamableFile,
} from "@nestjs/common";
import { NestApplication, NestFactory } from "@nestjs/core";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

/**
 * The installed `@nestjs/common`'s version, for the skip line: read from its
 * `package.json` on disk, since Nest 12's `exports` map has none.
 * @returns The version string, such as "12.2.0".
 */
async function nestCommonVersion(): Promise<string> {
  let dir = dirname(Bun.resolveSync("@nestjs/common", import.meta.dir));
  for (;;) {
    const file = Bun.file(join(dir, "package.json"));
    if (await file.exists()) {
      const pkg = (await file.json()) as { name?: string; version: string };
      if (pkg.name === "@nestjs/common") return pkg.version;
    }
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error("@nestjs/common's package.json was not found");
    dir = parent;
  }
}

/** The installed `@nestjs/common`'s version: for the skip line only. */
const NEST_VERSION = await nestCommonVersion();

/**
 * Whether this Nest has `useSecurityHeaders()` and `enableCsrfProtection()`
 * (12.1+): asked of the application class, never a version string.
 */
const HAS_SECURITY =
  typeof Reflect.get(NestApplication.prototype, "enableCsrfProtection") ===
  "function";

/** The two security methods, where this Nest has them (Nest 11's type lacks them). */
type SecureApp = INestApplication & {
  /** Sets the helmet-equivalent response headers on every answer. */
  useSecurityHeaders: () => SecureApp;
  /** Refuses cross-site requests with unsafe methods: Nest's `403`. */
  enableCsrfProtection: () => SecureApp;
  /** Configures one of Nest's body parsers, as on `NestExpressApplication`. */
  useBodyParser: (type: string, options?: { limit?: string }) => unknown;
};

/** The origin CORS allows, and the one the cross-site requests come from. */
const SHOP = "https://shop.test";

/** A browser's headers for a cross-site request from {@link SHOP}. */
const CROSS_SITE = { origin: SHOP, "sec-fetch-site": "cross-site" };

/** A browser's headers for a same-origin request. */
const SAME_ORIGIN = { origin: SHOP, "sec-fetch-site": "same-origin" };

/** A JSON body over the 1 kB limit the apps below set. */
const OVERSIZED = JSON.stringify({ pad: "x".repeat(4000) });

/** Nest's body for the CSRF refusal. */
const CSRF_REFUSAL = {
  message: "Cross-origin request detected from Sec-Fetch-Site header",
  error: "Forbidden",
  statusCode: 403,
};

/* ------------------------------------------------------------------ */
/** A source that fails before its first chunk: a file that cannot be opened. */
function failingSource(): Readable {
  return new Readable({
    read() {
      this.destroy(new Error("source failed"));
    },
  });
}

@Controller()
class ItemsController {
  @Get("items")
  list() {
    return ["pen"];
  }

  @Post("items")
  create(@Body() body: unknown) {
    return { body: body ?? null };
  }

  /** A file whose source fails before its first byte: the default handler's 400. */
  @Get("file/fails")
  fileFails() {
    return new StreamableFile(failingSource());
  }

  /** The same, answered by the file's own `setErrorHandler()`. */
  @Get("file/fails-custom")
  fileFailsCustom() {
    return new StreamableFile(failingSource()).setErrorHandler(
      (error, response) => {
        response.statusCode = 503;
        response.send(`custom: ${error.message}`);
      },
    );
  }

  /** A source that had already failed by the time the handler returned it. */
  @Get("file/failed")
  async fileFailed() {
    const source = new Readable({ read() {} });
    source.on("error", () => {});
    source.destroy(new Error("failed early"));
    await new Promise((resolve) => setImmediate(resolve));
    return new StreamableFile(source);
  }
}

@Module({ controllers: [ItemsController] })
class ItemsModule {}

/** Marks every response `x-before: set`, ahead of whatever follows it. */
function markBefore(_req: BunRequest, res: BunResponse, next: () => void) {
  res.setHeader("x-before", "set");
  next();
}

/**
 * Raises an error outside every route for `/mw/*`: Nest's exception layer
 * answers it, on the response {@link markBefore} already marked.
 */
function failUnderMw(
  req: BunRequest,
  _res: BunResponse,
  next: (error?: unknown) => void,
) {
  if (req.path.startsWith("/mw/")) {
    next(new ForbiddenException("refused in middleware"));
    return;
  }
  next();
}

/** Builds {@link ItemsModule} on `adapter`, set up by `configure`, initialised. */
async function boot(
  adapter: BunHttpAdapter,
  configure: (app: SecureApp) => void,
): Promise<SecureApp> {
  const app = (await NestFactory.create(ItemsModule, adapter, {
    logger: false,
    abortOnError: false,
  })) as unknown as SecureApp;
  configure(app);
  await app.init();
  return app;
}

/** A `POST /items` of `body` as JSON, with `headers`. */
function postItems(body: string, headers: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  };
}

/** What a check compares of an answer: status, the marked headers, body. */
async function observe(response: Response) {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: kept as text
  }
  return {
    status: response.status,
    "x-before": response.headers.get("x-before"),
    "access-control-allow-origin": response.headers.get(
      "access-control-allow-origin",
    ),
    body,
  };
}

/** Three of the security headers, which `useSecurityHeaders()` sets on every answer. */
function securityHeaders(response: Response) {
  return {
    "x-frame-options": response.headers.get("x-frame-options"),
    "x-content-type-options": response.headers.get("x-content-type-options"),
    "referrer-policy": response.headers.get("referrer-policy"),
  };
}

/** {@link securityHeaders} as `useSecurityHeaders()` sets them by default. */
const SECURITY_DEFAULTS = {
  "x-frame-options": "SAMEORIGIN",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/* ------------------------------------------------------------------ */
title("Security headers, CSRF protection and errors outside a route");
show("@nestjs/common", NEST_VERSION);

/** How many checks the Nest 12.1 steps hold, for the skip line. */
const GATED_CHECKS = 8;

step("useSecurityHeaders() and enableCsrfProtection() (Nest 12.1+)");

if (!HAS_SECURITY) {
  show(
    `skipped: Nest < 12.1 has no useSecurityHeaders() or enableCsrfProtection(); ${GATED_CHECKS} checks skipped on Nest ${NEST_VERSION}`,
  );
} else {
  const adapter = new BunHttpAdapter();
  const app = await boot(adapter, (secure) => {
    secure.enableCors({ origin: SHOP });
    secure.use(markBefore);
    secure.useSecurityHeaders().enableCsrfProtection();
    secure.useBodyParser("json", { limit: "1kb" });
  });

  check(
    "the security hook turned the adapter's deferBody on",
    adapter.requestOpts.deferBody === true,
    adapter.requestOpts,
  );

  const refused = await adapter.fetch(
    "/items",
    postItems('{"a":1}', CROSS_SITE),
  );
  const refusedHeaders = securityHeaders(refused);
  const refusedSeen = await observe(refused);
  show("cross-site POST /items", refusedSeen);
  checkEqual(
    "a cross-site POST is Nest's 403, keeping CORS and the earlier middleware's header",
    refusedSeen,
    {
      status: 403,
      "x-before": "set",
      "access-control-allow-origin": SHOP,
      body: CSRF_REFUSAL,
    },
  );
  checkEqual(
    "the 403 carries the security headers",
    refusedHeaders,
    SECURITY_DEFAULTS,
  );

  /** Each body, cross-site and same-origin: the status each answered. */
  const statuses: Record<string, number> = {};
  for (const [name, body] of [
    ["malformed", "{not json"],
    ["oversized", OVERSIZED],
    ["valid", '{"a":[1]}'],
  ] as const) {
    for (const [origin, headers] of [
      ["cross-site", CROSS_SITE],
      ["same-origin", SAME_ORIGIN],
    ] as const) {
      const response = await adapter.fetch("/items", postItems(body, headers));
      statuses[`${name}, ${origin}`] = response.status;
      await response.body?.cancel();
    }
  }
  show("statuses", statuses);
  checkEqual(
    "refused before the body is read: a malformed or oversized body gets the 403; allowed, it is read as before",
    statuses,
    {
      "malformed, cross-site": 403,
      "malformed, same-origin": 400,
      "oversized, cross-site": 403,
      "oversized, same-origin": 413,
      "valid, cross-site": 403,
      "valid, same-origin": 201,
    },
  );

  const allowed = await adapter.fetch(
    "/items",
    postItems('{"a":[1]}', SAME_ORIGIN),
  );
  const allowedHeaders = securityHeaders(allowed);
  checkEqual(
    "an allowed POST is parsed, and carries the same headers",
    [await observe(allowed), allowedHeaders],
    [
      {
        status: 201,
        "x-before": "set",
        "access-control-allow-origin": SHOP,
        body: { body: { a: [1] } },
      },
      SECURITY_DEFAULTS,
    ],
  );

  await app.listen(0);
  const served = await fetch(
    `${await app.getUrl()}/items`,
    postItems("{not json", CROSS_SITE),
  );
  const servedHeaders = securityHeaders(served);
  checkEqual(
    "served: the same 403 over a socket, its malformed body unread",
    [await observe(served), servedHeaders],
    [
      {
        status: 403,
        "x-before": "set",
        "access-control-allow-origin": SHOP,
        body: CSRF_REFUSAL,
      },
      SECURITY_DEFAULTS,
    ],
  );
  await app.close();

  /* ---------------------------------------------------------------- */
  step("request: { deferBody: false } reads the body up front again");

  const eager = new BunHttpAdapter(0, { request: { deferBody: false } });
  const eagerApp = await boot(eager, (secure) => {
    secure.enableCsrfProtection();
  });
  check(
    "an explicit deferBody: false wins over the security hook's",
    eager.requestOpts.deferBody === false,
    eager.requestOpts,
  );
  const eagerStatuses: Record<string, number> = {};
  for (const [name, body] of [
    ["malformed", "{not json"],
    ["valid", '{"a":1}'],
  ] as const) {
    const response = await eager.fetch("/items", postItems(body, CROSS_SITE));
    eagerStatuses[`${name}, cross-site`] = response.status;
    await response.body?.cancel();
  }
  show("statuses", eagerStatuses);
  checkEqual(
    "the malformed body is refused as it is read, before the CSRF check: 400, not 403",
    eagerStatuses,
    { "malformed, cross-site": 400, "valid, cross-site": 403 },
  );
  await eagerApp.close();
}

/* ------------------------------------------------------------------ */
step("Without either feature the body is never deferred (every Nest)");
{
  const adapter = new BunHttpAdapter();
  const app = await boot(adapter, () => undefined);
  checkEqual("deferBody stays unset", adapter.requestOpts.deferBody, undefined);
  await app.close();
}

/* ------------------------------------------------------------------ */
step("Errors outside a route keep the headers already set (every Nest)");
{
  const adapter = new BunHttpAdapter();
  const app = await boot(adapter, (plain) => {
    plain.enableCors({ origin: SHOP });
    plain.use(markBefore);
    plain.use(failUnderMw);
  });

  const fromMiddleware = await observe(
    await adapter.fetch("/mw/anything", { headers: { origin: SHOP } }),
  );
  show("GET /mw/anything", fromMiddleware);
  checkEqual(
    "a middleware's next(err) is Nest's answer, on the response CORS and the middleware marked",
    fromMiddleware,
    {
      status: 403,
      "x-before": "set",
      "access-control-allow-origin": SHOP,
      body: {
        message: "refused in middleware",
        error: "Forbidden",
        statusCode: 403,
      },
    },
  );

  const early = await observe(
    await adapter.fetch("/items", postItems("{not json", { origin: SHOP })),
  );
  show("POST /items, malformed JSON, read up front", early);
  checkEqual(
    "a body refused as the request is built is Nest's 400 on a fresh response: no middleware has run yet",
    [early.status, early["x-before"], early["access-control-allow-origin"]],
    [400, null, null],
  );
  await app.close();

  // Deferred, the body is read by Nest's body parser, after CORS and the
  // middleware: its refusal is answered on the response they marked.
  const deferred = new BunHttpAdapter(0, { request: { deferBody: true } });
  const deferredApp = await boot(deferred, (plain) => {
    plain.enableCors({ origin: SHOP });
    plain.use(markBefore);
  });
  const late = await observe(
    await deferred.fetch("/items", postItems("{not json", { origin: SHOP })),
  );
  show("POST /items, malformed JSON, deferBody: true", late);
  checkEqual(
    "a body refused by the body parser is Nest's 400, keeping CORS and the middleware's header",
    [late.status, late["x-before"], late["access-control-allow-origin"]],
    [400, "set", SHOP],
  );
  await deferredApp.close();
}

/* ------------------------------------------------------------------ */
step("A StreamableFile whose source fails before its first byte (every Nest)");
{
  const adapter = new BunHttpAdapter();
  const app = await boot(adapter, () => undefined);

  // What Nest's own default handler answers for an error: it changed in
  // 12.2.0, which logs the message and sends "Bad Request", where earlier
  // releases send the message. The adapter calls that handler, so a check
  // compares against it rather than against either text.
  const defaultAnswer = (message: string) => {
    let body: unknown;
    new StreamableFile(Buffer.from("")).errorHandler(new Error(message), {
      destroyed: false,
      headersSent: false,
      statusCode: 200,
      send: (sent: unknown) => {
        body = sent;
      },
    } as unknown as Parameters<StreamableFile["errorHandler"]>[1]);
    return body;
  };
  show(
    "Nest's default handler sends, for Error('source failed')",
    defaultAnswer("source failed"),
  );

  const failed: Record<string, unknown> = {};
  for (const path of ["/file/fails", "/file/fails-custom", "/file/failed"]) {
    const response = await adapter.fetch(path);
    failed[path] = { status: response.status, body: await response.text() };
  }
  show("answers", failed);
  checkEqual(
    "the file's errorHandler answers: Nest's 400 by default, or the custom handler's answer",
    failed,
    {
      "/file/fails": { status: 400, body: defaultAnswer("source failed") },
      "/file/fails-custom": { status: 503, body: "custom: source failed" },
      "/file/failed": { status: 400, body: defaultAnswer("failed early") },
    },
  );

  await app.close();
}

summary();
