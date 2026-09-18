/**
 * `onUpgrade` and the router- / response-level upgrade values.
 *
 * What a WebSocket upgrade carries is layered: the router's
 * `webSocketUpgradeHeaders`/`webSocketUpgradeData`, then the response's (set by
 * middleware), then the route's `onUpgrade` result — or, for a bare
 * `res.upgradeToWebsocket()`, that call's own arguments. Every server that can
 * perform an upgrade runs the same suite: the adapter's, a standalone
 * `BunWebSocket` server's, and one attached after `listen()`. The 101 is read
 * off a raw TCP socket, since a `WebSocket` client exposes only the negotiated
 * protocol.
 */
import type {
  WebSocketClientData,
  WebSocketCustomDataFn,
  WebSocketUpgradeHook,
} from "../lib/BunWebSocket";
import type { RawResponseHead } from "./helpers";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { BunWebSocket } from "../lib/BunWebSocket";
import { createTestLogger } from "../lib/logging";
import { makeResponse, negotiatedProtocol, rawUpgrade } from "./helpers";

/** The subprotocol a server picks from the client's offer. */
const PROTOCOL = "bun-jobs.v1";
/** An offer that puts another protocol first, which Bun echoes by default. */
const OFFER = ["other", PROTOCOL];

/** The header names a plain Bun upgrade writes, in wire order. */
const BUN_DEFAULT_101 = [
  "upgrade",
  "connection",
  "sec-websocket-accept",
  "sec-websocket-protocol",
  "date",
];

/** The values of every `name` header in `head`, in wire order. */
function values(head: RawResponseHead, name: string): string[] {
  return head.headers.filter(([key]) => key === name).map(([, v]) => v);
}

/**
 * `head` as text, with the one value that varies between two responses (the
 * `Date`) masked, so two heads compare byte for byte otherwise.
 */
function wire(head: RawResponseHead): string {
  return [
    head.statusLine,
    ...head.headers.map(
      ([name, value]) => `${name}: ${name === "date" ? "<date>" : value}`,
    ),
  ].join("\r\n");
}

/**
 * The 101 a bare `Bun.serve` answers with for `server.upgrade(req)` — what
 * every upgrade here sent before the upgrade layers existed — read off the
 * wire the same way. `rawUpgrade` sends a fixed `Sec-WebSocket-Key`, so only
 * the `Date` can differ.
 */
async function bunBaseline(protocols: string[]): Promise<string> {
  const server = Bun.serve<Record<string, never>>({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req, { data: {} })
        ? undefined
        : new Response("no", { status: 400 });
    },
    websocket: { message() {} },
  });
  try {
    return wire(await rawUpgrade(Number(server.port), "/", protocols));
  } finally {
    await server.stop(true);
  }
}

/** Instance-wide options a suite's server may be started with. */
interface InstanceOptions {
  /** The instance-wide `onUpgrade`. */
  onUpgrade?: WebSocketUpgradeHook;
  /** The deprecated instance-wide mapping. */
  customDataToWsClientFn?: WebSocketCustomDataFn;
}

/** A running server, as one suite's `start` returns it. */
interface Served {
  /** The port it listens on. */
  port: number;
  /** The router requests run through, and `ws()` routes are registered on. */
  router: BunRouter;
  /** The `BunWebSocket` upgrades go through. */
  socket: BunWebSocket;
  /** Every record the router's logger received. */
  logs: { level: string; message: string }[];
  /** `ws.data` of every connection opened, in order. */
  opened: WebSocketClientData[];
  /** A handler that records each connection's `ws.data` in {@link opened}. */
  record: {
    open: (ws: { data: WebSocketClientData }) => void;
    message: () => void;
  };
  /** Stops the server. */
  stop: () => Promise<void> | void;
}

/** Polls `predicate` until true, or fails after `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await Bun.sleep(5);
  }
}

/**
 * Opens a client on `path`, waits for the server to record the connection,
 * closes it, and returns the recorded `ws.data`.
 */
async function connect(
  served: Served,
  path: string,
  protocols: string[] = [],
): Promise<WebSocketClientData> {
  const before = served.opened.length;
  const client = new WebSocket(
    `ws://127.0.0.1:${served.port}${path}`,
    protocols,
  );
  await new Promise<void>((resolve, reject) => {
    client.addEventListener("open", () => resolve(), { once: true });
    const refuse = () => reject(new Error(`no upgrade at ${path}`));
    client.addEventListener("error", refuse, { once: true });
    client.addEventListener("close", refuse, { once: true });
  });
  try {
    await until(() => served.opened.length > before);
    return served.opened[served.opened.length - 1] as WebSocketClientData;
  } finally {
    client.close();
  }
}

/** Builds the pieces every {@link Served} shares. */
function recorder() {
  const opened: WebSocketClientData[] = [];
  return {
    opened,
    record: {
      open: (ws: { data: WebSocketClientData }) => {
        opened.push(ws.data);
      },
      message: () => {},
    },
  };
}

type Start = (options?: InstanceOptions) => Promise<Served>;

const startAdapter: Start = async (options = {}) => {
  const { logger, events } = createTestLogger();
  const adapter = new BunHttpAdapter(0, { logger, websocket: options });
  const server = await adapter.listen(0);
  return {
    ...recorder(),
    port: Number(server.port),
    router: adapter,
    socket: adapter.webSocketAdapter,
    logs: events,
    stop: () => adapter.close(),
  };
};

const startStandalone: Start = async (options = {}) => {
  const { logger, events } = createTestLogger();
  const router = new BunRouter({ logger });
  const socket = new BunWebSocket({
    newInstance: true,
    router,
    listen: { port: 0 },
    ...options,
  });
  return {
    ...recorder(),
    port: Number(socket.port),
    router,
    socket,
    logs: events,
    stop: () => {
      socket.killServer(socket.getServer());
    },
  };
};

const startAttachedAfterListen: Start = async (options = {}) => {
  const { logger, events } = createTestLogger();
  const adapter = new BunHttpAdapter(0, { logger });
  const server = await adapter.listen(0);
  // Swapped in after the server is up, the way NestJS's
  // `useWebSocketAdapter()` takes over.
  const socket = new BunWebSocket({
    newInstance: false,
    router: adapter,
    getServer: () => adapter.getBunServer(),
    ...options,
  });
  if (adapter.getBunWebsocket() !== socket) {
    throw new Error("the BunWebSocket was not swapped in");
  }
  return {
    ...recorder(),
    port: Number(server.port),
    router: adapter,
    socket,
    logs: events,
    stop: () => adapter.close(),
  };
};

/** Starts a server, runs `body` against it, and always stops it. */
async function using(
  start: Start,
  options: InstanceOptions | undefined,
  body: (served: Served) => Promise<void>,
) {
  const served = await start(options);
  try {
    await body(served);
  } finally {
    await served.stop();
  }
}

/** A replacement `ws.data`, minus what the match fills in. */
function replacement(custom: unknown): WebSocketClientData {
  return {
    host: "replaced.test",
    path: "/replaced",
    search: "",
    hash: "",
    originalUrl: "/replaced",
    headers: new Headers({ "x-replaced": "1" }),
    custom,
  };
}

function describeOnUpgrade(name: string, start: Start) {
  describe(`onUpgrade: ${name}`, () => {
    it("a route hook's headers reach the 101 and choose the subprotocol", async () => {
      await using(start, undefined, async (served) => {
        served.router.ws("/proto", served.record, {
          onUpgrade: () => ({
            headers: { "Sec-WebSocket-Protocol": PROTOCOL, "X-Hook": "1" },
          }),
        });
        expect(
          await negotiatedProtocol(
            `ws://127.0.0.1:${served.port}/proto`,
            OFFER,
          ),
        ).toBe(PROTOCOL);
        const head = await rawUpgrade(served.port, "/proto", OFFER);
        expect(head.statusLine).toBe("HTTP/1.1 101 Switching Protocols");
        expect(values(head, "sec-websocket-protocol")).toEqual([PROTOCOL]);
        expect(values(head, "x-hook")).toEqual(["1"]);
      });
    });

    it("a route hook's custom becomes ws.data.custom, and the hook sees req and res", async () => {
      await using(start, undefined, async (served) => {
        let sawRes = false;
        served.router.ws("/custom", served.record, {
          onUpgrade: async (req, res) => {
            sawRes = typeof res.upgradeToWebsocket === "function";
            return { custom: { userId: req.query.user } };
          },
        });
        const data = await connect(served, "/custom?user=u1");
        expect(data.custom).toEqual({ userId: "u1" });
        expect(sawRes).toBe(true);
        expect(data.route).toBe("/custom");
        expect(data.port).toBe(served.port);
      });
    });

    it("a route hook's data replaces ws.data, with route/params/port filled in", async () => {
      await using(start, undefined, async (served) => {
        served.router.ws("/rooms/:id", served.record, {
          onUpgrade: () => ({
            data: replacement({ from: "data" }),
          }),
        });
        const data = await connect(served, "/rooms/42");
        expect(data.host).toBe("replaced.test");
        expect(data.path).toBe("/replaced");
        expect(data.headers.get("x-replaced")).toBe("1");
        expect(data.custom).toEqual({ from: "data" });
        // Nothing of the built data survives.
        expect("user" in data).toBe(false);
        // Dispatch still works (the handler above recorded it), because the
        // match filled in what the data left out.
        expect(data.route).toBe("/rooms/:id");
        expect(data.params).toEqual({ id: "42" });
        expect(data.port).toBe(served.port);
      });
    });

    it("keeps route/params/port a hook's data gives, and custom beats data.custom", async () => {
      await using(start, undefined, async (served) => {
        served.router.ws("/kept/:id", served.record, {
          onUpgrade: () => ({
            data: { ...replacement("data"), params: { id: "mine" }, port: 1 },
            custom: "custom",
          }),
        });
        const data = await connect(served, "/kept/7");
        expect(data.params).toEqual({ id: "mine" });
        expect(data.port).toBe(1);
        expect(data.route).toBe("/kept/:id");
        expect(data.custom).toBe("custom");
      });
    });

    it("the instance-wide hook applies to routes without one, and a route's hook replaces it", async () => {
      const instance: WebSocketUpgradeHook = () => ({
        custom: "instance",
        headers: { "X-Instance": "1" },
      });
      await using(start, { onUpgrade: instance }, async (served) => {
        served.router.ws("/instance", served.record);
        served.router.ws("/own", served.record, {
          onUpgrade: () => ({
            custom: "route",
            headers: { "X-Route": "1" },
          }),
        });

        expect((await connect(served, "/instance")).custom).toBe("instance");
        const instanceHead = await rawUpgrade(served.port, "/instance");
        expect(values(instanceHead, "x-instance")).toEqual(["1"]);

        expect((await connect(served, "/own")).custom).toBe("route");
        const ownHead = await rawUpgrade(served.port, "/own");
        expect(values(ownHead, "x-route")).toEqual(["1"]);
        expect(values(ownHead, "x-instance")).toEqual([]);
      });
    });

    it("the deprecated customDataToWsClientFn still sets custom, instance-wide and per route", async () => {
      await using(
        start,
        { customDataToWsClientFn: () => ({ legacy: "instance" }) },
        async (served) => {
          served.router.ws("/legacy", served.record);
          // Positional, in the old shape: its result is taken as `custom`.
          served.router.ws("/legacy-route", served.record, async () => ({
            legacy: "route",
          }));
          expect((await connect(served, "/legacy")).custom).toEqual({
            legacy: "instance",
          });
          expect((await connect(served, "/legacy-route")).custom).toEqual({
            legacy: "route",
          });
          expect(served.logs.filter((log) => log.level === "warn")).toEqual([]);
        },
      );
    });

    it("a function as the third argument is always the deprecated mapping, whatever its result's shape", async () => {
      await using(start, undefined, async (served) => {
        // Shaped like a hook result, but a function here is never a hook: the
        // whole object is `custom`, and none of it reaches the 101 or ws.data.
        served.router.ws("/shaped", served.record, () => ({
          data: "x",
          custom: 1,
        }));
        await served.socket.setRouteHandler(
          "/shaped-direct",
          served.record,
          () => ({
            headers: { "X-Not-A-Header": "1" },
            custom: 2,
          }),
        );

        const data = await connect(served, "/shaped?q=1");
        expect(data.custom).toEqual({ data: "x", custom: 1 });
        expect(data.search).toBe("?q=1");
        expect(data.route).toBe("/shaped");

        const direct = await connect(served, "/shaped-direct");
        expect(direct.custom).toEqual({
          headers: { "X-Not-A-Header": "1" },
          custom: 2,
        });
        const head = await rawUpgrade(served.port, "/shaped-direct");
        expect(values(head, "x-not-a-header")).toEqual([]);
      });
    });

    it("the options form carries headers, custom and data together", async () => {
      await using(start, undefined, async (served) => {
        served.router.ws("/options/:id", served.record, {
          onUpgrade: (req) => ({
            headers: { "X-Options": "1" },
            custom: { from: "options" },
            data: { ...replacement("data"), search: `?from=${req.path}` },
          }),
        });
        await served.socket.setRouteHandler("/options-direct", served.record, {
          onUpgrade: () => ({ custom: "direct", headers: { "X-Direct": "1" } }),
        });

        const head = await rawUpgrade(served.port, "/options/5");
        expect(values(head, "x-options")).toEqual(["1"]);
        const data = await connect(served, "/options/5");
        expect(data.host).toBe("replaced.test");
        expect(data.search).toBe("?from=/options/5");
        expect(data.custom).toEqual({ from: "options" });
        expect(data.params).toEqual({ id: "5" });

        expect(
          values(await rawUpgrade(served.port, "/options-direct"), "x-direct"),
        ).toEqual(["1"]);
        expect((await connect(served, "/options-direct")).custom).toBe(
          "direct",
        );
      });
    });

    it("with both names given, onUpgrade wins and a warning is logged once", async () => {
      await using(
        start,
        {
          onUpgrade: () => ({ custom: "onUpgrade" }),
          customDataToWsClientFn: () => "legacy",
        },
        async (served) => {
          served.router.ws("/both", served.record);
          expect((await connect(served, "/both")).custom).toBe("onUpgrade");
          expect((await connect(served, "/both")).custom).toBe("onUpgrade");
          const warnings = served.logs.filter((log) => log.level === "warn");
          expect(warnings).toHaveLength(1);
          expect(warnings[0]?.message).toContain("customDataToWsClientFn");
        },
      );
    });

    it("layers router defaults, then res values, then the hook", async () => {
      await using(start, undefined, async (served) => {
        served.router
          .setWebSocketUpgradeHeaders({
            "X-Layer": "router",
            "X-Router": "1",
          })
          .setWebSocketUpgradeData({
            custom: "router",
            search: "?router",
            hash: "#router",
          });
        served.router.use("/layered", (_req, res, next) => {
          res.webSocketUpgradeHeaders = { "X-Layer": "res", "X-Res": "1" };
          // `route` is a dispatch key: a layer cannot move the connection.
          res.webSocketUpgradeData = {
            custom: "res",
            search: "?res",
            route: "/elsewhere",
          };
          next();
        });
        served.router.ws("/layered", served.record, {
          onUpgrade: () => ({
            headers: { "X-Layer": "hook" },
          }),
        });
        served.router.ws("/layered/custom", served.record, {
          onUpgrade: () => ({
            custom: "hook",
          }),
        });

        const head = await rawUpgrade(served.port, "/layered");
        expect(values(head, "x-layer")).toEqual(["hook"]);
        expect(values(head, "x-router")).toEqual(["1"]);
        expect(values(head, "x-res")).toEqual(["1"]);

        const data = await connect(served, "/layered");
        expect(data.custom).toBe("res");
        expect(data.search).toBe("?res");
        expect(data.hash).toBe("#router");
        expect(data.route).toBe("/layered");

        // A hook's custom beats both layers; its data would beat everything.
        expect((await connect(served, "/layered/custom")).custom).toBe("hook");

        // Router defaults are read at upgrade time.
        served.router.webSocketUpgradeHeaders = undefined;
        const cleared = await rawUpgrade(served.port, "/layered");
        expect(values(cleared, "x-router")).toEqual([]);
        expect(values(cleared, "x-res")).toEqual(["1"]);
      });
    });

    it("a hook's data replaces the router and res data layers, but not their headers", async () => {
      await using(start, undefined, async (served) => {
        served.router
          .setWebSocketUpgradeHeaders({ "X-Router": "1" })
          .setWebSocketUpgradeData({ custom: "router", search: "?router" });
        served.router.use("/replaced", (_req, res, next) => {
          res.webSocketUpgradeData = { custom: "res" };
          next();
        });
        served.router.ws("/replaced", served.record, {
          onUpgrade: () => ({
            data: replacement("data"),
          }),
        });
        const data = await connect(served, "/replaced");
        expect(data.custom).toBe("data");
        expect(data.search).toBe("");
        const head = await rawUpgrade(served.port, "/replaced");
        expect(values(head, "x-router")).toEqual(["1"]);
      });
    });

    it("a bare upgradeToWebsocket() honours the router and res layers under its own arguments", async () => {
      await using(start, undefined, async (served) => {
        served.router
          .setWebSocketUpgradeHeaders({
            "Sec-WebSocket-Protocol": "other",
            "X-Trace": "trace-1",
          })
          .setWebSocketUpgradeData({ custom: { from: "router" }, hash: "#r" });
        served.router.use("/bare", (_req, res, next) => {
          res.webSocketUpgradeHeaders = { "X-Res": "1" };
          res.webSocketUpgradeData = { custom: { from: "res" } };
          next();
        });
        // Built data: the layers merge over it.
        served.router.get("/bare/built", (_req, res) => {
          return res.upgradeToWebsocket();
        });
        // Explicit data and headers: the data is used as is, the headers win
        // per name over the inherited ones.
        let explicit: WebSocketClientData | undefined;
        served.router.get("/bare/explicit", (req, res) => {
          explicit = {
            host: req.host,
            path: req.path,
            search: req.search,
            hash: req.hash,
            originalUrl: req.originalUrl,
            headers: req.headersObj,
            custom: { bunJobsApi: true },
            route: "/bare/explicit",
            params: {},
            port: served.port,
          };
          return res.upgradeToWebsocket(explicit, {
            headers: { "Sec-WebSocket-Protocol": PROTOCOL },
          });
        });
        // `inherit: false` sends only this call's arguments.
        served.router.get("/bare/alone", (_req, res) => {
          return res.upgradeToWebsocket(undefined, { inherit: false });
        });
        served.socket.on("open", (ws) => {
          if (ws.data.path.startsWith("/bare")) {
            served.opened.push(ws.data);
          }
        });

        // The router's protocol must be one the client offered.
        const built = await connect(served, "/bare/built", OFFER);
        expect(built.custom).toEqual({ from: "res" });
        expect(built.hash).toBe("#r");
        expect(built.path).toBe("/bare/built");
        const builtHead = await rawUpgrade(served.port, "/bare/built", OFFER);
        expect(values(builtHead, "sec-websocket-protocol")).toEqual(["other"]);
        expect(values(builtHead, "x-trace")).toEqual(["trace-1"]);
        expect(values(builtHead, "x-res")).toEqual(["1"]);

        const data = await connect(served, "/bare/explicit", OFFER);
        // Exactly what was passed: no router or res data, at any depth.
        expect(Object.keys(data).sort()).toEqual(
          Object.keys(explicit ?? {}).sort(),
        );
        expect(data).toEqual(explicit as WebSocketClientData);
        expect(data.custom).toEqual({ bunJobsApi: true });

        expect(
          await negotiatedProtocol(
            `ws://127.0.0.1:${served.port}/bare/explicit`,
            OFFER,
          ),
        ).toBe(PROTOCOL);
        const head = await rawUpgrade(served.port, "/bare/explicit", OFFER);
        expect(head.statusLine).toBe("HTTP/1.1 101 Switching Protocols");
        expect(values(head, "sec-websocket-protocol")).toEqual([PROTOCOL]);
        expect(values(head, "x-trace")).toEqual(["trace-1"]);
        expect(values(head, "x-res")).toEqual(["1"]);

        const alone = await connect(served, "/bare/alone");
        expect(alone.custom).toEqual({});
        expect(alone.hash).toBe("");
        const aloneHead = await rawUpgrade(served.port, "/bare/alone", OFFER);
        expect(aloneHead.headers.map(([header]) => header)).toEqual(
          BUN_DEFAULT_101,
        );
      });
    });

    it("with no values set, a ws() route's 101 and data are unchanged", async () => {
      await using(start, undefined, async (served) => {
        served.router.ws("/plain/:id", served.record);
        const head = await rawUpgrade(served.port, "/plain/1", OFFER);
        expect(head.statusLine).toBe("HTTP/1.1 101 Switching Protocols");
        expect(head.headers.map(([header]) => header)).toEqual(BUN_DEFAULT_101);
        expect(values(head, "sec-websocket-protocol")).toEqual(["other"]);

        const data = await connect(served, "/plain/1?q=1");
        expect(Object.keys(data).sort()).toEqual(
          [
            "custom",
            "hash",
            "headers",
            "host",
            "originalUrl",
            "params",
            "path",
            "port",
            "route",
            "search",
            "user",
          ].sort(),
        );
        expect(data.custom).toBeUndefined();
        expect(data.search).toBe("?q=1");
        expect(data.params).toEqual({ id: "1" });
      });
    });

    it("with no router, res or option values, every kind of upgrade sends Bun's 101 byte for byte", async () => {
      await using(start, undefined, async (served) => {
        served.router.ws("/same/route", served.record);
        served.router.get("/same/bare", (_req, res) => {
          return res.upgradeToWebsocket();
        });
        served.router.get("/same/explicit", (req, res) => {
          return res.upgradeToWebsocket({
            host: req.host,
            path: req.path,
            search: req.search,
            hash: req.hash,
            originalUrl: req.originalUrl,
            headers: req.headersObj,
            custom: {},
          });
        });
        for (const protocols of [[], OFFER]) {
          const baseline = await bunBaseline(protocols);
          for (const path of ["/same/route", "/same/bare", "/same/explicit"]) {
            expect(wire(await rawUpgrade(served.port, path, protocols))).toBe(
              baseline,
            );
          }
        }
      });
    });
  });
}

describeOnUpgrade("bun-common BunHttpAdapter", startAdapter);
describeOnUpgrade("a standalone BunWebSocket server", startStandalone);
describeOnUpgrade(
  "a BunWebSocket attached after listen()",
  startAttachedAfterListen,
);

describe("onUpgrade: whose router defaults apply", () => {
  it("a ws() route takes the defaults of the router ws() was called on, mounted or not", async () => {
    await using(startAdapter, undefined, async (served) => {
      const adapter = served.router;
      adapter.setWebSocketUpgradeHeaders({ "X-Main": "1" });
      const sub = new BunRouter({ bunWebsocket: served.socket });
      sub
        .setWebSocketUpgradeHeaders({ "X-Sub": "1" })
        .setWebSocketUpgradeData({ custom: "sub" });
      sub.ws("/sub-live", served.record);
      // A bare upgrade inside the sub-router: mounting flattens its routes
      // into the adapter, so it is the adapter that runs the request.
      sub.get("/bare", (_req, res) => res.upgradeToWebsocket());
      adapter.use("/api", sub);

      // The route itself lands on the socket's router (the adapter), at the
      // path `ws()` was given.
      const head = await rawUpgrade(served.port, "/sub-live");
      expect(head.statusLine).toBe("HTTP/1.1 101 Switching Protocols");
      expect(values(head, "x-sub")).toEqual(["1"]);
      expect(values(head, "x-main")).toEqual([]);
      expect((await connect(served, "/sub-live")).custom).toBe("sub");

      const bare = await rawUpgrade(served.port, "/api/bare");
      expect(bare.statusLine).toBe("HTTP/1.1 101 Switching Protocols");
      expect(values(bare, "x-main")).toEqual(["1"]);
      expect(values(bare, "x-sub")).toEqual([]);
    });
  });

  it("setRouteHandler() called directly takes the BunWebSocket's router's defaults", async () => {
    await using(startStandalone, undefined, async (served) => {
      served.router.setWebSocketUpgradeHeaders({ "X-Router": "1" });
      await served.socket.setRouteHandler("/direct", served.record);
      const head = await rawUpgrade(served.port, "/direct");
      expect(values(head, "x-router")).toEqual(["1"]);
    });
  });

  it("an adapter with a replaced instance reads and writes the instance's defaults", () => {
    const adapter = new BunHttpAdapter(0, {
      logger: createTestLogger().logger,
    });
    adapter.setWebSocketUpgradeHeaders({ "X-Own": "1" });
    expect(adapter.webSocketUpgradeHeaders?.get("x-own")).toBe("1");

    const instance = new BunRouter();
    adapter.setInstance(instance);
    expect(adapter.webSocketUpgradeHeaders).toBeUndefined();
    adapter
      .setWebSocketUpgradeHeaders({ "X-Instance": "1" })
      .setWebSocketUpgradeData({ custom: "instance" });
    expect(instance.webSocketUpgradeHeaders?.get("x-instance")).toBe("1");
    expect(instance.webSocketUpgradeData).toEqual({ custom: "instance" });
    expect(adapter.webSocketUpgradeData).toEqual({ custom: "instance" });
  });
});

describe("onUpgrade: BunRouter and BunResponse accessors", () => {
  it("router values are copied, read back as Headers, and cleared by undefined", () => {
    const router = new BunRouter();
    expect(router.webSocketUpgradeHeaders).toBeUndefined();
    expect(router.webSocketUpgradeData).toBeUndefined();

    const init = { "X-A": "1" };
    const data = { custom: "c" };
    expect(router.setWebSocketUpgradeHeaders(init)).toBe(router);
    expect(router.setWebSocketUpgradeData(data)).toBe(router);
    expect(router.webSocketUpgradeHeaders).toBeInstanceOf(Headers);
    expect(router.webSocketUpgradeHeaders?.get("x-a")).toBe("1");
    data.custom = "changed";
    expect(router.webSocketUpgradeData).toEqual({ custom: "c" });

    router.webSocketUpgradeHeaders = undefined;
    router.webSocketUpgradeData = undefined;
    expect(router.webSocketUpgradeHeaders).toBeUndefined();
    expect(router.webSocketUpgradeData).toBeUndefined();
  });

  it("res values layer under explicit headers; each call recomputes", async () => {
    const res = await makeResponse();
    res.webSocketUpgradeHeaders = [
      ["X-Multi", "a"],
      ["X-Multi", "b"],
      ["X-Keep", "1"],
    ];
    res.upgradeToWebsocket(undefined, { headers: { "x-multi": "c" } });
    // A name given later replaces every value of it beneath.
    expect(res.upgradeToWsHeaders?.get("x-multi")).toBe("c");
    expect(res.upgradeToWsHeaders?.get("x-keep")).toBe("1");

    res.upgradeToWebsocket();
    expect(res.upgradeToWsHeaders?.get("x-multi")).toBe("a, b");

    res.upgradeToWebsocket(undefined, { inherit: false });
    expect(res.upgradeToWsHeaders).toBeUndefined();
  });

  it("a response outside any router has no router layer, and data is used as given", async () => {
    const res = await makeResponse();
    expect(res.webSocketUpgradeDefaults).toBeUndefined();
    res.webSocketUpgradeData = { custom: "res" };
    const given = {
      host: "h",
      path: "/",
      search: "",
      hash: "",
      originalUrl: "/",
      headers: new Headers(),
      custom: "given",
    };
    res.upgradeToWebsocket(given);
    expect(res.upgradeToWsData).toBe(given);
    res.upgradeToWebsocket();
    expect(res.upgradeToWsData?.custom).toBe("res");
  });

  it("a router's handle() records itself as the response's source of defaults, outermost first", async () => {
    const outer = new BunRouter();
    const inner = new BunRouter();
    const res = await makeResponse();
    await outer.handle({
      requestHost: "localhost",
      requestMethod: "GET",
      requestUrl: "/",
      request: res.req,
      response: res,
    });
    await inner.handle({
      requestHost: "localhost",
      requestMethod: "GET",
      requestUrl: "/",
      request: res.req,
      response: res,
    });
    expect(res.webSocketUpgradeDefaults).toBe(outer);
  });
});
