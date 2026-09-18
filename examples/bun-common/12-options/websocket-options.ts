/**
 * Option tour: every field of `BunWebSocketOptions` — its shared
 * `BunWebSocketGeneralOptions`, `BunWebSocketNormalOptions` and
 * `BunWebSocketCreateServerOptions` — every `wsOptions` setting, every event
 * and every public `BunWebSocket` method, each asserted against real
 * `WebSocket` clients.
 *
 * ```bash
 * bun 12-options/websocket-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - `wsOptions` is merged over bun-common's defaults, which are not Bun's:
 *   `perMessageDeflate: true`, `idleTimeout: 30`, `maxPayloadLength` 1 MB.
 * - A standalone server (`newInstance: true`) accepts `listen.port: 0` for an
 *   OS-assigned port, which `.port` then reports.
 * - `ws()` handlers are dispatched by the route pattern the upgrade matched,
 *   so param routes (`/rooms/:id`) work and see `ws.data.route`/`params`.
 * - What an upgrade carries is layered: the router's
 *   `webSocketUpgradeHeaders`/`webSocketUpgradeData`, then the response's (set
 *   by middleware), then the route's `onUpgrade` result — or a bare
 *   `upgradeToWebsocket()`'s own arguments. `customDataToWsClientFn` is the
 *   deprecated name of a hook that returns only `custom`.
 * - The idle-timeout section waits for Bun's idle timer, so the tour takes
 *   several seconds longer than the rest would.
 */
import type {
  BunWebSocketHandlerType,
  JsonValue,
  RouterMiddlewareHandler,
  WebSocketClient,
  WebSocketClientData,
  WebsocketOptions,
} from "@kingsleyweb/bun-common";
import type { Client, ConnectOptions } from "../09-websocket/helpers/client";
import {
  BunHttpAdapter,
  BunRequest,
  BunResponse,
  BunRouter,
  BunWebSocket,
  FETCH_STUB_SERVER,
  getPort,
} from "@kingsleyweb/bun-common";
import { connect, upgradeHead } from "../09-websocket/helpers/client";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title, waitFor } from "../shared/console";

/** A listening adapter, and what the tour needs to reach into it. */
interface Served<T> {
  /** The adapter. */
  adapter: BunHttpAdapter<T>;
  /** Its `ws://host:port` origin. */
  origin: string;
  /** Every event its `BunWebSocket` emitted, by name, in order. */
  events: string[];
  /** Resolves with the server side of the connection opened with `x-id: id`. */
  socket: (id: string) => Promise<WebSocketClient<T>>;
}

/** What `reportData` sends back: the connection's `ws.data`, as JSON. */
interface ReportedData {
  /** `ws.data.host`. */
  host: string;
  /** `ws.data.path`. */
  path: string;
  /** `ws.data.search`. */
  search: string;
  /** `ws.data.hash`. */
  hash: string;
  /** `ws.data.originalUrl`. */
  originalUrl: string;
  /** The `x-demo` header from `ws.data.headers`. */
  header: string | null;
  /** `ws.data.user`, or `null`. */
  user: WebSocketClientData["user"] | null;
  /**
   * `ws.data.custom`, or `null`. `unknown`: the one `reportData` handler serves
   * routes whose `onUpgrade` hooks return different things.
   */
  custom: unknown;
  /** `ws.data.route`, or `null`. */
  route: string | null;
  /** `ws.data.params`, or `null`. */
  params: Record<string, string> | null;
  /** `ws.data.port`, or `null`. */
  port: number | null;
}

/** What a standalone server's `/inspect` route answers, as JSON. */
interface Inspected {
  /** `req.query`. */
  query: Record<string, JsonValue>;
  /** `req.cookies`. */
  cookies: Record<string, JsonValue>;
}

/** Every event name a `BunWebSocket` emits. */
const EVENTS = [
  "connect",
  "open",
  "message",
  "disconnect",
  "close",
  "ping",
  "pong",
  "drain",
] as const;

/** Clients opened by the tour, closed at the end. */
const clients: Client[] = [];

/** Servers opened by the tour, closed at the end, after the clients. */
const closers: (() => Promise<void>)[] = [];

/** Connects a client and remembers it for cleanup. */
async function openClient(
  url: string,
  options?: ConnectOptions,
): Promise<Client> {
  const client = await connect(url, options);
  clients.push(client);
  return client;
}

/** Connects, and resolves once the route's `open` handler has said `subscribed`. */
async function openSubscribed(
  url: string,
  options?: ConnectOptions,
): Promise<Client> {
  const client = await openClient(url, options);
  await client.waitForText("subscribed", (text) => {
    return text.startsWith("subscribed");
  });
  return client;
}

/** `true` once `predicate` holds, `false` if it never does — for checks. */
async function eventually(
  what: string,
  predicate: () => boolean,
  timeout = 15_000,
): Promise<boolean> {
  return waitFor(what, predicate, { timeout }).then(
    () => true,
    () => false,
  );
}

/** A listening adapter with `websocket` options; `setup` registers its routes. */
async function serve<T = unknown>(
  websocket: Partial<WebsocketOptions<T>> = {},
  setup?: (adapter: BunHttpAdapter<T>) => void,
): Promise<Served<T>> {
  const adapter = new BunHttpAdapter<T>(0, { websocket });
  const sockets = new Map<string, WebSocketClient<T>>();
  const events: string[] = [];

  adapter.webSocketAdapter.on("open", (ws) => {
    sockets.set(ws.data.headers.get("x-id") ?? "", ws);
  });
  for (const name of EVENTS) {
    // Every listener has the same shape here, so one cast covers them all.
    adapter.webSocketAdapter.on(name as "drain", () => {
      events.push(name);
    });
  }

  setup?.(adapter);
  await adapter.listen(0);
  closers.push(async () => {
    await adapter.close();
  });

  return {
    adapter,
    origin: adapter.url.replace(/^http/, "ws"),
    events,
    socket: async (id) => {
      await waitFor(`the server side of ${id}`, () => sockets.has(id));
      const socket = sockets.get(id);
      if (!socket) {
        throw new Error(`no server side for ${id}`);
      }
      return socket;
    },
  };
}

/**
 * Subscribes to `room` on open and says `subscribed`; publishes `pub:<text>`
 * messages to the room and acknowledges with `published`; answers anything
 * else with `got <length>`.
 */
const roomHandler: BunWebSocketHandlerType = {
  open(ws) {
    ws.subscribe("room");
    ws.sendText("subscribed");
  },
  message(ws, message) {
    if (typeof message === "string" && message.startsWith("pub:")) {
      ws.publish("room", message.slice(4));
      ws.sendText("published");
      return;
    }
    ws.sendText(`got ${message.length}`);
  },
};

/** Sends the connection's `ws.data` back as JSON on open. */
const reportData: BunWebSocketHandlerType = {
  open(ws) {
    const report: ReportedData = {
      host: ws.data.host,
      path: ws.data.path,
      search: ws.data.search,
      hash: ws.data.hash,
      originalUrl: ws.data.originalUrl,
      header: ws.data.headers.get("x-demo"),
      user: ws.data.user ?? null,
      custom: ws.data.custom ?? null,
      route: ws.data.route ?? null,
      params: ws.data.params ?? null,
      port: ws.data.port ?? null,
    };
    ws.sendText(JSON.stringify(report));
  },
  message() {},
};

/**
 * What a bare `res.upgradeToWebsocket()` route in the layers step reports:
 * only the two fields that step compares.
 */
interface BareReport {
  /** `ws.data.custom`. */
  custom: unknown;
  /** `ws.data.hash`. */
  hash: string;
}

/**
 * Opens `url` and answers the report its route sends — a `ReportedData`
 * unless `T` names another shape.
 */
async function reportFor<T = ReportedData>(
  url: string,
  options?: ConnectOptions,
): Promise<T> {
  const client = await openClient(url, options);
  const text = await client.waitForText("the data report", (message) => {
    return message.startsWith("{");
  });
  return JSON.parse(text) as T;
}

title("Option tour: WebSocket options");

/* ------------------------------------------------------------------ */
step("wsOptions — bun-common's defaults, and overrides merged over them");

{
  const defaults = new BunHttpAdapter(0).webSocketAdapter.wsHandler;
  checkEqual(
    "perMessageDeflate defaults to true",
    defaults.perMessageDeflate,
    true,
  );
  checkEqual("idleTimeout defaults to 30 seconds", defaults.idleTimeout, 30);
  checkEqual(
    "maxPayloadLength defaults to 1 MB",
    defaults.maxPayloadLength,
    1024 * 1024,
  );
  check(
    "every lifecycle callback is supplied by BunWebSocket",
    [
      defaults.open,
      defaults.message,
      defaults.close,
      defaults.ping,
      defaults.pong,
      defaults.drain,
    ].every((callback) => typeof callback === "function"),
  );

  const tuned = new BunHttpAdapter(0, {
    websocket: {
      wsOptions: {
        perMessageDeflate: { compress: "shared", decompress: true },
        idleTimeout: 12,
        maxPayloadLength: 2048,
        backpressureLimit: 4096,
        closeOnBackpressureLimit: true,
        publishToSelf: true,
        sendPings: false,
      },
    },
  }).webSocketAdapter.wsHandler;
  checkEqual(
    "every wsOptions field overrides its default",
    {
      perMessageDeflate: tuned.perMessageDeflate,
      idleTimeout: tuned.idleTimeout,
      maxPayloadLength: tuned.maxPayloadLength,
      backpressureLimit: tuned.backpressureLimit,
      closeOnBackpressureLimit: tuned.closeOnBackpressureLimit,
      publishToSelf: tuned.publishToSelf,
      sendPings: tuned.sendPings,
    },
    {
      perMessageDeflate: { compress: "shared", decompress: true },
      idleTimeout: 12,
      maxPayloadLength: 2048,
      backpressureLimit: 4096,
      closeOnBackpressureLimit: true,
      publishToSelf: true,
      sendPings: false,
    },
  );
}

/* ------------------------------------------------------------------ */
step("BunWebSocketNormalOptions — getServer, and the router option");

const riding = new BunHttpAdapter(0);
checkEqual(
  "getServer may return undefined before the server listens",
  riding.webSocketAdapter.getServer(),
  undefined,
);
await riding.listen(0);
closers.push(async () => {
  await riding.close();
});
check(
  "getServer returns the shared server once it listens",
  riding.webSocketAdapter.getServer() === riding.server &&
    riding.server !== undefined,
);
check(
  "BunHttpAdapter wires its BunWebSocket to itself as the router",
  riding.webSocketAdapter.router === riding &&
    riding.getBunWebsocket() === riding.webSocketAdapter,
);

{
  const router = new BunRouter();
  const direct = new BunWebSocket({
    newInstance: false,
    router,
    getServer: () => riding.server,
  });
  check(
    "router: the BunWebSocket registers itself on the router given",
    direct.router === router && router.getBunWebsocket() === direct,
  );
  check(
    "getServer: consulted when asked",
    direct.getServer() === riding.server,
  );

  const other = new BunRouter();
  direct.router = other;
  check(
    "the router setter re-registers on the new router",
    direct.router === other && other.getBunWebsocket() === direct,
  );
}

/* ------------------------------------------------------------------ */
step("onUpgrade and WebSocketClientData");

{
  /** What the tour's `onUpgrade` hooks produce as `custom`. */
  interface Custom {
    /** Which function produced it. */
    source: "adapter" | "route";
    /** The `?q=` query parameter, for the route's function. */
    q?: string;
  }

  let adapterFnArgs: { request: boolean; response: boolean } | undefined;

  const served = await serve<Custom>(
    {
      onUpgrade: (req, res) => {
        adapterFnArgs = {
          request: req instanceof BunRequest,
          response: res instanceof BunResponse,
        };
        return { custom: { source: "adapter" } };
      },
    },
    (adapter) => {
      const identify: RouterMiddlewareHandler = (req, _res, next) => {
        Object.assign(req, { user: { id: 7 } });
        next();
      };
      adapter.use("/with-user", identify);
      adapter.ws("/with-user", reportData);
      adapter.ws("/adapter-data", reportData);
      adapter.ws("/route-data", reportData, {
        onUpgrade: async (req) => {
          await Promise.resolve();
          return { custom: { source: "route", q: String(req.query.q) } };
        },
      });
    },
  );

  const report = await reportFor(`${served.origin}/adapter-data?x=1&y=two`, {
    headers: { "x-demo": "yes" },
  });
  checkEqual(
    "host is the request's authority",
    report.host,
    new URL(served.adapter.url).host,
  );
  checkEqual("path is the pathname only", report.path, "/adapter-data");
  checkEqual("search keeps its leading ?", report.search, "?x=1&y=two");
  checkEqual("hash is empty: a client never sends a fragment", report.hash, "");
  checkEqual(
    "originalUrl is path + search + hash",
    report.originalUrl,
    "/adapter-data?x=1&y=two",
  );
  checkEqual("headers are the upgrade request's", report.header, "yes");
  checkEqual("user is absent when nothing set req.user", report.user, null);
  checkEqual("custom comes from the adapter-wide onUpgrade", report.custom, {
    source: "adapter",
  });
  checkEqual(
    "onUpgrade receives the BunRequest and BunResponse",
    adapterFnArgs,
    { request: true, response: true },
  );

  checkEqual(
    "a route's own (async) onUpgrade takes precedence",
    (await reportFor(`${served.origin}/route-data?q=hello`)).custom,
    { source: "route", q: "hello" },
  );
  checkEqual(
    "user is req.user as middleware left it",
    (await reportFor(`${served.origin}/with-user`)).user,
    { id: 7 },
  );
  checkEqual(
    "a plain GET to a ws() path is not upgraded and falls through to 404",
    (await served.adapter.fetch("/adapter-data")).status,
    404,
  );
}

/* ------------------------------------------------------------------ */
step("onUpgrade — headers on the 101, and a replacement ws.data");

{
  const served = await serve({}, (adapter) => {
    // The hook's headers go out on the 101. Bun otherwise echoes the first
    // protocol offered; naming one here is how a route picks a subprotocol.
    adapter.ws("/chat", reportData, {
      onUpgrade: () => ({
        headers: { "Sec-WebSocket-Protocol": "chat.v1", "X-Hook": "1" },
      }),
    });
    // `data` replaces ws.data outright; what dispatch needs and it leaves out
    // (route, params, port) is filled in from the match.
    adapter.ws("/rooms/:id", reportData, {
      onUpgrade: () => ({
        data: {
          host: "replaced.example",
          path: "/replaced",
          search: "",
          hash: "",
          originalUrl: "/replaced",
          headers: new Headers({ "x-demo": "from data" }),
          custom: { replaced: true },
        },
      }),
    });
  });

  const chat = await openClient(`${served.origin}/chat`, {
    protocols: ["other", "chat.v1"],
  });
  checkEqual(
    "headers: a Sec-WebSocket-Protocol chooses the subprotocol",
    chat.socket.protocol,
    "chat.v1",
  );
  const head = await upgradeHead(`${served.origin}/chat`, ["other", "chat.v1"]);
  checkEqual(
    "headers: every header the hook returned is on the 101, once",
    [head.values("sec-websocket-protocol"), head.values("x-hook")],
    [["chat.v1"], ["1"]],
  );

  const replaced = await reportFor(`${served.origin}/rooms/42`);
  checkEqual(
    "data: replaces ws.data, and the match fills in route, params and port",
    replaced,
    {
      host: "replaced.example",
      path: "/replaced",
      search: "",
      hash: "",
      originalUrl: "/replaced",
      header: "from data",
      user: null,
      custom: { replaced: true },
      route: "/rooms/:id",
      params: { id: "42" },
      port: served.adapter.server?.port ?? null,
    },
  );
}

/* ------------------------------------------------------------------ */
step("Upgrade layers — router defaults, then res values, then the upgrade");

{
  const served = await serve({}, (adapter) => {
    // Router-wide defaults: chainable setters, or the matching properties.
    adapter
      .setWebSocketUpgradeHeaders({ "X-Layer": "router", "X-Trace": "t-1" })
      .setWebSocketUpgradeData({ custom: { from: "router" }, hash: "#router" });

    // Per request: middleware ahead of the upgrade sets them on res.
    adapter.use("/layered", (_req, res, next) => {
      res.webSocketUpgradeHeaders = { "X-Layer": "res", "X-Res": "1" };
      res.webSocketUpgradeData = { custom: { from: "res" } };
      next();
    });
    adapter.ws("/layered", reportData, {
      onUpgrade: () => ({
        headers: { "X-Layer": "hook" },
      }),
    });
    adapter.ws("/layered/custom", reportData, {
      onUpgrade: () => ({
        custom: { from: "hook" },
      }),
    });

    // A bare upgrade from an ordinary route layers the same way. With data
    // passed outright, that data is used as is; its headers still inherit.
    adapter.get("/layered/built", (_req, res) => res.upgradeToWebsocket());
    adapter.get("/layered/explicit", (req, res) => {
      return res.upgradeToWebsocket(
        {
          host: req.host,
          path: req.path,
          search: req.search,
          hash: req.hash,
          originalUrl: req.originalUrl,
          headers: req.headersObj,
          custom: { from: "explicit" },
        },
        { headers: { "X-Layer": "explicit" } },
      );
    });
    // `inherit: false`: only this call's own arguments.
    adapter.get("/layered/alone", (_req, res) => {
      return res.upgradeToWebsocket(undefined, { inherit: false });
    });
    adapter.webSocketAdapter.on("open", (ws) => {
      if (!ws.data.route) {
        ws.sendText(
          JSON.stringify({ custom: ws.data.custom, hash: ws.data.hash }),
        );
      }
    });
  });

  const hookHead = await upgradeHead(`${served.origin}/layered`);
  checkEqual(
    "headers merge by name: router, then res, then the hook",
    {
      layer: hookHead.values("x-layer"),
      trace: hookHead.values("x-trace"),
      res: hookHead.values("x-res"),
    },
    { layer: ["hook"], trace: ["t-1"], res: ["1"] },
  );
  const layered = await reportFor(`${served.origin}/layered`);
  checkEqual(
    "data merges shallowly: res's custom over the router's, the router's hash kept",
    { custom: layered.custom, hash: layered.hash },
    { custom: { from: "res" }, hash: "#router" },
  );
  checkEqual(
    "a hook's custom beats both layers",
    (await reportFor(`${served.origin}/layered/custom`)).custom,
    { from: "hook" },
  );

  const built = await reportFor<BareReport>(`${served.origin}/layered/built`);
  checkEqual(
    "a bare upgradeToWebsocket() builds its data under the same layers",
    built,
    { custom: { from: "res" }, hash: "#router" },
  );
  const explicit = await reportFor<BareReport>(
    `${served.origin}/layered/explicit`,
  );
  checkEqual(
    "explicit data is used as is: no router or res data merged in",
    explicit,
    { custom: { from: "explicit" }, hash: "" },
  );
  const explicitHead = await upgradeHead(`${served.origin}/layered/explicit`);
  checkEqual(
    "…while its headers inherit, and the explicit one wins per name",
    [explicitHead.values("x-layer"), explicitHead.values("x-trace")],
    [["explicit"], ["t-1"]],
  );
  const aloneHead = await upgradeHead(`${served.origin}/layered/alone`);
  checkEqual(
    "inherit: false sends exactly Bun's default 101",
    aloneHead.headers.map(([name]) => name),
    ["upgrade", "connection", "sec-websocket-accept", "date"],
  );

  served.adapter.webSocketUpgradeHeaders = undefined;
  checkEqual(
    "router defaults are read at upgrade time: cleared, they are gone",
    (await upgradeHead(`${served.origin}/layered`)).values("x-trace"),
    [],
  );

  // A ws() route takes the defaults of the router ws() was called on, even
  // a sub-router mounted elsewhere.
  const sub = new BunRouter({ bunWebsocket: served.adapter.webSocketAdapter });
  sub.setWebSocketUpgradeHeaders({ "X-Router": "sub" });
  sub.ws("/sub-feed", reportData);
  served.adapter.setWebSocketUpgradeHeaders({ "X-Router": "adapter" });
  served.adapter.use("/api", sub);
  checkEqual(
    "a sub-router's ws() route gets the sub-router's defaults",
    (await upgradeHead(`${served.origin}/sub-feed`)).values("x-router"),
    ["sub"],
  );
}

/* ------------------------------------------------------------------ */
step("customDataToWsClientFn — deprecated, still works");

{
  const served = await serve(
    {
      // The old name: whatever it returns becomes ws.data.custom.
      customDataToWsClientFn: () => ({ legacy: true }),
    },
    (adapter) => {
      adapter.ws("/legacy", reportData);
      // A function as a route's third argument is the old mapping, always:
      // whatever it returns is custom, even an object with `data`/`custom`
      // keys. The hook goes in `{ onUpgrade }` instead.
      adapter.ws("/legacy/route", reportData, () => ({ room: "lobby" }));
      adapter.ws("/legacy/shaped", reportData, () => ({
        data: "x",
        custom: 1,
      }));
    },
  );
  checkEqual(
    "the deprecated option still sets custom",
    (await reportFor(`${served.origin}/legacy`)).custom,
    { legacy: true },
  );
  checkEqual(
    "…and so does the old shape of a route's third argument",
    (await reportFor(`${served.origin}/legacy/route`)).custom,
    { room: "lobby" },
  );
  checkEqual(
    "…whose result is custom whatever its shape: { data, custom } is not a hook result",
    (await reportFor(`${served.origin}/legacy/shaped`)).custom,
    { data: "x", custom: 1 },
  );
}

/* ------------------------------------------------------------------ */
step("Events — every one, listeners before route handlers");

{
  const order: string[] = [];
  const served = await serve({}, (adapter) => {
    adapter.webSocketAdapter.on("open", () => {
      order.push("event:open");
    });
    adapter.ws("/events", {
      open() {
        order.push("route:open");
      },
      message(ws, message) {
        if (message === "ping me") {
          ws.ping("server-ping");
        }
      },
      ping(_ws, data) {
        order.push(`route:ping:${data.toString()}`);
      },
      pong(_ws, data) {
        order.push(`route:pong:${data.toString()}`);
      },
      close(_ws, code, reason) {
        order.push(`route:close:${code}:${reason}`);
      },
    });
  });

  const client = await openClient(`${served.origin}/events`);
  await waitFor("the route's open", () => order.includes("route:open"));
  checkEqual(
    "open is emitted as connect, then open",
    served.events.slice(0, 2),
    ["connect", "open"],
  );
  check(
    "instance listeners run before the route's handler",
    order.indexOf("event:open") < order.indexOf("route:open"),
    order,
  );

  client.socket.ping("client-ping");
  const pinged = await eventually("the ping", () => {
    return order.includes("route:ping:client-ping");
  });
  check(
    "a client ping reaches ping, with its data",
    pinged && served.events.includes("ping"),
    order,
  );

  client.socket.send("ping me");
  const ponged = await eventually("the pong", () => {
    return order.includes("route:pong:server-ping");
  });
  check(
    "the client's pong to a server ping reaches pong, with the ping's data",
    ponged && served.events.includes("pong"),
    order,
  );
  check("message is emitted", served.events.includes("message"));

  client.socket.close(4321, "tour over");
  await eventually("the close", () => served.events.includes("close"));
  checkEqual(
    "close carries the client's code and reason",
    order.find((entry) => entry.startsWith("route:close")),
    "route:close:4321:tour over",
  );
  const disconnectAt = served.events.indexOf("disconnect");
  check(
    "a close is emitted as disconnect, then close",
    disconnectAt !== -1 && disconnectAt < served.events.indexOf("close"),
    served.events,
  );
}

/* ------------------------------------------------------------------ */
step("setRouteHandler — handlers accumulate per path");

{
  const calls: string[] = [];
  const served = await serve();
  const bunWebSocket = served.adapter.webSocketAdapter;

  const first: BunWebSocketHandlerType = {
    message() {
      calls.push("first");
    },
  };
  const second: BunWebSocketHandlerType = {
    message(ws) {
      calls.push("second");
      ws.sendText("ok");
    },
  };

  checkEqual(
    "a handler object is registered",
    await bunWebSocket.setRouteHandler("/multi", first, undefined),
    true,
  );
  await bunWebSocket.setRouteHandler("/multi", first, undefined);
  served.adapter.ws("/multi", second);
  checkEqual(
    "anything but an object is refused",
    await bunWebSocket.setRouteHandler(
      "/refused",
      // Deliberately wrong at runtime, as an untyped JavaScript caller might pass.
      null as unknown as BunWebSocketHandlerType,
      undefined,
    ),
    false,
  );

  const client = await openClient(`${served.origin}/multi`);
  client.socket.send("hi");
  await client.waitForText("the reply", (text) => text === "ok");
  checkEqual("each handler runs once per event, in registration order", calls, [
    "first",
    "second",
  ]);
}

/* ------------------------------------------------------------------ */
step("maxPayloadLength, perMessageDeflate, publishToSelf");

const tight = await serve(
  {
    wsOptions: {
      maxPayloadLength: 1024,
      perMessageDeflate: false,
      publishToSelf: true,
    },
  },
  (adapter) => {
    adapter.ws("/room", roomHandler);
  },
);
const loose = await serve({}, (adapter) => {
  adapter.ws("/room", roomHandler);
});

{
  const client = await openSubscribed(`${tight.origin}/room`);
  client.socket.send("x".repeat(1000));
  const delivered = await eventually("the size reply", () => {
    return client.texts().includes("got 1000");
  });
  check("maxPayloadLength: a message within it is delivered", delivered);
  client.socket.send("x".repeat(4096));
  const closed = await client.waitClosed().catch(() => undefined);
  // Bun drops the connection without a close frame, so the client sees 1006
  // rather than 1009 ("message too big").
  check(
    "maxPayloadLength: a larger message drops the connection (1006)",
    closed?.code === 1006,
    closed,
  );
}

{
  const offering = await openSubscribed(`${loose.origin}/room`);
  check(
    "perMessageDeflate true: negotiated with a client that offers it",
    offering.socket.extensions.includes("permessage-deflate"),
    offering.socket.extensions,
  );
  const notOffering = await openSubscribed(`${loose.origin}/room`, {
    perMessageDeflate: false,
  });
  checkEqual(
    "perMessageDeflate true: not negotiated with a client that does not offer it",
    notOffering.socket.extensions,
    "",
  );
  const disabled = await openSubscribed(`${tight.origin}/room`);
  checkEqual(
    "perMessageDeflate false: never negotiated",
    disabled.socket.extensions,
    "",
  );
}

{
  const sender = await openSubscribed(`${tight.origin}/room`);
  const listener = await openSubscribed(`${tight.origin}/room`);
  sender.socket.send("pub:to everyone");
  await listener.waitForText("the publish", (text) => text === "to everyone");
  await sender.waitForText(
    "the acknowledgement",
    (text) => text === "published",
  );
  check(
    "publishToSelf true: ws.publish reaches the sender too",
    sender.texts().includes("to everyone"),
    sender.texts(),
  );

  const quietSender = await openSubscribed(`${loose.origin}/room`);
  const quietListener = await openSubscribed(`${loose.origin}/room`);
  quietSender.socket.send("pub:not to me");
  await quietListener.waitForText("the publish", (text) => {
    return text === "not to me";
  });
  await quietSender.waitForText("the acknowledgement", (text) => {
    return text === "published";
  });
  // The acknowledgement is sent after the publish on the same connection, so
  // had the publish been delivered to the sender it would have arrived first.
  check(
    "publishToSelf defaults to false: the sender is skipped",
    !quietSender.texts().includes("not to me"),
    quietSender.texts(),
  );
}

/* ------------------------------------------------------------------ */
step("idleTimeout and sendPings — waiting out the idle timer");

{
  const pinging = await serve(
    { wsOptions: { idleTimeout: 4, sendPings: true } },
    (adapter) => {
      adapter.ws("/idle", roomHandler);
    },
  );
  const dropping = await serve(
    { wsOptions: { idleTimeout: 4, sendPings: false } },
    (adapter) => {
      adapter.ws("/idle", roomHandler);
    },
  );

  const kept = await openSubscribed(`${pinging.origin}/idle`);
  const dropped = await openSubscribed(`${dropping.origin}/idle`);
  const [pinged, closed] = await Promise.all([
    eventually(
      "an idle ping to be answered",
      () => pinging.events.includes("pong"),
      30_000,
    ),
    eventually(
      "the idle client to be closed",
      () => dropped.closed !== undefined,
      30_000,
    ),
  ]);

  check(
    "sendPings true: an idle client is pinged, answers, and stays open",
    pinged && kept.closed === undefined,
    { events: pinging.events, closed: kept.closed },
  );
  check(
    "sendPings false: an idle client is closed after idleTimeout",
    closed,
    dropped.closed,
  );
}

/* ------------------------------------------------------------------ */
step("backpressureLimit, closeOnBackpressureLimit and drain");

/** One chunk, uncompressed: large enough to fill socket buffers quickly. */
const CHUNK = new Uint8Array(64 * 1024);

/** Sends `CHUNK` until `stop` says so (or 4000 sends); answers every status. */
function flood(
  ws: WebSocketClient,
  stop: (status: number) => boolean,
): number[] {
  const statuses: number[] = [];
  while (statuses.length < 4000) {
    const status = ws.sendBinary(CHUNK, false);
    statuses.push(status);
    if (stop(status)) {
      break;
    }
  }
  return statuses;
}

/** The last server side seen by the backpressure section, for the emitter checks. */
let sampleSocket: WebSocketClient | undefined;

{
  const limited = await serve(
    { wsOptions: { backpressureLimit: 256 * 1024, perMessageDeflate: false } },
    (adapter) => {
      adapter.ws("/bp", roomHandler);
    },
  );
  const slow = await openSubscribed(`${limited.origin}/bp`, {
    headers: { "x-id": "slow" },
  });
  const slowSide = await limited.socket("slow");
  sampleSocket = slowSide;

  slow.socket.pause();
  const before = slow.messages.length;
  const statuses = flood(slowSide, (status) => status === 0);

  check(
    "a send that cannot be written at once is queued: status -1",
    statuses.includes(-1),
    statuses.slice(-5),
  );
  checkEqual(
    "past backpressureLimit a send is dropped: status 0",
    statuses.at(-1),
    0,
  );
  check(
    "closeOnBackpressureLimit defaults to false: the connection stays open",
    slowSide.readyState === 1,
    slowSide.readyState,
  );

  slow.socket.resume();
  check(
    "drain is emitted once the queue can take more",
    await eventually("drain", () => limited.events.includes("drain")),
    limited.events,
  );
  const delivered = statuses.filter((status) => status !== 0).length;
  check(
    "every chunk that was not dropped arrives",
    await eventually("the queued chunks", () => {
      return slow.messages.length - before === delivered;
    }),
    { received: slow.messages.length - before, delivered },
  );
}

{
  const strict = await serve(
    {
      wsOptions: {
        backpressureLimit: 256 * 1024,
        closeOnBackpressureLimit: true,
        perMessageDeflate: false,
      },
    },
    (adapter) => {
      adapter.ws("/bp", roomHandler);
    },
  );
  const stuck = await openSubscribed(`${strict.origin}/bp`, {
    headers: { "x-id": "stuck" },
  });
  const stuckSide = await strict.socket("stuck");

  stuck.socket.pause();
  flood(stuckSide, (status) => status === 0 || stuckSide.readyState !== 1);
  const closedAtLimit = await eventually("the server-side close", () => {
    return strict.events.includes("close");
  });
  check(
    "closeOnBackpressureLimit true: the connection is closed at the limit",
    closedAtLimit,
    strict.events,
  );
  stuck.socket.resume();
}

/* ------------------------------------------------------------------ */
step("BunWebSocketCreateServerOptions — a standalone server");

await checkRejects(
  "listen.port outside 0-65535 is refused",
  () => {
    return new BunWebSocket({
      newInstance: true,
      router: new BunRouter(),
      listen: { port: 70000 },
    });
  },
  { message: /listen\.port/ },
);

{
  const router = new BunRouter();
  const anyPort = new BunWebSocket({
    newInstance: true,
    router,
    listen: { port: 0 },
  });
  closers.push(async () => {
    anyPort.killServer(anyPort.getServer());
  });
  check(
    "listen.port 0 binds an OS-assigned port, reported by .port",
    Number(anyPort.port) > 0 && anyPort.port === anyPort.getServer()?.port,
    anyPort.port,
  );

  router.ws("/rooms/:id", {
    open(ws) {
      ws.sendText(`room ${ws.data.params?.id} via ${ws.data.route}`);
    },
    message() {},
  });
  const inRoom = await connect(`ws://127.0.0.1:${anyPort.port}/rooms/42`);
  checkEqual(
    "ws() handlers run on a param route, with ws.data.route and params",
    await inRoom.waitForText("the room greeting", (text) => {
      return text.startsWith("room");
    }),
    "room 42 via /rooms/:id",
  );
  inRoom.socket.close();
  await inRoom.waitClosed();
}

{
  const router = new BunRouter();
  // The timer starts once the pipeline returns, so this handler returns first
  // and responds later. (A reply slower than `responseTimeout` fails with 500;
  // not shown, because the server's `error()` rethrows it as uncaught.)
  router.get("/slow", (_req, res) => {
    setTimeout(() => res.send("late"), 1300);
  });
  const timed = new BunWebSocket({
    newInstance: true,
    router,
    listen: { port: 0 },
    responseTimeout: 3000,
    // WebSocket-only: an idle timeout this short does not touch HTTP.
    wsOptions: { idleTimeout: 1 },
  });
  closers.push(async () => {
    timed.killServer(timed.getServer());
  });
  checkEqual(
    "responseTimeout, not wsOptions.idleTimeout, bounds an HTTP reply",
    await (await fetch(`http://127.0.0.1:${timed.port}/slow`)).text(),
    "late",
  );
}

{
  /** What the standalone server's connections carry. */
  interface Feed {
    /** A fixed marker, to see the function ran. */
    channel: string;
  }

  const router = new BunRouter();
  const port = await getPort();
  const standalone = new BunWebSocket<Feed>({
    newInstance: true,
    router,
    listen: { host: "127.0.0.1", port },
    serverOptions: { maxRequestBodySize: 1024 },
    bunRequestOpts: { parseBody: false, parseQuery: false, parseCookies: true },
    wsOptions: { perMessageDeflate: false },
    onUpgrade: () => {
      return { custom: { channel: "standalone" } };
    },
  });
  const server = standalone.getServer();
  closers.push(async () => {
    standalone.killServer(server);
  });

  check(
    "listen: binds its own server on listen.host and listen.port",
    server?.port === port && server.hostname === "127.0.0.1",
    { port: server?.port, hostname: server?.hostname },
  );
  check(
    "router: the router given knows this BunWebSocket",
    router.getBunWebsocket() === standalone,
  );

  router.get("/inspect", (req, res) => {
    res.json({ query: req.query, cookies: req.cookies });
  });
  router.post("/inspect", (_req, res) => {
    res.send("accepted");
  });
  router.ws("/feed", reportData);

  const http = `http://127.0.0.1:${port}`;
  const inspected = (await (
    await fetch(`${http}/inspect?a=1`, { headers: { cookie: "sid=abc" } })
  ).json()) as Inspected;
  checkEqual(
    "bunRequestOpts: parseQuery false leaves req.query empty",
    inspected.query,
    {},
  );
  checkEqual(
    "bunRequestOpts: parseCookies true parses the Cookie header",
    inspected.cookies,
    { sid: "abc" },
  );
  checkEqual(
    "serverOptions reach Bun.serve: a body over maxRequestBodySize is 413",
    (await fetch(`${http}/inspect`, { method: "POST", body: "x".repeat(4096) }))
      .status,
    413,
  );
  checkEqual(
    "an unmatched path is a 404",
    (await fetch(`${http}/nowhere`)).status,
    404,
  );
  checkEqual(
    "onUpgrade applies to its upgrades",
    (await reportFor(`ws://127.0.0.1:${port}/feed`)).custom,
    { channel: "standalone" },
  );
}

{
  const router = new BunRouter();
  const port = await getPort();
  const prebuiltRequest = await BunRequest.init(
    new Request("http://fixture.local/fixed?from=prebuilt"),
    FETCH_STUB_SERVER,
    { parseBody: false },
  );
  const prebuiltResponse = new BunResponse(prebuiltRequest);
  let handedResponse: BunResponse | undefined;

  router.get("/fixed", (req, res) => {
    handedResponse = res;
    res.send(`routed ${req.originalUrl}`);
  });

  const fixture = new BunWebSocket({
    newInstance: true,
    router,
    listen: { port }, // `host` is optional
    request: prebuiltRequest,
    response: prebuiltResponse,
  });
  const server = fixture.getServer();
  closers.push(async () => {
    fixture.killServer(server);
  });

  checkEqual(
    "request: the pre-built BunRequest is routed, whatever was fetched",
    await (await fetch(`http://127.0.0.1:${port}/anything`)).text(),
    "routed /fixed?from=prebuilt",
  );
  check(
    "response: the pre-built BunResponse is what handlers get",
    handedResponse === prebuiltResponse,
  );
}

/* ------------------------------------------------------------------ */
step("getOrCreateWebsocketServer and killServer");

{
  const shared = riding.webSocketAdapter;
  riding.ws("/extra", roomHandler);

  check(
    "port 0 answers the shared server",
    shared.getOrCreateWebsocketServer(0) === riding.server,
  );
  check(
    "the shared server's own port answers the shared server",
    shared.getOrCreateWebsocketServer(Number(riding.server?.port)) ===
      riding.server,
  );

  const extraPort = await getPort();
  const extra = shared.getOrCreateWebsocketServer(extraPort);
  check(
    "any other port binds a dedicated server",
    extra !== undefined && extra !== riding.server && extra.port === extraPort,
  );
  check(
    "asking for that port again reuses it",
    shared.getOrCreateWebsocketServer(extraPort) === extra,
  );

  const viaExtra = await openSubscribed(`ws://127.0.0.1:${extraPort}/extra`);
  check("the dedicated server routes upgrades through the same router", true);
  viaExtra.socket.close();
  await viaExtra.waitClosed();

  shared.killServer(extra);
  check(
    "killServer force-stops the dedicated server",
    await fetch(`http://127.0.0.1:${extraPort}/extra`).then(
      () => false,
      () => true,
    ),
  );
}

/* ------------------------------------------------------------------ */
step("Attaching a BunWebSocket after listen() — dispatch follows the swap");

{
  const late = new BunHttpAdapter(0);
  const replacedRoute: string[] = [];
  // Registered on the adapter's built-in instance, before anything replaces it.
  late.ws("/late", {
    open: (ws) => {
      replacedRoute.push(ws.data.path);
    },
    message: () => {},
  });
  const builtIn = late.webSocketAdapter;

  await late.listen(0);
  closers.push(async () => {
    await late.close();
  });

  // Constructing a BunWebSocket with `router:` calls setBunWebSocket() on that
  // router — which is how bun-nest's useWebSocketAdapter() takes over, and it
  // may happen after the server is already listening.
  const swapped = new BunWebSocket({
    newInstance: false,
    router: late,
    getServer: () => late.getBunServer(),
  });
  check(
    "constructing one with `router:` registers it, leaving webSocketAdapter alone",
    late.getBunWebsocket() === swapped && late.webSocketAdapter === builtIn,
  );

  await swapped.setRouteHandler(
    "/late",
    {
      open: (ws) => {
        ws.send(`open ${ws.data.route}`);
      },
      message: (ws, message) => {
        ws.send(`echo ${String(message)}`);
      },
    },
    undefined,
  );

  const lateClient = await connect(`ws://127.0.0.1:${late.server?.port}/late`);
  checkEqual(
    "the instance attached after listen() is the one that dispatches",
    await lateClient.waitForText("open", (text) => text.startsWith("open")),
    "open /late",
  );

  lateClient.socket.send("hi");
  checkEqual(
    "its message handler runs too",
    await lateClient.waitForText("the echo", (text) => text.startsWith("echo")),
    "echo hi",
  );

  // Last one wins: Bun.serve reads its `websocket` object once, so dispatch is
  // resolved per event instead of frozen at listen().
  check(
    "the instance it replaced no longer dispatches",
    replacedRoute.length === 0,
  );

  lateClient.socket.close();
  await lateClient.waitClosed();
}

/* ------------------------------------------------------------------ */
step("The TypedEmitter surface");

{
  const emitter = new BunWebSocket({
    newInstance: false,
    router: new BunRouter(),
    getServer: () => undefined,
  });
  const socket = sampleSocket;
  if (!socket) {
    throw new Error("the backpressure section left no socket to emit with");
  }

  checkEqual(
    "emit answers false before anyone listens",
    emitter.emit("drain", socket),
    false,
  );
  checkEqual("eventNames is empty", emitter.eventNames(), []);
  checkEqual("listenerCount is 0", emitter.listenerCount("drain"), 0);
  checkEqual("listeners is empty", emitter.listeners("drain"), []);
  checkEqual(
    "getMaxListeners is EventEmitter's default before any listener",
    emitter.getMaxListeners(),
    10,
  );

  const seen: string[] = [];
  const onListener = () => {
    seen.push("on");
  };
  const addedListener = () => {
    seen.push("addListener");
  };

  check("on returns the instance", emitter.on("drain", onListener) === emitter);
  checkEqual(
    "the emitter, once created, has no listener limit",
    emitter.getMaxListeners(),
    0,
  );
  emitter.addListener("drain", addedListener);
  emitter.once("drain", () => {
    seen.push("once");
  });
  emitter.prependListener("drain", () => {
    seen.push("prependListener");
  });
  emitter.prependOnceListener("drain", () => {
    seen.push("prependOnceListener");
  });
  checkEqual(
    "listenerCount counts every listener",
    emitter.listenerCount("drain"),
    5,
  );
  checkEqual("listeners lists them", emitter.listeners("drain").length, 5);

  checkEqual(
    "emit answers true when someone listens",
    emitter.emit("drain", socket),
    true,
  );
  checkEqual("prepended listeners run first", seen.splice(0), [
    "prependOnceListener",
    "prependListener",
    "on",
    "addListener",
    "once",
  ]);
  emitter.emit("drain", socket);
  checkEqual("once listeners run a single time", seen.splice(0), [
    "prependListener",
    "on",
    "addListener",
  ]);

  emitter.off("drain", onListener);
  checkEqual("off removes that listener", emitter.listenerCount("drain"), 2);
  emitter.removeListener("drain", addedListener);
  checkEqual(
    "removeListener removes that listener",
    emitter.listenerCount("drain"),
    1,
  );

  emitter.on("ping", () => {});
  emitter.removeAllListeners("drain");
  checkEqual(
    "removeAllListeners(event) removes only that event",
    emitter.eventNames(),
    ["ping"],
  );
  emitter.removeAllListeners();
  checkEqual(
    "removeAllListeners() removes every event",
    emitter.eventNames(),
    [],
  );

  check(
    "setMaxListeners returns the instance",
    emitter.setMaxListeners(3) === emitter,
  );
  checkEqual("setMaxListeners sets the limit", emitter.getMaxListeners(), 3);
}

/* ------------------------------------------------------------------ */
step("Cleanup");

for (const client of clients) {
  if (client.closed === undefined) {
    client.socket.close();
  }
}
await Promise.all(
  clients.map(async (client) => {
    await client.waitClosed({ timeout: 5000 }).catch(() => undefined);
  }),
);
for (const close of closers.reverse()) {
  await close();
}

summary();
