/**
 * Counting only what should count, in a Nest application:
 * `skipSuccessfulRequests`, `skipFailedRequests` and `requestWasSuccessful`
 * on `BunThrottlerModule`, its throttlers and `@Throttle()` (express-rate-
 * limit's options, through bun-common's `throttle()`; `@nestjs/throttler`
 * has neither), and a `limit` that depends on the request.
 *
 * ```bash
 * cd examples/bun-nest && bun 14-throttle/refunds.ts
 * ```
 *
 * - **A sign-in that counts failed attempts only**:
 *   `@Throttle({ default: { skipSuccessfulRequests: true,
 *   skipFailedRequests: false } })` on the route, over the module's flags.
 *   A request counts while it runs; once Nest has answered, a success is
 *   given back. Good sign-ins never run out; the third bad one in a row is
 *   the last allowed, and the refusal holds for the right password too.
 * - **An export that counts what worked**: the module's
 *   `skipFailedRequests: true`. An exception Nest answered with a `5xx` is
 *   given back, and so is the `429` of a refusal.
 * - **`requestWasSuccessful`**: the module's rule for both options. Here a
 *   `404` is a success too: a lookup that found nothing counts, rather than
 *   being given back as a failure.
 * - **A limit per account**: `limit: (context) => …` on a throttler
 *   `@Throttle()` declares (as `@nestjs/throttler`'s `Resolvable`): three
 *   for a `pro` plan, one for the rest.
 *
 * Requests go through `adapter.fetch()` (no socket), so the tracker reads
 * the client from an `x-client` header. Method decorators need the working
 * directory's `tsconfig.json` (oven-sh/bun#28605): run this from
 * `examples/bun-nest`.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { ExecutionContext, INestApplication } from "@nestjs/common";
import {
  BunHttpAdapter,
  BunThrottlerGuard,
  BunThrottlerModule,
  Throttle,
} from "@kingsleyweb/bun-nest";
import {
  Controller,
  Get,
  Headers,
  InternalServerErrorException,
  Module,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { checkEqual, checkRejects, summary } from "../shared/check";
import { step, title } from "../shared/console";
import "reflect-metadata";

/** Whether the export's backend is up. */
let healthy = false;

/** The plan a request's account is on. */
function planOf(context: ExecutionContext): string {
  const req = context.switchToHttp().getRequest<BunRequest>();
  return String(req.headers["x-plan"] ?? "free");
}

@Controller()
class AppController {
  /** Counts failed sign-ins only: the route's flags over the module's. */
  @Throttle({
    default: { skipSuccessfulRequests: true, skipFailedRequests: false },
  })
  @Get("sign-in")
  signIn(@Headers("x-password") password?: string) {
    if (password !== "right") throw new UnauthorizedException();
    return "welcome";
  }

  /** Counts the exports that worked (the module's `skipFailedRequests`). */
  @Get("export")
  export() {
    if (!healthy) throw new InternalServerErrorException("try later");
    return "csv";
  }

  /** A lookup: a 404 is a success under the module's rule. */
  @Get("users/:id")
  user() {
    throw new NotFoundException();
  }
}

@Controller("reports")
class ReportController {
  /**
   * A throttler declared here, its limit per request: three a minute for a
   * `pro` plan, one for the rest. The default throttler is raised out of
   * the way.
   */
  @Throttle({
    default: { limit: 1000 },
    tiered: {
      limit: (context) => (planOf(context) === "pro" ? 3 : 1),
      ttl: "1m",
    },
  })
  @Get()
  report() {
    return "report";
  }
}

@Module({
  imports: [
    BunThrottlerModule.forRoot({
      throttlers: [{ limit: 2, ttl: "1h" }],
      getTracker: (req: BunRequest) =>
        String(req.headers["x-client"] ?? "anonymous"),
      skipFailedRequests: true,
      // A lookup that found nothing is not a failure: it counts like a
      // success (and is not given back under skipFailedRequests).
      requestWasSuccessful: (_req: BunRequest, res: BunResponse) =>
        res.statusCode < 400 || res.statusCode === 404,
    }),
  ],
  controllers: [AppController, ReportController],
  providers: [{ provide: APP_GUARD, useClass: BunThrottlerGuard }],
})
class AppModule {}

title("Refunds and per-request limits with BunThrottlerModule");

const adapter = new BunHttpAdapter();
const app: INestApplication = await NestFactory.create(AppModule, adapter, {
  logger: false,
});
await app.init();

/** Requests `path` `n` times as `client`, answering each status. */
async function statuses(
  path: string,
  n: number,
  client: string,
  headers: Record<string, string> = {},
): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await adapter.fetch(path, {
      headers: { "x-client": client, ...headers },
    });
    out.push(res.status);
  }
  return out;
}

/* ------------------------------------------------------------------ */
step(
  "@Throttle({ default: { skipSuccessfulRequests: true, skipFailedRequests: false } }): failed sign-ins only",
);

const right = { "x-password": "right" };
checkEqual(
  "five good sign-ins: none counts",
  await statuses("/sign-in", 5, "alice", right),
  [200, 200, 200, 200, 200],
);
checkEqual(
  "two bad ones are the limit; the third is refused",
  await statuses("/sign-in", 3, "alice"),
  [401, 401, 429],
);
checkEqual(
  "and the refusal holds for the right password",
  await statuses("/sign-in", 1, "alice", right),
  [429],
);

/* ------------------------------------------------------------------ */
step("the module's skipFailedRequests: an export that counts what worked");

checkEqual(
  "the backend is down: four 500s, none counts",
  await statuses("/export", 4, "bob"),
  [500, 500, 500, 500],
);
healthy = true;
checkEqual(
  "back up: two exports, then the 429s, given back too",
  await statuses("/export", 5, "bob"),
  [200, 200, 429, 429, 429],
);

/* ------------------------------------------------------------------ */
step("requestWasSuccessful: a 404 is not a failure here");

checkEqual(
  "a lookup's 404s count, as successes do (only failures are given back)",
  await statuses("/users/42", 3, "carol"),
  [404, 404, 429],
);

/* ------------------------------------------------------------------ */
step("a limit per plan (a Resolvable limit)");

checkEqual(
  "a pro account: three a minute",
  await statuses("/reports", 4, "pat", { "x-plan": "pro" }),
  [200, 200, 200, 429],
);
checkEqual(
  "a free account: one",
  await statuses("/reports", 2, "fred"),
  [200, 429],
);

/* ------------------------------------------------------------------ */
step("the flags are checked at boot");

await checkRejects(
  "skipFailedRequests must be a boolean",
  async () => {
    @Module({
      imports: [
        BunThrottlerModule.forRoot({
          throttlers: [
            {
              limit: 1,
              ttl: "1m",
              skipFailedRequests: "yes" as unknown as boolean,
            },
          ],
        }),
      ],
    })
    class BadModule {}
    const bad = await NestFactory.create(BadModule, new BunHttpAdapter(), {
      logger: false,
      abortOnError: false,
    });
    await bad.close();
  },
  { message: /skipFailedRequests/ },
);

await app.close();
summary();
