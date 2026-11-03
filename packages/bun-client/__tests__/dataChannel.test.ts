/**
 * `typedDataChannel` (lib/webrtc.ts, PR-R2), two ways:
 *
 * - **Real peers**: node-datachannel's polyfill on both sides, connected by
 *   `connectPeer` over bun-common's relay (`fixtures/peers.ts`): typed,
 *   checked messages each way in the channel envelope and in order,
 *   request/response with the answer from the other peer's listener, the
 *   sender guard refusing before the wire and the receiver guard on what a
 *   peer without one sends (warn, `"drop"`, production off), error frames
 *   for an undeclared request and a throwing answer, binary frames checked
 *   by kind and size and delivered as `Uint8Array`, an unreliable channel
 *   refusing requests, `symmetric`, sends made while connecting, `close()`.
 * - **A scripted channel** (`FakeChannel`), for what a real stack does not
 *   let a test hold still: `sendWhenReady` waits on `bufferedamountlow` (not
 *   a poll), in order; binary normalised from every kind a stack delivers.
 */
import type { Pair } from "./fixtures/peers";
import { Buffer } from "node:buffer";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { channelContract } from "@kingsleyweb/bun-contract";
import { cleanup } from "node-datachannel";
import { z } from "zod";
import {
  ChannelClosedError,
  ChannelError,
  RequestTimeoutError,
  ValidationError,
} from "../lib/errors";
import { typedDataChannel } from "../lib/webrtc";
import { connectedPair } from "./fixtures/peers";

/** The shared contract: what both peers' modules import. */
const chat = channelContract({
  path: "/dc/chat", // a name only: a data channel has no route
  receives: {
    say: z.object({ text: z.string().min(1), at: z.number().int() }),
    ask: z.object({ q: z.string() }),
    nudge: null,
  },
  sends: {
    said: z.object({ by: z.string(), text: z.string() }),
    answer: z.object({ a: z.string() }),
  },
  replies: { ask: "answer" },
});

/** Pairs to close after each test. */
const pairs: Pair[] = [];
afterEach(async () => {
  for (const pair of pairs.splice(0)) await pair.close();
});
// node-datachannel's native threads keep the process alive until cleaned up.
afterAll(() => cleanup());

/** A connected pair, closed after the test. */
async function pair(init?: Parameters<typeof connectedPair>[1]) {
  const made = await connectedPair("chat", init);
  pairs.push(made);
  return made;
}

/** A logger that keeps what it is given. */
function recording() {
  const warned: string[] = [];
  const errored: string[] = [];
  return {
    warned,
    errored,
    logger: {
      warn: (...args: unknown[]) =>
        void warned.push(args.map(String).join(" ")),
      error: (...args: unknown[]) =>
        void errored.push(args.map(String).join(" ")),
    },
  };
}

/** Resolves with the first `n` values `subscribe` hands its callback. */
function collect<T>(
  n: number,
  subscribe: (push: (value: T) => void) => void,
): Promise<T[]> {
  const values: T[] = [];
  return new Promise((resolve) => {
    subscribe((value) => {
      values.push(value);
      if (values.length === n) resolve(values);
    });
  });
}

/** Waits a little, for frames that must not arrive. */
const settle = (ms = 150): Promise<void> => Bun.sleep(ms);

describe("typedDataChannel between two node-datachannel peers", () => {
  it("carries typed, checked messages each way, in order", async () => {
    const { a, b } = await pair();
    const alice = typedDataChannel(a, chat, {
      side: "client",
      mode: "development",
    });
    const bob = typedDataChannel(b, chat, {
      side: "server",
      mode: "development",
    });
    const atBob = collect<{ text: string; at: number }>(200, (push) =>
      bob.on("say", (data) => push(data)),
    );
    for (let i = 0; i < 200; i++) alice.send("say", { text: `m${i}`, at: i });
    expect((await atBob).map((m) => m.at)).toEqual(
      Array.from({ length: 200 }, (_, i) => i),
    );
    const atAlice = collect<{ by: string; text: string }>(1, (push) =>
      alice.on("said", (data) => push(data)),
    );
    bob.send("said", { by: "bob", text: "hi" });
    expect(await atAlice).toEqual([{ by: "bob", text: "hi" }]);
    const nudged = collect<unknown>(1, (push) =>
      bob.on("nudge", (data) => push(data)),
    );
    alice.send("nudge");
    expect(await nudged).toEqual([undefined]);
    expect(alice.state).toBe("open");
    expect(alice.bufferedAmount).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("answers a request with the other peer's listener, sync or async, and its id", async () => {
    const { a, b } = await pair();
    const alice = typedDataChannel(a, chat, { side: "client" });
    const bob = typedDataChannel(b, chat, { side: "server" });
    bob.on("ask", async (data) => {
      await Bun.sleep(5);
      return { a: `re:${data.q}` };
    });
    const [one, two] = await Promise.all([
      alice.request("ask", { q: "1" }),
      alice.request("ask", { q: "2" }),
    ]);
    expect([one, two]).toEqual([{ a: "re:1" }, { a: "re:2" }]);
  }, 30_000);

  it("refuses an invalid send before the wire, and the other peer sees nothing", async () => {
    const { a, b } = await pair();
    const alice = typedDataChannel(a, chat, {
      side: "client",
      mode: "development",
    });
    const bob = typedDataChannel(b, chat, { side: "server", validate: false });
    bob.on("ask", () => ({ a: "ok" }));
    const raw: string[] = [];
    b.addEventListener("message", (event) =>
      raw.push(String((event as MessageEvent).data)),
    );
    // The checks load lazily: a send before they have waits for them (its
    // failure can only reach $error); a request answered means they have,
    // and from then on a send (synchronous zod) throws.
    await alice.request("ask", { q: "warm" });
    expect(() => alice.send("say", { text: "", at: 1.5 })).toThrow(
      ValidationError,
    );
    await settle();
    expect(raw.filter((text) => text.includes('"say"'))).toEqual([]);
  }, 30_000);

  it("checks what a peer without the guard sends: warn and deliver by default, drop with $invalid, off in production", async () => {
    const { a, b } = await pair();
    const warnRec = recording();
    const bob = typedDataChannel(b, chat, {
      side: "server",
      mode: "development",
      logger: warnRec.logger,
    });
    const delivered = collect<unknown>(1, (push) => bob.on("say", push));
    a.send(JSON.stringify({ type: "say", data: { text: "", at: 1.5 } }));
    expect(await delivered).toEqual([{ text: "", at: 1.5 }]);
    expect(warnRec.warned.join("\n")).toContain("failed validation");

    const dropper = typedDataChannel(b, chat, {
      side: "server",
      mode: "development",
      validate: { onFailure: { receive: "drop" } },
      logger: recording().logger,
    });
    const invalid = collect<ValidationError>(1, (push) =>
      dropper.on("$invalid", push),
    );
    let reached = 0;
    dropper.on("say", () => void reached++);
    a.send(JSON.stringify({ type: "say", data: { text: 3 } }));
    const [error] = await invalid;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.direction).toBe("receive");
    expect(error.issues.map((i) => i.path).sort()).toEqual(["at", "text"]);
    await settle();
    expect(reached).toBe(0);

    const production = typedDataChannel(b, chat, {
      side: "server",
      mode: "production",
      logger: recording().logger,
    });
    const unchecked = collect<unknown>(1, (push) => production.on("say", push));
    a.send(JSON.stringify({ type: "say", data: { text: 7 } }));
    expect(await unchecked).toEqual([{ text: 7 }]);
  }, 30_000);

  it("answers an undeclared request with UNKNOWN_MESSAGE, an invalid one with VALIDATION, a throwing listener with EXCEPTION", async () => {
    const { a, b } = await pair();
    const bob = typedDataChannel(b, chat, {
      side: "server",
      mode: "development",
      validate: { onFailure: { receive: "drop" } },
      logger: recording().logger,
    });
    bob.on("ask", (data) => {
      if (data.q === "boom") throw new Error("handler failed");
      return { a: "ok" };
    });
    const frames = collect<Record<string, unknown>>(3, (push) =>
      a.addEventListener("message", (event) =>
        push(
          JSON.parse(String((event as MessageEvent).data)) as Record<
            string,
            unknown
          >,
        ),
      ),
    );
    a.send(JSON.stringify({ type: "shout", id: "u1", data: {} }));
    a.send(JSON.stringify({ type: "ask", id: "v1", data: { q: 1 } }));
    a.send(JSON.stringify({ type: "ask", id: "x1", data: { q: "boom" } }));
    const byId = Object.fromEntries((await frames).map((f) => [f.id, f]));
    expect(byId.u1).toMatchObject({ type: "error", code: "UNKNOWN_MESSAGE" });
    expect(byId.v1).toMatchObject({ type: "error", code: "VALIDATION" });
    expect((byId.v1!.issues as { path: string }[]).map((i) => i.path)).toEqual([
      "q",
    ]);
    expect(byId.x1).toEqual({
      type: "error",
      id: "x1",
      code: "EXCEPTION",
      status: 500,
    });

    // The requester side rejects with the frame.
    const alice = typedDataChannel(a, chat, {
      side: "client",
      mode: "production",
    });
    const refused = await alice
      .request("ask", { q: "boom" })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ChannelError);
    expect((refused as ChannelError).code).toBe("EXCEPTION");
    expect((refused as ChannelError).type).toBe("ask");
  }, 30_000);

  it("times a request out when no answer comes", async () => {
    const { a, b } = await pair();
    typedDataChannel(b, chat, { side: "server" }); // no ask listener: no answer
    const alice = typedDataChannel(a, chat, { side: "client", timeout: 100 });
    const error = await alice
      .request("ask", { q: "?" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestTimeoutError);
  }, 30_000);

  it("sends and checks binary frames by kind and size, delivered as Uint8Array", async () => {
    const { a, b } = await pair();
    const alice = typedDataChannel(a, chat, {
      side: "client",
      binary: { maxBytes: 8 },
    });
    const errors: unknown[] = [];
    const bob = typedDataChannel(b, chat, {
      side: "server",
      binary: { maxBytes: 8 },
      logger: recording().logger,
    });
    bob.on("$error", (error) => errors.push(error));
    const bytes = collect<Uint8Array>(1, (push) => bob.on("$binary", push));
    alice.sendBinary(new Uint8Array([1, 2, 3, 4, 5]));
    const [got] = await bytes;
    expect(got).toBeInstanceOf(Uint8Array);
    expect([...got]).toEqual([1, 2, 3, 4, 5]);
    expect(() => alice.sendBinary(new Uint8Array(9))).toThrow(RangeError);
    // A peer without the wrapper's check sends more than the declared size.
    a.send(new Uint8Array(10));
    await settle();
    expect(errors).toHaveLength(1);
    expect((errors[0] as ChannelError).code).toBe("UNSUPPORTED_DATA");

    const plain = typedDataChannel(a, chat, { side: "client" });
    expect(() => plain.sendBinary(new Uint8Array(1))).toThrow(TypeError);
  }, 30_000);

  it("refuses requests on an unreliable channel", async () => {
    const { a } = await pair({ maxRetransmits: 0 });
    const alice = typedDataChannel(a, chat, { side: "client" });
    await expect(alice.request("ask", { q: "?" })).rejects.toThrow(
      "needs a reliable data channel",
    );
  }, 30_000);

  it("symmetric: both peers send and receive `receives`, and request each other", async () => {
    const { a, b } = await pair();
    // One map for both directions, the reply type in it too.
    const peerToPeer = channelContract({
      path: "/dc/p2p",
      receives: {
        say: z.object({ text: z.string(), at: z.number() }),
        ask: z.object({ q: z.string() }),
        answer: z.object({ a: z.string() }),
      },
      sends: {},
      replies: { ask: "answer" },
    });
    const one = typedDataChannel(a, peerToPeer, { symmetric: true });
    const two = typedDataChannel(b, peerToPeer, { symmetric: true });
    one.on("ask", (data) => ({ a: `one:${data.q}` }));
    two.on("ask", (data) => ({ a: `two:${data.q}` }));
    expect(await one.request("ask", { q: "x" })).toEqual({ a: "two:x" });
    expect(await two.request("ask", { q: "y" })).toEqual({ a: "one:y" });
    const said = collect<unknown>(1, (push) => one.on("say", push));
    two.send("say", { text: "both ways", at: 1 });
    expect(await said).toEqual([{ text: "both ways", at: 1 }]);
  }, 30_000);

  it("close(): a waiting request rejects, and a later send throws", async () => {
    const { a, b } = await pair();
    typedDataChannel(b, chat, { side: "server" });
    const alice = typedDataChannel(a, chat, { side: "client" });
    const waiting = alice.request("ask", { q: "?" }).catch((e: unknown) => e);
    alice.close();
    expect(await waiting).toBeInstanceOf(ChannelClosedError);
    expect(() => alice.send("nudge")).toThrow(ChannelClosedError);
  }, 30_000);
});

/* ------------------------------------------------------------------------ */
/* A scripted data channel                                                   */
/* ------------------------------------------------------------------------ */

/** An `RTCDataChannel` whose state and buffer the test sets, recording what is sent. */
class FakeChannel extends EventTarget {
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = "blob";
  readonly sent: (string | Uint8Array)[] = [];
  send(data: string | Uint8Array): void {
    if (this.readyState !== "open") throw new Error("not open");
    this.sent.push(data);
  }
  close(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
  /** Opens it. */
  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }
  /** Delivers a frame. */
  deliver(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

describe("typedDataChannel, scripted", () => {
  it("writes the sends made while connecting, in order, once it opens; sets binaryType", () => {
    const fake = new FakeChannel();
    const dc = typedDataChannel(fake, chat, {
      side: "client",
      validate: false,
    });
    expect(fake.binaryType).toBe("arraybuffer");
    dc.send("say", { text: "1", at: 1 });
    dc.send("nudge");
    expect(fake.sent).toEqual([]);
    fake.open();
    expect(fake.sent).toEqual([
      '{"type":"say","data":{"text":"1","at":1}}',
      '{"type":"nudge"}',
    ]);
  });

  it("sendWhenReady waits for open and bufferedamountlow under the mark, not by polling, and in order", async () => {
    const fake = new FakeChannel();
    const dc = typedDataChannel(fake, chat, {
      side: "client",
      validate: false,
    });
    const order: string[] = [];
    const first = dc
      .sendWhenReady("say", { text: "a", at: 1 }, { highWaterMark: 100 })
      .then(() => order.push("a"));
    const second = dc
      .sendWhenReady("nudge", undefined, { highWaterMark: 1_000_000 })
      .then(() => order.push("b"));
    fake.bufferedAmount = 500;
    fake.open();
    await settle(30);
    expect(order).toEqual([]);
    expect(fake.bufferedAmountLowThreshold).toBe(100);
    // Drained without the event: a poll would see it, the event-driven wait does not.
    fake.bufferedAmount = 50;
    await settle(60);
    expect(order).toEqual([]);
    fake.dispatchEvent(new Event("bufferedamountlow"));
    await Promise.all([first, second]);
    expect(order).toEqual(["a", "b"]);
    expect(fake.sent).toEqual([
      '{"type":"say","data":{"text":"a","at":1}}',
      '{"type":"nudge"}',
    ]);
  });

  it("sendWhenReady rejects when the channel closes first", async () => {
    const fake = new FakeChannel();
    const dc = typedDataChannel(fake, chat, {
      side: "client",
      validate: false,
    });
    const waiting = dc.sendWhenReady("nudge").catch((e: unknown) => e);
    fake.close();
    expect(await waiting).toBeInstanceOf(ChannelClosedError);
  });

  it("normalises binary to Uint8Array: an ArrayBuffer, a Uint8Array (werift), a Buffer view, a Blob", async () => {
    const fake = new FakeChannel();
    const dc = typedDataChannel(fake, chat, {
      side: "client",
      binary: { maxBytes: 16 },
    });
    const got = collect<Uint8Array>(4, (push) => dc.on("$binary", push));
    const backing = new Uint8Array([9, 9, 1, 2, 9]);
    fake.deliver(new Uint8Array([1, 2]).buffer);
    fake.deliver(new Uint8Array([1, 2]));
    fake.deliver(Buffer.from(backing.buffer, 2, 2));
    fake.deliver(new Blob([new Uint8Array([1, 2])]));
    const all = await got;
    for (const bytes of all) {
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect([...bytes]).toEqual([1, 2]);
    }
  });

  it("throws a TypeError without a side, or with both", () => {
    const fake = new FakeChannel();
    expect(() =>
      typedDataChannel(fake, chat, {} as unknown as { side: "client" }),
    ).toThrow(TypeError);
    expect(() =>
      typedDataChannel(fake, chat, {
        side: "client",
        symmetric: true,
      } as unknown as { symmetric: true }),
    ).toThrow(TypeError);
  });
});
