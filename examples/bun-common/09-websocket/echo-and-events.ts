/**
 * WebSockets through the HTTP adapter — an echo server that shows every
 * lifecycle event, the per-connection data, text and binary frames, pings,
 * backpressure and close codes.
 *
 * ```bash
 * bun 09-websocket/echo-and-events.ts
 * ```
 *
 * `adapter.ws(path, handler)` registers an upgrade route on the adapter's
 * router, so an upgrade request goes through the same pipeline as any HTTP
 * request — middleware included. Once a connection is open, each of its
 * events reaches two places, in this order:
 *
 * 1. listeners on `adapter.webSocketAdapter` — a `BunWebSocket`, which is a
 *    typed event emitter — for every connection on the server;
 * 2. the handler object given to `ws()`, for connections on that path only.
 *
 * `open` is emitted under two names, `connect` then `open`; a close as
 * `disconnect` then `close`.
 */
import type { WebSocketClient } from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { show, step, title, waitFor } from "../shared/console";
import { connect } from "./helpers/client";

/** What each connection carries in `ws.data.custom`. */
interface Session {
  /** A short id, fresh per connection. */
  id: string;
  /** Who connected, from the `?name=` query parameter. */
  name: string;
}

/**
 * The session of a connection seen by a `ws()` handler. Those handlers are
 * typed for any connection, so `ws.data.custom` is `unknown` there; the
 * adapter's `customDataToWsClientFn` is what put a `Session` in it.
 */
function sessionOf(ws: WebSocketClient): Session {
  return ws.data.custom as Session;
}

title("WebSockets: echo and every event");

/* ------------------------------------------------------------------ */
step("An adapter whose connections each carry a session");

const adapter = new BunHttpAdapter<Session>(0, {
  websocket: {
    // Runs once per upgrade, with the request and response; what it returns
    // becomes `ws.data.custom`. It may be async.
    customDataToWsClientFn: (req) => {
      return {
        id: crypto.randomUUID().slice(0, 8),
        name: String(req.query.name ?? "anonymous"),
      };
    },
  },
});

/** Everything heard, in order: `event:<name>` from listeners, `route:<name>` from `ws()`. */
const heard: string[] = [];

/** The server side of each open connection, by session name. */
const sockets = new Map<string, WebSocketClient<Session>>();

// Instance listeners: typed with the adapter's `Session`, for every path.
const events = adapter.webSocketAdapter;
events.on("connect", (ws) => {
  heard.push(`event:connect ${ws.data.custom.name}`);
});
events.on("open", (ws) => {
  sockets.set(ws.data.custom.name, ws);
  heard.push(`event:open ${ws.data.custom.name}`);
});
events.on("message", (ws, message) => {
  const kind = typeof message === "string" ? "text" : "binary";
  heard.push(`event:message ${ws.data.custom.name} (${kind})`);
});
events.on("ping", (ws) => {
  heard.push(`event:ping ${ws.data.custom.name}`);
});
events.on("pong", (ws) => {
  heard.push(`event:pong ${ws.data.custom.name}`);
});
events.on("drain", (ws) => {
  heard.push(`event:drain ${ws.data.custom.name}`);
});
events.on("disconnect", (ws, code) => {
  heard.push(`event:disconnect ${ws.data.custom.name} ${code}`);
});
events.on("close", (ws, code) => {
  sockets.delete(ws.data.custom.name);
  heard.push(`event:close ${ws.data.custom.name} ${code}`);
});

// The route: its handlers run after the listeners, for `/echo` only.
adapter.ws("/echo", {
  open(ws) {
    heard.push("route:open");
    ws.sendText(`welcome, ${sessionOf(ws).name}`);
  },
  message(ws, message) {
    heard.push("route:message");

    if (typeof message !== "string") {
      // Binary frames arrive as a Buffer. Send the bytes back reversed.
      ws.sendBinary(Buffer.from(message).reverse());
      return;
    }

    if (message === "close please") {
      ws.close(4001, "you asked"); // 4000–4999 are for applications
    } else if (message === "terminate please") {
      ws.terminate(); // no close frame: the client sees 1006
    } else if (message === "ping me") {
      ws.ping("from the server"); // the client answers with a pong
    } else {
      ws.sendText(`echo: ${message}`);
    }
  },
  ping(_ws, data) {
    heard.push(`route:ping "${data.toString()}"`);
  },
  pong(_ws, data) {
    heard.push(`route:pong "${data.toString()}"`);
  },
  drain() {
    heard.push("route:drain");
  },
  close(_ws, code, reason) {
    heard.push(`route:close ${code} "${reason}"`);
  },
});

await adapter.listen(0);
const url = adapter.url.replace(/^http/, "ws");
show("listening", adapter.url);

// Only a real upgrade request is upgraded; a plain GET falls through the
// route to whatever comes next — here, the 404.
show(
  "a plain GET /echo (not an upgrade)",
  (await adapter.fetch("/echo")).status,
);

/* ------------------------------------------------------------------ */
step("Connecting: the upgrade request becomes `ws.data`");

const ada = await connect(`${url}/echo?name=ada`, {
  headers: { "x-client": "echo-example" },
});
show(
  "ada received",
  await ada.waitForText("the welcome", (text) => text.startsWith("welcome")),
);

const adaSide = sockets.get("ada");
if (!adaSide) {
  throw new Error("the server has no socket for ada");
}

show("ws.data on the server", {
  host: adaSide.data.host, // the request's authority
  path: adaSide.data.path, // pathname only
  search: adaSide.data.search, // `?…`, or ""
  hash: adaSide.data.hash, // always "": clients never send a fragment
  originalUrl: adaSide.data.originalUrl, // path + search + hash
  header: adaSide.data.headers.get("x-client"), // the upgrade request's headers
  user: adaSide.data.user, // `req.user`, when middleware set one
  custom: adaSide.data.custom, // from customDataToWsClientFn
});
show("events so far", heard.splice(0));

/* ------------------------------------------------------------------ */
step("Text and binary frames");

ada.socket.send("hello");
show(
  "text back",
  await ada.waitForText("the echo", (text) => text === "echo: hello"),
);

ada.socket.send(new Uint8Array([1, 2, 3, 4]));
await waitFor("the binary echo", () => {
  return ada.messages.some((message) => message instanceof Uint8Array);
});
const binary = ada.messages.find((message) => message instanceof Uint8Array);
show("binary back, reversed", binary && [...binary]);
show("events", heard.splice(0));

/* ------------------------------------------------------------------ */
step("Pings and pongs");

// A client ping reaches `ping`; Bun answers it with a pong by itself.
ada.socket.ping("are you there?");
await waitFor("the server to hear the ping", () => {
  return heard.some((entry) => entry.startsWith("route:ping"));
});

// A server ping is answered by the client, which reaches `pong`.
ada.socket.send("ping me");
await waitFor("the client's pong", () => {
  return heard.some((entry) => entry.startsWith("route:pong"));
});
show("events", heard.splice(0));

/* ------------------------------------------------------------------ */
step("Backpressure, and `drain`");

// `send` says how it went: bytes written, `-1` when the data was queued
// behind backpressure, `0` when it was dropped. `drain` fires once a queued
// connection can take more. Pausing the client stops it reading, so the
// server's writes back up quickly.
ada.socket.pause();

const chunk = new Uint8Array(256 * 1024);
const statuses: number[] = [];
while (statuses.length < 1000) {
  // `false`: do not compress — a zero-filled chunk would shrink to nothing.
  const status = adaSide.sendBinary(chunk, false);
  statuses.push(status);
  if (status === -1) {
    break;
  }
}
show(`status of send #${statuses.length}`, statuses.at(-1));
show("bytes queued on the server", adaSide.getBufferedAmount());

const receivedBefore = ada.messages.length;
ada.socket.resume();
await waitFor("drain", () => {
  return heard.includes("route:drain");
});
await waitFor("every chunk to arrive", () => {
  return ada.messages.length === receivedBefore + statuses.length;
});
show("chunks received after resuming", ada.messages.length - receivedBefore);
show("events", heard.splice(0));

/* ------------------------------------------------------------------ */
step("Close codes");

// 1. The client closes, with an application code and a reason.
ada.socket.close(4000, "done for today");
show("ada saw", await ada.waitClosed());
await waitFor("the server to see ada leave", () => !sockets.has("ada"));
show("the server heard", heard.splice(0));

// 2. The server closes, with its own code.
const ben = await connect(`${url}/echo?name=ben`);
ben.socket.send("close please");
show("ben saw", await ben.waitClosed());

// 3. The server drops the connection without a close frame.
const cy = await connect(`${url}/echo?name=cy`);
cy.socket.send("terminate please");
show("cy saw", await cy.waitClosed());

await waitFor("the server to forget every connection", () => {
  return sockets.size === 0;
});
show(
  "close events",
  heard.filter((entry) => /close|disconnect/.test(entry)),
);
heard.length = 0;

/* ------------------------------------------------------------------ */
step("`BunWebSocket` is a typed event emitter");

show("listeners on message", events.listenerCount("message"));
show("event names", events.eventNames());

const order: string[] = [];
const prepended = () => {
  order.push("prependListener");
};
const added = () => {
  order.push("addListener");
};
events.prependListener("message", prepended); // runs before existing ones
events.addListener("message", added); // same as `on`
events.once("message", () => {
  order.push("once");
});
events.prependOnceListener("message", () => {
  order.push("prependOnceListener");
});
show("listeners on message now", events.listeners("message").length);

const dee = await connect(`${url}/echo?name=dee`);
dee.socket.send("one");
await dee.waitForText("the first echo", (text) => text === "echo: one");
show("order for the first message", order.splice(0));
dee.socket.send("two");
await dee.waitForText("the second echo", (text) => text === "echo: two");
show("order for the second (the once listeners are gone)", order.splice(0));

events.off("message", prepended);
events.removeListener("message", added);
show("after off / removeListener", events.listenerCount("message"));

// A new emitter starts unlimited (`0`); `setMaxListeners` changes that.
show("getMaxListeners", events.getMaxListeners());
events.setMaxListeners(50);
show("after setMaxListeners(50)", events.getMaxListeners());

// `emit` only calls listeners — no socket is involved — and answers whether
// anyone was listening.
const deeSide = sockets.get("dee");
if (deeSide) {
  show("emit('drain', ws) found listeners", events.emit("drain", deeSide));
}
heard.length = 0;

/* ------------------------------------------------------------------ */
step("Shutting down");

dee.socket.close(1000, "bye");
await dee.waitClosed();
await waitFor("the server to see dee leave", () => sockets.size === 0);

events.removeAllListeners("drain");
show("after removeAllListeners('drain')", events.eventNames());
events.removeAllListeners();
show("after removeAllListeners()", events.eventNames());

await adapter.close();
show("closed");
