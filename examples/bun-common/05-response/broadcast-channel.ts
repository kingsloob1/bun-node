/**
 * Broadcast channels — `createSseChannel()`: one event to many server-sent
 * event streams, with express-sse's conveniences and the writer's guarantees.
 *
 * ```bash
 * bun 05-response/broadcast-channel.ts
 * ```
 *
 * Worth knowing before reading it:
 *
 * - `channel.handler()` is a route handler (express-sse's `sse.init`):
 *   each request opens `res.sse()` and joins the channel; it leaves when its
 *   client does. `channel.subscribe(req, res, opts)` does the same inside a
 *   handler of your own, and `channel.response(request, { server })` serves
 *   a native `Bun.serve` route.
 * - `send()` encodes an event once and queues the same bytes on every
 *   subscriber without waiting for any, so a client that stops reading stalls
 *   no one; its own writer disconnects it past `maxQueuedBytes`. It returns
 *   how many subscribers it reached.
 * - The initial state (`initial`, `setInitial()`, `clearInitial()`) goes to
 *   each new subscriber alone, before any live event, even when computed
 *   asynchronously. express-sse re-sends it to everyone; this does not.
 * - With `replay: N`, events get ids and the last N are kept: a client
 *   reconnecting with a `Last-Event-ID` among them gets what it missed
 *   instead of the initial state. An id the channel does not hold is a
 *   "miss": the initial state again, and a function `initial` is told so.
 * - `topics` route an event to some subscribers; a send without a topic
 *   reaches everyone.
 * - A `transport` (Redis pub/sub, Postgres `LISTEN`, …) carries events
 *   between processes; here two channels share an in-memory bus.
 * - `close()` ends every stream; later requests get `204`, which tells
 *   `EventSource` to stop reconnecting.
 */
import type {
  SseChannelTransport,
  SseItem,
  SseTransportEnvelope,
} from "@kingsleyweb/bun-common/sse";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { createSseChannel, readSse } from "@kingsleyweb/bun-common/sse";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Broadcast channels");

/** A client of an event stream: its events, read with bun-common's parser. */
function client(response: Response) {
  const iterator = readSse(response.body!)[Symbol.asyncIterator]();
  return {
    /** The next `count` events (comments skipped), as `event data`. */
    async next(count: number): Promise<string[]> {
      const out: string[] = [];
      while (out.length < count) {
        const item = await iterator.next();
        if (item.done) break;
        if (item.value.kind === "event") out.push(describe(item.value));
      }
      return out;
    },
    /** The id of the next event. */
    async nextId(): Promise<string> {
      for (;;) {
        const item = await iterator.next();
        if (item.done) return "";
        if (item.value.kind === "event") return item.value.id;
      }
    },
    /** Whether the stream ends next. */
    async ends(): Promise<boolean> {
      for (;;) {
        const item = await iterator.next();
        if (item.done) return true;
        if (item.value.kind === "event") return false;
      }
    },
    /** The client goes away. */
    async leave(): Promise<void> {
      await iterator.return?.();
    },
  };
}

/** An event as `name data`. */
function describe(item: SseItem): string {
  return item.kind === "event" ? `${item.event} ${item.data}` : `:${item.text}`;
}

/* ------------------------------------------------------------------ */
step("A channel, its route, and two clients");

let price = 100;

/** The current book, as a database or another service would answer it. */
async function loadBook(): Promise<{ price: number }> {
  await Bun.sleep(1);
  return { price };
}

const prices = createSseChannel({
  // Each new client's snapshot, loaded when it connects; live events wait
  // for it, so it always arrives first.
  initial: async (context) => [
    {
      event: context.replay === "miss" ? "reset" : "snapshot",
      data: await loadBook(),
    },
  ],
  replay: 50,
  heartbeatMs: 15_000,
});

const app = new BunHttpAdapter(0);
app.get("/prices", prices.handler());
app.get("/rooms/:room", (req, res) => {
  prices.subscribe(req, res, { topics: [`room:${String(req.params.room)}`] });
});
await app.listen(0);

const alice = client(await fetch(`${app.url}/prices`));
const bob = client(await fetch(`${app.url}/prices`));
await waitFor("both subscribed", () => prices.size === 2);
checkEqual("each client gets the snapshot first", await alice.next(1), [
  'snapshot {"price":100}',
]);
checkEqual("…its own copy, at its own connection", await bob.next(1), [
  'snapshot {"price":100}',
]);

price = 101;
checkEqual(
  "send() reaches both, and returns how many",
  prices.send({ event: "tick", data: { price } }),
  2,
);
checkEqual("alice gets the tick", await alice.next(1), ['tick {"price":101}']);
checkEqual("bob too", await bob.next(1), ['tick {"price":101}']);

/* ------------------------------------------------------------------ */
step("sendList(): one event per item, in order");

prices.sendList(["a", "b", "c"], { event: "row" });
checkEqual("alice gets three rows", await alice.next(3), [
  "row a",
  "row b",
  "row c",
]);
await bob.next(3);

/* ------------------------------------------------------------------ */
step("Reconnecting with Last-Event-ID: replay, or a miss");

price = 102;
prices.send({ event: "tick", data: { price } });
const lastSeen = await bob.nextId();
show("bob's last event id", lastSeen);
await bob.leave();
await waitFor("bob gone", () => prices.size === 1);

price = 103;
prices.send({ event: "tick", data: { price } });
price = 104;
prices.send({ event: "tick", data: { price } });

const bobAgain = client(
  await fetch(`${app.url}/prices`, { headers: { "Last-Event-ID": lastSeen } }),
);
checkEqual(
  "bob gets exactly what he missed, no snapshot",
  await bobAgain.next(2),
  ['tick {"price":103}', 'tick {"price":104}'],
);

const stranger = client(
  await fetch(`${app.url}/prices`, {
    headers: { "Last-Event-ID": "an-id-from-yesterday" },
  }),
);
checkEqual(
  "an id the channel does not hold: the initial state, marked by `initial`",
  await stranger.next(1),
  ['reset {"price":104}'],
);
await stranger.leave();
// Alice, connected throughout, got all three ticks.
checkEqual("alice, never gone, got every tick", await alice.next(3), [
  'tick {"price":102}',
  'tick {"price":103}',
  'tick {"price":104}',
]);

/* ------------------------------------------------------------------ */
step("Topics: an event for one room");

const room7 = client(await fetch(`${app.url}/rooms/7`));
await waitFor("room 7 subscribed", () => prices.size === 3);
await room7.next(1); // its snapshot
checkEqual(
  "a topic send reaches its subscribers only",
  prices.send({ event: "chat", data: "hi room 7" }, { topic: "room:7" }),
  1,
);
checkEqual("room 7 gets it", await room7.next(1), ["chat hi room 7"]);
prices.send({ event: "tick", data: { price } });
checkEqual("…and broadcasts too", await room7.next(1), ['tick {"price":104}']);
checkEqual("alice got the broadcast, not the chat", await alice.next(1), [
  'tick {"price":104}',
]);
await room7.leave();
await bobAgain.leave();

/* ------------------------------------------------------------------ */
step("Two processes on one bus");

/** An in-memory bus: each `transport()` is one process; a real one is Redis or Postgres. */
function memoryBus() {
  const listeners = new Set<(envelope: SseTransportEnvelope) => void>();
  return {
    transport: (): SseChannelTransport => ({
      publish: (envelope) => {
        const copy = JSON.parse(
          JSON.stringify(envelope),
        ) as SseTransportEnvelope;
        queueMicrotask(() => {
          for (const listener of listeners) listener(copy);
        });
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
  };
}

const bus = memoryBus();
const east = createSseChannel({ replay: 10, transport: bus.transport() });
const west = createSseChannel({ replay: 10, transport: bus.transport() });
const westApp = new BunHttpAdapter(0);
westApp.get("/prices", west.handler());
await westApp.listen(0);
const westClient = client(await fetch(`${westApp.url}/prices`));
await waitFor("west subscribed", () => west.size === 1);
east.send({ event: "tick", data: { from: "east" } });
checkEqual(
  "an event sent in one process reaches a client of the other",
  await westClient.next(1),
  ['tick {"from":"east"}'],
);
await westClient.leave();
east.close();
west.close();
await westApp.close();

/* ------------------------------------------------------------------ */
step("close(): every stream ends; later clients get 204");

prices.close();
check("alice's stream ends", await alice.ends());
checkEqual(
  "a new client is told to stop reconnecting",
  (await fetch(`${app.url}/prices`)).status,
  204,
);
await app.close();

summary();
