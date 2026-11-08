/**
 * Live invalidation across processes (`lib/live/bus.ts`), over a scripted
 * bus in this process: the test plays the other processes, handing the
 * subscription messages with another origin, and reads what this process
 * publishes. bun-cache's `cacheLiveBus` over a real Redis, with two
 * processes, is `bun-cache/__tests__/live/servers.test.ts`.
 *
 * Covered: what is published (origin, consecutive `n`, one message per
 * synchronous run, 256 tags a message) while local delivery stays
 * immediate; another process's message delivered to the tag's holders, in
 * order, numbered here (control: a tag nobody here holds); its own echo and
 * a duplicate dropped; a hole in the numbers, a truncated message, the bus's
 * `onGap` and every (re)subscription sending a `gap` to sockets and SSE
 * streams, and resume answering a cursor before it with one (control: a
 * cursor after it); a bus that is down (subscribe retried, a failed publish
 * logged once, its number spent, local delivery unaffected); one bus per
 * process, shared and refcounted; `liveInvalidation({ bus })`.
 */
import type { Server } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import type { LiveBus, LiveBusMessage } from "../lib/live";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { ConfigError } from "../lib/errors";
import { createTestLogger } from "../lib/logging";
import {
  connectLiveBus,
  liveContract,
  liveInvalidation,
  publishTags,
} from "../lib/live";
import { resetLiveBus } from "../lib/live/bus";

afterEach(async () => {
  await resetLiveBus();
});

/** Polls `predicate` until true, or fails after `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

/** A frame as the client sees it. */
interface Frame {
  type: string;
  id?: string;
  data?: Record<string, unknown>;
}

/** A raw live client: its frames, and `request()` answered by the echoed id. */
async function socketOf(url: string) {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  let next = 0;
  ws.onmessage = (event) =>
    void frames.push(JSON.parse(String(event.data)) as Frame);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`${url} did not open`));
  });
  const request = async (type: string, data: unknown): Promise<Frame> => {
    const id = `r${++next}`;
    ws.send(JSON.stringify({ type, id, data }));
    let reply: Frame | undefined;
    await until(() => {
      reply = frames.find((frame) => frame.id === id);
      return reply !== undefined;
    });
    return reply!;
  };
  const of = (type: string) => frames.filter((frame) => frame.type === type);
  /** The `invalidate` frames so far, as `[seq, tags]`. */
  const invalidations = () =>
    of("invalidate").map((frame) => [frame.data?.seq, frame.data?.tags]);
  return { ws, frames, request, of, invalidations };
}

/** An app with live invalidation mounted. */
async function serve(bus?: LiveBus) {
  const { logger, events } = createTestLogger();
  const adapter = new BunHttpAdapter(0, { logger });
  adapter.use(
    liveInvalidation(adapter, {
      authorize: (_req, _res, next) => next(),
      bus,
    }),
  );
  const server = (await adapter.listen(0)) as Server<unknown>;
  const base = `127.0.0.1:${server.port}`;
  return {
    events,
    http: `http://${base}`,
    ws: `ws://${base}${liveContract.meta.path}`,
    close: () => adapter.close(),
  };
}

/** A scripted bus: what was published, and the subscription's callbacks to play other processes with. */
function scriptedBus() {
  const published: LiveBusMessage[] = [];
  let onMessage: ((message: LiveBusMessage) => void) | undefined;
  let onGap: (() => void) | undefined;
  const state = {
    /** How many of the next subscribes fail. */
    failSubscribes: 0,
    /** Whether a publish fails. */
    failPublish: false,
    subscribes: 0,
    unsubscribes: 0,
  };
  const bus: LiveBus = {
    name: "scripted",
    publish: async (message) => {
      if (state.failPublish) throw new Error("the bus is down");
      published.push(message);
    },
    subscribe: async (message, gap) => {
      state.subscribes++;
      if (state.failSubscribes > 0) {
        state.failSubscribes--;
        throw new Error("the bus is down");
      }
      onMessage = message;
      onGap = gap;
      return async () => {
        state.unsubscribes++;
        onMessage = undefined;
      };
    },
  };
  return {
    bus,
    state,
    published,
    /** Hands the subscription a message, as another process's would arrive. */
    deliver: (message: LiveBusMessage) => onMessage?.(message),
    /** The bus reports a gap. */
    gap: () => onGap?.(),
  };
}

/** A unique tag. */
let tagCount = 0;
const fresh = (name: string): string => `${name}-${++tagCount}-${Date.now()}`;

/** Another process's origin. */
const other = (): string => `other-${crypto.randomUUID()}`;

describe("publishing", () => {
  it("publishes this process's invalidations on the bus, one message per synchronous run, while delivering them here at once", async () => {
    const script = scriptedBus();
    const connection = connectLiveBus(script.bus);
    await connection.ready;
    const app = await serve();
    try {
      const a = fresh("a");
      const b = fresh("b");
      const socket = await socketOf(app.ws);
      await socket.request("subscribe", { tags: [a] });
      publishTags([a]);
      publishTags([b, a]);
      // Local delivery does not wait for the bus.
      expect(script.published).toEqual([]);
      await until(() => script.published.length === 1);
      const [first] = script.published;
      expect(first!.tags).toEqual([a, b]);
      expect(first!.n).toBe(1);
      expect(typeof first!.origin).toBe("string");
      await until(() => socket.invalidations().length === 2);

      // 300 tags: two messages, consecutive numbers, one origin.
      const many = Array.from({ length: 300 }, (_, i) => fresh(`m${i}`));
      publishTags(many);
      await until(() => script.published.length === 3);
      expect(script.published.map((m) => [m.n, m.tags.length])).toEqual([
        [1, 2],
        [2, 256],
        [3, 44],
      ]);
      expect(new Set(script.published.map((m) => m.origin)).size).toBe(1);
      socket.ws.close();
    } finally {
      await app.close();
      await connection.close();
    }
  });
});

describe("receiving", () => {
  it("delivers another process's invalidation to the holders of its tags, numbered here, in order", async () => {
    const script = scriptedBus();
    const connection = connectLiveBus(script.bus);
    await connection.ready;
    const app = await serve();
    try {
      const held = fresh("held");
      const notHeld = fresh("not-held");
      const socket = await socketOf(app.ws);
      const hello = (await socket.request("subscribe", { tags: [held] })).data!;
      const origin = other();
      for (let n = 1; n <= 20; n++)
        script.deliver({ origin, n, tags: n % 2 === 0 ? [held] : [notHeld] });
      await until(() => socket.invalidations().length === 10);
      const seq = hello.seq as number;
      // In order, each numbered in this process's epoch.
      expect(socket.invalidations()).toEqual(
        Array.from({ length: 10 }, (_, i) => [seq + 2 * (i + 1), [held]]),
      );
      expect(
        socket.of("invalidate").every((f) => f.data?.epoch === hello.epoch),
      ).toBe(true);
      // The control: nothing for the tag nobody here holds, and no gap.
      expect(socket.of("gap")).toEqual([]);
      socket.ws.close();
    } finally {
      await app.close();
      await connection.close();
    }
  });

  it("drops its own echo, a duplicate and a late message", async () => {
    const script = scriptedBus();
    const connection = connectLiveBus(script.bus);
    await connection.ready;
    const app = await serve();
    try {
      const tag = fresh("d");
      const socket = await socketOf(app.ws);
      await socket.request("subscribe", { tags: [tag] });
      publishTags([tag]);
      await until(() => script.published.length === 1);
      // The bus hands a process its own message back: skipped.
      script.deliver(script.published[0]!);
      const origin = other();
      script.deliver({ origin, n: 1, tags: [tag] });
      script.deliver({ origin, n: 1, tags: [tag] });
      script.deliver({ origin, n: 2, tags: [tag] });
      script.deliver({ origin, n: 1, tags: [tag] });
      await until(() => socket.invalidations().length === 3);
      await Bun.sleep(30);
      // Its own (once, locally), then n = 1 and n = 2 once each.
      expect(socket.invalidations().length).toBe(3);
      expect(socket.of("gap")).toEqual([]);
      socket.ws.close();
    } finally {
      await app.close();
      await connection.close();
    }
  });
});

describe("gaps", () => {
  it("sends a gap on a hole in another process's numbers, and resumes a cursor before it as a gap", async () => {
    const script = scriptedBus();
    const connection = connectLiveBus(script.bus);
    await connection.ready;
    const app = await serve();
    try {
      const tag = fresh("h");
      const socket = await socketOf(app.ws);
      const before = (await socket.request("subscribe", { tags: [tag] })).data!;
      const controller = new AbortController();
      const stream = await fetch(`${app.http}/__live/sse?tag=${tag}`, {
        signal: controller.signal,
      });
      const events = readEvents(stream);
      await until(() => events.list.length === 1); // hello
      const origin = other();
      script.deliver({ origin, n: 1, tags: [tag] });
      await until(() => socket.invalidations().length === 1);
      // The control: consecutive numbers send no gap.
      expect(socket.of("gap")).toEqual([]);
      script.deliver({ origin, n: 3, tags: [tag] });
      await until(() => socket.of("gap").length === 1);
      await until(() => socket.invalidations().length === 2);
      const gap = socket.of("gap")[0]!.data!;
      expect(gap.epoch).toBe(before.epoch);
      expect(gap.seq).toBe((before.seq as number) + 2);
      // The gap comes before n = 3's invalidation, which follows it.
      expect(socket.frames.map((f) => f.type).slice(-2)).toEqual([
        "gap",
        "invalidate",
      ]);
      await until(() => events.list.length === 4);
      expect(events.list.map((e) => e.event)).toEqual([
        "hello",
        "invalidate",
        "gap",
        "invalidate",
      ]);
      expect(events.list[2]!.id).toBe(
        `${String(gap.epoch)}:${String(gap.seq)}`,
      );
      controller.abort();

      // A cursor before the gap cannot be replayed; one at it can.
      const early = await socketOf(app.ws);
      await early.request("subscribe", { tags: [tag] });
      await early.request("resume", before);
      expect(early.of("gap").length).toBe(1);
      const late = await socketOf(app.ws);
      await late.request("subscribe", { tags: [tag] });
      await late.request("resume", gap);
      expect(late.of("gap")).toEqual([]);
      expect(late.invalidations()).toEqual([[(gap.seq as number) + 1, [tag]]]);
      for (const s of [socket, early, late]) s.ws.close();
    } finally {
      await app.close();
      await connection.close();
    }
  });

  it("sends a gap for a truncated message, the bus's onGap, and every subscription", async () => {
    const app = await serve();
    try {
      const tag = fresh("t");
      const socket = await socketOf(app.ws);
      await socket.request("subscribe", { tags: [tag] });
      const script = scriptedBus();
      const connection = connectLiveBus(script.bus);
      await connection.ready;
      // Nothing published before the subscription reached this process.
      await until(() => socket.of("gap").length === 1);
      script.deliver({ origin: other(), n: 1, tags: [tag], truncated: true });
      await until(() => socket.of("gap").length === 2);
      script.gap();
      await until(() => socket.of("gap").length === 3);
      // A truncated message's tags are never delivered: only the gap.
      expect(socket.invalidations()).toEqual([]);
      const seqs = socket.of("gap").map((f) => f.data!.seq as number);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
      socket.ws.close();
      await connection.close();
    } finally {
      await app.close();
    }
  });
});

describe("when the bus is down", () => {
  it("retries the subscription, saying so once", async () => {
    const script = scriptedBus();
    script.state.failSubscribes = 1;
    const { logger, events } = createTestLogger();
    const connection = connectLiveBus(script.bus, { logger });
    await connection.ready;
    expect(script.state.subscribes).toBe(2);
    expect(events.filter((e) => e.level === "warn").length).toBe(1);
    expect(events.some((e) => e.message.includes("subscribed again"))).toBe(
      true,
    );
    await connection.close();
  });

  it("keeps delivering locally when a publish fails, logs the outage once, and spends the numbers", async () => {
    const script = scriptedBus();
    const { logger, events } = createTestLogger();
    const connection = connectLiveBus(script.bus, { logger });
    await connection.ready;
    const app = await serve();
    try {
      const tag = fresh("down");
      const socket = await socketOf(app.ws);
      await socket.request("subscribe", { tags: [tag] });
      script.state.failPublish = true;
      publishTags([tag]);
      await Bun.sleep(5);
      publishTags([tag]);
      await until(() => socket.invalidations().length === 2);
      await Bun.sleep(20);
      expect(events.filter((e) => e.level === "warn").length).toBe(1);
      script.state.failPublish = false;
      publishTags([tag]);
      await until(() => script.published.length === 1);
      // n = 1 and 2 were lost: a receiver sees the hole.
      expect(script.published[0]!.n).toBe(3);
      expect(events.some((e) => e.message.includes("publishing again"))).toBe(
        true,
      );
      socket.ws.close();
    } finally {
      await app.close();
      await connection.close();
    }
  });
});

describe("one bus per process", () => {
  it("refuses another bus, shares the same one, and stops with its last holder", async () => {
    const script = scriptedBus();
    const one = connectLiveBus(script.bus);
    const two = connectLiveBus(script.bus);
    await one.ready;
    expect(script.state.subscribes).toBe(1);
    expect(() => connectLiveBus(scriptedBus().bus)).toThrow(ConfigError);
    await one.close();
    await one.close();
    expect(script.state.unsubscribes).toBe(0);
    publishTags([fresh("still")]);
    await until(() => script.published.length === 1);
    await two.close();
    expect(script.state.unsubscribes).toBe(1);
    publishTags([fresh("after")]);
    await Bun.sleep(20);
    expect(script.published.length).toBe(1);
    // Free again: another bus may connect.
    const next = connectLiveBus(scriptedBus().bus);
    await next.close();
  });

  it("refuses something that is not a bus", () => {
    expect(() => connectLiveBus({} as LiveBus)).toThrow(TypeError);
  });

  it("liveInvalidation({ bus }) connects it with the app's logger, and refuses a second bus before registering anything", async () => {
    const script = scriptedBus();
    script.state.failSubscribes = 1;
    const app = await serve(script.bus);
    try {
      await until(() => script.state.subscribes === 2, 5000);
      expect(app.events.some((e) => e.message.includes("live bus"))).toBe(true);
      const second = new BunHttpAdapter(0);
      expect(() =>
        liveInvalidation(second, {
          authorize: (_req, _res, next) => next(),
          bus: scriptedBus().bus,
        }),
      ).toThrow(ConfigError);
      expect(second.getBunWebsocket()?.routesVersion ?? 0).toBe(0);
    } finally {
      await app.close();
    }
  });
});

/** Reads an SSE response's events as they arrive. */
function readEvents(response: Response) {
  const list: { event: string; id: string; data: unknown }[] = [];
  void (async () => {
    const reader = response
      .body!.pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        for (
          let end = buffer.indexOf("\n\n");
          end >= 0;
          end = buffer.indexOf("\n\n")
        ) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith(":")) continue;
          const field = (name: string) =>
            block
              .split("\n")
              .find((line) => line.startsWith(`${name}: `))
              ?.slice(name.length + 2) ?? "";
          list.push({
            event: field("event"),
            id: field("id"),
            data: JSON.parse(field("data")),
          });
        }
      }
    } catch {
      // Aborted.
    }
  })();
  return { list };
}
