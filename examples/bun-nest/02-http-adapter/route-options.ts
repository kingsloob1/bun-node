/**
 * Nest 12's two route options on `BunHttpAdapter`, asserted:
 * `routeResolutionStrategy`, the order the routes are registered in, and
 * `routeConflictPolicy`, what happens when two routes overlap. Both are
 * `NestFactory.create()` options, not adapter options.
 *
 * ```bash
 * bun 02-http-adapter/route-options.ts
 * ```
 *
 * Worth knowing:
 *
 * - The core does the work (`NestApplication.registerRouter`): it sorts the
 *   routes and detects conflicts before any route reaches the adapter. The
 *   adapter's part is `isRouteOrderSensitive()`, which returns `true`, as
 *   `@nestjs/platform-express`'s does: the first route registered for a
 *   request wins, so the order Nest registers them in decides.
 * - `routeResolutionStrategy: "declaration"` (the default) registers the
 *   routes as declared. `@Get(":id")` declared before `@Get("me")` takes
 *   `/users/me`, as on Express.
 * - `"specificity"` registers a literal segment before a parameter before a
 *   wildcard, segment by segment, so `/users/me` reaches `me` and
 *   `/files/readme` reaches `readme` before `*path`. Ties keep declaration
 *   order: Nest ranks paths only, so an `@All()` declared before an `@Get()`
 *   on the same path still takes `GET`.
 * - bun-common's `router: { routeSpecificity: true }` is a different ranking:
 *   it also prefers a route's own method to `@All()`. Use Nest's option on
 *   Nest 12 (the package README's known differences).
 * - `routeConflictPolicy` is `{ duplicate, shadow }`, each `"off"` (the
 *   default), `"warn"` or `"error"`. A *duplicate* is the same method and
 *   path registered twice; a *shadow* is a pattern that can take another's
 *   requests (`/users/:id` before `/users/me`). `"warn"` logs one warning per
 *   conflict through Nest's logger and the app starts, the first route
 *   winning. `"error"` makes `app.init()` reject with one
 *   `RouteConflictException` listing every conflict at that level.
 * - Under `"specificity"`, a shadow the sort has resolved is not reported,
 *   so `shadow: "error"` starts an app whose literal route was declared last.
 * - Nest 11 has neither option, and ignores both. This example reads the
 *   capability, `ApplicationConfig.prototype.setRouteResolutionStrategy`
 *   (Nest 12.0.0), never a version string. On Nest 11 it checks that the
 *   options change nothing, and says on a line starting `skipped:`, naming
 *   the installed version, which checks sat out.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import type {
  LoggerService,
  NestApplicationOptions,
  Type,
} from "@nestjs/common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { All, Controller, Get, Module, Param, Req } from "@nestjs/common";
import { ApplicationConfig, NestFactory } from "@nestjs/core";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { nestCoreVersion } from "../shared/nest";
import "reflect-metadata";

/** The installed `@nestjs/core`'s version. */
const NEST_VERSION = await nestCoreVersion();

/**
 * Whether this Nest has the route options: Nest 12's `ApplicationConfig`
 * stores them. The gate for every check that needs them.
 */
const HAS_ROUTE_OPTIONS =
  typeof (
    ApplicationConfig.prototype as { setRouteResolutionStrategy?: unknown }
  ).setRouteResolutionStrategy === "function";

/**
 * The two options, typed here so this file reads the same on Nest 11, whose
 * `NestApplicationOptions` lacks them.
 */
interface RouteOptions {
  /** Nest 12's `routeResolutionStrategy`. */
  routeResolutionStrategy?: "declaration" | "specificity";
  /** Nest 12's `routeConflictPolicy`. */
  routeConflictPolicy?: {
    /** The same method and path registered twice. */
    duplicate?: "off" | "warn" | "error";
    /** A pattern that can take another route's requests. */
    shadow?: "off" | "warn" | "error";
  };
}

/* ------------------------------------------------------------------ */
/** `/users/:id` declared before `/users/me`: a shadow. */
@Controller("users")
class UsersController {
  @Get(":id")
  byId(@Param("id") id: string) {
    return { handler: "byId", id };
  }

  @Get("me")
  me() {
    return { handler: "me" };
  }
}

/** A named wildcard declared before a literal. */
@Controller("files")
class FilesController {
  @Get("*path")
  any(@Param("path") path: string[]) {
    return { handler: "any", path };
  }

  @Get("readme")
  readme() {
    return { handler: "readme" };
  }
}

/** `@All()` declared before `@Get()` on the same path: a tie for Nest. */
@Controller("ag")
class AllFirstController {
  @All()
  all(@Req() req: BunRequest) {
    return { handler: "all", method: req.method };
  }

  @Get()
  get() {
    return { handler: "get" };
  }
}

@Module({ controllers: [UsersController, FilesController, AllFirstController] })
class RoutesModule {}

/** One half of a duplicate: `GET /dup`, declared first. */
@Controller("dup")
class FirstDupController {
  @Get()
  first() {
    return { handler: "FirstDupController#first" };
  }
}

/** The other half: `GET /dup` again, declared second. */
@Controller("dup")
class SecondDupController {
  @Get()
  second() {
    return { handler: "SecondDupController#second" };
  }
}

@Module({ controllers: [FirstDupController, SecondDupController] })
class DuplicateModule {}

@Module({ controllers: [UsersController] })
class ShadowModule {}

@Module({
  controllers: [FirstDupController, SecondDupController, UsersController],
})
class BothConflictsModule {}

/* ------------------------------------------------------------------ */
/** A started application, its adapter and the warnings Nest logged. */
interface Booted {
  /** The adapter, asked through `fetch()`. */
  adapter: BunHttpAdapter;
  /** Every `warn()` Nest logged while starting. */
  warnings: string[];
  /** Closes the application. */
  close: () => Promise<void>;
}

/**
 * Starts `module` on a new adapter with Nest's route `options`, collecting
 * what Nest warns. Rejects when `app.init()` does.
 */
async function boot(
  module: Type,
  options: RouteOptions = {},
  adapterOptions?: ConstructorParameters<typeof BunHttpAdapter>[1],
): Promise<Booted> {
  const warnings: string[] = [];
  const logger: LoggerService = {
    log: () => {},
    error: () => {},
    warn: (message: unknown) => warnings.push(String(message)),
  };
  const adapter = new BunHttpAdapter(0, adapterOptions);
  const app = await NestFactory.create(module, adapter, {
    logger,
    abortOnError: false,
    ...(options as NestApplicationOptions),
  });
  try {
    await app.init();
  } catch (error) {
    await app.close();
    throw error;
  }
  return { adapter, warnings, close: () => app.close() };
}

/** What `GET path` (or another method) answers: the status and the JSON body. */
async function ask(adapter: BunHttpAdapter, path: string, method = "GET") {
  const response = await adapter.fetch(path, { method });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as unknown) : null,
  };
}

/** Which handler served each `[method, path]`, as `"<status> <handler>[ <param>]"`. */
async function served(adapter: BunHttpAdapter, requests: [string, string][]) {
  const answers: Record<string, string> = {};
  for (const [method, path] of requests) {
    const { status, body } = await ask(adapter, path, method);
    const {
      handler,
      id,
      path: rest,
    } = (body ?? {}) as {
      handler?: string;
      id?: string;
      path?: string[];
    };
    answers[`${method} ${path}`] = [
      status,
      handler ?? "-",
      ...(id === undefined ? [] : [id]),
      ...(rest === undefined ? [] : [rest.join("/")]),
    ].join(" ");
  }
  return answers;
}

/** The requests every resolution check sends. */
const ROUTE_REQUESTS: [string, string][] = [
  ["GET", "/users/me"],
  ["GET", "/users/42"],
  ["GET", "/files/readme"],
  ["GET", "/files/a/b"],
  ["GET", "/ag"],
  ["POST", "/ag"],
];

/** What each request reaches with the routes registered as declared. */
const IN_DECLARATION_ORDER = {
  "GET /users/me": "200 byId me",
  "GET /users/42": "200 byId 42",
  "GET /files/readme": "200 any readme",
  "GET /files/a/b": "200 any a/b",
  "GET /ag": "200 all",
  "POST /ag": "200 all",
};

/* ------------------------------------------------------------------ */
title("Nest 12's routeResolutionStrategy and routeConflictPolicy");
show("@nestjs/core", NEST_VERSION);

step("Which Nest has the options");

checkEqual(
  "ApplicationConfig stores the route options from Nest 12.0.0",
  HAS_ROUTE_OPTIONS,
  Bun.semver.satisfies(NEST_VERSION, ">=12.0.0"),
);
check(
  "the adapter is order-sensitive, as platform-express is: Nest sorts for it",
  new BunHttpAdapter().isRouteOrderSensitive(),
);

/* ------------------------------------------------------------------ */
step('routeResolutionStrategy: "declaration", the default');

{
  const app = await boot(RoutesModule);
  const answers = await served(app.adapter, ROUTE_REQUESTS);
  show("no option", answers);
  checkEqual(
    "without the option the first declared route wins: :id takes /users/me, *path takes /files/readme",
    answers,
    IN_DECLARATION_ORDER,
  );
  await app.close();
}

/** How many checks the Nest 12 steps hold, for the skip line. */
const GATED_CHECKS = 16;

if (!HAS_ROUTE_OPTIONS) {
  step("Nest 11: the options are ignored");

  const sorted = await boot(RoutesModule, {
    routeResolutionStrategy: "specificity",
  });
  checkEqual(
    'routeResolutionStrategy: "specificity" changes nothing on Nest 11',
    await served(sorted.adapter, ROUTE_REQUESTS),
    IN_DECLARATION_ORDER,
  );
  await sorted.close();

  const strict = await boot(BothConflictsModule, {
    routeConflictPolicy: { duplicate: "error", shadow: "error" },
  });
  checkEqual(
    'routeConflictPolicy "error" starts the app on Nest 11, warning nothing, the first route winning',
    {
      warnings: strict.warnings,
      ...(await served(strict.adapter, [
        ["GET", "/dup"],
        ["GET", "/users/me"],
      ])),
    },
    {
      warnings: [],
      "GET /dup": "200 FirstDupController#first",
      "GET /users/me": "200 byId me",
    },
  );
  await strict.close();

  show(
    `skipped: Nest < 12.0.0 has no routeResolutionStrategy or routeConflictPolicy; ${GATED_CHECKS} checks skipped on Nest ${NEST_VERSION}`,
  );
} else {
  // Nest 12 only: the file does not exist on 11. Its `name` is "Error", so
  // the checks below test the class.
  const { RouteConflictException } =
    await import("@nestjs/core/errors/exceptions/route-conflict.exception.js");

  {
    const app = await boot(RoutesModule, {
      routeResolutionStrategy: "declaration",
    });
    checkEqual(
      '"declaration" given explicitly is the default',
      await served(app.adapter, ROUTE_REQUESTS),
      IN_DECLARATION_ORDER,
    );
    await app.close();
  }

  /* ---------------------------------------------------------------- */
  step('routeResolutionStrategy: "specificity"');

  {
    const app = await boot(RoutesModule, {
      routeResolutionStrategy: "specificity",
    });
    const answers = await served(app.adapter, ROUTE_REQUESTS);
    show('"specificity"', answers);
    checkEqual(
      "literal before parameter before wildcard; a tie (@All, @Get) keeps declaration order",
      answers,
      {
        "GET /users/me": "200 me",
        "GET /users/42": "200 byId 42",
        "GET /files/readme": "200 readme",
        "GET /files/a/b": "200 any a/b",
        "GET /ag": "200 all",
        "POST /ag": "200 all",
      },
    );
    await app.close();
  }

  {
    // bun-common's own ranking, with Nest's default order: it puts the literal
    // first too, and also prefers a route's own method to `@All()`.
    const app = await boot(
      RoutesModule,
      {},
      { router: { routeSpecificity: true } },
    );
    const answers = await served(app.adapter, [
      ["GET", "/users/me"],
      ["GET", "/ag"],
    ]);
    checkEqual(
      "router: { routeSpecificity: true } is another ranking: GET /ag reaches @Get(), not the @All() declared first",
      answers,
      { "GET /users/me": "200 me", "GET /ag": "200 get" },
    );
    await app.close();
  }

  /* ---------------------------------------------------------------- */
  step("routeConflictPolicy: duplicate");

  for (const policy of [
    undefined,
    { duplicate: "off", shadow: "off" },
  ] as const) {
    const app = await boot(DuplicateModule, { routeConflictPolicy: policy });
    checkEqual(
      `${policy ? 'duplicate and shadow "off"' : "no policy"}: nothing is reported, the first GET /dup wins`,
      {
        warnings: app.warnings,
        ...(await served(app.adapter, [["GET", "/dup"]])),
      },
      { warnings: [], "GET /dup": "200 FirstDupController#first" },
    );
    await app.close();
  }

  /** What Nest says about the duplicate. */
  const DUPLICATE =
    "Duplicate route: GET /dup is registered by both FirstDupController#first and SecondDupController#second.";

  {
    const app = await boot(DuplicateModule, {
      routeConflictPolicy: { duplicate: "warn" },
    });
    show('duplicate: "warn"', app.warnings);
    checkEqual(
      'duplicate: "warn" logs one warning and starts; the first declared route wins',
      {
        warnings: app.warnings,
        ...(await served(app.adapter, [["GET", "/dup"]])),
      },
      { warnings: [DUPLICATE], "GET /dup": "200 FirstDupController#first" },
    );
    await app.close();
  }

  {
    const app = await boot(DuplicateModule, {
      routeConflictPolicy: { shadow: "error" },
    });
    checkEqual(
      'shadow: "error" leaves a duplicate alone: the two kinds are separate',
      app.warnings,
      [],
    );
    await app.close();
  }

  const duplicateError = await checkRejects(
    'duplicate: "error" makes app.init() reject',
    () =>
      boot(DuplicateModule, { routeConflictPolicy: { duplicate: "error" } }),
    { message: /Duplicate route: GET \/dup/ },
  );
  check(
    "…with a RouteConflictException",
    duplicateError instanceof RouteConflictException,
    duplicateError,
  );
  show("its message", duplicateError?.message);

  /* ---------------------------------------------------------------- */
  step("routeConflictPolicy: shadow");

  /** What Nest says about `/users/:id` taking `/users/me`. */
  const SHADOW =
    "Route GET /users/me (UsersController#me) is shadowed by GET /users/:id (UsersController#byId). The first-registered route will match all matching requests on order-sensitive adapters.";

  {
    const app = await boot(ShadowModule, {
      routeConflictPolicy: { shadow: "warn" },
    });
    show('shadow: "warn"', app.warnings);
    checkEqual(
      'shadow: "warn" logs it and starts; /users/:id still takes /users/me',
      {
        warnings: app.warnings,
        ...(await served(app.adapter, [["GET", "/users/me"]])),
      },
      { warnings: [SHADOW], "GET /users/me": "200 byId me" },
    );
    await app.close();
  }

  {
    const app = await boot(ShadowModule, {
      routeConflictPolicy: { duplicate: "error" },
    });
    checkEqual('duplicate: "error" leaves a shadow alone', app.warnings, []);
    await app.close();
  }

  const shadowError = await checkRejects(
    'shadow: "error" makes app.init() reject',
    () => boot(ShadowModule, { routeConflictPolicy: { shadow: "error" } }),
    { message: /is shadowed by GET \/users\/:id/ },
  );
  check(
    "…with a RouteConflictException",
    shadowError instanceof RouteConflictException,
    shadowError,
  );

  {
    const app = await boot(ShadowModule, {
      routeResolutionStrategy: "specificity",
      routeConflictPolicy: { shadow: "error" },
    });
    checkEqual(
      'with "specificity", a shadow the sort resolved is not one: shadow: "error" starts, and /users/me reaches me',
      {
        warnings: app.warnings,
        ...(await served(app.adapter, [["GET", "/users/me"]])),
      },
      { warnings: [], "GET /users/me": "200 me" },
    );
    await app.close();
  }

  const both = await checkRejects(
    'every conflict at "error" is listed in the one RouteConflictException',
    () =>
      boot(BothConflictsModule, {
        routeConflictPolicy: { duplicate: "error", shadow: "error" },
      }),
  );
  checkEqual(
    "…one line per conflict, under Nest's heading",
    both?.message.split("\n").slice(0, 3),
    ["Conflicting HTTP routes detected:", `  - ${DUPLICATE}`, `  - ${SHADOW}`],
  );
}

summary();
