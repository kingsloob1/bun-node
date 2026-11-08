/**
 * Throttling a Nest application on bun-nest, asserted: `BunThrottlerModule`
 * and `BunThrottlerGuard` (`@nestjs/throttler` 6's API over bun-common's
 * `throttle()`), and the adapter's `throttle` option in front of Nest.
 *
 * ```bash
 * cd examples/bun-nest && bun 14-throttle/throttling.ts
 * ```
 *
 * What it shows, on a served application (so the default tracker sees a
 * real address, `127.0.0.1`):
 *
 * - a generous **default throttler per route per client** (600 a minute in
 *   production; 5 here, to see it trip), with `@nestjs/throttler`'s
 *   `X-RateLimit-*` headers (`headers: "legacy"`) and its `429` body;
 * - **a sign-in route with two limits**, declared by `@Throttle()`: one keyed
 *   on address and account (against guessing one account's password), one
 *   on the address alone (against spraying many accounts);
 * - **a route that replaces the default**: `@SkipThrottle()` plus a strict
 *   throttler of its own;
 * - **a service exemption**: a `skipIf` on the default throttler only, so a
 *   trusted service is not counted by it while the strict routes still are;
 * - `@SkipThrottle()` on a health check;
 * - **the adapter's `throttle` option**, which runs before Nest and counts
 *   404s too;
 * - **one store for two applications** (two instances behind a balancer):
 *   `cacheThrottleStore(cache)` from `@kingsleyweb/bun-nest/cache`, on a
 *   memory cache here, on a Redis or SQL cache in production;
 * - **the startup checks**: a bare-number `ttl` refused, and the module's
 *   boot check logging when no guard is installed.
 *
 * Worth knowing:
 *
 * - `ttl` is a duration (`"1m"`, `seconds(60)`, `{ minutes: 1 }`), never a
 *   bare number: `@nestjs/throttler` reads `ttl: 60` as 60 ms, which turns
 *   throttling off. `seconds()`/`minutes()` answer duration objects here.
 * - `@SkipThrottle()` with no argument skips the throttler named `default`
 *   only, as in `@nestjs/throttler`.
 * - A refused request still counts (bun-common's count-then-check), so a
 *   client that keeps hammering stays refused until it slows down.
 * - Method decorators are written with `@`, which needs the working
 *   directory's `tsconfig.json` (Bun reads the decorator options from it,
 *   oven-sh/bun#28605): run this from `examples/bun-nest`.
 *
 * Each check below is asserted with `shared/check.ts`; a failed one fails the
 * script.
 */
import type { BunRequest, ThrottleStore } from "@kingsleyweb/bun-common";
import type {
  ExecutionContext,
  INestApplication,
  LoggerService,
} from "@nestjs/common";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { memoryThrottleStore } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunThrottlerGuard,
  BunThrottlerModule,
  minutes,
  seconds,
  SkipThrottle,
  Throttle,
} from "@kingsleyweb/bun-nest";
import { cacheThrottleStore } from "@kingsleyweb/bun-nest/cache";
import { Body, Controller, Get, Module, Post } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

/** The token a sibling service sends; a request carrying it is that service calling. */
const SERVICE_TOKEN = "service-secret";

/** Whether the request is a trusted service's call (a constant-time compare in production). */
function isService(context: ExecutionContext): boolean {
  const req = context.switchToHttp().getRequest<BunRequest>();
  return req.headers["x-api-token"] === SERVICE_TOKEN;
}

/** Who a sign-in counts against under the per-account limit: address and account. */
function addressAndAccount(req: BunRequest): string {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  const account = typeof email === "string" ? email.toLowerCase() : "";
  return `${req.ip ?? "unknown"}|${account}`;
}

@Controller()
class AppController {
  /** Only the default throttler. */
  @Get("items")
  items() {
    return ["a", "b"];
  }

  /** Never throttled. */
  @SkipThrottle()
  @Get("health")
  health() {
    return "ok";
  }
}

@Controller("auth")
class AuthController {
  /**
   * Two limits beside the default: 2 a minute per address and account, 4 a
   * minute per address. Neither name is a module throttler, so
   * `@Throttle()` declares them here (both need `limit` and `ttl`).
   */
  @Throttle({
    account: { limit: 2, ttl: minutes(1), getTracker: addressAndAccount },
    address: { limit: 4, ttl: "1m" },
  })
  @Post("sign-in")
  signIn(@Body() body: { email?: string }) {
    return { signedIn: body.email ?? null };
  }

  /** The default replaced: skipped, and a strict throttler declared instead. */
  @SkipThrottle()
  @Throttle({ strict: { limit: 2, ttl: seconds(60) } })
  @Post("verify-code")
  verify() {
    return { verified: true };
  }
}

/** The application's module, over a store given by the caller. */
function appModule(store: ThrottleStore) {
  @Module({
    imports: [
      BunThrottlerModule.forRoot({
        throttlers: [
          // 600 a minute in production; 5 here, to see it trip. A trusted
          // service is not counted by this throttler (its skipIf), but the
          // strict ones still count it: it may proxy a user's sign-in.
          { limit: 5, ttl: "1m", skipIf: isService },
        ],
        store,
        headers: "legacy",
        logLimited: "warn",
      }),
    ],
    controllers: [AppController, AuthController],
    providers: [{ provide: APP_GUARD, useClass: BunThrottlerGuard }],
  })
  class AppModule {}
  return AppModule;
}

/** Log lines Nest's loggers wrote, by level, so the example can read them. */
const logged: { level: string; message: string }[] = [];
const captureLogger: LoggerService = {
  log: (message: unknown) =>
    logged.push({ level: "log", message: String(message) }),
  error: (message: unknown) =>
    logged.push({ level: "error", message: String(message) }),
  warn: (message: unknown) =>
    logged.push({ level: "warn", message: String(message) }),
};

title("Throttling with BunThrottlerModule and the adapter's throttle option");

// Two instances of one application sharing one store, as two processes
// behind a balancer would share a Redis cache.
const cache = createCache({ driver: memoryDriver() });
const store = cacheThrottleStore(cache);
const apps: INestApplication[] = [];
const bases: string[] = [];
for (let i = 0; i < 2; i++) {
  const app = await NestFactory.create(
    appModule(store),
    new BunHttpAdapter(0),
    {
      logger: captureLogger,
    },
  );
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  bases.push(await app.getUrl());
}
const [base, otherBase] = bases;
show("listening on", bases);

/** A request to the first instance (or `at`), answering status, headers and body. */
async function call(path: string, init: RequestInit = {}, at = base) {
  const response = await fetch(`${at}${path}`, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status, headers: response.headers, body };
}

/** A sign-in attempt for `email`, as JSON. */
const signIn = (email: string, headers: Record<string, string> = {}) =>
  call("/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ email }),
  });

step("the default throttler: 5 a minute per route per client, legacy headers");
const statuses: number[] = [];
let last = await call("/items");
statuses.push(last.status);
checkEqual("X-RateLimit-Limit", last.headers.get("x-ratelimit-limit"), "5");
checkEqual(
  "X-RateLimit-Remaining",
  last.headers.get("x-ratelimit-remaining"),
  "4",
);
for (let i = 0; i < 5; i++) {
  last = await call("/items");
  statuses.push(last.status);
}
show("six GET /items", statuses);
checkEqual("the sixth is refused", statuses, [200, 200, 200, 200, 200, 429]);
checkEqual("@nestjs/throttler's 429 body", last.body, {
  statusCode: 429,
  message: "ThrottlerException: Too Many Requests",
});
check(
  "Retry-After on the 429",
  /^\d+$/.test(last.headers.get("retry-after") ?? ""),
  {
    retryAfter: last.headers.get("retry-after"),
  },
);
check(
  "the refusal was logged naming the route and limit, not the address",
  logged.some(
    (line) =>
      line.level === "warn" &&
      line.message.includes('AppController.items: throttler "default"') &&
      !line.message.includes("127.0.0.1"),
  ),
  logged,
);
checkEqual(
  "another route has its own count",
  (await call("/health")).status,
  200,
);

step("the other instance shares the store, so the count holds across both");
checkEqual(
  "GET /items on the second instance is refused too",
  (await call("/items", {}, otherBase)).status,
  429,
);

step("a service token skips the default throttler only");
const service = { "x-api-token": SERVICE_TOKEN };
checkEqual(
  "the service's GET /items passes though the client is over the limit",
  (await call("/items", { headers: service })).status,
  200,
);
const verify = [];
for (let i = 0; i < 3; i++) {
  verify.push(
    (await call("/auth/verify-code", { method: "POST", headers: service }))
      .status,
  );
}
show("three POST /auth/verify-code from the service", verify);
checkEqual(
  "the strict route still counts the service",
  verify,
  [201, 201, 429],
);

step("sign-in: 2 per address and account, 4 per address");
const attempts: [string, number][] = [];
for (const email of [
  "ann@x.test",
  "ann@x.test",
  "ann@x.test",
  "bob@x.test",
  "eve@x.test",
]) {
  attempts.push([email, (await signIn(email)).status]);
}
show("sign-in attempts from one address", attempts);
checkEqual(
  "ann's third is refused (account), bob still gets in, eve is refused (address)",
  attempts,
  [
    ["ann@x.test", 201],
    ["ann@x.test", 201],
    ["ann@x.test", 429],
    ["bob@x.test", 201],
    ["eve@x.test", 429],
  ],
);
const refused = await signIn("eve@x.test");
checkEqual(
  "the refusing throttlers' own Retry-After headers",
  [
    refused.headers.get("retry-after-address") !== null,
    refused.headers.get("x-ratelimit-limit-account"),
  ],
  [true, "2"],
);

for (const app of apps) await app.close();
await cache.close();

step("the adapter's throttle option: before Nest, 404s included");
const front = new BunHttpAdapter(0, { throttle: { limit: 3, window: "1m" } });
const frontApp = await NestFactory.create(
  appModule(memoryThrottleStore()),
  front,
  {
    logger: false,
  },
);
await frontApp.init();
const front404 = [
  (await front.fetch("/nope")).status,
  (await front.fetch("/nope")).status,
  (await front.fetch("/health")).status,
  (await front.fetch("/health")).status,
];
show("two 404s, then GET /health twice", front404);
checkEqual(
  "the 404s used the budget; @SkipThrottle() does not reach it",
  front404,
  [404, 404, 200, 429],
);
const problem = await front.fetch("/health");
checkEqual(
  "bun-common's problem document, not Nest's body",
  problem.headers.get("content-type"),
  "application/problem+json",
);
await frontApp.close();

step("startup checks");
await checkRejects(
  "a bare-number ttl fails the boot",
  async () => {
    @Module({
      imports: [
        BunThrottlerModule.forRoot({
          // What `THROTTLE_TTL=60` read with Number() gives: 60 ms or 60 s?
          throttlers: [{ limit: 600, ttl: Number("60") as unknown as "1m" }],
        }),
      ],
    })
    class BareModule {}
    const app = await NestFactory.create(BareModule, new BunHttpAdapter(0), {
      logger: false,
      abortOnError: false,
    });
    await app.close();
  },
  { message: /bare number is ambiguous/ },
);
logged.length = 0;
{
  @Module({
    imports: [BunThrottlerModule.forRoot([{ limit: 600, ttl: "1m" }])],
    controllers: [AppController],
    // No BunThrottlerGuard: the module alone throttles nothing.
  })
  class ForgotTheGuard {}
  const app = await NestFactory.create(ForgotTheGuard, new BunHttpAdapter(0), {
    logger: captureLogger,
  });
  await app.init();
  check(
    "the boot check logs that no guard is installed",
    logged.some(
      (line) =>
        line.level === "error" &&
        line.message.includes("no BunThrottlerGuard is installed"),
    ),
    logged,
  );
  await app.close();
}

summary();
