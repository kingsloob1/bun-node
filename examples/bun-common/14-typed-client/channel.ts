/**
 * A typed WebSocket channel — one `channelContract()` module shared by the
 * server's `defineChannel()` and the client's `channel()`: typed and checked
 * sends, pushes, a request/reply, and a reconnect that re-subscribes. Each
 * behaviour is asserted.
 *
 * ```bash
 * bun 14-typed-client/channel.ts
 * ```
 *
 * - **One declaration**: `helpers/chat.contract.ts` has no server code in it,
 *   so a browser bundle can import it. The server serves it with
 *   `defineChannel(chat)`; the client opens it with `channel(api, chat, …)`.
 * - **Direction**: the client sends what the server `receives` and receives
 *   what it `sends`. `room.send("typing")` / `room.on("someoneTyping", …)` are
 *   typed from the contract; `request("say", …)` exists only because
 *   `replies` maps `say`.
 * - **A bad send is refused before anything is written** (`ValidationError`).
 * - **Reconnect**: a dropped socket reconnects with backoff; a request waiting
 *   on it rejects with `DisconnectedError`, unless `retry: true`, which sends
 *   it again; `resubscribe` runs after every open.
 * - **One socket per URL**: `channel()` twice on one URL shares the socket,
 *   so two users of one process differ in the query (`?name=`).
 */
import type { ServerWebSocket } from "bun";
import { createClient, ValidationError } from "@kingsleyweb/bun-client";
import { channel, DisconnectedError } from "@kingsleyweb/bun-client/channel";
import {
  BunHttpAdapter,
  defineChannel,
  noopLogger,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { chat } from "./helpers/chat.contract";

title("A typed WebSocket channel");

/* ------------------------------------------------------------------ */
step("The server: defineChannel on the shared contract");

const room = defineChannel(chat);
const adapter = new BunHttpAdapter(0, { logger: noopLogger });

/** What the server received, in order. */
const received: string[] = [];
/** The sockets open now, to drop on purpose below. */
const sockets = new Set<ServerWebSocket<unknown>>();
/** How many sockets ever opened. */
let opened = 0;

adapter.webSocketAdapter.on("open", (ws) => {
  if (ws.data.route !== room.path) return;
  opened++;
  sockets.add(ws);
  ws.subscribe(`room:${String(ws.data.params?.room)}`);
});
adapter.webSocketAdapter.on("close", (ws) => void sockets.delete(ws));

adapter.ws(
  room.path,
  room.checks(),
  room.handler({
    say(ws, msg) {
      received.push(`say:${msg.text}`);
      const line = { by: String(ws.data.params.room), text: msg.text };
      void room.publish(ws, `room:${ws.data.params.room}`, "said", line); // the others
      return line; // the reply to this request
    },
    typing(ws) {
      received.push("typing");
      void room.publish(ws, `room:${ws.data.params.room}`, "someoneTyping", {
        by: "someone",
      });
    },
  }),
  room.options(),
);
const server = await adapter.listen(0);
const api = createClient({ baseUrl: `http://127.0.0.1:${server.port}` });

try {
  /* ---------------------------------------------------------------- */
  step("Two clients in a room: a send, a push and a request/reply");

  // One socket per URL: bob's query keeps his socket apart from alice's.
  const states: string[] = [];
  let resubscribed = 0;
  const alice = channel(api, chat, {
    params: { room: "lobby" },
    reconnect: { initialMs: 10, maxMs: 20 },
    resubscribe: () => void resubscribed++,
  });
  const bob = channel(api, chat, {
    params: { room: "lobby" },
    query: { as: "bob" },
  });
  alice.on("$state", (state) => void states.push(state));

  const typing: string[] = [];
  const heard: { by: string; text: string }[] = [];
  bob.on("someoneTyping", (data) => void typing.push(data.by));
  bob.on("said", (line) => void heard.push(line));

  await waitFor(
    "both sockets are open",
    () => alice.state === "open" && bob.state === "open",
  );

  alice.send("typing"); // a `null` message: no data
  await waitFor("bob to hear the typing push", () => typing.length === 1);
  checkEqual("bob's push is typed ({ by })", typing, ["someone"]);

  const reply = await alice.request("say", { text: "hello" });
  show("alice's reply", reply);
  checkEqual("request() resolves the `said` reply, typed as Line", reply, {
    by: "lobby",
    text: "hello",
  });
  await waitFor("bob to hear the line", () => heard.length === 1);
  checkEqual("the others got the publish", heard, [
    { by: "lobby", text: "hello" },
  ]);

  /* ---------------------------------------------------------------- */
  step("A bad send is refused before it is written");

  const before = received.length;
  await checkRejects(
    "an empty text fails the contract",
    () => {
      alice.send("say", { text: "" });
      return Promise.resolve();
    },
    { name: "ValidationError" },
  );
  try {
    alice.send("say", { text: "" });
  } catch (error) {
    check(
      "the error carries the issue's path",
      error instanceof ValidationError && error.issues[0]?.path === "text",
      error,
    );
  }
  await Bun.sleep(50);
  checkEqual("and the server received nothing", received.length, before);

  /* ---------------------------------------------------------------- */
  step("Reconnect: the socket drops, the channel comes back");

  const waiting = alice
    .request("say", { text: "never answered?" })
    .catch((error: unknown) => error);
  // Drop alice's sockets (and bob's, which are not under test) as a restart would.
  for (const socket of sockets) socket.close(1011, "restart");
  const dropped = await waiting;
  // Either the request was answered just before the drop, or it was cut off:
  // the cut-off one is a DisconnectedError, never a hang.
  check(
    "the waiting request settled",
    dropped instanceof DisconnectedError ||
      (dropped as { text?: string }).text !== undefined,
    dropped,
  );
  await waitFor(
    "alice to reconnect",
    () => alice.state === "open" && opened >= 4,
  );
  show("alice's states", states);
  checkEqual("open → reconnecting → open", states.slice(0, 3), [
    "open",
    "reconnecting",
    "open",
  ]);
  checkEqual("resubscribe ran after each open", resubscribed, 2);

  // (`retry: true` on a request would resend one that a drop cut off.)
  const again = alice.request("say", { text: "after the drop" });
  checkEqual(
    "a request after the reconnect is answered",
    (await again).text,
    "after the drop",
  );

  alice.close();
  bob.close();

  /* ---------------------------------------------------------------- */
  step("The type-level half");

  const refused = (): void => {
    // @ts-expect-error -- "shout" is not a message the server receives
    alice.send("shout", { text: "hi" });
    // @ts-expect-error -- `text` is a string
    alice.send("say", { text: 7 });
    // @ts-expect-error -- `typing` carries no data
    alice.send("typing", { text: "x" });
    // @ts-expect-error -- `typing` has no reply in `replies`, so it cannot be requested
    void alice.request("typing");
    // @ts-expect-error -- "said" is a push the server sends; the client cannot send it
    alice.send("said", { by: "a", text: "b" });
    // @ts-expect-error -- "someoneTyping" is a payload { by: string }, not a number
    bob.on("someoneTyping", (data: number) => void data);
  };
  void refused;
  show("six refusals at compile time (see the source)");
} finally {
  await adapter.close();
}

summary();
