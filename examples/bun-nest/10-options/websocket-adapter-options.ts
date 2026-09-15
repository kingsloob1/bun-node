/**
 * Option tour: `BunWebSocketAdapter` — every constructor shape and option,
 * every method NestJS calls, every `MessageEventTypes` packet, and the gateway
 * behaviour a NestJS app sees on top of them.
 *
 * ```bash
 * bun 10-options/websocket-adapter-options.ts
 * ```
 *
 * Covers:
 *
 * - **Construction** — the adapter `BunHttpAdapter` builds
 *   (`httpAdapter.webSocketAdapter`, `BunNestWebsocketAdapter`) and its
 *   `websocket` option (`wsOptions`, `customDataToWsClientFn`, `httpAdapter`,
 *   `getServer`, `newInstance`/`listen`); `{ httpAdapter, localOptions }`; any
 *   `BunWebsocketHttpAdapter` shape; `{ newInstance: true, listen, router }`
 *   and `{ newInstance: true, listen, httpAdapter }`; `{ newInstance: false,
 *   getServer }`; the `webSocketAdapter` setter.
 * - **Methods** — `create`, `bindClientConnect`, `bindMessageHandlers` (with
 *   and without `transform`), `bindClientDisconnect`, `close`, `dispose`,
 *   `getServer`, `router`, `wsHandler`.
 * - **Packets** — `CONNECT`, `DISCONNECT`, `EVENT` (with and without an ack
 *   `id`), `ACK`, `ERROR`, `BINARY_EVENT`, `BINARY_ACK`, malformed and
 *   unroutable frames, and handler errors.
 * - **NestJS** — lifecycle hook arguments, `@WebSocketServer()`,
 *   `@ConnectedSocket()`/`client.data`/`client.emit`, `@MessageBody(key)`,
 *   `@Ack()`, namespaces, `path`, gateway ports, exceptions with and without a
 *   filter, and what `app.close()` calls.
 */
import type {
  BunRequest,
  BunResponse,
  JsonValue,
} from "@kingsleyweb/bun-common";
import type {
  BunNestWebSocketClient,
  BunWebSocketAdapterOptions,
  BunWebsocketHttpAdapter,
  BunWebSocketServerType,
  WebSocketClient,
  WsAckFunction,
} from "@kingsleyweb/bun-nest";
import type {
  ArgumentsHost,
  ExceptionFilter,
  WsMessageHandler,
} from "@nestjs/common";
import type {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WsResponse,
} from "@nestjs/websockets";
import type { Observable } from "rxjs";
import type { WirePacket, WsClient } from "../04-websockets/fixtures/ws-client";
import { Buffer } from "node:buffer";
import { BunRouter, getPort } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunNestWebsocketAdapter,
  BunWebSocketAdapter,
  MessageEventTypes,
} from "@kingsleyweb/bun-nest";
import { Catch, Module, UseFilters } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  Ack,
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from "@nestjs/websockets";
import { from, isObservable, of } from "rxjs";
import {
  connect,
  eventName,
  eventPayload,
  tryConnect,
} from "../04-websockets/fixtures/ws-client";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title, waitFor } from "../shared/console";
import "reflect-metadata";

/** The `transform` argument of `bindMessageHandlers`. */
type Transform = NonNullable<
  Parameters<BunWebSocketAdapter["bindMessageHandlers"]>[2]
>;

/** What `customDataToWsClientFn` stores on each connection of the NestJS app. */
interface Session {
  /** When the upgrade was accepted, in epoch milliseconds. */
  connectedAt: number;
  /** The `?room=` query parameter; `"lobby"` when absent. */
  room: string;
}

/** A client of the NestJS app. */
type Client = WebSocketClient<Session>;

/** One connection a `bindClientConnect` callback saw. */
interface SeenConnection {
  /** The namespace the binding was created for. */
  namespace: string;
  /** The connected client. */
  client: WebSocketClient;
  /** The server the callback received. */
  server: BunWebSocketServerType | undefined;
}

/** One call of a `bindClientDisconnect` callback. */
interface SeenDisconnect {
  /** The client it reported. */
  client: WebSocketClient;
  /** The close code. */
  code: number;
  /** The close reason. */
  reason: string;
}

title("Option tour: BunWebSocketAdapter");

/** Counts echo markers, so each one is unique. */
let markers = 0;

/**
 * The packets `probe` makes the server send to `client`. An echo is sent right
 * after it; once that is back, anything the probe would produce has arrived.
 */
async function framesFrom(
  client: WsClient,
  probe: () => void,
): Promise<WirePacket[]> {
  const before = client.frames.length;
  const marker = `marker-${++markers}`;
  probe();
  client.emit("echo", marker);
  await client.next(`echo ${marker}`, (packet) => {
    return eventName(packet) === "echo" && eventPayload(packet) === marker;
  });
  return client.frames.slice(before).filter((frame): frame is WirePacket => {
    return typeof frame !== "string" && eventPayload(frame) !== marker;
  });
}

/**
 * A `WsMessageHandler` for `message`. `isAckHandledManually` is what NestJS
 * sets for a handler declaring `@Ack()`: `true` makes the callback's own ack
 * call the only ack; `false` (the default) lets a returned value ack.
 */
function handler(
  message: string,
  callback: WsMessageHandler<string>["callback"],
  isAckHandledManually = false,
): WsMessageHandler<string> {
  return { message, callback, isAckHandledManually };
}

/** Whether a new connection to `url` is refused. */
async function refused(url: string): Promise<boolean> {
  const client = await tryConnect(url, { timeout: 2_000 });
  await client?.close();
  return client === undefined;
}

/* ------------------------------------------------------------------ */
step("MessageEventTypes: the socket.io packet ordinals");

checkEqual(
  "CONNECT, DISCONNECT, EVENT, ACK, ERROR, BINARY_EVENT, BINARY_ACK",
  [
    MessageEventTypes.CONNECT,
    MessageEventTypes.DISCONNECT,
    MessageEventTypes.EVENT,
    MessageEventTypes.ACK,
    MessageEventTypes.ERROR,
    MessageEventTypes.BINARY_EVENT,
    MessageEventTypes.BINARY_ACK,
  ],
  [0, 1, 2, 3, 4, 5, 6],
);

/* ------------------------------------------------------------------ */
step("The adapter BunHttpAdapter builds");

const scratch = new BunHttpAdapter();
const builtIn = scratch.webSocketAdapter;

check(
  "is a BunNestWebsocketAdapter",
  builtIn instanceof BunNestWebsocketAdapter,
);
check("which is a BunWebSocketAdapter", builtIn instanceof BunWebSocketAdapter);
check(
  "router is the HTTP adapter's router",
  builtIn.router === scratch.instance,
);
check(
  "is the router's active WebSocket",
  scratch.instance.getBunWebsocket() === builtIn,
);
checkEqual("getServer() before listen", builtIn.getServer(), undefined);
checkEqual(
  "wsHandler defaults",
  {
    perMessageDeflate: builtIn.wsHandler.perMessageDeflate,
    idleTimeout: builtIn.wsHandler.idleTimeout,
    maxPayloadLength: builtIn.wsHandler.maxPayloadLength,
  },
  { perMessageDeflate: true, idleTimeout: 30, maxPayloadLength: 1024 * 1024 },
);
check(
  "wsHandler has every lifecycle callback",
  (["open", "message", "close", "drain", "ping", "pong"] as const).every(
    (name) => typeof builtIn.wsHandler[name] === "function",
  ),
);

/* ------------------------------------------------------------------ */
step("BunHttpAdapter's `websocket` option");

const tuned = new BunHttpAdapter(0, {
  websocket: {
    newInstance: false,
    wsOptions: {
      idleTimeout: 12,
      maxPayloadLength: 2048,
      perMessageDeflate: false,
    },
  },
});
checkEqual(
  "wsOptions reach wsHandler",
  {
    perMessageDeflate: tuned.webSocketAdapter.wsHandler.perMessageDeflate,
    idleTimeout: tuned.webSocketAdapter.wsHandler.idleTimeout,
    maxPayloadLength: tuned.webSocketAdapter.wsHandler.maxPayloadLength,
  },
  { perMessageDeflate: false, idleTimeout: 12, maxPayloadLength: 2048 },
);

const elsewhere = new BunHttpAdapter();
await elsewhere.listen(0);

const borrowing = new BunHttpAdapter(0, {
  websocket: { httpAdapter: elsewhere },
});
check(
  "httpAdapter: rides another HTTP adapter's router",
  borrowing.webSocketAdapter.router === elsewhere.instance,
);
check(
  "httpAdapter: … and its server",
  borrowing.webSocketAdapter.getServer() === elsewhere.getBunServer(),
);

const redirected = new BunHttpAdapter(0, {
  websocket: { newInstance: false, getServer: () => elsewhere.getBunServer() },
});
check(
  "getServer: supplies the server to ride on",
  redirected.webSocketAdapter.getServer() === elsewhere.getBunServer(),
  {
    got: redirected.webSocketAdapter.getServer()?.port,
    expected: elsewhere.listeningPort,
  },
);

const optionPort = await getPort();
const viaOption = new BunHttpAdapter(0, {
  websocket: { newInstance: true, listen: { port: optionPort } },
});
check(
  "newInstance + listen: a dedicated server on listen.port",
  viaOption.webSocketAdapter.getServer()?.port === optionPort,
  { got: viaOption.webSocketAdapter.getServer()?.port, expected: optionPort },
);
viaOption.webSocketAdapter.close(viaOption.webSocketAdapter.getServer());

/* ------------------------------------------------------------------ */
step("Constructor shapes");

const layered = new BunWebSocketAdapter({
  httpAdapter: scratch,
  localOptions: {
    newInstance: false,
    getServer: () => undefined,
    wsOptions: { idleTimeout: 7 },
  },
});
checkEqual(
  "{ httpAdapter, localOptions }: wsOptions layered on",
  layered.wsHandler.idleTimeout,
  7,
);
check("… router from httpAdapter", layered.router === scratch.instance);
check(
  "constructing one over a router makes it the router's active WebSocket",
  scratch.instance.getBunWebsocket() === layered,
);
scratch.webSocketAdapter = builtIn;
check(
  "the webSocketAdapter setter makes its adapter active again",
  scratch.instance.getBunWebsocket() === builtIn,
);

const shape: BunWebsocketHttpAdapter = {
  instance: new BunRouter(),
  getBunServer: () => elsewhere.getBunServer(),
};
const fromShape = new BunWebSocketAdapter({ httpAdapter: shape });
check(
  "any { instance, getBunServer } is an httpAdapter",
  fromShape.router === shape.instance &&
    fromShape.getServer() === elsewhere.getBunServer(),
);

const anyPort = new BunWebSocketAdapter({
  newInstance: true,
  listen: { port: 0 },
  router: new BunRouter(),
});
const boundPort = anyPort.getServer()?.port;
check(
  "newInstance: listen.port 0 binds a free port, reported by getServer()",
  typeof boundPort === "number" && boundPort > 0,
  { boundPort },
);
anyPort.close(undefined);
check(
  "… and close() releases it",
  await refused(`ws://127.0.0.1:${boundPort}/`),
);

await checkRejects(
  "options naming no server throw (there is no default port)",
  () =>
    new BunWebSocketAdapter({
      router: new BunRouter(),
      // Deliberately invalid: no server, so the constructor must reject it.
    } as unknown as BunWebSocketAdapterOptions),
  { message: /needs a server/ },
);

const standalonePort = await getPort();
const standaloneRouter = new BunRouter();
standaloneRouter.get("/health", (_req, res) => {
  res.send("ok");
});
const standalone = new BunWebSocketAdapter({
  newInstance: true,
  listen: { host: "127.0.0.1", port: standalonePort },
  router: standaloneRouter,
  wsOptions: { idleTimeout: 9 },
});
checkEqual(
  "newInstance + router: listening at construction",
  standalone.getServer()?.port,
  standalonePort,
);
check("… on that router", standalone.router === standaloneRouter);
checkEqual("… with its wsOptions", standalone.wsHandler.idleTimeout, 9);
checkEqual(
  "… serving the router's HTTP routes on its port",
  await (await fetch(`http://127.0.0.1:${standalonePort}/health`)).text(),
  "ok",
);
checkEqual(
  "… 404 for anything else",
  (await fetch(`http://127.0.0.1:${standalonePort}/nope`)).status,
  404,
);
check(
  "create(port) returns its own server",
  standalone.create(standalonePort, { transport: [] }) ===
    standalone.getServer(),
);
standalone.bindClientConnect(undefined, (client) => {
  standalone.bindMessageHandlers(client, [
    handler("echo", async (payload: unknown) => {
      return { event: "echo", data: payload };
    }),
  ]);
});
const standaloneClient = await connect(`ws://127.0.0.1:${standalonePort}/`);
standaloneClient.emit("echo", "standalone");
checkEqual(
  "… and its WebSocket",
  eventPayload(await standaloneClient.nextEvent("echo")),
  "standalone",
);
await standaloneClient.close();

const hostHttp = new BunHttpAdapter();
const ownPort = await getPort();
const onOwnPort = new BunWebSocketAdapter({
  newInstance: true,
  listen: { port: ownPort },
  httpAdapter: hostHttp,
});
check(
  "newInstance + httpAdapter: router falls back to httpAdapter.instance",
  onOwnPort.router === hostHttp.instance,
);
checkEqual(
  "… but listens on listen.port",
  onOwnPort.getServer()?.port,
  ownPort,
);
onOwnPort.close(undefined);

const riding = new BunWebSocketAdapter({
  newInstance: false,
  getServer: () => elsewhere.getBunServer(),
  router: new BunRouter(),
});
check(
  "newInstance: false rides on getServer()",
  riding.getServer() === elsewhere.getBunServer(),
  { got: riding.getServer()?.port, expected: elsewhere.listeningPort },
);

/* ------------------------------------------------------------------ */
step("create() and bindClientConnect()");

const early = new BunHttpAdapter();
checkEqual(
  "create(0) before the HTTP server listens returns undefined",
  early.webSocketAdapter.create(0, { transport: [] }),
  undefined,
);

const wire = new BunHttpAdapter(0, {
  websocket: { newInstance: false, wsOptions: { maxPayloadLength: 8 * 1024 } },
});
await wire.listen(0);
const adapter = wire.webSocketAdapter;
const wireUrl = (path: string) => `ws://127.0.0.1:${wire.listeningPort}${path}`;

const shared = adapter.create(0, { namespace: "/a", transport: [] });
check(
  "create(0) after listen returns the HTTP server",
  shared === wire.getBunServer(),
);

const connections: SeenConnection[] = [];
const disconnects: SeenDisconnect[] = [];
let countCalls = 0;

const handlers: WsMessageHandler<string>[] = [
  handler("echo", async (payload: unknown) => {
    return { event: "echo", data: payload };
  }),
  handler("nothing", async () => {
    return undefined;
  }),
  handler("stream", () => {
    return of({ event: "stream", data: 1 }, { event: "stream", data: 2 });
  }),
  handler(
    "ack",
    async (
      payload: unknown,
      ack?: WsAckFunction<[status: string, payload: unknown]>,
    ) => {
      ack?.("got", payload);
    },
    true,
  ),
  handler(
    "manual-returns",
    async (payload: unknown, ack?: WsAckFunction<[string, unknown]>) => {
      ack?.("manual", payload);
      return "never an ack";
    },
    true,
  ),
  handler(
    "ack-twice",
    async (_payload: unknown, ack?: WsAckFunction<[string]>) => {
      ack?.("first");
      ack?.("second");
    },
    true,
  ),
  handler("auto", async (payload: unknown) => {
    return { auto: payload };
  }),
  handler("throws", () => {
    throw new Error("thrown synchronously");
  }),
  handler("rejects", async () => {
    throw new Error("rejected");
  }),
  handler("binary", async (payload: unknown) => {
    return {
      event: "binary",
      data: Buffer.isBuffer(payload) ? [...payload] : null,
    };
  }),
  handler("binaries", async (payload: unknown) => {
    if (payload === undefined) {
      return { event: "binaries", data: "no arguments" };
    }
    const args = Array.isArray(payload) ? payload : [payload];
    return {
      event: "binaries",
      data: args.map((arg) => (Buffer.isBuffer(arg) ? [...arg] : arg)),
    };
  }),
  handler("bytes", async () => {
    return { event: "bytes", data: Buffer.from([0xff, 0x00, 0xe9]) };
  }),
  handler(
    "ack-length",
    async (payload: unknown, ack?: WsAckFunction<[length: number]>) => {
      ack?.(Buffer.isBuffer(payload) ? payload.length : -1);
    },
    true,
  ),
  handler("connect", async () => {
    return { event: "connect-packet", data: null };
  }),
  handler("disconnect", async () => {
    return { event: "disconnect-packet", data: null };
  }),
  handler("error", async (payload: string | Error) => {
    return {
      event: "error-handler",
      data: payload instanceof Error ? "an Error" : payload,
    };
  }),
  handler("events", async (raw: string | Buffer) => {
    return { event: "catch-all", data: String(raw) };
  }),
  handler("count", async () => {
    countCalls++;
  }),
];

adapter.bindClientConnect(shared, (client, server) => {
  connections.push({ namespace: "/a", client, server });
  adapter.bindMessageHandlers(client, handlers);
  adapter.bindClientDisconnect(client, (gone, code, reason) => {
    disconnects.push({ client: gone, code, reason });
  });
});

let transformed = 0;
const transform: Transform = (result) => {
  transformed++;
  return isObservable(result) ? result : from(Promise.resolve(result));
};

adapter.create(0, { namespace: "/b", transport: [] });
adapter.bindClientConnect(undefined, (client, server) => {
  connections.push({ namespace: "/b", client, server });
  adapter.bindMessageHandlers(client, [handlers[0]!], transform);
});

const alice = await connect(wireUrl("/a"));
const bob = await connect(wireUrl("/a?who=bob"));
const carol = await connect(wireUrl("/b"));
await waitFor("three connect callbacks", () => connections.length === 3);

checkEqual(
  "each binding hears only its namespace",
  connections.map((seen) => [seen.namespace, seen.client.data.path]),
  [
    ["/a", "/a"],
    ["/a", "/a"],
    ["/b", "/b"],
  ],
);
check(
  "the callback receives the live server (given or not)",
  connections.every((seen) => seen.server === wire.getBunServer()),
);
check("a path with no namespace is refused", await refused(wireUrl("/c")));

/* ------------------------------------------------------------------ */
step("bindMessageHandlers(): EVENT (2)");

alice.emit("echo", { n: 1 });
checkEqual(
  "a WsResponse comes back as an EVENT",
  await alice.nextEvent("echo"),
  {
    type: MessageEventTypes.EVENT,
    namespace: "/",
    data: ["echo", { n: 1 }],
  },
);

alice.emit("echo", "elsewhere", { namespace: "/other" });
checkEqual(
  "the reply echoes the packet's namespace field",
  (
    await alice.next(
      "the /other echo",
      (packet) => packet.namespace === "/other",
    )
  ).namespace,
  "/other",
);

checkEqual(
  "a handler resolving undefined sends nothing",
  await framesFrom(alice, () => alice.emit("nothing")),
  [],
);

alice.emit("stream");
await waitFor(
  "two stream events",
  () => alice.payloadsOf("stream").length === 2,
);
checkEqual(
  "every Observable emission is sent",
  alice.payloadsOf("stream"),
  [1, 2],
);

alice.emit("ack", "x", { id: 5 });
checkEqual(
  "with an id, the ack callback sends an ACK of that id",
  await alice.next("ACK 5", (packet) => packet.id === 5),
  { type: MessageEventTypes.ACK, id: 5, namespace: "/", data: ["got", "x"] },
);
checkEqual(
  "without an id, no ack callback is passed",
  await framesFrom(alice, () => alice.emit("ack", "y")),
  [],
);
checkEqual(
  "an id on an event whose handler does not ack produces no ACK",
  (await framesFrom(alice, () => alice.emit("echo", "z", { id: 6 }))).map(
    (packet) => packet.type,
  ),
  [MessageEventTypes.EVENT],
);

alice.emit("auto", "v", { id: 7 });
checkEqual(
  "isAckHandledManually false: a returned value is the ACK",
  await alice.next("ACK 7", (packet) => packet.id === 7),
  { type: MessageEventTypes.ACK, id: 7, namespace: "/", data: [{ auto: "v" }] },
);
checkEqual(
  "isAckHandledManually true: only the handler's ack, never its return value",
  await framesFrom(alice, () => alice.emit("manual-returns", "w", { id: 8 })),
  [
    {
      type: MessageEventTypes.ACK,
      id: 8,
      namespace: "/",
      data: ["manual", "w"],
    },
  ],
);
checkEqual(
  "an ack sends once, however often it is called",
  await framesFrom(alice, () => alice.emit("ack-twice", null, { id: 14 })),
  [{ type: MessageEventTypes.ACK, id: 14, namespace: "/", data: ["first"] }],
);
checkEqual(
  "a returned value without an id sends nothing",
  await framesFrom(alice, () => alice.emit("auto", "u")),
  [],
);

alice.emit("count");
await framesFrom(alice, () => undefined);
checkEqual("frames run only the sending client's handlers", countCalls, 1);

checkEqual(
  "a JSON packet in a binary frame is read like text",
  (
    await framesFrom(alice, () => {
      alice.send(
        new TextEncoder().encode(
          JSON.stringify({
            type: MessageEventTypes.EVENT,
            namespace: "/",
            data: ["echo", "from bytes"],
          }),
        ),
      );
    })
  ).map(eventPayload),
  ["from bytes"],
);

/* ------------------------------------------------------------------ */
step("bindMessageHandlers(): ACK (3), BINARY_ACK (6), BINARY_EVENT (5)");

const clientAck: WirePacket = {
  type: MessageEventTypes.ACK,
  namespace: "/",
  id: 9,
  data: ["x"],
};
alice.send(clientAck);
checkEqual(
  "an ACK from the client is echoed back",
  await alice.next("ACK 9", (packet) => packet.id === 9),
  clientAck,
);

const clientBinaryAck: WirePacket = {
  type: MessageEventTypes.BINARY_ACK,
  namespace: "/",
  id: 10,
  data: ["y"],
};
alice.send(clientBinaryAck);
checkEqual(
  "a BINARY_ACK is echoed back",
  await alice.next("BINARY_ACK 10", (packet) => packet.id === 10),
  clientBinaryAck,
);

alice.send({
  type: MessageEventTypes.BINARY_EVENT,
  namespace: "/",
  data: ["binary", Buffer.from("hi").toString("base64")],
});
checkEqual(
  "BINARY_EVENT: base64 arrives as a Buffer",
  eventPayload(await alice.nextEvent("binary")),
  [...Buffer.from("hi")],
);

alice.send({
  type: MessageEventTypes.BINARY_EVENT,
  namespace: "/",
  data: ["binary", Buffer.from([0xff, 0x00, 0xe9]).toString("base64")],
});
await waitFor(
  "the second binary reply",
  () => alice.payloadsOf("binary").length === 2,
);
checkEqual(
  "BINARY_EVENT: every byte survives",
  alice.payloadsOf("binary")[1],
  [0xff, 0x00, 0xe9],
);

alice.send({
  type: MessageEventTypes.BINARY_EVENT,
  namespace: "/",
  // `binary` names the base64 arguments; "label" is left a string.
  data: [
    "binaries",
    Buffer.from([1, 2]).toString("base64"),
    "label",
    Buffer.from([3]).toString("base64"),
  ],
  binary: [0, 2],
});
checkEqual(
  "BINARY_EVENT: every argument `binary` marks is decoded, and only those",
  eventPayload(await alice.nextEvent("binaries")),
  [[1, 2], "label", [3]],
);

alice.send({
  type: MessageEventTypes.BINARY_EVENT,
  namespace: "/",
  data: ["binaries"],
});
await waitFor(
  "the no-argument reply",
  () => alice.payloadsOf("binaries").length === 2,
);
checkEqual(
  "BINARY_EVENT with no arguments: nothing decoded, an undefined payload",
  alice.payloadsOf("binaries")[1],
  "no arguments",
);

alice.send({
  type: MessageEventTypes.BINARY_EVENT,
  namespace: "/",
  id: 12,
  data: ["ack", Buffer.from("b").toString("base64")],
});
checkEqual(
  "an ack carrying bytes is a BINARY_ACK (6), the bytes as base64",
  await alice.next("ack 12", (packet) => packet.id === 12),
  {
    type: MessageEventTypes.BINARY_ACK,
    id: 12,
    namespace: "/",
    data: ["got", Buffer.from("b").toString("base64")],
    binary: [1],
  },
);

alice.send({
  type: MessageEventTypes.BINARY_EVENT,
  namespace: "/",
  id: 13,
  data: ["ack-length", Buffer.from("four").toString("base64")],
});
checkEqual(
  "an ack without bytes is an ACK (3), even for a BINARY_EVENT",
  await alice.next("ack 13", (packet) => packet.id === 13),
  { type: MessageEventTypes.ACK, id: 13, namespace: "/", data: [4] },
);

alice.emit("bytes");
checkEqual(
  "a WsResponse whose data is bytes comes back as a BINARY_EVENT",
  await alice.next("the bytes reply", (packet) => {
    return eventName(packet) === "bytes";
  }),
  {
    type: MessageEventTypes.BINARY_EVENT,
    namespace: "/",
    data: ["bytes", Buffer.from([0xff, 0x00, 0xe9]).toString("base64")],
    binary: [0],
  },
);

/* ------------------------------------------------------------------ */
step("bindMessageHandlers(): CONNECT (0), DISCONNECT (1), ERROR (4)");

alice.send({ type: MessageEventTypes.CONNECT, namespace: "/" });
check(
  "CONNECT calls the `connect` handler",
  eventName(await alice.nextEvent("connect-packet")) === "connect-packet",
);

alice.send({ type: MessageEventTypes.DISCONNECT, namespace: "/" });
await alice.nextEvent("disconnect-packet");
check(
  "DISCONNECT calls the `disconnect` handler and leaves the socket open",
  alice.closed() === undefined,
);

alice.send({ type: MessageEventTypes.ERROR, namespace: "/", data: "boom" });
checkEqual(
  "ERROR calls the `error` handler with its text",
  eventPayload(await alice.nextEvent("error-handler")),
  "boom",
);

/* ------------------------------------------------------------------ */
step("bindMessageHandlers(): frames it cannot parse or route, handler errors");

const malformed = await framesFrom(alice, () => alice.send("not json"));
check(
  "a malformed frame gets an ERROR packet",
  malformed.some(
    (packet) =>
      packet.type === MessageEventTypes.ERROR &&
      typeof packet.data === "string",
  ),
  malformed,
);
check(
  "… the `error` handler gets the parse Error",
  malformed.some(
    (packet) =>
      eventName(packet) === "error-handler" &&
      eventPayload(packet) === "an Error",
  ),
  malformed,
);
check(
  "… and the `events` catch-all gets the raw frame",
  malformed.some(
    (packet) =>
      eventName(packet) === "catch-all" && eventPayload(packet) === "not json",
  ),
  malformed,
);

const unknownType = JSON.stringify({ type: 42, namespace: "/" });
checkEqual(
  "an unknown type goes to the catch-all",
  (await framesFrom(alice, () => alice.send(unknownType))).map(eventPayload),
  [unknownType],
);
const noArray = JSON.stringify({
  type: MessageEventTypes.EVENT,
  namespace: "/",
  data: "no array",
});
checkEqual(
  "an EVENT whose data is not an array goes to the catch-all",
  (await framesFrom(alice, () => alice.send(noArray))).map(eventPayload),
  [noArray],
);

checkEqual(
  "a handler that throws sends an ERROR with its message",
  await framesFrom(alice, () => alice.emit("throws")),
  [
    {
      type: MessageEventTypes.ERROR,
      namespace: "/",
      data: "thrown synchronously",
    },
  ],
);
checkEqual(
  "a handler that rejects sends an ERROR with its message",
  await framesFrom(alice, () => alice.emit("rejects")),
  [{ type: MessageEventTypes.ERROR, namespace: "/", data: "rejected" }],
);

/* ------------------------------------------------------------------ */
step("bindMessageHandlers() with a transform");

carol.emit("echo", "via transform");
checkEqual(
  "the reply still arrives",
  eventPayload(await carol.nextEvent("echo")),
  "via transform",
);
checkEqual("the transform wrapped the handler's result", transformed, 1);

/* ------------------------------------------------------------------ */
step("bindClientDisconnect()");

const messageListeners = adapter.listenerCount("message");
const disconnectListeners = adapter.listenerCount("disconnect");
await alice.close(4001, "bye");
await waitFor("the disconnect callback", () => disconnects.length === 1);
checkEqual(
  "reports the code and reason",
  { code: disconnects[0]!.code, reason: disconnects[0]!.reason },
  { code: 4001, reason: "bye" },
);
check(
  "… for its own client only",
  disconnects[0]!.client === connections[0]!.client,
);
checkEqual(
  "the message listener detaches",
  adapter.listenerCount("message"),
  messageListeners - 1,
);
checkEqual(
  "both disconnect listeners detach",
  adapter.listenerCount("disconnect"),
  disconnectListeners - 2,
);

/* ------------------------------------------------------------------ */
step("wsOptions.maxPayloadLength is enforced");

carol.emit("echo", "x".repeat(16 * 1024));
await waitFor(
  "the oversized frame to close the socket",
  () => carol.closed() !== undefined,
);
check(
  "a frame over maxPayloadLength closes the connection",
  carol.closed() !== undefined,
  carol.closed(),
);

/* ------------------------------------------------------------------ */
step("close() and dispose()");

await bob.close();
const lingering = await connect(wireUrl("/a"));
await waitFor("the lingering connection", () => connections.length === 4);
adapter.close(shared);
await waitFor("close() to close it", () => lingering.closed() !== undefined);
checkEqual(
  "close(shared server) closes the adapter's connections with 1001",
  lingering.closed()?.code,
  1001,
);
checkEqual(
  "… but leaves the HTTP server serving",
  (await fetch(`http://127.0.0.1:${wire.listeningPort}/nope`)).status,
  404,
);
const afterClose = await connect(wireUrl("/a"));
await Bun.sleep(50);
checkEqual("… and detaches the gateways bound to it", connections.length, 4);
await afterClose.close();
check(
  "dispose() is a no-op",
  (() => {
    adapter.dispose();
    return true;
  })(),
);
await wire.close();

standalone.close(undefined);
check(
  "close(undefined) stops a newInstance adapter's own server",
  await refused(`ws://127.0.0.1:${standalonePort}/`),
);

/* ------------------------------------------------------------------ */
step("NestJS: gateways on the adapter");

const METRICS_PORT = await getPort();

/** What the `profile` handler reports about a connection. */
interface Profile {
  /** The upgrade's URL path. */
  path: string;
  /** The upgrade's query string. */
  search: string;
  /** The upgrade's URL hash. */
  hash: string;
  /** The upgrade's URL as requested. */
  originalUrl: string;
  /** The host the upgrade was addressed to. */
  host: string;
  /** The `Host` header, `null` when absent. */
  hostHeader: string | null;
  /** What auth middleware put on the request, if anything. */
  user: Record<string, unknown> | undefined;
  /** The room from the connection's custom data. */
  room: string;
  /** `typeof` the custom data's connection time. */
  connectedAt: string;
}

/** Replaces the default `exception` event: writes any exception as an ERROR packet. */
@Catch()
class WireErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Client>();
    client.send(
      JSON.stringify({
        type: MessageEventTypes.ERROR,
        namespace: "/",
        data:
          exception instanceof Error ? exception.message : String(exception),
      }),
    );
  }
}

@WebSocketGateway()
class LobbyGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  /** What `@WebSocketServer()` injected. */
  @WebSocketServer()
  server: BunWebSocketServerType<Session> | undefined;

  /** `afterInit`'s argument, once it has run. */
  initServer: BunWebSocketServerType<Session> | undefined | null = null;

  /** `handleConnection`'s arguments, per call. */
  readonly connected: {
    client: Client;
    server: BunWebSocketServerType<Session>;
  }[] = [];

  /** `handleDisconnect`'s argument, per call. */
  readonly disconnected: Client[] = [];

  afterInit(server: BunWebSocketServerType<Session> | undefined): void {
    this.initServer = server;
  }

  handleConnection(
    client: Client,
    server: BunWebSocketServerType<Session>,
  ): void {
    this.connected.push({ client, server });
  }

  handleDisconnect(client: Client): void {
    this.disconnected.push(client);
  }

  @SubscribeMessage("echo")
  echo(@MessageBody() body: JsonValue): WsResponse<JsonValue> {
    return { event: "echo", data: body };
  }

  @SubscribeMessage("profile")
  profile(@ConnectedSocket() client: Client): WsResponse<Profile> {
    return {
      event: "profile",
      data: {
        path: client.data.path,
        search: client.data.search,
        hash: client.data.hash,
        originalUrl: client.data.originalUrl,
        host: client.data.host,
        hostHeader: client.data.headers.get("host"),
        user: client.data.user,
        room: client.data.custom.room,
        connectedAt: typeof client.data.custom.connectedAt,
      },
    };
  }

  @SubscribeMessage("pick")
  pick(@MessageBody("key") key: JsonValue): WsResponse<JsonValue> {
    return { event: "picked", data: key };
  }

  @SubscribeMessage("remember")
  remember(
    @MessageBody() item: JsonValue,
    @Ack() ack: WsAckFunction<[status: string, item: JsonValue]>,
  ): void {
    ack("remembered", item);
  }

  /** `@Ack()` plus a return value: the return value is never the ack. */
  @SubscribeMessage("remember-and-return")
  rememberAndReturn(
    @MessageBody() item: JsonValue,
    @Ack() ack: WsAckFunction<[status: string, item: JsonValue]>,
  ): string {
    ack("remembered", item);
    return "never an ack";
  }

  /** `@Ack()` plus an Observable: emissions never ack; a `WsResponse` is still sent. */
  @SubscribeMessage("watch")
  watch(
    @Ack() ack: WsAckFunction<[status: string]>,
  ): Observable<string | WsResponse<number>> {
    ack("watching");
    return of("not", "acks", { event: "watched", data: 1 });
  }

  /** No `@Ack()`: the return value is the ack. */
  @SubscribeMessage("tally")
  tally(@MessageBody() items: JsonValue[]): number {
    return items.length;
  }

  /** No `@Ack()`, an Observable: only its first emission acks. */
  @SubscribeMessage("tally-stream")
  tallyStream(): Observable<number> {
    return of(1, 2, 3);
  }

  @SubscribeMessage("nudge")
  nudge(@ConnectedSocket() client: BunNestWebSocketClient<Session>): void {
    client.emit("nudged", client.data.custom.room);
  }

  @SubscribeMessage("fizzle")
  fizzle(): never {
    throw new WsException("unheard");
  }

  @SubscribeMessage("explode")
  @UseFilters(new WireErrorFilter())
  explode(): never {
    throw new WsException("filtered");
  }
}

@WebSocketGateway({ namespace: "/rooms" })
class RoomsGateway {
  /** Lets `framesFrom` mark the end of a probe on this namespace. */
  @SubscribeMessage("echo")
  echo(@MessageBody() body: JsonValue): WsResponse<JsonValue> {
    return { event: "echo", data: body };
  }

  @SubscribeMessage("where")
  where(@ConnectedSocket() client: Client): WsResponse<string> {
    return { event: "here", data: client.data.path };
  }
}

/** A gateway on a `path`: it serves `/ws` only. */
@WebSocketGateway({ path: "/ws" })
class PathGateway {
  /** Lets `framesFrom` mark the end of a probe on this path. */
  @SubscribeMessage("echo")
  echo(@MessageBody() body: JsonValue): WsResponse<JsonValue> {
    return { event: "echo", data: body };
  }

  @SubscribeMessage("which")
  which(@ConnectedSocket() client: Client): WsResponse<string> {
    return { event: "which", data: client.data.path };
  }
}

/** A default-namespace gateway listed after a namespaced one and a path one. */
@WebSocketGateway()
class LateGateway {
  @SubscribeMessage("late")
  late(): WsResponse<string> {
    return { event: "late", data: "on time" };
  }
}

@WebSocketGateway(METRICS_PORT)
class MetricsGateway implements OnGatewayInit {
  /** What `@WebSocketServer()` injected. */
  @WebSocketServer()
  server: BunWebSocketServerType<Session> | undefined;

  /** `afterInit`'s argument. */
  initServer: BunWebSocketServerType<Session> | undefined;

  afterInit(server: BunWebSocketServerType<Session> | undefined): void {
    this.initServer = server;
  }

  @SubscribeMessage("stats")
  stats(): WsResponse<number | undefined> {
    return { event: "stats", data: this.server?.port };
  }

  /** Lets `framesFrom` mark the end of a probe on this port. */
  @SubscribeMessage("echo")
  echo(@MessageBody() body: JsonValue): WsResponse<JsonValue> {
    return { event: "echo", data: body };
  }
}

@Module({
  providers: [
    LobbyGateway,
    RoomsGateway,
    PathGateway,
    LateGateway,
    MetricsGateway,
  ],
})
class AppModule {}

/** Each upgrade request `customDataToWsClientFn` saw. */
const upgrades: { path: string; hasResponse: boolean }[] = [];

const http = new BunHttpAdapter<Session>(0, {
  websocket: {
    newInstance: false,
    customDataToWsClientFn: (req: BunRequest, res: BunResponse): Session => {
      upgrades.push({ path: req.path, hasResponse: res !== undefined });
      return {
        connectedAt: Date.now(),
        room: new URLSearchParams(req.search).get("room") ?? "lobby",
      };
    },
  },
});
const app = await NestFactory.create(AppModule, http, { logger: false });

app.use((req: BunRequest, res: BunResponse, next: () => void) => {
  if (
    req.headersObj.get("upgrade")?.toLowerCase() === "websocket" &&
    !req.search.includes("token=ok")
  ) {
    res.status(401).send("no token");
    return;
  }
  Object.assign(req, { user: { id: "u1" } });
  next();
});

const nestAdapter = http.webSocketAdapter;
const closedServers: (BunWebSocketServerType<Session> | undefined)[] = [];
const originalClose = nestAdapter.close.bind(nestAdapter);
nestAdapter.close = (server) => {
  closedServers.push(server);
  return originalClose(server);
};
let disposed = false;
const originalDispose = nestAdapter.dispose.bind(nestAdapter);
nestAdapter.dispose = () => {
  disposed = true;
  originalDispose();
};

app.useWebSocketAdapter(nestAdapter);
await app.listen(0);

const lobby = app.get(LobbyGateway);
const metrics = app.get(MetricsGateway);
const nestUrl = (path: string) => `ws://127.0.0.1:${http.listeningPort}${path}`;

checkEqual(
  "afterInit on the shared server gets undefined (not listening yet)",
  lobby.initServer,
  undefined,
);
checkEqual(
  "@WebSocketServer() on the shared server is undefined",
  lobby.server,
  undefined,
);
checkEqual(
  "@WebSocketServer() on a gateway port is its own server",
  metrics.server?.port,
  METRICS_PORT,
);
check(
  "afterInit on a gateway port gets that server",
  metrics.initServer === metrics.server,
);

check("middleware can refuse an upgrade", await refused(nestUrl("/?room=den")));

const dana = await connect(nestUrl("/?token=ok&room=den"));
await waitFor("handleConnection", () => lobby.connected.length === 1);
check(
  "handleConnection(client, server) gets the live server",
  lobby.connected[0]!.server === http.getBunServer(),
);
checkEqual(
  "customDataToWsClientFn gets the request and response",
  upgrades.at(-1),
  { path: "/", hasResponse: true },
);

dana.emit("profile");
checkEqual(
  "@ConnectedSocket client.data",
  eventPayload(await dana.nextEvent("profile")),
  {
    path: "/",
    search: "?token=ok&room=den",
    hash: "",
    originalUrl: "/?token=ok&room=den",
    host: `127.0.0.1:${http.listeningPort}`,
    hostHeader: `127.0.0.1:${http.listeningPort}`,
    user: { id: "u1" },
    room: "den",
    connectedAt: "number",
  },
);

dana.emit("pick", { key: "chosen", other: 1 });
checkEqual(
  "@MessageBody('key') picks one property",
  eventPayload(await dana.nextEvent("picked")),
  "chosen",
);

dana.emit("remember", "milk", { id: 21 });
checkEqual(
  "@Ack() answers with an ACK",
  await dana.next("ACK 21", (packet) => packet.id === 21),
  {
    type: MessageEventTypes.ACK,
    id: 21,
    namespace: "/",
    data: ["remembered", "milk"],
  },
);

checkEqual(
  "@Ack() plus a return value: only the handler's ACK is sent",
  await framesFrom(dana, () => {
    dana.emit("remember-and-return", "eggs", { id: 22 });
  }),
  [
    {
      type: MessageEventTypes.ACK,
      id: 22,
      namespace: "/",
      data: ["remembered", "eggs"],
    },
  ],
);
checkEqual(
  "@Ack() plus an Observable: one ACK, the WsResponse emission still sent",
  await framesFrom(dana, () => dana.emit("watch", null, { id: 23 })),
  [
    { type: MessageEventTypes.ACK, id: 23, namespace: "/", data: ["watching"] },
    { type: MessageEventTypes.EVENT, namespace: "/", data: ["watched", 1] },
  ],
);
checkEqual(
  "no @Ack(): the return value is the ACK",
  await framesFrom(dana, () => dana.emit("tally", [1, 2, 3], { id: 24 })),
  [{ type: MessageEventTypes.ACK, id: 24, namespace: "/", data: [3] }],
);
checkEqual(
  "no @Ack(), an Observable: its first emission is the ACK",
  await framesFrom(dana, () => dana.emit("tally-stream", null, { id: 25 })),
  [{ type: MessageEventTypes.ACK, id: 25, namespace: "/", data: [1] }],
);
checkEqual(
  "no @Ack() and no id: nothing is sent",
  await framesFrom(dana, () => dana.emit("tally", [1])),
  [],
);

dana.emit("nudge");
checkEqual(
  "client.emit(event, ...args) sends an EVENT",
  await dana.nextEvent("nudged"),
  { type: MessageEventTypes.EVENT, namespace: "/", data: ["nudged", "den"] },
);

checkEqual(
  "a thrown WsException reaches the client as an `exception` event",
  await framesFrom(dana, () => dana.emit("fizzle", null)),
  [
    {
      type: MessageEventTypes.EVENT,
      namespace: "/",
      data: [
        "exception",
        {
          status: "error",
          message: "unheard",
          cause: { pattern: "fizzle", data: null },
        },
      ],
    },
  ],
);
checkEqual(
  "an exception filter replaces it — here one writing an ERROR packet",
  await framesFrom(dana, () => dana.emit("explode")),
  [{ type: MessageEventTypes.ERROR, namespace: "/", data: "filtered" }],
);

const roomsClient = await connect(nestUrl("/rooms?token=ok"));
roomsClient.emit("where");
checkEqual(
  "a namespaced gateway answers on its path",
  eventPayload(await roomsClient.nextEvent("here")),
  "/rooms",
);
checkEqual(
  "another namespace's events do not reach it",
  await framesFrom(roomsClient, () => roomsClient.emit("profile")),
  [],
);
checkEqual(
  "its events do not reach the default namespace",
  await framesFrom(dana, () => dana.emit("where")),
  [],
);
check(
  "a path no gateway serves is refused",
  await refused(nestUrl("/nowhere?token=ok")),
);

checkEqual(
  "a default-namespace gateway listed after a namespaced one serves '/'",
  (await framesFrom(dana, () => dana.emit("late"))).map(eventPayload),
  ["on time"],
);

const pathClient = await connect(nestUrl("/ws?token=ok"));
pathClient.emit("which");
checkEqual(
  "@WebSocketGateway({ path }) answers on that path",
  eventPayload(await pathClient.nextEvent("which")),
  "/ws",
);
checkEqual(
  "… and only there: '/' does not reach it",
  await framesFrom(dana, () => dana.emit("which")),
  [],
);
checkEqual(
  "… nor does it reach the default path's gateways",
  await framesFrom(pathClient, () => pathClient.emit("late")),
  [],
);
await pathClient.close();

const metricsClient = await connect(`ws://127.0.0.1:${METRICS_PORT}/?token=ok`);
metricsClient.emit("stats");
checkEqual(
  "a gateway port accepts connections",
  eventPayload(await metricsClient.nextEvent("stats")),
  METRICS_PORT,
);
const lobbyConnections = lobby.connected.length;
checkEqual(
  "a port is a boundary: the HTTP server's '/' gateways do not answer on a gateway port",
  await framesFrom(metricsClient, () => metricsClient.emit("profile")),
  [],
);
checkEqual(
  "… nor do their connection hooks run for its clients",
  lobby.connected.length,
  lobbyConnections,
);
checkEqual(
  "… and a gateway port's gateway does not answer on the HTTP server",
  await framesFrom(dana, () => dana.emit("stats")),
  [],
);

await dana.close();
await waitFor("handleDisconnect", () => {
  return lobby.disconnected.includes(lobby.connected[0]!.client);
});
check(
  "handleDisconnect(client) gets the connected client",
  lobby.disconnected.includes(lobby.connected[0]!.client),
);

await roomsClient.close();
await metricsClient.close();
await app.close();

check(
  "app.close() calls close(server) for the gateway port's server",
  closedServers.includes(metrics.server),
);
check("… and dispose()", disposed);
check(
  "the gateway port is released",
  await refused(`ws://127.0.0.1:${METRICS_PORT}/`),
);

await elsewhere.close();

summary();
