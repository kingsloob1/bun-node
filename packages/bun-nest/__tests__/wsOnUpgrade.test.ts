/**
 * `onUpgrade` and the router- / response-level upgrade values through
 * bun-nest: the HTTP adapter's `websocket.onUpgrade` option and its
 * `webSocketUpgradeHeaders`/`webSocketUpgradeData` (delegated to the app's
 * router), and `BunWebSocketAdapter`'s own `onUpgrade` option, both as
 * `localOptions` and in the normal shape. bun-nest's adapter performs the
 * upgrade with its own `server.upgrade` call, so each layer is checked on
 * the wire.
 */
import type {
  WebSocketClientData,
  WebSocketUpgradeHook,
} from "@kingsleyweb/bun-common";
import type { RawResponseHead } from "../../bun-common/__tests__/helpers";
import { describe, expect, it } from "bun:test";
import {
  negotiatedProtocol,
  rawUpgrade,
} from "../../bun-common/__tests__/helpers";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunWebSocketAdapter } from "../lib/BunWebSocketAdapter";

/** The subprotocol the server picks from the client's offer. */
const PROTOCOL = "bun-jobs.v1";
/** An offer that puts another protocol first, which Bun echoes by default. */
const OFFER = ["other", PROTOCOL];

/** The values of every `name` header in `head`, in wire order. */
function values(head: RawResponseHead, name: string): string[] {
  return head.headers.filter(([key]) => key === name).map(([, v]) => v);
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

/** Records every connection's `ws.data`. */
function recorder() {
  const opened: WebSocketClientData[] = [];
  return {
    opened,
    handler: {
      open: (ws: { data: WebSocketClientData }) => {
        opened.push(ws.data);
      },
      message: () => {},
    },
  };
}

/** Opens a client on `path` and returns the `ws.data` the server recorded. */
async function connect(
  port: number,
  opened: WebSocketClientData[],
  path: string,
  protocols: string[] = [],
): Promise<WebSocketClientData> {
  const before = opened.length;
  const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols);
  await new Promise<void>((resolve, reject) => {
    const refuse = () => reject(new Error(`no upgrade at ${path}`));
    client.addEventListener("open", () => resolve(), { once: true });
    client.addEventListener("error", refuse, { once: true });
    client.addEventListener("close", refuse, { once: true });
  });
  try {
    await until(() => opened.length > before);
    return opened[opened.length - 1] as WebSocketClientData;
  } finally {
    client.close();
  }
}

/** Starts a nest adapter, runs `body`, and always closes it. */
async function withAdapter(
  websocket: { onUpgrade?: WebSocketUpgradeHook } | undefined,
  body: (adapter: BunHttpAdapter, port: number) => Promise<void>,
) {
  const adapter = new BunHttpAdapter(0, websocket ? { websocket } : {});
  await adapter.listen(0);
  try {
    await body(adapter, Number(adapter.listeningPort));
  } finally {
    await adapter.close();
  }
}

describe("bun-nest BunHttpAdapter: onUpgrade and upgrade layers", () => {
  it("the websocket.onUpgrade option applies to ws() routes, and a route's hook replaces it", async () => {
    await withAdapter(
      {
        onUpgrade: () => ({
          custom: "instance",
          headers: { "Sec-WebSocket-Protocol": PROTOCOL },
        }),
      },
      async (adapter, port) => {
        const { opened, handler } = recorder();
        adapter.instance.ws("/instance", handler);
        adapter.instance.ws("/own", handler, {
          onUpgrade: () => ({
            custom: "route",
            headers: { "X-Route": "1" },
          }),
        });

        expect(
          await negotiatedProtocol(`ws://127.0.0.1:${port}/instance`, OFFER),
        ).toBe(PROTOCOL);
        const head = await rawUpgrade(port, "/instance", OFFER);
        expect(values(head, "sec-websocket-protocol")).toEqual([PROTOCOL]);
        expect((await connect(port, opened, "/instance", OFFER)).custom).toBe(
          "instance",
        );

        const own = await rawUpgrade(port, "/own", OFFER);
        expect(values(own, "x-route")).toEqual(["1"]);
        expect(values(own, "sec-websocket-protocol")).toEqual(["other"]);
        expect((await connect(port, opened, "/own")).custom).toBe("route");
      },
    );
  });

  it("a hook's data replaces ws.data, with route/params/port filled in", async () => {
    await withAdapter(undefined, async (adapter, port) => {
      const { opened, handler } = recorder();
      adapter.instance.ws("/rooms/:id", handler, {
        onUpgrade: () => ({
          data: {
            host: "replaced.test",
            path: "/replaced",
            search: "",
            hash: "",
            originalUrl: "/replaced",
            headers: new Headers(),
            custom: "data",
          },
        }),
      });
      const data = await connect(port, opened, "/rooms/9");
      expect(data.host).toBe("replaced.test");
      expect(data.custom).toBe("data");
      expect(data.route).toBe("/rooms/:id");
      expect(data.params).toEqual({ id: "9" });
      expect(data.port).toBe(port);
    });
  });

  it("layers the adapter's defaults, res values and the hook", async () => {
    await withAdapter(undefined, async (adapter, port) => {
      const { opened, handler } = recorder();
      expect(
        adapter
          .setWebSocketUpgradeHeaders({ "X-Layer": "router", "X-Router": "1" })
          .setWebSocketUpgradeData({ custom: "router", hash: "#router" }),
      ).toBe(adapter);
      // Delegated to the app's router.
      expect(adapter.instance.webSocketUpgradeHeaders?.get("x-router")).toBe(
        "1",
      );
      adapter.use("/layered", (_req, res, next) => {
        res.webSocketUpgradeHeaders = { "X-Layer": "res", "X-Res": "1" };
        res.webSocketUpgradeData = { custom: "res" };
        next();
      });
      adapter.instance.ws("/layered", handler, {
        onUpgrade: () => ({
          headers: { "X-Layer": "hook" },
        }),
      });

      const head = await rawUpgrade(port, "/layered");
      expect(values(head, "x-layer")).toEqual(["hook"]);
      expect(values(head, "x-router")).toEqual(["1"]);
      expect(values(head, "x-res")).toEqual(["1"]);
      const data = await connect(port, opened, "/layered");
      expect(data.custom).toBe("res");
      expect(data.hash).toBe("#router");
    });
  });

  it("a bare upgradeToWebsocket() inherits the headers, keeps explicit data as is, and the explicit header wins", async () => {
    await withAdapter(undefined, async (adapter, port) => {
      adapter.webSocketUpgradeHeaders = {
        "Sec-WebSocket-Protocol": "other",
        "X-Trace": "trace-1",
      };
      adapter.webSocketUpgradeData = { custom: "router" };
      const opened: WebSocketClientData[] = [];
      adapter.webSocketAdapter.on("open", (ws) => {
        opened.push(ws.data);
      });
      let explicit: WebSocketClientData | undefined;
      adapter.get("/explicit", (req, res) => {
        res.webSocketUpgradeData = { custom: "res" };
        explicit = {
          host: req.host,
          path: req.path,
          search: req.search,
          hash: req.hash,
          originalUrl: req.originalUrl,
          headers: req.headersObj,
          custom: { bunJobsApi: true },
          route: "/explicit",
          params: {},
          port,
        };
        return res.upgradeToWebsocket(explicit, {
          headers: { "Sec-WebSocket-Protocol": PROTOCOL },
        });
      });

      expect(
        await negotiatedProtocol(`ws://127.0.0.1:${port}/explicit`, OFFER),
      ).toBe(PROTOCOL);
      const head = await rawUpgrade(port, "/explicit", OFFER);
      expect(values(head, "sec-websocket-protocol")).toEqual([PROTOCOL]);
      expect(values(head, "x-trace")).toEqual(["trace-1"]);

      const data = await connect(port, opened, "/explicit", OFFER);
      expect(Object.keys(data).sort()).toEqual(
        Object.keys(explicit ?? {}).sort(),
      );
      expect(data).toEqual(explicit as WebSocketClientData);
    });
  });

  it("with no values set, the 101 is Bun's own", async () => {
    await withAdapter(undefined, async (adapter, port) => {
      const { handler } = recorder();
      adapter.instance.ws("/plain", handler);
      const head = await rawUpgrade(port, "/plain", OFFER);
      expect(head.headers.map(([name]) => name)).toEqual([
        "upgrade",
        "connection",
        "sec-websocket-accept",
        "sec-websocket-protocol",
        "date",
      ]);
      expect(values(head, "sec-websocket-protocol")).toEqual(["other"]);
    });
  });
});

describe("bun-nest BunWebSocketAdapter: the onUpgrade option", () => {
  it("is honoured in localOptions", async () => {
    const httpAdapter = new BunHttpAdapter();
    await httpAdapter.listen(0);
    const port = Number(httpAdapter.listeningPort);
    try {
      const swapped = new BunWebSocketAdapter({
        httpAdapter,
        localOptions: {
          newInstance: false,
          getServer: () => httpAdapter.getBunServer(),
          onUpgrade: () => ({
            custom: "local",
            headers: { "X-Local": "1" },
          }),
        },
      });
      const { opened, handler } = recorder();
      swapped.router.ws("/local", handler);
      const head = await rawUpgrade(port, "/local");
      expect(values(head, "x-local")).toEqual(["1"]);
      expect((await connect(port, opened, "/local")).custom).toBe("local");
    } finally {
      await httpAdapter.close();
    }
  });

  it("is honoured in the normal shape, and beats a deprecated customDataToWsClientFn", async () => {
    const httpAdapter = new BunHttpAdapter();
    await httpAdapter.listen(0);
    const port = Number(httpAdapter.listeningPort);
    try {
      const swapped = new BunWebSocketAdapter({
        httpAdapter,
        newInstance: false,
        getServer: () => httpAdapter.getBunServer(),
        onUpgrade: () => ({ custom: "normal" }),
        customDataToWsClientFn: () => "legacy",
      });
      const { opened, handler } = recorder();
      swapped.router.ws("/normal", handler);
      expect((await connect(port, opened, "/normal")).custom).toBe("normal");
    } finally {
      await httpAdapter.close();
    }
  });
});
