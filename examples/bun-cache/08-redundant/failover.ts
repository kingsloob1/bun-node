/**
 * Redundant drivers, failing over — `redundant([a, b], options)` makes one
 * driver of several, so a cache tier survives losing one backend. Two memory
 * members here, one of them behind the kit's `faulty()` so it can be taken
 * down: no server needed.
 *
 * ```bash
 * bun 08-redundant/failover.ts
 * ```
 *
 * - `write: "all"` with `ack: "one"` (resolve when the member a read asks
 *   first has it) and `ack: "all"` (resolve when every member has it).
 * - `read: "failover"`: the primary down, the secondary serves; a miss from a
 *   healthy primary is final, a miss from a secondary is not.
 * - `member-down`, `member-up` and `member-dirty` through `cache.on`.
 * - A member that missed a write rejoins empty, with `cleared: true`.
 * - `read: "race"`: every healthy member is asked, the first hit wins.
 * - `secondaryTtl`: the hard expiry written to the secondaries is capped.
 *
 * Nothing here asserts on a duration. The circuit's cooldown is 50 ms, and
 * the example waits for the `member-up` event it ends with, not for a time.
 * The README's "Redundant drivers" is the reference.
 */
import type { CacheDriver, CacheEventMap } from "@kingsleyweb/bun-cache";
import { createCache, memoryDriver, redundant } from "@kingsleyweb/bun-cache";
import { faulty } from "@kingsleyweb/bun-cache/testing";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("redundant drivers: two members, one survives");

/** The namespace every cache here uses. */
const NS = "redundant-example";

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

/** What a member holds for `key`, as `cache` names it: the value, or `undefined`. */
async function heldBy(
  member: CacheDriver,
  cache: ReturnType<typeof cacheOver>,
  key: string,
) {
  const { namespace, key: stored } = cache.describeKey(key);
  return await member.get(namespace, stored);
}

/** Every member event a cache heard, in order. */
function listen(cache: ReturnType<typeof cacheOver>) {
  const seen: {
    /** The event's name. */
    name: string;
    /** Its payload. */
    payload: CacheEventMap["member-down" | "member-up" | "member-dirty"];
  }[] = [];
  for (const name of ["member-down", "member-up", "member-dirty"] as const) {
    cache.on(name, (payload) => seen.push({ name, payload }));
  }
  return {
    seen,
    /** The payloads of one event. */
    of: (name: string) =>
      seen.filter((each) => each.name === name).map((each) => each.payload),
  };
}

/* ------------------------------------------------------------------ */
step('write: "all": ack "one" and ack "all"');

{
  const a = memoryDriver();
  const b = memoryDriver();
  const cache = cacheOver(redundant([a, b], { write: "all", ack: "all" }));
  await cache.set("user:1", "Ada");
  check(
    'ack "all": both members hold it when set resolves',
    (await heldBy(a, cache, "user:1")) !== undefined &&
      (await heldBy(b, cache, "user:1")) !== undefined,
  );
  checkEqual("it reads back", await cache.get("user:1"), "Ada");
  await cache.close();
}

{
  const a = memoryDriver();
  const b = memoryDriver();
  const cache = cacheOver(redundant([a, b], { write: "all", ack: "one" }));
  await cache.set("user:2", "Grace");
  check(
    'ack "one": the first member holds it when set resolves',
    (await heldBy(a, cache, "user:2")) !== undefined,
  );
  // The second member finishes in the background: wait for it, do not time it.
  await waitFor("the second member to hold it", async () => {
    return (await heldBy(b, cache, "user:2")) !== undefined;
  });
  check("and so does the second, a moment later", true);
  await cache.close();
}

/* ------------------------------------------------------------------ */
step('read: "failover": the primary down, the secondary serves');

{
  const a = memoryDriver();
  const fa = faulty(a);
  const b = memoryDriver();
  const driver = redundant([fa, b], {
    timeout: 200,
    circuit: { failures: 1, cooldown: 60_000 },
  });
  const cache = cacheOver(driver);
  const heard = listen(cache);

  await cache.set("report", { total: 42 });
  checkEqual(
    "both members have it",
    [
      (await heldBy(a, cache, "report")) !== undefined,
      (await heldBy(b, cache, "report")) !== undefined,
    ],
    [true, true],
  );

  fa.setFaults({ down: true });
  checkEqual(
    "the primary is down and the secondary answers",
    await cache.get("report"),
    { total: 42 },
  );
  await waitFor("member-down", () => heard.of("member-down").length > 0);
  const down = heard.of("member-down")[0] as { index: number; member: string };
  checkEqual("member-down names the primary", down.index, 0);
  show("member-down", down);

  // A miss from a healthy primary is final; the secondary is not asked.
  const healthyA = memoryDriver();
  const holdsOnlyB = memoryDriver();
  const finalMiss = cacheOver(redundant([healthyA, holdsOnlyB]));
  await cacheOver(holdsOnlyB).set("only-on-b", "hidden");
  checkEqual(
    "a miss from a healthy primary is final",
    await finalMiss.get("only-on-b"),
    undefined,
  );
  await finalMiss.close();
  await cache.close();
}

/* ------------------------------------------------------------------ */
step("a member that missed a write rejoins empty");

{
  const a = memoryDriver();
  const b = memoryDriver();
  const fb = faulty(b);
  const driver = redundant([a, fb], {
    ack: "all",
    timeout: 200,
    circuit: { failures: 1, cooldown: 50 },
  });
  const cache = cacheOver(driver);
  const heard = listen(cache);

  await cache.set("old", "from before the outage");
  check(
    "the secondary holds the old value",
    (await heldBy(b, cache, "old")) !== undefined,
  );

  fb.setFaults({ down: true });
  // The write the secondary fails: its circuit opens and it is marked dirty.
  await cache.set("new", "written while it was down");
  await waitFor("member-down", () => heard.of("member-down").length > 0);
  await waitFor("member-dirty", () => heard.of("member-dirty").length > 0);
  const dirty = heard.of("member-dirty");
  checkEqual("member-dirty names the missed write", dirty.length, 1);
  checkEqual(
    "its index, op and reason",
    {
      index: (dirty[0] as { index: number }).index,
      op: (dirty[0] as { op: string }).op,
      reason: (dirty[0] as { reason: string }).reason,
    },
    { index: 1, op: "set", reason: "failed" },
  );

  fb.setFaults({});
  // The operation after the cooldown starts the probe; keep asking until the
  // member is back (the event is the signal, not the clock).
  await waitFor("member-up", async () => {
    await cache.get("old");
    return heard.of("member-up").length > 0;
  });
  const up = heard.of("member-up")[0] as { cleared?: boolean };
  checkEqual("member-up says it was emptied", up.cleared, true);
  checkEqual(
    "the value it held from before is gone from it",
    await heldBy(b, cache, "old"),
    undefined,
  );
  checkEqual(
    "the primary still has everything",
    [
      (await heldBy(a, cache, "old")) !== undefined,
      (await heldBy(a, cache, "new")) !== undefined,
    ],
    [true, true],
  );
  await cache.set("after", "written once it is back");
  await waitFor("the rejoined member to take writes", async () => {
    return (await heldBy(b, cache, "after")) !== undefined;
  });
  check("it takes writes again", true);
  await cache.close();
}

/* ------------------------------------------------------------------ */
step('read: "race": every member is asked, the first hit wins');

{
  const a = memoryDriver();
  const b = memoryDriver();
  // The value is on the second member only, written through a cache of its own.
  await cacheOver(b).set("only-on-b", "found");

  const failover = cacheOver(redundant([a, b], { read: "failover" }));
  checkEqual(
    "failover: the primary's miss is final",
    await failover.get("only-on-b"),
    undefined,
  );
  const race = cacheOver(redundant([a, b], { read: "race" }));
  checkEqual(
    "race: the secondary's hit wins",
    await race.get("only-on-b"),
    "found",
  );
  await failover.close();
  await race.close();
}

/* ------------------------------------------------------------------ */
step("secondaryTtl: the secondaries' hard expiry is capped");

{
  const a = memoryDriver();
  const b = memoryDriver();
  const cache = cacheOver(
    redundant([a, b], { secondaryTtl: 1_000, ack: "all" }),
  );
  await cache.set("capped", "v", { ttl: 3_600_000 });
  const first = await heldBy(a, cache, "capped");
  const second = await heldBy(b, cache, "capped");
  const firstLeft = (first?.expiresAt ?? 0) - Date.now();
  const secondLeft = (second?.expiresAt ?? 0) - Date.now();
  show("time left on the primary, ms", firstLeft);
  show("time left on the secondary, ms", secondLeft);
  check(
    "the primary keeps the entry's own TTL (an hour)",
    firstLeft > 3_000_000,
    {
      firstLeft,
    },
  );
  check(
    "the secondary's copy lives at most secondaryTtl",
    secondLeft <= 1_000,
    {
      secondLeft,
    },
  );
  await cache.close();
}

summary();
