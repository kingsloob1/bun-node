/**
 * `BunJobsApiModule` on `BunJobsModule`'s context, and `guardsAuthorize` (plan §9.4).
 *
 * `authorize` is an auth path, so most of this is about what is refused, on both transports,
 * and about what a guard that fails does: over HTTP through the adapter with no socket, and
 * over a real WebSocket for channels. A denial is checked by what it stopped, not only by
 * its status: the queue stays unpaused, the events do not arrive.
 *
 * `reflect-metadata` is imported last, as the other suites do.
 */
import type { BunRequest, LogEvent } from "@kingsleyweb/bun-common";
import type {
  BunJobs,
  BunQueue,
  JobsApi,
  JobsApiAuthorizeContext,
} from "@kingsleyweb/bun-jobs";
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Type,
} from "@nestjs/common";
import { ConfigError, noopLogger } from "@kingsleyweb/bun-common";
import { MemoryDriver } from "@kingsleyweb/bun-jobs";
import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Module,
  Scope,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ModuleRef, NestFactory, Reflector, REQUEST } from "@nestjs/core";
import { afterEach, describe, expect, it } from "bun:test";
import { EMPTY, of, throwError } from "rxjs";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  BUN_JOBS_API,
  BunJobsApiModule,
  BunJobsModule,
  getBunJobsToken,
  guardsAuthorize,
  jobsApiContextOf,
} from "../lib/jobs/index";
import { connectWs } from "./helpers";
import "reflect-metadata";

const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const BASE = "/admin/jobs";

const Roles = Reflector.createDecorator<string[]>();

/** The methods stand for the API's routes, carrying what the role guard reads. */
class Policy {
  @Roles(["reader", "admin"])
  read() {}

  @Roles(["admin"])
  mutate() {}
}

@Injectable()
class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const role = context
      .switchToHttp()
      .getRequest<BunRequest>()
      .getHeader("x-role");
    if (role === null) {
      throw new UnauthorizedException("Sign in first");
    }
    return (this.reflector.get(Roles, context.getHandler()) ?? []).includes(
      role,
    );
  }
}

interface Booted {
  app: INestApplication;
  adapter: BunHttpAdapter;
  jobs: BunJobs;
  queue: BunQueue;
}

/** An application with the API on `BunJobsModule`'s context, guarded as told. */
async function boot(
  guards: (moduleRef: ModuleRef) => Parameters<typeof guardsAuthorize>[1],
  options: {
    providers?: Type<unknown>[];
    policy?: typeof Policy;
    logger?: (event: LogEvent) => void;
    adapter?: BunHttpAdapter;
    listen?: boolean;
    controllers?: Type<unknown>[];
    websocket?: false;
  } = {},
): Promise<Booted> {
  @Module({
    imports: [
      BunJobsModule.forRoot({
        namespace: `guards-${crypto.randomUUID()}`,
        driver: new MemoryDriver(),
        publishEvents: true,
        logger: false,
      }),
      BunJobsApiModule.forRootAsync({
        inject: [ModuleRef],
        useFactory: (moduleRef: ModuleRef) => ({
          basePath: BASE,
          logger: noopLogger,
          ...(options.websocket === false ? { websocket: false } : {}),
          authorize: guardsAuthorize(moduleRef, guards(moduleRef), {
            policy: options.policy ?? Policy,
            logger: options.logger ?? noopLogger,
          }),
        }),
      }),
    ],
    providers: options.providers ?? [RolesGuard],
    controllers: options.controllers ?? [],
  })
  class AppModule {}

  const adapter = options.adapter ?? new BunHttpAdapter(30000);
  const app = (await NestFactory.create(AppModule, adapter, {
    logger: false,
  })) as INestApplication;
  app.useWebSocketAdapter(adapter.webSocketAdapter);
  cleanups.push(() => app.close());
  if (options.listen === true) {
    await app.listen(0);
  } else {
    await app.init();
  }
  const jobs = app.get<BunJobs>(getBunJobsToken(), { strict: false });
  const queue = jobs.queue("emails");
  await queue.add("welcome", {});
  return { app, adapter, jobs, queue };
}

/** A request through the adapter's real pipeline, with no port. */
async function call(
  { adapter }: Booted,
  method: string,
  path: string,
  role?: string,
) {
  const response = await adapter.fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(role === undefined ? {} : { "x-role": role }),
    },
    ...(method === "GET" ? {} : { body: "{}" }),
  });
  const body = (await response.json()) as {
    code?: string;
    type?: string;
    detail?: string;
  };
  return { status: response.status, body };
}

/** What a denial stopped: pausing was tried, and the queue is not paused. */
async function expectPauseDenied(
  booted: Booted,
  role: string | undefined,
  status: 401 | 403,
  code: "UNAUTHORIZED" | "FORBIDDEN",
) {
  const answer = await call(booted, "POST", "/queues/emails/pause", role);
  expect(answer.status).toBe(status);
  expect(answer.body.code).toBe(code);
  expect(answer.body.type).toBe(`urn:bun-jobs:error:${code}`);
  expect(await booted.queue.isPaused()).toBe(false);
  return answer;
}

describe("BunJobsApiModule on BunJobsModule's context", () => {
  /** Boots a module, answering the API. */
  async function apiOf(
    metadata: Parameters<typeof Module>[0],
  ): Promise<{ app: INestApplication }> {
    @Module(metadata)
    class AppModule {}

    const app = (await NestFactory.create(
      AppModule,
      new BunHttpAdapter(30000),
      { logger: false, abortOnError: false },
    )) as INestApplication;
    cleanups.push(() => app.close());
    await app.init();
    return { app };
  }

  /** The queues a listing names. */
  async function namesIn(response: Response): Promise<string[]> {
    const { items } = (await response.json()) as { items: { name: string }[] };
    return items.map((queue) => queue.name);
  }

  const context = (name?: string) =>
    BunJobsModule.forRoot({
      ...(name === undefined ? {} : { name }),
      namespace: `ctx-${name ?? "default"}-${crypto.randomUUID()}`,
      driver: new MemoryDriver(),
      logger: false,
    });

  it("takes the unnamed context when the options name nothing to manage", async () => {
    const { app } = await apiOf({
      imports: [
        context(),
        BunJobsApiModule.forRoot({
          basePath: BASE,
          allowUnauthenticated: true,
          logger: noopLogger,
        }),
      ],
    });
    const jobs = app.get<BunJobs>(getBunJobsToken(), { strict: false });
    await jobs.queue("from-the-context").add("x", {});

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .fetch(`${BASE}/queues`);
    expect(await namesIn(response)).toEqual(["from-the-context"]);
  });

  for (const how of ["forRoot", "forRootAsync"] as const) {
    it(`${how}: a named context is the one taken`, async () => {
      const module =
        how === "forRoot"
          ? BunJobsApiModule.forRoot({
              context: "other",
              basePath: BASE,
              allowUnauthenticated: true,
              logger: noopLogger,
            })
          : BunJobsApiModule.forRootAsync({
              context: "other",
              useFactory: () => ({
                basePath: BASE,
                allowUnauthenticated: true,
                logger: noopLogger,
              }),
            });
      const { app } = await apiOf({
        imports: [context(), context("other"), module],
      });
      await app
        .get<BunJobs>(getBunJobsToken(), { strict: false })
        .queue("in-the-default")
        .add("x", {});
      await app
        .get<BunJobs>(getBunJobsToken("other"), { strict: false })
        .queue("in-the-other")
        .add("x", {});

      const response = await app
        .getHttpAdapter()
        .getInstance()
        .fetch(`${BASE}/queues`);
      expect(await namesIn(response)).toEqual(["in-the-other"]);
    });
  }

  it("with no context to take, createJobsApi's own ConfigError stands", async () => {
    await expect(
      apiOf({
        imports: [
          BunJobsApiModule.forRoot({
            basePath: BASE,
            allowUnauthenticated: true,
            logger: noopLogger,
          }),
        ],
      }),
    ).rejects.toThrow(/createJobsApi needs `jobs`/);
  });

  it("a context named but absent is that same ConfigError, not the unnamed one", async () => {
    await expect(
      apiOf({
        imports: [
          context(),
          BunJobsApiModule.forRoot({
            context: "absent",
            basePath: BASE,
            allowUnauthenticated: true,
            logger: noopLogger,
          }),
        ],
      }),
    ).rejects.toThrow(/createJobsApi needs `jobs`/);
  });

  it("jobs in the options win, and the context is left alone", async () => {
    const own = (await apiOf({ imports: [context()] })).app.get<BunJobs>(
      getBunJobsToken(),
      { strict: false },
    );
    await own.queue("given").add("x", {});
    const { app } = await apiOf({
      imports: [
        context(),
        BunJobsApiModule.forRoot({
          jobs: own,
          basePath: BASE,
          allowUnauthenticated: true,
          logger: noopLogger,
        }),
      ],
    });

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .fetch(`${BASE}/queues`);
    expect(await namesIn(response)).toEqual(["given"]);
  });

  it("closes without closing the context under it first", async () => {
    const { app } = await apiOf({
      imports: [
        context(),
        BunJobsApiModule.forRoot({
          basePath: BASE,
          allowUnauthenticated: true,
          logger: noopLogger,
        }),
      ],
    });
    const api = app.get<JobsApi>(BUN_JOBS_API, { strict: false });
    expect(api.basePath).toBe(BASE);
    await app.close();
  });
});

describe("guardsAuthorize over HTTP", () => {
  it("a role guard: 200, 403 and 401 per role, the code from the closed set", async () => {
    const booted = await boot(() => [RolesGuard]);

    expect((await call(booted, "GET", "/queues", "reader")).status).toBe(200);
    expect((await call(booted, "GET", "/queues", "admin")).status).toBe(200);

    const nobody = await call(booted, "GET", "/queues", "nobody");
    expect(nobody.status).toBe(403);
    expect(nobody.body.code).toBe("FORBIDDEN");
    const anonymous = await call(booted, "GET", "/queues");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe("UNAUTHORIZED");
    expect(anonymous.body.detail).toBe("Sign in first");

    await expectPauseDenied(booted, "reader", 403, "FORBIDDEN");
    await expectPauseDenied(booted, undefined, 401, "UNAUTHORIZED");

    const admin = await call(booted, "POST", "/queues/emails/pause", "admin");
    expect(admin.status).toBe(200);
    expect(await booted.queue.isPaused()).toBe(true);
  });

  it("a controller beside the API is untouched", async () => {
    @Controller("health")
    class Health {
      @Get()
      ok() {
        return { ok: true };
      }
    }

    const booted = await boot(() => [RolesGuard], {
      controllers: [Health],
    });

    expect((await booted.adapter.fetch("/health")).status).toBe(200);
  });

  const failing: [string, () => unknown, RegExp | undefined][] = [
    [
      "throws an Error",
      () => {
        throw new Error("secret: db at 10.0.0.9");
      },
      /secret/,
    ],
    [
      "throws something that is not an Error",
      () => {
        // eslint-disable-next-line no-throw-literal -- what a guard can do
        throw "secret string";
      },
      /secret/,
    ],
    [
      "throws null",
      () => {
        // eslint-disable-next-line no-throw-literal -- what a guard can do
        throw null;
      },
      undefined,
    ],
    [
      "rejects",
      async () => {
        await Bun.sleep(1);
        throw new Error("secret: rejected");
      },
      /secret/,
    ],
    [
      "errors as an Observable",
      () => throwError(() => new Error("secret: observable")),
      /secret/,
    ],
    ["completes empty as an Observable", () => EMPTY, undefined],
    [
      "throws a 5xx exception",
      () => {
        throw new ServiceUnavailableException("secret: the auth service");
      },
      /secret/,
    ],
    [
      "has no canActivate of its own",
      () => {
        throw new TypeError("secret");
      },
      /secret/,
    ],
  ];

  for (const [name, canActivate, leak] of failing) {
    it(`a guard that ${name} denies, logs it and tells the caller nothing`, async () => {
      const logged: LogEvent[] = [];
      const booted = await boot(() => [{ canActivate } as CanActivate], {
        logger: (event) => logged.push(event),
      });

      const answer = await expectPauseDenied(booted, "admin", 403, "FORBIDDEN");

      if (leak !== undefined) {
        expect(JSON.stringify(answer.body)).not.toMatch(leak);
      }
      expect(logged.map((event) => event.level)).toContain("error");
      const read = await call(booted, "GET", "/queues", "admin");
      expect(read.status).toBe(403);
    });
  }

  const refusing: [string, () => unknown][] = [
    ["answers false", () => false],
    ["answers nothing", () => undefined],
    ["answers null", () => null],
    ["answers 0", () => 0],
    ["resolves false", async () => false],
    ["answers false as an Observable", () => of(false)],
  ];

  for (const [name, canActivate] of refusing) {
    it(`a guard that ${name} denies`, async () => {
      const booted = await boot(() => [{ canActivate } as CanActivate]);

      await expectPauseDenied(booted, "admin", 403, "FORBIDDEN");
    });
  }

  for (const [name, canActivate] of [
    ["answers true", () => true],
    ["resolves true", async () => true],
    ["answers true as an Observable", () => of(true)],
  ] as const) {
    it(`the control: a guard that ${name} allows`, async () => {
      const booted = await boot(() => [{ canActivate } as CanActivate]);

      const answer = await call(booted, "POST", "/queues/emails/pause");
      expect(answer.status).toBe(200);
      expect(await booted.queue.isPaused()).toBe(true);
    });
  }

  it("the exceptions: 401 for Unauthorized; 403 for Forbidden and other 4xx, with their message", async () => {
    let thrown: unknown;
    const booted = await boot(() => [
      {
        canActivate: () => {
          throw thrown;
        },
      },
    ]);

    thrown = new UnauthorizedException("who are you");
    const unauthorized = await expectPauseDenied(
      booted,
      "x",
      401,
      "UNAUTHORIZED",
    );
    expect(unauthorized.body.detail).toBe("who are you");

    thrown = new ForbiddenException("not you");
    const forbidden = await expectPauseDenied(booted, "x", 403, "FORBIDDEN");
    expect(forbidden.body.detail).toBe("not you");
  });

  it("every guard must allow, in order, and the first refusal ends it", async () => {
    const asked: string[] = [];
    const guard = (name: string, answer: boolean): CanActivate => ({
      canActivate: () => {
        asked.push(name);
        return answer;
      },
    });
    const booted = await boot(() => [
      guard("first", true),
      guard("second", false),
      guard("third", true),
    ]);

    await expectPauseDenied(booted, "admin", 403, "FORBIDDEN");

    expect(asked).toEqual(["first", "second"]);
  });

  it("an empty list is refused, since it would allow everyone", () => {
    expect(() => guardsAuthorize({} as ModuleRef, [])).toThrow(ConfigError);
    expect(() => guardsAuthorize({} as ModuleRef, [])).toThrow(
      /allow everyone/,
    );
  });

  it("a policy without read and mutate is refused", () => {
    class Wrong {}

    expect(() =>
      guardsAuthorize({} as ModuleRef, [{ canActivate: () => true }], {
        policy: Wrong as never,
      }),
    ).toThrow(/read and mutate/);
  });

  it("the default policy has no metadata, so a role guard refuses", async () => {
    @Injectable()
    class NoPolicyGuard extends RolesGuard {}

    const booted = await boot(() => [NoPolicyGuard], {
      providers: [NoPolicyGuard],
      policy: class {
        read() {}

        mutate() {}
      } as typeof Policy,
    });

    await expectPauseDenied(booted, "admin", 403, "FORBIDDEN");
  });

  it("finds a guard that is a provider, builds one that is not, once and with DI", async () => {
    let builds = 0;

    @Injectable()
    class Unprovided implements CanActivate {
      constructor(@Inject(Reflector) readonly reflector: Reflector) {
        builds++;
      }

      canActivate() {
        return this.reflector instanceof Reflector;
      }
    }

    const booted = await boot(() => [Unprovided]);

    expect((await call(booted, "GET", "/queues")).status).toBe(200);
    expect((await call(booted, "GET", "/queues")).status).toBe(200);
    expect(builds).toBe(1);
  });

  it("a guard that cannot be built denies", async () => {
    @Injectable()
    class Unbuildable implements CanActivate {
      constructor(@Inject("NOT-PROVIDED") readonly missing: unknown) {}

      canActivate() {
        return true;
      }
    }

    const logged: LogEvent[] = [];
    const booted = await boot(() => [Unbuildable], {
      logger: (event) => logged.push(event),
    });

    await expectPauseDenied(booted, "admin", 403, "FORBIDDEN");
    expect(logged.map((event) => event.level)).toContain("error");
  });

  it("a request-scoped guard gets the request", async () => {
    @Injectable({ scope: Scope.REQUEST })
    class ScopedGuard implements CanActivate {
      constructor(@Inject(REQUEST) readonly request: BunRequest) {}

      canActivate() {
        return this.request.getHeader("x-role") === "admin";
      }
    }

    const booted = await boot(() => [ScopedGuard], {
      providers: [ScopedGuard],
    });

    expect((await call(booted, "GET", "/queues", "admin")).status).toBe(200);
    await expectPauseDenied(booted, "reader", 403, "FORBIDDEN");
  });

  it("the context is http, on the request, with what is being decided", async () => {
    const seen: {
      type: string;
      told: JobsApiAuthorizeContext | undefined;
      className: string;
      handler: string;
      sameRequest: boolean;
      response: unknown;
    }[] = [];
    const booted = await boot(() => [
      {
        canActivate(context: ExecutionContext) {
          seen.push({
            type: context.getType(),
            told: jobsApiContextOf(context),
            className: context.getClass().name,
            handler: context.getHandler().name,
            sameRequest:
              context.switchToHttp().getRequest() === context.getArgByIndex(0),
            response: context.switchToHttp().getResponse(),
          });
          return true;
        },
      },
    ]);

    await call(booted, "GET", "/queues");
    await call(booted, "POST", "/queues/emails/pause");

    expect(seen[0]).toMatchObject({
      type: "http",
      className: "Policy",
      handler: "read",
      sameRequest: true,
      told: { action: "queues.list", mutation: false, transport: "http" },
    });
    expect(seen[1]).toMatchObject({
      handler: "mutate",
      told: {
        action: "queues.pause",
        mutation: true,
        transport: "http",
        queue: "emails",
      },
    });
    expect(seen[0]?.response).toBeUndefined();
  });

  it("a guard asking for rpc or ws fails, and so denies", async () => {
    const booted = await boot(() => [
      {
        canActivate(context: ExecutionContext) {
          context.switchToWs();
          return true;
        },
      },
    ]);

    await expectPauseDenied(booted, "admin", 403, "FORBIDDEN");
  });

  it("jobsApiContextOf answers undefined on a controller, so one guard serves both", async () => {
    const told: unknown[] = [];

    @Injectable()
    class Both implements CanActivate {
      canActivate(context: ExecutionContext) {
        told.push(jobsApiContextOf(context));
        return true;
      }
    }

    @Controller("mine")
    class Mine {
      @Get()
      @UseGuards(Both)
      ok() {
        return { ok: true };
      }
    }

    const booted = await boot(() => [Both], {
      providers: [Both],
      controllers: [Mine],
    });

    expect((await booted.adapter.fetch("/mine")).status).toBe(200);
    expect(told).toEqual([undefined]);
    await call(booted, "GET", "/queues");
    expect(told[1]).toMatchObject({ action: "queues.list" });
  });

  it("a guard reads req.ip under trustProxy, driven by fetch({ remoteAddress })", async () => {
    const booted = await boot(
      () => [
        {
          canActivate: (context: ExecutionContext) =>
            context.switchToHttp().getRequest<BunRequest>().ip ===
            "203.0.113.7",
        },
      ],
      { adapter: new BunHttpAdapter(30000, { trustProxy: ["10.0.0.0/8"] }) },
    );
    const fetchIt = async (remoteAddress: string, forwarded?: string) =>
      (
        await booted.adapter.fetch(`${BASE}/queues`, {
          remoteAddress,
          ...(forwarded === undefined
            ? {}
            : { headers: { "x-forwarded-for": forwarded } }),
        })
      ).status;

    // Through the trusted proxy, the client it names.
    expect(await fetchIt("10.0.0.1", "203.0.113.7")).toBe(200);
    expect(await fetchIt("10.0.0.1", "198.51.100.1")).toBe(403);
    // From an untrusted peer, the header is not believed.
    expect(await fetchIt("198.51.100.1", "203.0.113.7")).toBe(403);
    expect(await fetchIt("203.0.113.7")).toBe(200);
  });

  it("one value serves a jobs UI's authorize, told { asset, path }", async () => {
    const seen: unknown[] = [];
    const moduleRef = {} as ModuleRef;
    const authorize = guardsAuthorize(moduleRef, [
      {
        canActivate(context: ExecutionContext) {
          const told = jobsApiContextOf<{ asset: boolean; path: string }>(
            context,
          );
          seen.push({ told, handler: context.getHandler().name });
          return told?.asset === true;
        },
      },
    ]);
    const req = {} as BunRequest;

    expect(await authorize(req, { asset: true, path: "/a.js" })).toBe(true);
    expect(await authorize(req, { asset: false, path: "/queues" })).toEqual({
      allow: false,
      status: 403,
    });
    expect(seen[0]).toEqual({
      told: { asset: true, path: "/a.js" },
      handler: "read",
    });
  });
});

describe("guardsAuthorize over the WebSocket", () => {
  /** A listening app's socket URL. */
  const urlOf = (booted: Booted) =>
    `ws://127.0.0.1:${booted.adapter.listeningPort}${BASE}/ws`;

  /** A client on the socket that has said hello. */
  async function connected(booted: Booted, role?: string) {
    const client = await connectWs(
      urlOf(booted),
      5_000,
      role === undefined ? undefined : { "x-role": role },
    );
    cleanups.push(() => client.socket.close());
    await client.waitFor((message) => message?.type === "hello", 5_000);
    return client;
  }

  /**
   * What an upgrade is told when it is refused, through the adapter's pipeline, and that a
   * real client cannot connect and no session opens.
   */
  async function expectUpgradeRefused(
    booted: Booted,
    role: string | undefined,
    status: 401 | 403,
    code: "UNAUTHORIZED" | "FORBIDDEN",
  ) {
    const headers = role === undefined ? undefined : { "x-role": role };
    await expect(connectWs(urlOf(booted), 5_000, headers)).rejects.toThrow(
      /errored connecting/,
    );
    const response = await booted.adapter.fetch(`${BASE}/ws`, {
      headers: {
        upgrade: "websocket",
        connection: "upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    const problem = (await response.json()) as { code?: string };
    expect([response.status, problem.code]).toEqual([status, code]);
    expect(JSON.stringify(problem)).not.toContain("secret");
    const api = booted.app.get<JobsApi>(BUN_JOBS_API, { strict: false });
    expect(api.websocket!.sessions).toBe(0);
  }

  /** Subscribes, answering the ack. */
  async function subscribe(
    client: Awaited<ReturnType<typeof connected>>,
    channels: string[],
  ) {
    const id = crypto.randomUUID();
    client.send({ op: "subscribe", id, channels });
    return await client.waitFor(
      (message) => message?.type === "ack" && message.id === id,
      5_000,
    );
  }

  /** The events a client has been sent that mention a queue. */
  const eventsOf = (
    client: Awaited<ReturnType<typeof connected>>,
    queue: string,
  ) =>
    client.received
      .map((raw) => JSON.parse(raw))
      .filter(
        (message) =>
          message.type === "event" && JSON.stringify(message).includes(queue),
      );

  /** What fails, at either stage of the socket. */
  const FAILURES = [
    [
      "throws",
      () => {
        throw new Error("secret");
      },
    ],
    [
      "rejects",
      async () => {
        throw new Error("secret");
      },
    ],
    ["errors as an Observable", () => throwError(() => new Error("secret"))],
    ["answers nothing", () => undefined],
    ["answers false", () => false],
  ] as const;

  it("a role guard: a reader connects and gets events; a refused role and an anonymous caller are stopped at the upgrade", async () => {
    const booted = await boot(() => [RolesGuard], { listen: true });

    await expectUpgradeRefused(booted, "nobody", 403, "FORBIDDEN");
    await expectUpgradeRefused(booted, undefined, 401, "UNAUTHORIZED");

    const reader = await connected(booted, "reader");
    const ack = await subscribe(reader, ["queue/emails"]);
    expect(ack.channels).toEqual(["queue/emails"]);
    expect(ack.rejected).toBeUndefined();
    await booted.queue.add("after", {});
    await reader.waitFor((message) => message?.type === "event", 5_000);
    expect(eventsOf(reader, "emails").length).toBeGreaterThan(0);
  });

  for (const [name, canActivate] of FAILURES) {
    it(`a guard that ${name} at the upgrade refuses it`, async () => {
      const booted = await boot(
        () => [{ canActivate: canActivate as () => boolean }],
        { listen: true },
      );

      await expectUpgradeRefused(booted, "admin", 403, "FORBIDDEN");
    });

    it(`a guard that ${name} on a channel refuses it, and nothing arrives`, async () => {
      const booted = await boot(
        () => [
          {
            canActivate: (context: ExecutionContext) =>
              jobsApiContextOf(context)?.action === "events.connect"
                ? true
                : (canActivate as () => boolean)(),
          },
        ],
        { listen: true },
      );
      const client = await connected(booted, "admin");

      const ack = await subscribe(client, ["queue/emails"]);

      expect(ack.channels).toEqual([]);
      expect(ack.rejected).toMatchObject([
        { channel: "queue/emails", code: "FORBIDDEN", status: 403 },
      ]);
      expect(JSON.stringify(ack)).not.toContain("secret");
      await booted.queue.add("after", {});
      await Bun.sleep(100);
      expect(eventsOf(client, "emails")).toEqual([]);
    });
  }

  it("the control: a guard that allows lets the same channel through", async () => {
    const booted = await boot(() => [{ canActivate: () => true }], {
      listen: true,
    });
    const client = await connected(booted, "admin");

    const ack = await subscribe(client, ["queue/emails"]);

    expect(ack.channels).toEqual(["queue/emails"]);
    await booted.queue.add("after", {});
    await client.waitFor((message) => message?.type === "event", 5_000);
    expect(eventsOf(client, "emails").length).toBeGreaterThan(0);
  });

  it("an exception on a channel is its status there: 401, with its message", async () => {
    const booted = await boot(
      () => [
        {
          canActivate(context: ExecutionContext) {
            if (jobsApiContextOf(context)?.action === "events.connect") {
              return true;
            }
            throw new UnauthorizedException("Your session ended");
          },
        },
      ],
      { listen: true },
    );
    const client = await connected(booted);

    const ack = await subscribe(client, ["queue/emails"]);

    expect(ack.rejected).toMatchObject([
      {
        channel: "queue/emails",
        code: "UNAUTHORIZED",
        status: 401,
        detail: "Your session ended",
      },
    ]);
  });

  it("a broad channel: a guard refusing one queue drops only that queue's events", async () => {
    const told: JobsApiAuthorizeContext[] = [];
    const booted = await boot(
      () => [
        {
          canActivate(context: ExecutionContext) {
            const decided = jobsApiContextOf(context)!;
            told.push(decided);
            return decided.queue !== "secret";
          },
        },
      ],
      { listen: true },
    );
    const client = await connected(booted, "reader");

    const ack = await subscribe(client, ["all"]);
    expect(ack.channels).toEqual(["all"]);

    await booted.jobs.queue("secret").add("hidden", {});
    await booted.jobs.queue("open").add("shown", {});
    await client.waitFor(
      (message) =>
        message?.type === "event" && JSON.stringify(message).includes("open"),
      5_000,
    );
    await Bun.sleep(100);

    expect(eventsOf(client, "open").length).toBeGreaterThan(0);
    expect(eventsOf(client, "secret")).toEqual([]);
    expect(told.some((one) => one.queue === "secret")).toBe(true);
    expect(told.every((one) => one.transport === "ws")).toBe(true);
    expect(told[0]).toMatchObject({
      action: "events.connect",
      mutation: false,
    });
    expect(told.find((one) => one.channel === "all")).toMatchObject({
      action: "events.subscribe",
      mutation: false,
    });
  });

  it("a guard sees the upgrade's request, the same on every channel", async () => {
    const roles: (string | null)[] = [];
    const booted = await boot(
      () => [
        {
          canActivate(context: ExecutionContext) {
            roles.push(
              context
                .switchToHttp()
                .getRequest<BunRequest>()
                .getHeader("x-role"),
            );
            return true;
          },
        },
      ],
      { listen: true },
    );
    const client = await connected(booted, "reader");

    await subscribe(client, ["queue/a"]);
    await subscribe(client, ["queue/b"]);

    expect(roles).toEqual(["reader", "reader", "reader"]);
  });

  it("a request-scoped guard on the socket gets the upgrade's request", async () => {
    @Injectable({ scope: Scope.REQUEST })
    class ScopedGuard implements CanActivate {
      constructor(@Inject(REQUEST) readonly request: BunRequest) {}

      canActivate() {
        return this.request.getHeader("x-role") === "admin";
      }
    }

    const booted = await boot(() => [ScopedGuard], {
      providers: [ScopedGuard],
      listen: true,
    });

    await expectUpgradeRefused(booted, "reader", 403, "FORBIDDEN");
    const admin = await connected(booted, "admin");
    expect((await subscribe(admin, ["queue/a"])).channels).toEqual(["queue/a"]);
  });
});
