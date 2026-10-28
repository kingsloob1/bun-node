/**
 * The SQL drivers — a durable cache in Postgres, MySQL or MariaDB, shared by
 * every process and host that can reach the database (PR-C4).
 *
 * ```bash
 * EXAMPLE_POSTGRES_URL=postgres://user:pass@localhost:5432/app bun 04-drivers/sql.ts
 * EXAMPLE_MYSQL_URL=mysql://user:pass@localhost:3307/app?allowPublicKeyRetrieval=true \
 *   EXAMPLE_MARIADB_URL=mariadb://user:pass@localhost:3306/app bun 04-drivers/sql.ts
 * ```
 *
 * - It runs on each engine whose URL variable is set and says which it
 *   skipped; with none set it prints `skipped:` and exits 0. A URL that is set
 *   but unreachable fails, naming the engine.
 * - Every engine gets tables of its own under a prefix naming this process
 *   (`bun_cache_example_<pid>_<engine>_`), and the example drops exactly
 *   those tables at the end, even when a check failed. Nothing else in the
 *   database is read or written.
 * - Per engine it shows `getOrSet`, tag invalidation and a counter below
 *   zero; two driver instances sharing data and the bus; exact keys;
 *   `maxEntries` evicting nearest-to-expiry first; and an existing `sql`
 *   client that outlives the cache. On MySQL and MariaDB it also connects
 *   with `?allowPublicKeyRetrieval=true` in the URL, and on Postgres it
 *   creates `UNLOGGED` tables.
 */
import { SQL } from "bun";
import process from "node:process";
import type { BusMessage, CacheDriver } from "@kingsleyweb/bun-cache";
import {
  createCache,
  mariadbDriver,
  mysqlDriver,
  postgresDriver,
} from "@kingsleyweb/bun-cache";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

/** The engines, the variable holding each one's URL, and its driver. */
const ENGINES = [
  {
    name: "postgres",
    variable: "EXAMPLE_POSTGRES_URL",
    make: (options: DriverOptions): CacheDriver => postgresDriver(options),
  },
  {
    name: "mysql",
    variable: "EXAMPLE_MYSQL_URL",
    make: (options: DriverOptions): CacheDriver => mysqlDriver(options),
  },
  {
    name: "mariadb",
    variable: "EXAMPLE_MARIADB_URL",
    make: (options: DriverOptions): CacheDriver => mariadbDriver(options),
  },
] as const;

/** What the example passes to a driver (the options all three share, plus `unlogged`). */
interface DriverOptions {
  /** The connection URL. */
  url?: string;
  /** An existing client, which the driver never closes. */
  sql?: SQL;
  /** The table prefix. */
  prefix: string;
  /** The cap on entries, enforced by `sweep`. */
  maxEntries?: number;
  /** How often the MySQL and MariaDB bus is polled, in ms. */
  busPollInterval?: number;
  /** Postgres only: create the tables `UNLOGGED`. */
  unlogged?: boolean;
}

/** The tables a prefix names; `bus` exists on MySQL and MariaDB only. */
const TABLES = ["entries", "tags", "stamps", "locks", "bus"];

/** The engines whose URL is set, and the ones skipped. */
const selected = ENGINES.filter((engine) => process.env[engine.variable]);
const skippedEngines = ENGINES.filter(
  (engine) => !process.env[engine.variable],
);

if (selected.length === 0) {
  console.log(
    "skipped: set EXAMPLE_POSTGRES_URL, EXAMPLE_MYSQL_URL or EXAMPLE_MARIADB_URL to run this example",
  );
  process.exit(0);
}

title("the SQL drivers: a durable cache in a database server");
if (skippedEngines.length > 0) {
  show(
    "skipped engines",
    skippedEngines.map(
      (engine) => `${engine.name} (${engine.variable} is unset)`,
    ),
  );
}

/** Runs a query on `client` and answers its rows, typed. */
async function rowsOf(
  client: SQL,
  query: string,
): Promise<Record<string, unknown>[]> {
  return client.unsafe<Record<string, unknown>[]>(query);
}

/** A client of our own on `url`, the way the drivers build theirs. */
function openClient(url: string): SQL {
  // Bun honours `allowPublicKeyRetrieval` as an option and ignores it in a URL,
  // so it is moved out of the URL here (the drivers do the same for theirs).
  const parsed = new URL(url);
  const wanted = parsed.searchParams.get("allowPublicKeyRetrieval") === "true";
  parsed.searchParams.delete("allowPublicKeyRetrieval");
  return wanted
    ? new SQL({ url: parsed.toString(), allowPublicKeyRetrieval: true })
    : new SQL(parsed.toString());
}

for (const engine of selected) {
  const url = process.env[engine.variable]!;
  const prefix = `bun_cache_example_${process.pid}_${engine.name}_`;
  const unloggedPrefix = `${prefix}u_`;
  const capPrefix = `${prefix}c_`;
  const prefixes = [prefix, unloggedPrefix, capPrefix];

  /** Builds a driver on this engine's URL; the options override the defaults. */
  const driver = (options: Partial<DriverOptions> = {}): CacheDriver =>
    engine.make({ url, prefix, ...options });

  // A client of our own: it checks the server is there (a failure names the
  // engine), and later it reads the tables and drops them.
  const raw = openClient(url);
  try {
    await raw`SELECT 1`;
  } catch (error) {
    await raw.close();
    throw new Error(`${engine.variable} is set but unreachable`, {
      cause: error,
    });
  }

  try {
    title(engine.name);

    /* ------------------------------------------------------------------ */
    step(`${engine.name}: getOrSet, tags and counters`);

    const events: string[] = [];
    const cache = createCache({
      driver: driver(),
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

    await cache.invalidateTags(["users"]);
    checkEqual(
      "invalidateTags makes the entry a miss",
      await cache.get("user:42"),
      undefined,
    );
    // Index mode: the tagged row was deleted, not just stamped.
    const rows = await rowsOf(raw, `SELECT k FROM ${prefix}entries`);
    checkEqual("the entry row is gone from the table", rows.length, 0);
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

    /* ------------------------------------------------------------------ */
    step(`${engine.name}: keys are exact`);

    await cache.set("a", "lower");
    await cache.set("A", "upper");
    checkEqual("a is one entry", await cache.get("a"), "lower");
    checkEqual("A is another", await cache.get("A"), "upper");
    await cache.close();

    /* ------------------------------------------------------------------ */
    step(`${engine.name}: two driver instances share data and the bus`);

    const first = createCache({
      driver: driver(),
      namespace: "example",
      sweepInterval: 0,
    });
    const second = createCache({
      driver: driver(),
      namespace: "example",
      sweepInterval: 0,
    });
    await first.set("shared", "written by the first", { ttl: 60_000 });
    checkEqual(
      "the second sees the first's write",
      await second.get("shared"),
      "written by the first",
    );

    const publisher = driver({ busPollInterval: 25 });
    const listener = driver({ busPollInterval: 25 });
    await publisher.connect?.();
    await listener.connect?.();
    const received: BusMessage[] = [];
    const unsubscribe = await listener.subscribe!(
      (message) => received.push(message),
      () => undefined,
    );
    await publisher.publish!({
      type: "invalidate-tags",
      namespace: "example",
      tags: ["users"],
      at: Date.now(),
    });
    await waitFor(
      "the listener to receive the message",
      () => received.length > 0,
      {
        timeout: 5_000,
      },
    );
    checkEqual("the listener received it", received[0]?.tags, ["users"]);
    await unsubscribe();
    await publisher.close();
    await listener.close();
    await first.close();
    await second.close();

    /* ------------------------------------------------------------------ */
    step(`${engine.name}: maxEntries evicts nearest to expiry first`);

    // Its own tables: the cap counts every namespace under a prefix, so a
    // prefix of its own keeps the count to the five entries written here.
    const capDriver = driver({ prefix: capPrefix, maxEntries: 3 });
    const capped = createCache({
      driver: capDriver,
      namespace: "cap",
      sweepInterval: 0,
    });
    capped.on("evict", (event) => events.push(`${event.key}:${event.reason}`));
    // The longest-lived entry is written first, so "oldest write first" and
    // "nearest to expiry first" would pick different victims.
    await capped.set("c-50s", 1, { ttl: 50_000 });
    await capped.set("c-40s", 2, { ttl: 40_000 });
    await capped.set("c-30s", 3, { ttl: 30_000 });
    await capped.set("c-20s", 4, { ttl: 20_000 });
    await capped.set("c-10s", 5, { ttl: 10_000 });
    const counted = await rowsOf(raw, `SELECT k FROM ${capPrefix}entries`);
    checkEqual("five entries before the sweep", counted.length, 5);
    await capDriver.sweep!(Date.now(), 1_000);
    const remaining = await rowsOf(raw, `SELECT k FROM ${capPrefix}entries`);
    checkEqual("the sweep left exactly 3 entries", remaining.length, 3);
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
    step(`${engine.name}: an existing sql client outlives the cache`);

    const mine = openClient(url);
    const borrowing = createCache({
      driver: driver({ sql: mine }),
      namespace: "borrowed",
      sweepInterval: 0,
    });
    await borrowing.set("k", "v");
    checkEqual("the cache works on my client", await borrowing.get("k"), "v");
    await borrowing.close();
    const after = await rowsOf(mine, "SELECT 1 AS one");
    checkEqual("my client still answers after close", Number(after[0]?.one), 1);
    await mine.close();

    /* ------------------------------------------------------------------ */
    if (engine.name === "postgres") {
      step("postgres: unlogged tables");

      const unlogged = createCache({
        driver: driver({ prefix: unloggedPrefix, unlogged: true }),
        namespace: "example",
        sweepInterval: 0,
      });
      await unlogged.set("k", "v");
      checkEqual("it works as usual", await unlogged.get("k"), "v");
      const kinds = await rowsOf(
        raw,
        `SELECT relname, relpersistence FROM pg_class WHERE relname = '${unloggedPrefix}entries' OR relname = '${prefix}entries' ORDER BY relname`,
      );
      show(
        "relpersistence (u = unlogged, p = permanent)",
        kinds.map(
          (row) => `${String(row.relname)}: ${String(row.relpersistence)}`,
        ),
      );
      // Unlogged: faster writes, emptied after a crash, and not replicated to a
      // standby, so a failover starts cold.
      checkEqual(
        "the unlogged prefix's table is UNLOGGED",
        kinds.find((row) => row.relname === `${unloggedPrefix}entries`)
          ?.relpersistence,
        "u",
      );
      checkEqual(
        "the default prefix's table is permanent",
        kinds.find((row) => row.relname === `${prefix}entries`)?.relpersistence,
        "p",
      );
      await unlogged.close();
    } else {
      step(`${engine.name}: ?allowPublicKeyRetrieval=true in the URL`);

      // Bun ignores the parameter in a URL; the driver moves it into the
      // client option, so a URL carrying it connects.
      const withParam = new URL(url);
      withParam.searchParams.set("allowPublicKeyRetrieval", "true");
      const viaUrl = createCache({
        driver: engine.make({ url: withParam.toString(), prefix }),
        namespace: "example",
        sweepInterval: 0,
      });
      await viaUrl.set("k", "v");
      checkEqual("it connects and works", await viaUrl.get("k"), "v");
      await viaUrl.close();
    }
  } finally {
    // Drop exactly the tables this run's prefixes name — never a pattern.
    for (const used of prefixes) {
      for (const table of TABLES) {
        await raw.unsafe(`DROP TABLE IF EXISTS ${used}${table}`);
      }
    }
    await raw.close();
    show(
      "dropped this run's tables",
      prefixes.map((used) => `${used}*`),
    );
  }
}

summary();
