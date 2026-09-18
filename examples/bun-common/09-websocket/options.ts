/**
 * WebSocket options — every field of `BunWebSocketOptions`, in both of its
 * shapes, and what each one changes on a real connection.
 *
 * ```bash
 * bun 09-websocket/options.ts
 * ```
 *
 * `BunWebSocketOptions` is a union, told apart by `newInstance`:
 *
 * - `BunWebSocketNormalOptions` (`newInstance: false`) rides on a server
 *   somebody else owns, found through `getServer()`. `BunHttpAdapter` builds
 *   one of these for you and merges its own `websocket` option over it.
 * - `BunWebSocketCreateServerOptions` (`newInstance: true`) binds a
 *   `Bun.serve` of its own on `listen`, which serves the router's HTTP routes
 *   as well as its upgrades.
 *
 * Both share `BunWebSocketGeneralOptions`: `wsOptions` (Bun's
 * `WebSocketHandler` settings), `router` and `onUpgrade`.
 *
 * `wsOptions` is merged over defaults that are *not* Bun's:
 * `perMessageDeflate: true` (Bun: `false`), `idleTimeout: 30` (Bun: `120`) and
 * `maxPayloadLength: 1 MB` (Bun: 16 MB).
 *
 * The idle-timeout section waits for Bun's idle timer, so this example takes
 * several seconds.
 */
import type {
  BunWebSocketHandlerType,
  WebSocketClient,
} from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunRouter,
  BunWebSocket,
  getPort,
} from "@kingsleyweb/bun-common";
import { show, step, title, waitFor } from "../shared/console";
import { connect } from "./helpers/client";

/** What the standalone server's connections carry in `ws.data.custom`. */
interface Feed {
  /** The channel asked for with `?channel=`. */
  channel: string;
}

/** What the tuned adapter's connections carry in `ws.data.custom`. */
interface Origin {
  /** Which `onUpgrade` hook produced it: the adapter's or the route's. */
  source: "adapter" | "route";
}

/** The `WebSocketHandler` settings of a `BunWebSocket`, without its callbacks. */
function settingsOf<T>(handler: BunWebSocketHandlerType<T>) {
  return {
    perMessageDeflate: handler.perMessageDeflate,
    idleTimeout: handler.idleTimeout,
    maxPayloadLength: handler.maxPayloadLength,
    backpressureLimit: handler.backpressureLimit,
    closeOnBackpressureLimit: handler.closeOnBackpressureLimit,
    publishToSelf: handler.publishToSelf,
    sendPings: handler.sendPings,
  };
}

/**
 * Subscribes to `room` on open and says so; publishes `pub:<text>` messages to
 * the room; answers anything else with its size.
 */
const roomHandler: BunWebSocketHandlerType = {
  open(ws) {
    ws.subscribe("room");
    ws.sendText(`subscribed ${JSON.stringify(ws.data.custom)}`);
  },
  message(ws, message) {
    if (typeof message === "string" && message.startsWith("pub:")) {
      ws.publish("room", message.slice(4));
      ws.sendText("published");
      return;
    }
    ws.sendText(`got ${message.length} bytes`);
  },
};

title("WebSockets: options");

/* ------------------------------------------------------------------ */
step("The defaults, and `wsOptions` merged over them");

show("defaults", settingsOf(new BunHttpAdapter(0).webSocketAdapter.wsHandler));

const tuned = new BunHttpAdapter<Origin>(0, {
  websocket: {
    wsOptions: {
      // `true`/`false`, or per-direction compressor settings.
      perMessageDeflate: { compress: "shared", decompress: true },
      maxPayloadLength: 1024, // the largest message a client may *send*
      idleTimeout: 4, // seconds without traffic before the idle timer fires
      sendPings: true, // at idle, ping the client instead of dropping it
      backpressureLimit: 256 * 1024, // bytes queued per connection
      closeOnBackpressureLimit: false, // past it, drop messages, not the connection
      publishToSelf: true, // `ws.publish` reaches the sender too
    },
    // Adapter-wide: every `ws()` route without its own function uses this.
    onUpgrade: () => {
      return { custom: { source: "adapter" } };
    },
  },
});
show("tuned", settingsOf(tuned.webSocketAdapter.wsHandler));

/* ------------------------------------------------------------------ */
step("`getServer` and `router`: riding on the adapter's server");

show(
  "getServer() before listen() — nothing to ride on yet",
  tuned.webSocketAdapter.getServer(),
);

/** The server side of each connection, by its `x-id` request header. */
const serverSide = new Map<string, WebSocketClient<Origin>>();
/** Events the tuned adapter's `BunWebSocket` emitted, by name. */
const tunedEvents: string[] = [];
tuned.webSocketAdapter.on("open", (ws) => {
  serverSide.set(ws.data.headers.get("x-id") ?? "", ws);
});
tuned.webSocketAdapter.on("pong", () => {
  tunedEvents.push("pong");
});
tuned.webSocketAdapter.on("drain", () => {
  tunedEvents.push("drain");
});

tuned.ws("/room", roomHandler);
// A route's own `onUpgrade` wins over the adapter's.
tuned.ws("/vip", roomHandler, {
  onUpgrade: () => {
    return { custom: { source: "route" } satisfies Origin };
  },
});

await tuned.listen(0);
const tunedUrl = tuned.url.replace(/^http/, "ws");
show(
  "getServer() after listen() is the adapter's server",
  tuned.webSocketAdapter.getServer() === tuned.server,
);
show(
  "router is the adapter, which knows its BunWebSocket",
  tuned.webSocketAdapter.router === tuned &&
    tuned.getBunWebsocket() === tuned.webSocketAdapter,
);

/* ------------------------------------------------------------------ */
step("`onUpgrade`: adapter-wide, or per route");

const regular = await connect(`${tunedUrl}/room`);
const vip = await connect(`${tunedUrl}/vip`);
show(
  "/room",
  await regular.waitForText("subscribed", (text) => {
    return text.startsWith("subscribed");
  }),
);
show(
  "/vip",
  await vip.waitForText("subscribed", (text) => text.startsWith("subscribed")),
);

/* ------------------------------------------------------------------ */
step("`publishToSelf`");

vip.socket.send("pub:hello, room");
await regular.waitForText("the publish", (text) => text === "hello, room");
await vip.waitForText("the acknowledgement", (text) => text === "published");
show(
  "the sender received its own publish",
  vip.texts().includes("hello, room"),
);

/* ------------------------------------------------------------------ */
step("`perMessageDeflate`");

show("negotiated with a client that offers it", regular.socket.extensions);
const plainClient = await connect(`${tunedUrl}/room`, {
  perMessageDeflate: false,
});
show(
  "with a client that does not",
  JSON.stringify(plainClient.socket.extensions),
);
plainClient.socket.close();

/* ------------------------------------------------------------------ */
step("`maxPayloadLength`");

regular.socket.send("x".repeat(512));
show(
  "a 512-byte message",
  await regular.waitForText("the size", (text) => text === "got 512 bytes"),
);
regular.socket.send("x".repeat(4096));
show("a 4 KB message closes the connection", await regular.waitClosed());

/* ------------------------------------------------------------------ */
step("`backpressureLimit` and `drain`");

const slow = await connect(`${tunedUrl}/room`, { headers: { "x-id": "slow" } });
await slow.waitForText("subscribed", (text) => text.startsWith("subscribed"));
await waitFor("the server side of the slow client", () => {
  return serverSide.has("slow");
});
const slowSide = serverSide.get("slow");
if (!slowSide) {
  throw new Error("no server side for the slow client");
}

// A paused client stops reading, so the server's queue grows: `-1` means
// queued, and once the queue passes `backpressureLimit`, `0` means dropped.
slow.socket.pause();
const chunk = new Uint8Array(64 * 1024);
const statuses: number[] = [];
while (statuses.length < 4000) {
  const status = slowSide.sendBinary(chunk, false);
  statuses.push(status);
  if (status === 0) {
    break;
  }
}
show("sends until one was dropped", statuses.length);
show("the last few statuses", statuses.slice(-4));
show("still open (closeOnBackpressureLimit: false)", slowSide.readyState === 1);

const before = slow.messages.length;
slow.socket.resume();
await waitFor("drain", () => tunedEvents.includes("drain"));
const delivered = statuses.filter((status) => status !== 0).length;
await waitFor("every chunk that was not dropped", () => {
  return slow.messages.length - before === delivered;
});
show("chunks delivered after resuming", slow.messages.length - before);
slow.socket.close();

// With `closeOnBackpressureLimit: true` the connection itself is closed at
// the limit instead — see 12-options/websocket-options.ts.

/* ------------------------------------------------------------------ */
step("`idleTimeout` and `sendPings`");

const lean = new BunHttpAdapter(0, {
  websocket: {
    wsOptions: { idleTimeout: 4, sendPings: false, perMessageDeflate: false },
  },
});
lean.ws("/room", roomHandler);
await lean.listen(0);

const kept = await connect(`${tunedUrl}/room`);
const dropped = await connect(`${lean.url.replace(/^http/, "ws")}/room`);
show(
  "perMessageDeflate: false negotiates nothing",
  JSON.stringify(dropped.socket.extensions),
);

show("waiting for both idle timers…");
await Promise.all([
  waitFor("the idle ping to be answered", () => tunedEvents.includes("pong"), {
    timeout: 30_000,
  }),
  dropped.waitClosed({ timeout: 30_000 }),
]);
show(
  "sendPings: true — pinged, answered, still open",
  kept.closed === undefined,
);
show("sendPings: false — closed when idle", dropped.closed);

/* ------------------------------------------------------------------ */
step("`BunWebSocketCreateServerOptions`: a standalone server");

const feedRouter = new BunRouter();
feedRouter.get("/health", (_req, res) => {
  res.send("ok");
});

const standalone = new BunWebSocket<Feed>({
  newInstance: true,
  router: feedRouter, // its HTTP routes and upgrade routes are served here
  // `0` lets the OS pick a free port; `standalone.port` reports the bound one.
  listen: { host: "127.0.0.1", port: 0 },
  // Base `Bun.serve` options; `port`/`hostname`/`fetch`/`websocket` are managed.
  serverOptions: { maxRequestBodySize: 1024 },
  // How this server builds each `BunRequest` (default: parse body, query, cookies).
  bunRequestOpts: { parseBody: false, parseQuery: true, parseCookies: false },
  wsOptions: { perMessageDeflate: false },
  onUpgrade: (req) => {
    return { custom: { channel: String(req.query.channel ?? "general") } };
  },
  // Not used here: `request` and `response` hand the server one pre-built
  // `BunRequest`/`BunResponse` to reuse for *every* fetch — a fixture, not
  // something a live server wants.
});
feedRouter.ws("/feed", {
  open(ws) {
    ws.sendText(`feed for ${(ws.data.custom as Feed).channel}`);
  },
  message() {},
});

const feedServer = standalone.getServer();
const feedPort = Number(standalone.port);
const httpOrigin = `http://127.0.0.1:${feedPort}`;
show("bound to", `${feedServer?.hostname}:${feedServer?.port}`);
show("GET /health", await (await fetch(`${httpOrigin}/health`)).text());
show(
  "POST past serverOptions.maxRequestBodySize",
  (
    await fetch(`${httpOrigin}/health`, {
      method: "POST",
      body: "x".repeat(4096),
    })
  ).status,
);

const feed = await connect(`ws://127.0.0.1:${feedPort}/feed?channel=releases`);
show(
  "the feed says",
  await feed.waitForText("the greeting", (text) => text.startsWith("feed")),
);
feed.socket.close();
await feed.waitClosed();

/* ------------------------------------------------------------------ */
step("An extra port on an attached BunWebSocket");

// What a NestJS gateway with its own port does: the same router and handlers,
// served on a dedicated server. Port `0` (or the shared port) is the shared
// server instead.
const extraPort = await getPort();
const extra = tuned.webSocketAdapter.getOrCreateWebsocketServer(extraPort);
show(
  "port 0 is the shared server",
  tuned.webSocketAdapter.getOrCreateWebsocketServer(0) === tuned.server,
);
show("the extra port has its own server", extra?.port === extraPort);

const viaExtra = await connect(`ws://127.0.0.1:${extraPort}/vip`);
show(
  "a client on the extra port reaches the same route",
  await viaExtra.waitForText("subscribed", (text) => {
    return text.startsWith("subscribed");
  }),
);
viaExtra.socket.close();
await viaExtra.waitClosed();

/* ------------------------------------------------------------------ */
step("Shutting down");

for (const client of [vip, kept]) {
  client.socket.close();
}
await Promise.all([vip.waitClosed(), kept.waitClosed()]);

// `killServer` force-stops a server (`stop(true)`, so no keep-alive connection
// lingers) and forgets it.
tuned.webSocketAdapter.killServer(extra);
standalone.killServer(feedServer);

await tuned.close();
await lean.close();
show("closed");
