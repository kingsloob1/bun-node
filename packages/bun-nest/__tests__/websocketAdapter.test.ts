import type {
  BunWebSocketServerType,
  WebSocketClient,
} from "@kingsleyweb/bun-common";
import type { WsMessageHandler } from "@nestjs/common";
import type {
  BunNestWebSocketClient,
  BunWebSocketAdapterOptions,
} from "../lib/BunWebSocketAdapter";
import { Buffer } from "node:buffer";
import { BunRouter, getPort } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { from, isObservable, mergeAll, of } from "rxjs";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  BunNestWebsocketAdapter,
  BunWebSocketAdapter,
  MessageEventTypes,
} from "../lib/BunWebSocketAdapter";

/** Adapters listening during a test, closed after it. */
const listening: BunHttpAdapter[] = [];

afterEach(async () => {
  while (listening.length) {
    await listening.pop()?.close();
  }
});

describe("BunWebSocketAdapter: server options", () => {
  it("rides on the server `{ newInstance: false, getServer }` returns", async () => {
    const http = new BunHttpAdapter();
    listening.push(http);
    await http.listen(0);

    const adapter = new BunWebSocketAdapter({
      newInstance: false,
      getServer: () => http.getBunServer(),
      router: new BunRouter(),
    });

    expect(adapter.getServer()).toBe(http.getBunServer());
  });

  it("throws for options that name no server, rather than binding a default port", () => {
    expect(
      () =>
        new BunWebSocketAdapter({
          router: new BunRouter(),
        } as unknown as BunWebSocketAdapterOptions),
    ).toThrow(/needs a server/);
  });

  it("applies BunHttpAdapter's `websocket.getServer`", async () => {
    const elsewhere = new BunHttpAdapter();
    listening.push(elsewhere);
    await elsewhere.listen(0);

    const http = new BunHttpAdapter(0, {
      websocket: {
        newInstance: false,
        getServer: () => elsewhere.getBunServer(),
      },
    });

    expect(http.webSocketAdapter.getServer()).toBe(elsewhere.getBunServer());
  });

  it("applies BunHttpAdapter's `websocket.newInstance` + `listen`", async () => {
    const http = new BunHttpAdapter(0, {
      websocket: { newInstance: true, listen: { port: 0 } },
    });
    const server = http.webSocketAdapter.getServer();

    expect(Number(server?.port)).toBeGreaterThan(0);
    expect(http.webSocketAdapter.router).toBe(http.instance);
    http.webSocketAdapter.close(server);
  });
});

describe("BunWebSocketAdapter: per-gateway routes and close()", () => {
  const client = (path: string) =>
    ({ data: { path }, send() {} }) as unknown as WebSocketClient;

  it("binds a gateway NestJS skipped create() for to its server's route", () => {
    const adapter = new BunNestWebsocketAdapter({
      httpAdapter: new BunHttpAdapter(),
    });
    const seen: string[] = [];

    // NestJS's sequence: a server-creating create(), then create() with the
    // namespace, then bindClientConnect — and for a later default gateway on
    // the same server, bindClientConnect alone.
    const server = adapter.create(0, { transport: [] });
    adapter.create(0, { namespace: "/rooms", server, transport: [] });
    adapter.bindClientConnect(server, () => seen.push("rooms"));
    adapter.bindClientConnect(server, () => seen.push("default"));

    adapter.emit("connect", client("/"));
    adapter.emit("connect", client("/rooms"));

    expect(seen).toEqual(["default", "rooms"]);
  });

  it("serves `path` + `namespace` as one URL path", () => {
    const adapter = new BunNestWebsocketAdapter({
      httpAdapter: new BunHttpAdapter(),
    });
    const seen: string[] = [];

    adapter.create(0, { path: "/ws", transport: [] });
    adapter.bindClientConnect(undefined, () => seen.push("ws"));
    adapter.create(0, { path: "ws/", namespace: "chat", transport: [] });
    adapter.bindClientConnect(undefined, () => seen.push("ws/chat"));

    adapter.emit("connect", client("/"));
    adapter.emit("connect", client("/ws"));
    adapter.emit("connect", client("/ws/chat"));

    expect(seen).toEqual(["ws", "ws/chat"]);
  });

  it("close(shared server) leaves the HTTP server running and detaches gateways", async () => {
    const http = new BunHttpAdapter();
    listening.push(http);
    await http.listen(0);
    const adapter = http.webSocketAdapter;

    let connections = 0;
    const server = adapter.create(0, { transport: [] });
    adapter.bindClientConnect(server, () => connections++);
    adapter.close(server as BunWebSocketServerType);
    adapter.emit("connect", client("/"));

    expect(connections).toBe(0);
    expect(http.getBunServer()).toBe(server);
    expect((await fetch(`${http.url}/missing`)).status).toBe(404);
  });

  it("keeps a gateway on an explicit port to that port's clients", async () => {
    const adapter = new BunNestWebsocketAdapter({
      httpAdapter: new BunHttpAdapter(),
    });
    const port = await getPort();
    const seen: string[] = [];

    const server = adapter.create(port, { transport: [] });
    adapter.bindClientConnect(server, () => seen.push("port"));
    const onPort = (clientPort?: number) =>
      ({
        data: { path: "/", port: clientPort },
        send() {},
      }) as unknown as WebSocketClient;

    try {
      adapter.emit("connect", onPort(port));
      adapter.emit("connect", onPort(port + 1));
      adapter.emit("connect", onPort(undefined));

      expect(seen).toEqual(["port"]);
    } finally {
      adapter.close(server);
    }
  });

  it("keeps a port-0 gateway to the shared server's clients, read at connection time", async () => {
    const http = new BunHttpAdapter();
    const adapter = http.webSocketAdapter;
    const seen: (number | undefined)[] = [];

    // Created before the HTTP server listens, as NestJS does.
    const server = adapter.create(0, { transport: [] });
    adapter.bindClientConnect(server, (c) => seen.push(c.data.port));

    listening.push(http);
    await http.listen(0);
    const shared = Number(http.getBunServer()?.port);
    const at = (clientPort?: number) =>
      ({
        data: { path: "/", port: clientPort },
        send() {},
      }) as unknown as WebSocketClient;

    adapter.emit("connect", at(shared));
    adapter.emit("connect", at(shared + 1));
    adapter.emit("connect", at(undefined));

    expect(seen).toEqual([shared, undefined]);
  });

  it("binds a gateway NestJS skipped create() for to its server's port", async () => {
    const adapter = new BunNestWebsocketAdapter({
      httpAdapter: new BunHttpAdapter(),
    });
    const port = await getPort();
    const seen: string[] = [];

    const server = adapter.create(port, { transport: [] });
    adapter.bindClientConnect(server, () => seen.push("first"));
    adapter.bindClientConnect(server, () => seen.push("reused"));

    try {
      adapter.emit("connect", {
        data: { path: "/", port: port + 1 },
        send() {},
      } as unknown as WebSocketClient);
      adapter.emit("connect", {
        data: { path: "/", port },
        send() {},
      } as unknown as WebSocketClient);

      expect(seen).toEqual(["first", "reused"]);
    } finally {
      adapter.close(server);
    }
  });

  it("close() stops a dedicated gateway-port server", async () => {
    const http = new BunHttpAdapter();
    const adapter = http.webSocketAdapter;
    const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = Number(probe.port);
    await probe.stop(true);

    const server = adapter.create(port, { transport: [] });
    expect(Number(server?.port)).toBe(port);
    adapter.close(server);

    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});

/** A fake client that records everything sent to it. */
function makeFakeClient() {
  const sent: string[] = [];
  const client = {
    send(message: string) {
      sent.push(message);
    },
  } as unknown as WebSocketClient;
  return { client, sent, parsed: () => sent.map((m) => JSON.parse(m)) };
}

/** rxjs-style transform NestJS supplies to `bindMessageHandlers`. */
const transform = (result: unknown) => of(result);

/**
 * The transform exactly as `WebSocketsController.subscribeMessages` builds it:
 * `from(pickResult(result)).pipe(mergeAll())`, so an Observable (or a Promise
 * of one) is flattened into its emissions.
 */
const nestTransform = (result: unknown) =>
  from(
    Promise.resolve(result).then((value) =>
      isObservable(value) ? value : of(value),
    ),
  ).pipe(mergeAll());

/**
 * Builds a {@link WsMessageHandler} from a loosely-typed test callback. NestJS
 * types `callback` as returning `Observable | Promise`, but the adapter
 * tolerates any return (it normalises via `transform`), so we cast here.
 * `isAckHandledManually` is what NestJS sets for a handler declaring `@Ack()`
 * — pass `true` for any callback that calls its ack argument.
 */
function wsHandler(
  message: string,
  callback: (...args: any[]) => unknown,
  isAckHandledManually = false,
): WsMessageHandler<string> {
  return {
    message,
    callback: callback as WsMessageHandler<string>["callback"],
    isAckHandledManually,
  };
}

describe("BunWebSocketAdapter: construction", () => {
  it("builds from an http adapter", () => {
    const httpAdapter = new BunHttpAdapter(10000);
    const adapter = new BunNestWebsocketAdapter({ httpAdapter });
    expect(adapter).toBeInstanceOf(BunNestWebsocketAdapter);
    expect(adapter).toBeInstanceOf(BunWebSocketAdapter);
  });

  it("exposes a websocket handler with lifecycle hooks", () => {
    const httpAdapter = new BunHttpAdapter(10000);
    const adapter = new BunNestWebsocketAdapter({ httpAdapter });
    expect(typeof adapter.wsHandler.message).toBe("function");
    expect(typeof adapter.wsHandler.open).toBe("function");
  });
});

describe("MessageEventTypes", () => {
  it("matches the socket.io packet type ordinals", () => {
    expect(MessageEventTypes.CONNECT).toBe(0);
    expect(MessageEventTypes.DISCONNECT).toBe(1);
    expect(MessageEventTypes.EVENT).toBe(2);
    expect(MessageEventTypes.ACK).toBe(3);
    expect(MessageEventTypes.ERROR).toBe(4);
    expect(MessageEventTypes.BINARY_EVENT).toBe(5);
    expect(MessageEventTypes.BINARY_ACK).toBe(6);
  });
});

describe("BunWebSocketAdapter: client binding", () => {
  it("invokes the connect callback when a client connects", () => {
    const httpAdapter = new BunHttpAdapter(10000);
    const adapter = new BunNestWebsocketAdapter({ httpAdapter });

    let connected = false;
    adapter.bindClientConnect(undefined, () => {
      connected = true;
    });
    adapter.emit("connect", {} as never);
    expect(connected).toBe(true);
  });

  it("invokes the disconnect callback when a client disconnects", () => {
    const httpAdapter = new BunHttpAdapter(10000);
    const adapter = new BunNestWebsocketAdapter({ httpAdapter });

    let disconnected = false;
    // The hook is scoped to this exact client, so emit the disconnect for the
    // same object (NestJS binds the disconnect hook per connection).
    const client = {} as never;
    adapter.bindClientDisconnect(client, () => {
      disconnected = true;
    });
    adapter.emit("disconnect", client, 1000 as never, "bye" as never);
    expect(disconnected).toBe(true);
  });
});

describe("BunWebSocketAdapter: bindMessageHandlers", () => {
  const newAdapter = () =>
    new BunNestWebsocketAdapter({ httpAdapter: new BunHttpAdapter(10000) });

  const emitMessage = (
    adapter: BunNestWebsocketAdapter,
    client: WebSocketClient,
    packet: unknown,
  ) => adapter.emit("message", client, JSON.stringify(packet) as never);

  it("dispatches an EVENT packet to the matching handler with its payload", () => {
    const adapter = newAdapter();
    const { client } = makeFakeClient();

    const received: unknown[] = [];
    const handlers: WsMessageHandler<string>[] = [
      wsHandler("chat", (data) => received.push(data)),
      wsHandler("other", () => received.push("WRONG")),
    ];
    adapter.bindMessageHandlers(client, handlers, transform);

    emitMessage(adapter, client, {
      type: MessageEventTypes.EVENT,
      namespace: "/",
      data: ["chat", { text: "hi" }],
    });

    expect(received).toEqual([{ text: "hi" }]);
  });

  it("sends a handler's WsResponse back to the client as an EVENT packet", () => {
    const adapter = newAdapter();
    const { client, parsed } = makeFakeClient();

    adapter.bindMessageHandlers(
      client,
      [wsHandler("ping", () => ({ event: "pong", data: 42 }))],
      transform,
    );

    emitMessage(adapter, client, {
      type: MessageEventTypes.EVENT,
      namespace: "/ns",
      data: ["ping", null],
    });

    expect(parsed()).toEqual([
      {
        type: MessageEventTypes.EVENT,
        namespace: "/ns",
        data: ["pong", 42],
      },
    ]);
  });

  it("does not send anything when a handler returns nothing", () => {
    const adapter = newAdapter();
    const { client, sent } = makeFakeClient();

    adapter.bindMessageHandlers(
      client,
      [wsHandler("fire", () => undefined)],
      transform,
    );

    emitMessage(adapter, client, {
      type: MessageEventTypes.EVENT,
      namespace: "/",
      data: ["fire", "x"],
    });

    expect(sent).toEqual([]);
  });

  it("routes a CONNECT packet to a 'connect' handler", () => {
    const adapter = newAdapter();
    const { client } = makeFakeClient();

    let connected = false;
    adapter.bindMessageHandlers(
      client,
      [wsHandler("connect", () => (connected = true))],
      transform,
    );

    emitMessage(adapter, client, {
      type: MessageEventTypes.CONNECT,
      namespace: "/",
    });

    expect(connected).toBe(true);
  });

  it("routes a DISCONNECT packet to a 'disconnect' handler", () => {
    const adapter = newAdapter();
    const { client } = makeFakeClient();

    let left = false;
    adapter.bindMessageHandlers(
      client,
      [wsHandler("disconnect", () => (left = true))],
      transform,
    );

    emitMessage(adapter, client, {
      type: MessageEventTypes.DISCONNECT,
      namespace: "/",
    });

    expect(left).toBe(true);
  });

  it("routes an ERROR packet to an 'error' handler with the error payload", () => {
    const adapter = newAdapter();
    const { client } = makeFakeClient();

    const errors: unknown[] = [];
    adapter.bindMessageHandlers(
      client,
      [wsHandler("error", (data) => errors.push(data))],
      transform,
    );

    emitMessage(adapter, client, {
      type: MessageEventTypes.ERROR,
      namespace: "/",
      data: "boom",
    });

    expect(errors).toEqual(["boom"]);
  });

  it("echoes an ACK packet back to the client", () => {
    const adapter = newAdapter();
    const { client, parsed } = makeFakeClient();

    adapter.bindMessageHandlers(client, [], transform);

    emitMessage(adapter, client, {
      type: MessageEventTypes.ACK,
      id: 7,
      namespace: "/",
      data: ["evt"],
    });

    expect(parsed()).toEqual([
      {
        type: MessageEventTypes.ACK,
        id: 7,
        namespace: "/",
        data: ["evt"],
      },
    ]);
  });

  it("emits an ERROR packet and notifies the error handler on a malformed packet", () => {
    const adapter = newAdapter();
    const { client, parsed } = makeFakeClient();

    let errorHandled = false;
    adapter.bindMessageHandlers(
      client,
      [wsHandler("error", () => (errorHandled = true))],
      transform,
    );

    adapter.emit("message", client, "not-json" as never);

    expect(errorHandled).toBe(true);
    expect(parsed()[0]?.type).toBe(MessageEventTypes.ERROR);
  });

  it("resolves a handler that returns a Promise without a transform", async () => {
    const adapter = newAdapter();
    const { client, parsed } = makeFakeClient();

    adapter.bindMessageHandlers(client, [
      {
        message: "ask",
        callback: async () => ({ event: "answer", data: "later" }),
        isAckHandledManually: false,
      },
    ]);

    emitMessage(adapter, client, {
      type: MessageEventTypes.EVENT,
      namespace: "/",
      data: ["ask", null],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(parsed()).toEqual([
      {
        type: MessageEventTypes.EVENT,
        namespace: "/",
        data: ["answer", "later"],
      },
    ]);
  });

  it("decodes a BINARY_EVENT payload to the exact bytes", () => {
    const adapter = newAdapter();
    const { client } = makeFakeClient();

    const received: unknown[] = [];
    adapter.bindMessageHandlers(
      client,
      [wsHandler("bytes", (data) => received.push(data))],
      transform,
    );

    emitMessage(adapter, client, {
      type: MessageEventTypes.BINARY_EVENT,
      namespace: "/",
      data: ["bytes", Buffer.from([0xff, 0x00, 0xe9]).toString("base64")],
    });

    expect(Buffer.isBuffer(received[0])).toBe(true);
    expect([...(received[0] as Buffer)]).toEqual([0xff, 0x00, 0xe9]);
  });

  it("acks with BINARY_ACK when an ack argument is binary, ACK otherwise", () => {
    const adapter = newAdapter();
    const { client, parsed } = makeFakeClient();

    adapter.bindMessageHandlers(
      client,
      [
        wsHandler("bin", (data, ack) => ack(data), true),
        wsHandler("num", (data: Buffer, ack) => ack(data.length), true),
      ],
      transform,
    );

    const payload = Buffer.from("hey").toString("base64");
    emitMessage(adapter, client, {
      type: MessageEventTypes.BINARY_EVENT,
      namespace: "/",
      id: 1,
      data: ["bin", payload],
    });
    emitMessage(adapter, client, {
      type: MessageEventTypes.BINARY_EVENT,
      namespace: "/",
      id: 2,
      data: ["num", payload],
    });

    expect(parsed()).toEqual([
      {
        type: MessageEventTypes.BINARY_ACK,
        id: 1,
        namespace: "/",
        data: [payload],
        binary: [0],
      },
      { type: MessageEventTypes.ACK, id: 2, namespace: "/", data: [3] },
    ]);
  });

  it("sends a WsResponse with binary data as a BINARY_EVENT", () => {
    const adapter = newAdapter();
    const { client, parsed } = makeFakeClient();

    adapter.bindMessageHandlers(
      client,
      [
        wsHandler("get", () => ({
          event: "file",
          data: new Uint8Array([1, 2, 255]),
        })),
      ],
      transform,
    );

    emitMessage(adapter, client, {
      type: MessageEventTypes.EVENT,
      namespace: "/",
      data: ["get", null],
    });

    expect(parsed()).toEqual([
      {
        type: MessageEventTypes.BINARY_EVENT,
        namespace: "/",
        data: ["file", Buffer.from([1, 2, 255]).toString("base64")],
        binary: [0],
      },
    ]);
  });

  it("decodes every argument a BINARY_EVENT marks binary, and only those", () => {
    const adapter = newAdapter();
    const { client } = makeFakeClient();

    const received: unknown[] = [];
    adapter.bindMessageHandlers(
      client,
      [wsHandler("files", (data) => received.push(data))],
      transform,
    );

    const first = Buffer.from([1, 2, 3]);
    const second = Buffer.from([250, 251]);
    emitMessage(adapter, client, {
      type: MessageEventTypes.BINARY_EVENT,
      namespace: "/",
      // "bm90ZQ==" is valid base64 too: unmarked, it must stay a string.
      data: [
        "files",
        first.toString("base64"),
        "bm90ZQ==",
        second.toString("base64"),
      ],
      binary: [0, 2],
    });

    expect(received).toHaveLength(1);
    const [a, name, b] = received[0] as [Buffer, string, Buffer];
    expect(Buffer.isBuffer(a) && [...a]).toEqual([1, 2, 3]);
    expect(name).toBe("bm90ZQ==");
    expect(Buffer.isBuffer(b) && [...b]).toEqual([250, 251]);
  });

  it("decodes every string argument of a BINARY_EVENT sent without `binary`", () => {
    const adapter = newAdapter();
    const { client } = makeFakeClient();

    const received: unknown[] = [];
    adapter.bindMessageHandlers(
      client,
      [wsHandler("pair", (data) => received.push(data))],
      transform,
    );

    emitMessage(adapter, client, {
      type: MessageEventTypes.BINARY_EVENT,
      namespace: "/",
      data: [
        "pair",
        Buffer.from("ab").toString("base64"),
        7,
        Buffer.from("c").toString("base64"),
      ],
    });

    const [a, seven, c] = received[0] as [Buffer, number, Buffer];
    expect(a.toString()).toBe("ab");
    expect(seven).toBe(7);
    expect(c.toString()).toBe("c");
  });

  it("hands a BINARY_EVENT with no arguments an undefined payload", () => {
    const adapter = newAdapter();
    const { client } = makeFakeClient();

    const received: unknown[] = [];
    adapter.bindMessageHandlers(
      client,
      [wsHandler("nothing", (data) => received.push(data))],
      transform,
    );

    emitMessage(adapter, client, {
      type: MessageEventTypes.BINARY_EVENT,
      namespace: "/",
      data: ["nothing"],
    });

    expect(received).toEqual([undefined]);
  });

  it("hands an EVENT with several arguments all of them, as socket.io", () => {
    const adapter = newAdapter();
    const { client } = makeFakeClient();

    const received: unknown[] = [];
    adapter.bindMessageHandlers(
      client,
      [wsHandler("move", (data) => received.push(data))],
      transform,
    );

    emitMessage(adapter, client, {
      type: MessageEventTypes.EVENT,
      namespace: "/",
      data: ["move", 3, 4],
    });

    expect(received).toEqual([[3, 4]]);
  });

  it("marks the binary positions of an emit with mixed arguments", () => {
    const adapter = newAdapter();
    const { client, parsed } = makeFakeClient();
    adapter.bindMessageHandlers(client, [], transform);

    (client as BunNestWebSocketClient).emit("file", "a.txt", Buffer.from([9]));

    expect(parsed()).toEqual([
      {
        type: MessageEventTypes.BINARY_EVENT,
        namespace: "/",
        data: ["file", "a.txt", Buffer.from([9]).toString("base64")],
        binary: [1],
      },
    ]);
  });

  it("installs client.emit, which sends an EVENT packet", () => {
    const adapter = newAdapter();
    const { client, parsed } = makeFakeClient();
    (client as { data?: unknown }).data = { path: "/room" };

    adapter.bindMessageHandlers(client, [], transform);
    (client as BunNestWebSocketClient).emit("exception", { message: "no" });

    expect(parsed()).toEqual([
      {
        type: MessageEventTypes.EVENT,
        namespace: "/room",
        data: ["exception", { message: "no" }],
      },
    ]);
  });

  it("stops dispatching messages after the client disconnects", () => {
    const adapter = newAdapter();
    const { client } = makeFakeClient();

    let calls = 0;
    adapter.bindMessageHandlers(
      client,
      [wsHandler("tick", () => (calls += 1))],
      transform,
    );

    const packet = {
      type: MessageEventTypes.EVENT,
      namespace: "/",
      data: ["tick", null],
    };
    emitMessage(adapter, client, packet);
    expect(calls).toBe(1);

    adapter.emit("disconnect", client, 1000 as never, "bye" as never);
    emitMessage(adapter, client, packet);
    expect(calls).toBe(1);
  });
});

/**
 * `isAckHandledManually`, against `@nestjs/platform-socket.io`'s `IoAdapter`:
 * a non-nullish, non-`WsResponse` emission auto-acks only when the flag is
 * false and the packet asked for an ack; the ack sends at most once.
 */
describe("BunWebSocketAdapter: acks and isAckHandledManually", () => {
  const newAdapter = () =>
    new BunNestWebsocketAdapter({ httpAdapter: new BunHttpAdapter(10000) });

  /** Binds `handlers` with `transform`, sends `packet`, lets async results settle. */
  async function run(
    handlers: WsMessageHandler<string>[],
    packet: Record<string, unknown>,
    useTransform: ((result: unknown) => unknown) | null = nestTransform,
  ) {
    const adapter = newAdapter();
    const { client, parsed } = makeFakeClient();
    adapter.bindMessageHandlers(
      client,
      handlers,
      (useTransform ?? undefined) as Parameters<
        BunNestWebsocketAdapter["bindMessageHandlers"]
      >[2],
    );
    adapter.emit(
      "message",
      client,
      JSON.stringify({
        type: MessageEventTypes.EVENT,
        namespace: "/",
        ...packet,
      }) as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    return parsed();
  }

  const ackOf = (id: number, data: unknown[]) => ({
    type: MessageEventTypes.ACK,
    id,
    namespace: "/",
    data,
  });

  it("with @Ack() and a return value, sends only the manual ack", async () => {
    const frames = await run(
      [
        wsHandler(
          "save",
          (data, ack) => {
            ack("manual", data);
            return "returned";
          },
          true,
        ),
      ],
      { id: 1, data: ["save", "x"] },
    );
    expect(frames).toEqual([ackOf(1, ["manual", "x"])]);
  });

  it("with @Ack() and a Promise of a value, sends only the manual ack (with and without a transform)", async () => {
    const handler = wsHandler(
      "save",
      async (_data, ack) => {
        ack("manual");
        return "returned";
      },
      true,
    );
    const packet = { id: 2, data: ["save", null] };
    expect(await run([handler], packet)).toEqual([ackOf(2, ["manual"])]);
    expect(await run([handler], packet, null)).toEqual([ackOf(2, ["manual"])]);
  });

  it("with @Ack() and no return, sends the manual ack", async () => {
    const frames = await run(
      [wsHandler("save", (_data, ack) => void ack("only"), true)],
      { id: 3, data: ["save", null] },
    );
    expect(frames).toEqual([ackOf(3, ["only"])]);
  });

  it("with @Ack() never called, sends no ack, even with a return value", async () => {
    const frames = await run([wsHandler("save", () => "returned", true)], {
      id: 4,
      data: ["save", null],
    });
    expect(frames).toEqual([]);
  });

  it("sends the ack once when @Ack() is called twice, as socket.io", async () => {
    const frames = await run(
      [
        wsHandler(
          "save",
          (_data, ack) => {
            ack("first");
            ack("second");
          },
          true,
        ),
      ],
      { id: 5, data: ["save", null] },
    );
    expect(frames).toEqual([ackOf(5, ["first"])]);
  });

  it("sends a manual ack made after the handler returned", async () => {
    const frames = await run(
      [
        wsHandler(
          "save",
          (_data, ack) => {
            setTimeout(ack, 5, "late");
            return "returned";
          },
          true,
        ),
      ],
      { id: 6, data: ["save", null] },
    );
    expect(frames).toEqual([ackOf(6, ["late"])]);
  });

  it("with @Ack(), still emits a WsResponse return alongside the manual ack", async () => {
    const frames = await run(
      [
        wsHandler(
          "save",
          (_data, ack) => {
            ack("manual");
            return { event: "saved", data: 1 };
          },
          true,
        ),
      ],
      { id: 7, data: ["save", null] },
    );
    expect(frames).toEqual([
      ackOf(7, ["manual"]),
      { type: MessageEventTypes.EVENT, namespace: "/", data: ["saved", 1] },
    ]);
  });

  it("with @Ack() and an Observable return, acks manually and never with an emission", async () => {
    const handler = wsHandler(
      "watch",
      (_data, ack) => {
        ack("manual");
        return of("a", "b", { event: "tick", data: 1 });
      },
      true,
    );
    const expected = [
      ackOf(8, ["manual"]),
      { type: MessageEventTypes.EVENT, namespace: "/", data: ["tick", 1] },
    ];
    const packet = { id: 8, data: ["watch", null] };
    expect(await run([handler], packet)).toEqual(expected);
    expect(await run([handler], packet, null)).toEqual(expected);
  });

  it("without @Ack(), acks with the return value", async () => {
    const frames = await run(
      [wsHandler("count", (data) => ({ saved: data }))],
      { id: 9, data: ["count", "x"] },
    );
    expect(frames).toEqual([ackOf(9, [{ saved: "x" }])]);
  });

  it("without @Ack(), acks with a Promise's value (with and without a transform)", async () => {
    const handler = wsHandler("count", async () => 42);
    const packet = { id: 10, data: ["count", null] };
    expect(await run([handler], packet)).toEqual([ackOf(10, [42])]);
    expect(await run([handler], packet, null)).toEqual([ackOf(10, [42])]);
  });

  it("without @Ack(), an Observable acks with its first emission only", async () => {
    const handler = wsHandler("count", () => of("first", "second"));
    const packet = { id: 11, data: ["count", null] };
    expect(await run([handler], packet)).toEqual([ackOf(11, ["first"])]);
    expect(await run([handler], packet, null)).toEqual([ackOf(11, ["first"])]);
  });

  it("without @Ack(), a WsResponse is emitted and not acked", async () => {
    const frames = await run(
      [wsHandler("count", () => ({ event: "counted", data: 2 }))],
      { id: 12, data: ["count", null] },
    );
    expect(frames).toEqual([
      { type: MessageEventTypes.EVENT, namespace: "/", data: ["counted", 2] },
    ]);
  });

  it("without @Ack(), null/undefined returns and plain events (no id) send nothing", async () => {
    expect(
      await run([wsHandler("count", () => null)], {
        id: 13,
        data: ["count", null],
      }),
    ).toEqual([]);
    expect(
      await run([wsHandler("count", () => "value")], {
        data: ["count", null],
      }),
    ).toEqual([]);
  });

  it("treats a falsy `event` as an ack value, as IoAdapter's `response.event` test", async () => {
    const frames = await run(
      [wsHandler("count", () => ({ event: "", data: 1 }))],
      { id: 14, data: ["count", null] },
    );
    expect(frames).toEqual([ackOf(14, [{ event: "", data: 1 }])]);
  });

  it("does not auto-ack after a manual-less handler's own ack call (once per packet)", async () => {
    // Without `@Ack()` NestJS still passes the raw ack to an undecorated
    // handler; socket.io's once-only guard then drops the automatic ack.
    const frames = await run(
      [
        wsHandler("count", (_data, ack) => {
          ack("own");
          return "auto";
        }),
      ],
      { id: 15, data: ["count", null] },
    );
    expect(frames).toEqual([ackOf(15, ["own"])]);
  });
});
