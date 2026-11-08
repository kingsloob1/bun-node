/**
 * `cacheThrottleStore` on shared backends — Redis (`BUN_CACHE_TEST_REDIS_URL`,
 * database 15), Postgres, MySQL and MariaDB (`BUN_CACHE_TEST_*_URL`), each
 * falling back to its `BUN_JOBS_TEST_*_URL`, and a SQLite file (always) —
 * and the two-process proof: two `bun` processes, each with its own cache,
 * store and `throttle()` of limit N over the same backend and namespace,
 * together send more than N requests for one client, and exactly N are
 * allowed. Its negative control is a permanent test: the same two processes
 * in two namespaces allow 2N.
 *
 * Every one of these backends counts itself (`countWindow`, `consumeGcra`):
 * the skewed-clock proof gives the two processes clocks either side of an
 * hour's boundary. Placed by their own clocks (`clock: "process"`, the
 * negative control) they count in two windows and allow 2N; placed by the
 * backend's (`clock: "store"`, the default) they allow N, and so does GCRA.
 *
 * A backend whose URL is unset skips visibly; one whose URL is set but
 * unreachable fails, naming the variable (`sqlSuite.ts`).
 *
 * Test data: Redis keys under this run's own prefix
 * (`bun-cache-test:<pid>-<time>-throttle`), deleted by that prefix at the end;
 * Postgres tables under `bun_cache_test_<pid>_throttle_`, dropped by name.
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import type { RouterHandler, ThrottleOptions } from "@kingsleyweb/bun-common";
import { BunRouter, throttle } from "@kingsleyweb/bun-common";
import type { Cache, CacheDriver } from "../../lib/index";
import { createCache, redisDriver, sqliteDriver } from "../../lib/index";
import {
  cacheThrottleStore,
  DEFAULT_THROTTLE_EXPIRY_MARGIN,
} from "../../lib/throttle/index";
import { fakeClock } from "../../lib/testing/index";
import {
  deleteRedisPrefix,
  dropTables,
  reachError,
  redisBackend,
  redisReachError,
  runPrefix,
  sqlBackends,
} from "../drivers/backends";
import { reportNotConfigured, reportUnreachable } from "../drivers/sqlSuite";
import type {
  ThrottleWorkerJob,
  ThrottleWorkerResult,
} from "./throttle-worker";

/** A minute-aligned instant for the single-process counts. */
const T0 = 60_000 * 29_000_000;

/** One minute. */
const MINUTE = 60_000;

/** One hour, the children's window. */
const HOUR = 3_600_000;

const ok: RouterHandler = (_req, res) => {
  res.send("ok");
};

/** One backend under test. */
interface Backend {
  /** As in the titles. */
  name: ThrottleWorkerJob["backend"];
  /** The URL. */
  url: string;
  /** This run's key or table prefix. */
  prefix: string;
  /** Builds a driver on this run's prefix. */
  make: () => CacheDriver;
  /** Removes exactly what this run created. */
  cleanup: () => Promise<void>;
}

/** Spawns one child; resolves once it is ready, with a `go` and its result. */
async function spawnWorker(job: ThrottleWorkerJob): Promise<{
  /** Releases the child (closes its stdin). */
  go: () => void;
  /** The child's counts. */
  result: Promise<ThrottleWorkerResult>;
}> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      new URL("./throttle-worker.ts", import.meta.url).pathname,
      JSON.stringify(job),
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const lines = (async function* () {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        yield buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    }
  })();
  const failed = async (): Promise<never> => {
    void child.stdin.end();
    const code = await child.exited;
    throw new Error(`throttle-worker exited ${code}: ${(await stderr).trim()}`);
  };
  const ready = await lines.next();
  if (ready.done === true || JSON.parse(ready.value).ready !== true) {
    return await failed();
  }
  return {
    go: () => {
      void child.stdin.end();
    },
    result: (async () => {
      const line = await lines.next();
      const code = await child.exited;
      if (code !== 0 || line.done === true) return await failed();
      return JSON.parse(line.value) as ThrottleWorkerResult;
    })(),
  };
}

/**
 * Waits, when the real time is within 15 s of an hour's end, until the next
 * hour has begun: a proof counted by the backend's clock in a one-hour
 * window must not straddle a boundary.
 */
async function clearOfHourBoundary(): Promise<void> {
  const left = HOUR - (Date.now() % HOUR);
  if (left < 15_000) await Bun.sleep(left + 250);
}

/** How the two children of {@link twoProcesses} count. */
interface TwoProcessOptions {
  /** The algorithm; default the sliding window. */
  algorithm?: ThrottleWorkerJob["algorithm"];
  /** The store's `clock`; default `"process"`. */
  clock?: ThrottleWorkerJob["clock"];
  /** Each child's throttle clock, from the hour's start; default 1 s into it for both. */
  offsets?: readonly [number, number];
}

/** Runs two children together, each with its own namespace, and answers their counts. */
async function twoProcesses(
  backend: Backend,
  namespaces: readonly [string, string],
  limit: number,
  requests: number,
  options: TwoProcessOptions = {},
): Promise<ThrottleWorkerResult[]> {
  await clearOfHourBoundary();
  // An instant just inside an hour, so the whole proof counts in one window.
  const hour = Math.floor(Date.now() / HOUR) * HOUR;
  const offsets = options.offsets ?? [1_000, 1_000];
  const workers = await Promise.all(
    namespaces.map(
      async (namespace, index) =>
        await spawnWorker({
          backend: backend.name,
          url: backend.url,
          prefix: backend.prefix,
          namespace,
          limit,
          requests,
          now: hour + offsets[index],
          algorithm: options.algorithm,
          clock: options.clock,
        }),
    ),
  );
  for (const worker of workers) worker.go();
  return await Promise.all(workers.map(async (worker) => await worker.result));
}

/** Sums the children's counts. */
function total(results: readonly ThrottleWorkerResult[]): ThrottleWorkerResult {
  return results.reduce(
    (sum, each) => ({
      allowed: sum.allowed + each.allowed,
      limited: sum.limited + each.limited,
      failed: sum.failed + each.failed,
    }),
    { allowed: 0, limited: 0, failed: 0 },
  );
}

/** Registers the suite for one reachable backend. */
function registerSuite(backend: Backend): void {
  describe(`cacheThrottleStore on ${backend.name}`, () => {
    const caches: Cache[] = [];
    /** A cache on this run's prefix, with `now` as its clock when given. */
    const cacheOn = (now?: () => number): Cache => {
      const cache = createCache({
        driver: backend.make(),
        sweepInterval: 0,
        ...(now === undefined ? {} : { now }),
      });
      caches.push(cache);
      return cache;
    };

    afterAll(async () => {
      for (const cache of caches) await cache.close();
      await backend.cleanup();
    });

    it("counts, reads and deletes a counter", async () => {
      const store = cacheThrottleStore(cacheOn(), { namespace: "unit" });
      expect(store.name).toBe(`bun-cache:${backend.name}`);
      expect(await store.get("k")).toBeUndefined();
      expect(await store.increment("k", 2, 10_000)).toBe(2);
      expect(await store.increment("k", 3, 10_000)).toBe(5);
      expect(await store.get("k")).toBe(5);
      await store.delete("k");
      expect(await store.get("k")).toBeUndefined();
      expect(await store.increment("k", 1, 10_000)).toBe(1);
    });

    it("sets the lifetime only when it creates the counter", async () => {
      let now = Date.now();
      const cache = cacheOn(() => now);
      const store = cacheThrottleStore(cache, { namespace: "ttl" });
      const created = now;
      await store.increment("k", 1, 60_000);
      now += 5_000;
      await store.increment("k", 1, 60_000);
      const entry = await cache.namespace("ttl").getEntry("k");
      expect(entry?.value).toBe(2);
      expect(entry?.expiresAt).toBe(
        created + 60_000 + DEFAULT_THROTTLE_EXPIRY_MARGIN,
      );
    });

    it("counts a sliding and a fixed window under throttle() (clock: process)", async () => {
      const store = cacheThrottleStore(cacheOn(), {
        namespace: "windows",
        clock: "process",
      });
      expect(store.clock).toBe("process");
      const clock = fakeClock(T0);
      const make = (
        algorithm: "fixed-window" | "sliding-window",
      ): BunRouter => {
        const app = new BunRouter({
          throttle: {
            limit: 3,
            window: "1m",
            store,
            algorithm,
            prefix: algorithm,
            key: () => "c1",
            now: clock.now,
          },
        });
        app.get("/", ok);
        return app;
      };
      const statuses = async (app: BunRouter, n: number): Promise<number[]> => {
        const out: number[] = [];
        for (let i = 0; i < n; i++) out.push((await app.fetch("/")).status);
        return out;
      };
      const sliding = make("sliding-window");
      const fixed = make("fixed-window");
      expect(await statuses(sliding, 4)).toEqual([200, 200, 200, 429]);
      expect(await statuses(fixed, 4)).toEqual([200, 200, 200, 429]);
      clock.set(T0 + MINUTE + MINUTE / 2);
      // Sliding: half of last window's 4 still weighs, one more fits.
      expect(await statuses(sliding, 2)).toEqual([200, 429]);
      // Fixed: a new window, a new budget.
      expect(await statuses(fixed, 4)).toEqual([200, 200, 200, 429]);
    });

    it("holds one limit across two processes: exactly N of 2 × 30 allowed", async () => {
      const limit = 20;
      const counts = await twoProcesses(
        backend,
        ["shared", "shared"],
        limit,
        30,
      );
      expect(total(counts)).toEqual({
        allowed: limit,
        limited: 60 - limit,
        failed: 0,
      });
    }, 30_000);

    it("holds a fixed-window limit across two processes too", async () => {
      const limit = 20;
      const counts = await twoProcesses(
        backend,
        ["fixed", "fixed"],
        limit,
        30,
        {
          algorithm: "fixed-window",
        },
      );
      expect(total(counts)).toEqual({
        allowed: limit,
        limited: 60 - limit,
        failed: 0,
      });
    }, 30_000);

    /** A router throttled by `options` on `store`, its key fixed. */
    const throttled = (
      options: Omit<ThrottleOptions, "key">,
    ): { app: BunRouter; handler: ReturnType<typeof throttle> } => {
      const handler = throttle({ ...options, key: () => "c1" });
      const app = new BunRouter();
      app.use(handler);
      app.get("/", ok);
      return { app, handler };
    };
    const statusesOf = async (app: BunRouter, n: number): Promise<number[]> => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await app.fetch("/")).status);
      return out;
    };

    it("counts by the backend's clock by default: throttles a day apart share one window", async () => {
      const store = cacheThrottleStore(cacheOn(), { namespace: "store-clock" });
      expect(store.clock).toBe("store");
      expect(typeof store.countWindow).toBe("function");
      expect(typeof store.consumeGcra).toBe("function");
      await clearOfHourBoundary();
      const make = (now: number): BunRouter =>
        throttled({
          limit: 3,
          window: "1h",
          algorithm: "fixed-window",
          store,
          now: () => now,
        }).app;
      const early = make(T0);
      const late = make(T0 + 86_400_000);
      expect(await statusesOf(early, 2)).toEqual([200, 200]);
      expect(await statusesOf(late, 2)).toEqual([200, 429]);
    });

    it("reset() forgets the window the backend placed", async () => {
      const store = cacheThrottleStore(cacheOn(), { namespace: "reset" });
      await clearOfHourBoundary();
      const { app, handler } = throttled({ limit: 1, window: "1h", store });
      expect(await statusesOf(app, 2)).toEqual([200, 429]);
      await handler.reset("c1");
      expect(await statusesOf(app, 2)).toEqual([200, 429]);
    });

    it("countWindow() with cost 0 reads and counts nothing; a window's counter is the backend's", async () => {
      const store = cacheThrottleStore(cacheOn(), {
        namespace: "peek",
        clock: "process",
      });
      const at = T0 + 30_000;
      const step = (cost: number, now = at) =>
        store.countWindow!("b", { window: MINUTE, cost, previous: true, now });
      expect(await step(0)).toEqual({
        current: 0,
        previous: 0,
        elapsed: 30_000,
      });
      expect(await step(2)).toEqual({
        current: 2,
        previous: 0,
        elapsed: 30_000,
      });
      expect(await step(0)).toEqual({
        current: 2,
        previous: 0,
        elapsed: 30_000,
      });
      expect(await step(1)).toEqual({
        current: 3,
        previous: 0,
        elapsed: 30_000,
      });
      // The next window reads this one as its previous.
      expect(await step(0, at + MINUTE)).toEqual({
        current: 0,
        previous: 3,
        elapsed: 30_000,
      });
      // Not a fixed window's: without `previous` it is not read.
      expect(
        await store.countWindow!("b", {
          window: MINUTE,
          cost: 0,
          previous: false,
          now: at + MINUTE,
        }),
      ).toEqual({ current: 0, previous: 0, elapsed: 30_000 });
      await store.deleteWindow!("b", { window: MINUTE, now: at + MINUTE });
      expect(await step(0, at + MINUTE)).toEqual({
        current: 0,
        previous: 0,
        elapsed: 30_000,
      });
      await expect(step(1.5)).rejects.toThrow(TypeError);
    });

    it("runs GCRA on the backend, as the memory store does (clock: process)", async () => {
      const store = cacheThrottleStore(cacheOn(), {
        namespace: "gcra-process",
        clock: "process",
      });
      const clock = fakeClock(T0);
      const { app } = throttled({
        limit: 2,
        window: "10s",
        algorithm: "gcra",
        store,
        now: clock.now,
      });
      expect(await statusesOf(app, 3)).toEqual([200, 200, 429]);
      clock.advance(5_000);
      expect(await statusesOf(app, 2)).toEqual([200, 429]);
      const refused = await app.fetch("/");
      expect(refused.headers.get("Retry-After")).toBe("5");
      // A cost past the bucket is refused and takes nothing.
      const big = throttled({
        limit: 2,
        window: "10s",
        algorithm: "gcra",
        store,
        cost: 3,
        prefix: "big",
        now: clock.now,
      });
      expect(await statusesOf(big.app, 2)).toEqual([429, 429]);
      clock.advance(10_000);
      expect(await statusesOf(app, 3)).toEqual([200, 200, 429]);
    });

    it("runs GCRA by the backend's clock, and reset() empties the bucket", async () => {
      const store = cacheThrottleStore(cacheOn(), { namespace: "gcra-store" });
      const { app, handler } = throttled({
        limit: 3,
        window: "1h",
        algorithm: "gcra",
        store,
        now: () => T0,
      });
      expect(await statusesOf(app, 4)).toEqual([200, 200, 200, 429]);
      await handler.reset("c1");
      expect(await statusesOf(app, 4)).toEqual([200, 200, 200, 429]);
    });

    it("skewed clocks, backend's clock: two processes an hour apart hold one fixed-window limit (N)", async () => {
      const limit = 20;
      const counts = await twoProcesses(backend, ["skew", "skew"], limit, 30, {
        algorithm: "fixed-window",
        clock: "store",
        offsets: [-60_000, 60_000],
      });
      expect(total(counts)).toEqual({
        allowed: limit,
        limited: 60 - limit,
        failed: 0,
      });
    }, 30_000);

    it("skewed clocks, backend's clock: the sliding window and GCRA hold N too", async () => {
      const limit = 20;
      for (const algorithm of ["sliding-window", "gcra"] as const) {
        const counts = await twoProcesses(
          backend,
          [`skew-${algorithm}`, `skew-${algorithm}`],
          limit,
          30,
          { algorithm, clock: "store", offsets: [-60_000, 60_000] },
        );
        expect({ algorithm, ...total(counts) }).toEqual({
          algorithm,
          allowed: limit,
          limited: 60 - limit,
          failed: 0,
        });
      }
    }, 60_000);

    // The skew proof's negative control: the same two processes placed by
    // their own clocks, either side of the hour, count in two windows.
    it("negative control: skewed clocks, process clock: two windows (2N allowed)", async () => {
      const limit = 20;
      const counts = await twoProcesses(
        backend,
        ["skew-local", "skew-local"],
        limit,
        30,
        {
          algorithm: "fixed-window",
          clock: "process",
          offsets: [-60_000, 60_000],
        },
      );
      expect(total(counts)).toEqual({
        allowed: 2 * limit,
        limited: 60 - 2 * limit,
        failed: 0,
      });
    }, 30_000);

    // The negative control: the same proof with the two processes in two
    // namespaces. Each counts alone, so together they allow twice the limit;
    // a proof that could not tell this from a shared count would be no proof.
    it("negative control: two namespaces do not share a limit (2N allowed)", async () => {
      const limit = 20;
      const counts = await twoProcesses(
        backend,
        ["apart-a", "apart-b"],
        limit,
        30,
      );
      expect(total(counts)).toEqual({
        allowed: 2 * limit,
        limited: 60 - 2 * limit,
        failed: 0,
      });
    }, 30_000);
  });
}

/* ------------------------------------------------------------------ */

const redis = redisBackend();
if (redis.url === undefined) {
  reportNotConfigured("redis", redis.variable);
} else {
  const unreachable = await redisReachError(redis.url);
  if (unreachable !== undefined) {
    reportUnreachable("redis", redis.variable, unreachable);
  } else {
    const url = redis.url;
    const prefix = `bun-cache-test:${process.pid}-${Date.now()}-throttle`;
    registerSuite({
      name: "redis",
      url,
      prefix,
      make: () => redisDriver({ url, prefix }),
      cleanup: async () => {
        await deleteRedisPrefix(url, prefix);
      },
    });
  }
}

for (const sql of sqlBackends()) {
  if (sql.url === undefined) {
    reportNotConfigured(sql.name, sql.variable);
    continue;
  }
  const unreachable = await reachError(sql);
  if (unreachable !== undefined) {
    reportUnreachable(sql.name, sql.variable, unreachable);
    continue;
  }
  const url = sql.url;
  const prefix = runPrefix("throttle_");
  // The tables exist before any child connects, so two children never race
  // to create them.
  const setup = sql.make({ url, prefix });
  await setup.connect!();
  await setup.close();
  registerSuite({
    name: sql.name,
    url,
    prefix,
    make: () => sql.make({ url, prefix }),
    cleanup: async () => {
      await dropTables(sql, prefix);
    },
  });
}

{
  // SQLite needs no server: a file of this run's own, shared by the children.
  const path = join(
    tmpdir(),
    `bun-cache-throttle-${process.pid}-${Date.now()}.db`,
  );
  const setup = sqliteDriver({ path });
  await setup.connect!();
  await setup.close();
  registerSuite({
    name: "sqlite",
    url: path,
    prefix: "",
    make: () => sqliteDriver({ path }),
    cleanup: async () => {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${path}${suffix}`, { force: true });
      }
    },
  });
}
