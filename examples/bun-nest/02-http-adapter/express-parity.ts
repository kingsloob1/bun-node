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
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import type {
  CanActivate,
  MessageEvent,
  MiddlewareConsumer,
  NestMiddleware,
  NestModule,
  RawBodyRequest,
} from "@nestjs/common";
import type { Observable } from "rxjs";
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
  Req,
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

summary();
