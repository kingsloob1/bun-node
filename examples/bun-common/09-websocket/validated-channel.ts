/**
 * A validated WebSocket channel — `defineChannel` on the contract core: one
 * declaration gives the upgrade's request checks, every incoming frame's
 * validation, typed and checked `send`/`publish`, and the error frames a bad
 * message is answered with. Each behaviour is asserted.
 *
 * ```bash
 * bun 09-websocket/validated-channel.ts
 * ```
 *
 * A channel is a contract keyed by the message's `type` on both sides, with
 * one part, `data`:
 *
 * - **Incoming**: a text frame is parsed as JSON and checked against
 *   `receives`. An invalid frame is answered with an error frame —
 *   `{ type: "error", id?, code: "VALIDATION", status: 400, issues }`, the
 *   issues value-free — and the socket stays open (`closeOnInvalid: true`
 *   closes with `1007` instead). An unknown `type` is answered with
 *   `UNKNOWN_MESSAGE`, a binary frame with `UNSUPPORTED_DATA` unless the
 *   channel declares `binary: true`.
 * - **Outgoing**: `send(ws, type, data)` and `publish(ws, topic, type, data)`
 *   are typed by `sends` and checked under the `out` policy; under `"error"`
 *   (the default) a synchronous vendor's mismatch throws to the caller and
 *   nothing is written.
 * - **The upgrade** is a GET, so its `params`/`query`/`headers`/`cookies` are
 *   checked by `checks()` — a route handler registered with `get()` **before**
 *   the `ws()` route (a `use()` middleware never sees the path's params) —
 *   and a failure is a 400, never a 101.
 */
import type { ServerWebSocket } from "bun";
import type {
  ChannelErrorFrame,
  ChannelMessage,
  WebSocketClient,
  WebSocketClientData,
} from "@kingsleyweb/bun-common";
import { BunHttpAdapter, defineChannel } from "@kingsleyweb/bun-common";
import { z } from "zod";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { connect } from "./helpers/client";
import type { Client } from "./helpers/client";

/** What each connection carries in `ws.data.custom` (the `onUpgrade` hook sets it). */
interface Session {
  /** Who connected, from the `?name=` query parameter. */
  name: string;
}

/** The room topic a connection subscribes to. */
function roomTopic(room: string): string {
  return `room:${room}`;
}

/**
 * The session of a connection inside a channel handler. Channel handlers are
 * typed for any connection, so `ws.data` is `never` there; the `onUpgrade`
 * hook passed to `options()` is what put a `Session` in it.
 */
function sessionOf(ws: ServerWebSocket<never>): Session {
  return (ws.data as WebSocketClientData<Session>).custom;
}

/** The room of a connection, from the route's params. */
function roomOf(ws: ServerWebSocket<never>): string {
  return String((ws.data as WebSocketClientData<Session>).params?.room);
}

/** The frames a client has received, parsed. */
function framesOf(client: Client): (ChannelMessage | ChannelErrorFrame)[] {
  return client
    .texts()
    .map((text) => JSON.parse(text) as ChannelMessage | ChannelErrorFrame);
}

/** Resolves with the first parsed frame satisfying `predicate`. */
async function waitForFrame(
  client: Client,
  what: string,
  predicate: (frame: ChannelMessage | ChannelErrorFrame) => boolean,
): Promise<ChannelMessage | ChannelErrorFrame> {
  const text = await client.waitForText(what, (candidate) => {
    return predicate(JSON.parse(candidate) as ChannelMessage);
  });
  return JSON.parse(text) as ChannelMessage;
}

title("WebSockets: a validated channel");

/* ------------------------------------------------------------------ */
step("The channel, declared once");

const chat = defineChannel({
  path: "/rooms/:room",
  request: {
    // The upgrade's request side: the room name, from the path.
    params: z.object({ room: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
  },
  receives: {
    say: z.object({ text: z.string().min(1).max(200) }),
    typing: null, // no data
  },
  sends: {
    said: z.object({ by: z.string(), text: z.string() }),
    someoneTyping: z.object({ by: z.string() }),
    // No `error` declared: the implicit error frame joins by itself.
  },
  replies: { say: "said" },
  meta: { name: "chat", description: "A validated chat room" },
});

checkEqual("the channel's path", chat.path, "/rooms/:room");
checkEqual(
  "the reply mapping (meta for clients and docs)",
  chat.contract.meta.replies,
  {
    say: "said",
  },
);
checkEqual(
  "the envelope's correlation field",
  chat.contract.meta.envelope.idField,
  "id",
);

/* ------------------------------------------------------------------ */
step("The route: checks first, then the WebSocket route");

const adapter = new BunHttpAdapter<Session>(0);

/** The server side of every open connection, by name. */
const sockets = new Map<string, WebSocketClient<Session>>();
adapter.webSocketAdapter.on("open", (ws) => {
  // This listener hears every path; `ws.data.route` is the matched pattern.
  if (ws.data.route !== chat.path) {
    return;
  }
  sockets.set(ws.data.custom.name, ws);
  ws.subscribe(roomTopic(String(ws.data.params?.room)));
});
adapter.webSocketAdapter.on("close", (ws) => {
  if (ws.data.route === chat.path) {
    sockets.delete(ws.data.custom.name);
  }
});

// The upgrade's request checks — a GET route handler, before the ws route.
adapter.get(chat.path, chat.checks());

adapter.ws(
  chat.path,
  chat.handler({
    say(ws, msg) {
      // `msg` is the parsed data: `{ text: string }`, typed and checked.
      const data = { by: sessionOf(ws).name, text: msg.text };
      chat.publish(ws, roomTopic(roomOf(ws)), "said", data); // the others
      chat.send(ws, "said", data); // the speaker's own line back
    },
    typing(ws) {
      chat.publish(ws, roomTopic(roomOf(ws)), "someoneTyping", {
        by: sessionOf(ws).name,
      });
    },
  }),
  chat.options((req) => ({
    custom: { name: String(req.query.name ?? "anonymous") },
  })),
);

await adapter.listen(0);
const url = `${adapter.url.replace(/^http/, "ws")}/rooms`;
show("listening", adapter.url);

/* ------------------------------------------------------------------ */
step("A bad room is refused before the 101");

const refused = await adapter.fetch("/rooms/Lobby", {
  headers: {
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
  },
});
checkEqual("the upgrade request is answered", refused.status, 400);
const refusal = (await refused.json()) as {
  error?: string;
  issues?: unknown[];
};
checkEqual("the refusal's error", refusal.error, "Validation failed");
check("the refusal carries issues", Array.isArray(refusal.issues));

// A plain GET — not an upgrade — is none of the channel's business: the
// checks pass it through, and nothing else answers it.
const plain = await adapter.fetch("/rooms/lobby");
checkEqual("a plain GET falls through", plain.status, 404);

/* ------------------------------------------------------------------ */
step("A checked message reaches the room");

const ada = await connect(`${url}/lobby?name=ada`);
const bob = await connect(`${url}/lobby?name=bob`);

ada.socket.send(JSON.stringify({ type: "say", data: { text: "hi lobby" } }));

// `publish` excludes the sender, so bob hears ada; ada's own line is the
// handler's `send`.
const bobHeard = await waitForFrame(bob, "ada's hello", (frame) => {
  return frame.type === "said";
});
checkEqual("bob received", bobHeard, {
  type: "said",
  data: { by: "ada", text: "hi lobby" },
});

const adaHeard = await waitForFrame(ada, "her own line", (frame) => {
  return frame.type === "said";
});
checkEqual("ada received her own line, via send", adaHeard, bobHeard);

/* ------------------------------------------------------------------ */
step("A `null` entry: a message with no data");

ada.socket.send(JSON.stringify({ type: "typing" }));
const typing = await waitForFrame(bob, "ada typing", (frame) => {
  return frame.type === "someoneTyping";
});
checkEqual("bob received", typing, {
  type: "someoneTyping",
  data: { by: "ada" },
});

/* ------------------------------------------------------------------ */
step("An invalid frame is answered, and the socket stays open");

// A distinctive bad value, to prove the issues never carry it.
ada.socket.send(
  JSON.stringify({ type: "say", id: "m-1", data: { text: 987654 } }),
);
const invalid = (await waitForFrame(ada, "the validation error", (frame) => {
  return frame.type === "error";
})) as ChannelErrorFrame;
checkEqual("the code", invalid.code, "VALIDATION");
checkEqual("the status", invalid.status, 400);
checkEqual("the frame's id, echoed", invalid.id, "m-1");
check("issues are listed", (invalid.issues?.length ?? 0) > 0);
check(
  "the issues are value-free",
  !JSON.stringify(invalid).includes("987654"),
  invalid,
);
check("the socket stayed open", ada.closed === undefined);

ada.socket.send(JSON.stringify({ type: "nope", id: "m-2" }));
const unknown = (await waitForFrame(
  ada,
  "the unknown-message error",
  (frame) => {
    return frame.type === "error" && (frame as ChannelErrorFrame).id === "m-2";
  },
)) as ChannelErrorFrame;
checkEqual("the code", unknown.code, "UNKNOWN_MESSAGE");
check(
  "the detail names the declared types",
  unknown.detail?.includes("say") === true && unknown.detail.includes("typing"),
  unknown,
);

ada.socket.send(new Uint8Array([1, 2, 3]));
const binary = (await waitForFrame(ada, "the binary refusal", (frame) => {
  return (
    frame.type === "error" &&
    (frame as ChannelErrorFrame).code === "UNSUPPORTED_DATA"
  );
})) as ChannelErrorFrame;
checkEqual("the code", binary.code, "UNSUPPORTED_DATA");

ada.socket.send("this is not JSON");
const garbled = (await waitForFrame(ada, "the parse failure", (frame) => {
  return (
    frame.type === "error" &&
    (frame as ChannelErrorFrame).issues?.some((issue) => {
      return issue.message.includes("JSON");
    }) === true
  );
})) as ChannelErrorFrame;
checkEqual("the code", garbled.code, "VALIDATION");

// The socket is still good: ada can still talk.
ada.socket.send(JSON.stringify({ type: "say", data: { text: "still here" } }));
await bob.waitForText("ada's second line", (text) =>
  text.includes("still here"),
);
check("ada's socket never closed", ada.closed === undefined);

/* ------------------------------------------------------------------ */
step("A socket's frames are handled in order");

for (const text of ["one", "two", "three"]) {
  ada.socket.send(JSON.stringify({ type: "say", data: { text } }));
}
const order: string[] = [];
await waitFor("ada's three lines, in order", () => {
  order.length = 0;
  for (const frame of framesOf(ada)) {
    if (frame.type === "said") {
      order.push(
        (frame as ChannelMessage<"said", { text: string }>).data?.text ?? "",
      );
    }
  }
  const tail = order.slice(-3);
  return tail.join(",") === "one,two,three";
});
checkEqual("the last three lines", order.slice(-3), ["one", "two", "three"]);

/* ------------------------------------------------------------------ */
step("Outgoing messages are checked too");

// The server side of ada's connection, for a direct `send`.
const adaSide = sockets.get("ada");
if (!adaSide) {
  throw new Error("the server has no socket for ada");
}

// `said` wants `{ by: string, text: string }` — a mismatch under the default
// `"error"` policy throws to the caller, and nothing is written.
const before = ada.messages.length;
await checkRejects(
  "a bad send throws to the caller",
  () => {
    chat.send(adaSide as ServerWebSocket<never>, "said", {
      by: "ada",
    } as never);
  },
  { name: "ContractError" },
);
check("nothing was written", ada.messages.length === before);

/* ------------------------------------------------------------------ */
step("Shutting down");

ada.socket.close();
bob.socket.close();
await Promise.all([ada.waitClosed(), bob.waitClosed()]);
await waitFor("the server to see every connection close", () => {
  return sockets.size === 0;
});
await adapter.close();
show("closed");

summary();
