/**
 * Option tour: `BunJobsApiModule` from `@kingsleyweb/bun-nest/jobs` — every
 * option the module adds, and the rules that decide whether its live-events
 * socket can share a server with a `@WebSocketGateway`.
 *
 * ```bash
 * bun 10-options/jobs-api-module-options.ts
 * ```
 *
 * Covers:
 *
 * - **Registration** — `forRoot`, `forRootAsync` (`imports`, `inject`,
 *   `useFactory`), `BUN_JOBS_API`, `BUN_JOBS_API_OPTIONS`, `@InjectJobsApi()`.
 * - **Options passed through to the API** — `basePath`, `authorize`,
 *   `readOnly`, `websocket: false`, `websocket: { port }`.
 * - **The module's own option** — `attachWebSocket`.
 * - **Lifecycle** — where the router is mounted, where the socket is attached,
 *   and the `1001` a client is told on shutdown.
 * - **Sharing a server with gateways** — the `bunJobsApi` marker, what a
 *   catch-all gateway does and does not reach, connection-slot accounting,
 *   registration order (`ConfigError`), and attaching before
 *   `useWebSocketAdapter()` swaps the adapter.
 *
 * Every gateway class is declared before the first top-level `await`: a
 * top-level await between decorator evaluations perturbs the metadata NestJS
 * reads, which is why the package's gateway tests build theirs in factories.
 */
import type { WebSocketClient } from "@kingsleyweb/bun-common";
import type {
  BunJobsApiModuleOptions,
  JobsApi,
} from "@kingsleyweb/bun-nest/jobs";
import type { INestApplication } from "@nestjs/common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_WS_SUBPROTOCOL,
  MemoryDriver,
} from "@kingsleyweb/bun-jobs";
import { BunHttpAdapter, BunWebSocketAdapter } from "@kingsleyweb/bun-nest";
import {
  BUN_JOBS_API,
  BUN_JOBS_API_OPTIONS,
  BunJobsApiModule,
  InjectJobsApi,
} from "@kingsleyweb/bun-nest/jobs";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title, waitFor } from "../shared/console";
import "reflect-metadata";

/** What a gateway saw, so the tour can assert whose clients reached it. */
const seen = {
  /** One entry per connection a gateway's `handleConnection` received. */
  connects: [] as { path: string; marked: boolean }[],
  /** The path of each connection whose `handleDisconnect` ran. */
  disconnects: [] as string[],
  /** Frames a catch-all `@SubscribeMessage` handler received. */
  caught: [] as unknown[],
};

/** Whether a connection is one the jobs API upgraded and marked. */
function marked(client: WebSocketClient<any>): boolean {
  return (
    (client?.data?.custom as { bunJobsApi?: unknown } | undefined)
      ?.bunJobsApi === true
  );
}

/** A gateway whose namespace matches every path, the socket's included. */
@WebSocketGateway({ namespace: "/*" })
class CatchAllGateway {
  handleConnection(client: WebSocketClient<any>) {
    seen.connects.push({
      path: String(client?.data?.path),
      marked: marked(client),
    });
  }

  handleDisconnect(client: WebSocketClient<any>) {
    seen.disconnects.push(String(client?.data?.path));
  }

  @SubscribeMessage("who")
  who() {
    return { event: "who", data: "gateway" };
  }

  @SubscribeMessage("events")
  everything(data: unknown) {
    seen.caught.push(data);
    return undefined;
  }
}

/** A provider that asks for the built API by decorator. */
@Injectable()
class ApiProbe {
  constructor(@InjectJobsApi() readonly api: JobsApi) {}
}

/** Decides what a request may do, from the token it carries. */
@Injectable()
class AuthService {
  /** Every action it was asked about, so the tour can prove it was consulted. */
  readonly asked: string[] = [];

  can(action: string): boolean {
    this.asked.push(action);
    return true;
  }
}

@Module({ providers: [AuthService], exports: [AuthService] })
class AuthModule {}

/** One connected live-events client, speaking the jobs socket's protocol. */
interface JobsSocket {
  /** Every frame received, parsed from JSON. */
  frames: Record<string, any>[];
  /** Sends one protocol message. */
  send: (message: Record<string, unknown>) => void;
  /** Resolves with the first frame matching `predicate`. */
  next: (what: string, predicate: (frame: any) => boolean) => Promise<any>;
  /** The close code, once the socket has closed. */
  closeCode: () => number | undefined;
  /** The subprotocol the server negotiated; `""` when none. */
  protocol: string;
  /** Closes it and resolves once closed. */
  close: () => Promise<void>;
}

/** Opens a live-events client; `undefined` when the upgrade was refused. */
async function openSocket(
  url: string,
  /** Subprotocols to offer; none by default. */
  protocols?: string[],
): Promise<JobsSocket | undefined> {
  const socket = new WebSocket(url, protocols);
  const frames: Record<string, any>[] = [];
  let code: number | undefined;

  socket.addEventListener("message", (event) => {
    try {
      frames.push(JSON.parse(String(event.data)));
    } catch {
      // Not a protocol frame; the tour only asserts on the ones that are.
    }
  });
  socket.addEventListener("close", (event) => {
    code = event.code;
  });

  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(resolve, 3000, false);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(true);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (!opened) {
    return undefined;
  }

  return {
    frames,
    send: (message) => socket.send(JSON.stringify(message)),
    async next(what, predicate) {
      await waitFor(what, () => frames.some(predicate), { timeout: 3000 });
      return frames.find(predicate)!;
    },
    closeCode: () => code,
    protocol: socket.protocol,
    close: async () => {
      if (code !== undefined) {
        return;
      }
      socket.close();
      await waitFor("the socket to close", () => code !== undefined);
    },
  };
}

/** A jobs context over the memory driver, so the tour needs no server. */
function context(name: string): BunJobs {
  return new BunJobs({
    namespace: `examples-nest-tour-${name}`,
    driver: new MemoryDriver(),
    publishEvents: true,
  });
}

/** Builds a Nest application on this package's adapter. */
async function start(
  moduleClass: new () => unknown,
  options: { listen?: boolean; swapAdapter?: boolean; attach?: JobsApi } = {},
) {
  const adapter = new BunHttpAdapter();
  const app = (await NestFactory.create(moduleClass, adapter, {
    logger: false,
    abortOnError: false,
  })) as INestApplication;

  // Attached before `init()` when asked, so a gateway binds afterwards.
  options.attach?.websocket?.attach(adapter.getInstance());
  app.useWebSocketAdapter(
    options.swapAdapter
      ? new BunWebSocketAdapter({ httpAdapter: adapter })
      : adapter.webSocketAdapter,
  );

  if (options.listen === false) {
    await app.init();
  } else {
    await app.listen(0);
  }
  return { app, adapter, base: `ws://127.0.0.1:${adapter.listeningPort}` };
}

/** The JSON body of a request to `adapter`, with its status. */
async function call(
  adapter: BunHttpAdapter,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const response = await adapter.fetch(path, init);
  return { status: response.status, body: await response.json() };
}

title("Option tour: BunJobsApiModule");

/* ------------------------------------------------------------------ */
step("forRoot: mounting, the tokens, and @InjectJobsApi()");
{
  const jobs = context("forroot");

  @Module({
    imports: [
      BunJobsApiModule.forRoot({
        jobs,
        basePath: "/admin/jobs",
        authorize: () => true,
      }),
    ],
    providers: [ApiProbe],
  })
  class AppModule {}

  const { app, adapter } = await start(AppModule, { listen: false });
  const api = app.get<JobsApi>(BUN_JOBS_API);

  const meta = await call(adapter, "/admin/jobs/meta");
  checkEqual("the router is mounted under basePath", meta.status, 200);
  checkEqual("…and answers as the management API", meta.body.protocol, 1);
  checkEqual(
    "the OpenAPI document is served under it too",
    (await call(adapter, "/admin/jobs/openapi.json")).body.openapi,
    "3.1.0",
  );
  check(
    "BUN_JOBS_API provides the built JobsApi",
    api.basePath === "/admin/jobs" && api.routes.length > 0,
    { basePath: api.basePath, routes: api.routes.length },
  );
  check(
    "@InjectJobsApi() resolves the very same instance",
    app.get(ApiProbe).api === api,
  );
  check(
    "BUN_JOBS_API_OPTIONS provides what it was configured with",
    app.get<BunJobsApiModuleOptions>(BUN_JOBS_API_OPTIONS).basePath ===
      "/admin/jobs",
  );
  checkEqual(
    "a path the API does not route still reaches the host's 404",
    (await adapter.fetch("/not-the-api")).status,
    404,
  );

  await app.close();
  await jobs.close();
}

/* ------------------------------------------------------------------ */
step("authorize and readOnly reach the API through the module");
{
  const jobs = context("readonly");

  @Module({
    imports: [
      BunJobsApiModule.forRoot({
        jobs,
        basePath: "/admin/jobs",
        readOnly: true,
        authorize: (_req, ctx) => ctx.action !== "queues.list",
      }),
    ],
  })
  class AppModule {}

  const { app, adapter } = await start(AppModule, { listen: false });

  const denied = await call(adapter, "/admin/jobs/queues");
  checkEqual("authorize denies an action it refuses", denied.status, 403);
  checkEqual("…with the API's problem code", denied.body.code, "FORBIDDEN");
  checkEqual(
    "readOnly prunes a mutating route entirely, so it 404s",
    (
      await adapter.fetch("/admin/jobs/queues/emails/pause", {
        method: "POST",
        headers: { "content-type": "application/json" },
      })
    ).status,
    404,
  );
  checkEqual(
    "an allowed read still answers",
    (await adapter.fetch("/admin/jobs/meta")).status,
    200,
  );

  await app.close();
  await jobs.close();
}

/* ------------------------------------------------------------------ */
step("forRootAsync: imports, inject and useFactory");
{
  const jobs = context("async");

  @Module({
    imports: [
      BunJobsApiModule.forRootAsync({
        imports: [AuthModule],
        inject: [AuthService],
        useFactory: (auth: AuthService) => ({
          jobs,
          basePath: "/ops/jobs",
          authorize: (_req, ctx) => auth.can(ctx.action),
        }),
      }),
    ],
  })
  class AppModule {}

  const { app, adapter } = await start(AppModule, { listen: false });

  checkEqual(
    "the factory's basePath is where the API is mounted",
    (await adapter.fetch("/ops/jobs/meta")).status,
    200,
  );
  check(
    "the injected provider really decided the request",
    app.get(AuthService).asked.includes("meta.read"),
    app.get(AuthService).asked,
  );
  checkEqual(
    "…and nothing is mounted at the default of another app",
    (await adapter.fetch("/admin/jobs/meta")).status,
    404,
  );

  await app.close();
  await jobs.close();
}

/* ------------------------------------------------------------------ */
step("attachWebSocket: false leaves the HTTP API and no socket");
{
  const jobs = context("noattach");

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

  const { app, adapter, base } = await start(AppModule);

  checkEqual(
    "the HTTP API is mounted as usual",
    (await adapter.fetch("/admin/jobs/meta")).status,
    200,
  );
  check(
    "but nothing upgrades on the socket's path",
    (await openSocket(`${base}/admin/jobs/ws`)) === undefined,
  );

  await app.close();
  await jobs.close();
}

/* ------------------------------------------------------------------ */
step("websocket: { port } serves the socket on a server of its own");
{
  const jobs = context("ownport");

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

  const { app, adapter } = await start(AppModule);
  const api = app.get<JobsApi>(BUN_JOBS_API);
  const port = api.websocket?.port;

  check("the socket reports its own bound port", (port ?? 0) > 0, { port });
  check("…which is not the HTTP one", port !== adapter.listeningPort);

  const client = await openSocket(`ws://127.0.0.1:${port}/admin/jobs/ws`);
  const hello = await client!.next("a hello", (f) => f.type === "hello");
  checkEqual("it greets a client on that port", hello.protocol, 1);
  await client!.close();

  // A server answers with the first protocol offered unless told otherwise;
  // the API names its own, wherever the client put it in the list.
  const negotiated = await openSocket(`ws://127.0.0.1:${port}/admin/jobs/ws`, [
    "other",
    JOBS_API_WS_SUBPROTOCOL,
  ]);
  checkEqual(
    'offering ["other", "bun-jobs.v1"] negotiates bun-jobs.v1',
    negotiated?.protocol,
    JOBS_API_WS_SUBPROTOCOL,
  );
  await negotiated?.close();

  checkEqual(
    "and the HTTP server does not upgrade that path at all",
    (await adapter.fetch("/admin/jobs/ws")).status,
    404,
  );

  await app.close();
  await jobs.close();
}

/* ------------------------------------------------------------------ */
step("websocket: false removes the socket and the AsyncAPI document");
{
  const jobs = context("nosocket");

  @Module({
    imports: [
      BunJobsApiModule.forRoot({
        jobs,
        basePath: "/admin/jobs",
        authorize: () => true,
        websocket: false,
      }),
    ],
  })
  class AppModule {}

  const { app, adapter } = await start(AppModule, { listen: false });
  const api = app.get<JobsApi>(BUN_JOBS_API);

  check("there is no socket", api.websocket === undefined);
  check("nor an AsyncAPI document", api.asyncapi() === undefined);
  checkEqual(
    "the HTTP API is unaffected",
    (await adapter.fetch("/admin/jobs/meta")).status,
    200,
  );

  await app.close();
  await jobs.close();
}

/* ------------------------------------------------------------------ */
step("sharing the server with a catch-all gateway");
{
  const jobs = context("coexist");
  seen.connects.length = 0;
  seen.disconnects.length = 0;
  seen.caught.length = 0;

  const api = createJobsApi({
    jobs,
    basePath: "/admin/jobs",
    authorize: () => true,
    websocket: { maxConnections: 2 },
  });

  @Module({
    imports: [
      BunJobsApiModule.forRoot({
        jobs,
        basePath: "/unused/jobs",
        authorize: () => true,
        websocket: false,
      }),
    ],
    providers: [CatchAllGateway],
  })
  class AppModule {}

  // The API built above is mounted and attached by hand *before* `init()`, so
  // the gateway's `"/*"` route is registered after it. The other order is a
  // `ConfigError`, checked next.
  const adapter = new BunHttpAdapter();
  const app = (await NestFactory.create(AppModule, adapter, {
    logger: false,
    abortOnError: false,
  })) as INestApplication;
  adapter.use(api.basePath, api.router);
  api.websocket!.attach(adapter.getInstance());
  app.useWebSocketAdapter(adapter.webSocketAdapter);
  await app.init();
  await app.listen(0);
  const base = `ws://127.0.0.1:${adapter.listeningPort}`;

  const ours = await openSocket(`${base}/admin/jobs/ws`);
  await ours!.next("a hello", (f) => f.type === "hello");
  ours!.send({ op: "ping", id: "tour" });
  const pong = await ours!.next(
    "a pong",
    (f) => f.type === "pong" && f.id === "tour",
  );
  checkEqual("the socket answers beside a catch-all gateway", pong.id, "tour");
  checkEqual("one session is counted", api.websocket!.sessions, 1);

  const theirs = await openSocket(`${base}/chat`);
  await waitFor("the gateway to see both", () => seen.connects.length === 2);
  checkEqual(
    "every connection the API upgraded carries the bunJobsApi marker",
    seen.connects,
    [
      { path: "/admin/jobs/ws", marked: true },
      { path: "/chat", marked: false },
    ],
  );

  // A gateway's client speaking our protocol is not a session of ours.
  theirs!.send({ op: "ping", id: "intruder" });
  theirs!.send({ op: "subscribe", id: "intruder", channels: ["all"] });
  await Bun.sleep(80);
  check(
    "the API never answers a connection it did not mark",
    !theirs!.frames.some((f) => f.type === "pong" || f.type === "ack"),
    theirs!.frames,
  );
  checkEqual("…and it moves no session counter", api.websocket!.sessions, 1);

  await theirs!.close();
  const theirCloseSeen = () => seen.disconnects.includes("/chat");
  await waitFor("the gateway to see the disconnect", theirCloseSeen);
  checkEqual(
    "closing one leaves our bookkeeping alone",
    api.websocket!.sessions,
    1,
  );
  ours!.send({ op: "ping", id: "after" });
  const after = await ours!.next(
    "a pong after their close",
    (f) => f.type === "pong" && f.id === "after",
  );
  checkEqual("our session is still live", after.id, "after");

  // The other half of the overlap, stated as it is: a catch-all gateway does
  // receive the API's connections. The marker is what an application filters
  // on if it should ignore them.
  check(
    "a catch-all gateway does see the API's connections (filter on the marker)",
    seen.connects.some((entry) => entry.marked),
    seen.connects,
  );

  // The cap counts sessions of ours, and nothing else.
  const second = await openSocket(`${base}/admin/jobs/ws`);
  await second!.next("a hello", (f) => f.type === "hello");
  checkEqual("two sessions fill a cap of two", api.websocket!.sessions, 2);
  check(
    "a third is refused",
    (await openSocket(`${base}/admin/jobs/ws`)) === undefined,
  );
  await second!.close();
  await waitFor(
    "the session count to fall",
    () => api.websocket!.sessions === 1,
  );
  // This one offers a list with ours second: attached through Nest, the API
  // still names its own, as it does on a server of its own.
  const third = await openSocket(`${base}/admin/jobs/ws`, [
    "other",
    JOBS_API_WS_SUBPROTOCOL,
  ]);
  await third!.next("a hello", (f) => f.type === "hello");
  checkEqual("a released slot is reusable", api.websocket!.sessions, 2);
  checkEqual(
    'offering ["other", "bun-jobs.v1"] through Nest negotiates bun-jobs.v1',
    third!.protocol,
    JOBS_API_WS_SUBPROTOCOL,
  );

  await third!.close();
  await ours!.close();
  await app.close();
  await api.close();
  await jobs.close();
}

/* ------------------------------------------------------------------ */
step("registration order: a catch-all gateway bound first is refused");
{
  const jobs = context("order");

  @Module({ providers: [CatchAllGateway] })
  class AppModule {}

  const { app, adapter } = await start(AppModule, { listen: false });
  const api = createJobsApi({
    jobs,
    basePath: "/admin/jobs",
    authorize: () => true,
  });

  await checkRejects(
    "attach() after a route already covering the path",
    () => api.websocket!.attach(adapter.getInstance()),
    { name: "ConfigError", message: /\/admin\/jobs\/ws/ },
  );

  await api.close();
  await app.close();
  await jobs.close();
}

/* ------------------------------------------------------------------ */
step("attaching before useWebSocketAdapter() swaps the adapter");
{
  const jobs = context("swap");

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

  const adapter = new BunHttpAdapter();
  const app = (await NestFactory.create(AppModule, adapter, {
    logger: false,
    abortOnError: false,
  })) as INestApplication;
  const api = app.get<JobsApi>(BUN_JOBS_API);

  // Attached against the adapter's own BunWebSocket…
  api.websocket!.attach(adapter.getInstance());
  // …then replaced by another, which is what useWebSocketAdapter() installs.
  const swapped = new BunWebSocketAdapter({ httpAdapter: adapter });
  app.useWebSocketAdapter(swapped);
  check(
    "the router's BunWebSocket really was replaced",
    adapter.getInstance().getBunWebsocket() === swapped,
  );

  await app.init();
  await app.listen(0);
  const base = `ws://127.0.0.1:${adapter.listeningPort}`;

  const client = await openSocket(`${base}/admin/jobs/ws`);
  const hello = await client!.next("a hello", (f) => f.type === "hello");
  checkEqual(
    "open still reaches the session after the swap",
    hello.protocol,
    1,
  );
  client!.send({ op: "subscribe", id: "s1", channels: ["queues"] });
  const ack = await client!.next(
    "an ack",
    (f) => f.type === "ack" && f.id === "s1",
  );
  checkEqual("message too", ack.channels, ["queues"]);

  // Shutdown closes sessions with 1001 while the transport is still up.
  await app.close();
  await waitFor("the socket to close", () => client!.closeCode() !== undefined);
  checkEqual(
    "shutdown tells a live client 1001 'going away'",
    client!.closeCode(),
    1001,
  );
  checkEqual("and its session is gone", api.websocket!.sessions, 0);

  await jobs.close();
}

summary();
