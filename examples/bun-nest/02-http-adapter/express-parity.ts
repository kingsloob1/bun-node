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
 *   waits for it. One that never calls it is cut short by the adapter's
 *   request timeout (`new BunHttpAdapter(ms)`), as a 500.
 * - `server.routes` is passed to `Bun.serve`: a constant `Response` there
 *   answers every method with no middleware, guard or interceptor, gets an
 *   `ETag`, and wins over a Nest route on the same path. It exists only on
 *   the socket, so `adapter.fetch()` reaches Nest instead.
 */
import type {
  CanActivate,
  MiddlewareConsumer,
  NestMiddleware,
  NestModule,
} from "@nestjs/common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  Controller,
  Get,
  Header,
  Injectable,
  Module,
  Post,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
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
summary();
