import type {
  BunWebSocketHandlerType,
  BunWebSocketServerType,
  WebSocketClientData,
} from "../lib/BunWebSocket";
import { describe, expect, it, mock, spyOn } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunResponse } from "../lib/BunResponse";
import { BunRouter } from "../lib/BunRouter";
import { BunWebSocket } from "../lib/BunWebSocket";
import { createTestLogger } from "../lib/logging";
import { getPort } from "../lib/utils/native";

/** Opens a client and resolves once the socket is open, with its received frames. */
async function openClient(url: string) {
  const client = new WebSocket(url);
  const received: string[] = [];
  client.onmessage = (event) => {
    received.push(String(event.data));
  };
  await new Promise<void>((resolve, reject) => {
    client.onopen = () => resolve();
    client.onerror = (event) =>
      reject(new Error(`WebSocket ${url} failed to open`, { cause: event }));
  });
  return { client, received };
}

/** Polls `predicate` until true, or fails after `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await Bun.sleep(10);
  }
}

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

describe("BunWebSocket: lazy emitter", () => {
  it("emit returns false when nothing is listening", () => {
    const ws = new BunWebSocket({
      newInstance: false,
      router: new BunRouter(),
      getServer: () => undefined,
    });
    expect(ws.emit("drain", undefined as never)).toBe(false);
  });

  it("on returns the instance and supports introspection/removal", () => {
    const ws = new BunWebSocket({
      newInstance: false,
      router: new BunRouter(),
      getServer: () => undefined,
    });

    const listener = () => {};
    expect(ws.on("ping", listener)).toBe(ws);
    expect(ws.listenerCount("ping")).toBe(1);
    expect(ws.eventNames()).toContain("ping");

    ws.off("ping", listener);
    expect(ws.listenerCount("ping")).toBe(0);

    ws.once("pong", () => {});
    ws.removeAllListeners();
    expect(ws.eventNames()).toHaveLength(0);
  });

  it("fires a once listener a single time", () => {
    const ws = new BunWebSocket({
      newInstance: false,
      router: new BunRouter(),
      getServer: () => undefined,
    });

    let calls = 0;
    ws.once("drain", () => {
      calls++;
    });
    ws.emit("drain", undefined as never);
    ws.emit("drain", undefined as never);
    expect(calls).toBe(1);
  });
});

describe("BunWebSocket: route handlers on a live server", () => {
  it("runs handlers registered on a param route, exposing route and params", async () => {
    const ws = new BunWebSocket({
      newInstance: true,
      router: new BunRouter(),
      listen: { port: 0 },
    });
    const opened: WebSocketClientData[] = [];
    const messages: string[] = [];
    await ws.setRouteHandler(
      "/rooms/:id",
      {
        open: (socket) => {
          opened.push(socket.data);
        },
        message: (socket, message) => {
          messages.push(String(message));
          socket.send(
            `room ${String(socket.data.params?.id)}: ${String(message)}`,
          );
        },
      },
      undefined,
    );

    try {
      const { client, received } = await openClient(
        `ws://127.0.0.1:${ws.port}/rooms/42?x=1`,
      );
      client.send("hello");
      await until(() => received.length > 0);
      client.close();

      expect(opened).toHaveLength(1);
      expect(opened[0]?.path).toBe("/rooms/42");
      expect(opened[0]?.route).toBe("/rooms/:id");
      expect(opened[0]?.params).toEqual({ id: "42" });
      expect(opened[0]?.hash).toBe("");
      expect(messages).toEqual(["hello"]);
      expect(received).toEqual(["room 42: hello"]);
    } finally {
      ws.killServer(ws.getServer());
    }
  });
});

describe("BunWebSocket: ws.data.params is the connection's own copy", () => {
  it("copies a wildcard's array, so mutating it reaches no other connection", async () => {
    const ws = new BunWebSocket({
      newInstance: true,
      router: new BunRouter(),
      listen: { port: 0 },
    });
    const seen: string[][] = [];
    await ws.setRouteHandler(
      "/files/*rest",
      {
        open: (socket) => {
          const rest = socket.data.params?.rest as string[];
          seen.push([...rest]);
          // Mutable: the connection's own copy.
          rest.push("mine");
          socket.send(rest.join("/"));
        },
        message: () => {},
      },
      undefined,
    );
    try {
      for (let i = 0; i < 2; i++) {
        const { client, received } = await openClient(
          `ws://127.0.0.1:${ws.port}/files/a/b`,
        );
        await until(() => received.length > 0);
        client.close();
        expect(received).toEqual(["a/b/mine"]);
      }
      expect(seen).toEqual([
        ["a", "b"],
        ["a", "b"],
      ]);
    } finally {
      ws.killServer(ws.getServer());
    }
  });
});

describe("BunWebSocket: killServer", () => {
  it("force-stops the server it is given", () => {
    const ws = new BunWebSocket({
      newInstance: false,
      router: new BunRouter(),
      getServer: () => undefined,
    });
    const stop = mock((_force?: boolean) => Promise.resolve());
    ws.killServer({
      port: 4321,
      stop,
    } as unknown as BunWebSocketServerType);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(true);
  });

  it("never binds a server while killing one that is not running", async () => {
    const ws = new BunWebSocket({
      newInstance: false,
      router: new BunRouter(),
      getServer: () => undefined,
    });
    const port = await getPort();
    const serve = spyOn(Bun, "serve");
    try {
      ws.killServer({
        port,
        stop: () => Promise.resolve(),
      } as unknown as BunWebSocketServerType);
      expect(serve).not.toHaveBeenCalled();
    } finally {
      serve.mockRestore();
    }
  });
});

describe("BunWebSocket: standalone server options", () => {
  it("binds an OS-assigned port for port 0 and reports it", async () => {
    const ws = new BunWebSocket({
      newInstance: true,
      router: new BunRouter(),
      listen: { port: 0 },
    });
    try {
      expect(ws.port).toBeGreaterThan(0);
      expect(ws.port).toBe(ws.getServer()?.port);
      const response = await fetch(`http://127.0.0.1:${ws.port}/nothing`);
      expect(response.status).toBe(404);
    } finally {
      ws.killServer(ws.getServer());
    }
  });

  it("rejects a port outside 0-65535", () => {
    expect(
      () =>
        new BunWebSocket({
          newInstance: true,
          router: new BunRouter(),
          listen: { port: -1 },
        }),
    ).toThrow(/listen\.port/);
  });

  it("works without a router: a private one is created on first use", async () => {
    const ws = new BunWebSocket({
      newInstance: true,
      listen: { port: 0 },
    });
    const opened: string[] = [];
    try {
      expect(ws.router).toBeInstanceOf(BunRouter);
      expect(ws.router.getBunWebsocket()).toBe(ws);
      expect(
        await ws.setRouteHandler(
          "/live",
          {
            open: (socket) => {
              opened.push(socket.data.path);
            },
            message: () => {},
          },
          undefined,
        ),
      ).toBe(true);

      expect((await fetch(`http://127.0.0.1:${ws.port}/other`)).status).toBe(
        404,
      );
      const { client } = await openClient(`ws://127.0.0.1:${ws.port}/live`);
      await until(() => opened.length > 0);
      client.close();
      expect(opened).toEqual(["/live"]);
    } finally {
      ws.killServer(ws.getServer());
    }
  });

  it("does not use the WebSocket idle timeout as the HTTP response timeout", async () => {
    const router = new BunRouter();
    // Responds after the pipeline has returned — the case a response timeout
    // governs (an awaited handler finishes before the timer starts).
    router.get("/slow", (_req, res) => {
      setTimeout(() => res.send("done"), 1300);
    });
    const ws = new BunWebSocket({
      newInstance: true,
      router,
      listen: { port: 0 },
      wsOptions: { idleTimeout: 1 },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${ws.port}/slow`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("done");
    } finally {
      ws.killServer(ws.getServer());
    }
  });

  it("waits responseTimeout ms for a response, and not at all by default", async () => {
    // Asserted on the value handed to `getNativeResponse`; what a timeout
    // answers is covered by "standalone server errors" below.
    const router = new BunRouter();
    router.get("/ok", (_req, res) => {
      res.send("ok");
    });
    const timed = new BunWebSocket({
      newInstance: true,
      router,
      listen: { port: 0 },
      responseTimeout: 100,
      wsOptions: { idleTimeout: 5 },
    });
    const untimed = new BunWebSocket({
      newInstance: true,
      router,
      listen: { port: 0 },
      wsOptions: { idleTimeout: 5 },
    });
    const spy = spyOn(BunResponse.prototype, "getNativeResponse");
    try {
      expect((await fetch(`http://127.0.0.1:${timed.port}/ok`)).status).toBe(
        200,
      );
      expect(spy.mock.calls.at(-1)).toEqual([100]);

      expect((await fetch(`http://127.0.0.1:${untimed.port}/ok`)).status).toBe(
        200,
      );
      // Not `idleTimeout * 1000`: the WebSocket setting stays WebSocket-only.
      expect(spy.mock.calls.at(-1)).toEqual([0]);
    } finally {
      spy.mockRestore();
      timed.killServer(timed.getServer());
      untimed.killServer(untimed.getServer());
    }
  });
});

describe("BunWebSocket: standalone server errors", () => {
  it("answers a response timeout with 500 and logs it, rather than throwing", async () => {
    const { logger, events } = createTestLogger();
    const router = new BunRouter();
    router.setLogger(logger);
    let late: ReturnType<typeof setTimeout> | undefined;
    router.get("/late", (_req, res) => {
      late = setTimeout(() => {
        try {
          res.send("too late");
        } catch {
          // The request already failed; nothing is listening.
        }
      }, 400);
    });
    const ws = new BunWebSocket({
      newInstance: true,
      router,
      listen: { port: 0 },
      responseTimeout: 50,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${ws.port}/late`);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal Server Error");

      const logged = events.filter((event) => event.level === "error");
      expect(logged).toHaveLength(1);
      expect(logged[0]?.error?.message).toMatch(/timed ?out/i);
      expect(logged[0]?.fields.status).toBe(500);
    } finally {
      clearTimeout(late);
      ws.killServer(ws.getServer());
    }
  });

  it("answers a handler error with its own 4xx status and message", async () => {
    const { logger, events } = createTestLogger();
    const router = new BunRouter();
    router.setLogger(logger);
    router.get("/invalid", () => {
      throw Object.assign(new Error("bad input"), { statusCode: 422 });
    });
    const ws = new BunWebSocket({
      newInstance: true,
      router,
      listen: { port: 0 },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${ws.port}/invalid?q=1`);
      expect(response.status).toBe(422);
      expect(await response.text()).toBe("bad input");

      const logged = events.filter((event) => event.level === "error");
      expect(logged).toHaveLength(1);
      expect(logged[0]?.fields).toMatchObject({
        status: 422,
        method: "GET",
        url: "/invalid?q=1",
      });
    } finally {
      ws.killServer(ws.getServer());
    }
  });

  it("lets serverOptions.error replace the default answer", async () => {
    const { logger, events } = createTestLogger();
    const router = new BunRouter();
    router.setLogger(logger);
    router.get("/boom", () => {
      throw new Error("boom");
    });
    const seen: string[] = [];
    const ws = new BunWebSocket({
      newInstance: true,
      router,
      listen: { port: 0 },
      serverOptions: {
        error(error) {
          seen.push(error.message);
          return new Response("custom", { status: 503 });
        },
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${ws.port}/boom`);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("custom");
      expect(seen).toEqual(["boom"]);
      expect(events.filter((event) => event.level === "error")).toEqual([]);
    } finally {
      ws.killServer(ws.getServer());
    }
  });
});

describe("BunWebSocket: ws.data.port records the accepting server", () => {
  it("is the adapter's real bound port for a client of an adapter on port 0", async () => {
    const adapter = new BunHttpAdapter(0, {
      logger: createTestLogger().logger,
    });
    const opened: WebSocketClientData[] = [];
    adapter.ws("/live", {
      open: (socket) => {
        opened.push(socket.data);
      },
      message: () => {},
    });
    try {
      const server = await adapter.listen(0);
      expect(server.port).toBeGreaterThan(0);

      const { client } = await openClient(`ws://127.0.0.1:${server.port}/live`);
      await until(() => opened.length > 0);
      client.close();

      expect(opened[0]?.port).toBe(server.port);
    } finally {
      await adapter.close();
    }
  });

  it("is a standalone server's real bound port when it listens on port 0", async () => {
    const ws = new BunWebSocket({
      newInstance: true,
      router: new BunRouter(),
      listen: { port: 0 },
    });
    const opened: WebSocketClientData[] = [];
    await ws.setRouteHandler(
      "/live",
      {
        open: (socket) => {
          opened.push(socket.data);
        },
        message: () => {},
      },
      undefined,
    );
    try {
      expect(ws.port).toBeGreaterThan(0);
      const { client } = await openClient(`ws://127.0.0.1:${ws.port}/live`);
      await until(() => opened.length > 0);
      client.close();

      expect(opened[0]?.port).toBe(ws.port);
    } finally {
      ws.killServer(ws.getServer());
    }
  });

  it("is set for a bare res.upgradeToWebsocket() on a server this instance built", async () => {
    const router = new BunRouter();
    router.get("/bare", (_req, res) => res.upgradeToWebsocket());
    const ws = new BunWebSocket({
      newInstance: true,
      router,
      listen: { port: 0 },
    });
    const ports: (number | undefined)[] = [];
    ws.on("open", (socket) => {
      ports.push(socket.data.port);
    });
    try {
      const { client } = await openClient(`ws://127.0.0.1:${ws.port}/bare`);
      await until(() => ports.length > 0);
      client.close();

      expect(ports).toEqual([ws.port]);
    } finally {
      ws.killServer(ws.getServer());
    }
  });

  it("tells a client of the shared port from one of a gateway's own port on the same route", async () => {
    const adapter = new BunHttpAdapter(0, {
      logger: createTestLogger().logger,
    });
    const opened: WebSocketClientData[] = [];
    adapter.ws("/gateway", {
      open: (socket) => {
        opened.push(socket.data);
      },
      message: () => {},
    });
    const wsAdapter = adapter.webSocketAdapter;
    let gateway: BunWebSocketServerType | undefined;
    try {
      const shared = await adapter.listen(0);
      // A `@WebSocketGateway(port)`-style extra server: same router, own port.
      gateway = wsAdapter.getOrCreateWebsocketServer(await getPort());
      expect(gateway).toBeDefined();
      expect(gateway).not.toBe(wsAdapter.getServer());

      const viaShared = await openClient(
        `ws://127.0.0.1:${shared.port}/gateway`,
      );
      await until(() => opened.length === 1);
      const viaGateway = await openClient(
        `ws://127.0.0.1:${gateway?.port}/gateway`,
      );
      await until(() => opened.length === 2);
      viaShared.client.close();
      viaGateway.client.close();

      expect(opened[0]?.port).toBe(shared.port);
      expect(opened[1]?.port).toBe(gateway?.port);
      expect(opened[0]?.port).not.toBe(opened[1]?.port);
    } finally {
      wsAdapter.killServer(gateway);
      await adapter.close();
    }
  });
});

describe("BunWebSocket: removeAllListeners argument handling", () => {
  it("detaches everything when called with no argument", () => {
    const ws = new BunWebSocket({
      newInstance: false,
      router: new BunRouter(),
      getServer: () => undefined,
    });
    ws.on("ping", () => {});
    ws.once("pong", () => {});

    ws.removeAllListeners();

    // A long-lived socket is where a leaked listener actually accumulates.
    expect(ws.eventNames()).toHaveLength(0);
    expect(ws.listenerCount("ping")).toBe(0);
    expect(ws.listenerCount("pong")).toBe(0);
  });

  it("removes only the named event when given one", () => {
    const ws = new BunWebSocket({
      newInstance: false,
      router: new BunRouter(),
      getServer: () => undefined,
    });
    ws.on("ping", () => {});
    ws.on("pong", () => {});

    ws.removeAllListeners("ping");

    expect(ws.listenerCount("ping")).toBe(0);
    expect(ws.listenerCount("pong")).toBe(1);
  });
});

describe("BunWebSocket: an instance attached after listen()", () => {
  it("dispatches to the instance current at call time, not the one bound at listen", async () => {
    const adapter = new BunHttpAdapter(0, {
      logger: createTestLogger().logger,
    });
    try {
      const server = await adapter.listen(0);

      // A `BunWebSocket` constructed with a router calls `setBunWebSocket()` on
      // it — the way bun-nest's adapter, and so NestJS's
      // `useWebSocketAdapter()`, takes over after the server is already up.
      const swapped = new BunWebSocket({
        newInstance: false,
        router: adapter,
        getServer: () => adapter.getBunServer(),
      });
      expect(adapter.getBunWebsocket()).toBe(swapped);
      // The built-in instance is untouched; only dispatch moved.
      expect(adapter.webSocketAdapter).not.toBe(swapped);

      const opened: WebSocketClientData[] = [];
      const messages: string[] = [];
      const emitted: string[] = [];
      swapped.on("open", (socket) => {
        emitted.push(socket.data.path);
      });
      await swapped.setRouteHandler(
        "/fresh",
        {
          open: (socket) => {
            opened.push(socket.data);
          },
          message: (socket, message) => {
            messages.push(String(message));
            socket.send(`echo:${String(message)}`);
          },
        },
        undefined,
      );

      const { client, received } = await openClient(
        `ws://127.0.0.1:${server.port}/fresh`,
      );
      client.send("hello");
      await until(() => received.length > 0);
      client.close();

      // The route handler registered on the new instance runs,
      expect(opened).toHaveLength(1);
      expect(opened[0]?.route).toBe("/fresh");
      expect(messages).toEqual(["hello"]);
      expect(received).toEqual(["echo:hello"]);
      // its emitter fires,
      expect(emitted).toEqual(["/fresh"]);
      // and the accepting server's real port is still recorded.
      expect(opened[0]?.port).toBe(server.port);
    } finally {
      await adapter.close();
    }
  });

  it("stops dispatching to the instance it replaced", async () => {
    const adapter = new BunHttpAdapter(0, {
      logger: createTestLogger().logger,
    });
    const staleRoute: string[] = [];
    // Registered on the built-in instance, before anything is swapped in.
    adapter.ws("/stale", {
      open: (socket) => {
        staleRoute.push(socket.data.path);
      },
      message: () => {},
    });
    const original = adapter.webSocketAdapter;
    const staleEvents: string[] = [];
    original.on("open", (socket) => {
      staleEvents.push(socket.data.path);
    });

    try {
      const server = await adapter.listen(0);
      const swapped = new BunWebSocket({
        newInstance: false,
        router: adapter,
        getServer: () => adapter.getBunServer(),
      });

      const opened: string[] = [];
      await swapped.setRouteHandler(
        "/stale",
        {
          open: (socket) => {
            opened.push(socket.data.path);
          },
          message: () => {},
        },
        undefined,
      );

      const { client } = await openClient(
        `ws://127.0.0.1:${server.port}/stale`,
      );
      await until(() => opened.length > 0);
      client.close();

      // Last one wins: the replaced instance sees neither its own route
      // handler nor its emitter, even on a path it registered itself.
      expect(opened).toEqual(["/stale"]);
      expect(staleRoute).toEqual([]);
      expect(staleEvents).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it("keeps the built-in instance dispatching when nothing is swapped in", async () => {
    // The guard against the fix over-reaching: with no later instance, the
    // adapter's own `BunWebSocket` must still be the one that dispatches.
    const adapter = new BunHttpAdapter(0, {
      logger: createTestLogger().logger,
    });
    const opened: WebSocketClientData[] = [];
    adapter.ws("/plain", {
      open: (socket) => {
        opened.push(socket.data);
      },
      message: (socket, message) => {
        socket.send(`echo:${String(message)}`);
      },
    });

    try {
      const server = await adapter.listen(0);
      const { client, received } = await openClient(
        `ws://127.0.0.1:${server.port}/plain`,
      );
      client.send("ping");
      await until(() => received.length > 0);
      client.close();

      expect(adapter.getBunWebsocket()).toBe(adapter.webSocketAdapter);
      expect(received).toEqual(["echo:ping"]);
      expect(opened[0]?.port).toBe(server.port);
    } finally {
      await adapter.close();
    }
  });
});

/**
 * Sends a raw WebSocket upgrade request for `path` and resolves the status
 * code and head of the answer — a `101` included, which `fetch` cannot see.
 */
async function rawUpgrade(port: number, path: string) {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let head = "";
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, chunk) {
        head += chunk.toString();
        if (head.includes("\r\n\r\n")) {
          resolve(head);
        }
      },
      error(_socket, error) {
        reject(error);
      },
      close() {
        resolve(head);
      },
    },
  });
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
      "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
  try {
    const text = await promise;
    return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]), text };
  } finally {
    socket.end();
  }
}

describe("BunWebSocket: removeRouteHandler", () => {
  it("stops upgrading a removed route: a 404, or the next route on the path", async () => {
    const adapter = new BunHttpAdapter(0, {
      logger: createTestLogger().logger,
    });
    adapter.ws("/live", { message: () => {} });
    adapter.ws("/feed", { message: () => {} });
    // A plain route on the same path, registered after the upgrade route.
    adapter.get("/feed", (_req, res) => {
      res.send("plain feed");
    });
    try {
      const server = await adapter.listen(0);
      const port = Number(server.port);
      expect((await rawUpgrade(port, "/live")).status).toBe(101);
      expect((await rawUpgrade(port, "/feed")).status).toBe(101);

      const ws = adapter.webSocketAdapter;
      expect(ws.removeRouteHandler("/live")).toBe(true);
      expect(ws.removeRouteHandler("/feed")).toBe(true);

      expect((await rawUpgrade(port, "/live")).status).toBe(404);
      // The upgrade layer stands aside, so the GET route answers instead.
      const feed = await rawUpgrade(port, "/feed");
      expect(feed.status).toBe(200);
      expect(feed.text).toContain("plain feed");
      // and a plain request to the path is untouched.
      const plain = await fetch(`http://127.0.0.1:${port}/feed`);
      expect(await plain.text()).toBe("plain feed");
    } finally {
      await adapter.close();
    }
  });

  it("keeps a route upgrading until its last handler is removed", async () => {
    const ws = new BunWebSocket({
      newInstance: true,
      router: new BunRouter(),
      listen: { port: 0 },
    });
    const calls: string[] = [];
    const first: BunWebSocketHandlerType = {
      open: () => {
        calls.push("first open");
      },
      message: () => {},
    };
    const second: BunWebSocketHandlerType = {
      open: () => {
        calls.push("second open");
      },
      message: () => {},
    };
    await ws.setRouteHandler("/duo", first, undefined);
    await ws.setRouteHandler("/duo", second, undefined);
    try {
      const port = Number(ws.port);
      expect(ws.removeRouteHandler("/duo", first)).toBe(true);
      // Already gone, a handler never registered, a path never registered.
      expect(ws.removeRouteHandler("/duo", first)).toBe(false);
      expect(ws.removeRouteHandler("/duo", { message: () => {} })).toBe(false);
      expect(ws.removeRouteHandler("/nowhere")).toBe(false);
      expect(ws.removeRouteHandler("/nowhere", second)).toBe(false);

      const { client } = await openClient(`ws://127.0.0.1:${port}/duo`);
      await until(() => calls.length > 0);
      client.close();
      expect(calls).toEqual(["second open"]);

      expect(ws.removeRouteHandler("/duo", second)).toBe(true);
      expect((await rawUpgrade(port, "/duo")).status).toBe(404);
      expect(ws.removeRouteHandler("/duo")).toBe(false);
    } finally {
      ws.killServer(ws.getServer());
    }
  });

  it("upgrades again once re-registered, on the one upgrade route, with the new options", async () => {
    const router = new BunRouter();
    const ws = new BunWebSocket({
      newInstance: true,
      router,
      listen: { port: 0 },
    });
    const calls: string[] = [];
    const customs: unknown[] = [];
    const handler: BunWebSocketHandlerType = {
      open: (socket) => {
        calls.push("open");
        customs.push(socket.data.custom);
      },
      message: (socket, message) => {
        calls.push(`message ${String(message)}`);
        socket.send("ack");
      },
      close: () => {
        calls.push("close");
      },
    };
    const layerCount = () =>
      router.getMatchedLayers({
        requestHost: "localhost",
        requestMethod: "GET",
        requestUrl: "/again",
      }).length;

    await ws.setRouteHandler("/again", handler, {
      onUpgrade: () => ({ custom: "before" }),
    });
    const layers = layerCount();
    try {
      const port = Number(ws.port);
      expect(ws.removeRouteHandler("/again", handler)).toBe(true);
      expect((await rawUpgrade(port, "/again")).status).toBe(404);

      await ws.setRouteHandler("/again", handler, {
        onUpgrade: () => ({ custom: "after" }),
      });
      // The route is revived, not stacked.
      expect(layerCount()).toBe(layers);

      const { client, received } = await openClient(
        `ws://127.0.0.1:${port}/again`,
      );
      client.send("hi");
      await until(() => received.length > 0);
      client.close();
      await until(() => calls.includes("close"));

      // One invocation per event, and the re-registration's hook.
      expect(calls).toEqual(["open", "message hi", "close"]);
      expect(customs).toEqual(["after"]);
    } finally {
      ws.killServer(ws.getServer());
    }
  });

  it("keeps a live pattern's first options when another handler joins it", async () => {
    const router = new BunRouter();
    const ws = new BunWebSocket({
      newInstance: true,
      router,
      listen: { port: 0 },
    });
    const customs: unknown[] = [];
    const record: BunWebSocketHandlerType = {
      open: (socket) => {
        customs.push(socket.data.custom);
      },
      message: () => {},
    };
    await ws.setRouteHandler("/kept", record, {
      onUpgrade: () => ({ custom: "first" }),
    });
    await ws.setRouteHandler(
      "/kept",
      { message: () => {} },
      {
        onUpgrade: () => ({ custom: "second" }),
      },
    );
    try {
      const { client } = await openClient(`ws://127.0.0.1:${ws.port}/kept`);
      await until(() => customs.length > 0);
      client.close();
      expect(customs).toEqual(["first"]);
    } finally {
      ws.killServer(ws.getServer());
    }
  });

  it("leaves an open socket open: its events reach no removed handler, and nothing throws", async () => {
    const ws = new BunWebSocket({
      newInstance: true,
      router: new BunRouter(),
      listen: { port: 0 },
    });
    const handlerCalls: string[] = [];
    const emitted: string[] = [];
    ws.on("message", (socket, message) => {
      emitted.push(`message ${String(message)}`);
      socket.send(`instance:${String(message)}`);
    });
    ws.on("close", () => {
      emitted.push("close");
    });
    await ws.setRouteHandler(
      "/open",
      {
        message: (_socket, message) => {
          handlerCalls.push(`message ${String(message)}`);
        },
        close: () => {
          handlerCalls.push("close");
        },
      },
      undefined,
    );
    try {
      const { client, received } = await openClient(
        `ws://127.0.0.1:${ws.port}/open`,
      );
      client.send("one");
      await until(() => received.length === 1);

      expect(ws.removeRouteHandler("/open")).toBe(true);

      client.send("two");
      await until(() => received.length === 2);
      expect(client.readyState).toBe(WebSocket.OPEN);
      client.close();
      await until(() => emitted.includes("close"));

      expect(received).toEqual(["instance:one", "instance:two"]);
      expect(emitted).toEqual(["message one", "message two", "close"]);
      // Only the event before the removal reached the route's handler.
      expect(handlerCalls).toEqual(["message one"]);
    } finally {
      ws.killServer(ws.getServer());
    }
  });
});
