/**
 * The fence's millisecond (plan §3.6). A stamp records only the millisecond
 * of its invalidation, and the fence counts a stamp at a load's own
 * millisecond as newer, since it cannot tell a load that began before the
 * invalidation from one that began after it. `invalidateTags` therefore
 * resolves only once the clock has passed the millisecond its stamps were
 * written in: a load (or a `set`) that starts after it resolved is stored,
 * where it used to be fenced whenever the two shared a millisecond.
 *
 * What stays as it was: a load that started before the invalidation is
 * fenced, and a stamp another process writes in a load's own millisecond
 * still fences it (that process does not wait for this one).
 *
 * Every case runs on the index path (memory, SQLite), the stamps path (file)
 * and the sealed-stamps path (an encrypted cache on memory), on the real
 * clock unless it says otherwise — the wait runs on the default clock only.
 * A test's frozen clock never makes `invalidateTags` hang (the last cases).
 */
import {
  afterAll,
  describe,
  expect,
  jest,
  setSystemTime,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeferred } from "@kingsleyweb/bun-common";
import type {
  CacheDriver,
  CacheEventMap,
  CreateCacheOptions,
} from "../../lib/index";
import {
  createCache,
  fileDriver,
  memoryDriver,
  sqliteDriver,
} from "../../lib/index";
import { fakeClock } from "../../lib/testing/index";

/** The ring of the encrypted cases. */
const RING = [{ id: "f1", key: new Uint8Array(32).fill(7) }];

/** How many invalidate-then-load rounds a case runs: on memory nearly every one shares a millisecond without the wait. */
const ROUNDS = 20;

/** The directories this file made, removed at the end. */
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    dirs.map(async (dir) => await rm(dir, { recursive: true, force: true })),
  );
});

/** One driver under test. */
interface Backend {
  /** Its name in the test titles. */
  name: string;
  /** A fresh driver, on `now` when given (the default clock otherwise). */
  make: (now?: () => number) => Promise<CacheDriver>;
  /** Extra cache options (the encrypted case's ring). */
  options?: Partial<CreateCacheOptions>;
}

const BACKENDS: Backend[] = [
  {
    name: "memory (index)",
    make: async (now) => await Promise.resolve(memoryDriver({ now })),
  },
  {
    name: "sqlite (index)",
    make: async (now) => {
      const dir = await mkdtemp(join(tmpdir(), "bc-fence-sqlite-"));
      dirs.push(dir);
      return sqliteDriver({ path: join(dir, "cache.db"), now });
    },
  },
  {
    name: "file (stamps)",
    make: async (now) => {
      const dir = await mkdtemp(join(tmpdir(), "bc-fence-file-"));
      dirs.push(dir);
      return fileDriver({ root: dir, now });
    },
  },
  {
    name: "memory, encrypted (sealed stamps)",
    make: async (now) => await Promise.resolve(memoryDriver({ now })),
    options: { encrypt: { keys: RING } },
  },
];

/** A cache over `driver`, the sweeper off, with the backend's options. */
function open(
  backend: Backend,
  driver: CacheDriver,
  extra: Partial<CreateCacheOptions> = {},
): ReturnType<typeof createCache> {
  return createCache({
    driver,
    namespace: "fence",
    sweepInterval: 0,
    ...backend.options,
    ...extra,
  });
}

/** Records the `fenced` events a cache emits. */
function fencedOf(
  cache: ReturnType<typeof createCache>,
): CacheEventMap["fenced"][] {
  const seen: CacheEventMap["fenced"][] = [];
  cache.on("fenced", (event) => seen.push(event));
  return seen;
}

for (const backend of BACKENDS) {
  describe(`the fence's millisecond: ${backend.name}`, () => {
    test("a load that starts once invalidateTags resolved is stored", async () => {
      const driver = await backend.make();
      const cache = open(backend, driver);
      const fenced = fencedOf(cache);
      try {
        let loads = 0;
        for (let round = 0; round < ROUNDS; round++) {
          await cache.set("k", `old ${round}`, { tags: ["t"] });
          await cache.invalidateTags(["t"]);
          const value = await cache.getOrSet(
            "k",
            () => {
              loads++;
              return `new ${round}`;
            },
            { tags: ["t"] },
          );
          expect(value).toBe(`new ${round}`);
          // Stored, and read back as stored: the next read is a hit.
          expect(await cache.get("k")).toBe(`new ${round}`);
        }
        expect(loads).toBe(ROUNDS);
        expect(fenced).toEqual([]);
      } finally {
        await cache.close();
        await driver.close?.();
      }
    });

    test("so is a set issued once invalidateTags resolved", async () => {
      const driver = await backend.make();
      const cache = open(backend, driver);
      try {
        for (let round = 0; round < ROUNDS; round++) {
          await cache.invalidateTags(["t"]);
          expect(await cache.set("k", round, { tags: ["t"] })).toBe(true);
          expect(await cache.get("k")).toBe(round);
        }
      } finally {
        await cache.close();
        await driver.close?.();
      }
    });

    test("and a load by another cache in the process, after the first's invalidateTags resolved", async () => {
      const driver = await backend.make();
      // The file driver's bus is polled: without `tagStampCacheMs: 0`, `two`
      // reads its cached copy of the stamps until a poll brings `one`'s
      // invalidation (§3.6, §4.2) — a window this case is not about.
      const one = open(backend, driver, { tagStampCacheMs: 0 });
      const two = open(backend, driver, { tagStampCacheMs: 0 });
      try {
        for (let round = 0; round < ROUNDS; round++) {
          await one.invalidateTags(["t"]);
          expect(await two.getOrSet("k", () => round, { tags: ["t"] })).toBe(
            round,
          );
          expect(await two.get("k")).toBe(round);
          expect(await one.get("k")).toBe(round);
        }
      } finally {
        await Promise.all([one.close(), two.close()]);
        await driver.close?.();
      }
    });

    test("a load that started before the invalidation is still not stored", async () => {
      const driver = await backend.make();
      // Two caches, so the write reaches the driver's fence (index) or the
      // read check (stamps) rather than this cache's own flight check.
      const one = open(backend, driver);
      const two = open(backend, driver);
      const fenced = fencedOf(two);
      try {
        const gate = createDeferred<void>();
        const started = createDeferred<void>();
        const inflight = two.getOrSet(
          "k",
          async () => {
            started.resolve();
            await gate.promise;
            return "pre-invalidation";
          },
          { tags: ["t"] },
        );
        await started.promise;
        await one.invalidateTags(["t"]);
        gate.resolve();
        // The caller gets its value; the store does not keep it.
        expect(await inflight).toBe("pre-invalidation");
        expect(await two.get("k")).toBeUndefined();
        expect(await one.get("k")).toBeUndefined();
        if (driver.capabilities.tags === "index") {
          expect(fenced.map((event) => event.reason)).toEqual(["fence"]);
        }
      } finally {
        await Promise.all([one.close(), two.close()]);
        await driver.close?.();
      }
    });

    test("another process's stamp in the load's own millisecond still fences it (one shared clock)", async () => {
      // `other` stands for another process: it writes its stamp at T on the
      // shared clock and nothing makes this one wait for it.
      const clock = fakeClock();
      const driver = await backend.make(clock.now);
      const other = open(backend, driver, { now: clock.now });
      const cache = open(backend, driver, { now: clock.now });
      const fenced = fencedOf(cache);
      try {
        await other.invalidateTags(["t"]);
        expect(await cache.getOrSet("k", () => "tie", { tags: ["t"] })).toBe(
          "tie",
        );
        expect(await cache.get("k")).toBeUndefined();
        if (driver.capabilities.tags === "index") {
          expect(fenced.map((event) => event.reason)).toEqual(["fence"]);
        }
        // A millisecond later the load is stored.
        clock.advance(1);
        expect(await cache.getOrSet("k", () => "after", { tags: ["t"] })).toBe(
          "after",
        );
        expect(await cache.get("k")).toBe("after");
      } finally {
        await Promise.all([other.close(), cache.close()]);
        await driver.close?.();
      }
    });
  });
}

describe("the fence's millisecond under a test's frozen clock", () => {
  /** A set, an `invalidateTags` and a load on a fresh memory cache, all in the frozen millisecond. */
  async function invalidateOnce(): Promise<void> {
    const cache = createCache({ driver: memoryDriver(), sweepInterval: 0 });
    try {
      await cache.set("k", 1, { tags: ["t"] });
      await cache.invalidateTags(["t"]);
      // The tie stands: a load in the frozen millisecond is not stored.
      expect(await cache.getOrSet("k", () => 2, { tags: ["t"] })).toBe(2);
      expect(await cache.get("k")).toBeUndefined();
    } finally {
      await cache.close();
    }
  }

  test("setSystemTime: invalidateTags gives up within its cap and resolves", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const start = Bun.nanoseconds();
      for (let round = 0; round < 5; round++) {
        await invalidateOnce();
      }
      // Five invalidations at most a 2 ms cap each, plus the work.
      expect((Bun.nanoseconds() - start) / 1e6).toBeLessThan(1_000);
    } finally {
      setSystemTime();
    }
  });

  test("jest.useFakeTimers(): invalidateTags resolves at once", async () => {
    jest.useFakeTimers();
    try {
      for (let round = 0; round < 5; round++) {
        await invalidateOnce();
      }
    } finally {
      jest.useRealTimers();
    }
  });
});
