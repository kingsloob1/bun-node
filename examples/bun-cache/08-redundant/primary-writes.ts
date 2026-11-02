/**
 * Redundant drivers, primary writes — `write: "primary"` writes the first
 * healthy member and copies to the others in the background through a bounded
 * queue per member. Memory members, one behind the kit's `faulty()`: no
 * server needed.
 *
 * ```bash
 * bun 08-redundant/primary-writes.ts
 * ```
 *
 * - The replication queue: the secondary catches up in order; a slow one
 *   whose queue passes `maxQueue` is dropped for that write, reported as
 *   `member-dirty` with `reason: "overflow"`, emptied, and then serves again.
 * - Counters and locks live on the primary only. With it down, `increment`
 *   throws `UnsupportedOperationError` and never reaches the secondary; the
 *   capabilities say `lock: false`, so `getOrSet({ lock: true })` falls back
 *   to the in-process single-flight. `counters: "refuse"` removes them.
 * - The fence under `write: "primary"`: an invalidation, then a loader that
 *   started before it is refused as `"fenced"` (the `fenced` event) and its
 *   value is not stored.
 *
 * Nothing here asserts on a duration: every wait is for an event or a state.
 */
import type { CacheDriver, CacheEventMap } from "@kingsleyweb/bun-cache";
import {
  createCache,
  memoryDriver,
  redundant,
  UnsupportedOperationError,
} from "@kingsleyweb/bun-cache";
import { faulty } from "@kingsleyweb/bun-cache/testing";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("redundant drivers: write: primary");

/** The namespace every cache here uses. */
const NS = "redundant-primary";

/** A cache over `driver` with nothing running in the background. */
function cacheOver(driver: CacheDriver) {
  return createCache({
    driver,
    namespace: NS,
    ttl: 60_000,
    sweepInterval: 0,
    bus: false,
  });
}

/** What a member holds for `key`, as `cache` names it. */
async function heldBy(
  member: CacheDriver,
  cache: ReturnType<typeof cacheOver>,
  key: string,
) {
  const { namespace, key: stored } = cache.describeKey(key);
  return await member.get(namespace, stored);
}

/* ------------------------------------------------------------------ */
step("the replication queue and maxQueue");

{
  const a = memoryDriver();
  const b = memoryDriver();
  // Every operation on the secondary is slowed, so its queue fills.
  const fb = faulty(b, { lagMs: 40 });
  const cache = cacheOver(
    redundant([a, fb], { write: "primary", maxQueue: 5, timeout: 2_000 }),
  );
  const dirty: CacheEventMap["member-dirty"][] = [];
  const up: CacheEventMap["member-up"][] = [];
  cache.on("member-dirty", (payload) => dirty.push(payload));
  cache.on("member-up", (payload) => up.push(payload));

  await cache.set("pre", 1);
  await waitFor("the secondary to take the first write", async () => {
    return (await heldBy(b, cache, "pre")) !== undefined;
  });

  for (let index = 0; index < 20; index++) {
    await cache.set(`k${index}`, index);
  }
  checkEqual(
    "the primary has every write the moment each resolves",
    (
      await Promise.all(
        Array.from({ length: 20 }, (_, index) => heldBy(a, cache, `k${index}`)),
      )
    ).every((entry) => entry !== undefined),
    true,
  );
  checkEqual("one member-dirty, for the overflow", dirty.length, 1);
  show("member-dirty", dirty[0]);
  checkEqual(
    "its index, op and reason",
    { index: dirty[0]?.index, op: dirty[0]?.op, reason: dirty[0]?.reason },
    { index: 1, op: "set", reason: "overflow" },
  );
  await waitFor("member-up", () => up.length > 0);
  checkEqual(
    "the secondary was emptied before it served",
    up[0]?.cleared,
    true,
  );
  checkEqual(
    "what it held from before is gone",
    await heldBy(b, cache, "pre"),
    undefined,
  );
  await cache.close();
}

/* ------------------------------------------------------------------ */
step("counters and locks: the primary only");

{
  const a = memoryDriver();
  const fa = faulty(a);
  const b = memoryDriver();
  const driver = redundant([fa, b], {
    write: "primary",
    timeout: 200,
    circuit: { failures: 1, cooldown: 60_000 },
  });
  const cache = cacheOver(driver);

  checkEqual(
    "a counter counts on the primary",
    await cache.increment("hits"),
    1,
  );
  const { namespace, key } = cache.describeKey("hits");
  checkEqual(
    "the secondary has no counter",
    await b.getCounter!(namespace, key),
    undefined,
  );
  checkEqual(
    "the capabilities offer counters",
    driver.capabilities.atomicIncrement,
    true,
  );
  checkEqual("and the lock", driver.capabilities.lock, true);

  fa.setFaults({ down: true });
  await driver.get("ns", "x"); // a call the primary fails: its circuit opens
  checkEqual(
    "with the primary down: no counters",
    driver.capabilities.atomicIncrement,
    false,
  );
  checkEqual("and no lock", driver.capabilities.lock, false);
  await checkRejects("increment refuses", () => cache.increment("hits"), {
    name: UnsupportedOperationError.name,
  });
  checkEqual(
    "nothing reached the secondary",
    await b.getCounter!(namespace, key),
    undefined,
  );

  let loads = 0;
  const [one, two] = await Promise.all([
    cache.getOrSet("locked", () => ++loads, { lock: true }),
    cache.getOrSet("locked", () => ++loads, { lock: true }),
  ]);
  checkEqual(
    "getOrSet({ lock: true }) falls back to in-process single-flight",
    [one, two, loads],
    [1, 1, 1],
  );
  await cache.close();
}

{
  const driver = redundant([memoryDriver(), memoryDriver()], {
    write: "primary",
    counters: "refuse",
  });
  const cache = cacheOver(driver);
  checkEqual(
    "counters: refuse advertises no counters",
    driver.capabilities.atomicIncrement,
    false,
  );
  checkEqual("and no lock", driver.capabilities.lock, false);
  await checkRejects("increment is refused", () => cache.increment("hits"), {
    name: UnsupportedOperationError.name,
  });
  await cache.close();
}

/* ------------------------------------------------------------------ */
step("the fence: an invalidation, then a stale load");

{
  const a = memoryDriver();
  const b = memoryDriver();
  const driver = redundant([a, b], { write: "primary" });
  // Two caches on one driver: what two processes would be. An invalidation
  // from the same cache forgets its own flight; another's meets the fence.
  const loading = cacheOver(driver);
  const invalidating = cacheOver(driver);
  const fenced: CacheEventMap["fenced"][] = [];
  loading.on("fenced", (event) => fenced.push(event));

  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const pending = loading.getOrSet(
    "page",
    async () => {
      started.resolve();
      await release.promise;
      return "computed before the invalidation";
    },
    { tags: ["pages"] },
  );
  await started.promise;
  await invalidating.invalidateTags(["pages"]);
  release.resolve();
  checkEqual(
    "the caller still gets its value",
    await pending,
    "computed before the invalidation",
  );
  checkEqual("a fenced event says the write was refused", fenced.length, 1);
  show("fenced", fenced[0]);
  checkEqual("with reason fence", fenced[0]?.reason, "fence");
  checkEqual(
    "the primary did not store it",
    await heldBy(a, loading, "page"),
    undefined,
  );
  checkEqual("it reads as a miss", await loading.get("page"), undefined);

  // The same load started after the invalidation is stored.
  await loading.getOrSet("page", () => "computed after", { tags: ["pages"] });
  check(
    "a load that starts after it is stored",
    (await heldBy(a, loading, "page")) !== undefined,
  );
  await loading.close();
  await invalidating.close();
}

summary();
