/**
 * `BunThrottlerModule`, `BunThrottlerGuard`, `@Throttle()` and
 * `@SkipThrottle()`: `@nestjs/throttler` 6's API (https://github.com/nestjs/throttler)
 * over bun-common's `throttle()`, on real Nest applications on
 * `BunHttpAdapter`, requests through `adapter.fetch()` (no port).
 *
 * Covered: the default throttler per route, `@Throttle()` per method and
 * class (a field at a time, the method winning), `@SkipThrottle()` with no
 * argument (the `default` throttler only), by name, and `{ default: false }`
 * re-enabling; several named throttlers and decorator-declared ones with
 * their own trackers; the `429` through Nest's exception layer; the headers
 * (none by default, `"legacy"`, `"ietf"`, `Retry-After` always);
 * `getTracker` by option and by subclass; `ignoreUserAgents` and `skipIf`
 * (module-wide and per throttler); a store shared by two applications;
 * `errorMessage`; `forRootAsync`; `BunThrottlerService.update()`; the
 * startup checks (bare-number `ttl`, `@nestjs/throttler` spellings, a
 * decorator throttler without a window) and the boot check that a guard is
 * installed, both outcomes on whichever Nest major is installed.
 *
 * Requests carry an `x-client` header the tests' tracker reads, since a
 * socket-free request has no address. `reflect-metadata` is imported last
 * per the import-sort rule.
 */
import type { BunRequest, ThrottleStore } from "@kingsleyweb/bun-common";
import type {
  ArgumentsHost,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  INestApplication,
} from "@nestjs/common";
import type { BunThrottlerModuleConfig } from "../lib/throttler/options";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { memoryThrottleStore } from "@kingsleyweb/bun-common";
import {
  Catch,
  Controller,
  Get,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  Module,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD, NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { cacheThrottleStore } from "../lib/cache/index";
import { SkipThrottle, Throttle } from "../lib/throttler/decorators";
import { minutes, seconds } from "../lib/throttler/durations";
import { ThrottlerException } from "../lib/throttler/exception";
import { BunThrottlerGuard } from "../lib/throttler/guard";
import {
  BUN_THROTTLER_OPTIONS,
  BunThrottlerModule,
} from "../lib/throttler/module";
import { BunThrottlerService } from "../lib/throttler/options";
import "reflect-metadata";

/** Reads the test's client from `x-client` (a socket-free request has no address). */
const byHeader = (req: BunRequest): string =>
  String(req.headers["x-client"] ?? "anonymous");

/** Applications to close after each test. */
const apps: INestApplication[] = [];

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
});

/** Boots `controllers` with `BunThrottlerModule.forRoot(options)` and the guard as `APP_GUARD`. */
async function boot(
  options: BunThrottlerModuleConfig,
  controllers: (new () => unknown)[],
  extra: {
    providers?: unknown[];
    guard?: boolean;
    adapter?: BunHttpAdapter;
  } = {},
): Promise<{ app: INestApplication; adapter: BunHttpAdapter }> {
  class AppModule {}
  Module({
    imports: [BunThrottlerModule.forRoot(options)],
    controllers,
    providers: [
      ...(extra.guard === false
        ? []
        : [{ provide: APP_GUARD, useClass: BunThrottlerGuard }]),
      ...((extra.providers ?? []) as never[]),
    ],
  })(AppModule);
  const adapter = extra.adapter ?? new BunHttpAdapter();
  const app = await NestFactory.create(AppModule, adapter, {
    logger: false,
    abortOnError: false,
  });
  apps.push(app);
  await app.init();
  return { app, adapter };
}

/** `n` requests to `path`, in order, their statuses. */
async function statuses(
  adapter: BunHttpAdapter,
  path: string,
  n: number,
  init: RequestInit = {},
): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push((await adapter.fetch(path, init)).status);
  }
  return out;
}

/** A request from client `id`. */
const as = (id: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { "x-client": id, ...(init.headers as Record<string, string>) },
});

@Controller()
class PlainController {
  @Get("a")
  a() {
    return "a";
  }

  @Get("b")
  b() {
    return "b";
  }
}

describe("the default throttler", () => {
  it("counts per route per client and refuses past the limit with ThrottlerException's 429", async () => {
    const { adapter } = await boot(
      { throttlers: [{ limit: 2, ttl: "1m" }], getTracker: byHeader },
      [PlainController],
    );
    expect(await statuses(adapter, "/a", 3, as("x"))).toEqual([200, 200, 429]);
    // Another route has its own count; another client too.
    expect(await statuses(adapter, "/b", 2, as("x"))).toEqual([200, 200]);
    expect(await statuses(adapter, "/a", 2, as("y"))).toEqual([200, 200]);
    const refused = await adapter.fetch("/a", as("x"));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      statusCode: 429,
      message: "ThrottlerException: Too Many Requests",
    });
    // Headers are off by default; Retry-After is on every 429.
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(refused.headers.get("x-ratelimit-limit")).toBeNull();
    expect(refused.headers.get("ratelimit")).toBeNull();
  });

  it("accepts a bare array of throttlers, as @nestjs/throttler does", async () => {
    const { adapter } = await boot(
      [{ limit: 1, ttl: seconds(60) }],
      [PlainController],
    );
    expect(await statuses(adapter, "/a", 2)).toEqual([200, 429]);
  });

  it("goes through Nest's exception layer, so a filter shapes the 429", async () => {
    @Catch(ThrottlerException)
    class ProblemFilter implements ExceptionFilter {
      catch(exception: ThrottlerException, host: ArgumentsHost) {
        host
          .switchToHttp()
          .getResponse<{
            status: (n: number) => { json: (b: unknown) => unknown };
          }>()
          .status(429)
          .json({ title: "slow down", detail: exception.message });
      }
    }
    const { adapter } = await boot(
      { throttlers: [{ limit: 1, ttl: "1m" }] },
      [PlainController],
      { providers: [{ provide: APP_FILTER, useClass: ProblemFilter }] },
    );
    await adapter.fetch("/a");
    const refused = await adapter.fetch("/a");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      title: "slow down",
      detail: "ThrottlerException: Too Many Requests",
    });
    expect(refused.headers.get("retry-after")).not.toBeNull();
  });

  it("uses errorMessage, a string or a function of the detail", async () => {
    const { adapter } = await boot(
      {
        throttlers: [{ name: "burst", limit: 1, ttl: "1m" }],
        errorMessage: (_ctx, detail) =>
          `${detail.name}: ${detail.totalHits}/${detail.limit} per ${detail.ttl} ms, retry in ${detail.timeToBlockExpire}s`,
      },
      [PlainController],
    );
    await adapter.fetch("/a");
    const body = (await (await adapter.fetch("/a")).json()) as {
      message: string;
    };
    expect(body.message).toMatch(/^burst: 2\/1 per 60000 ms, retry in \d+s$/);
  });
});

@Throttle({ default: { limit: 3 } })
@Controller("decorated")
class DecoratedController {
  /** The class's limit (3) and the module's window. */
  @Get("class")
  byClass() {
    return "class";
  }

  /** The method's limit wins over the class's. */
  @Throttle({ default: { limit: 1 } })
  @Get("method")
  byMethod() {
    return "method";
  }
}

@Controller("undecorated")
class UndecoratedController {
  /** A method-level override on an undecorated class. */
  @Throttle({ default: { limit: 2, ttl: minutes(5) } })
  @Get("method")
  byMethod() {
    return "method";
  }

  @Get("plain")
  plain() {
    return "plain";
  }
}

describe("@Throttle()", () => {
  it("overrides the module's throttler per class and per method, a field at a time, the method winning", async () => {
    const { adapter } = await boot(
      { throttlers: [{ limit: 10, ttl: "1m" }], headers: "legacy" },
      [DecoratedController, UndecoratedController],
    );
    expect(await statuses(adapter, "/decorated/class", 4)).toEqual([
      200, 200, 200, 429,
    ]);
    expect(await statuses(adapter, "/decorated/method", 2)).toEqual([200, 429]);
    expect(await statuses(adapter, "/undecorated/method", 3)).toEqual([
      200, 200, 429,
    ]);
    const plain = await adapter.fetch("/undecorated/plain");
    expect(plain.headers.get("x-ratelimit-limit")).toBe("10");
    // The method's ttl (5 min) replaced the module's minute.
    const method = await adapter.fetch("/undecorated/method");
    expect(Number(method.headers.get("x-ratelimit-reset"))).toBeGreaterThan(60);
  });
});

@SkipThrottle()
@Controller("skipped")
class SkippedController {
  @Get("all")
  all() {
    return "all";
  }

  @SkipThrottle({ default: false })
  @Get("again")
  again() {
    return "again";
  }
}

@Controller("named")
class NamedSkipController {
  @SkipThrottle({ burst: true })
  @Get("no-burst")
  noBurst() {
    return "ok";
  }

  @SkipThrottle()
  @Get("no-default")
  noDefault() {
    return "ok";
  }
}

describe("@SkipThrottle()", () => {
  it("skips the default throttler on a class, and { default: false } on a method re-enables it", async () => {
    const { adapter } = await boot({ throttlers: [{ limit: 1, ttl: "1m" }] }, [
      SkippedController,
    ]);
    expect(await statuses(adapter, "/skipped/all", 3)).toEqual([200, 200, 200]);
    expect(await statuses(adapter, "/skipped/again", 2)).toEqual([200, 429]);
  });

  it("skips only the named throttler; with no argument only `default`, as @nestjs/throttler", async () => {
    const { adapter } = await boot(
      {
        throttlers: [
          { limit: 1, ttl: "1m" },
          { name: "burst", limit: 2, ttl: "1m" },
        ],
        headers: "legacy",
      },
      [NamedSkipController],
    );
    // burst skipped: default (1) still refuses the second.
    const first = await adapter.fetch("/named/no-burst");
    expect(first.headers.get("x-ratelimit-limit")).toBe("1");
    expect(first.headers.get("x-ratelimit-limit-burst")).toBeNull();
    expect((await adapter.fetch("/named/no-burst")).status).toBe(429);
    // default skipped: burst (2) refuses the third.
    expect(await statuses(adapter, "/named/no-default", 3)).toEqual([
      200, 200, 429,
    ]);
  });
});

describe("headers", () => {
  it('"legacy" sends @nestjs/throttler\'s X-RateLimit-* with -<name> suffixes, and Retry-After-<name> on a refusal', async () => {
    const { adapter } = await boot(
      {
        throttlers: [
          { limit: 3, ttl: "1m" },
          { name: "short", limit: 1, ttl: "10s" },
        ],
        headers: "legacy",
      },
      [PlainController],
    );
    const ok = await adapter.fetch("/a");
    expect(ok.headers.get("x-ratelimit-limit")).toBe("3");
    expect(ok.headers.get("x-ratelimit-remaining")).toBe("2");
    expect(ok.headers.get("x-ratelimit-limit-short")).toBe("1");
    expect(ok.headers.get("x-ratelimit-remaining-short")).toBe("0");
    expect(
      Number(ok.headers.get("x-ratelimit-reset-short")),
    ).toBeLessThanOrEqual(10);
    const refused = await adapter.fetch("/a");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after-short")).toMatch(/^\d+$/);
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it('"ietf" sends RateLimit-Policy and RateLimit, one item per throttler', async () => {
    const { adapter } = await boot(
      {
        throttlers: [
          { limit: 3, ttl: "1m" },
          { name: "short", limit: 2, ttl: "10s" },
        ],
        headers: "ietf",
      },
      [PlainController],
    );
    const ok = await adapter.fetch("/a");
    expect(ok.headers.get("ratelimit-policy")).toBe(
      '"default";q=3;w=60, "short";q=2;w=10',
    );
    expect(ok.headers.get("ratelimit")).toMatch(
      /^"default";r=2;t=\d+, "short";r=1;t=\d+$/,
    );
    expect(ok.headers.get("x-ratelimit-limit")).toBeNull();
  });

  it("a throttler's own headers option wins over the module's", async () => {
    const { adapter } = await boot(
      {
        throttlers: [
          { limit: 3, ttl: "1m" },
          { name: "quiet", limit: 3, ttl: "1m", headers: false },
        ],
        headers: "legacy",
      },
      [PlainController],
    );
    const ok = await adapter.fetch("/a");
    expect(ok.headers.get("x-ratelimit-limit")).toBe("3");
    expect(ok.headers.get("x-ratelimit-limit-quiet")).toBeNull();
  });
});

describe("several throttlers", () => {
  it("refuses when any refuses, and counts the refused request against all (bun-common's count-then-check)", async () => {
    const { adapter } = await boot(
      {
        throttlers: [
          // long first: each refusing throttle sets its own Retry-After, so
          // the guard must take the longest, not the last.
          { name: "long", limit: 3, ttl: "1h" },
          { name: "short", limit: 2, ttl: "10s" },
        ],
        headers: "legacy",
      },
      [PlainController],
    );
    expect(await statuses(adapter, "/a", 3)).toEqual([200, 200, 429]);
    const fourth = await adapter.fetch("/a");
    expect(fourth.status).toBe(429);
    // Both refused now: long counted the refused third.
    expect(fourth.headers.get("x-ratelimit-remaining-long")).toBe("0");
    expect(fourth.headers.get("retry-after-long")).not.toBeNull();
    // Retry-After is the longest wait: long's hour, not short's seconds.
    expect(Number(fourth.headers.get("retry-after"))).toBeGreaterThan(60);
  });
});

/** A sign-in route: two decorator-declared throttlers with their own trackers, beside the module's default. */
@Controller("auth")
class AuthController {
  @Throttle({
    account: {
      limit: 2,
      ttl: "1m",
      getTracker: (req) =>
        `${byHeader(req)}|${String(req.headers["x-account"])}`,
    },
    address: { limit: 3, ttl: "1m" },
  })
  @Post("sign-in")
  signIn() {
    return "signed in";
  }

  /** The default throttler replaced: skipped, and a strict one declared. */
  @SkipThrottle()
  @Throttle({ strict: { limit: 1, ttl: "1m" } })
  @Post("verify")
  verify() {
    return "verified";
  }

  @Get("me")
  me() {
    return "me";
  }
}

describe("throttlers declared by @Throttle()", () => {
  it("apply to their routes only, each with its own tracker, beside the module's", async () => {
    const { adapter } = await boot(
      { throttlers: [{ limit: 100, ttl: "1m" }], getTracker: byHeader },
      [AuthController],
    );
    const post = (client: string, account: string) =>
      adapter.fetch(
        "/auth/sign-in",
        as(client, { method: "POST", headers: { "x-account": account } }),
      );
    // address+account: 2 per account from one address; another account
    // from it still gets in (its own count) while the address has room.
    expect((await post("ip1", "ann")).status).toBe(201);
    expect((await post("ip1", "ann")).status).toBe(201);
    expect((await post("ip1", "bob")).status).toBe(201);
    expect((await post("ip1", "ann")).status).toBe(429);
    // address alone: 3 (and the refused 4th) counted from ip1, so a new
    // account from it is refused too.
    expect((await post("ip1", "carol")).status).toBe(429);
    // Another address is untouched.
    expect((await post("ip2", "ann")).status).toBe(201);
    // Other routes see only the module's throttler.
    expect(await statuses(adapter, "/auth/me", 5, as("ip1"))).toEqual([
      200, 200, 200, 200, 200,
    ]);
  });

  it("replace the default throttler on a route that skips it", async () => {
    const { adapter } = await boot(
      { throttlers: [{ limit: 100, ttl: "1m" }] },
      [AuthController],
    );
    expect(
      await statuses(adapter, "/auth/verify", 2, { method: "POST" }),
    ).toEqual([201, 429]);
  });
});

describe("getTracker, ignoreUserAgents, skipIf", () => {
  it("getTracker as an option and as an overridden method", async () => {
    @Injectable()
    class ByHeaderGuard extends BunThrottlerGuard {
      protected override async getTracker(req: BunRequest) {
        return byHeader(req);
      }
    }
    const { adapter } = await boot(
      { throttlers: [{ limit: 1, ttl: "1m" }] },
      [PlainController],
      {
        guard: false,
        providers: [{ provide: APP_GUARD, useClass: ByHeaderGuard }],
      },
    );
    expect((await adapter.fetch("/a", as("p"))).status).toBe(200);
    expect((await adapter.fetch("/a", as("q"))).status).toBe(200);
    expect((await adapter.fetch("/a", as("p"))).status).toBe(429);
  });

  it('the default tracker is the address, "unknown" with none', async () => {
    const { adapter } = await boot({ throttlers: [{ limit: 1, ttl: "1m" }] }, [
      PlainController,
    ]);
    // Two "clients" by header share the unknown address.
    expect((await adapter.fetch("/a", as("p"))).status).toBe(200);
    expect((await adapter.fetch("/a", as("q"))).status).toBe(429);
  });

  it("ignoreUserAgents lets matching agents through uncounted", async () => {
    const { adapter } = await boot(
      { throttlers: [{ limit: 1, ttl: "1m" }], ignoreUserAgents: [/^probe\//] },
      [PlainController],
    );
    const probe = { headers: { "user-agent": "probe/1.0" } };
    expect(await statuses(adapter, "/a", 3, probe)).toEqual([200, 200, 200]);
    expect(await statuses(adapter, "/a", 2)).toEqual([200, 429]);
  });

  it("skipIf on one throttler exempts a caller from it while the others still apply (a service token)", async () => {
    const service = (ctx: ExecutionContext) =>
      ctx.switchToHttp().getRequest<BunRequest>().headers["x-api-token"] ===
      "secret";
    const { adapter } = await boot(
      {
        throttlers: [
          { limit: 1, ttl: "1m", skipIf: service },
          { name: "strict", limit: 2, ttl: "1m" },
        ],
      },
      [PlainController],
    );
    const token = { headers: { "x-api-token": "secret" } };
    // default skipped for the service; strict still counts it.
    expect(await statuses(adapter, "/a", 3, token)).toEqual([200, 200, 429]);
  });

  it("a module-wide skipIf exempts from every throttler, and shouldSkip can be overridden", async () => {
    const { adapter } = await boot(
      {
        throttlers: [{ limit: 1, ttl: "1m" }],
        skipIf: (ctx) =>
          ctx.switchToHttp().getRequest<BunRequest>().headers["x-skip"] === "1",
      },
      [PlainController],
    );
    expect(
      await statuses(adapter, "/a", 3, { headers: { "x-skip": "1" } }),
    ).toEqual([200, 200, 200]);
    expect(await statuses(adapter, "/a", 2)).toEqual([200, 429]);

    @Injectable()
    class NeverGuard extends BunThrottlerGuard {
      protected override async shouldSkip() {
        return true;
      }
    }
    const other = await boot(
      { throttlers: [{ limit: 1, ttl: "1m" }] },
      [PlainController],
      {
        guard: false,
        providers: [{ provide: APP_GUARD, useClass: NeverGuard }],
      },
    );
    expect(await statuses(other.adapter, "/a", 3)).toEqual([200, 200, 200]);
  });

  it("resolves limit and ttl given as functions of the context, per request", async () => {
    let premium = false;
    const { adapter } = await boot(
      {
        throttlers: [{ limit: () => (premium ? 3 : 1), ttl: async () => "1m" }],
      },
      [PlainController],
    );
    expect(await statuses(adapter, "/a", 2)).toEqual([200, 429]);
    premium = true;
    // Same counter (same window), higher limit: the count carried over (2 so far).
    expect(await statuses(adapter, "/a", 2)).toEqual([200, 429]);
  });
});

describe("the store", () => {
  it("one store shared by two applications holds one count (as a Redis store holds it across instances)", async () => {
    const store = memoryThrottleStore();
    const one = await boot({ throttlers: [{ limit: 3, ttl: "1m" }], store }, [
      PlainController,
    ]);
    const two = await boot({ throttlers: [{ limit: 3, ttl: "1m" }], store }, [
      PlainController,
    ]);
    expect(await statuses(one.adapter, "/a", 2)).toEqual([200, 200]);
    expect(await statuses(two.adapter, "/a", 2)).toEqual([200, 429]);
    expect((await one.adapter.fetch("/a")).status).toBe(429);
  });

  it("cacheThrottleStore from @kingsleyweb/bun-nest/cache shares one count between two applications", async () => {
    const cache = createCache({ driver: memoryDriver() });
    const store = cacheThrottleStore(cache);
    const one = await boot({ throttlers: [{ limit: 2, ttl: "1m" }], store }, [
      PlainController,
    ]);
    const two = await boot({ throttlers: [{ limit: 2, ttl: "1m" }], store }, [
      PlainController,
    ]);
    expect((await one.adapter.fetch("/a")).status).toBe(200);
    expect((await two.adapter.fetch("/a")).status).toBe(200);
    expect((await one.adapter.fetch("/a")).status).toBe(429);
    await cache.close();
  });

  it('failMode "closed" answers 503 when the store fails; "open" (the default) lets the request through', async () => {
    const broken: ThrottleStore = {
      name: "broken",
      increment: () => {
        throw new Error("down");
      },
      get: () => {
        throw new Error("down");
      },
    };
    const closed = await boot(
      {
        throttlers: [{ limit: 1, ttl: "1m" }],
        store: broken,
        failMode: "closed",
      },
      [PlainController],
    );
    expect((await closed.adapter.fetch("/a")).status).toBe(503);
    const open = await boot(
      { throttlers: [{ limit: 1, ttl: "1m" }], store: broken },
      [PlainController],
    );
    expect(await statuses(open.adapter, "/a", 3)).toEqual([200, 200, 200]);
  });
});

describe("BunThrottlerModule.forRootAsync and BunThrottlerService", () => {
  it("builds the options with an injected factory", async () => {
    const CONFIG = Symbol("config");
    @Module({
      providers: [{ provide: CONFIG, useValue: { limit: 1 } }],
      exports: [CONFIG],
    })
    class ConfigModule {}
    class AppModule {}
    Module({
      imports: [
        BunThrottlerModule.forRootAsync({
          imports: [ConfigModule],
          inject: [CONFIG],
          useFactory: (config: { limit: number }) => ({
            throttlers: [{ limit: config.limit, ttl: "1m" }],
          }),
          globalGuard: true,
        }),
      ],
      controllers: [PlainController],
    })(AppModule);
    const adapter = new BunHttpAdapter();
    const app = await NestFactory.create(AppModule, adapter, {
      logger: false,
      abortOnError: false,
    });
    apps.push(app);
    await app.init();
    expect(await statuses(adapter, "/a", 2)).toEqual([200, 429]);
    expect(app.get<unknown>(BUN_THROTTLER_OPTIONS) as object).toEqual({
      throttlers: [{ limit: 1, ttl: "1m" }],
    });
  });

  it("builds the options with a factory class (useClass)", async () => {
    class Factory {
      createThrottlerOptions() {
        return [{ limit: 1, ttl: "1m" }];
      }
    }
    class AppModule {}
    Module({
      imports: [BunThrottlerModule.forRootAsync({ useClass: Factory })],
      controllers: [PlainController],
      providers: [{ provide: APP_GUARD, useClass: BunThrottlerGuard }],
    })(AppModule);
    const adapter = new BunHttpAdapter();
    const app = await NestFactory.create(AppModule, adapter, {
      logger: false,
      abortOnError: false,
    });
    apps.push(app);
    await app.init();
    expect(await statuses(adapter, "/a", 2)).toEqual([200, 429]);
  });

  it("update() changes a limit for every guard at once", async () => {
    const { app, adapter } = await boot(
      { throttlers: [{ limit: 1, ttl: "1m" }] },
      [PlainController],
    );
    expect(await statuses(adapter, "/a", 2)).toEqual([200, 429]);
    app.get(BunThrottlerService).update("default", { limit: 5 });
    expect(await statuses(adapter, "/a", 3)).toEqual([200, 200, 200]);
    expect(() =>
      app.get(BunThrottlerService).update("nope", { limit: 1 }),
    ).toThrow(/no throttler is named "nope"/);
    expect(() =>
      app
        .get(BunThrottlerService)
        .update("default", { ttl: 60_000 as unknown as "1m" }),
    ).toThrow(/bare number/);
  });

  it("resolves a subclass with no constructor of its own, its dependency declared explicitly", async () => {
    @Injectable()
    class SubGuard extends BunThrottlerGuard {}
    const { adapter } = await boot(
      { throttlers: [{ limit: 1, ttl: "1m" }] },
      [PlainController],
      { guard: false, providers: [{ provide: APP_GUARD, useClass: SubGuard }] },
    );
    expect(await statuses(adapter, "/a", 2)).toEqual([200, 429]);
  });

  it("a subclass with a constructor declares its dependency with @Inject(BunThrottlerService)", async () => {
    @Injectable()
    class WithCtor extends BunThrottlerGuard {
      constructor(@Inject(BunThrottlerService) service: BunThrottlerService) {
        super(service);
      }
    }
    const { adapter } = await boot(
      { throttlers: [{ limit: 1, ttl: "1m" }] },
      [PlainController],
      { guard: false, providers: [{ provide: APP_GUARD, useClass: WithCtor }] },
    );
    expect(await statuses(adapter, "/a", 2)).toEqual([200, 429]);
  });

  it("lets a non-HTTP context through", async () => {
    const guard = new BunThrottlerGuard({
      throttlers: [{ limit: 1, ttl: "1m" }],
    });
    const context = { getType: () => "ws" } as unknown as ExecutionContext;
    expect(await guard.canActivate(context)).toBe(true);
    expect(await guard.canActivate(context)).toBe(true);
  });
});

describe("startup checks", () => {
  /** Boots and answers the error the boot failed with. */
  async function bootError(
    options: BunThrottlerModuleConfig,
    controllers: (new () => unknown)[] = [PlainController],
  ): Promise<string> {
    try {
      await boot(options, controllers);
    } catch (error) {
      return (error as Error).message;
    }
    return "booted";
  }

  it("refuses a bare-number ttl (THROTTLE_TTL=60) and a sub-second one", async () => {
    expect(
      await bootError({
        throttlers: [{ limit: 1, ttl: 60 as unknown as "1m" }],
      }),
    ).toMatch(/bare number is ambiguous.*seconds\(60\)/);
    expect(
      await bootError({ throttlers: [{ limit: 1, ttl: "500ms" }] }),
    ).toMatch(/under a second/);
    expect(
      await bootError({
        throttlers: [{ limit: 1, ttl: "500ms", allowSubSecond: true }],
      }),
    ).toBe("booted");
  });

  it("refuses @nestjs/throttler spellings it does not take, naming the replacement", async () => {
    expect(
      await bootError({
        throttlers: [{ limit: 1, ttl: "1m" }],
        setHeaders: true,
      } as unknown as BunThrottlerModuleConfig),
    ).toMatch(/headers: "legacy"/);
    expect(
      await bootError({
        throttlers: [{ limit: 1, ttl: "1m", blockDuration: 5 as never }],
      }),
    ).toMatch(/blockDuration is not supported/);
    expect(
      await bootError({
        throttlers: [{ limit: 1, ttl: "1m" }],
        storage: {},
      } as unknown as BunThrottlerModuleConfig),
    ).toMatch(/spelled store/);
    expect(
      await bootError({
        throttlers: [
          { limit: 1, ttl: "1m" },
          { limit: 2, ttl: "1m" },
        ],
      }),
    ).toMatch(/two throttlers are named "default"/);
    expect(await bootError({ throttlers: [{ limit: 0, ttl: "1m" }] })).toMatch(
      /limit must be a positive integer/,
    );
  });

  it("fails the boot on a decorator throttler without a window, naming the route", async () => {
    @Controller()
    class Broken {
      @Throttle({ unknown: { limit: 1 } })
      @Get("x")
      x() {
        return "x";
      }
    }
    expect(await bootError({ throttlers: [] }, [Broken])).toMatch(
      /Broken\.x: BunThrottlerModule defines no throttler "unknown".*no ttl/,
    );
  });
});

describe("the boot check that a guard is installed", () => {
  /** A guard that is not the throttler, registered as APP_GUARD instead of it. */
  @Injectable()
  class OtherGuard implements CanActivate {
    canActivate() {
      return true;
    }
  }

  /** Boots, answering the boot check's error lines. */
  async function errorsOf(
    options: BunThrottlerModuleConfig,
    providers: unknown[],
    controllers: (new () => unknown)[] = [PlainController],
    configure?: (app: INestApplication) => void,
  ): Promise<string[]> {
    const spy = spyOn(Logger.prototype, "error");
    try {
      class AppModule {}
      Module({
        imports: [BunThrottlerModule.forRoot(options)],
        controllers,
        providers: providers as never[],
      })(AppModule);
      const app = await NestFactory.create(AppModule, new BunHttpAdapter(), {
        logger: false,
        abortOnError: false,
      });
      apps.push(app);
      configure?.(app);
      await app.init();
      return spy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("BunThrottlerGuard"));
    } finally {
      spy.mockRestore();
    }
  }

  const throttlers = { throttlers: [{ limit: 1, ttl: "1m" }] };

  it("logs an error when the module is imported but no guard is installed", async () => {
    const lines = await errorsOf(throttlers, [
      { provide: APP_GUARD, useClass: OtherGuard },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/no BunThrottlerGuard is installed/);
  });

  it('fails the boot under guardCheck: "throw"', async () => {
    await expect(
      errorsOf({ ...throttlers, guardCheck: "throw" }, []),
    ).rejects.toThrow(/no BunThrottlerGuard is installed/);
  });

  it("says nothing with guardCheck: false", async () => {
    expect(await errorsOf({ ...throttlers, guardCheck: false }, [])).toEqual(
      [],
    );
  });

  it("is satisfied by APP_GUARD, globalGuard, useGlobalGuards and @UseGuards", async () => {
    expect(
      await errorsOf(throttlers, [
        { provide: APP_GUARD, useClass: BunThrottlerGuard },
      ]),
    ).toEqual([]);
    expect(await errorsOf({ ...throttlers, globalGuard: true }, [])).toEqual(
      [],
    );
    expect(
      await errorsOf(throttlers, [], [PlainController], (app) => {
        app.useGlobalGuards(
          new BunThrottlerGuard(app.get(BunThrottlerService)),
        );
      }),
    ).toEqual([]);

    @UseGuards(BunThrottlerGuard)
    @Controller("guarded")
    class GuardedController {
      @Get()
      get() {
        return "ok";
      }
    }
    expect(await errorsOf(throttlers, [], [GuardedController])).toEqual([]);

    @Controller("routes")
    class RouteGuarded {
      @UseGuards(BunThrottlerGuard)
      @Get()
      get() {
        return "ok";
      }
    }
    expect(await errorsOf(throttlers, [], [RouteGuarded])).toEqual([]);
  });
});

@Controller("outcome")
class OutcomeController {
  @Throttle({ default: { skipSuccessfulRequests: true } })
  @Get("login")
  login(@Req() req: BunRequest) {
    if (req.headers["x-ok"] !== "1") throw new UnauthorizedException();
    return "welcome";
  }

  @Get("work")
  work(@Req() req: BunRequest) {
    if (req.headers["x-ok"] !== "1") throw new InternalServerErrorException();
    return "done";
  }
}

describe("skipSuccessfulRequests and skipFailedRequests", () => {
  it("@Throttle({ default: { skipSuccessfulRequests: true } }): only failed logins count", async () => {
    const { adapter } = await boot(
      { throttlers: [{ limit: 2, ttl: "1m" }], getTracker: byHeader },
      [OutcomeController],
    );
    const good = as("c1", { headers: { "x-ok": "1" } });
    expect(await statuses(adapter, "/outcome/login", 4, good)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(await statuses(adapter, "/outcome/login", 3, as("c1"))).toEqual([
      401, 401, 429,
    ]);
    expect(await statuses(adapter, "/outcome/login", 1, good)).toEqual([429]);
    // The route without it counts every request.
    expect(await statuses(adapter, "/outcome/work", 3, good)).toEqual([
      200, 200, 429,
    ]);
  });

  it("the module's skipFailedRequests: errors and refusals are given back", async () => {
    const { adapter } = await boot(
      {
        throttlers: [{ limit: 2, ttl: "1m" }],
        getTracker: byHeader,
        skipFailedRequests: true,
      },
      [OutcomeController],
    );
    expect(await statuses(adapter, "/outcome/work", 3, as("c2"))).toEqual([
      500, 500, 500,
    ]);
    const good = as("c2", { headers: { "x-ok": "1" } });
    expect(await statuses(adapter, "/outcome/work", 4, good)).toEqual([
      200, 200, 429, 429,
    ]);
  });

  it("requestWasSuccessful decides what success is", async () => {
    const { adapter } = await boot(
      {
        throttlers: [{ limit: 1, ttl: "1m", skipSuccessfulRequests: true }],
        getTracker: byHeader,
        requestWasSuccessful: (_req, res) => res.statusCode < 500,
      },
      [OutcomeController],
    );
    expect(await statuses(adapter, "/outcome/work", 2, as("c3"))).toEqual([
      500, 429,
    ]);
    expect(await statuses(adapter, "/outcome/login", 3, as("c4"))).toEqual([
      401, 401, 401,
    ]);
  });

  it("refuses a flag that is not a boolean, at startup", async () => {
    let error: unknown;
    try {
      await boot(
        {
          // @ts-expect-error not a boolean
          throttlers: [{ limit: 1, ttl: "1m", skipFailedRequests: "yes" }],
        },
        [OutcomeController],
      );
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("skipFailedRequests");
  });
});
