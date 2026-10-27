/**
 * The failure policy (plan §3.14, D8): a driver that is down is bypassed,
 * never fatal — reads degrade to misses, writes resolve `false`, the circuit
 * opens and probes — with `strict: true` restoring the throws. The faults come
 * from `faulty` (§13.1).
 */
import { describe, expect, test } from "bun:test";
import { sleep } from "@kingsleyweb/bun-common";
import type { CacheEventMap } from "../../lib/index";
import {
  CacheDriverError,
  CircuitOpenError,
  createCache,
  EntryTooLargeError,
  memoryDriver,
} from "../../lib/index";
import { faulty, fakeClock } from "../../lib/testing/index";
import { makeCache } from "../helpers";

describe("the failure policy (§3.14)", () => {
  test("a failing read is a miss, with an error event", async () => {
    const driver = faulty(memoryDriver(), { failOn: ["get"] });
    const cache = createCache({ driver, sweepInterval: 0 });
    const errors: CacheEventMap["error"][] = [];
    cache.on("error", (event) => {
      errors.push(event);
    });
    expect(await cache.get("k")).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].phase).toBe("driver");
    expect(errors[0].error).toBeInstanceOf(CacheDriverError);
    expect((errors[0].error as CacheDriverError).op).toBe("get");
    await cache.close();
  });

  test("a failing write resolves false, and getOrSet still answers the value", async () => {
    const driver = faulty(memoryDriver(), { failOn: ["set"] });
    const cache = createCache({ driver, sweepInterval: 0 });
    expect(await cache.set("k", "v")).toBe(false);
    expect(await cache.getOrSet("k", async () => "loaded")).toBe("loaded");
    // Nothing was stored, though.
    driver.setFaults({});
    expect(await cache.get("k")).toBeUndefined();
    await cache.close();
  });

  test("N consecutive failures open the circuit; a probe after the cooldown closes it", async () => {
    const clock = fakeClock();
    const driver = faulty(memoryDriver({ now: clock.now }), {
      failOn: ["get"],
    });
    const cache = createCache({
      driver,
      sweepInterval: 0,
      circuit: { failures: 2, cooldown: 30_000 },
      now: clock.now,
    });
    const events: string[] = [];
    cache.on("circuit-open", () => events.push("open"));
    cache.on("circuit-close", () => events.push("close"));
    await cache.get("a");
    await cache.get("b"); // the second failure opens the circuit
    expect(events).toEqual(["open"]);
    // Open: reads bypass the driver — no error event, just a miss.
    driver.setFaults({});
    expect(await cache.get("a")).toBeUndefined();
    expect(events).toEqual(["open"]);
    // After the cooldown the next read probes and closes the circuit.
    clock.advance(31_000);
    await cache.set("a", "stored");
    expect(await cache.get("a")).toBe("stored");
    expect(events).toEqual(["open", "close"]);
    await cache.close();
  });

  test("an operation timeout is a failure like any other", async () => {
    const driver = faulty(memoryDriver(), { hangMs: 200 });
    const cache = createCache({ driver, sweepInterval: 0, timeout: 30 });
    const started = Date.now();
    expect(await cache.get("k")).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(150);
    await cache.close();
  });

  test("strict: true throws CacheDriverError on a driver failure, CircuitOpenError on an open circuit", async () => {
    const clock = fakeClock();
    const driver = faulty(memoryDriver({ now: clock.now }), {
      failOn: ["get", "set"],
    });
    const cache = createCache({
      driver,
      sweepInterval: 0,
      strict: true,
      circuit: { failures: 1, cooldown: 60_000 },
      now: clock.now,
    });
    await expect(cache.get("k")).rejects.toThrow(CacheDriverError);
    await expect(cache.get("k")).rejects.toThrow(CircuitOpenError);
    await expect(cache.set("k", "v")).rejects.toThrow(CircuitOpenError);
    await cache.close();
  });

  test("a failing increment throws even without strict: there is no honest fallback", async () => {
    const driver = faulty(memoryDriver(), { failOn: ["increment"] });
    const cache = createCache({ driver, sweepInterval: 0 });
    await expect(cache.increment("c")).rejects.toThrow(CacheDriverError);
    await cache.close();
  });

  test("a bypassed cache still single-flights the origin (§3.14)", async () => {
    const driver = faulty(memoryDriver(), { down: true });
    const cache = createCache({ driver, sweepInterval: 0 });
    let loads = 0;
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        cache.getOrSet("k", async () => {
          loads++;
          await sleep(5);
          return "origin";
        }),
      ),
    );
    expect(loads).toBe(1);
    expect(results.every((r) => r === "origin")).toBe(true);
    await cache.close();
  });
});

describe("size limits (§3.9, R10)", () => {
  test("an oversized set resolves false with an oversize event", async () => {
    const { cache } = makeCache({ maxEntryBytes: 128, compress: false });
    const events: CacheEventMap["oversize"][] = [];
    cache.on("oversize", (event) => {
      events.push(event);
    });
    expect(await cache.set("big", "x".repeat(1_000))).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].limit).toBe(128);
    expect(await cache.has("big")).toBe(false);
    // In getOrSet the value is returned uncached.
    expect(
      await cache.getOrSet("big", async () => "x".repeat(1_000)),
    ).toHaveLength(1_000);
    expect(await cache.has("big")).toBe(false);
    await cache.close();
  });

  test("strict: true throws EntryTooLargeError", async () => {
    const { cache } = makeCache({
      maxEntryBytes: 128,
      compress: false,
      strict: true,
    });
    await expect(cache.set("big", "x".repeat(1_000))).rejects.toThrow(
      EntryTooLargeError,
    );
    await cache.close();
  });
});
