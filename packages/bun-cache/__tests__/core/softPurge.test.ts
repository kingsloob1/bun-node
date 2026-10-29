/**
 * The soft purge (R21, plan §3.6): `invalidateTags(tags, { mode: "stale" })`
 * writes a stale stamp per tag, and a read of an entry created at or before
 * it caps its freshness at the stamp — stale, never missing. One mechanism on
 * every driver, and only on a cache with `softPurge: true` (the user's
 * decision of 2026-10-29): without it no read asks for a stale stamp, on a
 * stamps-mode driver and under encryption too.
 *
 * Here: the option rule, what a purged entry reads as through each API, the
 * stale windows (SWR refresh, SIE after a failure, no window), "only ever
 * lowered", the hard expiry, the fence race (in process and across two
 * caches), the in-process fail-safe backoff, L1, encrypt + hashNames, the
 * reserved stale-stamp names, the `invalidate` event and the stats. The
 * conformance kit runs the contract on every driver; the two-process bus
 * case is in `tiers/crossprocess.test.ts`, HTTP in `http/softPurge.test.ts`.
 *
 * A fake clock: a stamp at an entry's own millisecond counts as newer, so a
 * write after a purge advances the clock first.
 */
import { describe, expect, test } from "bun:test";
import { createDeferred, sleep } from "@kingsleyweb/bun-common";
import type {
  CacheDriver,
  CacheEventMap,
  CreateCacheOptions,
} from "../../lib/index";
import {
  createCache,
  fromSimpleDriver,
  memoryDriver,
  UnsupportedOperationError,
} from "../../lib/index";
import { STALE_STAMP_PREFIX } from "../../lib/core/keys";
import { fakeClock } from "../../lib/testing/index";
import { makeCache } from "../helpers";

/** The test encryption: a fixed ring and names key. */
const ENCRYPT = {
  keys: [{ id: "k1", key: new Uint8Array(32).fill(7) }],
  hashNames: { key: new Uint8Array(32).fill(9) },
} as const;

/** A plaintext soft-purging cache on the memory driver and a fake clock. */
function softCache(options: Omit<CreateCacheOptions, "driver"> = {}) {
  return makeCache({ softPurge: true, ...options });
}

/** A stamps-mode driver (a Map behind `fromSimpleDriver`), on the clock. */
function mapDriver(now: () => number) {
  const map = new Map<string, Parameters<typeof JSON.stringify>[0]>();
  return fromSimpleDriver({
    name: "map",
    capabilities: { multiProcess: false },
    get: (ns, key) => {
      const entry = map.get(`${ns}\n${key}`) as
        { expiresAt: number | null } | undefined;
      return Promise.resolve(
        entry === undefined ||
          (entry.expiresAt !== null && entry.expiresAt <= now())
          ? undefined
          : (entry as never),
      );
    },
    set: (ns, entry) => {
      map.set(`${ns}\n${entry.key}`, entry);
      return Promise.resolve();
    },
    delete: (ns, key) => Promise.resolve(map.delete(`${ns}\n${key}`)),
    clear: () => {
      map.clear();
      return Promise.resolve();
    },
  });
}

/** Resolves with the next `name` event. */
function next<E extends keyof CacheEventMap>(
  cache: ReturnType<typeof createCache>,
  name: E,
): Promise<CacheEventMap[E]> {
  return new Promise((resolve) => {
    const off = cache.on(name, (event) => {
      off();
      resolve(event);
    });
  });
}

describe("soft purge: which caches support it", () => {
  test("a plaintext cache over an index-mode driver throws without softPurge, naming it, and purges nothing", async () => {
    const { cache } = makeCache();
    await cache.set("k", "v", { tags: ["t"] });
    const refused = cache.invalidateTags(["t"], { mode: "stale" });
    await expect(refused).rejects.toThrow(UnsupportedOperationError);
    await expect(refused).rejects.toThrow(/softPurge: true/);
    expect(await cache.get("k")).toBe("v");
    await cache.close();
  });

  test("an empty tag list still needs the option (the call is refused, not ignored)", async () => {
    const { cache } = makeCache();
    await expect(cache.invalidateTags([], { mode: "stale" })).rejects.toThrow(
      UnsupportedOperationError,
    );
    await cache.close();
  });

  /**
   * A cache over `driver` recording every name its `getStamps` calls ask
   * for, so a test can see whether a read asked for stale stamps.
   */
  function recorded(driver: CacheDriver): {
    driver: CacheDriver;
    asked: string[];
  } {
    const asked: string[] = [];
    const recording = new Proxy(driver, {
      get(target, property) {
        if (property === "getStamps") {
          return async (ns: string, tags: readonly string[]) => {
            asked.push(...tags);
            return await target.getStamps(ns, tags);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    return { driver: recording, asked };
  }

  /** The stale-stamp names among `asked`. */
  const staleNames = (asked: readonly string[]) =>
    asked.filter((name) => name.startsWith(STALE_STAMP_PREFIX));

  for (const kind of ["a stamps-mode driver", "an encrypted cache"] as const) {
    test(`${kind} needs softPurge too, and without it no read asks for a stale stamp`, async () => {
      for (const softPurge of [false, true]) {
        const clock = fakeClock();
        const { driver, asked } = recorded(
          kind === "a stamps-mode driver"
            ? mapDriver(clock.now)
            : memoryDriver({ now: clock.now }),
        );
        const cache = createCache({
          driver,
          sweepInterval: 0,
          now: clock.now,
          ttl: 60_000,
          ...(kind === "an encrypted cache" ? { encrypt: ENCRYPT } : {}),
          ...(softPurge ? { softPurge } : {}),
        });
        await cache.set("k", "v", { tags: ["t"] });
        expect(await cache.get("k")).toBe("v");
        // Both kinds read the ordinary stamps on a tagged read …
        expect(asked.length).toBeGreaterThan(0);
        if (!softPurge) {
          // … but without the option never a stale one, and the purge is refused.
          expect(staleNames(asked)).toEqual([]);
          const refused = cache.invalidateTags(["t"], { mode: "stale" });
          await expect(refused).rejects.toThrow(UnsupportedOperationError);
          await expect(refused).rejects.toThrow(/softPurge: true/);
          expect(await cache.get("k")).toBe("v");
          expect(staleNames(asked)).toEqual([]);
        } else {
          // … with it, the stale ones too, in the same call, and it purges.
          expect(staleNames(asked).length).toBeGreaterThan(0);
          await cache.invalidateTags(["t"], { mode: "stale" });
          const entry = await cache.getEntry("k");
          expect(entry?.value).toBe("v");
          expect(entry?.stale).toBe(true);
        }
        await cache.close();
      }
    });
  }

  test("a plaintext index-mode cache without softPurge reads no stamps at all; with it, only the stale ones", async () => {
    for (const softPurge of [false, true]) {
      const clock = fakeClock();
      const { driver, asked } = recorded(memoryDriver({ now: clock.now }));
      const cache = createCache({
        driver,
        sweepInterval: 0,
        now: clock.now,
        ...(softPurge ? { softPurge } : {}),
      });
      await cache.set("k", "v", { tags: ["t"] });
      expect(await cache.get("k")).toBe("v");
      expect(asked).toEqual(softPurge ? [`${STALE_STAMP_PREFIX}t`] : []);
      await cache.close();
    }
  });

  test("a mode that is neither is a TypeError", async () => {
    const { cache } = softCache();
    await expect(
      cache.invalidateTags(["t"], { mode: "soft" as "stale" }),
    ).rejects.toThrow(TypeError);
    await cache.close();
  });
});

describe("soft purge: what a purged entry reads as", () => {
  test("stale, never missing: getEntry answers it stale, get and has miss it, other entries are untouched", async () => {
    const { cache, clock } = softCache({ ttl: 60_000 });
    await cache.set("a", "a1", { tags: ["t"] });
    await cache.set("b", "b1", { tags: ["other"] });
    await cache.set("u", "u1");
    const before = (await cache.getEntry("a"))!;
    clock.advance(10);
    await cache.invalidateTags(["t"], { mode: "stale" });
    const after = (await cache.getEntry("a"))!;
    expect(after.value).toBe("a1");
    expect(after.stale).toBe(true);
    // Stale from the purge's millisecond; the hard expiry is not shortened.
    expect(after.freshUntil).toBe(clock.now());
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(after.createdAt).toBe(before.createdAt);
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.has("a")).toBe(false);
    expect((await cache.getEntry("b"))?.stale).toBe(false);
    expect(await cache.get("u")).toBe("u1");
    await cache.close();
  });

  test("a write after the purge is fresh; one in the purge's own millisecond is stale (the safe side)", async () => {
    const { cache, clock } = softCache({ ttl: 60_000 });
    await cache.invalidateTags(["t"], { mode: "stale" });
    await cache.set("same-ms", "v", { tags: ["t"] });
    expect((await cache.getEntry("same-ms"))?.stale).toBe(true);
    clock.advance(1);
    await cache.set("after", "v", { tags: ["t"] });
    expect(await cache.get("after")).toBe("v");
    await cache.close();
  });

  test("freshness is only ever lowered: an entry already stale keeps its own freshUntil", async () => {
    const { cache, clock } = softCache({
      ttl: 1_000,
      staleWhileRevalidate: 60_000,
    });
    await cache.set("k", "v", { tags: ["t"] });
    const own = (await cache.getEntry("k"))!.freshUntil!;
    clock.advance(5_000); // stale on its own
    await cache.invalidateTags(["t"], { mode: "stale" });
    expect((await cache.getEntry("k"))!.freshUntil).toBe(own);
    await cache.close();
  });

  test("an entry that never goes stale (ttl null) goes stale at the purge, and its stale windows count from it", async () => {
    const { cache, clock } = softCache({ staleWhileRevalidate: 5_000 });
    await cache.set("k", "v", { tags: ["t"], ttl: null });
    clock.advance(10);
    await cache.invalidateTags(["t"], { mode: "stale" });
    const entry = (await cache.getEntry("k"))!;
    expect(entry.stale).toBe(true);
    expect(entry.freshUntil).toBe(clock.now());
    expect(entry.expiresAt).toBeNull();
    await cache.close();
  });

  test("the earliest of two purges caps it", async () => {
    const { cache, clock } = softCache({ ttl: 60_000 });
    await cache.set("k", "v", { tags: ["t1", "t2"] });
    clock.advance(10);
    const first = clock.now();
    await cache.invalidateTags(["t1"], { mode: "stale" });
    clock.advance(10);
    await cache.invalidateTags(["t2"], { mode: "stale" });
    expect((await cache.getEntry("k"))!.freshUntil).toBe(first);
    await cache.close();
  });

  test("a delete-mode invalidation after a soft purge still deletes", async () => {
    const { cache, clock } = softCache({ ttl: 60_000 });
    await cache.set("k", "v", { tags: ["t"] });
    await cache.invalidateTags(["t"], { mode: "stale" });
    clock.advance(1);
    await cache.invalidateTags(["t"]);
    expect(await cache.getEntry("k")).toBeUndefined();
    await cache.close();
  });
});

describe("soft purge: the stale windows (§3.5)", () => {
  test("getOrSet inside staleWhileRevalidate serves it stale and refreshes it", async () => {
    const { cache, clock } = softCache({
      ttl: 60_000,
      staleWhileRevalidate: 5_000,
    });
    await cache.set("k", "v1", { tags: ["t"] });
    clock.advance(10);
    await cache.invalidateTags(["t"], { mode: "stale" });
    clock.advance(1);
    const events: string[] = [];
    cache.on("stale-hit", () => events.push("stale-hit"));
    cache.on("refresh", () => events.push("refresh"));
    const refreshed = next(cache, "refresh");
    expect(await cache.getOrSet("k", async () => "v2", { tags: ["t"] })).toBe(
      "v1",
    );
    await refreshed;
    expect(events).toEqual(["stale-hit", "refresh"]);
    expect(await cache.get("k")).toBe("v2");
    expect((await cache.getEntry("k"))?.stale).toBe(false);
    await cache.close();
  });

  test("the window counts from the purge: past it, getOrSet loads instead", async () => {
    const { cache, clock } = softCache({
      ttl: 60_000,
      staleWhileRevalidate: 5_000,
    });
    await cache.set("k", "v1", { tags: ["t"] });
    await cache.invalidateTags(["t"], { mode: "stale" });
    clock.advance(6_000); // past purge + swr, though not past the entry's own TTL
    expect(await cache.getOrSet("k", async () => "v2", { tags: ["t"] })).toBe(
      "v2",
    );
    await cache.close();
  });

  test("staleIfError serves it when the loader fails", async () => {
    const { cache, clock } = softCache({ ttl: 60_000, staleIfError: 60_000 });
    await cache.set("k", "v1", { tags: ["t"] });
    clock.advance(10);
    await cache.invalidateTags(["t"], { mode: "stale" });
    clock.advance(1);
    const served = next(cache, "stale-if-error");
    expect(
      await cache.getOrSet("k", async () => {
        throw new Error("origin down");
      }),
    ).toBe("v1");
    expect((await served).namespace).toBe("cache");
    await cache.close();
  });

  test("with no stale window it is a miss: getOrSet loads, and a failing loader throws", async () => {
    const { cache, clock } = softCache({ ttl: 60_000 });
    await cache.set("k", "v1", { tags: ["t"] });
    clock.advance(10);
    await cache.invalidateTags(["t"], { mode: "stale" });
    clock.advance(1);
    const boom = new Error("origin down");
    await expect(
      cache.getOrSet("k", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await cache.getOrSet("k", async () => "v2")).toBe("v2");
    expect(await cache.get("k")).toBe("v2");
    await cache.close();
  });
});

describe("soft purge: the fence race", () => {
  test("a load in this cache that began before the purge does not store a fresh entry (its flight was forgotten)", async () => {
    const { cache, clock } = softCache({
      ttl: 60_000,
      staleWhileRevalidate: 60_000,
    });
    await cache.set("k", "old", { tags: ["t"] });
    clock.advance(1);
    const gate = createDeferred<void>();
    const inflight = cache.getOrSet(
      "fresh-load",
      async () => {
        await gate.promise;
        return "pre-purge";
      },
      { tags: ["t"] },
    );
    const fenced = next(cache, "fenced");
    await sleep(5);
    clock.advance(1);
    await cache.invalidateTags(["t"], { mode: "stale" });
    clock.advance(1);
    gate.resolve();
    expect(await inflight).toBe("pre-purge");
    // Dropped (the purge forgot the flight), never a fresh pre-purge value;
    // the entry that was there stays, stale.
    expect((await fenced).reason).toBe("local");
    expect(await cache.getEntry("fresh-load")).toBeUndefined();
    expect((await cache.getEntry("k"))?.stale).toBe(true);
    await cache.close();
  });

  test("a load in another cache on the same driver stores, and reads stale in both", async () => {
    const clock = fakeClock();
    const driver = memoryDriver({ now: clock.now });
    const make = () =>
      createCache({
        driver,
        sweepInterval: 0,
        now: clock.now,
        softPurge: true,
        ttl: 60_000,
        staleWhileRevalidate: 60_000,
        bus: false,
        // No in-process stamp copy: each read asks the driver.
        tagStampCacheMs: 0,
      });
    const loader = make();
    const purger = make();
    const gate = createDeferred<void>();
    const stored = next(loader, "set");
    const inflight = loader.getOrSet(
      "k",
      async () => {
        await gate.promise;
        return "pre-purge";
      },
      { tags: ["t"] },
    );
    await sleep(5);
    clock.advance(1);
    await purger.invalidateTags(["t"], { mode: "stale" });
    clock.advance(1);
    gate.resolve();
    expect(await inflight).toBe("pre-purge");
    await stored; // the late write is stored …
    for (const cache of [loader, purger]) {
      const entry = await cache.getEntry("k");
      expect(entry?.value).toBe("pre-purge");
      expect(entry?.stale).toBe(true); // … but reads stale
      expect(await cache.get("k")).toBeUndefined();
    }
    await loader.close();
    await purger.close();
  });
});

describe("soft purge: the fail-safe backoff (§3.5)", () => {
  test("after a failed refresh the purged entry is served without loading for failSafeBackoff, in process", async () => {
    const { cache, clock } = softCache({
      ttl: 60_000,
      staleWhileRevalidate: 120_000,
      failSafeBackoff: 10_000,
    });
    await cache.set("k", "v1", { tags: ["t"] });
    clock.advance(10);
    await cache.invalidateTags(["t"], { mode: "stale" });
    clock.advance(1);
    let loads = 0;
    const failing = async (): Promise<string> => {
      loads++;
      throw new Error("origin down");
    };
    const failed = next(cache, "error");
    expect(await cache.getOrSet("k", failing)).toBe("v1"); // stale-hit; refresh fails
    expect((await failed).phase).toBe("refresh");
    await sleep(5);
    expect(loads).toBe(1);
    clock.advance(1_000);
    // Inside the backoff: a hit, no load.
    expect(await cache.getOrSet("k", failing)).toBe("v1");
    expect(await cache.get("k")).toBe("v1");
    await sleep(5);
    expect(loads).toBe(1);
    clock.advance(10_000); // past it: stale again, and refreshed
    const refreshed = next(cache, "refresh");
    expect(await cache.getOrSet("k", async () => "v2")).toBe("v1");
    await refreshed;
    expect(await cache.get("k")).toBe("v2");
    await cache.close();
  });

  test("a later soft purge ends the backoff", async () => {
    const { cache, clock } = softCache({
      ttl: 60_000,
      staleWhileRevalidate: 120_000,
      failSafeBackoff: 10_000,
    });
    await cache.set("k", "v1", { tags: ["t"] });
    clock.advance(10);
    await cache.invalidateTags(["t"], { mode: "stale" });
    clock.advance(1);
    const failed = next(cache, "error");
    await cache.getOrSet("k", async () => {
      throw new Error("origin down");
    });
    await failed;
    await sleep(5);
    expect(await cache.get("k")).toBe("v1"); // backed off: fresh
    clock.advance(10);
    await cache.invalidateTags(["t"], { mode: "stale" });
    clock.advance(1);
    expect(await cache.get("k")).toBeUndefined();
    expect((await cache.getEntry("k"))?.stale).toBe(true);
    await cache.close();
  });
});

describe("soft purge: L1, events, stats and names", () => {
  test("it drops this process's L1 copies", async () => {
    const { cache, clock } = softCache({ ttl: 60_000, l1: true, bus: false });
    await cache.set("k", "v", { tags: ["t"] });
    expect(await cache.get("k")).toBe("v");
    const tiers: string[] = [];
    cache.on("hit", (hit) => tiers.push(hit.tier));
    expect(await cache.get("k")).toBe("v");
    expect(tiers).toEqual(["l1"]);
    clock.advance(10);
    await cache.invalidateTags(["t"], { mode: "stale" });
    expect(await cache.get("k")).toBeUndefined();
    expect((await cache.getEntry("k"))?.stale).toBe(true);
    await cache.close();
  });

  test("the invalidate event says which mode; a soft purge counts no deletes", async () => {
    const { cache, clock } = softCache({ ttl: 60_000 });
    const events: CacheEventMap["invalidate"][] = [];
    cache.on("invalidate", (event) => events.push(event));
    await cache.set("k", "v", { tags: ["t"] });
    clock.advance(1);
    await cache.invalidateTags(["t"], { mode: "stale" });
    expect(cache.stats().deletes).toBe(0);
    clock.advance(1);
    await cache.invalidateTags(["t"]);
    expect(cache.stats().deletes).toBe(1);
    expect(events).toEqual([
      { namespace: "cache", tags: ["t"], mode: "stale" },
      { namespace: "cache", tags: ["t"], mode: "delete" },
    ]);
    await cache.close();
  });

  test("the stale stamp is the tag's stamp with the reserved prefix, in the tag's namespace", async () => {
    const clock = fakeClock();
    const driver = memoryDriver({ now: clock.now });
    const cache = createCache({
      driver,
      sweepInterval: 0,
      now: clock.now,
      softPurge: true,
    });
    await cache.invalidateTags(["t"], { mode: "stale" });
    const stamps = await driver.getStamps("cache", [
      "t",
      `${STALE_STAMP_PREFIX}t`,
    ]);
    expect([...stamps.entries()]).toEqual([
      [`${STALE_STAMP_PREFIX}t`, clock.now()],
    ]);
    await cache.close();
  });

  test("encrypt + hashNames: the stale stamp is the hashed tag's, and the purge works", async () => {
    const clock = fakeClock();
    const driver = memoryDriver({ now: clock.now });
    const cache = createCache({
      driver,
      sweepInterval: 0,
      now: clock.now,
      encrypt: ENCRYPT,
      softPurge: true,
      ttl: 60_000,
      staleWhileRevalidate: 60_000,
    });
    await cache.set("k", "v1", { tags: ["org:7"] });
    clock.advance(10);
    await cache.invalidateTags(["org:7"], { mode: "stale" });
    clock.advance(1);
    const described = cache.describeKey("k", ["org:7"]);
    expect(described.tags[0]).toMatch(/^[\da-f]{32}$/);
    const stamps = await driver.getStamps(described.namespace, [
      described.tags[0],
      `${STALE_STAMP_PREFIX}${described.tags[0]}`,
      `${STALE_STAMP_PREFIX}org:7`,
    ]);
    expect([...stamps.keys()]).toEqual([
      `${STALE_STAMP_PREFIX}${described.tags[0]}`,
    ]);
    const refreshed = next(cache, "refresh");
    expect(
      await cache.getOrSet("k", async () => "v2", { tags: ["org:7"] }),
    ).toBe("v1");
    await refreshed;
    expect(await cache.get("k")).toBe("v2");
    await cache.close();
  });

  test("a plaintext tag starting with U+0001 is refused, so it never reads as a stale stamp; under hashNames it is fine", async () => {
    const { cache } = softCache();
    const reserved = `${STALE_STAMP_PREFIX}t`;
    await expect(cache.set("k", "v", { tags: [reserved] })).rejects.toThrow(
      /must not start with U\+0001/,
    );
    await expect(
      cache.getOrSet("k", async () => "v", { tags: [reserved] }),
    ).rejects.toThrow(TypeError);
    await expect(cache.invalidateTags([reserved])).rejects.toThrow(TypeError);
    await cache.close();
    const hashed = createCache({
      driver: memoryDriver(),
      sweepInterval: 0,
      encrypt: ENCRYPT,
    });
    expect(await hashed.set("k", "v", { tags: [reserved] })).toBe(true);
    await hashed.close();
  });

  test("a user hashNames.hash answering a tag name that starts with U+0001 is refused", async () => {
    const cache = createCache({
      driver: memoryDriver(),
      sweepInterval: 0,
      encrypt: {
        keys: ENCRYPT.keys,
        hashNames: {
          hash: (name, context) =>
            context.kind === "tag" ? `${STALE_STAMP_PREFIX}${name}` : name,
        },
      },
    });
    await expect(cache.set("k", "v", { tags: ["t"] })).rejects.toThrow(
      /must not answer a tag's name starting with U\+0001/,
    );
    await cache.close();
  });
});
