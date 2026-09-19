/**
 * `@kingsleyweb/bun-nest/jobs`: the management API as a NestJS module.
 *
 * The gateways are declared inside `beforeAll`-style factories rather than at
 * module scope, and `reflect-metadata` is imported last, for the reason the
 * other gateway suites give: a top-level `await` perturbs decorator metadata
 * across files.
 */
import type { JobsApi } from "@kingsleyweb/bun-jobs";
import type { INestApplication } from "@nestjs/common";
import type { WsTestClient } from "./helpers";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { MessageEventTypes } from "../lib/BunWebSocketAdapter";
import {
  BUN_JOBS_API,
  BunJobsApiModule,
  InjectJobsApi,
} from "../lib/jobs/index";
import { connectWs } from "./helpers";
import "reflect-metadata";

/** Applications and contexts to tear down after each test. */
const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A jobs context over the memory driver, closed afterwards. */
function jobsContext(): BunJobs {
  const jobs = new BunJobs({
    namespace: `nest-api-${Math.random().toString(36).slice(2, 8)}`,
    driver: new MemoryDriver(),
    publishEvents: true,
  });
  cleanups.push(() => jobs.close());
  return jobs;
}

/** Starts a Nest app on `BunHttpAdapter`, listening on an OS-assigned port. */
async function startApp(
  moduleClass: new () => unknown,
  options: { listen?: boolean } = {},
) {
  const adapter = new BunHttpAdapter(30000);
  const app = (await NestFactory.create(moduleClass, adapter, {
    logger: false,
  })) as INestApplication;
  app.useWebSocketAdapter(adapter.webSocketAdapter);
  cleanups.push(() => app.close());
  if (options.listen === false) {
    await app.init();
  } else {
    await app.listen(0);
  }
  return { app, adapter };
}

describe("BunJobsApiModule.forRoot", () => {
  it("mounts the API, serves its routes, and provides the JobsApi", async () => {
    const jobs = jobsContext();

    @Injectable()
    class Probe {
      constructor(@InjectJobsApi() readonly api: JobsApi) {}
    }

    @Module({
      imports: [
        BunJobsApiModule.forRoot({
          jobs,
          basePath: "/admin/jobs",
          authorize: () => true,
        }),
      ],
      providers: [Probe],
    })
    class AppModule {}

    const { app, adapter } = await startApp(AppModule, { listen: false });

    const meta = await adapter.fetch("/admin/jobs/meta");
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({ protocol: 1, readOnly: false });

    const openapi = await adapter.fetch("/admin/jobs/openapi.json");
    expect(openapi.status).toBe(200);
    expect(await openapi.json()).toMatchObject({ openapi: "3.1.0" });

    // `@InjectJobsApi()` resolves the very API the module built.
    const probe = app.get(Probe);
    expect(probe.api).toBe(app.get<JobsApi>(BUN_JOBS_API));
    expect(probe.api.basePath).toBe("/admin/jobs");

    // The control: a path the API does not route still reaches the host's
    // 404 rather than being swallowed by the mount.
    const missing = await adapter.fetch("/not-the-api");
    expect(missing.status).toBe(404);
  });

  it("honours readOnly and authorize through the module's options", async () => {
    const jobs = jobsContext();

    @Module({
      imports: [
        BunJobsApiModule.forRoot({
          jobs,
          basePath: "/admin/jobs",
          readOnly: true,
          authorize: (_req, context) => context.action !== "queues.list",
        }),
      ],
    })
    class AppModule {}

    const { adapter } = await startApp(AppModule, { listen: false });

    // Denied by `authorize`.
    const queues = await adapter.fetch("/admin/jobs/queues");
    expect(queues.status).toBe(403);
    expect(await queues.json()).toMatchObject({ code: "FORBIDDEN" });

    // Pruned by `readOnly`: a mutating route is not registered at all.
    const pause = await adapter.fetch("/admin/jobs/queues/mail/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(pause.status).toBe(404);

    // The control: an allowed read still answers.
    expect((await adapter.fetch("/admin/jobs/meta")).status).toBe(200);
  });
});

describe("BunJobsApiModule.forRootAsync", () => {
  it("builds its options from injected providers", async () => {
    const jobs = jobsContext();

    @Injectable()
    class AuthService {
      /** Records what it was asked, so the test can prove it was consulted. */
      readonly asked: string[] = [];
      can(action: string): boolean {
        this.asked.push(action);
        return true;
      }
    }

    @Module({ providers: [AuthService], exports: [AuthService] })
    class AuthModule {}

    @Module({
      imports: [
        BunJobsApiModule.forRootAsync({
          imports: [AuthModule],
          inject: [AuthService],
          useFactory: (auth: AuthService) => ({
            jobs,
            basePath: "/ops/jobs",
            authorize: (_req, context) => auth.can(context.action),
          }),
        }),
      ],
    })
    class AppModule {}

    const { app, adapter } = await startApp(AppModule, { listen: false });

    expect((await adapter.fetch("/ops/jobs/meta")).status).toBe(200);
    expect(app.get<JobsApi>(BUN_JOBS_API).basePath).toBe("/ops/jobs");
    // The factory's injected dependency really decided the request.
    expect(app.get(AuthService).asked).toContain("meta.read");

    // The control: the base path came from the factory, not a default.
    expect((await adapter.fetch("/admin/jobs/meta")).status).toBe(404);
  });
});

describe("the live-events socket under Nest", () => {
  it("serves the socket beside a gateway, and neither sees the other's clients", async () => {
    const jobs = jobsContext();
    /** Clients the gateway accepted. */
    const gatewayConnections: string[] = [];

    @WebSocketGateway({ namespace: "/chat" })
    class ChatGateway {
      handleConnection() {
        gatewayConnections.push("chat");
      }

      @SubscribeMessage("who")
      who() {
        return { event: "who", data: "chat" };
      }
    }

    @Module({
      imports: [
        BunJobsApiModule.forRoot({
          jobs,
          basePath: "/admin/jobs",
          authorize: () => true,
        }),
      ],
      providers: [ChatGateway],
    })
    class AppModule {}

    const { adapter } = await startApp(AppModule);
    const base = `ws://127.0.0.1:${adapter.listeningPort}`;

    // Ours: greeted with `hello` by the jobs API.
    const api = await connectWs(`${base}/admin/jobs/ws`);
    const hello = await api.waitFor((message) => message?.type === "hello");
    expect(hello).toMatchObject({ protocol: 1, mode: "both" });
    // The gateway did not see our client.
    expect(gatewayConnections).toEqual([]);

    // Theirs: the gateway answers, and the jobs API never greets it.
    const chat: WsTestClient = await connectWs(`${base}/chat`);
    chat.send({
      type: MessageEventTypes.EVENT,
      namespace: "/chat",
      data: ["who"],
    });
    const reply = await chat.waitFor((message) => message?.data?.[0] === "who");
    expect(reply.data[1]).toBe("chat");
    expect(gatewayConnections).toEqual(["chat"]);
    expect(
      chat.received.some((frame) => frame.includes('"type":"hello"')),
    ).toBe(false);

    await api.close();
    await chat.close();
  });

  it("serves the socket on its own port when asked, and not on the HTTP one", async () => {
    const jobs = jobsContext();

    @Module({
      imports: [
        BunJobsApiModule.forRoot({
          jobs,
          basePath: "/admin/jobs",
          authorize: () => true,
          websocket: { port: 0 },
        }),
      ],
    })
    class AppModule {}

    const { app, adapter } = await startApp(AppModule);
    const api = app.get<JobsApi>(BUN_JOBS_API);
    const socketPort = api.websocket!.port!;
    expect(socketPort).toBeGreaterThan(0);
    expect(socketPort).not.toBe(adapter.listeningPort);

    const client = await connectWs(
      `ws://127.0.0.1:${socketPort}/admin/jobs/ws`,
    );
    await client.waitFor((message) => message?.type === "hello");
    await client.close();

    // The control: with a dedicated port the HTTP server does not upgrade
    // that path — the API's JSON 404 answers a plain GET instead.
    const onHttp = await adapter.fetch("/admin/jobs/ws");
    expect(onHttp.status).toBe(404);
  });

  it("closes sessions when the application shuts down", async () => {
    const jobs = jobsContext();

    @Module({
      imports: [
        BunJobsApiModule.forRoot({
          jobs,
          basePath: "/admin/jobs",
          authorize: () => true,
        }),
      ],
    })
    class AppModule {}

    const { app, adapter } = await startApp(AppModule);
    const api = app.get<JobsApi>(BUN_JOBS_API);
    const client = await connectWs(
      `ws://127.0.0.1:${adapter.listeningPort}/admin/jobs/ws`,
    );
    await client.waitFor((message) => message?.type === "hello");
    expect(api.websocket!.sessions).toBe(1);

    const codes: number[] = [];
    client.socket.addEventListener("close", (event) => {
      codes.push((event as CloseEvent).code);
    });

    // Shutting down runs `beforeApplicationShutdown`, which closes the API
    // while the transport is still up: the session is told 1001 "going away"
    // before Nest's `dispose()` stops the HTTP server. Closing in
    // `onApplicationShutdown` — after `dispose()` — would leave the client
    // with a 1006 abnormal close instead, which is what this pins.
    await app.close();
    await Bun.sleep(80);

    expect(codes).toEqual([1001]);
    expect(api.websocket!.sessions).toBe(0);
    // The context it was given is untouched and still usable.
    await jobs.queue("still-open").add("x", {});
    expect(await jobs.listQueues()).toContain("still-open");
  });
});

describe("sharing the server with gateways", () => {
  it("keeps working when useWebSocketAdapter swaps the BunWebSocket after attach", async () => {
    const jobs = jobsContext();

    @Module({
      imports: [
        BunJobsApiModule.forRoot({
          jobs,
          basePath: "/admin/jobs",
          authorize: () => true,
        }),
      ],
    })
    class AppModule {}

    // `startApp` calls `useWebSocketAdapter()` before `listen()`, which is
    // what installs a new `BunWebSocket` over the router. The socket resolves
    // the serving instance when a client upgrades, so it follows that swap;
    // binding at `attach()` produced a socket that connected and then went
    // silent — no `hello`, no session.
    const { app, adapter } = await startApp(AppModule);
    const api = app.get<JobsApi>(BUN_JOBS_API);

    const client = await connectWs(
      `ws://127.0.0.1:${adapter.listeningPort}/admin/jobs/ws`,
    );
    const hello = await client.waitFor((message) => message?.type === "hello");
    expect(hello).toMatchObject({ protocol: 1 });
    expect(api.websocket!.sessions).toBe(1);

    // The control: the session is really driven by this API — it answers a
    // protocol message, not just the greeting.
    client.send({ op: "ping", id: "after-swap" });
    const pong = await client.waitFor(
      (message) => message?.type === "pong" && message?.id === "after-swap",
    );
    expect(pong.id).toBe("after-swap");
    await client.close();
  });

  it("refuses to attach when a catch-all gateway already claimed the path", async () => {
    const jobs = jobsContext();

    // A gateway whose namespace matches every path, including the socket's.
    // Registered first, it would upgrade our clients and the API's route
    // would never run — so `attach()` refuses rather than serving a dead path.
    @WebSocketGateway({ namespace: "/*" })
    class CatchAllGateway {
      @SubscribeMessage("who")
      who() {
        return { event: "who", data: "catch-all" };
      }
    }

    @Module({
      imports: [
        BunJobsApiModule.forRoot({
          jobs,
          basePath: "/admin/jobs",
          authorize: () => true,
        }),
      ],
      providers: [CatchAllGateway],
    })
    class AppModule {}

    const adapter = new BunHttpAdapter(30000);
    const app = (await NestFactory.create(AppModule, adapter, {
      logger: false,
    })) as INestApplication;
    app.useWebSocketAdapter(adapter.webSocketAdapter);
    cleanups.push(() => app.close());

    // Gateways bind during `init()`, before the module's bootstrap hook
    // attaches — so this is the ordering the guard is meant to catch.
    let message = "";
    try {
      await app.init();
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("/admin/jobs/ws");
    expect(message).toMatch(/already registered|websocket\.port/i);
  });
});

describe("the adapter requirement", () => {
  it("names what it expected and what it got", async () => {
    const jobs = jobsContext();

    @Module({
      imports: [
        BunJobsApiModule.forRoot({
          jobs,
          basePath: "/admin/jobs",
          authorize: () => true,
        }),
      ],
    })
    class AppModule {}

    // Driven directly rather than by booting a foreign platform: Nest's
    // default is Express, and asking for it here aborts the process because
    // `@nestjs/platform-express` is not installed in this package.
    const { adapter } = await startApp(AppModule, { listen: false });
    // An API of its own, so the hook can be driven against hosts the
    // application never had.
    const api = createJobsApi({
      jobs,
      basePath: "/admin/jobs",
      authorize: () => true,
    });

    /** An Express-shaped adapter, as `HttpAdapterHost` would carry it. */
    class ExpressAdapter {}
    const foreignHost = {
      httpAdapter: new ExpressAdapter(),
    } as unknown as ConstructorParameters<typeof BunJobsApiModule>[2];

    const onForeign = new BunJobsApiModule(api, {} as never, foreignHost);
    let message = "";
    try {
      onForeign.onModuleInit();
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("BunHttpAdapter");
    expect(message).toContain("ExpressAdapter");

    // A host with no adapter at all says so, rather than throwing something
    // opaque.
    let empty = "";
    try {
      new BunJobsApiModule(
        api,
        {} as never,
        {
          httpAdapter: undefined,
        } as never,
      ).onModuleInit();
    } catch (error) {
      empty = String(error);
    }
    expect(empty).toContain("no HTTP adapter");

    // The control: given this package's adapter, the same call mounts and the
    // API answers.
    expect((await adapter.fetch("/admin/jobs/meta")).status).toBe(200);
    await api.close();
  });
});
