/**
 * The Redis driver — a shared cache in a Redis server, with native expiry,
 * Lua-atomic counters, locks and tag invalidation, and its own pub/sub bus
 * (PR-C5).
 *
 * ```bash
 * EXAMPLE_REDIS_URL=redis://127.0.0.1:6379/13 bun 04-drivers/redis.ts
 * ```
 *
 * - It runs when `EXAMPLE_REDIS_URL` (or `BUN_CACHE_TEST_REDIS_URL`) is set
 *   and otherwise prints `skipped:` and exits 0. A URL that is set but
 *   unreachable fails.
 * - Every key lives under the prefix `bun-cache-example:<pid>`, and the
 *   example deletes exactly the keys that prefix names (a `SCAN` of it,
 *   never `FLUSHDB`) at the end, even when a check failed. The bus channel
 *   `<prefix>:bus` holds no key.
 * - It shows `getOrSet`, tag invalidation, bytes through the `structured`
 *   codec, counters below zero and `touch`; native expiry (the key is gone
 *   from Redis, `PTTL` is -2); two drivers on one prefix sharing data and,
 *   with `l1: true`, the driver's own bus dropping the other's L1 copy; the
 *   driver's bus and a separate `redisBus` on the same prefix hearing each
 *   other; an existing `client` that outlives the cache; and `cluster: true`
 *   throwing.
 *
 * Limits worth knowing, all measured (see the README's "The Redis driver"):
 *
 * - Bytes are only ever read with `getBuffer`; Bun's other replies are
 *   strings, which cannot carry bytes that are not UTF-8. The driver does
 *   that, so a `Uint8Array` round-trips exactly.
 * - Redis Cluster is not supported: Bun's `RedisClient` follows no `MOVED`
 *   redirect (oven-sh/bun#22947), so `cluster: true` throws.
 * - There is no `maxEntries` on Redis. To cap memory, run the server with
 *   `maxmemory` and `maxmemory-policy volatile-lru` (or `volatile-ttl`):
 *   Redis then evicts entries that have an expiry. Tag sets and stamps carry
 *   no Redis TTL on purpose, so those policies never evict them (an eviction
 *   of a tag set would let an invalidation miss entries that live on).
 *   `allkeys-*` policies can evict them, so avoid those. This example does
 *   not change the server's configuration.
 */
import { RedisClient } from "bun";
import process from "node:process";
import type { BusMessage } from "@kingsleyweb/bun-cache";
import { createCache, redisBus, redisDriver } from "@kingsleyweb/bun-cache";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

const url =
  process.env.EXAMPLE_REDIS_URL ?? process.env.BUN_CACHE_TEST_REDIS_URL;

if (!url) {
  console.log(
    "skipped: set EXAMPLE_REDIS_URL (for instance redis://127.0.0.1:6379/13) to run this example",
  );
  process.exit(0);
}

title("the Redis driver: a shared cache in a Redis server");

/** The key prefix of this run: it names this process, so a run owns its keys. */
const prefix = `bun-cache-example:${process.pid}`;

/** A client of our own: checks the server is there, reads the keys, and cleans up. */
const raw = new RedisClient(url);
try {
  await raw.connect();
  await raw.send("PING", []);
} catch (error) {
  raw.close();
  throw new Error("EXAMPLE_REDIS_URL is set but unreachable", {
    cause: error,
  });
}

/** Every key this run created: a `SCAN` of exactly its prefix. */
async function keysOfRun(): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  do {
    const reply = (await raw.send("SCAN", [
      cursor,
      "MATCH",
      `${prefix}:*`,
      "COUNT",
      "1000",
    ])) as [string, string[]];
    cursor = String(reply[0]);
    found.push(...reply[1]);
  } while (cursor !== "0");
  return found;
}

try {
  /* ------------------------------------------------------------------ */
  step("getOrSet, tags, bytes, counters and touch");

  const cache = createCache({
    driver: redisDriver({ url, prefix }),
    namespace: "example",
    ttl: 60_000,
    sweepInterval: 0, // Redis expires entries itself; nothing to sweep here
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

  await cache.invalidateTags(["users"]);
  checkEqual(
    "invalidateTags makes the entry a miss",
    await cache.get("user:42"),
    undefined,
  );
  await cache.getOrSet("user:42", load, { tags: ["users"] });
  checkEqual("it loads again after the invalidation", loads, 2);

  // Every byte value, 0-255: not valid UTF-8, so only a byte-exact read keeps it.
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  await cache.set("bytes", bytes);
  const back = await cache.get("bytes");
  check(
    "a Uint8Array of all 256 byte values round-trips",
    back instanceof Uint8Array && Bun.deepEquals(back, bytes),
    back,
  );

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

  await cache.set("touched", "v", { ttl: 10_000 });
  const touchedKey = (await keysOfRun()).find((key) =>
    key.endsWith(":e:touched"),
  )!;
  const before = Number(await raw.send("PTTL", [touchedKey]));
  await cache.touch("touched", 120_000);
  const after = Number(await raw.send("PTTL", [touchedKey]));
  check(
    "touch moves the key's expiry in Redis",
    before <= 10_000 && after > 100_000,
    { before, after },
  );
  checkEqual("the touched entry is unchanged", await cache.get("touched"), "v");
  await cache.close();

  /* ------------------------------------------------------------------ */
  step("native expiry");

  const expiring = createCache({
    driver: redisDriver({ url, prefix }),
    namespace: "example",
    sweepInterval: 0,
  });
  await expiring.set("short", "gone soon", { ttl: 200 });
  const shortKey = (await keysOfRun()).find((key) => key.endsWith(":e:short"))!;
  check(
    "Redis holds the key with a TTL",
    Number(await raw.send("PTTL", [shortKey])) > 0,
  );
  checkEqual("it reads while fresh", await expiring.get("short"), "gone soon");
  await waitFor("the entry to expire", async () => {
    return (await expiring.get("short")) === undefined;
  });
  checkEqual(
    "it is a miss after its TTL",
    await expiring.get("short"),
    undefined,
  );
  await waitFor("Redis to drop the key", async () => {
    return Number(await raw.send("PTTL", [shortKey])) === -2;
  });
  checkEqual(
    "PTTL is -2: the key is gone from Redis",
    Number(await raw.send("PTTL", [shortKey])),
    -2,
  );
  await expiring.close();

  /* ------------------------------------------------------------------ */
  step("two drivers share data, and the driver's bus drops the other's L1");

  const first = createCache({
    driver: redisDriver({ url, prefix }),
    namespace: "shared",
    l1: true,
    sweepInterval: 0,
  });
  const second = createCache({
    driver: redisDriver({ url, prefix }),
    namespace: "shared",
    l1: true,
    sweepInterval: 0,
  });
  // The L1 arms (flushes once) when its bus is listening.
  for (const side of [first, second]) {
    await waitFor(
      "the bus to listen",
      () => (side.stats().l1?.flushes ?? 0) >= 1,
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

  /* ------------------------------------------------------------------ */
  step("the driver's bus and a separate redisBus hear each other");

  const driver = redisDriver({ url, prefix });
  await driver.connect?.();
  const bus = redisBus({ url, prefix });
  const heardByDriver: BusMessage[] = [];
  const heardByBus: BusMessage[] = [];
  const stopDriver = await driver.subscribe!(
    (message) => heardByDriver.push(message),
    () => undefined,
  );
  const stopBus = await bus.subscribe(
    (message) => heardByBus.push(message),
    () => undefined,
  );
  await bus.publish({
    type: "invalidate-tags",
    namespace: "example",
    tags: ["from-bus"],
    at: Date.now(),
  });
  await driver.publish!({
    type: "invalidate-tags",
    namespace: "example",
    tags: ["from-driver"],
    at: Date.now(),
  });
  await waitFor(
    "both to hear both messages",
    () => heardByDriver.length >= 2 && heardByBus.length >= 2,
    { timeout: 5_000 },
  );
  const tagsOf = (messages: BusMessage[]) =>
    messages.flatMap((message) => message.tags ?? []).sort();
  checkEqual("the driver heard both", tagsOf(heardByDriver), [
    "from-bus",
    "from-driver",
  ]);
  checkEqual("the redisBus heard both", tagsOf(heardByBus), [
    "from-bus",
    "from-driver",
  ]);
  await stopDriver();
  await stopBus();
  await bus.close();
  await driver.close();

  /* ------------------------------------------------------------------ */
  step("an existing client outlives the cache");

  const mine = new RedisClient(url);
  await mine.connect();
  const borrowing = createCache({
    driver: redisDriver({ client: mine, prefix }),
    namespace: "borrowed",
    sweepInterval: 0,
  });
  await borrowing.set("k", "v");
  checkEqual("the cache works on my client", await borrowing.get("k"), "v");
  await borrowing.close();
  checkEqual(
    "my client still answers after close",
    await mine.send("PING", []),
    "PONG",
  );
  mine.close();

  /* ------------------------------------------------------------------ */
  step("Redis Cluster is refused");

  // Bun's RedisClient follows no MOVED redirect (oven-sh/bun#22947).
  await checkRejects(
    "cluster: true throws, naming the Bun issue",
    () => redisDriver({ url, prefix, cluster: true }),
    { name: "TypeError", message: /22947/ },
  );
} finally {
  // Delete exactly the keys this run's prefix names — never FLUSHDB.
  const mine = await keysOfRun();
  for (let index = 0; index < mine.length; index += 500) {
    await raw.send("UNLINK", mine.slice(index, index + 500));
  }
  const left = await keysOfRun();
  show("deleted this run's keys", { deleted: mine.length, left: left.length });
  raw.close();
}

summary();
