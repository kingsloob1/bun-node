/**
 * `@kingsleyweb/bun-nest/security` (PR-S6): bun-security's three stages on
 * a Nest application, the decorators, the module's options and its boot
 * self-test.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import type { Security } from "@kingsleyweb/bun-security";
import type {
  ArgumentsHost,
  ExceptionFilter,
  INestApplication,
} from "@nestjs/common";
import type { SecurityModuleOptions } from "../lib/security/index";
import { ConfigError } from "@kingsleyweb/bun-common";
import { createSecurity } from "@kingsleyweb/bun-security";
import { requestSecurity } from "@kingsleyweb/bun-security/http";
import {
  Catch,
  Controller,
  Get,
  Header,
  Injectable,
  Module,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  InjectSecurity,
  SecurityGuard,
  SecurityModule,
  SecurityProfile,
  SecurityRefusalException,
  SecurityService,
  SkipSecurity,
} from "../lib/security/index";
import "reflect-metadata";

/** Applications to close after each test. */
const apps: INestApplication[] = [];

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
});

/** Reads the caller from `x-user`. */
const identify = (req: BunRequest) => {
  const user = req.request.headers.get("x-user");
  return user === null ? undefined : { user };
};

/** A request from `client` (the socket peer), with `init`. */
const from = (client: string, init: Record<string, unknown> = {}) => ({
  remoteAddress: client,
  ...init,
});

/** Boots `controllers` with `imports` (by default `SecurityModule.forRoot`) on a fresh adapter. */
async function boot(
  imports: unknown[],
  controllers: (new (...args: never[]) => unknown)[],
  providers: unknown[] = [],
  adapter: BunHttpAdapter = new BunHttpAdapter(),
): Promise<{ app: INestApplication; adapter: BunHttpAdapter }> {
  class AppModule {}
  Module({
    imports: imports as never[],
    controllers,
    providers: providers as never[],
  })(AppModule);
  const app = await NestFactory.create(AppModule, adapter, {
    logger: false,
    abortOnError: false,
  });
  apps.push(app);
  await app.init();
  return { app, adapter };
}

/** `SecurityModule.forRoot()` with the test's identify and a quiet logger. */
const secured = (options: Partial<SecurityModuleOptions> = {}) =>
  SecurityModule.forRoot({
    policy: {},
    identify,
    logger: () => {},
    ...options,
  } as SecurityModuleOptions);

@Controller()
class AppController {
  @Get("x")
  x() {
    return "x";
  }

  @Post("upload")
  upload(@Req() req: BunRequest) {
    return req.body;
  }

  @Get("records/:id")
  record() {
    throw new NotFoundException("no such record");
  }

  @Get("boom")
  boom() {
    throw new Error("boom");
  }

  @Get("profiled")
  @SecurityProfile("login")
  profiled(@Req() req: BunRequest) {
    return {
      profile: requestSecurity(req)?.profile ?? null,
      factsProfile: requestSecurity(req)?.facts?.profile ?? null,
    };
  }

  @Post("transfer")
  transfer() {
    return "done";
  }

  @Post("hooks/stripe")
  @SecurityProfile("webhook", { crossSite: true })
  hook() {
    return "hook";
  }

  @Get("health")
  @SkipSecurity()
  health() {
    return "ok";
  }

  @Get("import")
  @SkipSecurity("limit:per-user")
  bulk() {
    return "imported";
  }

  @Get("users/:id")
  user(@Req() req: BunRequest) {
    return { routeKey: requestSecurity(req)?.facts?.routeKey ?? null };
  }
}

describe("SecurityModule: the early stage (the adapter's before-read hook)", () => {
  it("refuses a listed address before its body is read, with the security headers", async () => {
    const { adapter } = await boot(
      [
        secured({
          policy: { lists: [{ ip: "203.0.113.66", action: "block" }] },
        }),
      ],
      [AppController],
    );
    let pulls = 0;
    const body = () =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new TextEncoder().encode('{"a":1}'));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
    };
    const refused = await adapter.fetch(
      "/upload",
      from("203.0.113.66", { ...init, body: body() }),
    );
    expect(refused.status).toBe(403);
    expect(refused.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(refused.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await refused.json()).toMatchObject({
      status: 403,
      code: "blocked",
    });
    expect(pulls).toBe(0);
    const passed = await adapter.fetch(
      "/upload",
      from("198.51.100.1", { ...init, body: body() }),
    );
    expect([passed.status, await passed.json(), pulls]).toEqual([
      201,
      { a: 1 },
      1,
    ]);
  });

  it("counts an address limit once across both stages, and gives each request's slot back", async () => {
    const { app, adapter } = await boot(
      [
        secured({
          policy: {
            limits: [{ id: "ip", limit: 2, window: "1m" }],
            concurrency: { perIp: 1 },
          },
        }),
      ],
      [AppController],
    );
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++)
      statuses.push((await adapter.fetch("/x", from("198.51.100.2"))).status);
    expect(statuses).toEqual([200, 200, 429]);
    const security = app.get(SecurityService).security;
    expect(security.status().state.inFlight).toBe(0);
  });

  it("refuses a honeypot before the body is read, and fails open (or closed) when the engine throws", async () => {
    const { adapter } = await boot(
      [
        secured({
          policy: {
            deception: { honeypots: { paths: ["/.env"], answer: "not-found" } },
          },
        }),
      ],
      [AppController],
    );
    expect((await adapter.fetch("/.env", from("198.51.100.3"))).status).toBe(
      404,
    );
    const broken = createSecurity<BunRequest>({ policy: {}, logger: () => {} });
    const failing = new Proxy(broken, {
      get(target, key) {
        if (key === "evaluate") {
          return () => {
            throw new Error("engine bug");
          };
        }
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const open = await boot(
      [SecurityModule.forRoot({ security: failing, logger: () => {} })],
      [AppController],
    );
    expect((await open.adapter.fetch("/x")).status).toBe(200);
    const closed = await boot(
      [
        SecurityModule.forRoot({
          security: failing,
          failClosedOnEngineError: true,
          logger: () => {},
        }),
      ],
      [AppController],
    );
    const refused = await closed.adapter.fetch("/x");
    expect([refused.status, refused.headers.get("retry-after")]).toEqual([
      503,
      "1",
    ]);
  });
});

describe("SecurityModule: the route stage (SecurityGuard)", () => {
  it("refuses a caller-keyed limit with a SecurityRefusalException's problem body", async () => {
    const { adapter } = await boot(
      [
        secured({
          policy: {
            limits: [{ id: "per-user", limit: 1, window: "1m", key: "user" }],
          },
        }),
      ],
      [AppController],
    );
    const as = (user: string) =>
      from("198.51.100.4", { headers: { "x-user": user } });
    expect((await adapter.fetch("/x", as("alice"))).status).toBe(200);
    const refused = await adapter.fetch("/x", as("alice"));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      code: "rate_limited",
    });
    expect(refused.headers.get("retry-after")).not.toBeNull();
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect((await adapter.fetch("/x", as("bob"))).status).toBe(200);
  });

  it("enforces a user ban and a user list entry in the route stage", async () => {
    const { app, adapter } = await boot(
      [secured({ policy: { lists: [{ user: "mallory", action: "block" }] } })],
      [AppController],
    );
    expect(
      (await adapter.fetch("/x", { headers: { "x-user": "mallory" } })).status,
    ).toBe(403);
    app
      .get<SecurityService>(SecurityService)
      .security.ban({ user: "eve", duration: "1h" });
    const banned = await adapter.fetch("/x", { headers: { "x-user": "eve" } });
    expect([
      banned.status,
      ((await banned.json()) as { code: string }).code,
    ]).toEqual([403, "banned"]);
    expect(
      (await adapter.fetch("/x", { headers: { "x-user": "alice" } })).status,
    ).toBe(200);
  });

  it("knows the matched route's pattern, and reads @SecurityProfile", async () => {
    const { adapter } = await boot(
      [
        secured({
          policy: {
            limits: [
              {
                id: "user-page",
                limit: 1,
                window: "1m",
                routes: ["GET /users/:id"],
              },
            ],
          },
        }),
      ],
      [AppController],
    );
    const first = await adapter.fetch("/users/1", from("198.51.100.5"));
    expect(await first.json()).toEqual({ routeKey: "GET /users/:id" });
    expect((await adapter.fetch("/users/2", from("198.51.100.5"))).status).toBe(
      429,
    );
    expect(await (await adapter.fetch("/profiled")).json()).toEqual({
      profile: "login",
      factsProfile: "login",
    });
    expect(() => SecurityProfile("not a name")).toThrow(TypeError);
  });

  it("puts @SecurityProfile in the facts, so the profile's presets apply (login.ip: 30 a minute)", async () => {
    const { adapter } = await boot(
      [secured({ policy: { profiles: { login: false } } })],
      [AppController],
    );
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push(
        (await adapter.fetch("/profiled", from("198.51.100.6"))).status,
      );
    }
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    // Negative control: an unmarked route takes 31 from the address.
    for (let i = 0; i < 31; i++) {
      expect(
        (await adapter.fetch("/users/9", from("198.51.100.7"))).status,
      ).toBe(200);
    }
  });

  it("skips the route stage with @SkipSecurity(), and one rule's refusal with @SkipSecurity(id)", async () => {
    const { adapter } = await boot(
      [
        secured({
          policy: {
            limits: [{ id: "per-user", limit: 1, window: "1m", key: "user" }],
          },
        }),
      ],
      [AppController],
    );
    const as = { headers: { "x-user": "carol" } };
    const health = [];
    for (let i = 0; i < 3; i++)
      health.push((await adapter.fetch("/health", as)).status);
    expect(health).toEqual([200, 200, 200]);
    expect((await adapter.fetch("/x", as)).status).toBe(200);
    // Still counted, but its refusal is skipped on /import.
    expect((await adapter.fetch("/import", as)).status).toBe(200);
    expect((await adapter.fetch("/x", as)).status).toBe(429);
    expect(() => SkipSecurity("")).toThrow(TypeError);
  });

  it("refuses a cross-site cookie POST (CSRF), except on a crossSite route", async () => {
    const { adapter } = await boot([secured()], [AppController]);
    const forged = {
      method: "POST",
      headers: { cookie: "sid=1", "sec-fetch-site": "cross-site" },
    };
    const refused = await adapter.fetch("/transfer", forged);
    expect([
      refused.status,
      ((await refused.json()) as { code: string }).code,
    ]).toEqual([403, "csrf"]);
    expect((await adapter.fetch("/hooks/stripe", forged)).status).toBe(201);
    expect(
      (
        await adapter.fetch("/transfer", {
          method: "POST",
          headers: { cookie: "sid=1", "sec-fetch-site": "same-origin" },
        })
      ).status,
    ).toBe(201);
    const off = await boot([secured({ csrf: false })], [AppController]);
    expect((await off.adapter.fetch("/transfer", forged)).status).toBe(201);
  });

  it("lets an app's own exception filter render the refusal from its decision", async () => {
    @Catch(SecurityRefusalException)
    class RefusalFilter implements ExceptionFilter {
      catch(exception: SecurityRefusalException, host: ArgumentsHost) {
        const res = host
          .switchToHttp()
          .getResponse<import("@kingsleyweb/bun-common").BunResponse>();
        res
          .status(exception.getStatus())
          .send(`refused: ${exception.decision.code ?? ""}`);
      }
    }
    const { adapter } = await boot(
      [secured({ policy: { lists: [{ user: "mallory", action: "block" }] } })],
      [AppController],
      [{ provide: APP_FILTER, useClass: RefusalFilter }],
    );
    const res = await adapter.fetch("/x", { headers: { "x-user": "mallory" } });
    expect([res.status, await res.text()]).toEqual([403, "refused: blocked"]);
  });
});

describe("SecurityModule: the response stage", () => {
  it("counts Nest's route-not-found answers, never a route's own NotFoundException", async () => {
    const { adapter } = await boot(
      [
        secured({
          policy: {
            countedRules: [
              {
                id: "not_found",
                event: "route.notFound",
                threshold: 3,
                window: "1m",
                duration: "1h",
              },
            ],
          },
        }),
      ],
      [AppController],
    );
    for (let i = 0; i < 5; i++) {
      expect(
        (await adapter.fetch(`/records/${i}`, from("198.51.100.6"))).status,
      ).toBe(404);
    }
    expect((await adapter.fetch("/x", from("198.51.100.6"))).status).toBe(200);
    for (const path of ["/wp-admin", "/.git/config", "/phpmyadmin"]) {
      expect((await adapter.fetch(path, from("198.51.100.7"))).status).toBe(
        404,
      );
    }
    expect((await adapter.fetch("/x", from("198.51.100.7"))).status).toBe(403);
    expect((await adapter.fetch("/x", from("198.51.100.6"))).status).toBe(200);
  });

  it("sets the security headers on a route's answer, Nest's 404 and its exception answer; the app's own value wins", async () => {
    @Controller()
    class OwnHeader {
      @Get("own")
      @Header("X-Frame-Options", "SAMEORIGIN")
      own() {
        return "own";
      }
    }
    const { adapter } = await boot([secured()], [AppController, OwnHeader]);
    for (const path of ["/x", "/missing", "/boom"]) {
      const res = await adapter.fetch(path);
      expect([
        path,
        res.headers.get("x-frame-options"),
        res.headers.get("referrer-policy"),
      ]).toEqual([path, "DENY", "strict-origin-when-cross-origin"]);
    }
    expect((await adapter.fetch("/own")).headers.get("x-frame-options")).toBe(
      "SAMEORIGIN",
    );
    const off = await boot([secured({ headers: false })], [AppController]);
    expect(
      (await off.adapter.fetch("/x")).headers.get("x-frame-options"),
    ).toBeNull();
  });

  it("scrubs a stack trace an app's filter leaks into a 5xx, when asked", async () => {
    @Catch()
    class LeakyFilter implements ExceptionFilter {
      catch(exception: Error, host: ArgumentsHost) {
        host
          .switchToHttp()
          .getResponse<import("@kingsleyweb/bun-common").BunResponse>()
          .status(500)
          .json({ message: exception.message, stack: exception.stack });
      }
    }
    const filter = [{ provide: APP_FILTER, useClass: LeakyFilter }];
    const scrubbing = await boot(
      [secured({ scrub: "always" })],
      [AppController],
      filter,
    );
    const scrubbed = await scrubbing.adapter.fetch("/boom");
    expect(scrubbed.status).toBe(500);
    expect(await scrubbed.json()).toEqual({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      code: "internal_error",
    });
    // Negative control: off (and "production" outside production) leaks.
    const leaking = await boot(
      [secured({ scrub: false })],
      [AppController],
      filter,
    );
    expect(
      JSON.stringify(await (await leaking.adapter.fetch("/boom")).json()),
    ).toContain("stack");
  });
});

describe("SecurityModule: the module", () => {
  it("injects the engine with @InjectSecurity(), and builds it from forRootAsync's factory", async () => {
    @Injectable()
    class Uses {
      constructor(@InjectSecurity() readonly security: Security<BunRequest>) {}
    }
    @Module({
      providers: [{ provide: "LIMIT", useValue: 1 }],
      exports: ["LIMIT"],
    })
    class ConfigModule {}
    const { app, adapter } = await boot(
      [
        SecurityModule.forRootAsync({
          imports: [ConfigModule],
          inject: ["LIMIT"],
          useFactory: (limit: number) => ({
            policy: { limits: [{ id: "ip", limit, window: "1m" }] },
            logger: () => {},
          }),
        }),
      ],
      [AppController],
      [Uses],
    );
    expect(app.get(Uses).security).toBe(app.get(SecurityService).security);
    expect((await adapter.fetch("/x", from("198.51.100.8"))).status).toBe(200);
    expect((await adapter.fetch("/x", from("198.51.100.8"))).status).toBe(429);
  });

  it("closes an engine it made on shutdown, never one it was given", async () => {
    const given = createSecurity<BunRequest>({ policy: {}, logger: () => {} });
    const withGiven = await boot(
      [SecurityModule.forRoot({ security: given, logger: () => {} })],
      [AppController],
    );
    const made = await boot([secured()], [AppController]);
    const madeEngine = made.app.get(SecurityService).security;
    await withGiven.app.close();
    await made.app.close();
    apps.splice(0);
    expect([given.closed, madeEngine.closed]).toEqual([false, true]);
  });

  it("refuses both an engine and a policy, and an adapter that is not bun-nest's", () => {
    const given = createSecurity<BunRequest>({ policy: {} });
    expect(
      () =>
        new SecurityService(
          { security: given, policy: {} } as unknown as ConstructorParameters<
            typeof SecurityService
          >[0],
          new BunHttpAdapter(),
        ),
    ).toThrow(ConfigError);
    expect(() => new SecurityService({ policy: {} }, {})).toThrow(ConfigError);
  });
});

describe("SecurityModule: the boot self-test", () => {
  it("fails without a SecurityGuard, and passes with @UseGuards(SecurityGuard)", async () => {
    const failure = await boot(
      [secured({ globalGuard: false })],
      [AppController],
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConfigError);
    expect(String((failure as Error).message)).toContain(
      "no SecurityGuard is installed",
    );
    @Controller("guarded")
    @UseGuards(SecurityGuard)
    class Guarded {
      @Get()
      get() {
        return "g";
      }
    }
    const { adapter } = await boot(
      [
        secured({
          globalGuard: false,
          policy: { lists: [{ user: "mallory", action: "block" }] },
        }),
      ],
      [Guarded],
    );
    expect(
      (await adapter.fetch("/guarded", { headers: { "x-user": "mallory" } }))
        .status,
    ).toBe(403);
  });

  it("fails when the early stage is bypassed", async () => {
    class Bypassing extends BunHttpAdapter {
      protected override async handleNativeRequest(
        request: Request,
      ): Promise<Response> {
        void request;
        return new Response("bypassed");
      }
    }
    const failure = await boot(
      [secured()],
      [AppController],
      [],
      new Bypassing(),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(String((failure as Error).message)).toContain(
      "the early stage (the adapter's before-read hook) did not see it",
    );
    const off = await boot(
      [secured({ selfTest: false })],
      [AppController],
      [],
      new Bypassing(),
    );
    expect((await off.adapter.fetch("/x")).status).toBe(200);
  });
});
