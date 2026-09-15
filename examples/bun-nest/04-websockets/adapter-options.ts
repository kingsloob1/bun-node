/**
 * Configuring the WebSocket adapter: the HTTP adapter's `websocket` option,
 * auth and per-connection data on upgrade, namespaces and dedicated ports,
 * broadcasting — then the adapter driven by hand with no NestJS at all, both
 * riding an HTTP server and standing alone on its own port.
 *
 * ```bash
 * bun 04-websockets/adapter-options.ts
 * ```
 *
 * Two ways to build one:
 *
 * - **From an HTTP adapter** — `BunHttpAdapter` builds one for you
 *   (`httpAdapter.webSocketAdapter`), tuned with its `websocket` option:
 *   `wsOptions` (Bun's `idleTimeout`, `maxPayloadLength`, `perMessageDeflate`,
 *   …) and `customDataToWsClientFn`. Upgrades go through the app's router, so
 *   middleware runs first and can refuse them.
 * - **Standalone** — `new BunWebSocketAdapter({ newInstance: true, listen: {
 *   port }, router })` binds its own `Bun.serve` server on that port, at
 *   construction. `listen.port` must be a real port, not `0`.
 *
 * The methods NestJS calls, and you can call yourself: `create(port, {
 * namespace })` registers the upgrade route at the namespace path and returns
 * the server; `bindClientConnect` runs a callback per connection to that
 * namespace; `bindMessageHandlers` routes one client's packets to handlers;
 * `bindClientDisconnect` runs once when that client goes; `close(server)` stops
 * a server; `dispose()` is NestJS's shutdown hook.
 *
 * Where a gateway gets the server: `handleConnection(client, server)` always
 * receives the live one. `@WebSocketServer()` and `afterInit(server)` receive
 * what `create()` returned when NestJS connected the gateway — for a gateway
 * on a port of its own that is its server, but for one sharing the HTTP server
 * it is `undefined`, because `app.listen()` connects gateways before the HTTP
 * server starts.
 */
import type {
  BunRequest,
  BunResponse,
  JsonValue,
  RouterMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import type {
  BunWebSocketServerType,
  WebSocketClient,
  WebSocketClientData,
  WsAckFunction,
} from "@kingsleyweb/bun-nest";
import type { WsMessageHandler } from "@nestjs/common";
import type {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WsResponse,
} from "@nestjs/websockets";
import { BunRouter, getPort } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunWebSocketAdapter,
  MessageEventTypes,
} from "@kingsleyweb/bun-nest";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { check } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { connect, tryConnect } from "./fixtures/ws-client";
import "reflect-metadata";

/** What `customDataToWsClientFn` stores on every connection, as `client.data.custom`. */
interface Session {
  /** When the upgrade was accepted, in epoch milliseconds. */
  connectedAt: number;
  /** The `?room=` the client asked for; `"lobby"` when it did not. */
  room: string;
}

/** The user the auth middleware attaches to the upgrade request. */
interface User {
  /** The user's id. */
  id: string;
  /** The user's display name. */
  name: string;
}

/** A client of this app: its `data.custom` is a {@link Session}. */
type Client = WebSocketClient<Session>;

/** Tokens the auth middleware accepts, and whom they belong to. */
const USERS: Record<string, User> = {
  "t-alice": { id: "u1", name: "Alice" },
  "t-bob": { id: "u2", name: "Bob" },
  "t-carol": { id: "u3", name: "Carol" },
};

/** A free port for the gateway that listens on its own. Needed before the class is declared. */
const METRICS_PORT = await getPort();

/** Encodes one `EVENT` packet. */
function eventPacket(event: string, payload: JsonValue): string {
  return JSON.stringify({
    type: MessageEventTypes.EVENT,
    namespace: "/",
    data: [event, payload],
  });
}

@WebSocketGateway()
class LobbyGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  /** What `@WebSocketServer()` injected: `undefined` for a gateway on the shared server. */
  @WebSocketServer()
  server: BunWebSocketServerType<Session> | undefined;

  /** The server `handleConnection` received — the live one. */
  live: BunWebSocketServerType<Session> | undefined;

  /** Every open connection, for broadcasting to all of them. */
  readonly clients = new Set<Client>();

  afterInit(server: BunWebSocketServerType<Session> | undefined): void {
    show(
      "LobbyGateway afterInit server",
      server === undefined ? "undefined" : "a server",
    );
  }

  handleConnection(client: Client, server: BunWebSocketServerType<Session>) {
    this.live = server;
    this.clients.add(client);
    client.subscribe(client.data.custom.room);
  }

  handleDisconnect(client: Client): void {
    this.clients.delete(client);
  }

  /** Everything the upgrade put on `client.data`. */
  @SubscribeMessage("profile")
  profile(
    @ConnectedSocket() client: Client,
  ): WsResponse<
    Pick<
      WebSocketClientData<Session>,
      "user" | "custom" | "path" | "search" | "hash" | "originalUrl" | "host"
    >
  > {
    return {
      event: "profile",
      data: {
        user: client.data.user,
        custom: client.data.custom,
        path: client.data.path,
        search: client.data.search,
        hash: client.data.hash,
        originalUrl: client.data.originalUrl,
        host: client.data.host,
      },
    };
  }

  /** To one room, through Bun's pub/sub. */
  announce(room: string, text: string): void {
    this.live?.publish(room, eventPacket("announcement", text));
  }

  /** To every connection, one by one. */
  broadcast(text: string): void {
    for (const client of this.clients) {
      client.send(eventPacket("broadcast", text));
    }
  }
}

@WebSocketGateway({ namespace: "/rooms" })
class RoomsGateway {
  @SubscribeMessage("where")
  where(@ConnectedSocket() client: Client): WsResponse<string> {
    return { event: "here", data: client.data.path };
  }
}

@WebSocketGateway(METRICS_PORT)
class MetricsGateway {
  /** A gateway on its own port gets its own server injected. */
  @WebSocketServer()
  server: BunWebSocketServerType<Session> | undefined;

  @SubscribeMessage("stats")
  stats(): WsResponse<{ port: number | undefined }> {
    return { event: "stats", data: { port: this.server?.port } };
  }
}

@Module({ providers: [LobbyGateway, RoomsGateway, MetricsGateway] })
class AppModule {}

title("Adapter options");

/* ------------------------------------------------------------------ */
step("The HTTP adapter's `websocket` option tunes its built-in adapter");

const httpAdapter = new BunHttpAdapter<Session>(0, {
  websocket: {
    newInstance: false,
    // Bun's WebSocketHandler settings. Defaults: 30s, 1 MiB, deflate on.
    wsOptions: { idleTimeout: 120, maxPayloadLength: 64 * 1024 },
    // Runs on every upgrade; the result is `client.data.custom`.
    customDataToWsClientFn: (req: BunRequest): Session => {
      const room = new URLSearchParams(req.search).get("room") ?? "lobby";
      return { connectedAt: Date.now(), room };
    },
  },
});
const adapter = httpAdapter.webSocketAdapter;
show("wsHandler settings", {
  idleTimeout: adapter.wsHandler.idleTimeout,
  maxPayloadLength: adapter.wsHandler.maxPayloadLength,
  perMessageDeflate: adapter.wsHandler.perMessageDeflate,
});

const app = await NestFactory.create(AppModule, httpAdapter, {
  logger: false,
});

/* ------------------------------------------------------------------ */
step("Auth on upgrade: middleware runs before the upgrade route");

/** Refuses an upgrade without a known `?token=`, and attaches its user otherwise. */
const authenticateUpgrade: RouterMiddlewareHandler = (
  req: BunRequest,
  res: BunResponse,
  next,
) => {
  if (req.headersObj.get("upgrade")?.toLowerCase() !== "websocket") {
    next();
    return;
  }

  const token = new URLSearchParams(req.search).get("token");
  const user = token ? USERS[token] : undefined;
  if (!user) {
    res.status(401).send("unknown token");
    return;
  }

  // `client.data.user` is taken from `req.user`.
  Object.assign(req, { user });
  next();
};
app.use(authenticateUpgrade);

app.useWebSocketAdapter(adapter);
await app.listen(0);

const lobby = app.get(LobbyGateway);
const base = `ws://127.0.0.1:${httpAdapter.listeningPort}`;

show("no token", (await tryConnect(`${base}/`)) ? "accepted" : "refused");
show(
  "bad token",
  (await tryConnect(`${base}/?token=nope`)) ? "accepted" : "refused",
);

const alice = await connect(`${base}/?token=t-alice&room=kitchen`);
alice.emit("profile");
show("alice's client.data", await alice.nextEvent("profile"));

/* ------------------------------------------------------------------ */
step("A namespace is a URL path; each gateway hears only its own");

const roomsClient = await connect(`${base}/rooms?token=t-bob`);
roomsClient.emit("where");
show("/rooms answers", await roomsClient.nextEvent("here"));

roomsClient.emit("profile"); // LobbyGateway's event — not reachable from /rooms
roomsClient.emit("where");
await waitFor(
  "the second answer",
  () => roomsClient.payloadsOf("here").length === 2,
);
show("profile replies on /rooms", roomsClient.payloadsOf("profile").length);

show(
  "a path no gateway serves",
  (await tryConnect(`${base}/nowhere?token=t-bob`)) ? "accepted" : "refused",
);

/* ------------------------------------------------------------------ */
step("@WebSocketGateway(port): a gateway on a server of its own");

const metrics = app.get(MetricsGateway);
show("MetricsGateway @WebSocketServer() port", metrics.server?.port);
show(
  "LobbyGateway @WebSocketServer()",
  lobby.server === undefined ? "undefined" : "a server",
);

const metricsClient = await connect(
  `ws://127.0.0.1:${METRICS_PORT}/?token=t-carol`,
);
metricsClient.emit("stats");
show("stats", await metricsClient.nextEvent("stats"));

// A port is a boundary between gateways, as with socket.io. LobbyGateway also
// serves "/", but only on the HTTP server: this connection is not its, so
// neither its handleConnection nor its "profile" handler runs for it.
metricsClient.emit("profile");
metricsClient.emit("stats"); // answered after "profile" would have been
await waitFor(
  "the second stats answer",
  () => metricsClient.payloadsOf("stats").length === 2,
);
show("LobbyGateway connections (alice only)", lobby.clients.size);
show(
  "profile replies on the metrics port",
  metricsClient.payloadsOf("profile").length,
);
check(
  "a gateway port's client reaches only that port's gateway",
  lobby.clients.size === 1 && metricsClient.payloadsOf("profile").length === 0,
  { lobby: lobby.clients.size, profiles: metricsClient.payloadsOf("profile") },
);

// And the other way: MetricsGateway does not answer on the HTTP server.
alice.emit("stats");
alice.emit("profile"); // LobbyGateway answers, after "stats" would have been
await waitFor(
  "alice's second profile",
  () => alice.payloadsOf("profile").length === 2,
);
check(
  "an HTTP-server client does not reach the gateway port's gateway",
  alice.payloadsOf("stats").length === 0,
  alice.payloadsOf("stats"),
);
await metricsClient.close();

/* ------------------------------------------------------------------ */
step("Broadcasting: to a room with server.publish, to everyone with a Set");

const bob = await connect(`${base}/?token=t-bob&room=kitchen`);
const carol = await connect(`${base}/?token=t-carol`); // the lobby
await waitFor("three lobby connections", () => lobby.clients.size === 3);

lobby.announce("kitchen", "dinner is ready");
show("alice (kitchen) hears", await alice.nextEvent("announcement"));
show("bob (kitchen) hears", await bob.nextEvent("announcement"));

lobby.broadcast("closing in a minute");
for (const [name, client] of [
  ["alice", alice],
  ["bob", bob],
  ["carol", carol],
] as const) {
  show(`${name} hears`, await client.nextEvent("broadcast"));
}
show(
  "carol heard the kitchen announcement",
  carol.payloadsOf("announcement").length > 0,
);

for (const client of [alice, bob, carol, roomsClient, metricsClient]) {
  await client.close();
}
await waitFor("the lobby to empty", () => lobby.clients.size === 0);
await app.close();

/* ------------------------------------------------------------------ */
step(
  "By hand, on an HTTP server: create, bindClientConnect, bindMessageHandlers, bindClientDisconnect",
);

const plain = new BunHttpAdapter();
await plain.listen(0);
const raw = plain.webSocketAdapter;

// Port 0: ride the HTTP adapter's server, which is listening, so it is returned.
const shared = raw.create(0, { namespace: "/raw", transport: [] });
show("create(0) returned the HTTP server", shared === plain.getBunServer());

/** How each disconnect was reported. */
const disconnects: { code: number; reason: string }[] = [];

raw.bindClientConnect(shared, (client, server) => {
  show(`connected to ${client.data.path} on port ${server?.port}`);

  // Without NestJS nothing pre-binds the client: a callback gets the payload,
  // then the ack callback when the packet carried an id.
  const handlers: WsMessageHandler<string>[] = [
    {
      message: "sum",
      isAckHandledManually: false,
      callback: async (numbers: number[]) => {
        return { event: "sum", data: numbers.reduce((a, b) => a + b, 0) };
      },
    },
    {
      message: "save",
      isAckHandledManually: true,
      callback: async (
        item: JsonValue,
        ack?: WsAckFunction<[status: string, item: JsonValue]>,
      ) => {
        ack?.("saved", item);
      },
    },
  ];
  raw.bindMessageHandlers(client, handlers);

  raw.bindClientDisconnect(client, (_client, code, reason) => {
    disconnects.push({ code, reason });
  });
});

const handClient = await connect(`ws://127.0.0.1:${plain.listeningPort}/raw`);
handClient.emit("sum", [1, 2, 3]);
show("sum", await handClient.nextEvent("sum"));
handClient.emit("save", { title: "draft" }, { id: 3 });
show(
  "ack",
  await handClient.next("ACK 3", (packet) => {
    return packet.type === MessageEventTypes.ACK && packet.id === 3;
  }),
);

await handClient.close(4000, "done for now");
await waitFor("the disconnect callback", () => disconnects.length === 1);
show("disconnect", disconnects[0]);

// close(server) on the shared HTTP server closes this adapter's WebSocket
// connections and detaches the gateways bound there, but leaves the HTTP
// server to its owner (a dedicated server — a gateway port — is stopped).
const lingering = await connect(`ws://127.0.0.1:${plain.listeningPort}/raw`);
raw.close(shared);
raw.dispose(); // NestJS's shutdown hook; nothing to release here
await waitFor("close() to close it", () => lingering.closed() !== undefined);
show("an open connection after close()", lingering.closed());
show(
  "the HTTP server still answers",
  (await fetch(`http://127.0.0.1:${plain.listeningPort}/nope`)).status,
);
await plain.close();

/* ------------------------------------------------------------------ */
step("Standalone: `newInstance: true` binds a server of its own");

const ownPort = await getPort();
const router = new BunRouter();
router.get("/health", (_req, res) => {
  res.send("ok");
});

const standalone = new BunWebSocketAdapter({
  newInstance: true,
  listen: { port: ownPort },
  router, // HTTP routes on it are served on the same port
  wsOptions: { idleTimeout: 10 },
});
show("listening at construction on", standalone.getServer()?.port);

const own = standalone.create(ownPort, { transport: [] }); // namespace "/"
standalone.bindClientConnect(own, (client) => {
  standalone.bindMessageHandlers(client, [
    {
      message: "time",
      isAckHandledManually: false,
      callback: async () => {
        return { event: "time", data: new Date(0).toISOString() };
      },
    },
  ]);
});

show(
  "GET /health",
  await (await fetch(`http://127.0.0.1:${ownPort}/health`)).text(),
);
const standaloneClient = await connect(`ws://127.0.0.1:${ownPort}/`);
standaloneClient.emit("time");
show("time", await standaloneClient.nextEvent("time"));

await standaloneClient.close();
standalone.close(own);
standalone.dispose();
show("closed");
