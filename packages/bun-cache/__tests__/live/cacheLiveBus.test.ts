/**
 * `cacheLiveBus` over a scripted `CacheBus`: how a live message is written as
 * a bus message and read back; Postgres's oversized `clear` read as a
 * truncated message; other namespaces, other types and foreign origins
 * ignored; `onGap` passed through. The two-process proof on Redis is
 * `servers.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import type { LiveBusMessage } from "@kingsleyweb/bun-common/live";
import type { BusMessage, CacheBus } from "../../lib/index";
import { cacheLiveBus, DEFAULT_LIVE_NAMESPACE } from "../../lib/live/index";

/** A bus that records what is published and lets the test deliver. */
function scripted() {
  const published: BusMessage[] = [];
  let deliver: ((message: BusMessage) => void) | undefined;
  let gap: (() => void) | undefined;
  const bus: CacheBus = {
    name: "scripted",
    publish: async (message) => {
      published.push(message);
    },
    subscribe: async (onMessage, onGap) => {
      deliver = onMessage;
      gap = onGap;
      return async () => {};
    },
    close: async () => {},
  };
  return {
    bus,
    published,
    deliver: (message: BusMessage) => deliver?.(message),
    gap: () => gap?.(),
  };
}

describe("cacheLiveBus", () => {
  it("writes a live message as an invalidate-tags message in its namespace, and reads it back", async () => {
    const script = scripted();
    const live = cacheLiveBus(script.bus);
    expect(live.name).toBe("scripted");
    const received: LiveBusMessage[] = [];
    await live.subscribe(
      (message) => received.push(message),
      () => {},
    );
    await live.publish({ origin: "p-1", n: 7, tags: ["user:1", "users"] });
    expect(script.published).toEqual([
      {
        type: "invalidate-tags",
        namespace: DEFAULT_LIVE_NAMESPACE,
        tags: ["user:1", "users"],
        at: expect.any(Number),
        origin: "p-1:7",
      },
    ]);
    script.deliver(script.published[0]!);
    expect(received).toEqual([
      { origin: "p-1", n: 7, tags: ["user:1", "users"] },
    ]);
  });

  it("reads a clear of its namespace (Postgres's oversized payload) as truncated", async () => {
    const script = scripted();
    const live = cacheLiveBus(script.bus, { namespace: "app/live" });
    const received: LiveBusMessage[] = [];
    await live.subscribe(
      (message) => received.push(message),
      () => {},
    );
    script.deliver({
      type: "clear",
      namespace: "app/live",
      at: 1,
      origin: "p-2:3",
    });
    expect(received).toEqual([
      { origin: "p-2", n: 3, tags: [], truncated: true },
    ]);
  });

  it("ignores other namespaces, other types and origins that carry no number; passes gaps through", async () => {
    const script = scripted();
    const live = cacheLiveBus(script.bus);
    const received: LiveBusMessage[] = [];
    let gaps = 0;
    await live.subscribe(
      (message) => received.push(message),
      () => gaps++,
    );
    // A cache's own message on a shared channel.
    script.deliver({
      type: "invalidate-tags",
      namespace: "users",
      tags: ["x"],
      at: 1,
      origin: "cache-1:1",
    });
    script.deliver({
      type: "set",
      namespace: DEFAULT_LIVE_NAMESPACE,
      keys: ["k"],
      at: 1,
      origin: "p:1",
    });
    for (const origin of [undefined, "no-number", "p:0", "p:x", ":4"])
      script.deliver({
        type: "invalidate-tags",
        namespace: DEFAULT_LIVE_NAMESPACE,
        tags: ["x"],
        at: 1,
        ...(origin === undefined ? {} : { origin }),
      });
    expect(received).toEqual([]);
    // The control: the same message with a numbered origin is read.
    script.deliver({
      type: "invalidate-tags",
      namespace: DEFAULT_LIVE_NAMESPACE,
      tags: ["x"],
      at: 1,
      origin: "p:4",
    });
    expect(received).toEqual([{ origin: "p", n: 4, tags: ["x"] }]);
    script.gap();
    expect(gaps).toBe(1);
  });

  it("refuses an empty namespace", () => {
    expect(() => cacheLiveBus(scripted().bus, { namespace: "" })).toThrow(
      TypeError,
    );
  });
});
