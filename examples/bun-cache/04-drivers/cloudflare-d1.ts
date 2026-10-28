/**
 * The Cloudflare D1 driver — a cache in a D1 database (SQLite on Cloudflare),
 * reached over HTTP through the bun-cache Worker (PR-C11).
 *
 * ```bash
 * bun 04-drivers/cloudflare-d1.ts
 * ```
 *
 * - No Cloudflare account is needed. The example starts the Worker the package
 *   ships (`@kingsleyweb/bun-cache/cloudflare-worker`) in workerd through
 *   miniflare (`../shared/cloudflare-local.ts`), on a port the OS picks, with
 *   an in-memory D1 database bound as `CACHE_DB`, and points the driver at it
 *   with `endpoint`. That is what you do with a deployed Worker, with its
 *   `https://bun-cache.<you>.workers.dev` URL and its
 *   `BUN_CACHE_PROXY_TOKEN` secret. With miniflare not installed, the example
 *   prints `skipped:` and exits 0. It never touches the network.
 * - With an `endpoint`, `databaseId` is the **binding's name** in the Worker's
 *   `wrangler.toml`; with the REST API (`accountId` + `apiToken`, no
 *   `endpoint`) it is the database's id.
 * - Unlike KV, D1 has counters and locks, and tags are *index* mode:
 *   `invalidateTags` deletes the tagged rows at once (a trigger does it, in
 *   the statement that writes the stamp), and the same stamp fences a
 *   `getOrSet` whose loader was running when the tag was invalidated
 *   elsewhere. Every write is one statement, because D1 refuses `BEGIN`.
 * - An entry holds at most 1,000,000 bytes (values travel as hex, and D1 caps
 *   a string at 2,000,000): a larger one is skipped with an `oversize` event,
 *   or throws `EntryTooLargeError` under `strict`.
 * - There is no bus (`bus: "none"`): a cache with an L1 in front of D1 would
 *   need `redisBus` or `pgBus`.
 * - Tables are named by `prefix` (here one that names this process); they are
 *   created on first use, and this example drops exactly the ones it created
 *   (four tables under the prefix, four under the `maxEntries` part's) at the
 *   end. The Worker and its database are discarded when it ends.
 */
import process from "node:process";
import {
  cloudflareD1Driver,
  createCache,
  EntryTooLargeError,
} from "@kingsleyweb/bun-cache";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { D1_BINDING, startLocalWorker } from "../shared/cloudflare-local";
import { show, step, title } from "../shared/console";

title("the Cloudflare D1 driver: a cache in a D1 database, over HTTP");

const worker = await startLocalWorker();

if (!worker) {
  process.exit(0);
}

/** The table prefix of this run: it names this process, so a run owns its tables. */
const prefix = `example_${process.pid}_`;

/** The four tables the driver creates under the prefix (no bus table). */
const TABLES = ["entries", "tags", "stamps", "locks"].map(
  (name) => `${prefix}${name}`,
);

/** Runs one SQL statement through the Worker's D1 path, as the driver's own client does. */
async function sql(statement: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(
    `${worker!.endpoint}/d1/database/${D1_BINDING}/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${worker!.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql: statement }),
    },
  );
  const body = (await response.json()) as {
    result: { results: Record<string, unknown>[] }[];
  };
  return body.result[0].results;
}

/** Counts the rows of one of the driver's tables. */
async function countRows(table: string): Promise<number> {
  const rows = await sql(`SELECT count(*) AS n FROM ${prefix}${table}`);
  return Number(rows[0].n);
}

/** Opens a driver on the local Worker; `extra` adds the options a part needs. */
function openDriver(extra: { maxEntries?: number } = {}) {
  return cloudflareD1Driver({
    endpoint: worker!.endpoint,
    apiToken: worker!.token,
    databaseId: D1_BINDING,
    prefix,
    ...extra,
  });
}

try {
  show("the local Worker", worker.endpoint);

  const driver = openDriver();
  const cache = createCache({
    driver,
    namespace: "example",
    ttl: 300_000,
    sweepInterval: 0, // sweeps are driven by hand below
  });

  /* ---------------------------------------------------------------- */
  step("set and get, with the capabilities D1 advertises");

  show("capabilities", {
    ttl: driver.capabilities.ttl,
    tags: driver.capabilities.tags,
    fence: driver.capabilities.fence,
    atomicIncrement: driver.capabilities.atomicIncrement,
    lock: driver.capabilities.lock,
    bus: driver.capabilities.bus,
    maxEntryBytes: driver.capabilities.maxEntryBytes,
  });
  checkEqual("tags are an index", driver.capabilities.tags, "index");
  checkEqual("the fence is atomic", driver.capabilities.fence, "atomic");
  checkEqual("counters are atomic", driver.capabilities.atomicIncrement, true);
  checkEqual("no bus", driver.capabilities.bus, "none");
  checkEqual(
    "entries up to 1,000,000 bytes",
    driver.capabilities.maxEntryBytes,
    1_000_000,
  );

  await cache.set("user:42", { name: "Ada" });
  checkEqual("a value reads back", await cache.get("user:42"), { name: "Ada" });
  checkEqual("a missing key is a miss", await cache.get("user:0"), undefined);
  checkEqual(
    "tables were created under the prefix",
    (
      await sql(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '${prefix}%' ORDER BY name`,
      )
    ).map((row) => row.name),
    [...TABLES].sort(),
  );

  /* ---------------------------------------------------------------- */
  step("counters: one atomic statement each");

  checkEqual("the first increment", await cache.increment("visits"), 1);
  checkEqual("by 5", await cache.increment("visits", 5), 6);
  checkEqual("below zero", await cache.increment("balance", -3), -3);
  const visits = await cache.get("visits");
  checkEqual("a counter reads as a number", visits, 6);
  const concurrent = await Promise.all(
    Array.from({ length: 20 }, async () => cache.increment("burst")),
  );
  checkEqual(
    "20 concurrent increments lose none",
    [...concurrent].sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );

  /* ---------------------------------------------------------------- */
  step("tags delete eagerly (index mode)");

  await cache.set("post:1", "first", { tags: ["posts"] });
  await cache.set("post:2", "second", { tags: ["posts"] });
  await cache.set("page:home", "home", { tags: ["pages"] });
  const entriesBefore = await countRows("entries");
  const tagRowsBefore = await countRows("tags");
  show("rows before", { entries: entriesBefore, tagRows: tagRowsBefore });
  checkEqual("a tag row per tagged entry", tagRowsBefore, 3);
  await cache.invalidateTags(["posts"]);
  // Stamps mode (the KV driver) would leave the rows for the expiry to
  // reclaim. Here the trigger on the stamp deleted them in the same statement.
  checkEqual(
    "two entry rows are gone",
    await countRows("entries"),
    entriesBefore - 2,
  );
  checkEqual("and their tag rows", await countRows("tags"), 1);
  checkEqual("the tag was stamped", await countRows("stamps"), 1);
  checkEqual("it reads as a miss", await cache.get("post:1"), undefined);
  checkEqual("another tag's entry stays", await cache.get("page:home"), "home");

  /* ---------------------------------------------------------------- */
  step("the fence: invalidating a tag while a loader runs");

  // An invalidation from the *same* cache forgets its own flight in memory
  // and drops the write silently. The driver's fence catches an invalidation
  // made elsewhere (another process, or here another cache on the same
  // database) and that is what emits `fenced`.
  const elsewhere = createCache({
    driver: openDriver(),
    namespace: "example",
    sweepInterval: 0,
  });
  const fenced: unknown[] = [];
  cache.on("fenced", (event) => fenced.push(event));
  const loading = cache.getOrSet(
    "slow",
    async () => {
      await Bun.sleep(150);
      return "computed before the invalidation";
    },
    { tags: ["slow-tag"] },
  );
  await Bun.sleep(40); // the loader is running
  await elsewhere.invalidateTags(["slow-tag"]);
  checkEqual(
    "the caller still gets its value",
    await loading,
    "computed before the invalidation",
  );
  checkEqual("a fenced event was emitted", fenced.length, 1);
  checkEqual("the value was not stored", await cache.get("slow"), undefined);

  /* ---------------------------------------------------------------- */
  step("a cross-cache lock runs the loader once");

  let loads = 0;
  const loader = async () => {
    loads++;
    await Bun.sleep(300); // slow enough that the other cache arrives meanwhile
    return "built";
  };
  const lock = { wait: { interval: 20, timeout: 10_000 } };
  const results = await Promise.all([
    cache.getOrSet("report", loader, { lock }),
    elsewhere.getOrSet("report", loader, { lock }),
  ]);
  checkEqual("both callers got the value", results, ["built", "built"]);
  checkEqual("the loader ran exactly once across both", loads, 1);
  await elsewhere.close();

  /* ---------------------------------------------------------------- */
  step("the 1,000,000-byte cap");

  const big = "x".repeat(900_000);
  checkEqual("a large value is stored", await cache.set("big", big), true);
  checkEqual("and reads back whole", (await cache.get("big")) === big, true);

  const tooBig = "x".repeat(1_000_001);
  const oversize: { bytes: number; limit: number }[] = [];
  cache.on("oversize", (event) => oversize.push(event));
  checkEqual(
    "a larger value is skipped",
    await cache.set("huge", tooBig),
    false,
  );
  checkEqual("an oversize event said why", oversize.length, 1);
  check(
    "its limit is the driver's",
    oversize[0]?.limit === 1_000_000,
    oversize[0],
  );
  checkEqual("nothing was stored", await cache.get("huge"), undefined);

  const strict = createCache({
    driver: openDriver(),
    namespace: "example",
    sweepInterval: 0,
    strict: true,
  });
  await checkRejects(
    "under strict it throws",
    () => strict.set("huge", tooBig),
    {
      name: EntryTooLargeError.name,
    },
  );
  await strict.close();

  /* ---------------------------------------------------------------- */
  step("maxEntries evicts nearest to expiry first, on a sweep");

  // The cap counts every entry under the prefix, so it gets tables of its own.
  const capPrefix = `${prefix}cap_`;
  const capDriver = cloudflareD1Driver({
    endpoint: worker.endpoint,
    apiToken: worker.token,
    databaseId: D1_BINDING,
    prefix: capPrefix,
    maxEntries: 2,
  });
  const capped = createCache({
    driver: capDriver,
    namespace: "cap",
    sweepInterval: 0,
  });
  const evicted: unknown[] = [];
  capped.on("evict", (event) => evicted.push(event));
  await capped.set("soonest", 1, { ttl: 100_000 });
  await capped.set("middle", 2, { ttl: 200_000 });
  await capped.set("latest", 3, { ttl: 300_000 });
  await capped.increment("a-counter"); // counters are never evicted, nor counted
  const capRows = async () =>
    Number((await sql(`SELECT count(*) AS n FROM ${capPrefix}entries`))[0].n);
  checkEqual(
    "four rows before the sweep (three entries, a counter)",
    await capRows(),
    4,
  );
  const swept = await capDriver.sweep!(Date.now(), 1_000);
  // The answer counts expired rows removed; the cap's eviction is not in it.
  show("sweep answered", swept);
  checkEqual("one row fewer after it", await capRows(), 3);
  checkEqual(
    "the entry nearest to expiry went",
    await capped.get("soonest"),
    undefined,
  );
  checkEqual("one evict event", evicted.length, 1);
  checkEqual("the middle one stayed", await capped.get("middle"), 2);
  checkEqual("the latest stayed", await capped.get("latest"), 3);
  checkEqual("the counter stayed", await capped.get("a-counter"), 1);
  await capped.close();

  /* ---------------------------------------------------------------- */
  step("an expired entry is a miss at once; the sweep reclaims it");

  await cache.set("short", "gone soon", { ttl: 200 });
  checkEqual("it reads while fresh", await cache.get("short"), "gone soon");
  await Bun.sleep(260);
  checkEqual("it is a miss after its TTL", await cache.get("short"), undefined);
  const rowsBefore = await countRows("entries");
  await driver.sweep!(Date.now(), 1_000);
  checkEqual(
    "the sweep removed that row",
    await countRows("entries"),
    rowsBefore - 1,
  );

  await cache.close();
} finally {
  // Drop exactly the tables this run created.
  for (const name of ["entries", "tags", "stamps", "locks"]) {
    for (const base of [prefix, `${prefix}cap_`]) {
      await sql(`DROP TABLE IF EXISTS ${base}${name}`);
    }
  }
  await worker.stop();
}

summary();
