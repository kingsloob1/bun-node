/**
 * Middleware and versioning: Nest middleware through `MiddlewareConsumer`, a
 * global prefix, and every `VersioningType` — on `BunHttpAdapter`.
 *
 * ```bash
 * bun 02-http-adapter/middleware-and-versioning.ts
 * ```
 *
 * Worth knowing:
 *
 * - Nest hands each `consumer.apply(...).forRoutes(...)` entry to the adapter's
 *   `createMiddlewareFactory(method)`, which registers it with
 *   `BunRouter.useMethod`: method-scoped, run in registration order ahead of
 *   the route handler, and prefix-matched like Express `use(path)`.
 * - Every versioning type except `URI` is enforced by `applyVersionFilter`,
 *   which wraps each versioned handler. A request whose version does not match
 *   calls `next()`, so the next candidate route gets it; a request no route
 *   accepts ends as Nest's 404.
 * - Nest allows one versioning type per application, so this example builds
 *   one app per type. Those apps never listen: after `app.init()`,
 *   `adapter.fetch()` runs a request through the whole adapter pipeline with
 *   no socket.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type {
  MiddlewareFactoryRespType,
  VersionedRoute,
} from "@kingsleyweb/bun-nest";
import type {
  MiddlewareConsumer,
  NestMiddleware,
  NestModule,
  VersioningOptions,
} from "@nestjs/common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  RequestMethod,
  Version,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

/** What ran for the request being shown, in order. */
const trail: string[] = [];

/* ------------------------------------------------------------------ */
/** A class middleware: gives every response an `x-request-id`. */
@Injectable()
class RequestIdMiddleware implements NestMiddleware<BunRequest, BunResponse> {
  /** How many ids this instance has issued. */
  private issued = 0;

  use(req: BunRequest, res: BunResponse, next: () => void) {
    const id = req.getHeader("x-request-id") ?? `req-${++this.issued}`;
    res.setHeader("x-request-id", id);
    trail.push("RequestIdMiddleware");
    next();
  }
}

/** A functional middleware: stamps when handling started. */
function timing(_req: BunRequest, res: BunResponse, next: () => void) {
  res.setHeader("x-started-at", String(Math.round(performance.now())));
  trail.push("timing");
  next();
}

/** A functional middleware scoped to particular methods. */
function auditWrites(req: BunRequest, _res: BunResponse, next: () => void) {
  trail.push(`auditWrites(${req.method})`);
  next();
}

@Controller("cats")
class CatsController {
  @Get()
  list() {
    trail.push("CatsController.list");
    return [{ id: 1, name: "Tom" }];
  }

  @Post()
  create() {
    trail.push("CatsController.create");
    return { id: 2, name: "Felix" };
  }

  @Get("health")
  health() {
    trail.push("CatsController.health");
    return { ok: true };
  }
}

@Controller("dogs")
class DogsController {
  @Get()
  list() {
    trail.push("DogsController.list");
    return [{ id: 1, name: "Rex" }];
  }
}

/** Served at `/health`: excluded from the global prefix below. */
@Controller()
class RootController {
  @Get("health")
  health() {
    trail.push("RootController.health");
    return { status: "up" };
  }
}

@Module({ controllers: [CatsController, DogsController, RootController] })
class ShopModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Every route.
    consumer.apply(RequestIdMiddleware).forRoutes("*");

    // Every route of one controller, minus one.
    consumer
      .apply(timing)
      .exclude({ path: "cats/health", method: RequestMethod.GET })
      .forRoutes(CatsController);

    // A path and method each — `createMiddlewareFactory(RequestMethod.POST)`
    // and `createMiddlewareFactory(RequestMethod.ALL)` underneath.
    consumer
      .apply(auditWrites)
      .forRoutes(
        { path: "cats", method: RequestMethod.POST },
        { path: "dogs", method: RequestMethod.ALL },
      );
  }
}

title("Middleware and versioning on BunHttpAdapter");

/** Runs one request without a socket and prints what ran and what came back. */
async function run(
  adapter: BunHttpAdapter,
  label: string,
  path: string,
  init?: RequestInit,
) {
  trail.length = 0;
  const response = await adapter.fetch(path, init);
  const text = await response.text();
  show(label, {
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    trail: [...trail],
    body:
      text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text,
  });
}

/* ------------------------------------------------------------------ */
step("MiddlewareConsumer, app.use() and a global prefix");

const shopAdapter = new BunHttpAdapter();
const shop = await NestFactory.create(ShopModule, shopAdapter, {
  logger: false,
  abortOnError: false,
});
shop.setGlobalPrefix("api", {
  exclude: [{ path: "health", method: RequestMethod.GET }],
});
// `app.use()` goes straight to `adapter.use()`: Express-style, every method.
shop.use((req: BunRequest, _res: BunResponse, next: () => void) => {
  trail.push(`app.use(${req.method} ${req.path})`);
  next();
});
await shop.init();

await run(shopAdapter, "GET  /api/cats", "/api/cats");
await run(shopAdapter, "POST /api/cats", "/api/cats", { method: "POST" });
await run(
  shopAdapter,
  "GET  /api/cats/health (timing excluded)",
  "/api/cats/health",
);
await run(shopAdapter, "GET  /api/dogs", "/api/dogs", {
  headers: { "x-request-id": "from-the-client" },
});
await run(shopAdapter, "GET  /health (outside the prefix)", "/health");
await run(shopAdapter, "GET  /cats (no prefix: not found)", "/cats");

/* ------------------------------------------------------------------ */
step("createMiddlewareFactory directly: middleware for one method only");

const reports = new BunHttpAdapter();
const onlyGets: MiddlewareFactoryRespType = reports.createMiddlewareFactory(
  RequestMethod.GET,
);
onlyGets("/reports", (_req: BunRequest, res: BunResponse, next: () => void) => {
  res.setHeader("x-cache", "considered");
  next();
});
reports.all("/reports", (req, res) => {
  return res.json({ method: req.method, cache: res.getHeader("x-cache") });
});

show("GET  /reports", await (await reports.fetch("/reports")).json());
show(
  "POST /reports",
  await (await reports.fetch("/reports", { method: "POST" })).json(),
);

await shop.close();

/* ------------------------------------------------------------------ */
@Controller({ path: "products", version: "1" })
class ProductsV1Controller {
  @Get()
  list() {
    return { served: "v1", items: ["pen"] };
  }
}

@Controller({ path: "products", version: ["2", "3"] })
class ProductsV2Controller {
  @Get()
  list() {
    return { served: "v2|v3", items: [{ sku: "pen", price: 1.5 }] };
  }

  /** A method-level `@Version` narrows the controller's versions. */
  @Version("3")
  @Get("featured")
  featured() {
    return { served: "v3", featured: "pen" };
  }
}

/** Answers every version, and requests carrying none. */
@Controller({ path: "status", version: VERSION_NEUTRAL })
class StatusController {
  @Get()
  status() {
    return { served: "neutral", up: true };
  }
}

/** Declares no version, so it takes the app's `defaultVersion`. */
@Controller("orders")
class OrdersController {
  @Get()
  list() {
    return { served: "defaultVersion", orders: [] };
  }
}

@Module({
  controllers: [
    ProductsV1Controller,
    ProductsV2Controller,
    StatusController,
    OrdersController,
  ],
})
class CatalogModule {}

/** Builds and initialises one app with the given versioning; it never listens. */
async function versionedApp(versioning: VersioningOptions) {
  const adapter = new BunHttpAdapter();
  const app = await NestFactory.create(CatalogModule, adapter, {
    logger: false,
    abortOnError: false,
  });
  app.enableVersioning(versioning);
  await app.init();
  return { app, adapter };
}

/** Asks one versioned app for `path`, printing the status and body. */
async function ask(
  adapter: BunHttpAdapter,
  path: string,
  headers: Record<string, string> = {},
) {
  const response = await adapter.fetch(path, { headers });
  const text = await response.text();
  const label = `${path}${Object.keys(headers).length ? ` ${JSON.stringify(headers)}` : ""}`;
  show(label, {
    status: response.status,
    body: text ? JSON.parse(text) : "",
  });
}

step("VersioningType.URI — the version is part of the path");
{
  const { app, adapter } = await versionedApp({
    type: VersioningType.URI,
    defaultVersion: "1",
  });
  await ask(adapter, "/v1/products");
  await ask(adapter, "/v2/products");
  await ask(adapter, "/v3/products/featured");
  await ask(adapter, "/v2/products/featured");
  await ask(adapter, "/v4/products");
  await ask(adapter, "/status");
  await ask(adapter, "/v1/orders");
  await app.close();
}

step("VersioningType.HEADER — a custom request header");
{
  const { app, adapter } = await versionedApp({
    type: VersioningType.HEADER,
    header: "X-API-Version",
    defaultVersion: "1",
  });
  await ask(adapter, "/products", { "X-API-Version": "1" });
  await ask(adapter, "/products", { "X-API-Version": "3" });
  await ask(adapter, "/products/featured", { "X-API-Version": "3" });
  await ask(adapter, "/products", { "X-API-Version": "9" });
  await ask(adapter, "/products");
  await ask(adapter, "/status");
  await ask(adapter, "/orders", { "X-API-Version": "1" });
  await app.close();
}

step("VersioningType.MEDIA_TYPE — a parameter of the Accept header");
{
  const { app, adapter } = await versionedApp({
    type: VersioningType.MEDIA_TYPE,
    key: "v=",
  });
  await ask(adapter, "/products", { Accept: "application/json;v=1" });
  await ask(adapter, "/products", { Accept: "application/json;v=2" });
  await ask(adapter, "/products", { Accept: "application/json" });
  await ask(adapter, "/status", { Accept: "application/json" });
  await app.close();
}

step("VersioningType.CUSTOM — an extractor decides");
{
  const { app, adapter } = await versionedApp({
    type: VersioningType.CUSTOM,
    // A vendor media type, `application/vnd.shop.v2+json`. An extractor may
    // answer a single version or several, highest first.
    extractor: (request: unknown) => {
      const accept = (request as BunRequest).getHeader("accept") ?? "";
      const match = /application\/vnd\.shop\.v(\d+)\+json/.exec(accept);
      return match ? [match[1]] : [];
    },
  });
  await ask(adapter, "/products", { Accept: "application/vnd.shop.v1+json" });
  await ask(adapter, "/products", { Accept: "application/vnd.shop.v3+json" });
  await ask(adapter, "/products", { Accept: "text/html" });
  await ask(adapter, "/status", { Accept: "text/html" });
  await app.close();
}

/* ------------------------------------------------------------------ */
step("applyVersionFilter directly: a VersionedRoute on a plain adapter route");

const manual = new BunHttpAdapter();
const v2Only: VersionedRoute = manual.applyVersionFilter(
  (_req: BunRequest, res: BunResponse) => {
    return res.json({ via: "the v2 handler" });
  },
  "2",
  { type: VersioningType.HEADER, header: "X-API-Version" },
);
// On a mismatch the filter calls `next()`, reaching the next callback.
manual.get("/manual", v2Only, (_req, res) => {
  return res.json({ via: "the next callback" });
});

show(
  "X-API-Version: 2",
  await (
    await manual.fetch("/manual", { headers: { "X-API-Version": "2" } })
  ).json(),
);
show(
  "X-API-Version: 1",
  await (
    await manual.fetch("/manual", { headers: { "X-API-Version": "1" } })
  ).json(),
);
