/**
 * A broadcast channel with a contract (bun-native-routes plan §16.14.8,
 * PR-sse2c): `createSseChannel({ contract: sse({ … }) })` checks every event
 * with the contract's sender guard before it is encoded, so a bad event is
 * refused to the caller (`send()` throws its `ContractError`, as a writer's
 * `send()` does for a synchronous schema under `"error"`) and no subscriber,
 * replay buffer or transport ever sees it. Each case has its control: the
 * same channel taking a valid event, or the untyped channel taking the
 * invalid one.
 */
import type { SseMessage } from "../../lib/sse/format";
import type {
  SseChannelTransport,
  SseTransportEnvelope,
} from "../../lib/sse/channel";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ContractError } from "../../lib/contract/guard";
import { createTestLogger } from "../../lib/logging";
import { createSseChannel } from "../../lib/sse/channel";
import { sse, sseVariants } from "../../lib/sse/declaration";
import { readSse } from "../../lib/sse/parser";
import { SseWriter } from "../../lib/sse/writer";

const Prices = sse({
  tick: z.object({ p: z.number() }),
  message: z.string(),
  gap: null,
  quote: sseVariants({
    bid: { data: z.object({ bid: z.number() }) },
    // A `when` that never holds: a writer would never try this variant; a
    // channel, with no request to ask, tries every one.
    ask: { data: z.object({ ask: z.number() }), when: () => false },
  }),
});

/** What a `listen()` subscriber got, as `[event, data]`. */
function collector() {
  const got: [string | undefined, unknown][] = [];
  return {
    got,
    listener: (message: SseMessage) => {
      got.push([message.event, message.data]);
    },
  };
}

/** The events a writer subscriber received once the writer is closed. */
async function received(writer: SseWriter): Promise<string[]> {
  writer.close();
  const out: string[] = [];
  for await (const item of readSse(writer.readable)) {
    if (item.kind === "event") out.push(`${item.event} ${item.data}`);
  }
  return out;
}

/** A bare writer: no opening, no heartbeat. */
function writer(): SseWriter {
  return new SseWriter({ open: false, heartbeatMs: 0 });
}

/** Sends `message` past `send()`'s type, as an untyped caller would. */
function sendLoose(
  channel: { send: (message: never, options?: { topic?: string }) => number },
  message: SseMessage,
): number {
  return channel.send(message as never);
}

describe("createSseChannel({ contract }): checked before it is broadcast", () => {
  it('"error": a bad event throws its ContractError, and no subscriber, replay buffer or transport sees it; a good one goes out (the control)', () => {
    const published: unknown[] = [];
    const transport: SseChannelTransport = {
      publish: (envelope) => {
        published.push(envelope);
      },
      subscribe: () => () => {},
    };
    const prices = createSseChannel({
      contract: Prices,
      heartbeatMs: 0,
      replay: 10,
      transport,
    });
    const seen = collector();
    prices.listen(seen.listener);
    let thrown: unknown;
    try {
      sendLoose(prices, { event: "tick", data: { p: "101" } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    expect((thrown as ContractError).issues.length).toBeGreaterThan(0);
    expect(() => sendLoose(prices, { event: "other", data: 1 })).toThrow(
      ContractError,
    );
    expect(seen.got).toEqual([]);
    expect(published).toEqual([]);
    // Nothing kept: no id to resume from.
    expect(prices.listen(() => {}, { lastEventId: "x" }).replay).toBe("miss");

    expect(prices.send({ event: "tick", data: { p: 101 } })).toBe(2);
    expect(seen.got).toEqual([["tick", { p: 101 }]]);
    expect(published).toHaveLength(1);
  });

  it("the untyped channel sends the same event unchecked (the control for the refusal)", () => {
    const loose = createSseChannel({ heartbeatMs: 0 });
    const seen = collector();
    loose.listen(seen.listener);
    expect(loose.send({ event: "tick", data: { p: "101" } })).toBe(1);
    expect(seen.got).toEqual([["tick", { p: "101" }]]);
  });

  it("variants: checked against their union, `when` not consulted; data no variant takes is refused; a named variant checks that one", () => {
    const prices = createSseChannel({ contract: Prices, heartbeatMs: 0 });
    const seen = collector();
    prices.listen(seen.listener);
    // `ask`'s `when` is false, yet a broadcast takes it.
    prices.send({ event: "quote", data: { ask: 2 } });
    prices.send({ event: "quote", data: { bid: 1 } });
    prices.send({ event: "quote", variant: "ask", data: { ask: 3 } });
    expect(() =>
      sendLoose(prices, { event: "quote", data: { neither: 1 } }),
    ).toThrow(ContractError);
    expect(() =>
      sendLoose(prices, {
        event: "quote",
        variant: "ask",
        data: { bid: 1 },
      } as SseMessage),
    ).toThrow(ContractError);
    expect(seen.got.map(([, data]) => data)).toEqual([
      { ask: 2 },
      { bid: 1 },
      { ask: 3 },
    ]);

    // The control: a writer, which asks `when`, refuses the same event.
    const stream = new SseWriter({
      contract: Prices,
      open: false,
      heartbeatMs: 0,
    });
    expect(() => stream.send({ event: "quote", data: { ask: 2 } })).toThrow(
      ContractError,
    );
    stream.close();
  });

  it('the contract\'s data format: "json" stringifies strings too, "text" writes them as they are; the untyped channel as they are (the control)', async () => {
    const json = createSseChannel({ contract: Prices, heartbeatMs: 0 });
    const text = createSseChannel({
      contract: sse({ message: z.string() }, { data: "text" }),
      heartbeatMs: 0,
    });
    const loose = createSseChannel({ heartbeatMs: 0 });
    const [a, b, c] = [writer(), writer(), writer()];
    json.attach(a);
    text.attach(b);
    loose.attach(c);
    json.send({ data: "hi" });
    json.send({ event: "tick", data: { p: 1 } });
    json.send({ event: "gap" });
    text.send({ data: "hi" });
    loose.send({ data: "hi" });
    expect(await received(a)).toEqual(['message "hi"', 'tick {"p":1}', "gap "]);
    expect(await received(b)).toEqual(["message hi"]);
    expect(await received(c)).toEqual(["message hi"]);
  });

  it('"warn" logs a mismatch and sends it; "off" sends it without a word', () => {
    for (const validation of ["warn", "off"] as const) {
      const { logger, events } = createTestLogger();
      const prices = createSseChannel({
        contract: Prices,
        validation,
        heartbeatMs: 0,
        writer: { logger },
      });
      const seen = collector();
      prices.listen(seen.listener);
      expect(sendLoose(prices, { event: "tick", data: { p: "x" } })).toBe(1);
      expect(seen.got).toEqual([["tick", { p: "x" }]]);
      expect(events.filter((e) => e.level === "warn")).toHaveLength(
        validation === "warn" ? 1 : 0,
      );
    }
  });

  it("sendList(): every item is checked first; one bad item throws and none goes out", () => {
    const prices = createSseChannel({ contract: Prices, heartbeatMs: 0 });
    const seen = collector();
    prices.listen(seen.listener);
    expect(() =>
      prices.sendList([{ p: 1 }, { p: "2" } as never, { p: 3 }], {
        event: "tick",
      }),
    ).toThrow(ContractError);
    expect(seen.got).toEqual([]);
    expect(prices.sendList([{ p: 1 }, { p: 2 }], { event: "tick" })).toBe(1);
    expect(seen.got).toEqual([
      ["tick", { p: 1 }],
      ["tick", { p: 2 }],
    ]);
  });

  it("the initial state: a bad list throws at setInitial() and changes nothing; a function's bad event goes to onError and is skipped", async () => {
    const errors: unknown[] = [];
    const prices = createSseChannel({
      contract: Prices,
      heartbeatMs: 0,
      initial: [{ event: "tick", data: { p: 1 } }],
      onError: (error) => errors.push(error),
    });
    expect(() =>
      prices.setInitial([{ event: "tick", data: { p: "bad" } } as never]),
    ).toThrow(ContractError);
    const first = collector();
    prices.listen(first.listener);
    expect(first.got).toEqual([["tick", { p: 1 }]]);

    prices.setInitial(() => [
      { event: "tick", data: { p: "bad" } } as never,
      { event: "tick", data: { p: 2 } },
    ]);
    const second = collector();
    prices.listen(second.listener);
    expect(second.got).toEqual([["tick", { p: 2 }]]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ContractError);
  });

  it("a schema that checks asynchronously cannot be waited for: send() throws a TypeError and sends nothing", () => {
    const Slow = sse({
      tick: z.object({ p: z.number() }).refine(async () => true),
    });
    const slow = createSseChannel({ contract: Slow, heartbeatMs: 0 });
    const seen = collector();
    slow.listen(seen.listener);
    expect(() => slow.send({ event: "tick", data: { p: 1 } })).toThrow(
      TypeError,
    );
    expect(seen.got).toEqual([]);
  });

  it("an event from another process was checked by its sender and is not checked again", async () => {
    const listeners = new Set<(envelope: SseTransportEnvelope) => void>();
    const bus = (): SseChannelTransport => ({
      publish: (envelope) => {
        for (const listener of listeners) listener(envelope);
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const sender = createSseChannel({ heartbeatMs: 0, transport: bus() });
    const typed = createSseChannel({
      contract: Prices,
      heartbeatMs: 0,
      transport: bus(),
    });
    const seen = collector();
    typed.listen(seen.listener);
    sender.send({ event: "tick", data: { p: "unchecked" } });
    expect(seen.got).toEqual([["tick", { p: "unchecked" }]]);
    sender.close();
    typed.close();
  });

  it("a contract that is not an sse() declaration throws a TypeError", () => {
    expect(() =>
      createSseChannel({ contract: { events: {} } as never }),
    ).toThrow(TypeError);
  });
});
