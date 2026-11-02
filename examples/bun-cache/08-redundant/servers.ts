/**
 * Redundant drivers over two servers — `redundant([redisDriver(...),
 * postgresDriver(...)])`: a Redis primary and a Postgres secondary, so the
 * cache survives losing either (the members of a combinator can differ in
 * type).
 *
 * ```bash
 * EXAMPLE_REDIS_URL=redis://127.0.0.1:6379/13 \
 *   EXAMPLE_POSTGRES_URL=postgres://user:pass@localhost:5432/app \
 *   bun 08-redundant/servers.ts
 * ```
 *
 * - It runs when both `EXAMPLE_REDIS_URL` and `EXAMPLE_POSTGRES_URL` (or the
 *   `BUN_CACHE_TEST_*` names) are set and otherwise prints `skipped:` and
 *   exits 0. A URL that is set but unreachable fails.
 * - Redis keys live under `bun-cache-example:redundant-<pid>`; Postgres
 *   tables under `bun_cache_example_redundant_<pid>_`. The example deletes
 *   exactly the keys that prefix names (a `SCAN`, never `FLUSHDB`) and drops
 *   exactly those tables, at the end, even when a check failed.
 * - It shows a write reaching both servers, a tag invalidation reaching both,
 *   counters on the Redis member only, and a read served by Postgres while
 *   Redis is "down" (the Redis driver wrapped in the kit's `faulty()`).
 *
 * Nothing here asserts on a duration.
 */
import { RedisClient, SQL } from "bun";
import process from "node:process";
import type { CacheDriver } from "@kingsleyweb/bun-cache";
import {
  createCache,
  postgresDriver,
  redisDriver,
  redundant,
} from "@kingsleyweb/bun-cache";
import { faulty } from "@kingsleyweb/bun-cache/testing";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

const redisUrl =
  process.env.EXAMPLE_REDIS_URL ?? process.env.BUN_CACHE_TEST_REDIS_URL;
const postgresUrl =
  process.env.EXAMPLE_POSTGRES_URL ?? process.env.BUN_CACHE_TEST_POSTGRES_URL;

if (!redisUrl || !postgresUrl) {
  console.log(
    `skipped: set EXAMPLE_REDIS_URL and EXAMPLE_POSTGRES_URL to run this example (${
      redisUrl ? "" : "EXAMPLE_REDIS_URL is unset"
    }${!redisUrl && !postgresUrl ? ", " : ""}${
      postgresUrl ? "" : "EXAMPLE_POSTGRES_URL is unset"
    })`,
  );
  process.exit(0);
}

title("redundant drivers: a Redis member and a Postgres member");

/** The Redis key prefix of this run: it names this process, so a run owns its keys. */
const redisPrefix = `bun-cache-example:redundant-${process.pid}`;
/** The Postgres table prefix of this run. */
const tablePrefix = `bun_cache_example_redundant_${process.pid}_`;
/** The tables a Postgres prefix names. */
const TABLES = ["entries", "tags", "stamps", "locks", "bus"];

/** A client of our own on Redis: checks the server is there, and cleans up. */
const rawRedis = new RedisClient(redisUrl);
/** A client of our own on Postgres: checks the server is there, and cleans up. */
const rawPg = new SQL(postgresUrl);

try {
  await rawRedis.connect();
  await rawRedis.send("PING", []);
} catch (error) {
  rawRedis.close();
  await rawPg.close();
  throw new Error("EXAMPLE_REDIS_URL is set but unreachable", { cause: error });
}
try {
  await rawPg`SELECT 1`;
} catch (error) {
  rawRedis.close();
  await rawPg.close();
  throw new Error("EXAMPLE_POSTGRES_URL is set but unreachable", {
    cause: error,
  });
}

/** Every Redis key this run created: a `SCAN` of exactly its prefix. */
async function redisKeysOfRun(): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  do {
    const reply = (await rawRedis.send("SCAN", [
      cursor,
      "MATCH",
      `${redisPrefix}:*`,
      "COUNT",
      "1000",
    ])) as [string, string[]];
    cursor = String(reply[0]);
    found.push(...reply[1]);
  } while (cursor !== "0");
  return found;
}

/** How many rows this run's Postgres entries table holds. */
async function postgresEntries(): Promise<number> {
  const rows = await rawPg.unsafe<{ n: string }[]>(
    `SELECT count(*) AS n FROM ${tablePrefix}entries`,
  );
  return Number(rows[0]?.n ?? 0);
}

try {
  const redis = redisDriver({ url: redisUrl, prefix: redisPrefix });
  const postgres = postgresDriver({ url: postgresUrl, prefix: tablePrefix });
  const cache = createCache({
    driver: redundant([redis, postgres], { ack: "all" }),
    namespace: "example",
    ttl: 60_000,
    sweepInterval: 0,
    bus: false,
  });

  /** What a member holds for `key`, as `cache` names it. */
  async function heldBy(member: CacheDriver, key: string) {
    const { namespace, key: stored } = cache.describeKey(key);
    return await member.get(namespace, stored);
  }

  /* ------------------------------------------------------------------ */
  step("a write reaches both servers");

  await cache.set("user:42", { name: "Ada" }, { tags: ["users"] });
  check("Redis holds it", (await heldBy(redis, "user:42")) !== undefined);
  check("Postgres holds it", (await heldBy(postgres, "user:42")) !== undefined);
  checkEqual("a row in Postgres' entries table", await postgresEntries(), 1);
  check(
    "keys under this run's Redis prefix",
    (await redisKeysOfRun()).length > 0,
  );
  checkEqual("it reads back", await cache.get("user:42"), { name: "Ada" });

  /* ------------------------------------------------------------------ */
  step("a tag invalidation reaches both");

  await cache.invalidateTags(["users"]);
  checkEqual("it is a miss", await cache.get("user:42"), undefined);
  checkEqual("gone from Redis", await heldBy(redis, "user:42"), undefined);
  checkEqual(
    "gone from Postgres",
    await heldBy(postgres, "user:42"),
    undefined,
  );

  /* ------------------------------------------------------------------ */
  step("counters live on the Redis member only");

  checkEqual("a counter counts", await cache.increment("hits", 3), 3);
  const { namespace, key } = cache.describeKey("hits");
  checkEqual(
    "Redis holds the count",
    (await redis.getCounter!(namespace, key))?.value,
    3,
  );
  checkEqual(
    "Postgres holds none",
    await postgres.getCounter!(namespace, key),
    undefined,
  );
  // Closing the cache closes its members: the next part builds its own.
  await cache.close();

  /* ------------------------------------------------------------------ */
  step("Redis down: Postgres serves the read");

  const flaky = faulty(redisDriver({ url: redisUrl, prefix: redisPrefix }));
  const survivor = createCache({
    driver: redundant(
      [flaky, postgresDriver({ url: postgresUrl, prefix: tablePrefix })],
      {
        ack: "all",
        timeout: 1_000,
        circuit: { failures: 1, cooldown: 60_000 },
      },
    ),
    namespace: "example",
    ttl: 60_000,
    sweepInterval: 0,
    bus: false,
  });
  const down: unknown[] = [];
  survivor.on("member-down", (payload) => down.push(payload));
  await survivor.set("report", { total: 42 });
  flaky.setFaults({ down: true });
  checkEqual(
    "the read is served by the Postgres member",
    await survivor.get("report"),
    { total: 42 },
  );
  await waitFor("member-down", () => down.length > 0);
  show("member-down", down[0]);
  checkEqual(
    "member-down names the Redis member",
    (down[0] as { index: number }).index,
    0,
  );
  await survivor.close();
} finally {
  // Delete exactly what this run's prefixes name — never FLUSHDB, no LIKE sweep.
  const mine = await redisKeysOfRun();
  for (let index = 0; index < mine.length; index += 500) {
    await rawRedis.send("UNLINK", mine.slice(index, index + 500));
  }
  for (const table of TABLES) {
    await rawPg.unsafe(`DROP TABLE IF EXISTS ${tablePrefix}${table}`);
  }
  show("deleted this run's keys and tables", {
    keys: mine.length,
    keysLeft: (await redisKeysOfRun()).length,
    tables: TABLES.map((table) => `${tablePrefix}${table}`),
  });
  rawRedis.close();
  await rawPg.close();
}

summary();
