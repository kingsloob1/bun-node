/**
 * `hybridThrottleStore` (topologies.md §3.2): counts here at once, syncs to
 * the shared store in batches, reads back keys in use, fails loudly while
 * the shared store fails and recovers by itself, keeps fractions of a unit
 * until they make a whole one, and bounds its keys.
 */
import { describe, expect, it } from "bun:test";
import { memoryThrottleStore, throttle } from "@kingsleyweb/bun-common";
import type { ThrottleStore } from "@kingsleyweb/bun-common";
import { hybridThrottleStore } from "../../lib/stores/index";
import { fakeClock } from "../helpers";
import { quiet } from "./fleet";

/** A shared store that can be taken down, counting its calls. */
function flaky(inner: ThrottleStore = memoryThrottleStore()) {
  let down = false;
  const calls: string[] = [];
  const store: ThrottleStore = {
    name: "flaky",
    increment: (key, cost, ttl) => {
      calls.push(`increment ${key} ${cost}`);
      if (down) throw new Error("down");
      return inner.increment(key, cost, ttl);
    },
    get: (key) => {
      if (down) throw new Error("down");
      return inner.get(key);
    },
  };
  return {
    store,
    calls,
    setDown: (value: boolean) => {
      down = value;
    },
  };
}

describe("hybridThrottleStore", () => {
  it("counts here synchronously, and two stores agree on the total once synced", async () => {
    const clock = fakeClock();
    const shared = memoryThrottleStore({ now: clock.now });
    const options = {
      syncInterval: "1m",
      now: clock.now,
      logger: quiet,
    } as const;
    const a = hybridThrottleStore(shared, options);
    const b = hybridThrottleStore(shared, options);
    expect(a.increment("k", 1, 60_000)).toBe(1);
    expect(a.increment("k", 1, 60_000)).toBe(2);
    expect(b.increment("k", 1, 60_000)).toBe(1);
    expect(shared.get("k")).toBeUndefined();
    await a.flush();
    await b.flush();
    expect(shared.get("k")).toBe(3);
    // a reads b's count back at its next sync, the key being in use.
    await a.flush();
    expect(a.get("k")).toBe(3);
    expect(b.get("k")).toBe(3);
    expect(a.increment("k", 1, 60_000)).toBe(4);
    await a.close();
    await b.close();
  });

  it("keeps fractions until they make a whole unit (the shared stores count whole units)", async () => {
    const { store, calls } = flaky();
    const hybrid = hybridThrottleStore(store, {
      syncInterval: "1m",
      logger: quiet,
    });
    hybrid.increment("f", 0.5, 60_000);
    await hybrid.flush();
    expect(calls.filter((c) => c !== "increment f 0")).toEqual([]);
    hybrid.increment("f", 0.75, 60_000);
    await hybrid.flush();
    expect(calls).toContain("increment f 1");
    expect(hybrid.get("f")).toBeCloseTo(1.25);
    await hybrid.close();
  });

  it("throws while the shared store fails, keeps what it counted, and recovers on its own", async () => {
    const { store, setDown } = flaky();
    const hybrid = hybridThrottleStore(store, {
      syncInterval: "1m",
      logger: quiet,
    });
    hybrid.increment("x", 2, 60_000);
    setDown(true);
    await hybrid.flush();
    expect(hybrid.healthy).toBe(false);
    expect(() => hybrid.increment("x", 1, 60_000)).toThrow();
    expect(() => hybrid.get("x")).toThrow();
    setDown(false);
    await hybrid.flush();
    expect(hybrid.healthy).toBe(true);
    // What was counted before the failure was sent on recovery.
    expect(await store.get("x")).toBe(2);
    await hybrid.close();
  });

  it("probes a failing store with nothing to send, and recovers when the probe succeeds", async () => {
    const { store, setDown, calls } = flaky();
    const clock = fakeClock();
    const hybrid = hybridThrottleStore(store, {
      syncInterval: "1s",
      now: clock.now,
      logger: quiet,
    });
    hybrid.increment("y", 1, 60_000);
    await hybrid.flush();
    // The key is in use: read back at the next sync, which fails.
    setDown(true);
    await hybrid.flush();
    expect(hybrid.healthy).toBe(false);
    setDown(false);
    // Its window over, nothing is left to send: only the probe tells.
    clock.advance(60_000);
    await hybrid.flush();
    expect(hybrid.healthy).toBe(true);
    expect(calls.some((call) => call.includes("hybrid-probe"))).toBe(true);
    await hybrid.close();
  });

  it("bounds its keys, dropping the oldest", async () => {
    const hybrid = hybridThrottleStore(memoryThrottleStore(), {
      maxKeys: 2,
      syncInterval: "1m",
      logger: quiet,
    });
    hybrid.increment("a", 1, 60_000);
    hybrid.increment("b", 1, 60_000);
    hybrid.increment("c", 1, 60_000);
    expect(hybrid.size).toBe(2);
    expect(hybrid.get("a")).toBeUndefined();
    await hybrid.close();
  });

  it("serves throttle(), which refuses GCRA on it (no compare-and-set)", async () => {
    const hybrid = hybridThrottleStore(memoryThrottleStore(), {
      syncInterval: "1m",
      logger: quiet,
    });
    const limiter = throttle({
      limits: { l: { limit: 2, window: "1m" } },
      store: hybrid,
    });
    const counted = [1, 2, 3].map(() => {
      const results = limiter.count("client");
      if (results instanceof Promise) throw new Error("expected synchronous");
      return results[0]?.limited;
    });
    expect(counted).toEqual([false, false, true]);
    expect(() =>
      throttle({ limit: 1, window: "1m", store: hybrid, algorithm: "gcra" }),
    ).toThrow();
    await hybrid.close();
  });

  it("refuses bad options", () => {
    const shared = memoryThrottleStore();
    expect(() => hybridThrottleStore(null as unknown as ThrottleStore)).toThrow(
      TypeError,
    );
    for (const options of [
      { syncInterval: 250 },
      { syncInterval: "5ms" },
      { syncInterval: "2m" },
      { maxKeys: 0 },
    ]) {
      expect(() => hybridThrottleStore(shared, options as never)).toThrow(
        TypeError,
      );
    }
  });
});
