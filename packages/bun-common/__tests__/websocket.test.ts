import { describe, expect, it } from "bun:test";
import { BunRouter } from "../lib/BunRouter";
import { BunWebSocket } from "../lib/BunWebSocket";
import { getPort } from "../lib/utils/native";

describe("BunWebSocket: construction", () => {
  it("builds a websocket handler with all lifecycle hooks", () => {
    const ws = new BunWebSocket({
      newInstance: false,
      router: new BunRouter(),
      getServer: () => undefined,
    });

    expect(ws).toBeInstanceOf(BunWebSocket);
    for (const hook of ["open", "message", "close", "ping", "pong", "drain"]) {
      expect(
        typeof (ws.wsHandler as unknown as Record<string, unknown>)[hook],
      ).toBe("function");
    }
  });

  it("returns undefined for getServer when none is available", () => {
    const ws = new BunWebSocket({
      newInstance: false,
      router: new BunRouter(),
      getServer: () => undefined,
    });
    expect(ws.getServer()).toBeUndefined();
  });
});

describe("BunWebSocket: events", () => {
  it("emits and receives events like an EventEmitter", () => {
    const ws = new BunWebSocket({
      newInstance: false,
      router: new BunRouter(),
      getServer: () => undefined,
    });

    let received: unknown;
    // The `message` event is emitted as `(wsClient, message)`.
    ws.on("message", (_client: unknown, message: unknown) => {
      received = message;
    });
    ws.emit(
      "message",
      ws.getServer() as unknown as Parameters<
        NonNullable<typeof ws.wsHandler.open>
      >[0],
      "payload",
    );
    expect(received).toBe("payload");
  });
});

describe("BunWebSocket: route handlers", () => {
  it("registers an upgrade route on the router", async () => {
    const router = new BunRouter();
    const ws = new BunWebSocket({
      newInstance: false,
      router,
      getServer: () => undefined,
    });

    const registered = await ws.setRouteHandler(
      "/socket",
      { message: () => {} },
      undefined,
    );
    expect(registered).toBe(true);

    const layers = router.getMatchedLayers({
      requestHost: "localhost",
      requestMethod: "GET",
      requestUrl: "/socket",
    });
    expect(layers.length).toBeGreaterThan(0);
  });

  it("ignores non-object handlers", async () => {
    const ws = new BunWebSocket({
      newInstance: false,
      router: new BunRouter(),
      getServer: () => undefined,
    });
    expect(await ws.setRouteHandler("/x", undefined as never, undefined)).toBe(
      false,
    );
  });
});

describe("BunWebSocket: standalone server", () => {
  it("creates its own server instance", async () => {
    const port = await getPort();
    const ws = new BunWebSocket({
      newInstance: true,
      router: new BunRouter(),
      listen: { port },
    });
    try {
      const server = ws.getServer();
      expect(server).toBeDefined();
      expect(typeof server?.port).toBe("number");
    } finally {
      ws.killServer(ws.getServer());
    }
  });
});
