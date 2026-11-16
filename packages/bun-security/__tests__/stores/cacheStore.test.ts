/**
 * `cacheStore` (lib/stores/cache.ts): the shared store over a bun-cache
 * `Cache`. Its values round-trip under its own namespace; a read the cache
 * would answer with a miss because its driver failed is a failure here;
 * every call goes through the timeout and the circuit; the bus carries
 * only this namespace's nudges; its options are checked.
 */
import { describe, expect, it } from "bun:test";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { faulty } from "@kingsleyweb/bun-cache/testing";
import { cacheStore, DEFAULT_STORE_NAMESPACE } from "../../lib/stores/index";
import { fakeClock } from "../helpers";
import { quiet } from "./fleet";

describe("cacheStore", () => {
  it("round-trips values, counters and distinct counts under its namespace", async () => {
    const driver = memoryDriver();
    const cache = createCache({ driver });
    const store = cacheStore(cache, { namespace: "sec", logger: quiet });
    await store.set("k", { a: [1, "x"] }, 60_000);
    expect(await store.get("k")).toEqual({ a: [1, "x"] });
    expect(await store.getMany(["k", "missing"])).toEqual([
      { a: [1, "x"] },
      undefined,
    ]);
    expect(await store.increment("n", 2, null)).toBe(2);
    expect(await store.increment("n", 0, null)).toBe(2);
    expect(await store.pfAdd("d", ["u1", "u2", "u1"], 60_000)).toBe(true);
    expect(await store.pfCount("d")).toBe(2);
    // Under its namespace, not the cache's own.
    expect(await cache.get("k")).toBeUndefined();
    expect(await cache.namespace("sec").get("k")).toEqual({ a: [1, "x"] });
    await store.touch("k", 1);
    await Bun.sleep(5);
    expect(await store.get("k")).toBeUndefined();
    expect(DEFAULT_STORE_NAMESPACE).toBe("bun-security");
    expect(store.name).toBe("bun-cache:memory");
    await store.close();
  });

  it("a read the driver failed is a failure, where the cache alone answers a miss", async () => {
    const driver = faulty(memoryDriver());
    const cache = createCache({ driver, logger: quiet });
    const store = cacheStore(cache, { logger: quiet });
    await store.set("k", 1, null);
    driver.setFaults({ failOn: ["get", "getMany"] });
    // The negative control: the cache's default policy.
    expect(await cache.namespace("bun-security").get("k")).toBeUndefined();
    await expect(store.get("k")).rejects.toThrow("the cache's driver failed");
    await expect(store.getMany(["k"])).rejects.toThrow();
    // The throttle store's counter reads too.
    await expect(store.throttle.get("counter")).rejects.toThrow();
    driver.setFaults({ failOn: ["set"] });
    await expect(store.set("k", 2, null)).rejects.toThrow();
    await store.close();
  });

  it("times a slow call out, opens the circuit after the failures, and probes after the cooldown", async () => {
    const clock = fakeClock();
    const driver = faulty(memoryDriver());
    const store = cacheStore(createCache({ driver, logger: quiet }), {
      timeout: "20ms",
      circuit: { failures: 2, cooldown: "10s" },
      now: clock.now,
      logger: quiet,
    });
    driver.setFaults({ hangMs: 200 });
    await expect(store.increment("n", 1, null)).rejects.toThrow("timed out");
    expect(store.health()).toMatchObject({ healthy: false, failures: 1 });
    driver.setFaults({ down: true });
    await expect(store.increment("n", 1, null)).rejects.toThrow();
    // Open: fails at once, the driver not tried (it is healthy again).
    driver.setFaults({});
    await expect(store.increment("n", 1, null)).rejects.toThrow(
      "circuit is open",
    );
    clock.advance(10_000);
    expect(await store.increment("n", 1, null)).toBeGreaterThanOrEqual(1);
    expect(store.health()).toEqual({
      healthy: true,
      failingSince: undefined,
      failures: 0,
    });
    await store.close();
  });

  it("nudges listeners on its own namespace only", async () => {
    const driver = memoryDriver();
    const a = cacheStore(createCache({ driver }), {
      bus: driver,
      logger: quiet,
    });
    const b = cacheStore(createCache({ driver }), {
      bus: driver,
      logger: quiet,
    });
    const other = cacheStore(createCache({ driver }), {
      bus: driver,
      namespace: "other",
      logger: quiet,
    });
    let nudges = 0;
    const stop = await b.listen?.(
      () => {
        nudges++;
      },
      () => {},
    );
    await other.notify?.();
    await a.notify?.();
    await Bun.sleep(10);
    expect(nudges).toBe(1);
    await stop?.();
    for (const store of [a, b, other]) await store.close();
  });

  it("takes the cache's own bus by default (cacheBusOf), and none with bus: false", async () => {
    const driver = memoryDriver();
    const a = cacheStore(createCache({ driver }), { logger: quiet });
    const b = cacheStore(createCache({ driver }), { logger: quiet });
    const off = cacheStore(createCache({ driver }), {
      bus: false,
      logger: quiet,
    });
    expect(off.listen).toBeUndefined();
    expect(off.notify).toBeUndefined();
    let nudges = 0;
    const stop = await b.listen?.(
      () => {
        nudges++;
      },
      () => {},
    );
    await a.notify?.();
    await Bun.sleep(10);
    expect(nudges).toBe(1);
    await stop?.();
    for (const store of [a, b, off]) await store.close();
  });

  it("refuses bad options", () => {
    const cache = createCache({ driver: memoryDriver() });
    expect(() => cacheStore({} as never)).toThrow(TypeError);
    for (const options of [
      { namespace: "a b" },
      { namespace: "" },
      { timeout: 50 },
      { timeout: "soon" },
      { timeout: "2m" },
      { circuit: { failures: 0 } },
      { syncInterval: "1ms" },
      { pollInterval: "2h" },
      { bus: { name: "x" } },
    ]) {
      expect(() => cacheStore(cache, options as never)).toThrow(TypeError);
    }
  });
});
