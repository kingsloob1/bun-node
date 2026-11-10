/**
 * `createSseChannel()` (bun-native-routes plan §16.14, PR-sse2b): the cases
 * of §16.14.8, each with a negative control showing the check can fail —
 * either the same steps without the guarded behaviour (a hand-rolled hub
 * that awaits each writer, a writer attached without holding live events),
 * or the contrasting case the property rests on (an id prefix shared across
 * restarts, a bound lifted).
 *
 * HTTP cases run served, through `adapter.fetch()` and through
 * `router.fetch()`; the rest drive writers (`new SseWriter()`) and
 * `listen()` subscribers directly. Waits are on events and on the channel's
 * `size`, each with a deadline of seconds, so only a hang reaches one.
 */
import type { SseItem } from "../../lib/sse/parser";
import type { SseMessage } from "../../lib/sse/format";
import type {
  SseChannelOptions,
  SseChannelTransport,
  SseTransportEnvelope,
  SseChannel,
} from "../../lib/sse/channel";
import type { BunRequest } from "../../lib/BunRequest";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../../lib/BunHttpAdapter";
import { BunRouter } from "../../lib/BunRouter";
import { createTestLogger } from "../../lib/logging";
import { createSseChannel } from "../../lib/sse/channel";
import { sse } from "../../lib/sse/declaration";
import { readSse } from "../../lib/sse/parser";
import { SseWriter } from "../../lib/sse/writer";
import type { SseWriterInit } from "../../lib/sse/writer";

type Mode = "served" | "adapter.fetch()" | "router.fetch()";
const MODES: Mode[] = ["served", "adapter.fetch()", "router.fetch()"];

/** A step's deadline: only a hang reaches it. */
const STEP_MS = 5000;

/** What to close after each test. */
const open: { close: () => unknown }[] = [];

afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

/** A channel closed after the test. */
function channel(options?: SseChannelOptions): SseChannel {
  const made = createSseChannel(options);
  open.push(made);
  return made;
}

/** Requests on routes `build` registers, the way `mode` says. */
async function target(
  mode: Mode,
  build: (router: BunRouter) => void,
): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  if (mode === "router.fetch()") {
    const router = new BunRouter();
    build(router);
    return async (path, init) => router.fetch(path, init);
  }
  const adapter = new BunHttpAdapter(0);
  build(adapter);
  if (mode === "adapter.fetch()") {
    return async (path, init) => adapter.fetch(path, init);
  }
  await adapter.listen(0);
  open.push(adapter);
  return async (path, init) =>
    fetch(`http://127.0.0.1:${adapter.listeningPort}${path}`, init);
}

/** Resolves `pending`, or rejects naming `name` once {@link STEP_MS} passes. */
async function step<T>(name: string, pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name}: still pending after ${STEP_MS} ms`)),
          STEP_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waits until `condition()` holds, checking every few ms, up to {@link STEP_MS}. */
async function until(name: string, condition: () => boolean): Promise<void> {
  await step(
    name,
    (async () => {
      while (!condition()) await Bun.sleep(2);
    })(),
  );
}

/** A reader of an event stream's items. */
function reader(body: ReadableStream<Uint8Array>) {
  const iterator = readSse(body)[Symbol.asyncIterator]();
  return {
    /** The next `count` items (events and comments). */
    async take(count: number): Promise<SseItem[]> {
      const out: SseItem[] = [];
      while (out.length < count) {
        const next = await step(`item ${out.length + 1}`, iterator.next());
        if (next.done) break;
        out.push(next.value);
      }
      return out;
    },
    /** The next `count` events, skipping comments. */
    async events(count: number): Promise<SseItem[]> {
      const out: SseItem[] = [];
      while (out.length < count) {
        const next = await step(`event ${out.length + 1}`, iterator.next());
        if (next.done) break;
        if (next.value.kind === "event") out.push(next.value);
      }
      return out;
    },
    /** Whether the stream ends (rather than yielding an item) next. */
    async ends(): Promise<boolean> {
      const next = await step("the end", iterator.next());
      return next.done === true;
    },
    /** Stops reading: the client leaves. */
    async leave(): Promise<void> {
      await iterator.return?.();
    },
  };
}

/** An event's `[event, data, id]`, for comparing. */
function triple(item: SseItem): [string, string, string] | string {
  return item.kind === "event"
    ? [item.event, item.data, item.id]
    : `:${item.text}`;
}

/** A bare writer for a subscriber the test drives itself: no opening, no heartbeat. */
function writer(options?: SseWriterInit) {
  const made = new SseWriter<undefined>({
    open: false,
    heartbeatMs: 0,
    ...options,
  });
  open.push(made);
  return made;
}

/** A writer that records what the channel queues on it. */
class RecordingWriter extends SseWriter {
  /** Every `send()` argument, in order. */
  readonly sent: unknown[] = [];

  override send(message: SseMessage | Uint8Array): Promise<boolean> {
    this.sent.push(message);
    return super.send(message);
  }
}

/** Messages a `listen()` subscriber got, as `[event, data, id]`. */
function collector() {
  const got: [string | undefined, unknown, string | number | undefined][] = [];
  return {
    got,
    listener: (message: SseMessage) => {
      got.push([message.event, message.data, message.id]);
    },
  };
}

/**
 * An in-memory bus standing in for Redis pub/sub or Postgres `LISTEN`: each
 * `transport()` is one process. Envelopes round-trip through JSON and are
 * delivered in a microtask, to every listener, its publisher's included.
 */
function memoryBus() {
  const listeners = new Set<(envelope: SseTransportEnvelope) => void>();
  /** Every envelope delivered, with the listener index it reached. */
  const deliveries: { to: number; origin: string }[] = [];
  let next = 0;
  return {
    deliveries,
    transport(): SseChannelTransport {
      const index = next++;
      let mine: ((envelope: SseTransportEnvelope) => void) | undefined;
      return {
        publish: (envelope) => {
          const copy = JSON.parse(
            JSON.stringify(envelope),
          ) as SseTransportEnvelope;
          queueMicrotask(() => {
            for (const listener of listeners) listener(copy);
          });
        },
        subscribe: (listener) => {
          mine = (envelope) => {
            deliveries.push({ to: index, origin: envelope.origin });
            listener(envelope);
          };
          listeners.add(mine);
          return () => listeners.delete(mine!);
        },
      };
    },
  };
}

describe("createSseChannel(): subscribing over HTTP", () => {
  for (const mode of MODES) {
    it(`${mode}: the initial state, then live events; a disconnect unregisters (the one that stays is the control)`, async () => {
      const prices = channel({
        initial: [{ event: "snapshot", data: { p: 100 } }],
        heartbeatMs: 0,
      });
      const get = await target(mode, (router) => {
        router.get("/prices", prices.handler());
      });
      const a = reader((await step("A", get("/prices"))).body!);
      const b = reader((await step("B", get("/prices"))).body!);
      expect(prices.size).toBe(2);
      expect((await a.take(2)).map(triple)).toEqual([
        ": ok",
        ["snapshot", '{"p":100}', ""],
      ]);
      expect(prices.send({ event: "tick", data: { p: 101 } })).toBe(2);
      expect((await a.events(1)).map(triple)).toEqual([
        ["tick", '{"p":101}', ""],
      ]);
      expect((await b.events(2)).map(triple)).toEqual([
        ["snapshot", '{"p":100}', ""],
        ["tick", '{"p":101}', ""],
      ]);

      await a.leave();
      await until("A unregistered", () => prices.size === 1);
      // B is still subscribed and still served.
      await Bun.sleep(20);
      expect(prices.size).toBe(1);
      expect(prices.send({ data: "again" })).toBe(1);
      expect((await b.events(1)).map(triple)).toEqual([
        ["message", "again", ""],
      ]);
      await b.leave();
      await until("B unregistered", () => prices.size === 0);
    });
  }

  it("served: a new subscriber's initial state goes to it alone, not to those already connected (express-sse sends it to everyone)", async () => {
    const prices = channel({ initial: [{ data: "init" }], heartbeatMs: 0 });
    const get = await target("served", (router) => {
      router.get("/p", prices.handler());
    });
    const a = reader((await get("/p")).body!);
    expect((await a.events(1)).map(triple)).toEqual([["message", "init", ""]]);
    const b = reader((await get("/p")).body!);
    expect((await b.events(1)).map(triple)).toEqual([["message", "init", ""]]);
    prices.send({ data: "live" });
    // A's next event is the live one: B's arrival sent A nothing.
    expect((await a.events(1)).map(triple)).toEqual([["message", "live", ""]]);
    await a.leave();
    await b.leave();
  });

  it("handler({ topics }) reads the request; subscribe() in a handler of your own", async () => {
    const rooms = channel({ heartbeatMs: 0 });
    const get = await target("router.fetch()", (router) => {
      router.get(
        "/rooms/:id",
        rooms.handler({
          topics: (req: BunRequest) => [`room:${String(req.params.id)}`],
        }),
      );
      router.get("/custom", (req, res) => {
        rooms.subscribe(req, res, { topics: ["room:2"] });
      });
    });
    const one = reader((await get("/rooms/1")).body!);
    const two = reader((await get("/custom")).body!);
    expect(rooms.send({ data: "for 2" }, { topic: "room:2" })).toBe(1);
    expect(rooms.send({ data: "for 1" }, { topic: "room:1" })).toBe(1);
    expect((await one.events(1)).map(triple)).toEqual([
      ["message", "for 1", ""],
    ]);
    expect((await two.events(1)).map(triple)).toEqual([
      ["message", "for 2", ""],
    ]);
    await one.leave();
    await two.leave();
  });

  for (const mode of MODES) {
    it(`${mode}: close() ends every subscriber, and later requests get 204 (before it, 200: the control)`, async () => {
      const news = channel({ heartbeatMs: 0 });
      const get = await target(mode, (router) => {
        router.get("/news", news.handler());
      });
      const before = await get("/news");
      expect(before.status).toBe(200);
      const stream = reader(before.body!);
      expect((await stream.take(1)).map(triple)).toEqual([": ok"]);
      news.close();
      expect(news.closed).toBe(true);
      expect(await stream.ends()).toBe(true);
      expect(news.size).toBe(0);
      const after = await get("/news");
      expect(after.status).toBe(204);
      expect(news.send({ data: "late" })).toBe(0);
    });
  }

  it("response(): a native Bun.serve route, exempted from the idle timeout through `server`; 204 once closed", async () => {
    const feed = channel({ initial: [{ data: "init" }], heartbeatMs: 0 });
    let exempted = 0;
    const server = Bun.serve({
      port: 0,
      routes: {
        "/raw": (req, srv) =>
          feed.response(req, {
            server: {
              timeout: (request, seconds) => {
                exempted++;
                srv.timeout(request, seconds);
              },
            },
          }),
      },
      fetch: () => new Response("no", { status: 404 }),
    });
    open.push({ close: () => server.stop(true) });
    const res = await fetch(`http://127.0.0.1:${server.port}/raw`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(exempted).toBe(1);
    const stream = reader(res.body!);
    expect((await stream.take(2)).map(triple)).toEqual([
      ": ok",
      ["message", "init", ""],
    ]);
    feed.send({ data: "live" });
    expect((await stream.events(1)).map(triple)).toEqual([
      ["message", "live", ""],
    ]);
    await stream.leave();
    await until("unregistered", () => feed.size === 0);
    feed.close();
    expect((await fetch(`http://127.0.0.1:${server.port}/raw`)).status).toBe(
      204,
    );
  });
});

describe("createSseChannel(): the initial state", () => {
  it("an async initial state goes first even when a live event races it; the control, unheld, lets the live event through first", async () => {
    let release!: () => void;
    const snapshot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const book = channel({
      heartbeatMs: 0,
      initial: async (context) => {
        await snapshot;
        return [{ event: "snapshot", data: context.replay }];
      },
    });
    const w = writer();
    const subscription = book.attach(w);
    book.send({ data: "live" });
    release();
    await subscription.ready;
    const items = reader(w.readable);
    expect((await items.events(2)).map(triple)).toEqual([
      ["snapshot", "none", ""],
      ["message", "live", ""],
    ]);

    // The control: the same race, with the snapshot sent by hand after the
    // await (what attaching first and sending later does): live goes first.
    const naive = channel({ heartbeatMs: 0 });
    const control = writer();
    naive.attach(control);
    let releaseControl!: () => void;
    const later = new Promise<void>((resolve) => {
      releaseControl = resolve;
    });
    const sending = later.then(() =>
      control.send({ event: "snapshot", data: "none" }),
    );
    naive.send({ data: "live" });
    releaseControl();
    await sending;
    expect((await reader(control.readable).events(2)).map(triple)).toEqual([
      ["message", "live", ""],
      ["snapshot", "none", ""],
    ]);
  });

  it("a rejected initial state goes to onError, and the live events held meanwhile still go out", async () => {
    const errors: unknown[] = [];
    const failing = channel({
      heartbeatMs: 0,
      onError: (error) => errors.push(error),
      initial: async () => {
        await Bun.sleep(5);
        throw new Error("no snapshot");
      },
    });
    const w = writer();
    const subscription = failing.attach(w);
    failing.send({ data: "held" });
    await subscription.ready;
    expect((errors[0] as Error).message).toBe("no snapshot");
    expect((await reader(w.readable).events(1)).map(triple)).toEqual([
      ["message", "held", ""],
    ]);
  });

  it("without onError, a failed initial state is logged", async () => {
    const { logger, events } = createTestLogger();
    const failing = channel({
      heartbeatMs: 0,
      writer: { logger },
      initial: () => {
        throw new Error("sync failure");
      },
    });
    failing.attach(writer());
    expect(events.map((event) => event.level)).toEqual(["error"]);
    expect(events[0].error?.message).toBe("sync failure");
  });

  it("setInitial() and clearInitial() change what later subscribers get, and no one already connected", async () => {
    const state = channel({ heartbeatMs: 0, initial: [{ data: "v1" }] });
    const first = collector();
    state.listen(first.listener);
    state.setInitial([{ data: "v2" }, { data: "v2b" }]);
    const second = collector();
    state.listen(second.listener);
    state.clearInitial();
    const third = collector();
    state.listen(third.listener);
    expect(first.got).toEqual([[undefined, "v1", undefined]]);
    expect(second.got).toEqual([
      [undefined, "v2", undefined],
      [undefined, "v2b", undefined],
    ]);
    expect(third.got).toEqual([]);
  });
});

describe("createSseChannel(): replay", () => {
  /** A channel with `replay` that has sent `count` events, and their ids. */
  function sent(count: number, replay: number, initial = true) {
    const ch = channel({
      replay,
      heartbeatMs: 0,
      ...(initial
        ? {
            initial: (context) => [
              {
                event: "init",
                data: {
                  replay: context.replay,
                  id: context.lastEventId ?? null,
                },
              },
            ],
          }
        : {}),
    });
    // A subscriber from the start reads the ids back.
    const log = collector();
    ch.listen(log.listener);
    for (let n = 1; n <= count; n++) ch.send({ event: "tick", data: n });
    const ids = log.got
      .filter(([event]) => event === "tick")
      .map(([, , id]) => String(id));
    return { ch, ids };
  }

  it("a Last-Event-ID in the buffer replays exactly the later events and no initial state (hit); the newest replays nothing (current)", () => {
    const { ch, ids } = sent(3, 5);
    const hit = collector();
    const subscription = ch.listen(hit.listener, { lastEventId: ids[0] });
    expect(subscription.replay).toBe("hit");
    expect(subscription.replayed).toBe(2);
    expect(hit.got).toEqual([
      ["tick", 2, ids[1]],
      ["tick", 3, ids[2]],
    ]);
    const current = collector();
    const up = ch.listen(current.listener, { lastEventId: ids[2] });
    expect(up.replay).toBe("current");
    expect(current.got).toEqual([]);
  });

  it("an id older than the buffer, or unknown, is a miss: the initial state, told so, and none of the buffer", () => {
    const { ch, ids } = sent(8, 5);
    for (const lastEventId of [ids[0], "garbage"]) {
      const missed = collector();
      const subscription = ch.listen(missed.listener, { lastEventId });
      expect(subscription.replay).toBe("miss");
      expect(missed.got).toEqual([
        ["init", { replay: "miss", id: lastEventId }, undefined],
      ]);
    }
    // The control: an id still in the buffer is a hit.
    expect(ch.listen(() => {}, { lastEventId: ids[3] }).replay).toBe("hit");
  });

  it("ids carry a per-instance prefix, so a restarted process misses an old id; with one prefix for both (the control) it would wrongly hit", () => {
    const before = channel({ replay: 5, heartbeatMs: 0 });
    const old = collector();
    before.listen(old.listener);
    before.send({ data: "a" });
    before.send({ data: "b" });
    const oldId = String(old.got[0][2]);

    const restarted = channel({ replay: 5, heartbeatMs: 0 });
    restarted.send({ data: "x" });
    restarted.send({ data: "y" });
    expect(restarted.listen(() => {}, { lastEventId: oldId }).replay).toBe(
      "miss",
    );

    const fixedA = channel({ replay: 5, heartbeatMs: 0, idPrefix: "p." });
    const fixedB = channel({ replay: 5, heartbeatMs: 0, idPrefix: "p." });
    const seen = collector();
    fixedA.listen(seen.listener);
    fixedA.send({ data: "a" });
    fixedB.send({ data: "x" });
    fixedB.send({ data: "y" });
    expect(seen.got[0][2]).toBe("p.1");
    const wrong = fixedB.listen(() => {}, { lastEventId: "p.1" });
    expect(wrong.replay).toBe("hit");
  });

  it("ids given by the sender are kept and matched as exact strings; replay off assigns none", () => {
    const given = channel({ replay: 3, heartbeatMs: 0 });
    given.send({ data: "a", id: 10 });
    given.send({ data: "b", id: "11" });
    const after = collector();
    expect(given.listen(after.listener, { lastEventId: "10" }).replay).toBe(
      "hit",
    );
    expect(after.got).toEqual([[undefined, "b", "11"]]);
    expect(given.listen(() => {}, { lastEventId: "010" }).replay).toBe("miss");

    const plain = channel({ heartbeatMs: 0 });
    const got = collector();
    plain.listen(got.listener);
    plain.send({ data: "a" });
    expect(got.got).toEqual([[undefined, "a", undefined]]);
    expect(plain.listen(() => {}, { lastEventId: "anything" }).replay).toBe(
      "miss",
    );
  });

  for (const mode of MODES) {
    it(`${mode}: a reconnect with Last-Event-ID gets the later events over HTTP`, async () => {
      const ch = channel({ replay: 10, heartbeatMs: 0 });
      const get = await target(mode, (router) => {
        router.get("/e", ch.handler());
      });
      const first = reader((await get("/e")).body!);
      ch.send({ data: "one" });
      ch.send({ data: "two" });
      ch.send({ data: "three" });
      const [one] = await first.events(3);
      await first.leave();
      const again = reader(
        (
          await get("/e", {
            headers: { "last-event-id": (one as { id: string }).id },
          })
        ).body!,
      );
      expect((await again.events(2)).map((item) => triple(item)[1])).toEqual([
        "two",
        "three",
      ]);
      await again.leave();
    });
  }
});

describe("createSseChannel(): sending", () => {
  it("sendList(): one event per item, in order, as one chunk per subscriber", async () => {
    const list = channel({ heartbeatMs: 0, replay: 5 });
    const w = new RecordingWriter({ open: false, heartbeatMs: 0 });
    open.push(w);
    list.attach(w);
    expect(list.sendList(["a", "b", "c"], { event: "row" })).toBe(1);
    expect(w.sent).toHaveLength(1);
    const events = await reader(w.readable).events(3);
    expect(events.map((item) => triple(item).slice(0, 2))).toEqual([
      ["row", "a"],
      ["row", "b"],
      ["row", "c"],
    ]);
    // Ids follow on, one per item.
    const ids = events.map((item) => triple(item)[2]);
    expect(new Set(ids).size).toBe(3);
    expect(list.sendList([])).toBe(0);
  });

  it("a malformed event throws before anything is sent or kept, sendList()'s included", () => {
    const strict = channel({ heartbeatMs: 0, replay: 5 });
    const got = collector();
    strict.listen(got.listener);
    expect(() => strict.send({ event: "a\nb", data: 1 })).toThrow(TypeError);
    expect(() => strict.sendList([1, 2], { event: "x\ny" })).toThrow(TypeError);
    expect(got.got).toEqual([]);
    expect(strict.listen(() => {}, { lastEventId: "x" }).replay).toBe("miss");
  });

  it("encodes once: every subscriber is handed the same bytes; two sends are two encodings (the control)", () => {
    const many = channel({ heartbeatMs: 0 });
    const writers = Array.from({ length: 50 }, () => {
      const w = new RecordingWriter({ open: false, heartbeatMs: 0 });
      open.push(w);
      many.attach(w);
      return w;
    });
    expect(many.send({ event: "price", data: { p: 1 } })).toBe(50);
    const first = writers[0].sent[0];
    expect(first).toBeInstanceOf(Uint8Array);
    expect(writers.every((w) => w.sent[0] === first)).toBe(true);
    many.send({ event: "price", data: { p: 1 } });
    expect(writers[0].sent[1]).not.toBe(first);
  });

  it("topics: a topic send reaches its subscribers only, a broadcast everyone, a subscriber without topics broadcasts only; replay is filtered by topic", () => {
    const rooms = channel({ heartbeatMs: 0, replay: 10 });
    const one = collector();
    const two = collector();
    const none = collector();
    rooms.listen(one.listener, { topics: ["room:1"] });
    rooms.listen(two.listener, { topics: ["room:2", "room:3"] });
    rooms.listen(none.listener);
    expect(rooms.send({ data: "r1" }, { topic: "room:1" })).toBe(1);
    expect(rooms.send({ data: "r3" }, { topic: "room:3" })).toBe(1);
    expect(rooms.send({ data: "all" })).toBe(3);
    expect(rooms.send({ data: "nobody" }, { topic: "room:9" })).toBe(0);
    expect(one.got.map((m) => m[1])).toEqual(["r1", "all"]);
    expect(two.got.map((m) => m[1])).toEqual(["r3", "all"]);
    expect(none.got.map((m) => m[1])).toEqual(["all"]);

    const first = String(one.got[0][2]);
    const resumed = collector();
    const subscription = rooms.listen(resumed.listener, {
      topics: ["room:2"],
      lastEventId: first,
    });
    expect(resumed.got.map((m) => m[1])).toEqual(["all"]);
    expect(subscription.replayed).toBe(1);
    // A subscriber unsubscribed leaves its topics' index.
    subscription.unsubscribe();
    subscription.unsubscribe();
    expect(rooms.size).toBe(3);
  });

  it("a subscriber that never reads does not stall another: the channel awaits no writer; the control, a hub awaiting each, stalls", async () => {
    const COUNT = 2000;
    const data = "x".repeat(1000);
    const hub = channel({ heartbeatMs: 0 });
    const stalled = writer({ maxQueuedBytes: Infinity });
    const live = writer();
    hub.attach(stalled);
    hub.attach(live);
    const received = (async () => {
      let n = 0;
      for await (const item of readSse(live.readable)) {
        if (item.kind === "event" && ++n === COUNT) return n;
      }
      return n;
    })();
    for (let n = 0; n < COUNT; n++) hub.send({ data });
    expect(await step("every event to the reader", received)).toBe(COUNT);

    // The control: the same fan-out, awaiting each writer in turn.
    const stalledToo = writer({ maxQueuedBytes: Infinity });
    const liveToo = writer();
    let got = 0;
    void (async () => {
      for await (const item of readSse(liveToo.readable)) {
        if (item.kind === "event") got++;
      }
    })();
    const sending = (async () => {
      for (let n = 0; n < COUNT; n++) {
        for (const w of [stalledToo, liveToo]) await w.send({ data });
      }
    })();
    await Bun.sleep(200);
    expect(got).toBeLessThan(COUNT / 2);
    stalledToo.close();
    liveToo.close();
    await sending;
  });

  it("past maxQueuedBytes a stalled subscriber is disconnected and forgotten while the reader goes on; with the bound lifted (the control) it stays", async () => {
    const data = "y".repeat(1000);
    for (const bound of [64 * 1024, Infinity]) {
      const { logger } = createTestLogger();
      const hub = channel({ heartbeatMs: 0 });
      const stalled = writer({ maxQueuedBytes: bound, logger });
      const live = writer();
      hub.attach(stalled);
      hub.attach(live);
      let got = 0;
      const reading = (async () => {
        for await (const item of readSse(live.readable)) {
          if (item.kind === "event") got++;
        }
      })();
      for (let n = 0; n < 200; n++) hub.send({ data });
      await until("the reader's 200 events", () => got === 200);
      if (bound === Infinity) {
        expect(stalled.closed).toBe(false);
        expect(hub.size).toBe(2);
      } else {
        expect(stalled.closed).toBe(true);
        expect(hub.size).toBe(1);
      }
      live.close();
      await reading;
    }
  });

  it("one heartbeat timer for the channel reaches every writer subscriber, skipped after a broadcast; heartbeatMs: 0 (the control) sends none", async () => {
    const beating = channel({ heartbeatMs: 15 });
    const quiet = channel({ heartbeatMs: 0 });
    const a = writer();
    const b = writer();
    const c = writer();
    beating.attach(a);
    beating.attach(b);
    quiet.attach(c);
    const listened = collector();
    beating.listen(listened.listener);
    const [fromA, fromB] = await Promise.all([
      reader(a.readable).take(1),
      reader(b.readable).take(1),
    ]);
    expect(fromA.map(triple)).toEqual([":"]);
    expect(fromB.map(triple)).toEqual([":"]);
    expect(listened.got).toEqual([]);
    quiet.send({ data: "only" });
    c.close();
    const fromC: SseItem[] = [];
    for await (const item of readSse(c.readable)) fromC.push(item);
    expect(fromC.map(triple)).toEqual([["message", "only", ""]]);
  });

  it("listen(): onEnd runs when the channel closes; on a closed channel at once; attach() closes the writer", () => {
    const ch = createSseChannel({ heartbeatMs: 0 });
    let ended = 0;
    ch.listen(() => {}, { onEnd: () => ended++ });
    ch.close();
    ch.close();
    expect(ended).toBe(1);
    ch.listen(() => {}, { onEnd: () => ended++ });
    expect(ended).toBe(2);
    const w = writer();
    expect(ch.attach(w).replay).toBe("none");
    expect(w.closed).toBe(true);
  });

  it("a listener that throws, or a writer that refuses bytes, goes to onError and the others still get the event; without the throw (the control) nothing is reported", () => {
    const errors: unknown[] = [];
    const ch = channel({
      heartbeatMs: 0,
      onError: (error) => errors.push(error),
    });
    const after = collector();
    ch.listen(() => {
      throw new Error("listener broke");
    });
    // A contract writer takes no bytes: cast past attach()'s type.
    const typed = new SseWriter({
      open: false,
      heartbeatMs: 0,
      contract: sse({ tick: null }),
    });
    open.push(typed);
    ch.attach(typed as unknown as SseWriter);
    ch.listen(after.listener);
    expect(ch.send({ data: "x" })).toBe(3);
    expect(after.got).toEqual([[undefined, "x", undefined]]);
    expect(errors.map((error) => (error as Error).constructor.name)).toEqual([
      "Error",
      "TypeError",
    ]);
    expect(typed.closed).toBe(true);
    expect(ch.size).toBe(2);

    const quiet: unknown[] = [];
    const fine = channel({ heartbeatMs: 0, onError: (e) => quiet.push(e) });
    fine.listen(() => {});
    fine.send({ data: "x" });
    expect(quiet).toEqual([]);
  });

  it("rejects a bad replay or heartbeatMs", () => {
    expect(() => createSseChannel({ replay: -1 })).toThrow(TypeError);
    expect(() => createSseChannel({ replay: 1.5 })).toThrow(TypeError);
    expect(() => createSseChannel({ heartbeatMs: -1 })).toThrow(TypeError);
  });
});

describe("createSseChannel(): across processes", () => {
  it("a transport carries each event once to the other process, which replays it with the sender's id; the sender ignores its own echo", async () => {
    const bus = memoryBus();
    const a = channel({
      heartbeatMs: 0,
      replay: 10,
      transport: bus.transport(),
    });
    const b = channel({
      heartbeatMs: 0,
      replay: 10,
      transport: bus.transport(),
    });
    const onA = collector();
    const onB = collector();
    a.listen(onA.listener);
    b.listen(onB.listener, { topics: ["t"] });
    a.send({ data: "one" });
    a.send({ data: "two" }, { topic: "t" });
    a.send({ data: "three" });
    await until("B's three events", () => onB.got.length === 3);
    await Bun.sleep(5);
    // Once each on both sides, A's echo included (it was delivered to A).
    expect(onA.got.map((m) => m[1])).toEqual(["one", "three"]);
    expect(onB.got.map((m) => m[1])).toEqual(["one", "two", "three"]);
    // B sees A's ids, assigned by the sender.
    const [idOne, idThree] = onA.got.map((m) => m[2]);
    expect(onB.got.map((m) => m[2])).toEqual([
      idOne,
      expect.any(String),
      idThree,
    ]);
    // The echo is real: the bus delivered A's three envelopes back to A,
    // and A ignored them (the control for "once each").
    expect(bus.deliveries.filter((d) => d.to === 0)).toHaveLength(3);

    // Replay on B, with A's id.
    const resumed = collector();
    const subscription = b.listen(resumed.listener, {
      lastEventId: String(onA.got[0][2]),
    });
    expect(subscription.replay).toBe("hit");
    expect(resumed.got.map((m) => m[1])).toEqual(["three"]);
  });

  it("a transport's publish failure goes to onError; the local delivery is unaffected", async () => {
    const errors: unknown[] = [];
    const failing = channel({
      heartbeatMs: 0,
      onError: (error) => errors.push(error),
      transport: {
        publish: () => Promise.reject(new Error("bus down")),
        subscribe: () => () => {},
      },
    });
    const got = collector();
    failing.listen(got.listener);
    expect(failing.send({ data: "local" })).toBe(1);
    await until("the error", () => errors.length === 1);
    expect((errors[0] as Error).message).toBe("bus down");
    expect(got.got).toEqual([[undefined, "local", undefined]]);
  });

  it("close() stops the transport's delivery", async () => {
    let stopped = false;
    const ch = createSseChannel({
      heartbeatMs: 0,
      transport: { publish: () => {}, subscribe: () => () => (stopped = true) },
    });
    ch.close();
    expect(stopped).toBe(true);
  });
});
