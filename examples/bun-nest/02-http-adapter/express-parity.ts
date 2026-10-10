/**
 * Express parity from a Nest app: what `@nestjs/platform-express` users rely
 * on, on `BunHttpAdapter` — `@Get()` answering `HEAD`, middleware calling
 * `next()` later, a request timeout — plus `server.routes`, the native static
 * routes Bun serves ahead of Nest.
 *
 * ```bash
 * bun 02-http-adapter/express-parity.ts
 * ```
 *
 * Worth knowing:
 *
 * - The behaviour comes from bun-common's router, which the adapter runs
 *   Nest's routes on, so it matches Express 5 the same way there.
 * - `HEAD` to a `@Get()` route runs the handler and answers its status and
 *   headers (`Content-Length` included) without the body — served, and
 *   through the socket-free `adapter.fetch()`. A route with no GET (here a
 *   `@Post()`) still answers `HEAD` with a 404.
 * - A `MiddlewareConsumer` middleware may call `next()` from a timer or an
 *   I/O callback, as callback-style Express middleware does: the request
 *   waits for it. One that never calls it — or an `async` controller method
 *   that never settles — is cut short by the adapter's request timeout
 *   (`new BunHttpAdapter(ms)`), as a 500.
 * - `server.routes` is passed to `Bun.serve`: a constant `Response` there
 *   answers every method with no middleware, guard or interceptor, gets an
 *   `ETag`, and wins over a Nest route on the same path. It exists only on
 *   the socket, so `adapter.fetch()` reaches Nest instead.
 * - `@Redirect()` and `res.redirect()` answer as Express's `res.redirect`:
 *   `Location` percent-encoded, `Vary: Accept`, a `Content-Length`, and a
 *   short body chosen by `Accept` — "Found. Redirecting to …" as `text/plain`,
 *   the same in a `<p>` (HTML-escaped) as `text/html`, or nothing for a client
 *   that accepts neither. `res.redirect(301, url)` and the older
 *   `res.redirect(url, 301)` both work.
 * - `@Controller({ host })` matches a `Host` with a port; `useStaticAssets()`
 *   redirects its bare prefix (`/static`) to `/static/` with a 301;
 *   `res.clearCookie()` expires the cookie at the epoch and drops a `maxAge`
 *   given; a JSON body that does not parse is Nest's 400 (`message`,
 *   `error: "Bad Request"`, `statusCode`).
 * - A few behaviours differ from Express on purpose, and the package README
 *   lists them under "Known differences from `@nestjs/platform-express`". The
 *   last section checks four a Nest user is most likely to meet — no `ETag`
 *   by default, `text/plain` for a string body, a nested `req.query`, and a
 *   `.tsx` view with no engine registered refused rather than loading a
 *   module named `tsx` — and that the README still lists each, so neither
 *   can change without the other.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type {
  CanActivate,
  MessageEvent,
  MiddlewareConsumer,
  NestMiddleware,
  NestModule,
  RawBodyRequest,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Injectable,
  Module,
  Post,
  Query,
  Redirect,
  Render,
  Req,
  Res,
  Sse,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { interval, map, take } from "rxjs";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

title("Express parity from a Nest app");

/** What ran, for the request being checked. */
const trail: string[] = [];

/** Calls `next()` from a timer, as a rate limiter or session store might. */
@Injectable()
class TimerMiddleware implements NestMiddleware {
  use(_req: unknown, _res: unknown, next: () => void) {
    trail.push("TimerMiddleware returned");
    setTimeout(() => {
      trail.push("TimerMiddleware next()");
      next();
    }, 10);
  }
}

/** Calls `next()` from an I/O callback: reading this file. */
function readsAFile(_req: unknown, _res: unknown, next: () => void) {
  void Bun.file(import.meta.path)
    .text()
    .then(() => {
      trail.push("readsAFile next()");
      next();
    });
}

/** Counts every request a guard sees, to show which ones Nest handled. */
@Injectable()
class CountingGuard implements CanActivate {
  canActivate() {
    trail.push("CountingGuard");
    return true;
  }
}

@Controller()
class ParityController {
  /** Counts how many times `page()` ran, for GET and HEAD alike. */
  pageRuns = 0;

  @Get("page")
  @Header("x-page", "1")
  page() {
    this.pageRuns++;
    return "the page body";
  }

  @Post("form")
  form() {
    return "posted";
  }

  @Get("late")
  late() {
    trail.push("handler");
    return "after a late next()";
  }

  @Get("health")
  health() {
    trail.push("Nest /health");
    return "Nest's /health";
  }

  @Get("stuck")
  stuck() {
    return "never reached: the middleware never calls next()";
  }

  @Get("stuck-controller")
  async stuckController(): Promise<string> {
    // Awaits forever: only the request timeout ends this request.
    await new Promise<never>(() => {});
    return "never reached";
  }
}

@Module({ controllers: [ParityController] })
class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TimerMiddleware, readsAFile).forRoutes("late");
    consumer
      .apply((_req: unknown, _res: unknown, _next: () => void) => {
        // Forgets to call next(): only the request timeout ends this.
      })
      .forRoutes("stuck");
    consumer
      .apply((_req: unknown, _res: unknown, next: () => void) => {
        trail.push("every-route middleware");
        next();
      })
      .forRoutes("*");
  }
}

/** Awaits before passing on, as a middleware reading a session store would. */
@Injectable()
class AsyncMiddleware implements NestMiddleware {
  async use(req: { seenBy?: string[] }, _res: unknown, next: () => void) {
    await Bun.sleep(2);
    req.seenBy = ["AsyncMiddleware"];
    next();
  }
}

@Controller("async")
class AsyncController {
  @Get("chain")
  async chain(@Req() req: { seenBy?: string[] }) {
    await Bun.sleep(2);
    return [...(req.seenBy ?? []), "async controller"].join(",");
  }

  /** Three events 100ms apart: the first must not wait for the last. */
  @Sse("ticks")
  ticks(): Observable<MessageEvent> {
    return interval(100).pipe(
      take(3),
      map((n) => ({ data: { tick: n } })),
    );
  }

  @Get("raw")
  rawGet(@Req() req: RawBodyRequest<BunRequest>) {
    return { rawBody: req.rawBody === undefined ? "undefined" : "set" };
  }

  @Post("raw")
  @HttpCode(200)
  rawPost(@Req() req: RawBodyRequest<BunRequest>) {
    return { rawBody: req.rawBody?.toString() ?? null };
  }

  @Post("body")
  @HttpCode(200)
  parsedBody(@Body() body: unknown) {
    return body;
  }
}

@Module({ controllers: [AsyncController] })
class AsyncModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AsyncMiddleware).forRoutes("async/chain");
  }
}

const adapter = new BunHttpAdapter(300, {
  server: {
    routes: {
      "/health": new Response("ok", {
        headers: { "Content-Type": "text/plain" },
      }),
    },
  },
});
const app = await NestFactory.create(AppModule, adapter, { logger: false });
app.useGlobalGuards(new CountingGuard());
await app.listen(0);
const base = `http://127.0.0.1:${adapter.listeningPort}`;
const controller = app.get(ParityController);

/* ------------------------------------------------------------------ */
step("@Get() answers HEAD, without the body");

const servedHead = await fetch(`${base}/page`, { method: "HEAD" });
const servedHeadSummary = {
  status: servedHead.status,
  page: servedHead.headers.get("x-page"),
  length: servedHead.headers.get("content-length"),
  body: await servedHead.text(),
};
show("served HEAD /page", servedHeadSummary);
checkEqual("served: the GET's status and headers, no body", servedHeadSummary, {
  status: 200,
  page: "1",
  length: String("the page body".length),
  body: "",
});
const fetchedHead = await adapter.fetch("/page", { method: "HEAD" });
checkEqual(
  "adapter.fetch(): the same, without a socket",
  {
    status: fetchedHead.status,
    page: fetchedHead.headers.get("x-page"),
    body: await fetchedHead.text(),
  },
  { status: 200, page: "1", body: "" },
);
checkEqual("the handler ran for each", controller.pageRuns, 2);
checkEqual(
  "GET /page still has its body",
  await (await fetch(`${base}/page`)).text(),
  "the page body",
);
checkEqual(
  "HEAD /form (a @Post() only) is a 404",
  (await fetch(`${base}/form`, { method: "HEAD" })).status,
  404,
);

/* ------------------------------------------------------------------ */
step("Middleware calling next() later");

trail.length = 0;
const late = await fetch(`${base}/late`);
checkEqual(
  "served GET /late waits for both callbacks",
  `${late.status} ${await late.text()}`,
  "200 after a late next()",
);
checkEqual("…in this order", trail, [
  "TimerMiddleware returned",
  "TimerMiddleware next()",
  "readsAFile next()",
  "every-route middleware",
  "CountingGuard",
  "handler",
]);
checkEqual(
  "adapter.fetch('/late') too",
  await (await adapter.fetch("/late")).text(),
  "after a late next()",
);

const started = performance.now();
const stuck = await fetch(`${base}/stuck`);
const waited = performance.now() - started;
show(
  `GET /stuck answered after ${waited.toFixed(0)}ms`,
  `${stuck.status} ${stuck.statusText}`,
);
checkEqual("a middleware that never calls next() is a 500", stuck.status, 500);
check("…once the 300ms request timeout ran out", waited >= 290, waited);

const controllerFrom = performance.now();
const stuckController = await fetch(`${base}/stuck-controller`);
const controllerWaited = performance.now() - controllerFrom;
checkEqual(
  "an async controller method that never settles is a 500",
  stuckController.status,
  500,
);
check(
  "…once the 300ms request timeout ran out",
  controllerWaited >= 290,
  controllerWaited,
);

/* ------------------------------------------------------------------ */
step("server.routes: a native route, ahead of Nest");

trail.length = 0;
const health = await fetch(`${base}/health`);
const etag = health.headers.get("etag");
checkEqual("GET /health is Bun's constant", await health.text(), "ok");
check("…with an ETag", typeof etag === "string", etag);
checkEqual(
  "POST /health gets it too",
  await (await fetch(`${base}/health`, { method: "POST" })).text(),
  "ok",
);
checkEqual(
  "If-None-Match with the ETag is a 304",
  (await fetch(`${base}/health`, { headers: { "If-None-Match": etag! } }))
    .status,
  304,
);
checkEqual("no middleware, guard or handler ran", trail, []);
checkEqual(
  "adapter.fetch('/health') has no socket, so Nest answers",
  await (await adapter.fetch("/health")).text(),
  "Nest's /health",
);

await app.close();

/* ------------------------------------------------------------------ */
step("Async middleware and controllers, an early stream, rawBody");

const asyncAdapter = new BunHttpAdapter();
const asyncApp = await NestFactory.create(AsyncModule, asyncAdapter, {
  logger: false,
  rawBody: true,
});
await asyncApp.listen(0);
const asyncBase = `http://127.0.0.1:${asyncAdapter.listeningPort}`;

const chainServed = await fetch(`${asyncBase}/async/chain`);
const chainOffline = await asyncAdapter.fetch("/async/chain");
checkEqual(
  "async middleware then an async controller, served and through fetch()",
  [await chainServed.text(), await chainOffline.text()],
  ["AsyncMiddleware,async controller", "AsyncMiddleware,async controller"],
);

/** The first SSE chunk of `response`, and how long after `startedAt` it came. */
async function firstEvent(response: Response, startedAt: number) {
  const reader = response.body!.getReader();
  let received = "";
  // Nest may open the stream with a comment line before the first event.
  while (!received.includes('"tick":')) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    received += new TextDecoder().decode(chunk.value);
  }
  const after = performance.now() - startedAt;
  await reader.cancel();
  return { tick0: received.includes('"tick":0'), early: after < 250 };
}
const sseServedAt = performance.now();
const sseServed = await firstEvent(
  await fetch(`${asyncBase}/async/ticks`),
  sseServedAt,
);
const sseOfflineAt = performance.now();
const sseOffline = await firstEvent(
  await asyncAdapter.fetch("/async/ticks"),
  sseOfflineAt,
);
checkEqual(
  "@Sse(): the first event arrives before the last is emitted (~300ms), both ways",
  [sseServed, sseOffline],
  [
    { tick0: true, early: true },
    { tick0: true, early: true },
  ],
);

checkEqual(
  "rawBody: true — a GET has no rawBody (the body parser passed it on)",
  await (await asyncAdapter.fetch("/async/raw")).json(),
  { rawBody: "undefined" },
);
checkEqual(
  "…a POST has its exact bytes",
  await (
    await asyncAdapter.fetch("/async/raw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"n": 1}',
    })
  ).json(),
  { rawBody: '{"n": 1}' },
);
// Served-shaped: a JSON POST with a Content-Length, the request.json() path
// without rawBody. rawBody: true keeps the bytes; without it the body is
// still parsed, with no bytes kept.
/** A JSON POST to `path` carrying an explicit Content-Length. */
function servedShapedTo(path: string, text: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(text.length),
    },
    body: text,
  });
}
/** The same, to `/async/raw`. */
function servedShaped(text: string): Request {
  return servedShapedTo("/async/raw", text);
}
checkEqual(
  "rawBody: true — a JSON POST with a Content-Length still has req.rawBody",
  [
    await (await asyncAdapter.fetch(servedShaped('{"n": 2}'))).json(),
    await (
      await fetch(`${asyncBase}/async/raw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"n": 2}',
      })
    ).json(),
  ],
  [{ rawBody: '{"n": 2}' }, { rawBody: '{"n": 2}' }],
);
await asyncApp.close();

const plainAdapter = new BunHttpAdapter();
const plainApp = await NestFactory.create(AsyncModule, plainAdapter, {
  logger: false,
});
await plainApp.init();
checkEqual(
  "without rawBody: no req.rawBody, and the controller still gets the parsed body",
  [
    await (await plainAdapter.fetch(servedShaped('{"n": 3}'))).json(),
    await (
      await plainAdapter.fetch(servedShapedTo("/async/body", '{"n": 3}'))
    ).json(),
  ],
  [{ rawBody: null }, { n: 3 }],
);
await plainApp.close();

/* ------------------------------------------------------------------ */
/** Express's response helpers, as a Nest app on platform-express sees them. */
@Controller()
class ExpressController {
  @Get("redirect")
  @Redirect("/target")
  redirect() {}

  /** Spaces, a non-ASCII letter and an `&`: encoded, and escaped in HTML. */
  @Get("redirect/encoded")
  @Redirect("/search/café menu?q=a b&lang=fr")
  encoded() {}

  /** Express 5's argument order. */
  @Get("res-redirect/status-first")
  statusFirst(@Res() res: BunResponse) {
    res.redirect(301, "/target");
  }

  /** The URL first, as before: still a 301 to the same place. */
  @Get("res-redirect/url-first")
  urlFirst(@Res() res: BunResponse) {
    res.redirect("/target", 301);
  }

  /** A `maxAge` given to `clearCookie()` would keep the cookie alive. */
  @Get("logout")
  logout(@Res({ passthrough: true }) res: BunResponse) {
    res.clearCookie("session", { maxAge: 60_000 });
    return { loggedOut: true };
  }

  @Post("json")
  @HttpCode(200)
  json(@Body() body: unknown) {
    return body;
  }

  @Get("data")
  data() {
    return { v: 1 };
  }

  @Get("words")
  words() {
    return "plain words";
  }

  @Get("query")
  query(@Query() query: unknown) {
    return query;
  }

  /** A `.tsx` view, with no engine registered for `.tsx`. */
  @Get("widget")
  @Render("widget.tsx")
  widget() {
    return {};
  }

  /** The same through `res.render()`, which throws what `@Render()` hides. */
  @Get("widget/why")
  widgetWhy(@Res() res: BunResponse) {
    try {
      res.render("widget.tsx");
    } catch (error) {
      res.json({ thrown: (error as Error).message });
    }
  }
}

/** Answers only for `Host: acme.example.com`, with or without a port. */
@Controller({ host: "acme.example.com", path: "tenant" })
class TenantController {
  @Get()
  tenant() {
    return "acme's page";
  }
}

@Module({ controllers: [ExpressController, TenantController] })
class ExpressModule {}

const parityScratch = await mkdtemp(join(tmpdir(), "bun-nest-parity-"));
const publicDir = join(parityScratch, "public");
await Bun.write(join(publicDir, "index.html"), "<h1>static home</h1>");
const viewsDir = join(parityScratch, "views");
await Bun.write(join(viewsDir, "widget.tsx"), "export const widget = 1;\n");

const expressAdapter = new BunHttpAdapter();
expressAdapter.useStaticAssets(publicDir, { prefix: "/static" });
expressAdapter.setBaseViewsDir(viewsDir);
const expressApp = await NestFactory.create(ExpressModule, expressAdapter, {
  logger: false,
});
await expressApp.listen(0);
const expressBase = `http://127.0.0.1:${expressAdapter.listeningPort}`;

/** What a redirect answered: status, the headers Express sets, the body. */
async function redirected(path: string, accept?: string) {
  const response = await fetch(`${expressBase}${path}`, {
    redirect: "manual",
    headers: accept === undefined ? {} : { accept },
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    vary: response.headers.get("vary"),
    type: response.headers.get("content-type"),
    length: response.headers.get("content-length"),
    body: await response.text(),
  };
}

step("@Redirect() and res.redirect(): Express's body, chosen by Accept");

const plain = await redirected("/redirect", "text/plain");
show("Accept: text/plain", plain);
checkEqual("Accept: text/plain — a plain-text body", plain, {
  status: 302,
  location: "/target",
  vary: "Accept",
  type: "text/plain; charset=utf-8",
  length: String("Found. Redirecting to /target".length),
  body: "Found. Redirecting to /target",
});
checkEqual(
  "Accept: text/html — the same in a <p>",
  await redirected("/redirect", "text/html"),
  {
    status: 302,
    location: "/target",
    vary: "Accept",
    type: "text/html; charset=utf-8",
    length: String("<p>Found. Redirecting to /target</p>".length),
    body: "<p>Found. Redirecting to /target</p>",
  },
);
checkEqual(
  "Accept: application/json — no body, and a Content-Length of 0",
  await redirected("/redirect", "application/json"),
  {
    status: 302,
    location: "/target",
    vary: "Accept",
    type: null,
    length: "0",
    body: "",
  },
);
const encoded = await redirected("/redirect/encoded", "text/html");
checkEqual(
  "Location is percent-encoded; the HTML body escapes the `&`",
  [encoded.location, encoded.body],
  [
    "/search/caf%C3%A9%20menu?q=a%20b&lang=fr",
    "<p>Found. Redirecting to /search/caf%C3%A9%20menu?q=a%20b&amp;lang=fr</p>",
  ],
);
checkEqual(
  "res.redirect(301, url) and res.redirect(url, 301) answer alike",
  [
    await redirected("/res-redirect/status-first", "text/plain"),
    await redirected("/res-redirect/url-first", "text/plain"),
  ].map(({ status, location, body }) => ({ status, location, body })),
  [
    {
      status: 301,
      location: "/target",
      body: "Moved Permanently. Redirecting to /target",
    },
    {
      status: 301,
      location: "/target",
      body: "Moved Permanently. Redirecting to /target",
    },
  ],
);

step("Host routing, the static prefix, clearCookie, invalid JSON");

/** `GET /tenant` with `Host: host`, served. */
async function tenantAs(host: string) {
  const response = await fetch(`${expressBase}/tenant`, { headers: { host } });
  return `${response.status} ${await response.text()}`;
}
checkEqual(
  "@Controller({ host }) matches the Host with and without a port, and nothing else",
  [
    await tenantAs("acme.example.com"),
    await tenantAs("acme.example.com:8080"),
    (await tenantAs("other.example.com")).slice(0, 3),
  ],
  ["200 acme's page", "200 acme's page", "404"],
);

const bare = await fetch(`${expressBase}/static`, { redirect: "manual" });
checkEqual(
  "GET /static — the bare prefix — is a 301 to /static/",
  [bare.status, bare.headers.get("location")],
  [301, "/static/"],
);
checkEqual(
  "…which serves the index",
  await (await fetch(`${expressBase}/static/`)).text(),
  "<h1>static home</h1>",
);

const logout = await fetch(`${expressBase}/logout`);
const cleared = logout.headers.get("set-cookie") ?? "";
show("clearCookie('session', { maxAge: 60000 })", cleared);
checkEqual(
  "clearCookie() expires the cookie at the epoch, and drops the maxAge given",
  {
    expiresAtEpoch: cleared.includes("Expires=Thu, 01 Jan 1970 00:00:00 GMT"),
    maxAge: /max-age/i.test(cleared),
    value: cleared.split(";")[0],
  },
  { expiresAtEpoch: true, maxAge: false, value: "session=" },
);

const broken = await fetch(`${expressBase}/json`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: '{"pad":',
});
const brokenBody = (await broken.json()) as Record<string, unknown>;
show("POST /json with invalid JSON", {
  status: broken.status,
  body: brokenBody,
});
checkEqual(
  "invalid JSON is Nest's 400: message, error and statusCode",
  {
    status: broken.status,
    keys: Object.keys(brokenBody).sort(),
    error: brokenBody.error,
    statusCode: brokenBody.statusCode,
    message: typeof brokenBody.message,
  },
  {
    status: 400,
    keys: ["error", "message", "statusCode"],
    error: "Bad Request",
    statusCode: 400,
    message: "string",
  },
);

/* ------------------------------------------------------------------ */
step("Differs from Express, on purpose (README: Known differences)");

/** The package README's "Known differences" section, whitespace collapsed. */
const readme = await Bun.file(
  join(import.meta.dir, "../../../packages/bun-nest/README.md"),
).text();
const knownDifferences = (
  readme
    .split("### Known differences from `@nestjs/platform-express`")[1]
    ?.split("\n## ")[0] ?? ""
).replace(/\s+/g, " ");

/**
 * Checks one deliberate difference: that the README's Known differences list
 * still names it, and that the adapter still behaves that way. Closing the gap
 * fails the second half — the README's entry is then out of date — and
 * dropping the entry while the behaviour stays fails the first.
 */
function differsOnPurpose<T>(
  label: string,
  readmeSays: string,
  observed: T,
  expected: T,
) {
  checkEqual(
    `${label} — README, Known differences: "${readmeSays}"`,
    { listed: knownDifferences.includes(readmeSays), observed },
    { listed: true, observed: expected },
  );
}

const data = await fetch(`${expressBase}/data`);
await data.text();
differsOnPurpose(
  "no ETag by default (Express: a weak one)",
  "ETags are off unless the adapter's `etag` option turns them on",
  data.headers.get("etag"),
  null,
);

const words = await fetch(`${expressBase}/words`);
differsOnPurpose(
  "a returned string is text/plain (Express: text/html)",
  "A string, number or boolean response body defaults to `text/plain` (Express: `text/html`)",
  [words.headers.get("content-type"), await words.text()],
  ["text/plain;charset=utf-8", "plain words"],
);

differsOnPurpose(
  "req.query nests a[b]=1 (Express 5's simple parser: { 'a[b]': '1' })",
  '`req.query` nests (`a[b]=1` → `{ a: { b: "1" } }`)',
  await (await fetch(`${expressBase}/query?a[b]=1`)).json(),
  { a: { b: "1" } },
);

const widget = await fetch(`${expressBase}/widget`);
differsOnPurpose(
  "a .tsx view with no engine is refused, not require('tsx')'d (Express loads the module named after the extension)",
  'A view with a script extension (`.tsx`, `.jsx`, `.ts`, `.js`, …) and no engine registered for it throws `No view engine registered for ".tsx"…`',
  {
    status: widget.status,
    body: await widget.json(),
    thrown: (
      (await (await fetch(`${expressBase}/widget/why`)).json()) as {
        thrown?: string;
      }
    ).thrown,
  },
  {
    status: 500,
    body: { statusCode: 500, message: "Internal server error" },
    thrown:
      'No view engine registered for ".tsx": register one with engine("tsx", fn).',
  },
);

await expressApp.close();
await rm(parityScratch, { recursive: true, force: true });

summary();
