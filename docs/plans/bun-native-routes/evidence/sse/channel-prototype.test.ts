/**
 * The channel prototype, served and socket-free. Each case names the planted
 * bug (`CHANNEL_MUTATE`) that must make it fail; channel-controls.ts runs
 * every one of them and checks it does.
 *
 *   bun test docs/plans/bun-native-routes/evidence/sse/channel-prototype.test.ts
 *   bun docs/plans/bun-native-routes/evidence/sse/channel-controls.ts
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { SseChannelOptions, SseChannelWriter, SseSubscription } from "./channel-prototype";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter, BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { createMemoryBus, createSseChannel } from "./channel-prototype";
import { readEvents } from "./lib";
import { encodeSseEvent, SseStream } from "./prototype-sse";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** A channel with one route, `/e`, served on port 0 and reachable through `router.fetch()`. */
async function setup(options: SseChannelOptions = {}, topics?: (req: BunRequest) => string[]) {
  const channel = createSseChannel({ heartbeatMs: 0, ...options });
  const subs: SseSubscription[] = [];
  const route = (req: BunRequest, res: BunResponse): void => {
    const s = channel.subscribe(req, res, { topics: topics?.(req) });
    if (s) subs.push(s);
  };
  const router = new BunRouter();
  router.get("/e", route);
  const adapter = new BunHttpAdapter(0, { logger: noopLogger });
  adapter.get("/e", route);
  const server = await adapter.listen(0);
  cleanup.push(() => adapter.close(), () => channel.close());
  const served = (init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}/e`, init);
  return { channel, subs, router, served };
}

const blocks = async (res: Response, max: number, timeoutMs = 1500) =>
  (await readEvents(res.body, performance.now(), { max, timeoutMs })).events.map((e) => e.block);

/** Resolves once the subscription's writer has closed and the channel has had its turn. */
const closedOf = (s: SseSubscription) => new Promise<void>((r) => s.writer!.onClose(() => queueMicrotask(r)));

/** A writer that records what it is given and never closes by itself. */
function captureWriter(): SseChannelWriter & { got: Uint8Array[] } {
  const listeners: (() => void)[] = [];
  let closed = false;
  return {
    got: [],
    send(b) {
      this.got.push(b);
    },
    get closed() {
      return closed;
    },
    onClose: (fn) => listeners.push(fn),
    close: () => {
      closed = true;
      listeners.splice(0).forEach((f) => f());
    },
  };
}

describe("channel", () => {
  it("[no-unsubscribe] a client disconnect unregisters its subscriber (waits on onClose)", async () => {
    const { channel, subs, served } = await setup();
    const ac = new AbortController();
    const res = await served({ signal: ac.signal });
    expect(await blocks(res, 1)).toEqual([": ok"]);
    expect(channel.size).toBe(1);
    const closed = closedOf(subs[0]);
    ac.abort();
    await closed;
    expect(channel.size).toBe(0);
    expect(channel.send({ data: "after" })).toBe(0);
  });

  it("[initial-unheld] the initial state goes first, even when it is async and a send races it", async () => {
    const { channel, router } = await setup({
      initial: async () => {
        await Bun.sleep(30);
        return [{ event: "init", data: "snapshot" }];
      },
    });
    const res = await router.fetch("/e");
    channel.send({ data: "live" });
    expect(await blocks(res, 3)).toEqual([": ok", "event: init\ndata: snapshot", "data: live"]);
    channel.setInitial([{ data: "s2" }]);
    expect(await blocks(await router.fetch("/e"), 2)).toEqual([": ok", "data: s2"]);
    channel.clearInitial();
    const res3 = await router.fetch("/e");
    channel.send({ data: "only live" });
    expect(await blocks(res3, 2)).toEqual([": ok", "data: only live"]);
  });

  it("[replay-include-last] Last-Event-ID inside the buffer replays exactly the later events, and no initial state", async () => {
    const { channel, subs, router } = await setup({ replay: 3, idPrefix: "e", initial: [{ data: "snapshot" }] });
    for (let i = 1; i <= 5; i++) channel.send({ data: `d${i}` }); // the buffer holds e3, e4, e5
    const res = await router.fetch("/e", { headers: { "last-event-id": "e3" } });
    channel.send({ data: "d6" });
    expect(await blocks(res, 4)).toEqual([": ok", "id: e4\ndata: d4", "id: e5\ndata: d5", "id: e6\ndata: d6"]);
    expect([subs[0].replay, subs[0].replayed]).toEqual(["hit", 2]);
    const current = await router.fetch("/e", { headers: { "last-event-id": "e6" } });
    channel.send({ data: "d7" });
    expect(await blocks(current, 2)).toEqual([": ok", "id: e7\ndata: d7"]);
    expect(subs[1].replay).toBe("current");
  });

  it("[miss-sends-buffer] an id older than the buffer (or unknown) is a miss: the initial state, told it is a miss", async () => {
    const seen: string[] = [];
    const { channel, subs, router } = await setup({
      replay: 2,
      idPrefix: "e",
      initial: (ctx) => {
        seen.push(`${ctx.replay}:${ctx.lastEventId}`);
        return [{ event: "snapshot", data: ctx.replay }];
      },
    });
    for (let i = 1; i <= 4; i++) channel.send({ data: `d${i}` }); // buffer: e3, e4
    const old = await router.fetch("/e", { headers: { "last-event-id": "e1" } });
    const unknown = await router.fetch("/e", { headers: { "last-event-id": "zzz" } });
    await Promise.all(subs.map((s) => s.ready));
    expect(await blocks(old, 2, 300)).toEqual([": ok", "event: snapshot\ndata: miss"]);
    expect(await blocks(unknown, 2, 300)).toEqual([": ok", "event: snapshot\ndata: miss"]);
    expect(subs.map((s) => s.replay)).toEqual(["miss", "miss"]);
    expect(seen).toEqual(["miss:e1", "miss:zzz"]);
  });

  it("[plain-ids] assigned ids carry a per-instance prefix, so a restarted process cannot replay the wrong events", async () => {
    const before = createSseChannel({ heartbeatMs: 0, replay: 10 });
    const w = captureWriter();
    before.attach(w);
    before.send({ data: "old-1" });
    const lastSeen = /id: (.*)/.exec(new TextDecoder().decode(w.got[0]))![1];
    before.close();
    const after = createSseChannel({ heartbeatMs: 0, replay: 10 }); // the "restarted" process
    cleanup.push(() => after.close());
    after.send({ data: "new-1" });
    after.send({ data: "new-2" });
    const sub = after.attach(captureWriter(), { lastEventId: lastSeen });
    expect(sub.replay).toBe("miss");
  });

  it("[sendlist-reverse] sendList sends one event per item, in order, as one chunk per subscriber", async () => {
    const { channel, router } = await setup({ replay: 10, idPrefix: "e" });
    const w = captureWriter();
    channel.attach(w);
    const res = await router.fetch("/e");
    expect(channel.sendList(["a", { b: 1 }, "c"], { event: "item" })).toBe(2);
    expect(await blocks(res, 4)).toEqual([": ok", "event: item\nid: e1\ndata: a", 'event: item\nid: e2\ndata: {"b":1}', "event: item\nid: e3\ndata: c"]);
    expect(w.got.length).toBe(1);
  });

  for (const routing of ["index", "scan"] as const) {
    it(`[topics-leak] topics (${routing}): a topic reaches only its subscribers, a broadcast reaches all, replay respects topics`, async () => {
      const ch = createSseChannel({ heartbeatMs: 0, routing, replay: 10, idPrefix: "e" });
      cleanup.push(() => ch.close());
      const [a, b, c] = [captureWriter(), captureWriter(), captureWriter()];
      ch.attach(a, { topics: ["room1"] });
      ch.attach(b, { topics: ["room2", "room1"] });
      ch.attach(c);
      expect(ch.send({ data: "r1" }, { topic: "room1" })).toBe(2);
      expect(ch.send({ data: "r2" }, { topic: "room2" })).toBe(1);
      expect(ch.send({ data: "all" })).toBe(3);
      const text = (w: { got: Uint8Array[] }) => w.got.flatMap((g) => [...new TextDecoder().decode(g).matchAll(/data: (.*)/g)].map((m) => m[1]));
      expect([text(a), text(b), text(c)]).toEqual([["r1", "all"], ["r1", "r2", "all"], ["all"]]);
      const late = captureWriter();
      ch.attach(late, { topics: ["room2"], lastEventId: "e1" });
      expect(text(late)).toEqual(["r2", "all"]);
    });
  }

  it("[close-no-end] close() ends every subscriber, served and fetch(), and refuses new ones with 204", async () => {
    const { channel, served, router } = await setup();
    const r1 = await served();
    const r2 = await router.fetch("/e");
    const reading = [readEvents(r1.body, 0, { timeoutMs: 1000 }), readEvents(r2.body, 0, { timeoutMs: 1000 })];
    channel.close();
    expect((await Promise.all(reading)).map((o) => o.end)).toEqual(["done", "done"]);
    expect([channel.closed, channel.size]).toEqual([true, 0]);
    expect((await served()).status).toBe(204);
    expect((await router.fetch("/e")).status).toBe(204);
  });

  it("[encode-per-sink] encode once: one encoder call per send, the same bytes object on every subscriber", async () => {
    let calls = 0;
    const ch = createSseChannel({ heartbeatMs: 0, encode: (m) => (calls++, encodeSseEvent(m)) });
    cleanup.push(() => ch.close());
    const writers = Array.from({ length: 50 }, () => captureWriter());
    for (const w of writers) ch.attach(w);
    ch.send({ data: { price: 101.5 } });
    expect(calls).toBe(1);
    expect(new Set(writers.map((w) => w.got[0])).size).toBe(1);
  });

  it("[await-each] a subscriber that never reads does not stall the others", async () => {
    const ch = createSseChannel({ heartbeatMs: 0 });
    cleanup.push(() => ch.close());
    const slow = new SseStream({ heartbeatMs: 0, open: false, maxQueuedBytes: Infinity }); // nobody reads it
    const fast = new SseStream({ heartbeatMs: 0, open: false });
    ch.attach(slow);
    ch.attach(fast);
    const reading = readEvents(fast.readable, 0, { max: 2000, timeoutMs: 2000 });
    const payload = "x".repeat(1000);
    for (let i = 0; i < 2000; i++) {
      ch.send({ data: payload });
      if (i % 100 === 99) await Bun.sleep(0);
    }
    expect((await reading).events.length).toBe(2000);
    slow.close();
  });

  it("[no-unsubscribe] past maxQueuedBytes the stalled subscriber is closed and removed; the reader keeps going", async () => {
    const ch = createSseChannel({ heartbeatMs: 0 });
    cleanup.push(() => ch.close());
    const slow = new SseStream({ heartbeatMs: 0, open: false, maxQueuedBytes: 256 * 1024 });
    const fast = new SseStream({ heartbeatMs: 0, open: false });
    const slowSub = ch.attach(slow);
    ch.attach(fast);
    // The size at the moment the stalled one is dropped (the reader cancels itself once it has all 1000).
    const sizeWhenDropped = new Promise<number>((r) => slowSub.writer!.onClose(() => queueMicrotask(() => r(ch.size))));
    const reading = readEvents(fast.readable, 0, { max: 1000, timeoutMs: 2000 });
    for (let i = 0; i < 1000; i++) {
      ch.send({ data: "x".repeat(1000) });
      if (i % 100 === 99) await Bun.sleep(0);
    }
    expect(await sizeWhenDropped).toBe(1);
    expect(slow.closed).toBe(true);
    expect((await reading).events.length).toBe(1000);
  });

  it("[unsubscribe-on-signal] served and router.fetch() parity: the same events, and both unregister on disconnect", async () => {
    const { channel, subs, served, router } = await setup({ replay: 5, idPrefix: "e", initial: [{ data: "hello" }] });
    const a = await served();
    const b = await router.fetch("/e");
    for (let i = 1; i <= 3; i++) channel.send({ event: "n", data: { i } });
    // Reading `max` events cancels each body: a disconnect, served and socket-free.
    const [ea, eb] = await Promise.all([blocks(a, 5), blocks(b, 5)]);
    expect(ea).toEqual(eb);
    expect(ea.length).toBe(5);
    await Promise.all(subs.map(closedOf));
    expect(channel.size).toBe(0);
  });

  it("[no-origin-check] a transport carries events across 'processes', once each, and replay works on the other side", async () => {
    const bus = createMemoryBus();
    const A = createSseChannel({ heartbeatMs: 0, replay: 5, transport: bus.transport() });
    const B = createSseChannel({ heartbeatMs: 0, replay: 5, transport: bus.transport() });
    cleanup.push(() => A.close(), () => B.close());
    const [onA, onB] = [captureWriter(), captureWriter()];
    A.attach(onA);
    B.attach(onB);
    A.send({ data: "one" });
    A.send({ data: "two" });
    await Bun.sleep(0);
    const dec = (w: { got: Uint8Array[] }) => w.got.map((g) => new TextDecoder().decode(g));
    expect(dec(onA)).toEqual(dec(onB));
    expect(dec(onA).length).toBe(2);
    const firstId = /id: (.*)/.exec(dec(onA)[0])![1];
    const resumed = captureWriter();
    expect(B.attach(resumed, { lastEventId: firstId }).replay).toBe("hit");
    expect(dec(resumed)).toEqual([dec(onA)[1]]);
  });

  it("one shared heartbeat reaches every subscriber; heartbeatMs: 0 sends none (the control)", async () => {
    for (const heartbeatMs of [40, 0]) {
      const ch = createSseChannel({ heartbeatMs });
      const [w1, w2] = [captureWriter(), captureWriter()];
      ch.attach(w1);
      ch.attach(w2);
      await Bun.sleep(130);
      ch.close();
      const n = [w1.got.length, w2.got.length];
      if (heartbeatMs) expect(Math.min(...n)).toBeGreaterThanOrEqual(2);
      else expect(n).toEqual([0, 0]);
      if (heartbeatMs) expect(new TextDecoder().decode(w1.got[0])).toBe(":\n\n");
    }
  });
});
