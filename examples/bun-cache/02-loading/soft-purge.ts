/**
 * Soft purge — `invalidateTags(tags, { mode: "stale" })` marks the tagged
 * entries stale instead of deleting them (Fastly's soft purge, Next.js's
 * `revalidateTag`). `getOrSet` then serves them inside the stale windows.
 *
 * ```bash
 * bun 02-loading/soft-purge.ts
 * ```
 *
 * - The cache opts in with `softPurge: true`; without it the call throws
 *   `UnsupportedOperationError`, naming the option.
 * - A purged entry is stale from the purge on, never missing: `get` misses it,
 *   `getEntry` answers it with `stale: true`, and `getOrSet` serves it within
 *   `staleWhileRevalidate` (refreshing in the background) or `staleIfError`
 *   (when the loader fails), both counted from the purge.
 * - With neither window it is a miss that loads.
 * - Time is a `fakeClock`: the windows are crossed by advancing it.
 */
import {
  createCache,
  memoryDriver,
  UnsupportedOperationError,
} from "@kingsleyweb/bun-cache";
import type { CacheEventMap } from "@kingsleyweb/bun-cache";
import { fakeClock } from "@kingsleyweb/bun-cache/testing";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("soft purge: stale instead of gone");

const clock = fakeClock();

/** A cache on a fresh memory driver with the windows given. */
function make(windows: {
  /** `staleWhileRevalidate`, ms. */
  swr?: number;
  /** `staleIfError`, ms. */
  sie?: number;
  /** Whether the cache opts in. */
  softPurge?: boolean;
}) {
  return createCache({
    driver: memoryDriver({ now: clock.now }),
    namespace: "soft",
    now: clock.now,
    ttl: 60_000,
    sweepInterval: 0,
    softPurge: windows.softPurge ?? true,
    ...(windows.swr === undefined ? {} : { staleWhileRevalidate: windows.swr }),
    ...(windows.sie === undefined ? {} : { staleIfError: windows.sie }),
  });
}

/* ------------------------------------------------------------------ */
step("staleWhileRevalidate: the old value at once, one refresh behind it");

const cache = make({ swr: 300_000, sie: 3_600_000 });
const modes: CacheEventMap["invalidate"][] = [];
cache.on("invalidate", (event) => modes.push(event));

let loads = 0;
const loadReport = () => {
  loads++;
  return Promise.resolve(`report v${loads}`);
};
checkEqual(
  "the first getOrSet loads",
  await cache.getOrSet("org:7:report", loadReport, { tags: ["org:7"] }),
  "report v1",
);
checkEqual("the entry is fresh: the loader ran once", loads, 1);

await cache.invalidateTags(["org:7"], { mode: "stale" });
// An entry created in the purge's own millisecond reads stale, so a frozen
// clock needs to move on before the refresh is written (a real one does).
clock.advance(1);
show("event", modes[0]);
checkEqual("the invalidate event says mode: stale", modes[0]?.mode, "stale");

checkEqual(
  "get misses a purged entry",
  await cache.get("org:7:report"),
  undefined,
);
checkEqual("has does too", await cache.has("org:7:report"), false);
const entry = await cache.getEntry("org:7:report");
show("getEntry", entry);
checkEqual("getEntry still answers it, stale: true", entry?.stale, true);
checkEqual("with its value", entry?.value, "report v1");

checkEqual(
  "getOrSet serves the old value at once",
  await cache.getOrSet("org:7:report", loadReport, { tags: ["org:7"] }),
  "report v1",
);
await waitFor("the background refresh", () => loads === 2);
await waitFor(
  "its value to be stored",
  async () => (await cache.get("org:7:report")) === "report v2",
);
checkEqual("the refresh ran the loader once more", loads, 2);
checkEqual(
  "the next getOrSet is fresh: the refreshed value, no load",
  await cache.getOrSet("org:7:report", loadReport, { tags: ["org:7"] }),
  "report v2",
);
checkEqual("…so the loader still ran twice", loads, 2);

/* ------------------------------------------------------------------ */
step("the window is counted from the purge");

await cache.invalidateTags(["org:7"], { mode: "stale" });
clock.advance(300_001); // past staleWhileRevalidate from the purge
let late = 0;
checkEqual(
  "past the window the purged entry is a miss that loads (waits for the loader)",
  await cache.getOrSet(
    "org:7:report",
    () => {
      late++;
      return Promise.resolve("report v3");
    },
    { tags: ["org:7"] },
  ),
  "report v3",
);
checkEqual("the loader ran", late, 1);

/* ------------------------------------------------------------------ */
step("staleIfError: a failing loader serves the purged value");

await cache.invalidateTags(["org:7"], { mode: "stale" });
clock.advance(300_001); // past stale-while-revalidate, inside staleIfError
checkEqual(
  "the loader fails: the purged value stands in",
  await cache.getOrSet(
    "org:7:report",
    () => Promise.reject(new Error("the origin is down")),
    { tags: ["org:7"] },
  ),
  "report v3",
);

/* ------------------------------------------------------------------ */
step("with no window: a miss that loads");

const bare = make({});
await bare.set("page", "v1", { tags: ["t"] });
await bare.invalidateTags(["t"], { mode: "stale" });
checkEqual(
  "getEntry sees it stale",
  (await bare.getEntry("page"))?.stale,
  true,
);
let bareLoads = 0;
checkEqual(
  "getOrSet loads at once (nothing is served stale)",
  await bare.getOrSet(
    "page",
    () => {
      bareLoads++;
      return Promise.resolve("v2");
    },
    { tags: ["t"] },
  ),
  "v2",
);
checkEqual("the loader ran", bareLoads, 1);

/* ------------------------------------------------------------------ */
step("without softPurge: UnsupportedOperationError");

const plain = make({ softPurge: false });
await plain.set("page", "v1", { tags: ["t"] });
let thrown: unknown;
try {
  await plain.invalidateTags(["t"], { mode: "stale" });
} catch (error) {
  thrown = error;
}
show("thrown", thrown instanceof Error ? thrown.message : thrown);
check(
  "mode: stale throws UnsupportedOperationError",
  thrown instanceof UnsupportedOperationError,
  thrown,
);
check(
  "…naming softPurge",
  thrown instanceof Error && thrown.message.includes("softPurge"),
  thrown,
);
checkEqual("the entry is untouched", await plain.get("page"), "v1");
await plain.invalidateTags(["t"]);
checkEqual(
  "a hard invalidation still works",
  await plain.get("page"),
  undefined,
);

for (const closing of [cache, bare, plain]) {
  await closing.close();
}
summary();
