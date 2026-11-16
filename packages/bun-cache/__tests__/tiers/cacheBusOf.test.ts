/**
 * `cacheBusOf(cache)` (bun-node#804): the bus a cache uses, for a library
 * built on the cache that announces its own changes to other processes —
 * the bus the `bus` option gave, the driver's under `"auto"`, the driver's
 * own when no bus was linked for want of an L1, `undefined` under
 * `bus: false`, for a bus-less driver and for a hand-written `Cache`. Its
 * `close()` is a no-op (the bus is the cache's), every view of a cache
 * answers the same object, and a library message in a namespace of its own
 * changes no cache's L1. With `BUN_CACHE_TEST_REDIS_URL`, the same across
 * two instances' Redis drivers.
 */
import process from "node:process";
import { afterAll, describe, expect, test } from "bun:test";
import type { BusMessage, Cache, StoredEntry } from "../../lib/index";
import * as bunCache from "../../lib/index";
import {
  cacheBusOf,
  createCache,
  fromSimpleDriver,
  memoryDriver,
  redisDriver,
} from "../../lib/index";
import { redisBackend, redisReachError } from "../drivers/backends";
import { reportNotConfigured, reportUnreachable } from "../drivers/sqlSuite";
import { busHub, waitFor } from "./helpers";

/** Caches to close after the file. */
const open: Cache[] = [];
afterAll(async () => {
  for (const cache of open.splice(0)) await cache.close();
});

/** `createCache`, closed after the file. */
function make(options: Parameters<typeof createCache>[0]): Cache {
  const cache = createCache(options);
  open.push(cache);
  return cache;
}

/** A library's announcement, in a namespace no cache's L1 holds. */
function announcement(extra: Partial<BusMessage> = {}): BusMessage {
  return {
    type: "set",
    namespace: `library-${process.pid}`,
    keys: ["log"],
    at: Date.now(),
    ...extra,
  };
}

/** A simple driver with no bus at all (`capabilities.bus: "none"`). */
function busless() {
  const store = new Map<string, StoredEntry>();
  return fromSimpleDriver({
    name: "busless",
    get: (ns, key) => Promise.resolve(store.get(`${ns}\n${key}`)),
    set: (ns, entry) => {
      store.set(`${ns}\n${entry.key}`, entry);
      return Promise.resolve();
    },
    delete: (ns, key) => Promise.resolve(store.delete(`${ns}\n${key}`)),
  });
}

describe("cacheBusOf: which bus", () => {
  test("is exported from the package root (the issue's reproduction)", () => {
    expect("cacheBusOf" in bunCache).toBe(true);
  });

  test('with an l1, the driver\'s bus the cache linked under bus: "auto"', () => {
    const bus = cacheBusOf(make({ driver: memoryDriver(), l1: true }));
    expect(bus?.name).toBe("memory");
  });

  test("without an l1 or a bus option, the driver's own bus", () => {
    const bus = cacheBusOf(make({ driver: memoryDriver() }));
    expect(bus?.name).toBe("memory");
  });

  test("the bus the bus option gave, an explicit one even without an l1", () => {
    const hub = busHub();
    const bus = cacheBusOf(
      make({ driver: memoryDriver(), bus: hub.bus("given") }),
    );
    expect(bus?.name).toBe("given");
  });

  test("undefined under bus: false, for a driver with no bus, and for a hand-written Cache", () => {
    expect(
      cacheBusOf(make({ driver: memoryDriver(), l1: true, bus: false })),
    ).toBeUndefined();
    expect(cacheBusOf(make({ driver: busless() }))).toBeUndefined();
    expect(cacheBusOf(make({ driver: busless(), l1: true }))).toBeUndefined();
    const handWritten = Object.create(
      make({ driver: memoryDriver() }),
    ) as Cache;
    expect(cacheBusOf(handWritten)).toBeUndefined();
    expect(cacheBusOf({} as Cache)).toBeUndefined();
  });

  test("every view of one cache answers the same object, on every call", () => {
    const cache = make({ driver: memoryDriver(), l1: true });
    const bus = cacheBusOf(cache);
    expect(bus).toBeDefined();
    expect(cacheBusOf(cache)).toBe(bus);
    expect(cacheBusOf(cache.namespace("other"))).toBe(bus);
    expect(Object.isFrozen(bus)).toBe(true);
  });
});

describe("cacheBusOf: using it", () => {
  test("a library's message reaches a subscriber on another cache's bus; its close() leaves the bus to the cache", async () => {
    const hub = busHub();
    const given = hub.bus("given");
    const a = make({ driver: memoryDriver(), l1: true, bus: given });
    const b = make({ driver: memoryDriver(), l1: true, bus: hub.bus("b") });
    const heard: BusMessage[] = [];
    const unsubscribe = await cacheBusOf(b)!.subscribe(
      (message) => {
        if (message.namespace === announcement().namespace) heard.push(message);
      },
      () => {},
    );
    await cacheBusOf(a)!.publish(announcement());
    await waitFor("the announcement", () => heard.length === 1);
    expect(heard[0]).toMatchObject({ type: "set", keys: ["log"] });
    await unsubscribe();
    // The library may close it: the cache's bus stays open.
    await cacheBusOf(a)!.close();
    expect(given.closed).toBe(false);
    await a.close();
    expect(given.closed).toBe(true);
  });

  test("a message in the library's own namespace changes no cache's L1; an unknown type flushes it (the control)", async () => {
    const hub = busHub();
    const shared = memoryDriver();
    const writer = make({ driver: shared, l1: true, bus: hub.bus("writer") });
    const reader = make({ driver: shared, l1: true, bus: hub.bus("reader") });
    await writer.set("k", 1);
    // The reader's L1 serves k once read, and once it listens.
    await waitFor("both caches subscribed", () => hub.subscribers === 2);
    expect(await reader.get("k")).toBe(1);
    /** The reader's L1 misses so far. */
    const misses = () => reader.stats().l1?.misses ?? 0;
    const read = async (): Promise<"l1" | "driver"> => {
      const before = misses();
      expect(await reader.get("k")).toBe(1);
      return misses() === before ? "l1" : "driver";
    };
    expect(await read()).toBe("l1");
    await cacheBusOf(writer)!.publish(announcement());
    expect(await read()).toBe("l1");
    // A type the cache does not know reads as "anything changed".
    await cacheBusOf(writer)!.publish(
      announcement({ type: "bans" as BusMessage["type"] }),
    );
    expect(await read()).toBe("driver");
  });
});

const redis = redisBackend();
if (redis.url === undefined) {
  reportNotConfigured("redis", redis.variable);
} else {
  const unreachable = await redisReachError(redis.url);
  if (unreachable !== undefined) {
    reportUnreachable("redis", redis.variable, unreachable);
  } else {
    const url = redis.url;
    describe("cacheBusOf: two instances' Redis drivers", () => {
      test("a library on one instance announces; the other hears it on its own cache's bus", async () => {
        const prefix = `bun-cache-test:busof:${process.pid}:${Date.now().toString(36)}`;
        // Inline drivers: the app keeps no reference to pass a second time.
        const one = make({ driver: redisDriver({ url, prefix }) });
        const two = make({ driver: redisDriver({ url, prefix }), l1: true });
        const heard: BusMessage[] = [];
        const unsubscribe = await cacheBusOf(two)!.subscribe(
          (message) => {
            if (message.namespace === announcement().namespace) {
              heard.push(message);
            }
          },
          () => {},
        );
        try {
          await cacheBusOf(one)!.publish(announcement());
          await waitFor(
            "the announcement over Redis",
            () => heard.length === 1,
            5_000,
          );
          expect(heard[0]).toMatchObject({ type: "set", keys: ["log"] });
          expect(cacheBusOf(one)!.name).toBe(cacheBusOf(two)!.name);
        } finally {
          await unsubscribe();
        }
      });
    });
  }
}
