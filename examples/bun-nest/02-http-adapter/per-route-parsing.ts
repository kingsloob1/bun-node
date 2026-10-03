/**
 * Per-route parsing in a Nest app: bun-common's `requestParsing()`, re-exported
 * by `@kingsleyweb/bun-nest`, applied with `consumer.apply()`.
 *
 * ```bash
 * bun 02-http-adapter/per-route-parsing.ts
 * ```
 *
 * Worth knowing:
 *
 * - `requestParsing({ ... })` is functional middleware: it sets how a route's
 *   requests are parsed — query, cookies, body — for those requests only,
 *   and parses them that way before `next()`. The adapter's options and other
 *   routes are never changed.
 * - Changing query or cookie parsing, or **lowering** a body cap, works as is.
 * - **Raising** a body cap for one route needs two settings: the adapter's
 *   `deferBody` request option (so the body is read on first need, not while
 *   the request is built) and `bodyParser: false` in `NestFactory.create`
 *   (otherwise Nest's own body parser reads, and caps, every body before any
 *   route's middleware runs).
 * - A body over a route's cap reaches Nest's exception layer as a 413.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import type {
  INestApplication,
  MiddlewareConsumer,
  NestModule,
} from "@nestjs/common";
import { BunHttpAdapter, requestParsing } from "@kingsleyweb/bun-nest";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Post,
  Req,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";
import "reflect-metadata";

title("Per-route parsing in a Nest app");

@Controller()
class AppController {
  @Post("upload")
  @HttpCode(200)
  upload(@Body() body: { pad?: string }) {
    return { bytes: body.pad?.length ?? 0 };
  }

  @Post("small")
  @HttpCode(200)
  small(@Body() body: { pad?: string }) {
    return { bytes: body.pad?.length ?? 0 };
  }

  @Get("webhooks")
  webhooks(@Req() req: BunRequest) {
    return { query: req.query, cookies: req.cookies };
  }

  @Get("flat")
  flat(@Req() req: BunRequest) {
    return { query: req.query };
  }

  @Get("plain")
  plain(@Req() req: BunRequest) {
    return { query: req.query, cookies: req.cookies };
  }
}

@Module({ controllers: [AppController] })
class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(requestParsing({ parseBody: { maxContentLength: "1mb" } }))
      .forRoutes("upload");
    consumer
      .apply(requestParsing({ parseQuery: false, parseCookies: false }))
      .forRoutes("webhooks");
    consumer
      .apply(requestParsing({ parseQueryOpts: { nesting: false } }))
      .forRoutes("flat");
  }
}

/** Builds the app on an adapter capping bodies at 64 bytes. */
async function build(
  deferBody: boolean,
  bodyParser: boolean,
): Promise<{ app: INestApplication; adapter: BunHttpAdapter }> {
  const adapter = new BunHttpAdapter(0, {
    request: { parseBody: { maxContentLength: 64 }, deferBody },
  });
  const app = await NestFactory.create(AppModule, adapter, {
    logger: false,
    bodyParser,
  });
  await app.init();
  return { app, adapter };
}

/** A JSON `POST` whose body is about `size` bytes. */
function post(size: number): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pad: "x".repeat(size) }),
  };
}

/* ------------------------------------------------------------------ */
step("deferBody + bodyParser: false — /upload raises its cap");

const raised = await build(true, false);
checkEqual(
  "POST /upload with ~200 bytes: over the adapter's 64, under the route's 1mb",
  await (await raised.adapter.fetch("/upload", post(200))).json(),
  { bytes: 200 },
);
const refused = await raised.adapter.fetch("/small", post(200));
checkEqual(
  "POST /small with the same body: the adapter's cap, a 413",
  refused.status,
  413,
);
checkEqual(
  "POST /small within it: parsed",
  await (await raised.adapter.fetch("/small", post(10))).json(),
  { bytes: 10 },
);

/* ------------------------------------------------------------------ */
step("Query and cookies, per route");

const headers = { Cookie: "session=abc" };
checkEqual(
  "GET /webhooks: no query, no cookies",
  await (await raised.adapter.fetch("/webhooks?a=1", { headers })).json(),
  { query: {}, cookies: {} },
);
checkEqual(
  "GET /flat?a[b]=1: kept flat",
  await (await raised.adapter.fetch("/flat?a[b]=1")).json(),
  { query: { "a[b]": "1" } },
);
checkEqual(
  "GET /plain: the adapter's defaults, untouched",
  await (await raised.adapter.fetch("/plain?a[b]=1", { headers })).json(),
  { query: { a: { b: "1" } }, cookies: { session: "abc" } },
);
await raised.app.close();

/* ------------------------------------------------------------------ */
step("Without either setting, the cap cannot be raised");

const noDefer = await build(false, false);
checkEqual(
  "no deferBody: /upload's body was refused before routing",
  (await noDefer.adapter.fetch("/upload", post(200))).status,
  413,
);
await noDefer.app.close();

const nestParser = await build(true, true);
checkEqual(
  "deferBody but Nest's body parser on: it read and capped the body first",
  (await nestParser.adapter.fetch("/upload", post(200))).status,
  413,
);
await nestParser.app.close();

summary();
