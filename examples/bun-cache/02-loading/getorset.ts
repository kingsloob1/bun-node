/**
 * Loading — `getOrSet` and `wrap`: the single-flight under a burst,
 * stale-while-revalidate, stale-if-error, and negative caching.
 *
 * ```bash
 * bun 02-loading/getorset.ts
 * ```
 *
 * - 20 concurrent misses run the loader once (the single-flight).
 * - Past its TTL but inside `staleWhileRevalidate`, a stale value is served
 *   at once while a refresh runs in the background.
 * - Inside `staleIfError`, a failing loader serves the stale value instead of
 *   throwing.
 * - A loader's `undefined` is not cached unless `cacheUndefined` asks for it.
 */
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("getOrSet: the single-flight, staleness, negative caching");

const cache = createCache<{
  report: { rows: number; builtAt: number };
  [k: `user:${number}`]: { id: number; name: string };
}>({
  driver: memoryDriver(),
  ttl: 400,
  staleWhileRevalidate: 2_000,
  staleIfError: 10_000,
});

/* ------------------------------------------------------------------ */
step("20 concurrent misses run the loader once");

let loads = 0;
const buildReport = async () => {
  loads++;
  await Bun.sleep(100); // an expensive computation
  return { rows: 1_000, builtAt: loads };
};
const reports = await Promise.all(
  Array.from({ length: 20 }, () => cache.getOrSet("report", buildReport)),
);
checkEqual("the loader ran once", loads, 1);
check(
  "every caller got the one result",
  reports.every((r) => r?.builtAt === 1),
);

/* ------------------------------------------------------------------ */
step("stale-while-revalidate");

await Bun.sleep(500); // past the 400 ms TTL, inside the 2 s window
show(
  "the entry is stale; the next read serves it and refreshes in the background",
);
const stale = await cache.getOrSet("report", buildReport);
checkEqual("the stale value was served", stale?.builtAt, 1);
show("waiting for the background refresh…");
await Bun.sleep(200);
checkEqual("the refresh landed", (await cache.get("report"))?.builtAt, 2);

/* ------------------------------------------------------------------ */
step("stale-if-error");

await Bun.sleep(500); // stale again
const served = await cache.getOrSet("report", () =>
  Promise.reject(new Error("the origin is down")),
);
checkEqual("the stale value stood in", served?.builtAt, 2);

/* ------------------------------------------------------------------ */
step("wrap: a function with fn's own parameters");

let fetches = 0;
const fetchUser = cache.wrap(
  async (id: number) => {
    fetches++;
    await Bun.sleep(10);
    return { id, name: `user ${id}` };
  },
  { key: (id) => `user:${id}` },
);
await fetchUser(1);
await fetchUser(1);
await fetchUser(2);
checkEqual("the wrapped function loaded each key once", fetches, 2);

/* ------------------------------------------------------------------ */
step("negative caching");

const plain = createCache({ driver: memoryDriver() });
let misses = 0;
const lookup = () =>
  plain.getOrSet("missing", () => {
    misses++;
    return undefined;
  });
await lookup();
await lookup();
checkEqual("undefined is not cached by default", misses, 2);

const negatives = createCache({
  driver: memoryDriver(),
  cacheUndefined: true,
  negativeTtl: 5_000,
});
await negatives.getOrSet("missing", () => undefined);
check(
  "with cacheUndefined the marker is stored",
  (await negatives.has("missing")) === true,
);

summary();
await cache.close();
await plain.close();
await negatives.close();
