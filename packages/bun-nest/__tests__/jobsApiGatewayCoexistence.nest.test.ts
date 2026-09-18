/**
 * The jobs API's live-events socket and a NestJS `@WebSocketGateway` on one
 * server.
 *
 * A gateway whose namespace is `"/*"` matches every path below it — the
 * socket's included — so on the shared HTTP server the two overlap. What keeps
 * them apart is a marker: every connection the API upgrades carries
 * `ws.data.custom.bunJobsApi === true`, and the API's handler ignores anything
 * without it for messages *and* for close and drain bookkeeping.
 *
 * These suites pin both halves of that overlap, in both registration orders,
 * and the connection-cap accounting that depends on it. The gateways are
 * declared inside each test rather than at module scope, and
 * `reflect-metadata` is imported last, for the reason the other gateway suites
 * give: a top-level `await` perturbs decorator metadata across files.
 */
import type { WebSocketClient } from "@kingsleyweb/bun-common";
import type { JobsApi } from "@kingsleyweb/bun-jobs";
import type { INestApplication } from "@nestjs/common";
import type { WsTestClient } from "./helpers";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  BunWebSocketAdapter,
  MessageEventTypes,
} from "../lib/BunWebSocketAdapter";
import { BUN_JOBS_API, BunJobsApiModule } from "../lib/jobs/index";
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
    namespace: `nest-coexist-${Math.random().toString(36).slice(2, 8)}`,
    driver: new MemoryDriver(),
    publishEvents: true,
  });
  cleanups.push(() => jobs.close());
  return jobs;
}

/** What a gateway saw, so a test can assert whose clients reached it. */
interface GatewaySightings {
  /** One entry per connection the gateway's `handleConnection` received. */
  connects: { path: string; marked: boolean }[];
  /** The path of each connection whose `handleDisconnect` ran. */
  disconnects: string[];
  /** Payloads a catch-all `@SubscribeMessage` handler received. */
  caught: unknown[];
}

/** A fresh, empty sightings record. */
function sightings(): GatewaySightings {
  return { connects: [], disconnects: [], caught: [] };
}

/** Whether a client is one the jobs API upgraded. */
function isJobsConnection(client: WebSocketClient<any>): boolean {
  return (
    (client?.data?.custom as { bunJobsApi?: unknown } | undefined)
      ?.bunJobsApi === true
  );
}

/** Tries to open a socket, answering `undefined` when the upgrade was refused. */
async function tryConnect(url: string): Promise<WsTestClient | undefined> {
  try {
    return await connectWs(url);
  } catch {
    return undefined;
  }
}

/** Waits until `predicate` holds, so nothing depends on a guessed sleep. */
async function until(
  what: string,
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await Bun.sleep(5);
  }
}

describe("a catch-all gateway beside the jobs socket", () => {
  /**
   * An application whose `"/*"` gateway is registered **after** the socket was
   * attached: the module's own hook attaches at bootstrap, which is always
   * after gateways bind, so the socket is attached by hand before `init()`
   * instead. The other order is a `ConfigError`, pinned further down.
   */
  async function startWithCatchAll(options: {
    /** What the gateway saw. */
    seen: GatewaySightings;
    /** The socket's connection cap. */
    maxConnections?: number;
    /** Whether the gateway also declares a catch-all message handler. */
    catchMessages?: boolean;
    /** Whether `authorize` requires `?token=ok` on an upgrade. */
    requireToken?: boolean;
  }) {
    const { seen } = options;
    const jobs = jobsContext();

    @WebSocketGateway({ namespace: "/*" })
    class CatchAllGateway {
      handleConnection(client: WebSocketClient<any>) {
        seen.connects.push({
          path: String(client?.data?.path),
          marked: isJobsConnection(client),
        });
      }

      handleDisconnect(client: WebSocketClient<any>) {
        seen.disconnects.push(String(client?.data?.path));
      }

      @SubscribeMessage("who")
      who() {
        return { event: "who", data: "gateway" };
      }

      /**
       * The adapter routes a frame it cannot decode as a packet to handlers
       * with no message name (or named `events`). Only declared when a test
       * asks for it, because it is what reaches a jobs connection's socket.
       */
      @SubscribeMessage("events")
      everything(data: unknown) {
        if (options.catchMessages !== true) {
          return undefined;
        }
        seen.caught.push(data);
        return { event: "caught", data: "gateway" };
      }
    }

    @Module({
      imports: [
        BunJobsApiModule.forRoot({
          jobs,
          basePath: "/admin/jobs",
          authorize: (req, context) =>
            context.transport === "http" ||
            options.requireToken !== true ||
            (req.query as Record<string, unknown> | undefined)?.token === "ok",
          ...(options.maxConnections === undefined
            ? {}
            : { websocket: { maxConnections: options.maxConnections } }),
          // Attached by hand below, so the gateway binds afterwards.
          attachWebSocket: false,
        }),
      ],
      providers: [CatchAllGateway],
    })
    class AppModule {}

    const adapter = new BunHttpAdapter(30000);
    const app = (await NestFactory.create(AppModule, adapter as never, {
      logger: false,
    })) as INestApplication;
    app.useWebSocketAdapter(adapter.webSocketAdapter as never);
    cleanups.push(() => app.close());

    const api = app.get<JobsApi>(BUN_JOBS_API);
    api.websocket!.attach(adapter.getInstance());
    await app.init();
    await app.listen(0);

    return {
      app,
      adapter,
      api,
      base: `ws://127.0.0.1:${adapter.listeningPort}`,
    };
  }

  it("serves both: the jobs protocol on its path, the gateway on theirs", async () => {
    const seen = sightings();
    const { api, base } = await startWithCatchAll({ seen });

    // Ours: greeted, and answering the protocol rather than merely connected.
    const jobsClient = await connectWs(`${base}/admin/jobs/ws`);
    const hello = await jobsClient.waitFor((m) => m?.type === "hello");
    expect(hello).toMatchObject({ protocol: 1, mode: "both" });
    jobsClient.send({ op: "ping", id: "beside-a-gateway" });
    const pong = await jobsClient.waitFor(
      (m) => m?.type === "pong" && m?.id === "beside-a-gateway",
    );
    expect(pong.id).toBe("beside-a-gateway");
    expect(api.websocket!.sessions).toBe(1);

    // Theirs, on the same server: the gateway answers its own event, and the
    // jobs API never greets that client.
    const gatewayClient: WsTestClient = await connectWs(`${base}/chat`);
    gatewayClient.send({
      type: MessageEventTypes.EVENT,
      namespace: "/chat",
      data: ["who"],
    });
    const reply = await gatewayClient.waitFor((m) => m?.data?.[0] === "who");
    expect(reply.data[1]).toBe("gateway");
    expect(
      gatewayClient.received.some((frame) => frame.includes('"type":"hello"')),
    ).toBe(false);
    expect(api.websocket!.sessions).toBe(1);

    await jobsClient.close();
    await gatewayClient.close();
  });

  it("marks its own connections, and only its own", async () => {
    const seen = sightings();
    const { base } = await startWithCatchAll({ seen });

    const jobsClient = await connectWs(`${base}/admin/jobs/ws`);
    await jobsClient.waitFor((m) => m?.type === "hello");
    const gatewayClient = await connectWs(`${base}/chat`);
    await until(
      "both connections to reach the gateway",
      () => seen.connects.length === 2,
    );

    // The marker is what a gateway can filter on: present on the API's
    // connection, absent on its own.
    expect(seen.connects).toEqual([
      { path: "/admin/jobs/ws", marked: true },
      { path: "/chat", marked: false },
    ]);

    await jobsClient.close();
    await gatewayClient.close();
  });

  it("ignores the gateway's clients for messages, counters and close bookkeeping", async () => {
    const seen = sightings();
    const { api, base } = await startWithCatchAll({ seen });

    const jobsClient = await connectWs(`${base}/admin/jobs/ws`);
    await jobsClient.waitFor((m) => m?.type === "hello");
    expect(api.websocket!.sessions).toBe(1);

    // A gateway's client speaking the jobs protocol is not a session of ours:
    // it is never answered, and it moves no counter.
    const intruder = await connectWs(`${base}/chat`);
    intruder.send({ op: "ping", id: "not-a-session" });
    intruder.send({
      op: "subscribe",
      id: "not-a-subscription",
      channels: ["all"],
    });
    await Bun.sleep(60);
    expect(
      intruder.received.some(
        (frame) => frame.includes('"pong"') || frame.includes('"ack"'),
      ),
    ).toBe(false);
    expect(api.websocket!.sessions).toBe(1);

    // Nor on the way out: closing it runs the gateway's disconnect hook, and
    // none of the API's. `sessionOf` gates `close` and `drain` on the marker
    // for exactly this — an unmarked socket must not end a session of ours.
    await intruder.close();
    const theirCloseSeen = () => seen.disconnects.includes("/chat");
    await until("the gateway to see the disconnect", theirCloseSeen);
    expect(api.websocket!.sessions).toBe(1);

    // The control: our session is untouched and still answering.
    jobsClient.send({ op: "ping", id: "after-their-close" });
    const pong = await jobsClient.waitFor(
      (m) => m?.type === "pong" && m?.id === "after-their-close",
    );
    expect(pong.id).toBe("after-their-close");

    await jobsClient.close();
  });

  /**
   * The half of the overlap the marker does **not** close, pinned as measured
   * rather than as hoped.
   *
   * A review of this module expected isolation in both directions — that the
   * API's clients never reach a gateway's handlers either. They do: the
   * adapter dispatches `connect`, `message` and `disconnect` to every gateway
   * whose route matches the connection's path, and `"/*"` matches the socket's.
   * So a catch-all gateway sees the API's connections, and a catch-all message
   * handler can write frames into one. The API is unharmed — it drives no
   * session for an unmarked socket, and the frames a gateway sends are not
   * protocol frames it would act on — but the client sees them.
   *
   * What the API provides is the marker; filtering on it is the application's
   * job. A gateway that does so sees nothing of ours, which is the last
   * assertion here.
   */
  it("leaves a catch-all gateway able to reach the API's connections — the marker is the filter", async () => {
    const seen = sightings();
    const { base } = await startWithCatchAll({ seen, catchMessages: true });

    const jobsClient = await connectWs(`${base}/admin/jobs/ws`);
    await jobsClient.waitFor((m) => m?.type === "hello");

    jobsClient.send({ op: "ping", id: "overlap" });
    await jobsClient.waitFor((m) => m?.type === "pong" && m?.id === "overlap");
    await until(
      "the gateway's catch-all handler to see the frame",
      () => seen.caught.length > 0,
    );

    // Measured: the gateway received the API client's frame and its reply
    // reached that client.
    expect(seen.caught.length).toBeGreaterThan(0);
    const replyArrived = () =>
      jobsClient.received.some((frame) => frame.includes('"caught"'));
    await until("the gateway's reply to arrive", replyArrived);

    // And the marker is sufficient to tell them apart, which is what an
    // application filters on.
    expect(seen.connects.filter((entry) => entry.marked)).toEqual([
      { path: "/admin/jobs/ws", marked: true },
    ]);

    await jobsClient.close();
  });

  it("does not spend a connection slot on a gateway's client, nor on a refused upgrade", async () => {
    const seen = sightings();
    const { api, base } = await startWithCatchAll({
      seen,
      maxConnections: 2,
      requireToken: true,
    });
    const socketUrl = `${base}/admin/jobs/ws?token=ok`;

    // Three of the gateway's clients, and three upgrades `authorize` refused:
    // neither kind ever reaches a marked `open()`, so neither may hold a slot.
    const gatewayClients = await Promise.all([
      connectWs(`${base}/chat`),
      connectWs(`${base}/chat`),
      connectWs(`${base}/chat`),
    ]);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(
        await tryConnect(`${base}/admin/jobs/ws?token=no`),
      ).toBeUndefined();
    }
    expect(api.websocket!.sessions).toBe(0);

    // The cap is therefore still whole: two connect, the third is refused.
    const first = await connectWs(socketUrl);
    await first.waitFor((m) => m?.type === "hello");
    const second = await connectWs(socketUrl);
    await second.waitFor((m) => m?.type === "hello");
    expect(api.websocket!.sessions).toBe(2);
    expect(await tryConnect(socketUrl)).toBeUndefined();

    // And back down: a released slot is reusable.
    await second.close();
    await until(
      "the session count to fall",
      () => api.websocket!.sessions === 1,
    );
    const third = await connectWs(socketUrl);
    await third.waitFor((m) => m?.type === "hello");
    expect(api.websocket!.sessions).toBe(2);

    await first.close();
    await third.close();
    await Promise.all(gatewayClients.map((client) => client.close()));
  });
});

describe("registration order", () => {
  it("refuses to attach where a catch-all ws route already covers the path", async () => {
    const jobs = jobsContext();

    @WebSocketGateway({ namespace: "/*" })
    class CatchAllGateway {
      @SubscribeMessage("who")
      who() {
        return { event: "who", data: "gateway" };
      }
    }

    @Module({ providers: [CatchAllGateway] })
    class AppModule {}

    const adapter = new BunHttpAdapter(30000);
    const app = (await NestFactory.create(AppModule, adapter as never, {
      logger: false,
    })) as INestApplication;
    app.useWebSocketAdapter(adapter.webSocketAdapter as never);
    cleanups.push(() => app.close());
    // The gateway binds here, so the catch-all route exists before `attach()`.
    await app.init();

    const api = createJobsApi({
      jobs,
      basePath: "/admin/jobs",
      authorize: () => true,
    });
    cleanups.push(() => api.close());

    let thrown: Error | undefined;
    try {
      api.websocket!.attach(adapter.getInstance());
    } catch (error) {
      thrown = error as Error;
    }

    // Both would be middleware on one router and the first to upgrade ends the
    // request, so the later route could never answer. Saying so at `attach()`
    // beats serving a path that is silently dead.
    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe("ConfigError");
    expect(thrown!.message).toContain("/admin/jobs/ws");
    expect(thrown!.message).toContain("/*");
    expect(thrown!.message).toMatch(/already registered|websocket\.port/i);
  });

  it("attaches cleanly when the socket comes first, and both then work", async () => {
    const jobs = jobsContext();
    const connected: string[] = [];

    @WebSocketGateway({ namespace: "/*" })
    class CatchAllGateway {
      handleConnection(client: WebSocketClient<any>) {
        connected.push(String(client?.data?.path));
      }

      @SubscribeMessage("who")
      who() {
        return { event: "who", data: "gateway" };
      }
    }

    @Module({ providers: [CatchAllGateway] })
    class AppModule {}

    const adapter = new BunHttpAdapter(30000);
    const app = (await NestFactory.create(AppModule, adapter as never, {
      logger: false,
    })) as INestApplication;
    app.useWebSocketAdapter(adapter.webSocketAdapter as never);
    cleanups.push(() => app.close());

    const api = createJobsApi({
      jobs,
      basePath: "/admin/jobs",
      authorize: () => true,
    });
    cleanups.push(() => api.close());
    adapter.use(api.basePath, api.router);
    // Before `init()`, which is when the gateway's route is registered.
    api.websocket!.attach(adapter.getInstance());

    await app.init();
    await app.listen(0);
    const base = `ws://127.0.0.1:${adapter.listeningPort}`;

    const jobsClient = await connectWs(`${base}/admin/jobs/ws`);
    await jobsClient.waitFor((m) => m?.type === "hello");
    const gatewayClient = await connectWs(`${base}/chat`);
    gatewayClient.send({
      type: MessageEventTypes.EVENT,
      namespace: "/chat",
      data: ["who"],
    });
    const reply = await gatewayClient.waitFor((m) => m?.data?.[0] === "who");

    expect(reply.data[1]).toBe("gateway");
    expect(api.websocket!.sessions).toBe(1);
    expect((await adapter.fetch("/admin/jobs/meta")).status).toBe(200);

    await jobsClient.close();
    await gatewayClient.close();
  });
});

describe("attach() before useWebSocketAdapter()", () => {
  it("still dispatches open, message and close after the adapter is swapped", async () => {
    const jobs = jobsContext();

    @Module({
      imports: [
        BunJobsApiModule.forRoot({
          jobs,
          basePath: "/admin/jobs",
          authorize: () => true,
          attachWebSocket: false,
        }),
      ],
    })
    class AppModule {}

    const adapter = new BunHttpAdapter(30000);
    const app = (await NestFactory.create(AppModule, adapter as never, {
      logger: false,
    })) as INestApplication;
    cleanups.push(() => app.close());

    const api = app.get<JobsApi>(BUN_JOBS_API);
    // Attached first, against the adapter's built-in `BunWebSocket`…
    api.websocket!.attach(adapter.getInstance());
    // …and only then replaced by a separately constructed adapter, which is
    // what `useWebSocketAdapter()` installs: its constructor calls
    // `setBunWebSocket(this)` on the router. The serving instance is resolved
    // at upgrade time, so the socket follows the swap; binding at `attach()`
    // produced a socket that connected and then went silent.
    const swapped = new BunWebSocketAdapter({ httpAdapter: adapter });
    app.useWebSocketAdapter(swapped as never);
    expect(adapter.getInstance().getBunWebsocket()).toBe(swapped as never);

    await app.init();
    await app.listen(0);
    const base = `ws://127.0.0.1:${adapter.listeningPort}`;

    // `open`: the greeting is sent by the session the handler created.
    const client = await connectWs(`${base}/admin/jobs/ws`);
    const hello = await client.waitFor((m) => m?.type === "hello");
    expect(hello).toMatchObject({ protocol: 1 });
    expect(api.websocket!.sessions).toBe(1);

    // `message`: the session answers a protocol frame.
    client.send({ op: "subscribe", id: "s1", channels: ["queues"] });
    const ack = await client.waitFor(
      (m) => m?.type === "ack" && m?.id === "s1",
    );
    expect(ack.channels).toEqual(["queues"]);

    // `close`: the session ends, which only the lifecycle dispatch can do.
    await client.close();
    await until("the session to end", () => api.websocket!.sessions === 0);
    expect(api.websocket!.sessions).toBe(0);
  });
});
