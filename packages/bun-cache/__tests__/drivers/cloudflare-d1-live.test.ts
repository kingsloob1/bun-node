/**
 * The Cloudflare D1 driver against Cloudflare itself — the **opt-in live
 * lane**, beside the KV one. Two transports, each run only when its variables
 * are set (never in a committed file: they are credentials), and otherwise
 * skipped visibly:
 *
 * - **The REST API**: `BUN_CACHE_TEST_CLOUDFLARE_ACCOUNT_ID`,
 *   `BUN_CACHE_TEST_CLOUDFLARE_API_TOKEN` (an API token with *D1: Edit*) and
 *   `BUN_CACHE_TEST_CLOUDFLARE_D1_DATABASE_ID` (a database made for tests).
 * - **A deployed bun-cache Worker**: `BUN_CACHE_TEST_CLOUDFLARE_PROXY_URL`
 *   and `BUN_CACHE_TEST_CLOUDFLARE_PROXY_TOKEN` (its `BUN_CACHE_PROXY_TOKEN`
 *   secret), with the database bound as `CACHE_DB` (the README's
 *   `wrangler.toml`).
 *
 * Some but not all of a lane's variables set fails, naming the missing ones;
 * a set lane that cannot be reached fails, naming the variable. Each lane runs
 * the conformance kit (with its two-process pass) and what the local Worker
 * cannot show: the race against Cloudflare's own D1, the 1,000,000-byte entry
 * under its documented 2,000,000-byte string limit, and whether the transport
 * runs a batch as one transaction (reported, not asserted: the driver does
 * not rely on it). Every table is this run's (`bct<pid>_<time>_…`), and the
 * end of the file drops exactly those.
 *
 * **Costs and limits.** The REST API allows 1,200 requests per five minutes
 * per token (the client paces under it); D1 bills rows read and written, and
 * the free plan allows 5 million rows read and 100,000 written a day.
 */
import process from "node:process";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { CloudflareD1DriverOptions } from "../../lib/drivers/cloudflare-d1";
import {
  CloudflareD1CacheDriver,
  D1_MAX_ENTRY_BYTES,
} from "../../lib/drivers/cloudflare-d1";
import { runCacheDriverConformance } from "../../lib/testing/index";
import { reportNotConfigured, reportUnreachable } from "./sqlSuite";

/** The variables' common prefix. */
const VAR = "BUN_CACHE_TEST_CLOUDFLARE";

/** The binding name the README's `wrangler.toml` gives the database. */
const WORKER_D1_BINDING = "CACHE_DB";

/** This run's table-name prefix (an SQL identifier). */
const RUN = `bct${process.pid}_${Date.now()}_`;

/** A lane: its name, its variables, and the driver options they give. */
interface Lane {
  /** Shown in the titles. */
  name: string;
  /** The variables, by name, and their values. */
  vars: Record<string, string | undefined>;
  /** The driver's options, with `prefix` left to the lane. */
  options: () => Omit<CloudflareD1DriverOptions, "prefix">;
}

const lanes: Lane[] = [
  {
    name: "cloudflare-d1, REST API",
    vars: {
      [`${VAR}_ACCOUNT_ID`]: process.env[`${VAR}_ACCOUNT_ID`] || undefined,
      [`${VAR}_API_TOKEN`]: process.env[`${VAR}_API_TOKEN`] || undefined,
      [`${VAR}_D1_DATABASE_ID`]:
        process.env[`${VAR}_D1_DATABASE_ID`] || undefined,
    },
    options: () => ({
      accountId: process.env[`${VAR}_ACCOUNT_ID`],
      apiToken: process.env[`${VAR}_API_TOKEN`],
      databaseId: process.env[`${VAR}_D1_DATABASE_ID`] ?? "",
    }),
  },
  {
    name: "cloudflare-d1, Worker",
    vars: {
      [`${VAR}_PROXY_URL`]: process.env[`${VAR}_PROXY_URL`] || undefined,
      [`${VAR}_PROXY_TOKEN`]: process.env[`${VAR}_PROXY_TOKEN`] || undefined,
    },
    options: () => ({
      endpoint: process.env[`${VAR}_PROXY_URL`],
      apiToken: process.env[`${VAR}_PROXY_TOKEN`],
      databaseId: WORKER_D1_BINDING,
    }),
  },
];

/** The drivers the lanes made, so the end of the file drops their tables. */
const made: CloudflareD1CacheDriver[] = [];

/** Each driver's database id, remembered when it was made. */
const databases = new WeakMap<CloudflareD1CacheDriver, string>();

/** Tables this run made outside a driver (the batch probe's). */
const extraTables: { driver: CloudflareD1CacheDriver; table: string }[] = [];

// The clean-up drops tables over the network: more than bun's 5 s hook default.
afterAll(async () => {
  const dropped = new Set<string>();
  for (const driver of made) {
    const database = databases.get(driver) ?? "";
    const names = Object.entries(driver.tables)
      .filter(([table]) => table !== "bus")
      .map(([, name]) => name)
      .filter((name) => name.startsWith(RUN) && !dropped.has(name));
    for (const name of names) {
      dropped.add(name);
    }
    if (names.length > 0) {
      await driver.client
        .d1Query(
          database,
          names.map((name) => ({ sql: `DROP TABLE IF EXISTS "${name}"` })),
        )
        .catch(() => undefined);
    }
  }
  for (const { driver, table } of extraTables) {
    await driver.client
      .d1Query(databases.get(driver) ?? "", [
        { sql: `DROP TABLE IF EXISTS "${table}"` },
      ])
      .catch(() => undefined);
  }
}, 120_000);

setDefaultTimeout(120_000);

for (const [index, lane] of lanes.entries()) {
  const missing = Object.entries(lane.vars)
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  const names = Object.keys(lane.vars).join(", ");
  if (missing.length === Object.keys(lane.vars).length) {
    reportNotConfigured(
      lane.name,
      names,
      "a Cloudflare account's credentials; opt-in, never committed",
    );
    continue;
  }
  if (missing.length > 0) {
    describe(`backend ${lane.name}: half configured`, () => {
      test(`sets every one of ${names}`, () => {
        throw new Error(
          `${lane.name}: ${missing.join(", ")} unset while the lane's other variables are set; set them all, or none to skip the lane`,
        );
      });
    });
    continue;
  }

  /** This lane's prefix: the run's, plus the lane, plus a name. */
  const prefixFor = (name: string): string => `${RUN}${index}${name}_`;

  /** A driver for this lane, on its own tables. */
  const make = (name: string): CloudflareD1CacheDriver => {
    const options = lane.options();
    const driver = new CloudflareD1CacheDriver({
      ...options,
      prefix: prefixFor(name),
    });
    databases.set(driver, options.databaseId);
    made.push(driver);
    return driver;
  };

  const probe = make("ping");
  const unreachable = await probe.ping().then(
    () => undefined,
    (error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
  );
  if (unreachable !== undefined) {
    reportUnreachable(lane.name, names, unreachable);
    continue;
  }

  const kitOptions: CloudflareD1DriverOptions = {
    ...lane.options(),
    prefix: prefixFor("kit"),
  };
  // A driver on the kit's tables, so the end of the file drops them.
  make("kit");
  await runCacheDriverConformance(
    lane.name,
    () => ({ driver: new CloudflareD1CacheDriver(kitOptions) }),
    {
      crossProcess: {
        module: new URL("../../lib/drivers/cloudflare-d1.ts", import.meta.url)
          .pathname,
        export: "cloudflareD1Driver",
        options: kitOptions,
      },
    },
  );

  describe(`${lane.name}: what the local Worker cannot show`, () => {
    test("a pre-invalidation write never survives a concurrent invalidation (20 rounds)", async () => {
      const driver = make("race");
      await driver.connect();
      let survivors = 0;
      for (let round = 0; round < 20; round++) {
        const ns = `race${round}`;
        const createdAt = Date.now();
        await Promise.all([
          driver.set(
            ns,
            {
              key: "k",
              value: new Uint8Array([1]),
              expiresAt: null,
              tags: ["g"],
            },
            { tags: ["g"], createdAt },
          ),
          driver.deleteByTags(ns, ["g"], Date.now() + 60_000),
        ]);
        if ((await driver.get(ns, "k")) !== undefined) {
          survivors++;
        }
      }
      expect(survivors).toBe(0);
    });

    test(`${D1_MAX_ENTRY_BYTES} bytes round-trip under D1's 2,000,000-byte string limit`, async () => {
      const driver = make("max");
      const value = new Uint8Array(D1_MAX_ENTRY_BYTES).map((_, at) => at % 253);
      await driver.set("ns", { key: "k", value, expiresAt: null, tags: [] });
      expect((await driver.get("ns", "k"))?.value).toEqual(value);
    });

    test("whether a batch is one transaction on this transport (reported; the driver does not rely on it)", async () => {
      const driver = make("batch");
      const table = `${prefixFor("batch")}probe`;
      extraTables.push({ driver, table });
      const database = databases.get(driver) ?? "";
      await driver.client.d1Query(database, [
        {
          sql: `CREATE TABLE IF NOT EXISTS "${table}" (id INTEGER PRIMARY KEY)`,
        },
      ]);
      await expect(
        driver.client.d1Query(database, [
          { sql: `INSERT INTO "${table}" VALUES (1)` },
          { sql: `INSERT INTO "${table}" VALUES (1)` },
        ]),
      ).rejects.toThrow(/UNIQUE/);
      const [count] = await driver.client.d1Query(database, [
        { sql: `SELECT count(*) AS c FROM "${table}"` },
      ]);
      const kept = Number(count.results[0]?.c);
      // eslint-disable-next-line no-console -- the live lane reports what it measured
      console.info(
        `${lane.name}: a failed two-statement batch ${kept === 0 ? "rolled back its first statement (one transaction)" : "kept its first statement (not one transaction)"}`,
      );
      expect([0, 1]).toContain(kept);
    });
  });
}
