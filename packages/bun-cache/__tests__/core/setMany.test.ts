/**
 * `Cache.setMany` (speed work: one driver write per batch). Every entry goes
 * through `set`'s pipeline, but the driver sees the batch; these pin what
 * must not change from the loop of `set` it replaced: the fence on tagged
 * entries, the last write of a repeated key (in L2 and L1), the order of
 * events and stats around a skipped entry, a throw part-way (the entries
 * before it written, nothing after it encoded), the failure policy, and the
 * bus. The drivers' own batches are the conformance kit's (`setMany*`).
 */
import { describe, expect, test } from "bun:test";
import type { BusMessage, CacheBus, CacheDriver } from "../../lib/index";
import {
  CacheDriverError,
  createCache,
  EntryTooLargeError,
  memoryDriver,
} from "../../lib/index";
import { fakeClock, faulty } from "../../lib/testing/index";

/** One driver call the spy saw. */
interface Call {
  /** The method. */
  op: "set" | "setMany" | "setManyFenced" | "get" | "getMany";
  /** The stored keys it named. */
  keys: string[];
  /** For `set`: whether it carried a tag fence; for `setManyFenced`, per entry. */
  fenced?: boolean | boolean[];
}

/** A driver that records its writes and reads, delegating everything. */
function spied(inner: CacheDriver): { driver: CacheDriver; calls: Call[] } {
  const calls: Call[] = [];
  const driver = new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        if (property === "set") {
          calls.push({
            op: "set",
            keys: [(args[1] as { key: string }).key],
            fenced: args[2] !== undefined,
          });
        } else if (property === "setManyFenced") {
          const writes = args[1] as {
            entry: { key: string };
            fence?: unknown;
          }[];
          calls.push({
            op: "setManyFenced",
            keys: writes.map((write) => write.entry.key),
            fenced: writes.map((write) => write.fence !== undefined),
          });
        } else if (property === "setMany") {
          calls.push({
            op: "setMany",
            keys: (args[1] as { key: string }[]).map((entry) => entry.key),
          });
        } else if (property === "get") {
          calls.push({ op: "get", keys: [args[1] as string] });
        } else if (property === "getMany") {
          calls.push({ op: "getMany", keys: [...(args[1] as string[])] });
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { driver, calls };
}

/** A bus that keeps what was published. */
function capturingBus(): { bus: CacheBus; published: BusMessage[] } {
  const published: BusMessage[] = [];
  return {
    published,
    bus: {
      name: "capture",
      publish: async (message) => {
        published.push(message);
        await Promise.resolve();
      },
      subscribe: async () => await Promise.resolve(async () => {}),
      close: async () => {},
    },
  };
}

/** `inner` with some members replaced; every other method runs on `inner` itself (its private fields). */
function overriding(
  inner: CacheDriver,
  overrides: Partial<Record<keyof CacheDriver, unknown>>,
): CacheDriver {
  return new Proxy(inner, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) {
        return overrides[property as keyof CacheDriver];
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The driver with `setManyFenced` hidden, as a driver written before it existed. */
function withoutFencedBatch(inner: CacheDriver): CacheDriver {
  return overriding(inner, { setManyFenced: undefined });
}

/** An incompressible string of `length` characters (no compression can bring it under a limit). */
function noise(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) =>
    String.fromCharCode(33 + (byte % 90)),
  ).join("");
}

describe("Cache.setMany", () => {
  test("an untagged batch is one driver.setMany, and reads back", async () => {
    const { driver, calls } = spied(memoryDriver());
    const cache = createCache({ driver, sweepInterval: 0, bus: false });
    expect(
      await cache.setMany([
        ["a", 1],
        ["b", { two: 2 }, { ttl: null }],
        ["c", "three", { ttl: 60_000 }],
      ]),
    ).toBe(3);
    expect(calls).toEqual([{ op: "setMany", keys: ["a", "b", "c"] }]);
    expect(await cache.getMany(["a", "b", "c"])).toEqual([
      1,
      { two: 2 },
      "three",
    ]);
    expect((await cache.getEntry("b"))?.expiresAt).toBeNull();
    await cache.close();
  });

  test("one entry is a set, as before", async () => {
    const { driver, calls } = spied(memoryDriver());
    const cache = createCache({ driver, sweepInterval: 0, bus: false });
    expect(await cache.setMany([["a", 1]])).toBe(1);
    expect(await cache.setMany([])).toBe(0);
    expect(calls).toEqual([{ op: "set", keys: ["a"], fenced: false }]);
    await cache.close();
  });

  test("tagged entries on an index driver with setManyFenced are one fenced batch: one invalidated in its millisecond is refused, as set refuses it", async () => {
    const clock = fakeClock();
    const { driver, calls } = spied(memoryDriver({ now: clock.now }));
    const cache = createCache({
      driver,
      sweepInterval: 0,
      bus: false,
      now: clock.now,
    });
    const fencedKeys: string[] = [];
    cache.on("fenced", (event) => fencedKeys.push(event.key));
    // A stamp at this very millisecond, written around the cache so its
    // own wait for the next millisecond does not apply: the fence refuses
    // a write created at or before it (§3.6).
    const ns = cache.describeKey("a", ["t"]).namespace;
    await driver.deleteByTags!(ns, ["t"], clock.now() + 60_000);
    calls.length = 0;
    expect(
      await cache.setMany([
        ["a", 1, { tags: ["t"] }],
        ["b", 2],
      ]),
    ).toBe(1);
    expect(calls).toEqual([
      { op: "setManyFenced", keys: ["a", "b"], fenced: [true, false] },
    ]);
    expect(fencedKeys).toEqual(["a"]);
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBe(2);
    // The same refusal as set's.
    expect(await cache.set("a", 1, { tags: ["t"] })).toBe(false);
    expect(fencedKeys).toEqual(["a", "a"]);
    await cache.close();
  });

  test("a key twice keeps its last write, in the driver and in L1, with an event per write", async () => {
    const { driver, calls } = spied(memoryDriver());
    const cache = createCache({
      driver,
      sweepInterval: 0,
      bus: false,
      l1: true,
    });
    const events: string[] = [];
    cache.on("set", (event) => events.push(event.key));
    expect(
      await cache.setMany([
        ["a", 1],
        ["b", 2],
        ["a", 3],
      ]),
    ).toBe(3);
    expect(events).toEqual(["a", "b", "a"]);
    // A new stretch at the repeated key, so the two writes land in order
    // (a stretch of one entry is that entry's `set`).
    expect(calls).toEqual([
      { op: "setMany", keys: ["a", "b"] },
      { op: "set", keys: ["a"], fenced: false },
    ]);
    calls.length = 0;
    expect(await cache.get("a")).toBe(3);
    expect(await cache.get("b")).toBe(2);
    // Both served by L1: each write's own copy was kept.
    expect(calls).toEqual([]);
    expect(await cache.get("a", { tier: "l2" })).toBe(3);
    await cache.close();
  });

  test("events and stats keep the batch's order around an oversize entry, which is skipped", async () => {
    const cache = createCache({
      driver: memoryDriver(),
      sweepInterval: 0,
      bus: false,
      maxEntryBytes: 1024,
    });
    const events: string[] = [];
    cache.on("set", (event) => events.push(`set ${event.key}`));
    cache.on("oversize", (event) => events.push(`oversize ${event.key}`));
    expect(
      await cache.setMany([
        ["a", 1],
        ["big", noise(4_000)],
        ["c", 3],
      ]),
    ).toBe(2);
    expect(events).toEqual(["set a", "oversize big", "set c"]);
    expect(cache.stats().sets).toBe(2);
    expect(await cache.getMany(["a", "big", "c"])).toEqual([1, undefined, 3]);
    await cache.close();
  });

  test("strict: an oversize entry writes the entries before it, then throws; nothing after it is encoded", async () => {
    const prepared: unknown[] = [];
    const cache = createCache({
      driver: memoryDriver(),
      sweepInterval: 0,
      bus: false,
      strict: true,
      maxEntryBytes: 1024,
      // Called once per entry the pipeline prepares.
      ttl: (value) => {
        prepared.push(value);
        return 60_000;
      },
    });
    const big = noise(4_000);
    let thrown: unknown;
    try {
      await cache.setMany([
        ["a", 1],
        ["big", big],
        ["c", 3],
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EntryTooLargeError);
    expect(prepared).toEqual([1, big]);
    expect(await cache.get("a")).toBe(1);
    expect(await cache.get("c")).toBeUndefined();
    await cache.close();
  });

  test("a throw while preparing an entry (a codec's, a refused tag) writes the entries before it, then throws", async () => {
    const cache = createCache({
      driver: memoryDriver(),
      sweepInterval: 0,
      bus: false,
      codec: "json",
    });
    let thrown: unknown;
    try {
      await cache.setMany([
        ["a", 1],
        // Past the types on purpose: JSON cannot encode a bigint, so the
        // codec throws while this entry is prepared.
        ["b", 1n as unknown as number],
        ["c", 3],
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(await cache.getMany(["a", "b", "c"])).toEqual([
      1,
      undefined,
      undefined,
    ]);
    thrown = undefined;
    try {
      await cache.setMany([
        ["d", 4],
        ["e", 5, { tags: ["\u0001stale"] }],
        ["f", 6],
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(await cache.getMany(["d", "e", "f"])).toEqual([
      4,
      undefined,
      undefined,
    ]);
    await cache.close();
  });

  test("the bus gets one message per stretch, naming the stored keys", async () => {
    const { bus, published } = capturingBus();
    const cache = createCache({
      driver: memoryDriver(),
      sweepInterval: 0,
      bus,
      maxEntryBytes: 1024,
    });
    await cache.setMany([
      ["a", 1],
      ["big", noise(4_000)],
      ["c", 3],
    ]);
    await cache.setMany([
      ["x", 1],
      ["y", 2],
      ["x", 3],
    ]);
    expect(published.map((message) => [message.type, message.keys])).toEqual([
      ["set", ["a", "c"]],
      ["set", ["x", "y"]],
      ["set", ["x"]],
    ]);
    await cache.close();
  });

  test("a failed driver.setMany stores nothing, and reports each entry as set reports a failed write", async () => {
    const report = (cache: ReturnType<typeof createCache>) => {
      const seen: string[] = [];
      cache.on("fenced", (event) => seen.push(`fenced ${event.key}`));
      cache.on("error", (event) => {
        seen.push(
          `error ${event.error instanceof CacheDriverError ? event.error.op : "?"}`,
        );
      });
      return seen;
    };
    const many = createCache({
      driver: faulty(memoryDriver(), { failOn: ["setMany"] }),
      sweepInterval: 0,
      bus: false,
    });
    const manySeen = report(many);
    expect(
      await many.setMany([
        ["a", 1],
        ["b", 2],
      ]),
    ).toBe(0);
    expect(manySeen).toEqual(["error setMany", "fenced a", "fenced b"]);
    expect(many.stats().sets).toBe(0);

    const one = createCache({
      driver: faulty(memoryDriver(), { failOn: ["set"] }),
      sweepInterval: 0,
      bus: false,
    });
    const oneSeen = report(one);
    expect(await one.set("a", 1)).toBe(false);
    expect(oneSeen).toEqual(["error set", "fenced a"]);

    const strict = createCache({
      driver: faulty(memoryDriver(), { failOn: ["setMany"] }),
      sweepInterval: 0,
      bus: false,
      strict: true,
    });
    let thrown: unknown;
    try {
      await strict.setMany([
        ["a", 1],
        ["b", 2],
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CacheDriverError);
    await Promise.all([many.close(), one.close(), strict.close()]);
  });
  test("a driver without setManyFenced: tagged entries are fenced sets, issued together, as before", async () => {
    const clock = fakeClock();
    const inner = memoryDriver({ now: clock.now });
    // The optional method hidden, as a third-party driver without it.
    const { driver, calls } = spied(withoutFencedBatch(inner));
    expect(driver.setManyFenced).toBeUndefined();
    const cache = createCache({
      driver,
      sweepInterval: 0,
      bus: false,
      now: clock.now,
    });
    const fencedKeys: string[] = [];
    cache.on("fenced", (event) => fencedKeys.push(event.key));
    const ns = cache.describeKey("a", ["t"]).namespace;
    await inner.deleteByTags!(ns, ["t"], clock.now() + 60_000);
    calls.length = 0;
    expect(
      await cache.setMany([
        ["a", 1, { tags: ["t"] }],
        ["b", 2],
        ["c", 3, { tags: ["u"] }],
      ]),
    ).toBe(2);
    expect(calls).toEqual([
      { op: "set", keys: ["a"], fenced: true },
      { op: "set", keys: ["b"], fenced: false },
      { op: "set", keys: ["c"], fenced: true },
    ]);
    expect(fencedKeys).toEqual(["a"]);
    expect(await cache.getMany(["a", "b", "c"])).toEqual([undefined, 2, 3]);
    await cache.close();
  });

  test("a fenced batch settles in the batch's order: set and fenced events, stats and L1, and one bus message naming the stored keys", async () => {
    const clock = fakeClock();
    const inner = memoryDriver({ now: clock.now });
    const { bus, published } = capturingBus();
    const cache = createCache({
      driver: inner,
      sweepInterval: 0,
      bus,
      l1: true,
      now: clock.now,
      maxEntryBytes: 1024,
    });
    const events: string[] = [];
    cache.on("set", (event) => events.push(`set ${event.key}`));
    cache.on("fenced", (event) => events.push(`fenced ${event.key}`));
    cache.on("oversize", (event) => events.push(`oversize ${event.key}`));
    const ns = cache.describeKey("x", ["t"]).namespace;
    await inner.deleteByTags!(ns, ["t"], clock.now() + 60_000);
    expect(
      await cache.setMany([
        ["w", 0, { tags: ["u"] }],
        ["x", 1, { tags: ["t"] }],
        ["big", noise(4_000), { tags: ["u"] }],
        ["y", 2],
        ["z", 3, { tags: ["t"] }],
      ]),
    ).toBe(2);
    expect(events).toEqual([
      "set w",
      "fenced x",
      "oversize big",
      "set y",
      "fenced z",
    ]);
    expect(cache.stats().sets).toBe(2);
    expect(cache.stats().fenced).toBe(2);
    expect(published.map((message) => message.keys)).toEqual([
      [cache.describeKey("w").key, cache.describeKey("y").key],
    ]);
    // L1 holds the stored ones only.
    expect(await cache.get("w")).toBe(0);
    expect(await cache.get("y")).toBe(2);
    expect(await cache.get("x")).toBeUndefined();
    await cache.close();
  });

  test("a failed setManyFenced stores nothing and reports each entry as a failed set; strict throws; a wrong-length answer is a failure", async () => {
    const report = (cache: ReturnType<typeof createCache>) => {
      const seen: string[] = [];
      cache.on("fenced", (event) => seen.push(`fenced ${event.key}`));
      cache.on("error", (event) => {
        seen.push(
          `error ${event.error instanceof CacheDriverError ? event.error.op : "?"}`,
        );
      });
      return seen;
    };
    const failing = createCache({
      driver: faulty(memoryDriver(), { failOn: ["setManyFenced"] }),
      sweepInterval: 0,
      bus: false,
    });
    const seen = report(failing);
    expect(
      await failing.setMany([
        ["a", 1, { tags: ["t"] }],
        ["b", 2],
      ]),
    ).toBe(0);
    expect(seen).toEqual(["error setMany", "fenced a", "fenced b"]);
    expect(failing.stats().sets).toBe(0);
    expect(await failing.getMany(["a", "b"])).toEqual([undefined, undefined]);

    const strict = createCache({
      driver: faulty(memoryDriver(), { failOn: ["setManyFenced"] }),
      sweepInterval: 0,
      bus: false,
      strict: true,
    });
    let thrown: unknown;
    try {
      await strict.setMany([
        ["a", 1, { tags: ["t"] }],
        ["b", 2],
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CacheDriverError);

    // A driver whose batch answers one outcome short.
    const inner = memoryDriver();
    const short = overriding(inner, {
      setManyFenced: async (
        ns: string,
        writes: Parameters<NonNullable<CacheDriver["setManyFenced"]>>[1],
      ) => (await inner.setManyFenced!(ns, writes)).slice(1),
    });
    const wrong = createCache({ driver: short, sweepInterval: 0, bus: false });
    const wrongSeen = report(wrong);
    expect(
      await wrong.setMany([
        ["a", 1, { tags: ["t"] }],
        ["b", 2],
      ]),
    ).toBe(0);
    expect(wrongSeen).toEqual(["error setMany", "fenced a", "fenced b"]);
    await Promise.all([failing.close(), strict.close(), wrong.close()]);
  });
});
