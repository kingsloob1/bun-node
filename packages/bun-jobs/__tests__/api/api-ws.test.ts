import type { WebSocketClient } from "@kingsleyweb/bun-common";
import type {
  JobsApiAuthorize,
  JobsApiConfig,
  JobsApiSocketData,
} from "../../lib/api/config";
import type {
  HubSubscriber,
  StampedEvent,
  WsClock,
} from "../../lib/api/ws/hub";
import type { JobsApiServerMessage } from "../../lib/api/ws/protocol";
import type { DriverEvent, JobsNotifier } from "../../lib/index";
import {
  BunHttpAdapter,
  BunRequest,
  BunRouter,
  BunWebSocket,
  createTestLogger,
  noopLogger,
} from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { testServer } from "../../../bun-common/__tests__/helpers";
import { resolveConfig } from "../../lib/api/config";
import {
  buildJobsApi,
  builtInRoutes,
  createJobsApi,
} from "../../lib/api/createJobsApi";
import { validateJson } from "../../lib/api/schema/validate";
import { channelKeysFor, parseChannel } from "../../lib/api/ws/channels";
import { EventHub } from "../../lib/api/ws/hub";
import {
  JOBS_API_WS_SUBPROTOCOL,
  ServerMessageSchema,
} from "../../lib/api/ws/protocol";
import { BunJobs, ConfigError, MemoryDriver } from "../../lib/index";
import { queueEvent, runnerEvent } from "../../lib/shared/events";
import { testNamespace, waitFor } from "../helpers";
import { apiConfig, ECHO_HANDLER, openContexts } from "./fixtures";

/**
 * The live-events socket: real connections to a `BunHttpAdapter` on port 0,
 * events from a `BunJobs` that publishes, and — for backpressure and timers —
 * the socket handler driven directly with a stub socket and a fake clock.
 */

/** Undone after each test, last first. */
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  await Promise.all(openContexts.splice(0).map((jobs) => jobs.close()));
});

/** A frame of one type. */
type Frame<T extends JobsApiServerMessage["type"]> = Extract<
  JobsApiServerMessage,
  { type: T }
>;

/** Timers that only move when told to. */
class FakeClock implements WsClock {
  /** The current time. */
  current = 1_000_000;
  /** Pending timers by handle. */
  readonly #timers = new Map<
    number,
    {
      /** When it fires next. */
      at: number;
      /** Its interval, for a repeating timer. */
      every?: number;
      /** What it runs. */
      callback: () => void;
    }
  >();

  /** The next handle. */
  #next = 1;

  now = () => this.current;

  setTimeout = (callback: () => void, ms: number) => {
    const handle = this.#next++;
    this.#timers.set(handle, { at: this.current + ms, callback });
    return handle;
  };

  clearTimeout = (handle: unknown) => {
    this.#timers.delete(handle as number);
  };

  setInterval = (callback: () => void, ms: number) => {
    const handle = this.#next++;
    this.#timers.set(handle, { at: this.current + ms, every: ms, callback });
    return handle;
  };

  clearInterval = (handle: unknown) => {
    this.#timers.delete(handle as number);
  };

  /** Moves time forward, firing every timer that falls due, in order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.#timers]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) {
        break;
      }
      const [handle, timer] = due;
      this.current = timer.at;
      if (timer.every) {
        timer.at += timer.every;
      } else {
        this.#timers.delete(handle);
      }
      timer.callback();
    }
    this.current = target;
  }
}

/** A publishing context, closed after the test. */
function publishingJobs(prefix = "ws"): BunJobs {
  const jobs = new BunJobs({
    namespace: testNamespace(prefix),
    driver: new MemoryDriver(),
    logger: noopLogger,
    publishEvents: true,
  });
  cleanups.push(() => jobs.close());
  return jobs;
}

/** An API on a listening adapter, with the socket attached. */
async function served(
  overrides: Partial<JobsApiConfig> = {},
  options: {
    /** Attach the socket before mounting the router. */
    attachFirst?: boolean;
  } = {},
) {
  const jobs = overrides.jobs ?? publishingJobs();
  const { logger, events } = createTestLogger();
  const api = createJobsApi({
    jobs,
    basePath: "/admin/jobs",
    authorize: () => true,
    logger,
    ...overrides,
  });
  const adapter = new BunHttpAdapter(0, { logger: noopLogger });
  if (options.attachFirst) {
    api.websocket!.attach(adapter);
    adapter.use(api.basePath, api.router);
  } else {
    adapter.use(api.basePath, api.router);
    api.websocket!.attach(adapter);
  }
  const server = await adapter.listen(0);
  cleanups.push(async () => {
    await api.close();
    await adapter.close();
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    jobs,
    api,
    adapter,
    events,
    origin,
    url: `ws://127.0.0.1:${server.port}/admin/jobs/ws`,
  };
}

/** A connected client, recording and schema-checking every frame. */
interface Client {
  /** The socket. */
  ws: WebSocket;
  /** Every frame received, parsed. */
  frames: JobsApiServerMessage[];
  /** Every frame received, as text. */
  raw: string[];
  /** Frames that did not match the server-message schema. */
  invalid: unknown[];
  /** Resolves with the close code and reason. */
  closed: Promise<{ code: number; reason: string }>;
  /** Sends a JSON message. */
  send: (message: unknown) => void;
  /** Waits for a frame of a type (matching `predicate`), returning it. */
  next: <T extends JobsApiServerMessage["type"]>(
    type: T,
    predicate?: (frame: Frame<T>) => boolean,
    timeout?: number,
  ) => Promise<Frame<T>>;
  /** Every received frame of a type. */
  all: <T extends JobsApiServerMessage["type"]>(type: T) => Frame<T>[];
}

/** Opens a client, resolving once open; rejects when the upgrade is refused. */
async function connect(
  url: string,
  init: {
    /** Upgrade request headers. */
    headers?: Record<string, string>;
    /** Offered subprotocols. */
    protocols?: string[];
  } = {},
): Promise<Client> {
  const ws = new WebSocket(url, {
    headers: init.headers,
    protocols: init.protocols,
  } as unknown as string[]);
  const frames: JobsApiServerMessage[] = [];
  const raw: string[] = [];
  const invalid: unknown[] = [];
  let resolveClosed!: (value: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    resolveClosed = resolve;
  });
  ws.onmessage = (event) => {
    const text = String(event.data);
    raw.push(text);
    const parsed = JSON.parse(text) as JobsApiServerMessage;
    if (validateJson(ServerMessageSchema.json, parsed).issues) {
      invalid.push(parsed);
    }
    frames.push(parsed);
  };
  ws.onclose = (event) =>
    resolveClosed({ code: event.code, reason: event.reason });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the upgrade was refused"));
    void closed.then(({ code }) =>
      reject(new Error(`closed before opening (${code})`)),
    );
  });
  cleanups.push(() => ws.close());

  const all = <T extends JobsApiServerMessage["type"]>(type: T) =>
    frames.filter((frame): frame is Frame<T> => frame.type === type);
  return {
    ws,
    frames,
    raw,
    invalid,
    closed,
    send: (message) => ws.send(JSON.stringify(message)),
    all,
    next: async (type, predicate, timeout = 3000) => {
      let found: Frame<typeof type> | undefined;
      await waitFor(
        () => {
          found = all(type).find((frame) => !predicate || predicate(frame));
          return found !== undefined;
        },
        {
          timeout,
          message: () =>
            `no ${type} frame arrived; got ${JSON.stringify(frames)}`,
        },
      );
      return found as never;
    },
  };
}

/** The headers of a WebSocket upgrade, for `fetch`. */
const UPGRADE_HEADERS = {
  Connection: "Upgrade",
  Upgrade: "websocket",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version": "13",
};

/** Sends an upgrade the server is expected to refuse, returning its answer. */
async function refusedUpgrade(
  origin: string,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${origin}/admin/jobs/ws`, {
    headers: { ...UPGRADE_HEADERS, ...headers },
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: (await response.json()) as { code: string; status: number },
  };
}

describe("connecting", () => {
  it("greets with hello, and authorizes the upgrade as events.connect", async () => {
    const calls: Parameters<JobsApiAuthorize>[1][] = [];
    const h = await served({
      authorize: (_req, context) => {
        calls.push(context);
        return true;
      },
    });
    const client = await connect(h.url);
    const hello = await client.next("hello");
    expect(hello).toMatchObject({
      type: "hello",
      protocol: 1,
      mode: "both",
      heartbeatMs: 25_000,
      maxSubscriptions: 50,
      events: h.jobs.driver.capabilities.events,
      seq: 0,
    });
    expect(hello.epoch).toMatch(/^[\da-f-]{36}$/);
    expect(h.api.websocket!.sessions).toBe(1);
    expect(calls).toEqual([
      { action: "events.connect", transport: "ws", mutation: false },
    ]);
    expect(client.invalid).toEqual([]);
  });

  it("accepts the bun-jobs.v1 subprotocol and refuses a list without it", async () => {
    const h = await served();
    const client = await connect(h.url, {
      protocols: [JOBS_API_WS_SUBPROTOCOL],
    });
    expect(client.ws.protocol).toBe(JOBS_API_WS_SUBPROTOCOL);
    const refused = await refusedUpgrade(h.origin, {
      "Sec-WebSocket-Protocol": "chat, mqtt",
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("UNSUPPORTED_SUBPROTOCOL");
  });

  it("refuses a cross-origin upgrade at HTTP, before any socket exists", async () => {
    const h = await served();
    const refused = await refusedUpgrade(h.origin, {
      Origin: "https://evil.example",
    });
    expect(refused).toMatchObject({
      status: 403,
      contentType: "application/problem+json",
      body: { code: "ORIGIN_REJECTED", status: 403 },
    });
    expect(h.api.websocket!.sessions).toBe(0);
    // The controls: the same origin, and a listed one, connect.
    await connect(h.url, { headers: { Origin: h.origin } });
    const listed = await served({
      websocket: { allowedOrigins: ["https://ops.example"] },
    });
    await connect(listed.url, { headers: { Origin: "https://ops.example" } });
    expect(listed.api.websocket!.sessions).toBe(1);
  });

  it("lets a plain GET of the socket path fall through to the API's JSON 404", async () => {
    const h = await served();
    const response = await fetch(`${h.origin}/admin/jobs/ws`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "ROUTE_NOT_FOUND" });
  });

  it("runs the guard in order — origin, cap, middleware, authorize — before the ws() route", async () => {
    const order: string[] = [];
    let deny = true;
    const h = await served(
      {
        middleware: [
          (req, _res, next) => {
            if (req.getHeader("upgrade")) {
              order.push("middleware");
            }
            next();
          },
        ],
        authorize: (_req, context) => {
          order.push(`authorize:${context.action}`);
          return deny && context.action === "events.connect"
            ? { allow: false, status: 401, reason: "log in" }
            : true;
        },
        websocket: { maxConnections: 1 },
      },
      // Attaching before mounting must not change anything.
      { attachFirst: true },
    );

    // Origin first: neither the middleware nor authorize is asked.
    const crossSite = await refusedUpgrade(h.origin, {
      Origin: "https://evil.example",
    });
    expect(crossSite.status).toBe(403);
    expect(order).toEqual([]);

    // Middleware, then authorize; a denial is an HTTP 401 and no socket —
    // which is only possible if the guard ran before the upgrade route.
    const denied = await refusedUpgrade(h.origin);
    expect(denied).toMatchObject({
      status: 401,
      body: { code: "UNAUTHORIZED" },
    });
    expect(order).toEqual(["middleware", "authorize:events.connect"]);
    expect(h.api.websocket!.sessions).toBe(0);

    deny = false;
    await (await connect(h.url)).next("hello");
    expect(order).toEqual([
      "middleware",
      "authorize:events.connect",
      "middleware",
      "authorize:events.connect",
    ]);

    // The cap comes before the middleware: a full API asks nobody.
    const full = await refusedUpgrade(h.origin);
    expect(full).toMatchObject({
      status: 429,
      body: { code: "CONNECTION_LIMIT" },
    });
    expect(order).toHaveLength(4);
  });

  it("honours trustProxy on the upgrade, exactly as the HTTP routes do", async () => {
    // What a browser sends to a TLS-terminating proxy that forwards to this
    // server: the `Origin` is the proxy's, and only the forwarded headers say
    // so. Without `trustProxy` the direct host and scheme are the truth.
    const forwarded = {
      Origin: "https://ops.example",
      "X-Forwarded-Host": "ops.example",
      "X-Forwarded-Proto": "https",
    };

    const trusting = await served({ trustProxy: true });
    const client = await connect(trusting.url, { headers: forwarded });
    await client.next("hello");
    expect(trusting.api.websocket!.sessions).toBe(1);

    // The control: the same upgrade with `trustProxy` off is refused, which is
    // the bug this guards — the routes would have accepted it.
    const direct = await served();
    expect(await refusedUpgrade(direct.origin, forwarded)).toMatchObject({
      status: 403,
      body: { code: "ORIGIN_REJECTED" },
    });

    // And trusting the proxy is not trusting the origin: a forwarded host that
    // is not the `Origin`'s is still cross-origin.
    expect(
      await refusedUpgrade(trusting.origin, {
        ...forwarded,
        "X-Forwarded-Host": "other.example",
      }),
    ).toMatchObject({ status: 403, body: { code: "ORIGIN_REJECTED" } });
  });

  it("marks its own connections, and ignores one it did not mark", async () => {
    const h = await served();
    const opened: unknown[] = [];
    h.adapter.webSocketAdapter.on("open", (client) => {
      opened.push(client.data?.custom);
    });

    const client = await connect(h.url);
    await client.next("hello");
    // Every connection this API upgrades carries the marker, which is what a
    // `"/*"` NestJS gateway on the same server would filter on.
    expect(opened).toEqual([expect.objectContaining({ bunJobsApi: true })]);
    expect(h.api.websocket!.sessions).toBe(1);

    const request = await BunRequest.init(
      new Request("http://localhost/admin/jobs/ws"),
      testServer,
      { parseBody: false, parseCookies: false, parseQuery: true },
    );

    /**
     * A socket some other handler upgraded, driven straight at our handler.
     * Well-formed in every other way — it carries a request and a session id —
     * so the marker is the only thing that tells it from one of ours.
     */
    const foreign = {
      data: { custom: { namespace: "/chat", sessionId: "theirs", request } },
      readyState: 1,
      sent: [] as string[],
      closes: [] as number[],
      send(text: string) {
        foreign.sent.push(text);
        return text.length;
      },
      getBufferedAmount: () => 0,
      close(code: number) {
        foreign.closes.push(code);
      },
    };
    const handler = h.api.websocket!.handler;
    handler.open!(foreign as never);
    // Left alone: not made a session, not answered, and not closed — it is
    // not ours to close.
    expect(h.api.websocket!.sessions).toBe(1);
    expect(foreign.sent).toEqual([]);
    expect(foreign.closes).toEqual([]);
    handler.message!(foreign as never, JSON.stringify({ op: "ping", id: "x" }));
    handler.drain!(foreign as never);
    handler.close!(foreign as never, 1000, "");
    expect(foreign.sent).toEqual([]);
    expect(h.api.websocket!.sessions).toBe(1);

    // The control: the same stub, marked, is greeted and becomes a session —
    // so the marker, and nothing else, is what kept the other one out.
    // Built standalone, not spread from `foreign`: its `send` must close over
    // its own frames, or the assertion below would read the other stub's.
    const ours = {
      data: { custom: { bunJobsApi: true, sessionId: "s1", request } },
      readyState: 1,
      sent: [] as string[],
      closes: [] as number[],
      send(text: string) {
        ours.sent.push(text);
        return text.length;
      },
      getBufferedAmount: () => 0,
      close(code: number) {
        ours.closes.push(code);
      },
    };
    handler.open!(ours as never);
    expect(h.api.websocket!.sessions).toBe(2);
    expect(ours.sent.map((frame) => JSON.parse(frame).type)).toEqual(["hello"]);

    // Leaving is bookkeeping too: a foreign close must not evict anything,
    // while ours must remove exactly one session — which is what shows the
    // counter is live rather than merely unmoved.
    handler.close!(foreign as never, 1006, "gone");
    handler.drain!(foreign as never);
    expect(h.api.websocket!.sessions).toBe(2);
    handler.close!(ours as never, 1000, "bye");
    expect(h.api.websocket!.sessions).toBe(1);

    // And the real client is still live after the foreign traffic.
    client.send({ op: "ping", id: "alive" });
    await client.next("pong", (frame) => frame.id === "alive");
  });

  it("attach() refuses a router with no BunWebSocket, and accepts an adapter's instance", async () => {
    const api = createJobsApi(apiConfig());
    cleanups.push(() => api.close());
    expect(() => api.websocket!.attach(new BunRouter())).toThrow(ConfigError);
    expect(() => api.websocket!.attach({ instance: new BunRouter() })).toThrow(
      /none is attached/,
    );

    // The control: the `{ instance }` form resolves the adapter's socket.
    const adapter = new BunHttpAdapter(0, { logger: noopLogger });
    cleanups.push(() => adapter.close());
    expect(() => api.websocket!.attach({ instance: adapter })).not.toThrow();

    await api.close();
    expect(() => api.websocket!.attach(adapter)).toThrow(/closed/);
  });

  it("upgrades on raw Bun.serve through upgrade(), with the same guard", async () => {
    const jobs = publishingJobs();
    const api = createJobsApi({
      jobs,
      basePath: "/admin/jobs",
      logger: noopLogger,
      authorize: (req) =>
        req.getHeader("x-token") === "ok"
          ? true
          : { allow: false, status: 401 },
    });
    const root = new BunRouter();
    root.use(api.basePath, api.router);
    const server = Bun.serve({
      port: 0,
      async fetch(req, srv) {
        const answer = await api.websocket!.upgrade(req, srv);
        if (answer !== null) {
          return answer;
        }
        return await root.fetch(req);
      },
      websocket: api.websocket!.handler,
    });
    cleanups.push(async () => {
      await api.close();
      server.stop(true);
    });
    const url = `ws://127.0.0.1:${server.port}/admin/jobs/ws`;

    const client = await connect(url, {
      headers: { "x-token": "ok" },
      protocols: [JOBS_API_WS_SUBPROTOCOL],
    });
    await client.next("hello");
    expect(client.ws.protocol).toBe(JOBS_API_WS_SUBPROTOCOL);

    const refused = await fetch(
      `http://127.0.0.1:${server.port}/admin/jobs/ws`,
      {
        headers: UPGRADE_HEADERS,
      },
    );
    expect(refused.status).toBe(401);
    // Not for the socket: null, so the host's routing answers.
    const meta = await fetch(
      `http://127.0.0.1:${server.port}/admin/jobs/meta`,
      {
        headers: { "x-token": "ok" },
      },
    );
    expect(meta.status).toBe(200);
  });

  it("serves the socket on a dedicated port, and close() stops that server", async () => {
    const jobs = publishingJobs();
    const api = createJobsApi({
      jobs,
      basePath: "/admin/jobs",
      logger: noopLogger,
      authorize: () => true,
      websocket: { port: 0 },
    });
    cleanups.push(() => api.close());
    const port = api.websocket!.port!;
    expect(port).toBeGreaterThan(0);
    const client = await connect(`ws://127.0.0.1:${port}/admin/jobs/ws`);
    await client.next("hello");
    expect(() => api.websocket!.attach(new BunHttpAdapter(0))).toThrow(
      /its own server/,
    );

    await api.close();
    expect((await client.closed).code).toBe(1001);
    await expect(
      fetch(`http://127.0.0.1:${port}/admin/jobs/ws`),
    ).rejects.toThrow();
  });
});

describe("subscribing", () => {
  it("acks what it accepted, in canonical form, and rejects the rest per channel", async () => {
    const h = await served({ websocket: { maxSubscriptions: 3 } });
    const client = await connect(h.url);
    client.send({
      op: "subscribe",
      id: "s1",
      channels: [
        "queue/mail",
        "queue/bad name",
        "nope",
        "queue/mail",
        `queue/mail/job/a%2Fb`,
        "queue/mail/job/%E0%A4%A",
        "runner/nightly",
        "all",
      ],
    });
    const ack = await client.next("ack");
    expect(ack).toEqual({
      type: "ack",
      id: "s1",
      op: "subscribe",
      channels: ["queue/mail", "queue/mail/job/a%2Fb", "runner/nightly"],
      rejected: [
        expect.objectContaining({
          channel: "queue/bad name",
          code: "INVALID_CHANNEL",
          status: 400,
        }),
        expect.objectContaining({
          channel: "nope",
          code: "INVALID_CHANNEL",
          status: 400,
        }),
        expect.objectContaining({
          channel: "queue/mail/job/%E0%A4%A",
          code: "INVALID_CHANNEL",
        }),
        expect.objectContaining({
          channel: "all",
          code: "SUBSCRIPTION_LIMIT",
          status: 400,
        }),
      ],
      seq: 0,
    });

    client.send({
      op: "unsubscribe",
      id: "u1",
      channels: ["runner/nightly", "queue/never"],
    });
    expect(
      await client.next("ack", (frame) => frame.id === "u1"),
    ).toMatchObject({
      op: "unsubscribe",
      channels: ["runner/nightly", "queue/never"],
    });
    client.send({ op: "ping", id: "p1" });
    expect(await client.next("pong")).toMatchObject({ id: "p1" });
    expect(client.invalid).toEqual([]);
  });

  it("answers malformed frames with VALIDATION errors, keeping the connection", async () => {
    const h = await served();
    const client = await connect(h.url);
    client.ws.send("{not json");
    expect(await client.next("error")).toMatchObject({
      code: "VALIDATION",
      status: 400,
    });
    client.send({ op: "subscribe", id: "x" });
    expect(
      await client.next("error", (frame) => frame.id === "x"),
    ).toMatchObject({
      code: "VALIDATION",
      detail: expect.stringContaining("channels"),
    });
    client.send({ op: "ping", id: "still-here" });
    await client.next("pong");
  });

  it("tells a connection that may not subscribe nothing about the schema", async () => {
    const calls: Parameters<JobsApiAuthorize>[1][] = [];
    const h = await served({
      authorize: (_req, context) => {
        if (context.action === "events.subscribe") {
          calls.push(context);
          return { allow: false, status: 403 };
        }
        return true;
      },
    });
    const client = await connect(h.url);
    client.send({ op: "subscribe", id: "x" });
    client.ws.send("{not json");
    const refused = await client.next("error", (frame) => frame.id === "x");
    expect(refused).toEqual({
      type: "error",
      id: "x",
      code: "FORBIDDEN",
      status: 403,
      detail: "The message was refused",
    });
    await waitFor(() => client.all("error").length === 2);
    expect(client.all("error").map((frame) => frame.code)).toEqual([
      "FORBIDDEN",
      "FORBIDDEN",
    ]);
    expect(client.raw.join("")).not.toContain("channels");
    // Asked once, without a target, and cached for the session.
    expect(calls).toEqual([
      { action: "events.subscribe", transport: "ws", mutation: false },
    ]);
  });

  it("offers only the channels of its mode", async () => {
    const jobs = publishingJobs();
    const h = await served({ jobs, mode: "jobs" });
    const client = await connect(h.url);
    client.send({
      op: "subscribe",
      id: "s",
      channels: ["queues", "runner/r", "runners", "all"],
    });
    const ack = await client.next("ack");
    expect(ack.channels).toEqual(["queues"]);
    expect(ack.rejected?.map((rejection) => rejection.code)).toEqual([
      "CHANNEL_NOT_AVAILABLE",
      "CHANNEL_NOT_AVAILABLE",
      "CHANNEL_NOT_AVAILABLE",
    ]);
  });

  it("authorizes each channel separately, once per session, and delivers only what was allowed", async () => {
    const calls: Parameters<JobsApiAuthorize>[1][] = [];
    const h = await served({
      authorize: (_req, context) => {
        if (context.action !== "events.subscribe") {
          return true;
        }
        calls.push(context);
        if (context.queue === "secret") {
          return { allow: false, reason: "not yours" };
        }
        return context.runner ? { allow: false, status: 401 } : true;
      },
    });
    const client = await connect(h.url);
    client.send({
      op: "subscribe",
      id: "s1",
      channels: ["queue/mail", "queue/secret", "runner/r"],
    });
    const ack = await client.next("ack");
    expect(ack.channels).toEqual(["queue/mail"]);
    expect(ack.rejected).toEqual([
      {
        channel: "queue/secret",
        code: "FORBIDDEN",
        status: 403,
        detail: "not yours",
      },
      { channel: "runner/r", code: "UNAUTHORIZED", status: 401 },
    ]);
    expect(calls).toEqual([
      {
        action: "events.subscribe",
        transport: "ws",
        mutation: false,
        channel: "queue/mail",
        queue: "mail",
      },
      {
        action: "events.subscribe",
        transport: "ws",
        mutation: false,
        channel: "queue/secret",
        queue: "secret",
      },
      {
        action: "events.subscribe",
        transport: "ws",
        mutation: false,
        channel: "runner/r",
        runner: "r",
      },
    ]);

    // Decisions are cached for the session.
    client.send({
      op: "subscribe",
      id: "s2",
      channels: ["queue/mail", "queue/secret"],
    });
    await client.next("ack", (frame) => frame.id === "s2");
    expect(calls).toHaveLength(3);

    await h.jobs.queue("secret").add("x", {});
    await h.jobs.queue("mail").add("x", {});
    await client.next("event", (frame) => frame.event.target === "mail");
    expect(
      client.all("event").filter((frame) => frame.event.target === "secret"),
    ).toEqual([]);
  });
});

describe("events", () => {
  it("delivers queue, job and runner events from a publishing BunJobs, once each, listing every match", async () => {
    const h = await served();
    const client = await connect(h.url);
    client.send({
      op: "subscribe",
      id: "s",
      channels: [
        "queues",
        "queue/mail",
        `queue/mail/job/${encodeURIComponent("a/b")}`,
        "runner/echo",
      ],
    });
    await client.next("ack");

    await h.jobs.queue("mail").add("send", { to: "x" }, { jobId: "a/b" });
    const added = await client.next(
      "event",
      (frame) => frame.event.type === "added",
    );
    expect(added.subscriptions).toEqual([
      "queues",
      "queue/mail",
      "queue/mail/job/a%2Fb",
    ]);
    expect(added.event).toMatchObject({
      v: 1,
      kind: "queue",
      target: "mail",
      id: "a/b",
      payload: { id: "a/b" },
    });
    // Once, however many channels matched.
    expect(
      client.all("event").filter((frame) => frame.seq === added.seq),
    ).toHaveLength(1);

    // The control: a job with another id matches fewer channels.
    await h.jobs.queue("mail").add("send", {}, { jobId: "other" });
    const other = await client.next(
      "event",
      (frame) => frame.event.id === "other",
    );
    expect(other.subscriptions).toEqual(["queues", "queue/mail"]);

    const runner = h.jobs.runner({
      id: "echo",
      file: ECHO_HANDLER.pathname,
      executionMode: "in-process",
      waitToExit: false,
      syncInterval: 0,
    });
    await runner.start();
    await runner.trigger();
    const succeeded = await client.next(
      "event",
      (frame) =>
        frame.event.kind === "runner" && frame.event.type === "succeeded",
    );
    expect(succeeded.subscriptions).toEqual(["runner/echo"]);
    expect(client.invalid).toEqual([]);
  });

  it("applies a subscription's event-type filter", async () => {
    const h = await served();
    const client = await connect(h.url);
    client.send({
      op: "subscribe",
      id: "s",
      channels: ["queue/mail"],
      events: ["removed"],
    });
    await client.next("ack");
    const queue = h.jobs.queue("mail");
    await queue.add("x", {}, { jobId: "1" });
    await queue.remove("1");
    const removed = await client.next(
      "event",
      (frame) => frame.event.type === "removed",
    );
    expect(client.all("event").map((frame) => frame.event.type)).toEqual([
      "removed",
    ]);
    expect(removed.seq).toBeGreaterThan(1);
  });

  it("strips ns, origin and stacks, and runs serialize.event per session", async () => {
    const jobs = publishingJobs();
    jobs.define("boom", () => {
      throw new Error("kaput");
    });
    const h = await served({
      jobs,
      serialize: {
        event: (dto, _event, req) =>
          req.getHeader("x-redact") && dto.type === "added" ? null : dto,
      },
    });
    const redacted = await connect(h.url, { headers: { "x-redact": "1" } });
    const plain = await connect(h.url);
    for (const client of [redacted, plain]) {
      client.send({ op: "subscribe", id: "s", channels: ["queues"] });
      await client.next("ack");
    }
    await jobs.start({ pollInterval: 5, waitToExit: false });
    await jobs.now("boom", {});

    const failed = await plain.next(
      "event",
      (frame) => frame.event.type === "failed",
    );
    expect(failed.event.payload).toMatchObject({
      error: { name: "Error", message: "kaput" },
    });
    const text = plain.raw.find((frame) => frame.includes('"failed"'))!;
    expect(text).not.toContain('"stack"');
    expect(text).not.toContain('"origin"');
    expect(text).not.toContain('"ns"');

    await redacted.next("event", (frame) => frame.event.type === "failed");
    expect(
      plain.all("event").some((frame) => frame.event.type === "added"),
    ).toBe(true);
    expect(
      redacted.all("event").some((frame) => frame.event.type === "added"),
    ).toBe(false);

    // The control: with exposeStacks the same check does see a stack.
    const exposing = publishingJobs();
    exposing.define("boom", () => {
      throw new Error("kaput");
    });
    const e = await served({
      jobs: exposing,
      serialize: { exposeStacks: true },
    });
    const client = await connect(e.url);
    client.send({ op: "subscribe", id: "s", channels: ["queues"] });
    await client.next("ack");
    await exposing.start({ pollInterval: 5, waitToExit: false });
    await exposing.now("boom", {});
    const withStack = await client.next(
      "event",
      (frame) => frame.event.type === "failed",
    );
    const failure = withStack.event.payload as { error: { stack?: unknown } };
    expect(typeof failure.error.stack).toBe("string");
  });

  it("carries the latest seq on heartbeats", async () => {
    const h = await served({ websocket: { heartbeatMs: 30 } });
    const client = await connect(h.url);
    client.send({ op: "subscribe", id: "s", channels: ["queue/mail"] });
    await client.next("ack");
    await h.jobs.queue("mail").add("x", {});
    const event = await client.next(
      "event",
      (frame) => frame.event.type === "added",
    );
    await Bun.sleep(20);
    const latest = Math.max(...client.all("event").map((frame) => frame.seq));
    expect(latest).toBeGreaterThanOrEqual(event.seq);
    const heartbeat = await client.next(
      "heartbeat",
      (frame) => frame.seq === latest && frame.at > 0,
    );
    expect(heartbeat.seq).toBe(latest);

    // The control: heartbeatMs 0 sends none.
    const quiet = await served({ websocket: { heartbeatMs: 0 } });
    const silent = await connect(quiet.url);
    await Bun.sleep(80);
    expect(silent.all("heartbeat")).toEqual([]);
  });
});

describe("resuming", () => {
  it("replays retained events in order before the ack, then goes live", async () => {
    const h = await served();
    const first = await connect(h.url);
    const { epoch } = await first.next("hello");
    first.send({
      op: "subscribe",
      id: "s",
      channels: ["queue/mail"],
      events: ["added"],
    });
    await first.next("ack");
    const queue = h.jobs.queue("mail");
    await queue.add("x", {}, { jobId: "j1" });
    const seen = await first.next("event", (frame) => frame.event.id === "j1");
    await queue.add("x", {}, { jobId: "j2" });
    await first.next("event", (frame) => frame.event.id === "j2");
    first.ws.close();
    await waitFor(() => h.api.websocket!.sessions === 0);
    await queue.add("x", {}, { jobId: "j3" });

    const second = await connect(h.url);
    await second.next("hello");
    second.send({
      op: "subscribe",
      id: "r",
      channels: ["queue/mail"],
      events: ["added"],
      resume: { epoch, afterSeq: seen.seq },
    });
    const ack = await second.next("ack");
    expect(ack.resumed).toBe(true);
    const ackIndex = second.frames.indexOf(ack);
    const replayed = second.frames
      .slice(0, ackIndex)
      .filter((frame) => frame.type === "event");
    expect(replayed.map((frame) => (frame as Frame<"event">).event.id)).toEqual(
      ["j2", "j3"],
    );
    const seqs = replayed.map((frame) => (frame as Frame<"event">).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(second.all("gap")).toEqual([]);

    await queue.add("x", {}, { jobId: "j4" });
    await second.next("event", (frame) => frame.event.id === "j4");
  });

  it("answers an expired resume with a gap, and a different instance with epoch-changed", async () => {
    const h = await served({ websocket: { replay: { size: 1 } } });
    const first = await connect(h.url);
    const { epoch } = await first.next("hello");
    first.send({ op: "subscribe", id: "s", channels: ["queue/mail"] });
    await first.next("ack");
    const queue = h.jobs.queue("mail");
    await queue.add("x", {}, { jobId: "j1" });
    const seen = await first.next("event", (frame) => frame.event.id === "j1");
    await queue.add("x", {}, { jobId: "j2" });
    await queue.add("x", {}, { jobId: "j3" });
    await first.next("event", (frame) => frame.event.id === "j3");
    const latest = Math.max(...first.all("event").map((frame) => frame.seq));

    const expired = await connect(h.url);
    expired.send({
      op: "subscribe",
      id: "r",
      channels: ["queue/mail"],
      resume: { epoch, afterSeq: seen.seq },
    });
    expect((await expired.next("ack")).resumed).toBe(false);
    expect(await expired.next("gap")).toEqual({
      type: "gap",
      epoch,
      fromSeq: seen.seq + 1,
      toSeq: latest,
      reason: "resume-expired",
      channels: ["queue/mail"],
    });
    expect(expired.all("event")).toEqual([]);

    // The control: resuming from the latest seq is within the buffer.
    const current = await connect(h.url);
    current.send({
      op: "subscribe",
      id: "r",
      channels: ["queue/mail"],
      resume: { epoch, afterSeq: latest },
    });
    expect((await current.next("ack")).resumed).toBe(true);
    expect(current.all("gap")).toEqual([]);

    const elsewhere = await served({ jobs: h.jobs });
    const moved = await connect(elsewhere.url);
    expect((await moved.next("hello")).epoch).not.toBe(epoch);
    moved.send({
      op: "subscribe",
      id: "r",
      channels: ["queue/mail"],
      resume: { epoch, afterSeq: seen.seq },
    });
    expect((await moved.next("ack")).resumed).toBe(false);
    expect(await moved.next("gap")).toMatchObject({
      reason: "epoch-changed",
      fromSeq: 0,
    });
  });
});

describe("client limits", () => {
  it("errors on the first rate-limit breach and closes 1008 on the second", async () => {
    const h = await served({ websocket: { messagesPerSecond: 1 } });
    const client = await connect(h.url);
    for (let index = 0; index < 6; index++) {
      client.send({ op: "ping", id: `p${index}` });
    }
    expect((await client.closed).code).toBe(1008);
    expect(client.all("pong").map((frame) => frame.id)).toEqual(["p0", "p1"]);
    expect(client.all("error")).toEqual([
      expect.objectContaining({ code: "RATE_LIMITED", status: 429 }),
    ]);

    // The control: the default rate takes the same burst.
    const relaxed = await served();
    const calm = await connect(relaxed.url);
    for (let index = 0; index < 6; index++) {
      calm.send({ op: "ping", id: `p${index}` });
    }
    await calm.next("pong", (frame) => frame.id === "p5");
    expect(calm.all("error")).toEqual([]);
  });

  it("closes 1009 on an oversized frame, and 1003 on a binary one", async () => {
    const h = await served({ websocket: { maxMessageBytes: 64 } });
    const big = await connect(h.url);
    big.ws.send(JSON.stringify({ op: "ping", id: "x".repeat(100) }));
    expect((await big.closed).code).toBe(1009);
    expect(big.all("error")).toEqual([
      expect.objectContaining({ code: "MESSAGE_TOO_LARGE", status: 413 }),
    ]);

    const small = await connect(h.url);
    small.send({ op: "ping", id: "fits" });
    await small.next("pong");

    const binary = await connect(h.url);
    binary.ws.send(new Uint8Array([123, 125]));
    expect((await binary.closed).code).toBe(1003);
  });
});

describe("backpressure", () => {
  it("lags on backpressure, sends one gap on drain, and closes 4008 after the timeout", async () => {
    const clock = new FakeClock();
    const jobs = publishingJobs();
    const config = resolveConfig({
      jobs,
      basePath: "/admin/jobs",
      authorize: () => true,
      logger: noopLogger,
      websocket: {
        heartbeatMs: 0,
        slowConsumerTimeoutMs: 5000,
        maxBufferedBytes: 1000,
      },
    });
    const api = buildJobsApi(config, builtInRoutes(config), { clock });
    cleanups.push(() => api.close());
    const handler = api.websocket!.handler;

    /** A stub socket whose `send` result and buffer are the test's to set. */
    const stub = async (sessionId: string) => {
      const request = await BunRequest.init(
        new Request("http://localhost/admin/jobs/ws"),
        testServer,
        { parseBody: false, parseCookies: false, parseQuery: true },
      );
      const socket = {
        data: { custom: { bunJobsApi: true, sessionId, request } },
        readyState: 1,
        sendResult: 64,
        buffered: 0,
        sent: [] as JobsApiServerMessage[],
        closes: [] as number[],
        send(text: string) {
          socket.sent.push(JSON.parse(text) as JobsApiServerMessage);
          return socket.sendResult;
        },
        getBufferedAmount: () => socket.buffered,
        close(code: number) {
          socket.closes.push(code);
        },
      };
      const client = socket as unknown as WebSocketClient<JobsApiSocketData>;
      handler.open!(client);
      handler.message!(
        client,
        JSON.stringify({
          op: "subscribe",
          id: "s",
          channels: ["queue/mail"],
          events: ["added"],
        }),
      );
      await waitFor(() => socket.sent.some((frame) => frame.type === "ack"));
      return { socket, client };
    };
    const events = (sent: JobsApiServerMessage[]) =>
      sent.filter((frame): frame is Frame<"event"> => frame.type === "event");

    const slow = await stub("slow");
    const healthy = await stub("healthy");
    const queue = jobs.queue("mail");

    slow.socket.sendResult = -1;
    await queue.add("x", {}, { jobId: "1" });
    await queue.add("x", {}, { jobId: "2" });
    await queue.add("x", {}, { jobId: "3" });
    await waitFor(() => events(healthy.socket.sent).length === 3);
    // The first was queued under backpressure; the other two were held back.
    expect(events(slow.socket.sent).map((frame) => frame.event.id)).toEqual([
      "1",
    ]);
    expect(slow.socket.sent.some((frame) => frame.type === "gap")).toBe(false);

    const [first, , third] = events(healthy.socket.sent);
    slow.socket.sendResult = 64;
    handler.drain!(slow.client);
    expect(slow.socket.sent.at(-1)).toEqual({
      type: "gap",
      epoch: expect.any(String),
      fromSeq: first!.seq + 1,
      toSeq: third!.seq,
      reason: "slow-consumer",
      channels: ["queue/mail"],
    });

    // Live again.
    await queue.add("x", {}, { jobId: "4" });
    await waitFor(() =>
      events(slow.socket.sent).some((frame) => frame.event.id === "4"),
    );

    // Past maxBufferedBytes the event is not even attempted.
    slow.socket.buffered = 5000;
    await queue.add("x", {}, { jobId: "5" });
    await waitFor(() => events(healthy.socket.sent).length === 5);
    expect(
      events(slow.socket.sent).some((frame) => frame.event.id === "5"),
    ).toBe(false);
    // A drain while the buffer is still full changes nothing.
    handler.drain!(slow.client);
    clock.advance(4999);
    expect(slow.socket.closes).toEqual([]);
    clock.advance(1);
    expect(slow.socket.closes).toEqual([4008]);
    expect(healthy.socket.closes).toEqual([]);
    expect(api.websocket!.sessions).toBe(1);
  });
});

describe("close()", () => {
  it("closes sessions with 1001 and the notifier it opened, never the BunJobs", async () => {
    const jobs = publishingJobs();
    const opened = spyOn(jobs, "notifier");
    const h = await served({ jobs, mode: "jobs" });
    const client = await connect(h.url);
    client.send({ op: "subscribe", id: "s", channels: ["queue/mail"] });
    await client.next("ack");
    expect(opened).toHaveBeenCalledTimes(1);
    // The mode narrows what the notifier follows.
    expect(opened.mock.calls[0]![0]).toEqual({ runners: [] });
    const notifier = (await opened.mock.results[0]!.value) as JobsNotifier;
    const closeSpy = spyOn(notifier, "close");

    await h.api.close();
    expect((await client.closed).code).toBe(1001);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(notifier.following).toEqual([]);
    expect(h.api.websocket!.sessions).toBe(0);
    expect((await refusedUpgrade(h.origin)).status).toBe(404);

    // The context is untouched.
    await jobs.queue("still-open").add("x", {});
    expect(await jobs.listQueues()).toContain("still-open");
    await h.api.close();
  });
});

describe("EventHub", () => {
  /** A hub over a resolved configuration and a fake clock. */
  function hubFor(websocket: JobsApiConfig["websocket"] = {}) {
    const clock = new FakeClock();
    const config = resolveConfig(apiConfig({ websocket }));
    const hub = new EventHub(config, {
      clock,
      openNotifier: async () => {
        throw new Error("not used");
      },
    });
    return { hub, clock };
  }

  /** A subscriber recording what it receives. */
  function recorder() {
    const received: { seq: number; type: string; keys: string[] }[] = [];
    const subscriber: HubSubscriber = {
      deliver: (stamped: StampedEvent, keys: string[]) => {
        received.push({ seq: stamped.seq, type: stamped.event.type, keys });
      },
    };
    return { received, subscriber };
  }

  /** A queue event. */
  const event = (
    type: "added" | "completed",
    target: string,
    id: string,
  ): DriverEvent =>
    type === "added"
      ? queueEvent({ ns: "api-routes", target, type, origin: "o" }, { id })
      : queueEvent(
          { ns: "api-routes", target, type, origin: "o" },
          { id, returnValue: null },
        );

  /** A progress event. */
  const progress = (id: string, value: number): DriverEvent =>
    queueEvent(
      { ns: "api-routes", target: "mail", type: "progress", origin: "o" },
      { id, progress: value },
    );

  it("stamps a monotonic seq and delivers once per subscriber, listing every matching channel", () => {
    const { hub } = hubFor();
    const one = recorder();
    const two = recorder();
    hub.subscribe(one.subscriber, "queues");
    hub.subscribe(one.subscriber, "queue/mail");
    hub.subscribe(two.subscriber, "queue/else");
    hub.ingest(event("added", "mail", "1"));
    hub.ingest(event("added", "else", "2"));
    expect(one.received).toEqual([
      { seq: 1, type: "added", keys: ["queues", "queue/mail"] },
      { seq: 2, type: "added", keys: ["queues"] },
    ]);
    expect(two.received).toEqual([
      { seq: 2, type: "added", keys: ["queue/else"] },
    ]);
    hub.unsubscribe(one.subscriber, "queues");
    hub.unsubscribe(one.subscriber, "queue/mail");
    hub.ingest(event("added", "mail", "3"));
    expect(one.received).toHaveLength(2);
    expect(hub.seq).toBe(3);
  });

  it("coalesces progress per job to the latest, flushing it before the job's next event", () => {
    const { hub, clock } = hubFor({ coalesceProgressMs: 100 });
    const { received, subscriber } = recorder();
    hub.subscribe(subscriber, "queue/mail");
    hub.ingest(progress("1", 1));
    hub.ingest(progress("1", 2));
    hub.ingest(progress("1", 3));
    hub.ingest(progress("2", 1));
    expect(received.map((entry) => entry.type)).toEqual([
      "progress",
      "progress",
    ]);
    clock.advance(100);
    expect(received).toHaveLength(3);
    hub.ingest(progress("1", 4));
    hub.ingest(event("completed", "mail", "1"));
    expect(received.map((entry) => entry.type)).toEqual([
      "progress",
      "progress",
      "progress",
      "progress",
      "completed",
    ]);

    // The control: coalescing off delivers every value.
    const eager = hubFor({ coalesceProgressMs: 0 });
    const all = recorder();
    eager.hub.subscribe(all.subscriber, "queue/mail");
    for (let value = 0; value < 5; value++) {
      eager.hub.ingest(progress("1", value));
    }
    expect(all.received).toHaveLength(5);
  });

  it("replays what it retains, and reports expiry by size, age and epoch", () => {
    const { hub, clock } = hubFor({ replay: { size: 3, maxAgeMs: 1000 } });
    for (let index = 1; index <= 5; index++) {
      hub.ingest(event("added", "mail", String(index)));
    }
    const ok = hub.replay(hub.epoch, 2);
    expect(
      ok.status === "ok" && ok.events.map((stamped) => stamped.seq),
    ).toEqual([3, 4, 5]);
    expect(hub.replay(hub.epoch, 1).status).toBe("resume-expired");
    expect(hub.replay(hub.epoch, 5)).toEqual({ status: "ok", events: [] });
    expect(hub.replay(hub.epoch, 6).status).toBe("resume-expired");
    expect(hub.replay("elsewhere", 4).status).toBe("epoch-changed");
    clock.advance(1001);
    expect(hub.replay(hub.epoch, 5)).toEqual({ status: "ok", events: [] });
    expect(hub.replay(hub.epoch, 4).status).toBe("resume-expired");

    const off = hubFor({ replay: false });
    off.hub.ingest(event("added", "mail", "1"));
    expect(off.hub.replay(off.hub.epoch, 1).status).toBe("resume-expired");
  });
});

describe("channels", () => {
  const config = () => resolveConfig(apiConfig());

  it("canonicalises job ids and computes every channel an event reaches", () => {
    const parsed = parseChannel("queue/mail/job/a%2fb", config());
    expect(parsed).toMatchObject({
      ok: true,
      channel: {
        key: "queue/mail/job/a%2Fb",
        target: { queue: "mail", jobId: "a/b" },
      },
    });
    expect(
      channelKeysFor(
        queueEvent(
          { ns: "n", target: "mail", type: "stalled", origin: "o" },
          { ids: ["a/b", "c", "c"] },
        ),
      ),
    ).toEqual([
      "all",
      "queues",
      "queue/mail",
      "queue/mail/job/a%2Fb",
      "queue/mail/job/c",
    ]);
    expect(
      channelKeysFor(
        runnerEvent(
          { ns: "n", target: "nightly", type: "started", origin: "o" },
          { runId: "r1" },
        ),
      ),
    ).toEqual(["all", "runners", "runner/nightly"]);
  });

  it("refuses queues outside a configured list", () => {
    const jobs = new BunJobs({
      namespace: testNamespace("ch"),
      driver: new MemoryDriver(),
      logger: noopLogger,
    });
    cleanups.push(() => jobs.close());
    const listed = resolveConfig({
      jobs,
      queues: ["mail"],
      basePath: "/a",
      authorize: () => true,
      logger: noopLogger,
    });
    expect(parseChannel("queue/mail", listed).ok).toBe(true);
    expect(parseChannel("queue/other", listed)).toMatchObject({
      ok: false,
      rejection: { code: "QUEUE_NOT_FOUND", status: 404 },
    });
  });
});

describe("sharing a router with other WebSocket routes", () => {
  /** An API and an adapter, both closed afterwards. */
  function pair(overrides: Partial<JobsApiConfig> = {}) {
    const api = createJobsApi(apiConfig(overrides));
    const adapter = new BunHttpAdapter(0, { logger: noopLogger });
    cleanups.push(async () => {
      await api.close();
      await adapter.close();
    });
    return { api, adapter };
  }

  it("refuses to attach where a WebSocket route already covers the path", async () => {
    const { api, adapter } = pair();
    // What a NestJS gateway with a `"/*"` namespace registers: middleware on
    // the same router, matching this socket's path. Registered first, it would
    // upgrade every client before our guard ran — a socket that exists and can
    // never answer.
    await adapter.webSocketAdapter.setRouteHandler(
      "/*",
      { open: () => {}, message: () => {} },
      undefined,
    );

    let message = "";
    try {
      api.websocket!.attach(adapter);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("/*");
    expect(message).toContain("/admin/jobs/ws");

    // The control: a WebSocket route that does not cover this path is no
    // conflict, and attaching succeeds.
    const clean = pair();
    await clean.adapter.webSocketAdapter.setRouteHandler(
      "/chat",
      { open: () => {}, message: () => {} },
      undefined,
    );
    expect(() => clean.api.websocket!.attach(clean.adapter)).not.toThrow();
  });

  it("reserves no connection slot when another layer upgrades first", async () => {
    // One connection allowed, so a leaked reservation is visible: the next
    // legitimate upgrade would be refused with 429.
    const { api, adapter } = pair({ websocket: { maxConnections: 1 } });

    // A foreign layer at the same path, registered *before* the guard, which
    // upgrades whenever a client asks it to. It is not a `ws()` route, so
    // `attach()` has nothing to refuse — and it ends the request before our
    // layers run.
    adapter.use("/admin/jobs/ws", (req, res, next) => {
      if (req.getHeader("x-foreign") === "1") {
        res.upgradeToWebsocket();
        return;
      }
      next();
    });
    adapter.use(api.basePath, api.router);
    api.websocket!.attach(adapter);
    const server = await adapter.listen(0);
    const url = `ws://127.0.0.1:${server.port}/admin/jobs/ws`;

    // Three upgrades the foreign layer takes. None of them is ours, so none
    // may consume the cap.
    for (let index = 0; index < 3; index++) {
      const foreign = new WebSocket(url, {
        headers: { "x-foreign": "1" },
      } as unknown as string[]);
      await new Promise<void>((resolve) => {
        foreign.onopen = () => resolve();
        foreign.onerror = () => resolve();
        foreign.onclose = () => resolve();
      });
      foreign.close();
    }
    expect(api.websocket!.sessions).toBe(0);

    // The cap is intact: a real client still connects.
    const client = await connect(url);
    await client.next("hello");
    expect(api.websocket!.sessions).toBe(1);

    // The control: the counter really is live — with the one slot taken, the
    // next upgrade is refused, so the assertion above was not vacuous.
    const refused = await fetch(
      `http://127.0.0.1:${server.port}/admin/jobs/ws`,
      {
        headers: UPGRADE_HEADERS,
      },
    );
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "CONNECTION_LIMIT" });
  });

  it("registers its handler on the BunWebSocket current when a client upgrades", async () => {
    const { api, adapter } = pair();
    adapter.use(api.basePath, api.router);
    api.websocket!.attach(adapter);

    // `app.useWebSocketAdapter()` installs a new `BunWebSocket`, whose
    // constructor takes the router over. The socket must follow that swap:
    // binding at `attach()` would leave the handler on the instance that is
    // no longer consulted, and clients would connect to silence.
    const replacement = new BunWebSocket({
      newInstance: false,
      router: adapter.instance,
      getServer: () => adapter.server as never,
    });
    expect(adapter.instance.getBunWebsocket()).toBe(replacement);

    const server = await adapter.listen(0);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/admin/jobs/ws`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
      ws.onerror = () => resolve();
      ws.onclose = () => resolve();
    });
    await Bun.sleep(50);
    ws.close();

    /** The route table of a `BunWebSocket`, by registered pattern. */
    const keysOf = (socket: BunWebSocket<unknown>) => [
      ...(
        socket as unknown as { _routeHandlers: Map<string, unknown[]> }
      )._routeHandlers.keys(),
    ];

    // The handler went to the instance current at upgrade time…
    expect(keysOf(replacement)).toContain("/admin/jobs/ws");
    // …and the control: not to the one `attach()` happened to see, which is
    // the binding this fix removed.
    expect(keysOf(adapter.webSocketAdapter)).not.toContain("/admin/jobs/ws");

    // Delivery after a swap is asserted in bun-nest's module suite instead:
    // `bun-common`'s adapter hands `Bun.serve` one `wsHandler` by value at
    // listen (`BunHttpAdapter.ts:985`), so a replacement on the router is
    // never consulted there — bun-nest's adapter delegates per call, which is
    // the path `useWebSocketAdapter()` actually takes.
  });
});
