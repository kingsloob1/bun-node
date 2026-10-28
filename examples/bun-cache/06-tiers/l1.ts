/**
 * The L1 memory tier — a per-process cache in front of a shared driver, kept
 * coherent by the driver's bus (PR-T1).
 *
 * ```bash
 * bun 06-tiers/l1.ts
 * ```
 *
 * - Two caches share one `memoryDriver()` and each has `l1: true`. They stand
 *   for two processes over one shared L2: the memory driver's bus is
 *   in-process, but the caches use it exactly as two processes would use
 *   Postgres's `LISTEN`/`NOTIFY` (`two-processes.ts` does that for real).
 * - A read goes L1, then L2; a fresh L2 hit is copied into L1. The `hit`
 *   event says which tier served it.
 * - A write goes to L2, then to the writer's own L1, then onto the bus. A
 *   message names the keys or tags that changed, never a value; the other
 *   cache drops its copy and its next read goes to L2.
 * - `{ tier: "l2" }` on a read bypasses L1 for that call: it neither reads
 *   nor fills it. A counter is L2's alone.
 * - `l1: { clone: true }` returns a `structuredClone` of each hit, so a
 *   caller mutating a result cannot change what L1 holds.
 * - L1 arms once the bus listens (it flushes then), so each cache is waited
 *   on before its first write.
 */
import type { Cache, CacheDriver } from "@kingsleyweb/bun-cache";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

/** What a read answered and the tier that served it (absent on a miss). */
interface Read {
  /** The value read. */
  value: unknown;
  /** The tier from the `hit` event; `undefined` for a miss. */
  tier: "l1" | "l2" | undefined;
}

/** The tier of the latest `hit` on each cache, set by its listener. */
const lastTier = new WeakMap<Cache, "l1" | "l2" | undefined>();

/** A cache with an L1 over `driver`, remembering which tier served each hit. */
async function openCache(
  driver: CacheDriver,
  l1: true | { clone: boolean } = true,
): Promise<Cache> {
  const cache = createCache({ driver, namespace: "example", ttl: 60_000, l1 });
  cache.on("hit", ({ tier }) => {
    lastTier.set(cache, tier);
  });
  // L1 serves and holds nothing until the bus listens; the subscription
  // flushes it, which is what `flushes` counts.
  await waitFor(
    "the bus to listen",
    () => (cache.stats().l1?.flushes ?? 0) >= 1,
  );
  return cache;
}

/** Reads `key` and says which tier served it. */
async function read(
  cache: Cache,
  key: string,
  options?: { tier: "l2" },
): Promise<Read> {
  lastTier.set(cache, undefined);
  const value = await (options === undefined
    ? cache.get(key)
    : cache.get(key, options));
  return { value, tier: lastTier.get(cache) };
}

/** Waits until `cache` no longer holds `key` in L1 (its entries count falls). */
async function droppedFromL1(cache: Cache, before: number): Promise<void> {
  await waitFor(
    "the copy to be dropped",
    () => (cache.stats().l1?.entries ?? 0) < before,
  );
}

title("the L1 tier: a memory copy per process, kept coherent by a bus");

const driver = memoryDriver();
const a = await openCache(driver);
const b = await openCache(driver);

/* ------------------------------------------------------------------ */
step("a write holds its own copy; another cache backfills on first read");

await a.set("k", { v: 1 });
checkEqual("A: served from its own L1", await read(a, "k"), {
  value: { v: 1 },
  tier: "l1",
});
checkEqual("A: one L1 hit counted", a.stats().l1?.hits, 1);

checkEqual("B: first read comes from L2", await read(b, "k"), {
  value: { v: 1 },
  tier: "l2",
});
checkEqual("B: the next read is L1", await read(b, "k"), {
  value: { v: 1 },
  tier: "l1",
});
checkEqual("B: one backfill", b.stats().l1?.backfills, 1);
show("B stats().l1", b.stats().l1);

/* ------------------------------------------------------------------ */
step("a write elsewhere drops the other cache's copy");

await a.set("k", { v: 2 });
// The memory driver's bus calls its listeners inside `publish`, which `set`
// awaits, so B's copy is already gone. Across processes delivery is
// eventual (see two-processes.ts).
checkEqual("B reads the new value at once", await read(b, "k"), {
  value: { v: 2 },
  tier: "l2",
});

/** Puts `k` into both L1s, then lets `change` run on A. */
async function bothHold(): Promise<void> {
  await a.set("k", { v: 3 });
  await waitFor("B to hold k in L1", async () => {
    const got = await read(b, "k");
    return got.tier === "l1";
  });
}

/* ------------------------------------------------------------------ */
step("delete, invalidateTags and clear each drop B's copy");

await bothHold();
let held = b.stats().l1?.entries ?? 0;
await a.delete("k");
await droppedFromL1(b, held);
checkEqual("delete: B misses", await read(b, "k"), {
  value: undefined,
  tier: undefined,
});

await a.set("t", { v: "tagged" }, { tags: ["group"] });
await waitFor(
  "B to hold t in L1",
  async () => (await read(b, "t")).tier === "l1",
);
held = b.stats().l1?.entries ?? 0;
await a.invalidateTags(["group"]);
await droppedFromL1(b, held);
checkEqual("invalidateTags: B misses", await read(b, "t"), {
  value: undefined,
  tier: undefined,
});

await bothHold();
held = b.stats().l1?.entries ?? 0;
await a.clear();
await droppedFromL1(b, held);
checkEqual("clear: B misses", await read(b, "k"), {
  value: undefined,
  tier: undefined,
});
check(
  "B counted invalidations",
  (b.stats().l1?.invalidations ?? 0) >= 3,
  b.stats().l1,
);

/* ------------------------------------------------------------------ */
step("tier: 'l2' bypasses L1 for one call");

await a.set("k", { v: 4 });
await waitFor(
  "B to hold k in L1",
  async () => (await read(b, "k")).tier === "l1",
);
const entriesBefore = b.stats().l1?.entries;
const hitsBefore = b.stats().l1?.hits;
checkEqual("B reads L2 on request", await read(b, "k", { tier: "l2" }), {
  value: { v: 4 },
  tier: "l2",
});
checkEqual("…and L1 is unchanged", b.stats().l1?.entries, entriesBefore);
checkEqual("…and counted no L1 hit", b.stats().l1?.hits, hitsBefore);

/* ------------------------------------------------------------------ */
step("counters never enter L1");

await a.increment("visits");
await a.increment("visits");
checkEqual("first read of a counter: L2", await read(b, "visits"), {
  value: 2,
  tier: "l2",
});
checkEqual("second read of a counter: still L2", await read(b, "visits"), {
  value: 2,
  tier: "l2",
});

/* ------------------------------------------------------------------ */
step("clone: true — a caller cannot change what L1 holds");

const cloning = await openCache(memoryDriver(), { clone: true });
await cloning.set("doc", { list: [1, 2] });
const first = (await read(cloning, "doc")).value as { list: number[] };
first.list.push(99);
checkEqual(
  "a mutated result is not seen by the next read",
  (await read(cloning, "doc")).value,
  {
    list: [1, 2],
  },
);
// The default shares the object L1 holds: documented, and a bug in a caller.
await a.set("doc", { list: [1, 2] });
const shared = (await read(a, "doc")).value as { list: number[] };
shared.list.push(99);
checkEqual(
  "without clone the same object is returned (shared, not copied)",
  (await read(a, "doc")).value,
  { list: [1, 2, 99] },
);

await cloning.close();
await a.close();
await b.close();
summary();
