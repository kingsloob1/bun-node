/**
 * How stale an L1 copy can be — the bound without a bus, and what the bus
 * changes (PR-T1).
 *
 * ```bash
 * bun 06-tiers/staleness.ts
 * ```
 *
 * - An L1 copy is held until the first of its freshness, the L2 entry's
 *   expiry and `l1.ttl`. With `bus: false` nothing tells a cache that another
 *   wrote, so `l1.ttl` is the staleness bound: the other cache serves its
 *   copy until the copy expires, and then reads the new value from L2. The
 *   bound is an upper one — a copy may also be dropped earlier (evicted, or
 *   flushed) — and it is only *eventual* consistency.
 * - A `{ tier: "l2" }` read sees the new value at once: it never consults L1.
 * - With the bus (`"auto"`, the default for an `l1`) the same write drops the
 *   other copy as soon as the message is delivered. Delivery has no fixed
 *   latency across processes (`two-processes.ts` measures it), so the
 *   guarantee is "eventually, and `l1.ttl` still caps it if the bus is
 *   down", not a number of milliseconds.
 * - Both caches share one `memoryDriver()`, standing for one shared L2.
 */
import type { Cache } from "@kingsleyweb/bun-cache";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

/** `l1.ttl` for the no-bus caches, in ms: the staleness bound being shown. */
const L1_TTL = 500;

/** How long past `l1.ttl` the new value may take to show up, in ms. Generous: a shared, loaded machine. */
const SLACK = 5_000;

/** The tier of the latest `hit` on each cache. */
const lastTier = new WeakMap<Cache, "l1" | "l2" | undefined>();

/** Watches a cache's hits for their tier. */
function track(cache: Cache): Cache {
  cache.on("hit", ({ tier }) => {
    lastTier.set(cache, tier);
  });
  return cache;
}

/** Reads `key`, answering the value and the tier that served it. */
async function read(cache: Cache, key: string, tier?: "l2") {
  lastTier.set(cache, undefined);
  const value = await (tier ? cache.get(key, { tier }) : cache.get(key));
  return { value, tier: lastTier.get(cache) };
}

title("L1 staleness: l1.ttl without a bus, the bus with one");

/* ------------------------------------------------------------------ */
step(`bus: false — the other cache serves its copy for up to ${L1_TTL} ms`);

const driver = memoryDriver();
const writer = track(
  createCache({
    driver,
    namespace: "example",
    l1: { ttl: L1_TTL },
    bus: false,
  }),
);
const reader = track(
  createCache({
    driver,
    namespace: "example",
    l1: { ttl: L1_TTL },
    bus: false,
  }),
);

await writer.set("page", "v1");
// The copy is taken at some instant after `copyBefore`, and lives at most
// `L1_TTL` from it, so it cannot be gone before `copyBefore + L1_TTL` unless
// something else dropped it.
const copyBefore = Date.now();
checkEqual("the reader copies v1 into its L1", await read(reader, "page"), {
  value: "v1",
  tier: "l2",
});
await writer.set("page", "v2");

const early = await read(reader, "page");
if (Date.now() - copyBefore < L1_TTL - 100) {
  checkEqual(
    "right after the write the reader still serves v1, from L1",
    early,
    {
      value: "v1",
      tier: "l1",
    },
  );
} else {
  show("the machine stalled past l1.ttl; skipping the 'still v1' check", early);
}
checkEqual(
  "a tier: 'l2' read sees v2 at once, L1 not consulted",
  await read(reader, "page", "l2"),
  { value: "v2", tier: "l2" },
);

await waitFor(
  "the reader to read v2",
  async () => (await reader.get("page")) === "v2",
  { timeout: L1_TTL + SLACK, interval: 20 },
);
const seenAfter = Date.now() - copyBefore;
show(`the reader saw v2 ${seenAfter} ms after its copy was taken`);
check(
  "…not before the copy's ttl ran out (nothing told the reader)",
  seenAfter >= L1_TTL - 5,
  seenAfter,
);
check("…and within l1.ttl plus slack", seenAfter <= L1_TTL + SLACK, seenAfter);
// The read after the expiry went to L2 and copied v2 in.
checkEqual("then v2 is served from L1 again", await read(reader, "page"), {
  value: "v2",
  tier: "l1",
});
await writer.close();
await reader.close();

/* ------------------------------------------------------------------ */
step("bus: 'auto' — the same write drops the other copy when it is delivered");

const busDriver = memoryDriver();
const busWriter = track(
  createCache({ driver: busDriver, namespace: "example", l1: { ttl: 60_000 } }),
);
const busReader = track(
  createCache({ driver: busDriver, namespace: "example", l1: { ttl: 60_000 } }),
);
await waitFor(
  "both caches to arm",
  () =>
    (busWriter.stats().l1?.flushes ?? 0) >= 1 &&
    (busReader.stats().l1?.flushes ?? 0) >= 1,
);
await busWriter.set("page", "v1");
await busReader.get("page");
checkEqual("the reader holds v1 in L1", await read(busReader, "page"), {
  value: "v1",
  tier: "l1",
});
await busWriter.set("page", "v2");
// l1.ttl is a minute and the wait is bounded by SLACK, so only the bus can
// have dropped the v1 copy (the wait throws if v2 never shows up).
await waitFor(
  "the reader to read v2",
  async () => (await busReader.get("page")) === "v2",
  { timeout: SLACK, interval: 20 },
);
check(
  "its L1 counted the invalidation",
  (busReader.stats().l1?.invalidations ?? 0) >= 1,
  busReader.stats().l1,
);
await busWriter.close();
await busReader.close();

summary();
