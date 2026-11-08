/**
 * The backend counts: on Redis, Postgres, MySQL, MariaDB and SQLite,
 * `cacheThrottleStore` runs each step as one script or statement on the
 * backend, timed by the backend's own clock, and runs GCRA there too.
 *
 * ```bash
 * bun 09-throttle/store-clock.ts                       # SQLite, always
 * EXAMPLE_REDIS_URL=redis://127.0.0.1:6379/13 \
 *   bun 09-throttle/store-clock.ts                     # and Redis
 * ```
 *
 * - `store.clock` is `"store"`: the backend's clock places every request
 *   (SQLite's `julianday('now')`, Redis's `TIME`), so `throttle()`'s `now`
 *   no longer decides the window. Two throttles whose clocks are a day apart
 *   share one count.
 * - `algorithm: "gcra"` runs on the store: a bucket of 3 per hour lets 3
 *   through and refuses the 4th, whichever process asks. `reset()` empties
 *   the bucket.
 * - `clock: "process"` keeps `throttle()`'s `now`, for code that drives a
 *   fake clock: a bucket of 2 per 10 s refills one token every 5 s.
 * - A memory cache cannot count itself: `store.clock` is `"process"` there,
 *   and GCRA is refused (see `basics.ts`).
 *
 * SQLite's database is a file in a temporary directory, deleted at the end.
 * Redis runs when `EXAMPLE_REDIS_URL` (or `BUN_CACHE_TEST_REDIS_URL`) is
 * set; its keys live under `bun-cache-example:<pid>-store-clock`, deleted
 * by a `SCAN` of exactly that prefix.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { RedisClient } from "bun";
import type { ThrottleOptions } from "@kingsleyweb/bun-common";
import { BunRouter, throttle } from "@kingsleyweb/bun-common";
import type { Cache } from "@kingsleyweb/bun-cache";
import {
  createCache,
  memoryDriver,
  redisDriver,
  sqliteDriver,
} from "@kingsleyweb/bun-cache";
import { fakeClock } from "@kingsleyweb/bun-cache/testing";
import { cacheThrottleStore } from "@kingsleyweb/bun-cache/throttle";
import { checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("bun-cache throttle store: the backend's clock, and GCRA on the store");

/** One hour. */
const HOUR = 3_600_000;

/** An instant long ago, minute-aligned: the fake clocks start here. */
const T0 = 60_000 * 29_000_000;

/** Waits out the last 15 s of an hour, so a window of an hour timed by the backend's clock is not cut short. */
async function clearOfHourEdge(): Promise<void> {
  const left = HOUR - (Date.now() % HOUR);
  if (left < 15_000) await Bun.sleep(left + 250);
}

/** A router throttled by `options`, every request one client's. */
function app(options: Omit<ThrottleOptions, "key">): {
  router: BunRouter;
  handler: ReturnType<typeof throttle>;
} {
  const handler = throttle({ ...options, key: () => "alice" });
  const router = new BunRouter();
  router.use(handler);
  router.get("/", (_req, res) => {
    res.send("ok");
  });
  return { router, handler };
}

/** Sends `n` requests; answers their statuses. */
async function send(router: BunRouter, n: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await router.fetch("/")).status);
  return statuses;
}

/** The tour on one backend's cache. */
async function tour(name: string, cache: Cache): Promise<void> {
  await clearOfHourEdge();

  step(`${name}: the backend's clock places every request`);
  const store = cacheThrottleStore(cache, { namespace: "store-clock" });
  show(`store.clock: ${store.clock}`);
  checkEqual("store.clock", store.clock, "store");
  const yesterday = app({
    limit: 3,
    window: "1h",
    algorithm: "fixed-window",
    store,
    now: () => Date.now() - 86_400_000,
  });
  const today = app({
    limit: 3,
    window: "1h",
    algorithm: "fixed-window",
    store,
    now: () => Date.now(),
  });
  checkEqual(
    "a throttle whose clock is a day behind: two of three",
    await send(yesterday.router, 2),
    [200, 200],
  );
  checkEqual(
    "one with the right time counts in the same window: one more, then 429",
    await send(today.router, 2),
    [200, 429],
  );

  step(`${name}: GCRA on the store`);
  const bucket = app({
    limit: 3,
    window: "1h",
    algorithm: "gcra",
    store,
    prefix: "gcra",
  });
  checkEqual(
    "a bucket of 3 per hour",
    await send(bucket.router, 4),
    [200, 200, 200, 429],
  );
  await bucket.handler.reset("alice");
  checkEqual(
    "reset() empties it",
    await send(bucket.router, 4),
    [200, 200, 200, 429],
  );

  step(`${name}: clock: "process" keeps throttle()'s clock`);
  const clock = fakeClock(T0);
  const local = cacheThrottleStore(cache, {
    namespace: "process-clock",
    clock: "process",
  });
  checkEqual("store.clock", local.clock, "process");
  const refill = app({
    limit: 2,
    window: "10s",
    algorithm: "gcra",
    store: local,
    now: clock.now,
  });
  checkEqual(
    "a bucket of 2 per 10 s",
    await send(refill.router, 3),
    [200, 200, 429],
  );
  clock.advance(5_000);
  checkEqual(
    "5 s later on the fake clock: one token back",
    await send(refill.router, 2),
    [200, 429],
  );
}

const dir = await mkdtemp(join(tmpdir(), "bun-cache-example-"));
try {
  const cache = createCache({
    driver: sqliteDriver({ path: join(dir, "cache.db") }),
    sweepInterval: 0,
  });
  await tour("sqlite", cache);
  await cache.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}

const redisUrl =
  process.env.EXAMPLE_REDIS_URL ?? process.env.BUN_CACHE_TEST_REDIS_URL;
if (redisUrl) {
  const prefix = `bun-cache-example:${process.pid}-store-clock`;
  const cache = createCache({
    driver: redisDriver({ url: redisUrl, prefix }),
    sweepInterval: 0,
  });
  const raw = new RedisClient(redisUrl);
  try {
    await tour("redis", cache);
  } finally {
    await cache.close();
    let cursor = "0";
    let deleted = 0;
    do {
      const [next, keys] = (await raw.send("SCAN", [
        cursor,
        "MATCH",
        `${prefix}:*`,
        "COUNT",
        "1000",
      ])) as [string, string[]];
      cursor = next;
      if (keys.length > 0) deleted += await raw.unlink(...keys);
    } while (cursor !== "0");
    show(`deleted this run's ${deleted} Redis keys (${prefix}:*)`);
    raw.close();
  }
} else {
  step("redis");
  show("sat out: set EXAMPLE_REDIS_URL to run it");
}

step("memory: a cache that cannot count itself");
const memory = cacheThrottleStore(
  createCache({ driver: memoryDriver(), sweepInterval: 0 }),
);
checkEqual("store.clock", memory.clock, "process");
checkEqual("no consumeGcra", memory.consumeGcra, undefined);

summary();
