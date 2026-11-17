/**
 * `memoryThrottleStore`'s evictions (bun-node#819): `evictions` counts the
 * live counters pushed out at `maxKeys`, and `onEvict(key, reason)` reports
 * each counter the store drops on its own (`"cap"` or `"expired"`) as it
 * happens. A cap eviction is told apart from an expired counter dropped on
 * the same insert; `delete()` and `clear()` report nothing, and `clear()`
 * resets the count; a throwing
 * callback cannot break counting; and a throttle over the store reports a
 * key-rotation flood through it.
 */
import { describe, expect, it } from "bun:test";
import { BunRouter } from "../lib/BunRouter";
import { ConfigError } from "../lib/errors";
import { throttle } from "../lib/throttle";
import { memoryThrottleStore } from "../lib/throttleStore";

/** A minute-aligned instant. */
const T0 = 60_000 * 29_000_000;

/** A clock that stands still unless moved. */
function clock(start = T0): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe("memoryThrottleStore: evictions", () => {
  it("the issue's reproduction: ten keys at maxKeys 3 count seven evictions, each reported", () => {
    const told: string[] = [];
    const store = memoryThrottleStore({
      maxKeys: 3,
      onEvict: (key, reason) => told.push(`${reason} ${key}`),
    });
    for (let i = 0; i < 10; i++) {
      store.increment(`ip:203.0.113.${i}`, 1, 60_000);
    }
    expect([store.size, store.maxKeys, store.evictions]).toEqual([3, 3, 7]);
    expect(told).toEqual(
      Array.from({ length: 7 }, (_, i) => `cap ip:203.0.113.${i}`),
    );
  });

  it("an expired counter dropped on an insert is reported as expired, and not counted", () => {
    const time = clock();
    const told: string[] = [];
    const store = memoryThrottleStore({
      maxKeys: 2,
      now: time.now,
      onEvict: (key, reason) => told.push(`${reason} ${key}`),
    });
    store.increment("short", 1, 100);
    store.increment("long", 1, 60_000);
    time.advance(200);
    // The sweep drops "short" (expired); the map then has room: no cap eviction.
    store.increment("third", 1, 60_000);
    expect(told).toEqual(["expired short"]);
    expect(store.evictions).toBe(0);
    // Full now: the next new key pushes out the oldest live one.
    store.increment("fourth", 1, 60_000);
    expect(told).toEqual(["expired short", "cap long"]);
    expect(store.evictions).toBe(1);
  });

  it("a read that finds a counter expired reports it", () => {
    const time = clock();
    const told: string[] = [];
    const store = memoryThrottleStore({
      now: time.now,
      onEvict: (key, reason) => told.push(`${reason} ${key}`),
    });
    store.increment("k", 1, 100);
    time.advance(100);
    expect(store.get("k")).toBeUndefined();
    expect(told).toEqual(["expired k"]);
  });

  it("GCRA buckets are counted and reported the same way", () => {
    const told: string[] = [];
    const store = memoryThrottleStore({
      maxKeys: 2,
      onEvict: (key, reason) => told.push(`${reason} ${key}`),
    });
    for (const key of ["a", "b", "c"]) {
      store.consumeGcra(key, { limit: 5, window: 60_000, cost: 1, now: T0 });
    }
    expect(store.evictions).toBe(1);
    expect(told).toEqual(["cap a"]);
  });

  it("delete() and clear() are the caller's: nothing reported, and clear() resets the count", () => {
    const told: string[] = [];
    const store = memoryThrottleStore({
      maxKeys: 1,
      onEvict: (key, reason) => told.push(`${reason} ${key}`),
    });
    store.increment("a", 1, 60_000);
    store.increment("b", 1, 60_000);
    expect(store.evictions).toBe(1);
    store.delete("b");
    store.increment("c", 1, 60_000);
    expect(store.evictions).toBe(1);
    store.clear();
    expect(told).toEqual(["cap a"]);
    expect(store.evictions).toBe(0);
    // Counting goes on after a clear.
    store.increment("d", 1, 60_000);
    store.increment("e", 1, 60_000);
    expect(told).toEqual(["cap a", "cap d"]);
    expect(store.evictions).toBe(1);
  });

  it("a throwing onEvict breaks nothing: the count goes on and the counter is stored", () => {
    const store = memoryThrottleStore({
      maxKeys: 1,
      onEvict: () => {
        throw new Error("a broken reporter");
      },
    });
    store.increment("a", 1, 60_000);
    expect(store.increment("b", 2, 60_000)).toBe(2);
    expect(store.get("b")).toBe(2);
    expect(store.evictions).toBe(1);
  });

  it("refuses an onEvict that is not a function", () => {
    expect(() =>
      memoryThrottleStore({ onEvict: "log" as unknown as () => void }),
    ).toThrow(ConfigError);
  });

  it("is zero, and reports nothing, while the store stays under its cap (the control)", () => {
    let told = 0;
    const store = memoryThrottleStore({
      maxKeys: 100,
      onEvict: () => {
        told++;
      },
    });
    for (let i = 0; i < 100; i++) store.increment(`k${i}`, 1, 60_000);
    expect([store.size, store.evictions, told]).toEqual([100, 0, 0]);
  });
});

describe("a throttle over the store: a key-rotation flood is seen", () => {
  it("3,000 rotating addresses at maxKeys 500 keep the store at 500 and count 2,500 evictions", async () => {
    let reported = 0;
    const store = memoryThrottleStore({
      maxKeys: 500,
      onEvict: (_key, reason) => {
        if (reason === "cap") reported++;
      },
    });
    const router = new BunRouter();
    router.use(throttle({ limit: 100, window: "1m", store, now: () => T0 }));
    router.get("/", (_req, res) => res.send("ok"));
    for (let i = 0; i < 3_000; i++) {
      const res = await router.fetch("/", {
        remoteAddress: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`,
      });
      expect(res.status).toBe(200);
    }
    // The default sliding window keeps one counter per client per window.
    expect(store.size).toBe(500);
    expect(store.evictions).toBe(2_500);
    expect(reported).toBe(2_500);
  });
});
