/**
 * The throttle store — `cacheThrottleStore(cache)` from
 * `@kingsleyweb/bun-cache/throttle`, given to bun-common's `throttle()`, on
 * the memory driver and a fake clock so every window edge is exact.
 *
 * ```bash
 * bun 09-throttle/basics.ts
 * ```
 *
 * - The sliding window (the default): four requests against a limit of three
 *   answer 200, 200, 200 and 429 with `Retry-After`; halfway into the next
 *   minute half of the last minute's count still weighs, so one more fits.
 * - The fixed window: a new minute is a new budget.
 * - Where the counts live: the cache namespace `throttle` under the cache's
 *   own (`app:throttle`), one counter per limit, window length, client and
 *   window index, with the window's lifetime set once, at creation.
 * - `delete(key)` resets one client; `clear()` empties the store's namespace
 *   and leaves the cache's own entries alone.
 * - The refusals: a Cloudflare KV cache (no atomic increment) at
 *   construction, a fractional cost, and `algorithm: "gcra"`, which a store
 *   over a memory cache cannot run atomically (one over Redis, Postgres,
 *   MySQL, MariaDB or SQLite can: `store-clock.ts`).
 *
 * Across processes, see `two-processes.ts` beside this file.
 */
import type { RouterHandler } from "@kingsleyweb/bun-common";
import { BunRouter } from "@kingsleyweb/bun-common";
import {
  cloudflareKvDriver,
  createCache,
  memoryDriver,
} from "@kingsleyweb/bun-cache";
import { fakeClock } from "@kingsleyweb/bun-cache/testing";
import { cacheThrottleStore } from "@kingsleyweb/bun-cache/throttle";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("bun-cache throttle store: throttle() counting through a cache");

/** A minute-aligned instant: window edges fall on whole minutes from here. */
const T0 = 60_000 * 29_000_000;

/** One minute, every limit's window here. */
const MINUTE = 60_000;

const clock = fakeClock(T0);
const cache = createCache({
  driver: memoryDriver({ now: clock.now }),
  namespace: "app",
  sweepInterval: 0,
  now: clock.now,
});
const store = cacheThrottleStore(cache);

const hello: RouterHandler = (_req, res) => {
  res.send("hello");
};

/** A router whose every request is throttled through `store`, per `x-client`. */
function app(algorithm: "fixed-window" | "sliding-window"): BunRouter {
  const router = new BunRouter({
    throttle: {
      limit: 3,
      window: "1m",
      algorithm,
      prefix: algorithm,
      store,
      headers: "ietf",
      key: (req) => req.get("x-client") ?? "anonymous",
      now: clock.now,
    },
  });
  router.get("/", hello);
  return router;
}

/** Sends `n` requests as `client`; answers their statuses. */
async function send(
  router: BunRouter,
  n: number,
  client = "alice",
): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await router.fetch("/", { headers: { "x-client": client } });
    statuses.push(res.status);
    if (res.status === 429) {
      show(
        `429: RateLimit ${res.headers.get("RateLimit")}, Retry-After ${res.headers.get("Retry-After")} s`,
      );
    }
  }
  return statuses;
}

/* ------------------------------------------------------------------ */
step("the sliding window (the default)");

const sliding = app("sliding-window");
checkEqual(
  "four requests, a limit of three",
  await send(sliding, 4),
  [200, 200, 200, 429],
);
checkEqual(
  "another client has its own count",
  await send(sliding, 1, "bob"),
  [200],
);
clock.set(T0 + MINUTE + MINUTE / 2);
checkEqual(
  "halfway into the next minute: half of last minute's 4 still weighs, one fits",
  await send(sliding, 2),
  [200, 429],
);

/* ------------------------------------------------------------------ */
step("the fixed window");

clock.set(T0);
const fixed = app("fixed-window");
checkEqual("the first minute", await send(fixed, 4), [200, 200, 200, 429]);
clock.set(T0 + MINUTE);
checkEqual(
  "the next minute: a new budget",
  await send(fixed, 4),
  [200, 200, 200, 429],
);

/* ------------------------------------------------------------------ */
step("where the counts live");

const counters = cache.namespace("throttle");
const key = `fixed-window:default:${MINUTE}:global:alice:${T0 / MINUTE + 1}`;
const entry = await counters.getEntry(key);
show(`store.namespace: ${store.namespace}`);
show(`counter ${key}`, entry?.value);
checkEqual("the store's namespace", store.namespace, "app:throttle");
checkEqual("the counter counts the refused request too", entry?.value, 4);
checkEqual(
  "its lifetime: to the window's end, plus the 1 s expiry margin",
  entry?.expiresAt,
  T0 + 2 * MINUTE + 1_000,
);
check(
  "the cache's own namespace holds none of it",
  (await cache.get(key)) === undefined,
);

/* ------------------------------------------------------------------ */
step("resetting");

await store.delete(key);
checkEqual(
  "delete(key): alice starts again from zero",
  await send(fixed, 4),
  [200, 200, 200, 429],
);
await cache.set("profile:alice", { plan: "pro" });
await store.clear();
checkEqual("clear(): alice's counters are gone", await send(fixed, 1), [200]);
checkEqual(
  "and the cache's own entry is not",
  await cache.get("profile:alice"),
  { plan: "pro" },
);

/* ------------------------------------------------------------------ */
step("what the store refuses");

const kv = createCache({
  driver: cloudflareKvDriver({
    accountId: "account",
    apiToken: "token",
    namespaceId: "namespace",
  }),
});
await checkRejects(
  "a Cloudflare KV cache, at construction",
  () => cacheThrottleStore(kv),
  { name: "ConfigError", message: /"cloudflare-kv" has no atomic increment/ },
);
await checkRejects(
  "a fractional cost",
  async () => await store.increment("k", 0.5, 1_000),
  { name: "TypeError", message: /cost must be an integer/ },
);
await checkRejects(
  'algorithm "gcra", which needs an atomic consumeGcra()',
  () => new BunRouter({ throttle: { limit: 3, store, algorithm: "gcra" } }),
  { name: "ConfigError", message: /algorithm "gcra" needs a store/ },
);

await cache.close();
summary();
