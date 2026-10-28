/**
 * The MongoDB driver — a shared cache in a MongoDB database, with TTL
 * indexes, atomic counters, lock documents, tag invalidation and its own bus
 * (PR-C6).
 *
 * ```bash
 * EXAMPLE_MONGODB_URL=mongodb://127.0.0.1:27017/bun_cache_example bun 04-drivers/mongodb.ts
 * ```
 *
 * - It runs when `EXAMPLE_MONGODB_URL` (or `BUN_CACHE_TEST_MONGODB_URL`) is
 *   set and otherwise prints `skipped:` and exits 0. A URL that is set but
 *   unreachable fails. The driver needs the `mongodb` package (an optional
 *   peer: `bun add mongodb`); this example also uses it for its own client.
 * - Every collection is named under a prefix naming this process
 *   (`bun_cache_example_<pid>_`, and one more each for the `maxEntries` and
 *   `collections` parts),
 *   and the example drops exactly those collections at the end, even when a
 *   check failed. Nothing else in the database is read or written.
 * - It shows `getOrSet`, tag invalidation and counters below zero; a lock
 *   contended by two caches; an expired entry read as a miss while its
 *   document is still stored; `collections` naming one collection outright;
 *   `syncSchema({ dryRun: true })` answering `[]`; `maxEntries` with a manual
 *   `sweep` and the `evict` events; an existing `client` that outlives the
 *   cache; and two caches with `l1: true` kept coherent over the driver's own
 *   bus (`bus: "auto"`).
 *
 * Limits worth knowing (see the README's "The MongoDB driver"):
 *
 * - MongoDB's TTL monitor runs once a minute, so a document can outlive its
 *   `exp` by that long; the driver filters `exp` on every read, so an expired
 *   entry is a miss at once.
 * - The bus depends on the server. A replica set or `mongos` has change
 *   streams, which the driver uses; a standalone server refuses them, and the
 *   driver tails a capped collection instead. This example does not assert
 *   which of the two it got: it checks only that the other cache hears the
 *   write.
 * - The fence is check-then-write with a take-back: a value loaded before an
 *   invalidation can be visible for about one round trip before it is taken
 *   back.
 */
import { MongoClient } from "mongodb";
import process from "node:process";
import { createCache, mongoDriver } from "@kingsleyweb/bun-cache";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

const url =
  process.env.EXAMPLE_MONGODB_URL ?? process.env.BUN_CACHE_TEST_MONGODB_URL;

if (!url) {
  console.log(
    "skipped: set EXAMPLE_MONGODB_URL (for instance mongodb://127.0.0.1:27017/bun_cache_example) to run this example",
  );
  process.exit(0);
}

title("the MongoDB driver: a shared cache in a MongoDB database");

/** The collection prefix of this run: it names this process, so a run owns its collections. */
const prefix = `bun_cache_example_${process.pid}_`;

/** The prefix of the `maxEntries` part, which counts every namespace under a prefix. */
const capPrefix = `bun_cache_example_${process.pid}_cap_`;

/** The prefix of the `collections` part: nothing else uses it, so which collections exist under it is known. */
const namedPrefix = `bun_cache_example_${process.pid}_named_`;

/** The one collection named outright through `collections` (it ignores the prefix). */
const namedCollection = `bun_cache_example_${process.pid}_outright`;

/** The collections a prefix names. */
const COLLECTIONS = ["entries", "stamps", "locks", "bus"];

/** Every collection this run may create: exactly these are dropped at the end. */
const mine = [
  ...COLLECTIONS.map((name) => `${prefix}${name}`),
  ...COLLECTIONS.map((name) => `${capPrefix}${name}`),
  ...COLLECTIONS.map((name) => `${namedPrefix}${name}`),
  namedCollection,
];

/** A client of our own: checks the server is there, reads the collections, and cleans up. */
const raw = new MongoClient(url, { serverSelectionTimeoutMS: 5_000 });
try {
  await raw.connect();
  await raw.db().command({ ping: 1 });
} catch (error) {
  await raw.close().catch(() => undefined);
  throw new Error("EXAMPLE_MONGODB_URL is set but unreachable", {
    cause: error,
  });
}

/** The database the URL names, which the drivers use too. */
const database = raw.db();

/** How many documents a collection holds right now. */
async function countOf(collection: string): Promise<number> {
  return database.collection(collection).countDocuments({});
}

try {
  /* ------------------------------------------------------------------ */
  step("getOrSet, tags and counters");

  const cache = createCache({
    driver: mongoDriver({ url, prefix }),
    namespace: "example",
    ttl: 60_000,
    sweepInterval: 0, // sweeps are driven by hand below
  });
  let loads = 0;
  const load = () => {
    loads++;
    return Promise.resolve({ name: "Ada" });
  };
  checkEqual(
    "getOrSet loads the value",
    await cache.getOrSet("user:42", load, { tags: ["users"] }),
    { name: "Ada" },
  );
  checkEqual(
    "a second getOrSet is a hit",
    await cache.getOrSet("user:42", load, { tags: ["users"] }),
    { name: "Ada" },
  );
  checkEqual("the loader ran once", loads, 1);
  checkEqual(
    "the entry is one document in the entries collection",
    await countOf(`${prefix}entries`),
    1,
  );

  await cache.invalidateTags(["users"]);
  checkEqual(
    "invalidateTags makes the entry a miss",
    await cache.get("user:42"),
    undefined,
  );
  // Tags are indexed: the tagged document was deleted, not just stamped.
  checkEqual(
    "the entry document is gone from the collection",
    await countOf(`${prefix}entries`),
    0,
  );
  await cache.getOrSet("user:42", load, { tags: ["users"] });
  checkEqual("it loads again after the invalidation", loads, 2);

  checkEqual("a counter counts up", await cache.increment("balance", 2), 2);
  checkEqual(
    "a counter goes below zero",
    await cache.increment("balance", -5),
    -3,
  );
  checkEqual(
    "get reads the counter as a number",
    await cache.get("balance"),
    -3,
  );
  await cache.close();

  /* ------------------------------------------------------------------ */
  step("a lock contended by two caches runs the loader once");

  const left = createCache({
    driver: mongoDriver({ url, prefix }),
    namespace: "locked",
    sweepInterval: 0,
  });
  const right = createCache({
    driver: mongoDriver({ url, prefix }),
    namespace: "locked",
    sweepInterval: 0,
  });
  let built = 0;
  const lockedLoad = (side: typeof left) =>
    side.getOrSet(
      "report",
      async () => {
        built++;
        await Bun.sleep(300); // slow enough that the other cache arrives meanwhile
        return "built";
      },
      { lock: { wait: { interval: 20, timeout: 5_000 } } },
    );
  const [fromLeft, fromRight] = await Promise.all([
    lockedLoad(left),
    lockedLoad(right),
  ]);
  checkEqual("the first cache got the value", fromLeft, "built");
  checkEqual("the second cache got it too", fromRight, "built");
  checkEqual("the loader ran exactly once across both", built, 1);
  await left.close();
  await right.close();

  /* ------------------------------------------------------------------ */
  step("expiry: a miss at once, the document still stored");

  const expiring = createCache({
    driver: mongoDriver({ url, prefix }),
    namespace: "expiring",
    sweepInterval: 0,
  });
  await expiring.set("short", "gone soon", { ttl: 200 });
  checkEqual("it reads while fresh", await expiring.get("short"), "gone soon");
  await waitFor("the entry to expire", async () => {
    return (await expiring.get("short")) === undefined;
  });
  checkEqual(
    "it is a miss after its TTL",
    await expiring.get("short"),
    undefined,
  );
  // The TTL index deletes the document, but its monitor runs once a minute
  // (measured: `ttlMonitorSleepSecs` is 60), so the read above is a miss
  // because the driver filters `exp` itself, not because the document is gone.
  const stored = await database
    .collection(`${prefix}entries`)
    .countDocuments({ "_id.ns": "expiring" });
  show("documents of the expired entry still stored (0 or 1)", stored);
  check("at most the one document is left", stored <= 1, stored);
  await expiring.close();

  /* ------------------------------------------------------------------ */
  step("collections names one collection outright");

  const named = createCache({
    driver: mongoDriver({
      url,
      prefix: namedPrefix,
      collections: { entries: namedCollection },
    }),
    namespace: "named",
    sweepInterval: 0,
  });
  await named.set("k", "v");
  checkEqual("the cache works", await named.get("k"), "v");
  checkEqual(
    "the entry is in the collection that was named",
    await countOf(namedCollection),
    1,
  );
  // The name is used as-is; the other collections keep the prefix.
  const present = new Set(
    (await database.listCollections({}, { nameOnly: true }).toArray()).map(
      (collection) => collection.name,
    ),
  );
  check(
    "the stamps collection kept the prefix",
    present.has(`${namedPrefix}stamps`),
    [...present].filter((name) => mine.includes(name)),
  );
  check(
    "no entries collection was made under the prefix's name",
    !present.has(`${namedPrefix}entries`),
  );
  await named.close();

  /* ------------------------------------------------------------------ */
  step("syncSchema: nothing to change");

  const synced = mongoDriver({ url, prefix });
  await synced.connect?.();
  // Connecting created every index, and nothing is retired yet, so the plan is empty.
  checkEqual(
    "a dry run answers []",
    await synced.syncSchema!({ dryRun: true }),
    [],
  );
  await synced.close();

  /* ------------------------------------------------------------------ */
  step("maxEntries evicts nearest to expiry first");

  // Its own collections: the cap counts every namespace under a prefix, so a
  // prefix of its own keeps the count to the five entries written here.
  const capDriver = mongoDriver({ url, prefix: capPrefix, maxEntries: 3 });
  const capped = createCache({
    driver: capDriver,
    namespace: "cap",
    sweepInterval: 0,
  });
  const events: string[] = [];
  capped.on("evict", (event) => events.push(`${event.key}:${event.reason}`));
  // The longest-lived entry is written first, so "oldest write first" and
  // "nearest to expiry first" would pick different victims.
  await capped.set("c-50s", 1, { ttl: 50_000 });
  await capped.set("c-40s", 2, { ttl: 40_000 });
  await capped.set("c-30s", 3, { ttl: 30_000 });
  await capped.set("c-20s", 4, { ttl: 20_000 });
  await capped.set("c-10s", 5, { ttl: 10_000 });
  checkEqual(
    "five entries before the sweep",
    await countOf(`${capPrefix}entries`),
    5,
  );
  await capDriver.sweep!(Date.now(), 1_000);
  checkEqual(
    "the sweep left exactly 3 entries",
    await countOf(`${capPrefix}entries`),
    3,
  );
  await waitFor("the evict events", () => events.length >= 2, {
    timeout: 5_000,
  });
  const survivors = await Promise.all(
    ["c-50s", "c-40s", "c-30s", "c-20s", "c-10s"].map(async (key) => [
      key,
      (await capped.get(key)) !== undefined,
    ]),
  );
  show("which capped keys survived", Object.fromEntries(survivors));
  check(
    "the nearest-to-expiry entries went first",
    !survivors.some(([key, alive]) => key === "c-10s" && alive) &&
      !survivors.some(([key, alive]) => key === "c-20s" && alive),
    survivors,
  );
  check(
    "every eviction was an evict event with reason cap",
    events.length === 2 && events.every((event) => event.endsWith(":cap")),
    events,
  );
  check("c-10s was reported", events.includes("c-10s:cap"), events);
  await capped.close();

  /* ------------------------------------------------------------------ */
  step("an existing client outlives the cache");

  const borrowed = new MongoClient(url, { serverSelectionTimeoutMS: 5_000 });
  await borrowed.connect();
  const borrowing = createCache({
    driver: mongoDriver({
      client: borrowed,
      database: database.databaseName,
      prefix,
    }),
    namespace: "borrowed",
    sweepInterval: 0,
  });
  await borrowing.set("k", "v");
  checkEqual("the cache works on my client", await borrowing.get("k"), "v");
  await borrowing.close();
  const pong = await borrowed.db().command({ ping: 1 });
  checkEqual("my client still answers after close", pong.ok, 1);
  await borrowed.close();

  /* ------------------------------------------------------------------ */
  step("two caches with l1: true stay coherent over the driver's bus");

  // A replica set uses a change stream for the bus and a standalone server a
  // tailable cursor on the capped bus collection; either way the other cache
  // hears the write, which is all this part checks.
  const first = createCache({
    driver: mongoDriver({ url, prefix }),
    namespace: "shared",
    l1: true,
    sweepInterval: 0,
  });
  const second = createCache({
    driver: mongoDriver({ url, prefix }),
    namespace: "shared",
    l1: true,
    sweepInterval: 0,
  });
  // The L1 arms (flushes once) when its bus is listening.
  for (const side of [first, second]) {
    await waitFor(
      "the bus to listen",
      () => (side.stats().l1?.flushes ?? 0) >= 1,
      { timeout: 10_000 },
    );
  }
  await first.set("k", "one", { ttl: 60_000 });
  checkEqual("the second sees the first's write", await second.get("k"), "one");
  // A value just written is not copied into L1 at once (the core holds back a
  // backfill of a very recent write), so read until the second serves it from L1.
  let tier: "l1" | "l2" | undefined;
  second.on("hit", (event) => {
    tier = event.tier;
  });
  await waitFor(
    "the second's L1 to serve the key",
    async () => {
      await second.get("k");
      return tier === "l1";
    },
    { timeout: 5_000, interval: 50 },
  );
  check("a repeat read is served by the second's L1", tier === "l1", tier);
  const droppedBefore = second.stats().l1?.invalidations ?? 0;
  await first.set("k", "two", { ttl: 60_000 });
  await waitFor(
    "the second's L1 copy to be dropped",
    () => (second.stats().l1?.invalidations ?? 0) > droppedBefore,
    { timeout: 5_000 },
  );
  check(
    "the write counted as an L1 invalidation on the other cache",
    (second.stats().l1?.invalidations ?? 0) > droppedBefore,
    second.stats().l1,
  );
  checkEqual("and it reads the new value", await second.get("k"), "two");
  await first.close();
  await second.close();
} finally {
  // Drop exactly the collections this run may have created — never the database.
  const existing = new Set(
    (await database.listCollections({}, { nameOnly: true }).toArray()).map(
      (collection) => collection.name,
    ),
  );
  const dropped = mine.filter((name) => existing.has(name));
  for (const name of dropped) {
    await database.dropCollection(name);
  }
  const remaining = (
    await database.listCollections({}, { nameOnly: true }).toArray()
  ).filter((collection) => mine.includes(collection.name));
  show("dropped this run's collections", {
    dropped: dropped.length,
    left: remaining.length,
  });
  await raw.close();
}

summary();
