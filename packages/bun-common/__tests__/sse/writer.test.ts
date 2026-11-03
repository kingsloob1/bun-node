/**
 * `SseWriter` on its own (bun-native-routes plan §16.3, §16.9; typed-client
 * `sse.md` §4): its body read directly, no server. Each behaviour with the
 * case that would fail without it:
 *
 * - the opening block and `retry:`; backpressure and shared promises (C2);
 *   the slow-client bound; the heartbeat; closing every way;
 * - `contract`: an event checked before it is encoded (a refusal throws and
 *   sends nothing), `"warn"` and `"off"`, an asynchronous vendor keeping the
 *   order, `data` encoded by the declaration's format;
 * - `ids: "auto"`, continuing after `Last-Event-ID` and explicit ids;
 * - `resume`: a replay ahead of live events, `"gap"`, a failure.
 */
import type { StandardSchemaV1 } from "../../lib/types/standardSchema";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ContractError } from "../../lib/contract/guard";
import { createTestLogger } from "../../lib/logging";
import { sse } from "../../lib/responseBodies";
import { SseParser, SseWriter } from "../../lib/sse";

const decoder = new TextDecoder();

/** Reads a writer's body until it ends, or `ms` pass (then cancels). */
async function readAll(
  writer: { readable: ReadableStream<Uint8Array> },
  ms = 2000,
): Promise<{ text: string; ended: "done" | "error" | "timeout" }> {
  const reader = writer.readable.getReader();
  let text = "";
  const deadline = Date.now() + ms;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      reader.read().then(
        (r) => r,
        () => "error" as const,
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(
          resolve,
          Math.max(0, deadline - Date.now()),
          "timeout",
        );
      }),
    ]);
    clearTimeout(timer);
    if (next === "timeout") {
      await reader.cancel().catch(() => undefined);
      return { text, ended: "timeout" };
    }
    if (next === "error") return { text, ended: "error" };
    if (next.done) return { text, ended: "done" };
    text += decoder.decode(next.value, { stream: true });
  }
}

/** The events the standard parser dispatches from `text`. */
function eventsOf(text: string) {
  const parser = new SseParser();
  return parser.push(text).filter((item) => item.kind === "event");
}

const Tick = z.object({ n: z.number() });
const Events = sse({ tick: Tick, message: z.string(), gap: null });

describe("opening", () => {
  it("sends `: ok` at once, then the events", async () => {
    const writer = new SseWriter({ heartbeatMs: 0 });
    void writer.send({ data: "a" });
    writer.close();
    expect((await readAll(writer)).text).toBe(": ok\n\ndata: a\n\n");
  });

  it("sends retry: with the opening, or alone with open: false", async () => {
    const withOpen = new SseWriter({ heartbeatMs: 0, retry: 1500 });
    withOpen.close();
    expect((await readAll(withOpen)).text).toBe(": ok\nretry: 1500\n\n");

    const alone = new SseWriter({ heartbeatMs: 0, retry: 0, open: false });
    alone.close();
    expect((await readAll(alone)).text).toBe("retry: 0\n\n");

    const none = new SseWriter({ heartbeatMs: 0, open: false });
    none.close();
    expect((await readAll(none)).text).toBe("");
  });

  it("refuses bad options", () => {
    expect(() => new SseWriter({ retry: -1 })).toThrow(TypeError);
    expect(() => new SseWriter({ heartbeatMs: -1 })).toThrow(TypeError);
    expect(
      () => new SseWriter({ ids: "sequential" as unknown as "auto" }),
    ).toThrow(TypeError);
    expect(
      () => new SseWriter({ contract: Tick as unknown as typeof Events }),
    ).toThrow(TypeError);
  });
});

describe("backpressure", () => {
  it("resolves at once under the high-water mark, and after a read past it", async () => {
    const writer = new SseWriter({
      heartbeatMs: 0,
      open: false,
      highWaterMark: 32,
    });
    let settled = false;
    const big = writer.send({ data: "x".repeat(64) });
    void big.then(() => {
      settled = true;
    });
    await Bun.sleep(20);
    // Nobody read: the promise waits.
    expect(settled).toBe(false);
    const reader = writer.readable.getReader();
    await reader.read();
    expect(await big).toBe(true);
    writer.close();
  });

  it("shares one promise per state: below the mark, and per backed-up period (C2)", async () => {
    const writer = new SseWriter({
      heartbeatMs: 0,
      open: false,
      highWaterMark: 1024,
    });
    const a = writer.send({ data: "a" });
    const b = writer.send({ data: "b" });
    expect(a).toBe(b);
    const c = writer.send({ data: "x".repeat(2048) });
    const d = writer.send({ data: "y" });
    expect(c).toBe(d);
    expect(c).not.toBe(a);
    writer.close();
    expect(await c).toBe(false);
  });

  it("disconnects a client that stopped reading, past maxQueuedBytes", async () => {
    const { logger, events } = createTestLogger();
    const writer = new SseWriter({
      heartbeatMs: 0,
      open: false,
      highWaterMark: 16,
      maxQueuedBytes: 256,
      logger,
    });
    let closedSeen = false;
    writer.onClose(() => {
      closedSeen = true;
    });
    const results: boolean[] = [];
    for (let i = 0; i < 20 && !writer.closed; i++) {
      results.push(
        await Promise.race([
          writer.send({ data: "x".repeat(40) }),
          Promise.resolve(true),
        ]),
      );
    }
    expect(writer.closed).toBe(true);
    expect(closedSeen).toBe(true);
    expect(results.at(-1)).toBe(false);
    expect(writer.signal.aborted).toBe(true);
    expect(await writer.send({ data: "late" })).toBe(false);
    expect((await readAll(writer)).ended).toBe("error");
    expect(events.some((e) => e.level === "warn")).toBe(true);
  });

  it("the control: with no bound a stalled client is buffered", async () => {
    const writer = new SseWriter({
      heartbeatMs: 0,
      open: false,
      highWaterMark: 16,
      maxQueuedBytes: Infinity,
    });
    for (let i = 0; i < 20; i++) void writer.send({ data: "x".repeat(40) });
    expect(writer.closed).toBe(false);
    writer.close();
  });
});

describe("heartbeat", () => {
  it("sends a bare comment after a quiet interval", async () => {
    const writer = new SseWriter({ heartbeatMs: 30, open: false });
    const read = readAll(writer, 400);
    await Bun.sleep(250);
    writer.close();
    const { text } = await read;
    expect(text.startsWith(":\n\n")).toBe(true);
  });

  it("skips a beat when something was written since the last", async () => {
    const writer = new SseWriter({ heartbeatMs: 100, open: false });
    const read = readAll(writer, 2000);
    const until = Date.now() + 600;
    while (Date.now() < until) {
      void writer.send({ data: "busy" });
      await Bun.sleep(10);
    }
    writer.close();
    const { text } = await read;
    // About 6 beats elapsed; each found a write since the last. One may
    // slip through on a loaded machine; without the skip there are ~6.
    expect(text.split(":\n\n").length - 1).toBeLessThan(2);
  });

  it("is off with heartbeatMs: 0", async () => {
    const writer = new SseWriter({ heartbeatMs: 0, open: false });
    const read = readAll(writer, 300);
    await Bun.sleep(150);
    writer.close();
    expect((await read).text).toBe("");
  });
});

describe("closing", () => {
  it("close() ends the stream after what is queued; onClose, signal and closed follow", async () => {
    const writer = new SseWriter({ heartbeatMs: 0, open: false });
    const calls: string[] = [];
    writer.onClose(() => calls.push("a"));
    const remove = writer.onClose(() => calls.push("removed"));
    remove();
    void writer.send({ data: "last" });
    writer.close();
    writer.close();
    expect(writer.closed).toBe(true);
    expect(writer.signal.aborted).toBe(true);
    expect(calls).toEqual(["a"]);
    expect(await readAll(writer)).toEqual({
      text: "data: last\n\n",
      ended: "done",
    });
    // A listener added after the close runs in a microtask.
    let late = false;
    writer.onClose(() => {
      late = true;
    });
    await Promise.resolve();
    expect(late).toBe(true);
  });

  it("the reader cancelling closes it (the client left)", async () => {
    const writer = new SseWriter({ heartbeatMs: 0 });
    await writer.readable.cancel();
    expect(writer.closed).toBe(true);
    expect(await writer.send({ data: "x" })).toBe(false);
  });

  it("the signal aborting closes it", async () => {
    const abort = new AbortController();
    const writer = new SseWriter({ heartbeatMs: 0, signal: abort.signal });
    expect(writer.closed).toBe(false);
    abort.abort();
    expect(writer.closed).toBe(true);
    const already = new SseWriter({
      heartbeatMs: 0,
      signal: AbortSignal.abort(),
    });
    expect(already.closed).toBe(true);
  });

  it("a throwing close listener is logged, and the others still run", () => {
    const { logger, events } = createTestLogger();
    const writer = new SseWriter({ heartbeatMs: 0, logger });
    let ran = false;
    writer.onClose(() => {
      throw new Error("listener");
    });
    writer.onClose(() => {
      ran = true;
    });
    writer.close();
    expect(ran).toBe(true);
    expect(events.some((e) => e.level === "error")).toBe(true);
  });
});

describe("contract", () => {
  it("checks each event before it is encoded: a refusal throws and sends nothing", async () => {
    const writer = new SseWriter({
      heartbeatMs: 0,
      open: false,
      contract: Events,
    });
    void writer.send({ event: "tick", data: { n: 1 } });
    expect(() =>
      writer.send({
        event: "tick",
        data: { n: "two" } as unknown as { n: number },
      }),
    ).toThrow(ContractError);
    expect(() =>
      writer.send({ event: "other" } as unknown as { event: "gap" }),
    ).toThrow(ContractError);
    void writer.send({ event: "gap" });
    void writer.send({ data: "plain" });
    writer.close();
    const { text, ended } = await readAll(writer);
    expect(ended).toBe("done");
    expect(eventsOf(text).map((e) => [e.event, e.data])).toEqual([
      ["tick", '{"n":1}'],
      ["gap", ""],
      ["message", '"plain"'],
    ]);
  });

  it("the control: the same bad event through an untyped writer is sent", async () => {
    const writer = new SseWriter({ heartbeatMs: 0, open: false });
    void writer.send({ event: "tick", data: { n: "two" } });
    writer.close();
    expect((await readAll(writer)).text).toBe(
      'event: tick\ndata: {"n":"two"}\n\n',
    );
  });

  it("encodes data by the declaration: JSON quotes a string, text sends it as it is", async () => {
    const json = new SseWriter({
      heartbeatMs: 0,
      open: false,
      contract: sse({ message: z.string() }),
    });
    void json.send({ data: "a\nb" });
    json.close();
    expect((await readAll(json)).text).toBe('data: "a\\nb"\n\n');

    const text = new SseWriter({
      heartbeatMs: 0,
      open: false,
      contract: sse({ message: z.string() }, { data: "text" }),
    });
    void text.send({ data: "a\nb" });
    text.close();
    expect((await readAll(text)).text).toBe("data: a\ndata: b\n\n");
  });

  it('"warn" logs a mismatch and sends it; "off" checks nothing', async () => {
    const { logger, events } = createTestLogger();
    const warn = new SseWriter({
      heartbeatMs: 0,
      open: false,
      contract: Events,
      validation: "warn",
      logger,
    });
    void warn.send({
      event: "tick",
      data: { n: "x" } as unknown as { n: number },
    });
    warn.close();
    expect(eventsOf((await readAll(warn)).text)).toHaveLength(1);
    expect(events.filter((e) => e.level === "warn")).toHaveLength(1);

    const off = new SseWriter({
      heartbeatMs: 0,
      open: false,
      contract: Events,
      validation: "off",
    });
    void off.send({ event: "nope" } as unknown as { event: "gap" });
    off.close();
    expect(eventsOf((await readAll(off)).text)).toHaveLength(1);
  });

  it("takes no pre-encoded bytes", () => {
    const writer = new SseWriter({ heartbeatMs: 0, contract: Events });
    expect(() =>
      writer.send(new Uint8Array([1]) as unknown as { event: "gap" }),
    ).toThrow(TypeError);
    writer.close();
  });

  it("an asynchronous vendor keeps the order, and its refusal rejects without cutting the stream", async () => {
    /** A schema that answers after `ms`, refusing `bad`. */
    const slow: StandardSchemaV1<{ n: number; ms: number; bad?: boolean }> = {
      "~standard": {
        version: 1,
        vendor: "test-async",
        validate: async (value) => {
          const v = value as { ms: number; bad?: boolean };
          await Bun.sleep(v.ms);
          return v.bad === true
            ? { issues: [{ message: "bad" }] }
            : { value: value as { n: number; ms: number } };
        },
      },
    };
    const writer = new SseWriter({
      heartbeatMs: 0,
      open: false,
      contract: sse({ tick: slow }),
    });
    const first = writer.send({ event: "tick", data: { n: 1, ms: 40 } });
    const second = writer.send({ event: "tick", data: { n: 2, ms: 0 } });
    const refused = writer.send({
      event: "tick",
      data: { n: 3, ms: 0, bad: true },
    });
    const fourth = writer.send({ event: "tick", data: { n: 4, ms: 0 } });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(
      await refused.then(
        () => "sent",
        (e: unknown) => e,
      ),
    ).toBeInstanceOf(ContractError);
    expect(await fourth).toBe(true);
    writer.close();
    const { text, ended } = await readAll(writer);
    expect(ended).toBe("done");
    expect(eventsOf(text).map((e) => JSON.parse(e.data).n)).toEqual([1, 2, 4]);
  });
});

describe('ids: "auto"', () => {
  it("numbers events from 1, skipping comments and id-only blocks, after explicit integer ids", async () => {
    const writer = new SseWriter({ heartbeatMs: 0, open: false, ids: "auto" });
    void writer.send({ data: "a" });
    void writer.comment("note");
    void writer.send({ event: "tick", data: "b" });
    void writer.send({ data: "c", id: 10 });
    void writer.send({ data: "d" });
    void writer.send({ data: "e", id: "custom" });
    void writer.send({ data: "f" });
    writer.close();
    expect(eventsOf((await readAll(writer)).text).map((e) => e.id)).toEqual([
      "1",
      "2",
      "10",
      "11",
      "custom",
      "12",
    ]);
  });

  it("continues after an integer Last-Event-ID, and starts at 1 after another", async () => {
    const resumed = new SseWriter({
      heartbeatMs: 0,
      open: false,
      ids: "auto",
      lastEventId: "41",
    });
    void resumed.send({ data: "a" });
    resumed.close();
    expect(eventsOf((await readAll(resumed)).text)[0]?.id).toBe("42");

    const other = new SseWriter({
      heartbeatMs: 0,
      open: false,
      ids: "auto",
      lastEventId: "abc",
    });
    void other.send({ data: "a" });
    other.close();
    expect(eventsOf((await readAll(other)).text)[0]?.id).toBe("1");
  });

  it("the control: without it, events carry no id", async () => {
    const writer = new SseWriter({ heartbeatMs: 0, open: false });
    void writer.send({ data: "a" });
    writer.close();
    expect((await readAll(writer)).text).toBe("data: a\n\n");
  });
});

describe("resume", () => {
  it("replays the hook's events ahead of every live one", async () => {
    const seen: string[] = [];
    const writer = new SseWriter({
      heartbeatMs: 0,
      open: false,
      contract: Events,
      lastEventId: "7",
      async *resume(id) {
        seen.push(id);
        await Bun.sleep(20);
        yield { event: "tick", data: { n: 8 }, id: 8 };
        yield { event: "tick", data: { n: 9 }, id: 9 };
      },
    });
    expect(writer.lastEventId).toBe("7");
    // Sent while the replay is still running: it waits.
    const live = writer.send({ event: "tick", data: { n: 10 }, id: 10 });
    expect(await live).toBe(true);
    writer.close();
    const { text } = await readAll(writer);
    expect(seen).toEqual(["7"]);
    expect(eventsOf(text).map((e) => e.id)).toEqual(["8", "9", "10"]);
  });

  it('"gap" sends the declared gap event', async () => {
    const writer = new SseWriter({
      heartbeatMs: 0,
      open: false,
      contract: Events,
      lastEventId: "old",
      resume: () => "gap",
    });
    void writer.send({ event: "tick", data: { n: 1 } });
    writer.close();
    expect(eventsOf((await readAll(writer)).text).map((e) => e.event)).toEqual([
      "gap",
      "tick",
    ]);
  });

  it("is not called without a Last-Event-ID (or with an empty one)", async () => {
    let calls = 0;
    const resume = () => {
      calls++;
      return [];
    };
    const none = new SseWriter({ heartbeatMs: 0, resume });
    const empty = new SseWriter({ heartbeatMs: 0, resume, lastEventId: "" });
    await Bun.sleep(5);
    expect(calls).toBe(0);
    expect(none.lastEventId).toBeUndefined();
    expect(empty.lastEventId).toBeUndefined();
    none.close();
    empty.close();
  });

  it("a failed replay drops the live events queued behind it, so the client does not believe it is up to date", async () => {
    const { logger } = createTestLogger();
    const writer = new SseWriter({
      heartbeatMs: 0,
      open: false,
      logger,
      lastEventId: "1",
      resume: async () => {
        await Bun.sleep(10);
        throw new Error("store down");
      },
    });
    const live = writer.send({ data: "live" });
    expect(await live).toBe(false);
    expect(await readAll(writer)).toEqual({ text: "", ended: "done" });
  });

  it("close() waits for the replay and the events behind it", async () => {
    const writer = new SseWriter({
      heartbeatMs: 0,
      open: false,
      lastEventId: "1",
      resume: async () => {
        await Bun.sleep(10);
        return [{ data: "replayed" }];
      },
    });
    void writer.send({ data: "live" });
    writer.close();
    expect(writer.closed).toBe(true);
    expect(await writer.send({ data: "after close" })).toBe(false);
    expect(await readAll(writer)).toEqual({
      text: "data: replayed\n\ndata: live\n\n",
      ended: "done",
    });
  });

  it("a failing hook closes the stream and is logged; with onError the app decides", async () => {
    const { logger, events } = createTestLogger();
    const failing = new SseWriter({
      heartbeatMs: 0,
      open: false,
      logger,
      lastEventId: "1",
      resume: () => {
        throw new Error("store down");
      },
    });
    expect((await readAll(failing)).ended).toBe("done");
    expect(failing.closed).toBe(true);
    expect(events.some((e) => e.level === "error")).toBe(true);

    const handled = new SseWriter({
      heartbeatMs: 0,
      open: false,
      contract: Events,
      lastEventId: "1",
      // A replayed event its contract refuses is a failure too.
      resume: () => [
        { event: "tick", data: { n: "x" } as unknown as { n: number } },
      ],
      onError: (error, writer) => {
        expect(error).toBeInstanceOf(ContractError);
        void writer.send({ event: "gap" });
        writer.close();
      },
    });
    expect(eventsOf((await readAll(handled)).text).map((e) => e.event)).toEqual(
      ["gap"],
    );
  });
});
