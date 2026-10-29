/**
 * `getOrSet`'s stampede protection (plan §3.4): the single-flight, the shared
 * rejection, the collective cancellation, the flight forgotten by delete and
 * invalidation, the cross-process lock (two caches on one driver stand in for
 * two processes), and negative caching.
 */
import { describe, expect, test } from "bun:test";
import { createDeferred, sleep } from "@kingsleyweb/bun-common";
import type { CacheDriver, CacheEventMap } from "../../lib/index";
import { createCache, LoaderTimeoutError, memoryDriver } from "../../lib/index";
import { makeCache } from "../helpers";

describe("getOrSet: the single-flight (§3.4)", () => {
  test("1000 concurrent misses run the loader once", async () => {
    const { cache } = makeCache();
    let loads = 0;
    const results = await Promise.all(
      Array.from({ length: 1_000 }, async () =>
        cache.getOrSet("k", async () => {
          loads++;
          await sleep(5);
          return 42;
        }),
      ),
    );
    expect(loads).toBe(1);
    expect(results.every((r) => r === 42)).toBe(true);
    await cache.close();
  });

  test("a throwing loader rejects every waiter with the one error, and the next call reloads", async () => {
    const { cache } = makeCache();
    const boom = new Error("boom");
    let loads = 0;
    const failing = () =>
      cache.getOrSet("k", async () => {
        loads++;
        await sleep(1);
        throw boom;
      });
    const outcomes = await Promise.allSettled([
      failing(),
      failing(),
      failing(),
    ]);
    expect(loads).toBe(1);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toBe(boom);
    }
    // Nothing was cached: the next call runs the loader again.
    expect(
      await cache.getOrSet("k", async () => {
        loads++;
        return "fine";
      }),
    ).toBe("fine");
    expect(loads).toBe(2);
    await cache.close();
  });

  test("the load event reports a shared flight", async () => {
    const { cache } = makeCache();
    const events: CacheEventMap["load"][] = [];
    cache.on("load", (event) => {
      events.push(event);
    });
    await cache.getOrSet("k", async () => 1);
    await Promise.all([
      cache.getOrSet("k2", async () => {
        await sleep(5);
        return 2;
      }),
      cache.getOrSet("k2", async () => 99),
    ]);
    expect(events).toHaveLength(2);
    expect(events[0].shared).toBe(false);
    expect(events[1].shared).toBe(true);
    await cache.close();
  });

  test("a delete mid-flight forgets the flight, and the old load's write is dropped", async () => {
    const { cache } = makeCache();
    const gate = createDeferred<void>();
    const inflight = cache.getOrSet("k", async () => {
      await gate.promise;
      return "stale";
    });
    await sleep(5);
    await cache.delete("k");
    // A caller arriving now starts a new load instead of joining the stale one.
    const fresh = await cache.getOrSet("k", async () => "fresh");
    expect(fresh).toBe("fresh");
    gate.resolve();
    expect(await inflight).toBe("stale");
    // The forgotten flight's write did not land.
    expect(await cache.get("k")).toBe("fresh");
    await cache.close();
  });

  test("the loader's signal aborts only when every waiter aborted", async () => {
    const { cache } = makeCache();
    const first = new AbortController();
    const second = new AbortController();
    let loaderSignal: AbortSignal | undefined;
    const loader = ({ signal }: { signal: AbortSignal }) =>
      new Promise<string>((resolve) => {
        loaderSignal = signal;
        signal.addEventListener("abort", () => resolve("aborted-load"), {
          once: true,
        });
      });
    const p1 = cache.getOrSet("k", loader, { signal: first.signal });
    const p2 = cache.getOrSet("k", loader, { signal: second.signal });
    await sleep(5);
    first.abort();
    expect(loaderSignal!.aborted).toBe(false);
    await expect(p1).rejects.toThrow();
    second.abort();
    await expect(p2).rejects.toThrow();
    expect(loaderSignal!.aborted).toBe(true);
    await cache.close();
  });

  test("wrap shares fn's parameters with the key builder", async () => {
    const { cache } = makeCache();
    let calls = 0;
    const fetchUser = async (id: number) => {
      calls++;
      return { id };
    };
    const cached = cache.wrap(fetchUser, { key: (id) => `user:${id}` });
    expect(await cached(1)).toEqual({ id: 1 });
    expect(await cached(1)).toEqual({ id: 1 });
    expect(await cached(2)).toEqual({ id: 2 });
    expect(calls).toBe(2);
    await cache.close();
  });
});

describe("getOrSet: negative caching (§3.4)", () => {
  test("undefined is not cached by default; null is a value", async () => {
    const { cache } = makeCache();
    let loads = 0;
    expect(
      await cache.getOrSet("k", () => {
        loads++;
        return undefined;
      }),
    ).toBeUndefined();
    await cache.getOrSet("k", () => {
      loads++;
      return undefined;
    });
    expect(loads).toBe(2);
    await cache.set("null", null);
    expect(await cache.has("null")).toBe(true);
    expect(await cache.get("null")).toBeNull();
    await cache.close();
  });

  test("cacheUndefined stores a marker, with negativeTtl of its own", async () => {
    const { cache, clock } = makeCache();
    let loads = 0;
    const options = { cacheUndefined: true, negativeTtl: 1_000 };
    expect(
      await cache.getOrSet(
        "k",
        () => {
          loads++;
          return undefined;
        },
        options,
      ),
    ).toBeUndefined();
    // The marker serves: no second load, and `has` says it exists.
    expect(
      await cache.getOrSet("k", () => Promise.resolve("x"), options),
    ).toBeUndefined();
    expect(loads).toBe(1);
    expect(await cache.has("k")).toBe(true);
    clock.advance(2_000);
    expect(await cache.has("k")).toBe(false);
    await cache.close();
  });
});

describe("getOrSet: the cross-process lock (§3.4)", () => {
  test("two caches on one driver: the loser waits, then reads the winner's value", async () => {
    const driver = memoryDriver();
    const a = createCache({ driver, sweepInterval: 0 });
    const b = createCache({ driver, sweepInterval: 0 });
    const events: string[] = [];
    b.on("lock-wait", () => {
      events.push("lock-wait");
    });
    const gate = createDeferred<void>();
    const slow = a.getOrSet(
      "k",
      async () => {
        await gate.promise;
        return "from-a";
      },
      { lock: true },
    );
    await sleep(10);
    const follower = b.getOrSet("k", async () => "from-b", {
      lock: { wait: { interval: 5, timeout: 2_000 } },
    });
    await sleep(20);
    gate.resolve();
    expect(await slow).toBe("from-a");
    expect(await follower).toBe("from-a");
    expect(events).toEqual(["lock-wait"]);
    await a.close();
  });

  test("a lock timeout loads without storing, and the holder's write wins", async () => {
    const driver = memoryDriver();
    const a = createCache({ driver, sweepInterval: 0 });
    const b = createCache({ driver, sweepInterval: 0 });
    const timeouts: string[] = [];
    b.on("lock-timeout", () => {
      timeouts.push("lock-timeout");
    });
    const gate = createDeferred<void>();
    const slow = a.getOrSet(
      "k",
      async () => {
        await gate.promise;
        return "from-a";
      },
      { lock: true },
    );
    await sleep(10);
    const impatient = await b.getOrSet("k", async () => "from-b", {
      lock: { wait: { interval: 5, timeout: 20 } },
      onLockTimeout: "load",
    });
    expect(impatient).toBe("from-b");
    expect(timeouts).toEqual(["lock-timeout"]);
    // Not stored: the read misses until the holder's write lands.
    expect(await a.has("k")).toBe(false);
    gate.resolve();
    expect(await slow).toBe("from-a");
    expect(await a.get("k")).toBe("from-a");
    await a.close();
  });

  test('onLockTimeout: "throw" rejects with LoaderTimeoutError', async () => {
    const driver = memoryDriver();
    const a = createCache({ driver, sweepInterval: 0 });
    const b = createCache({ driver, sweepInterval: 0 });
    const gate = createDeferred<void>();
    const slow = a.getOrSet(
      "k",
      async () => {
        await gate.promise;
        return 1;
      },
      { lock: true },
    );
    await sleep(10);
    await expect(
      b.getOrSet("k", async () => 2, {
        lock: { wait: { interval: 5, timeout: 20 } },
        onLockTimeout: "throw",
      }),
    ).rejects.toThrow(LoaderTimeoutError);
    gate.resolve();
    await slow;
    await a.close();
  });
});

describe("getOrSet: the loader's noStore() (§3.4)", () => {
  test("every caller sharing the flight gets the value, and nothing is stored", async () => {
    const { cache } = makeCache();
    const events: string[] = [];
    for (const event of ["set", "fenced", "load"] as const) {
      cache.on(event, () => events.push(event));
    }
    let loads = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, async () =>
        cache.getOrSet("k", async ({ noStore }) => {
          loads++;
          await sleep(5);
          noStore();
          return "uncacheable";
        }),
      ),
    );
    expect(loads).toBe(1);
    expect(results).toEqual(Array.from({ length: 5 }, () => "uncacheable"));
    expect(await cache.has("k")).toBe(false);
    expect(events).toEqual(["load"]);
    expect(cache.stats()).toMatchObject({ sets: 0, fenced: 0, loads: 1 });
    // Nothing stored, so the next call loads again, and stores this time.
    expect(
      await cache.getOrSet("k", async () => {
        loads++;
        return "kept";
      }),
    ).toBe("kept");
    expect(loads).toBe(2);
    expect(await cache.get("k")).toBe("kept");
    await cache.close();
  });

  test("a background refresh that calls noStore() leaves the stale entry as it was", async () => {
    const { cache, clock } = makeCache({
      ttl: 1_000,
      staleWhileRevalidate: 5_000,
    });
    await cache.set("k", "v1");
    clock.advance(2_000);
    const refreshes: string[] = [];
    cache.on("refresh", ({ key }) => refreshes.push(key));
    let ran = false;
    const value = await cache.getOrSet("k", async ({ noStore }) => {
      ran = true;
      noStore();
      return "v2";
    });
    expect(value).toBe("v1");
    await sleep(20); // the background refresh lands, and stores nothing
    expect(ran).toBe(true);
    expect(refreshes).toEqual([]);
    const entry = await cache.getEntry("k");
    expect(entry?.value).toBe("v1");
    expect(entry?.stale).toBe(true);
    await cache.close();
  });
});

/**
 * A memory driver whose reads look at the store when they are called but
 * answer late, one after another, as reads queued on a busy backend do
 * (MongoDB under a stampede, where the bench found the loader running twice
 * in one process, PR-B1). Writes are not queued behind them.
 */
function slowReads(spacingMs: number): {
  /** The driver. */
  driver: CacheDriver;
  /** Changes the spacing for the reads that follow. */
  setSpacing: (ms: number) => void;
} {
  const inner = memoryDriver();
  let spacing = spacingMs;
  let lastAnswer = 0;
  const driver = new Proxy(inner, {
    get(target, property, receiver) {
      if (property !== "get") {
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (ns: string, key: string) => {
        const snapshot = await target.get(ns, key);
        lastAnswer = Math.max(Date.now(), lastAnswer) + spacing;
        await sleep(Math.max(0, lastAnswer - Date.now()));
        return snapshot;
      };
    },
  });
  return { driver, setSpacing: (ms) => (spacing = ms) };
}

describe("getOrSet: reads slower than the load (§3.4)", () => {
  test("200 concurrent misses whose reads answer one by one over 600 ms run a 10 ms loader once", async () => {
    const { driver } = slowReads(3);
    const cache = createCache({ driver, sweepInterval: 0 });
    let loads = 0;
    const results = await Promise.all(
      Array.from({ length: 200 }, async () =>
        cache.getOrSet("k", async () => {
          loads++;
          await sleep(10);
          return 42;
        }),
      ),
    );
    expect(loads).toBe(1);
    expect(results.every((r) => r === 42)).toBe(true);
    await cache.close();
  });

  test("wrap: the same, through a wrapped function", async () => {
    const { driver } = slowReads(3);
    const cache = createCache({ driver, sweepInterval: 0 });
    let loads = 0;
    const load = cache.wrap(
      async (id: number) => {
        loads++;
        await sleep(10);
        return id * 2;
      },
      { key: (id) => `w:${id}` },
    );
    const results = await Promise.all(
      Array.from({ length: 200 }, async () => load(21)),
    );
    expect(loads).toBe(1);
    expect(results.every((r) => r === 42)).toBe(true);
    await cache.close();
  });

  test("a stale read that a background refresh settled under reads again, and starts no second refresh", async () => {
    const { driver, setSpacing } = slowReads(0);
    const cache = createCache({
      driver,
      sweepInterval: 0,
      staleWhileRevalidate: 60_000,
    });
    let loads = 0;
    const refreshed = createDeferred<void>();
    const loader = async () => {
      loads++;
      await sleep(20);
      refreshed.resolve();
      return "new";
    };
    await cache.set("s", "old", { ttl: 30 });
    await sleep(40);
    // The first caller is served the stale value and starts the refresh.
    expect(await cache.getOrSet("s", loader)).toBe("old");
    // The second reads while the refresh runs, and its read answers after
    // the refresh has written: it must not take the stale value it saw for
    // a reason to refresh again.
    setSpacing(60);
    const second = cache.getOrSet("s", loader);
    await refreshed.promise;
    expect(await second).toBe("new");
    await sleep(50);
    expect(loads).toBe(1);
    await cache.close();
  });

  test("a load already running is joined without a read", async () => {
    const { driver } = slowReads(0);
    let reads = 0;
    const counted = new Proxy(driver, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property === "get" && typeof value === "function") {
          return async (...args: [string, string]) => {
            reads++;
            return await (value as CacheDriver["get"])(...args);
          };
        }
        return value;
      },
    });
    const cache = createCache({ driver: counted, sweepInterval: 0 });
    const gate = createDeferred<number>();
    const first = cache.getOrSet("j", async () => await gate.promise);
    await sleep(5);
    const readsBefore = reads;
    const joiners = Array.from({ length: 10 }, async () =>
      cache.getOrSet("j", async () => 0),
    );
    expect(reads).toBe(readsBefore);
    gate.resolve(7);
    expect(await first).toBe(7);
    expect(await Promise.all(joiners)).toEqual(
      Array.from({ length: 10 }, () => 7),
    );
    await cache.close();
  });
});
