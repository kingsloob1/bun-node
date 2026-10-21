/**
 * Which requests a Nest middleware runs for on `BunHttpAdapter`, asserted:
 * `MiddlewareConsumer.exclude()` matched as the router matches
 * (`getRouteMatchingOptions()`, read by Nest 12.2.0's core), and
 * `forRoutes("*")` under a global prefix, including the bare prefix and
 * `/api/`.
 *
 * ```bash
 * bun 02-http-adapter/middleware-matching.ts
 * ```
 *
 * Worth knowing:
 *
 * - The adapter's `getRouteMatchingOptions()` reports how its router
 *   matches: `{ caseSensitive, ignoreTrailingSlash: true }`, `caseSensitive`
 *   being the `router` option's (`false` by default, as on platform-express).
 * - Nest 12.2.0's core asks for it once per `forRoutes()` and compiles each
 *   `exclude()` path with it, so an exclusion skips the middleware on exactly
 *   the paths the excluded route serves. `exclude("users/login")` skips
 *   `/users/LOGIN` and `/users/login/`, as earlier cores did too; what
 *   12.2.0 changes is that with `router: { caseSensitive: true }` it no
 *   longer skips `/users/LOGIN`, which that router does not serve, and that
 *   `exclude("invoices/{*path}")` now runs the middleware on `/invoices/`,
 *   which the `invoices` route serves. An adapter that reports nothing gets
 *   exact matching on 12.2.0; the last check of that step shows what that
 *   would do.
 * - Earlier cores never ask. They match exclusions with path-to-regexp's
 *   defaults, on both adapters alike, which also skip `/users/LOGIN` and
 *   `/users/login/`, but skip `/invoices/` too, whatever the router's case.
 * - With a global prefix, `forRoutes("*")` runs the middleware for `/api`,
 *   `/api/` and everything under `/api`, once per request, on every Nest
 *   here. The core registers it at `/api$` (exactly `/api`) and at
 *   `/api/{*path}`. From 12.2.0 the core itself runs a middleware once per
 *   request when two of its paths match, so the adapter's `/api$` entry
 *   serves `/api/` too, as platform-express 12.2.0's does; on an earlier
 *   core it skips `/api/`, which the wildcard entry serves, so the
 *   middleware never runs twice. The last step shows that entry alone.
 * - Both 12.2.0 behaviours are gated on what the installed core does, never
 *   on a version string: `filterMiddleware` asking a stand-in adapter for
 *   its matching options, and `MiddlewareModule.prototype.registerHandler`
 *   running one middleware registered at two paths for one request, the
 *   probe the adapter itself makes. Where the core lacks them, the checks
 *   for the earlier behaviour run instead, and a line starting `skipped:`
 *   names the installed version.
 */
import type {
  BunRequest,
  BunResponse,
  BunRouterOptions,
} from "@kingsleyweb/bun-common";
import type { MiddlewareConsumer, NestModule } from "@nestjs/common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { Controller, Get, Module, RequestMethod } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MiddlewareModule } from "@nestjs/core/middleware/middleware-module.js";
import { filterMiddleware } from "@nestjs/core/middleware/utils.js";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { nestCoreVersion } from "../shared/nest";
import "reflect-metadata";

/** The installed `@nestjs/core`'s version. */
const NEST_VERSION = await nestCoreVersion();

/**
 * Whether the core reads an adapter's `getRouteMatchingOptions()` (12.2.0):
 * its `filterMiddleware` is handed a stand-in adapter that records the call.
 */
const CORE_READS_MATCHING_OPTIONS = (() => {
  let asked = false;
  const adapter = {
    getRouteMatchingOptions: () => {
      asked = true;
      return { caseSensitive: true, ignoreTrailingSlash: false };
    },
  };
  filterMiddleware([() => {}], [], adapter as never);
  return asked;
})();

/** A middleware as the core registers it. */
type Middleware = (req: object, res: object, next: () => void) => unknown;

/**
 * Whether the core runs a middleware once per request when two of its paths
 * match (12.2.0): its own `registerHandler`, with stand-ins, registers one
 * middleware at two paths, and one request goes through both.
 * @returns `true` when the middleware ran once.
 */
async function coreRunsMiddlewareOnce(): Promise<boolean> {
  const registerHandler = (
    MiddlewareModule.prototype as unknown as Record<
      string,
      (...args: unknown[]) => Promise<void>
    >
  ).registerHandler;
  const registered: Middleware[] = [];
  let runs = 0;
  await registerHandler.call(
    { routeInfoPathExtractor: { extractPathsFrom: () => ["/a", "/b"] } },
    {
      createMiddlewareFactory: () => (_path: string, h: Middleware) =>
        registered.push(h),
    },
    { path: "a", method: RequestMethod.ALL },
    (_req: object, _res: object, next: () => void) => {
      runs++;
      next();
    },
  );
  const req = {};
  for (const h of registered) await h(req, {}, () => {});
  return registered.length === 2 && runs === 1;
}

/** Whether the core runs a middleware once per request (12.2.0). */
const CORE_RUNS_ONCE = await coreRunsMiddlewareOnce();

/** The paths a middleware ran for, in order, since the last request began. */
const trail: string[] = [];

/** Records that it ran, and for which path. */
function mark(req: BunRequest, _res: BunResponse, next: () => void) {
  trail.push(req.path);
  next();
}

/* ------------------------------------------------------------------ */
@Controller("users")
class UsersController {
  @Get("login")
  login() {
    return { handler: "login" };
  }

  @Get("profile")
  profile() {
    return { handler: "profile" };
  }
}

@Controller("invoices")
class InvoicesController {
  @Get()
  list() {
    return { handler: "list" };
  }

  @Get(":id")
  one() {
    return { handler: "one" };
  }
}

/** `mark` on every route but `users/login` and the invoice items. */
@Module({ controllers: [UsersController, InvoicesController] })
class ExcludeModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(mark)
      .exclude("users/login", "invoices/{*path}")
      .forRoutes("*");
  }
}

@Controller()
class HelloController {
  @Get("hello")
  hello() {
    return { handler: "hello" };
  }
}

/** `mark` on every route, under the global prefix the step sets. */
@Module({ controllers: [HelloController] })
class PrefixModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(mark).forRoutes("*");
  }
}

/**
 * Reports exact matching, as Nest 12.2.0 assumes of an adapter that does not
 * say: what `exclude()` does without `BunHttpAdapter`'s report.
 */
class ExactMatchingAdapter extends BunHttpAdapter {
  override getRouteMatchingOptions() {
    return { caseSensitive: true, ignoreTrailingSlash: false };
  }
}

/* ------------------------------------------------------------------ */
/** Starts `module` on `adapter` (with a global prefix, if given); it never listens. */
async function start(
  module: typeof ExcludeModule | typeof PrefixModule,
  adapter: BunHttpAdapter,
  prefix?: string,
) {
  const app = await NestFactory.create(module, adapter, {
    logger: false,
    abortOnError: false,
  });
  if (prefix) app.setGlobalPrefix(prefix);
  await app.init();
  return app;
}

/**
 * Sends `GET` for each path through `adapter.fetch()`, and answers each one's
 * status and how many times `mark` ran for it, as `"<status> mw×<n>"`.
 */
async function runs(adapter: BunHttpAdapter, paths: string[]) {
  const answers: Record<string, string> = {};
  for (const path of paths) {
    trail.length = 0;
    const { status } = await adapter.fetch(path);
    answers[path] = `${status} mw×${trail.length}`;
  }
  return answers;
}

/** The requests the `exclude()` checks send. */
const EXCLUDE_PATHS = [
  "/users/login",
  "/users/login/",
  "/users/LOGIN",
  "/Users/Login/",
  "/users/login/x",
  "/users/profile",
  "/invoices",
  "/invoices/",
  "/invoices/7",
];

/** Where the gated steps' checks sat out, printed at the end. */
const skippedLines: string[] = [];

/* ------------------------------------------------------------------ */
title("Middleware matching: exclude() and forRoutes('*') under a prefix");
show("@nestjs/core", NEST_VERSION);

step("What the adapter reports, and which core reads it");

checkEqual(
  "getRouteMatchingOptions(): case-insensitive by default, a trailing slash ignored",
  new BunHttpAdapter().getRouteMatchingOptions(),
  { caseSensitive: false, ignoreTrailingSlash: true },
);
checkEqual(
  "…and case-sensitive with router: { caseSensitive: true }",
  new BunHttpAdapter(0, {
    router: { caseSensitive: true },
  }).getRouteMatchingOptions(),
  { caseSensitive: true, ignoreTrailingSlash: true },
);
checkEqual(
  "the core reads it, and runs a middleware once per request, from Nest 12.2.0",
  { readsOptions: CORE_READS_MATCHING_OPTIONS, runsOnce: CORE_RUNS_ONCE },
  {
    readsOptions: Bun.semver.satisfies(NEST_VERSION, ">=12.2.0"),
    runsOnce: Bun.semver.satisfies(NEST_VERSION, ">=12.2.0"),
  },
);

/* ------------------------------------------------------------------ */
step('exclude("users/login", "invoices/{*path}") with forRoutes("*")');

/** Each path's answer, by router options; filled below. */
const excludeRuns = new Map<string, Record<string, string>>();
for (const [name, router] of [
  ["default", undefined],
  ["caseSensitive", { caseSensitive: true }],
] as [string, BunRouterOptions | undefined][]) {
  const adapter = new BunHttpAdapter(0, router ? { router } : undefined);
  const app = await start(ExcludeModule, adapter);
  excludeRuns.set(name, await runs(adapter, EXCLUDE_PATHS));
  await app.close();
}
const lenient = excludeRuns.get("default") ?? {};
const strict = excludeRuns.get("caseSensitive") ?? {};
show("default router", lenient);

checkEqual(
  "every Nest: exclude('users/login') skips /users/login, /users/login/, /users/LOGIN and /Users/Login/; not /users/login/x",
  Object.fromEntries(EXCLUDE_PATHS.slice(0, 6).map((p) => [p, lenient[p]])),
  {
    "/users/login": "200 mw×0",
    "/users/login/": "200 mw×0",
    "/users/LOGIN": "200 mw×0",
    "/Users/Login/": "200 mw×0",
    "/users/login/x": "404 mw×1",
    "/users/profile": "200 mw×1",
  },
);
checkEqual(
  "every Nest: exclude('invoices/{*path}') skips /invoices/7, not /invoices",
  [lenient["/invoices"], lenient["/invoices/7"]],
  ["200 mw×1", "200 mw×0"],
);

if (CORE_READS_MATCHING_OPTIONS) {
  checkEqual(
    "12.2.0: /invoices/ is the invoices route's, so the middleware runs there",
    lenient["/invoices/"],
    "200 mw×1",
  );
  show("router: { caseSensitive: true }", strict);
  checkEqual(
    "12.2.0, router: { caseSensitive: true }: /users/LOGIN is not the route's (404), so the middleware runs",
    [strict["/users/login/"], strict["/users/LOGIN"], strict["/Users/Login/"]],
    ["200 mw×0", "404 mw×1", "404 mw×1"],
  );

  const exact = new ExactMatchingAdapter();
  const exactApp = await start(ExcludeModule, exact);
  const exactRuns = await runs(exact, [
    "/users/login",
    "/users/login/",
    "/users/LOGIN",
  ]);
  await exactApp.close();
  checkEqual(
    "12.2.0 with an adapter reporting exact matching: only /users/login is skipped, though the route serves all three",
    exactRuns,
    {
      "/users/login": "200 mw×0",
      "/users/login/": "200 mw×1",
      "/users/LOGIN": "200 mw×1",
    },
  );
} else {
  checkEqual(
    "before 12.2.0, Nest's own matching also skips /invoices/",
    lenient["/invoices/"],
    "200 mw×0",
  );
  checkEqual(
    "before 12.2.0, router: { caseSensitive: true } changes no exclusion: /users/LOGIN (a 404) is skipped too",
    [strict["/users/login/"], strict["/users/LOGIN"], strict["/Users/Login/"]],
    ["200 mw×0", "404 mw×0", "404 mw×0"],
  );
  skippedLines.push(
    `skipped: the core does not read getRouteMatchingOptions() before Nest 12.2.0; 3 exclude() checks skipped on Nest ${NEST_VERSION}`,
  );
}

/* ------------------------------------------------------------------ */
step('forRoutes("*") under app.setGlobalPrefix("api")');

{
  const adapter = new BunHttpAdapter();
  const app = await start(PrefixModule, adapter, "api");
  const answers = await runs(adapter, [
    "/api",
    "/api/",
    "/api/hello",
    "/api/hello/",
    "/api/nope",
    "/hello",
  ]);
  await app.close();
  show("answers", answers);
  checkEqual(
    "every Nest: the middleware runs once for /api, /api/ and every path under it; never outside the prefix",
    answers,
    {
      "/api": "404 mw×1",
      "/api/": "404 mw×1",
      "/api/hello": "200 mw×1",
      "/api/hello/": "200 mw×1",
      "/api/nope": "404 mw×1",
      "/hello": "404 mw×0",
    },
  );
}

/* ------------------------------------------------------------------ */
step("The core's exact entry, /api$, on its own");

{
  // What the core registers beside `/api/{*path}` for `forRoutes("*")`.
  const adapter = new BunHttpAdapter();
  adapter.createMiddlewareFactory(RequestMethod.ALL)("/api$", mark);
  adapter.get("/api", (_req, res) => res.send("api"));
  const answers = await runs(adapter, ["/api", "/api/", "/api/x", "/apix"]);
  show("answers", answers);
  checkEqual(
    "/api$ matches /api exactly, never a path below it",
    [answers["/api"], answers["/api/x"], answers["/apix"]],
    ["200 mw×1", "404 mw×0", "404 mw×0"],
  );
  if (CORE_RUNS_ONCE) {
    check(
      "12.2.0: the core runs a middleware once per request, so /api$ serves /api/ too",
      answers["/api/"] === "200 mw×1",
      answers,
    );
  } else {
    check(
      "before 12.2.0: /api$ skips /api/, which the wildcard entry beside it serves",
      answers["/api/"] === "200 mw×0",
      answers,
    );
    skippedLines.push(
      `skipped: the core does not run a middleware once per request before Nest 12.2.0; 1 /api$ check skipped on Nest ${NEST_VERSION}`,
    );
  }
}

for (const line of skippedLines) show(line);
summary();
