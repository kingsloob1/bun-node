/**
 * Middleware chains on `ws()` — `router.ws(path, …middleware, handler, options?)`.
 *
 * With middleware the route is a real GET endpoint on the router `ws()` was
 * called on (params bind), whose terminal act is the upgrade: the chain runs
 * ahead of the upgrade layer, for plain GETs to the path too. A refusing
 * middleware answers the request itself (a plain GET is a 401, not a 404); a
 * passing one hands on. `removeRouteHandler` stands both the socket route and
 * the chain aside, and a re-registration revives them with the new call's
 * middleware and options.
 */
import type { WebSocketClientData } from "../lib/BunWebSocket";
import type { BunRequest } from "../lib/BunRequest";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { BunWebSocket } from "../lib/BunWebSocket";
import { defineChannel } from "../lib/channel";
import { createTestLogger } from "../lib/logging";

/** An adapter with a logger that swallows the tests' expected warnings. */
function newAdapter() {
  return new BunHttpAdapter(0, { logger: createTestLogger().logger });
}

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

/**
 * Sends an upgrade request over a raw socket (a `101` included, which `fetch`
 * cannot see) and returns the answer's status code and head.
 */
async function rawUpgrade(
  port: number,
  path: string,
  headers: Record<string, string> = {},
) {
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
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n"),
  );
  try {
    const text = await promise;
    return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]), text };
  } finally {
    socket.end();
  }
}

describe("ws() middleware chains", () => {
  it("runs the chain in order before the upgrade, with req.params bound", async () => {
    const adapter = newAdapter();
    const calls: string[] = [];
    const seenParams: unknown[] = [];
    adapter.ws(
      "/rooms/:room",
      (req, _res, next) => {
        calls.push("first");
        seenParams.push({ ...req.params });
        next();
      },
      (_req, _res, next) => {
        calls.push("second");
        next();
      },
      {
        open(ws) {
          calls.push(
            `open:${String((ws.data as WebSocketClientData).params?.room)}`,
          );
          ws.send("in");
        },
        message() {},
      },
    );

    const server = await adapter.listen(0);
    try {
      const port = Number(server.port);
      const { client, received } = await openClient(
        `ws://127.0.0.1:${port}/rooms/42`,
      );
      await until(() => received.length > 0);
      client.close();

      // The middleware ran ahead of the socket's `open`, params bound — the
      // whole point over a `use()` middleware, whose are never bound.
      expect(calls).toEqual(["first", "second", "open:42"]);
      expect(seenParams).toEqual([{ room: "42" }]);
      expect(received).toEqual(["in"]);
    } finally {
      await adapter.close();
    }
  });

  it("a middleware refusing the upgrade answers instead — the plain GET too, and no socket opens", async () => {
    const adapter = newAdapter();
    const opened: string[] = [];
    adapter.ws(
      "/private",
      (req, res, next) => {
        if (req.headersObj.get("authorization") === "Bearer ok") {
          next();
          return;
        }
        res.status(401).send("who are you");
      },
      {
        open() {
          opened.push("open");
        },
        message() {},
      },
    );

    const server = await adapter.listen(0);
    try {
      const port = Number(server.port);
      // The upgrade is refused by the middleware, before any 101.
      const refused = await rawUpgrade(port, "/private");
      expect(refused.status).toBe(401);
      expect(refused.text).toContain("who are you");
      // Full GET semantics: a plain GET meets the same middleware — a 401,
      // not the 404 an untouched fall-through would give.
      const plain = await fetch(`http://127.0.0.1:${port}/private`);
      expect(plain.status).toBe(401);

      // An authorized upgrade passes the chain and upgrades.
      expect(
        (await rawUpgrade(port, "/private", { authorization: "Bearer ok" }))
          .status,
      ).toBe(101);
      await until(() => opened.length > 0);
      expect(opened).toEqual(["open"]);
    } finally {
      await adapter.close();
    }
  });

  it("a passed-through plain GET falls to the next matching route, or a 404", async () => {
    const adapter = newAdapter();
    const calls: string[] = [];
    adapter.ws(
      "/pipe",
      (_req, _res, next) => {
        calls.push("pipe");
        next();
      },
      { message() {} },
    );
    // A plain route on the same path, registered after the ws route.
    adapter.get("/pipe", (_req, res) => {
      res.send("plain pipe");
    });
    adapter.ws(
      "/bare",
      (_req, _res, next) => {
        calls.push("bare");
        next();
      },
      { message() {} },
    );

    const server = await adapter.listen(0);
    try {
      const port = Number(server.port);
      const piped = await fetch(`http://127.0.0.1:${port}/pipe`);
      expect(piped.status).toBe(200);
      expect(await piped.text()).toBe("plain pipe");

      const bare = await fetch(`http://127.0.0.1:${port}/bare`);
      expect(bare.status).toBe(404);

      expect(calls).toEqual(["pipe", "bare"]);
    } finally {
      await adapter.close();
    }
  });

  it("a middleware can answer the plain GET and hand the upgrade on", async () => {
    const adapter = newAdapter();
    adapter.ws(
      "/dual",
      (req, res, next) => {
        if (req.headersObj.get("upgrade")?.toLowerCase() === "websocket") {
          next();
          return;
        }
        res.status(200).send("web page");
      },
      {
        open(ws) {
          ws.send("socket");
        },
        message() {},
      },
    );

    const server = await adapter.listen(0);
    try {
      const port = Number(server.port);
      const plain = await fetch(`http://127.0.0.1:${port}/dual`);
      expect(plain.status).toBe(200);
      expect(await plain.text()).toBe("web page");

      const { client, received } = await openClient(
        `ws://127.0.0.1:${port}/dual`,
      );
      await until(() => received.length > 0);
      client.close();
      expect(received).toEqual(["socket"]);
    } finally {
      await adapter.close();
    }
  });

  it("a trailing function after the handler is still the deprecated custom mapping, not middleware", async () => {
    const adapter = newAdapter();
    const calls: string[] = [];
    const customs: unknown[] = [];
    adapter.ws(
      "/legacy",
      (_req, _res, next) => {
        calls.push("middleware");
        next();
      },
      {
        open(ws) {
          customs.push(ws.data.custom);
          ws.send("ok");
        },
        message() {},
      },
      (req: BunRequest) => {
        calls.push("mapping");
        return { path: req.path };
      },
    );

    const server = await adapter.listen(0);
    try {
      const port = Number(server.port);
      const { client, received } = await openClient(
        `ws://127.0.0.1:${port}/legacy`,
      );
      await until(() => received.length > 0);
      client.close();

      // The mapping produced `custom` at the upgrade — once, after the
      // middleware; were it in the chain the request would have parked.
      expect(received).toEqual(["ok"]);
      expect(customs).toEqual([{ path: "/legacy" }]);
      expect(calls).toEqual(["middleware", "mapping"]);
    } finally {
      await adapter.close();
    }
  });

  it("removal stands aside both the socket and the middleware route", async () => {
    const adapter = newAdapter();
    const calls: string[] = [];
    adapter.ws(
      "/gone",
      (_req, _res, next) => {
        calls.push("middleware");
        next();
      },
      { message() {} },
    );

    const server = await adapter.listen(0);
    try {
      const port = Number(server.port);
      expect((await rawUpgrade(port, "/gone")).status).toBe(101);
      expect(calls).toEqual(["middleware"]);

      // While live, a plain GET runs the middleware and falls through to a 404.
      const live = await fetch(`http://127.0.0.1:${port}/gone`);
      expect(live.status).toBe(404);
      expect(calls).toEqual(["middleware", "middleware"]);

      expect(adapter.webSocketAdapter.removeRouteHandler("/gone")).toBe(true);
      const callsWhenRemoved = calls.length;

      // The upgrade is refused…
      expect((await rawUpgrade(port, "/gone")).status).toBe(404);
      // …and no middleware is left answering plain GETs.
      const gone = await fetch(`http://127.0.0.1:${port}/gone`);
      expect(gone.status).toBe(404);
      expect(calls.length).toBe(callsWhenRemoved);
    } finally {
      await adapter.close();
    }
  });

  it("re-registration revives with the new call's middleware, on the one chain route", async () => {
    const adapter = newAdapter();
    const calls: string[] = [];
    adapter.ws(
      "/again",
      (_req, _res, next) => {
        calls.push("old");
        next();
      },
      { message() {} },
    );
    const layerCount = () =>
      adapter.getMatchedLayers({
        requestHost: "localhost",
        requestMethod: "GET",
        requestUrl: "/again",
      }).length;
    const layers = layerCount();

    const server = await adapter.listen(0);
    try {
      const port = Number(server.port);
      expect(adapter.webSocketAdapter.removeRouteHandler("/again")).toBe(true);
      expect((await rawUpgrade(port, "/again")).status).toBe(404);

      adapter.ws(
        "/again",
        (_req, _res, next) => {
          calls.push("new");
          next();
        },
        {
          open(ws) {
            ws.send("back");
          },
          message() {},
        },
      );
      // The chain route is revived, not stacked (and so is the upgrade route).
      expect(layerCount()).toBe(layers);

      const { client, received } = await openClient(
        `ws://127.0.0.1:${port}/again`,
      );
      await until(() => received.length > 0);
      client.close();

      // Only the new middleware ran: the chain was replaced, not appended.
      expect(calls).toEqual(["new"]);
      expect(received).toEqual(["back"]);
    } finally {
      await adapter.close();
    }
  });

  it("a live pattern keeps its first middleware when another handler joins", async () => {
    const adapter = newAdapter();
    const calls: string[] = [];
    adapter.ws(
      "/kept",
      (_req, _res, next) => {
        calls.push("first");
        next();
      },
      { message() {} },
    );
    adapter.ws(
      "/kept",
      (_req, _res, next) => {
        calls.push("second");
        next();
      },
      { message() {} },
    );

    const server = await adapter.listen(0);
    try {
      const port = Number(server.port);
      expect((await rawUpgrade(port, "/kept")).status).toBe(101);
      // As the upgrade route keeps its first options, the chain keeps its
      // first middleware.
      expect(calls).toEqual(["first"]);
    } finally {
      await adapter.close();
    }
  });

  it("rejects arguments that fit none of the chain's positions", () => {
    const adapter = newAdapter();
    const handler = { message() {} };
    // Untyped, as a caller from plain JavaScript would be.
    const ws = adapter.ws.bind(adapter) as (...args: unknown[]) => unknown;
    // No handler at all.
    expect(() => ws("/x")).toThrow('ws("/x"): the handler must be an object.');
    // Neither a function nor an object before the handler.
    expect(() => ws("/x", 42)).toThrow(TypeError);
    // A second trailing argument.
    expect(() => ws("/x", handler, {}, {})).toThrow(TypeError);
    expect(() => ws("/x", handler, () => 1, {})).toThrow(TypeError);
  });
});

describe("ws() middleware chains on a bare router", () => {
  it("runs the chain for a plain GET, params bound, and stands it aside after removal", async () => {
    const router = new BunRouter();
    const socket = new BunWebSocket({
      newInstance: false,
      router,
      getServer: () => undefined,
    });
    const calls: string[] = [];
    router.ws(
      "/socket/:id",
      (req, _res, next) => {
        calls.push(String(req.params.id));
        next();
      },
      { message() {} },
    );

    // Socket-free: no upgrade can succeed, but the chain is a GET route — the
    // middleware runs (params bound) and the request falls through to a 404.
    let response = await router.fetch("/socket/7");
    expect(response.status).toBe(404);
    expect(calls).toEqual(["7"]);

    expect(socket.hasRouteHandler("/socket/:id")).toBe(true);
    expect(socket.removeRouteHandler("/socket/:id")).toBe(true);
    expect(socket.hasRouteHandler("/socket/:id")).toBe(false);

    response = await router.fetch("/socket/7");
    expect(response.status).toBe(404);
    // The guard stood the chain aside: the middleware did not run again.
    expect(calls).toEqual(["7"]);
  });
});

describe("defineChannel: the one-call ws() form", () => {
  it("checks, handler and options in one call — a plain GET falls through to a 404", async () => {
    const chat = defineChannel({
      path: "/rooms/:room",
      request: {
        params: z.object({ room: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
      },
      receives: { say: z.object({ text: z.string() }) },
      sends: { said: z.object({ by: z.string(), text: z.string() }) },
    });
    const adapter = newAdapter();
    adapter.ws(
      chat.path,
      chat.checks(),
      chat.handler({
        say(ws, msg) {
          chat.send(ws, "said", { by: "test", text: msg.text });
        },
      }),
      chat.options(),
    );

    const server = await adapter.listen(0);
    try {
      const port = Number(server.port);
      // A good frame flows end to end.
      const { client, received } = await openClient(
        `ws://127.0.0.1:${port}/rooms/lobby`,
      );
      client.send(JSON.stringify({ type: "say", data: { text: "hi" } }));
      await until(() => received.length > 0);
      client.close();
      expect(JSON.parse(received[0] ?? "")).toEqual({
        type: "said",
        data: { by: "test", text: "hi" },
      });

      // A bad upgrade is refused by the checks before any 101.
      expect((await rawUpgrade(port, "/rooms/Bad-Room")).status).toBe(400);

      // A plain GET runs the checks, which pass it through (they only check
      // upgrade-shaped requests), then the terminal next(), then a 404 — even
      // one the checks would refuse as an upgrade.
      expect((await fetch(`http://127.0.0.1:${port}/rooms/lobby`)).status).toBe(
        404,
      );
      expect(
        (await fetch(`http://127.0.0.1:${port}/rooms/Bad-Room`)).status,
      ).toBe(404);
    } finally {
      await adapter.close();
    }
  });
});
