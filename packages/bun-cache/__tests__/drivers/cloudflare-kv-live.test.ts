/**
 * The Cloudflare KV driver against Cloudflare itself — the **opt-in live
 * lane**, like the Upstash one. Two transports, each run only when its
 * variables are set (never in a committed file: they are credentials), and
 * otherwise skipped visibly:
 *
 * - **The REST API**: `BUN_CACHE_TEST_CLOUDFLARE_ACCOUNT_ID`,
 *   `BUN_CACHE_TEST_CLOUDFLARE_API_TOKEN` (an API token with *Workers KV
 *   Storage: Edit*) and `BUN_CACHE_TEST_CLOUDFLARE_KV_NAMESPACE_ID` (a
 *   namespace made for tests).
 * - **A deployed bun-cache Worker**: `BUN_CACHE_TEST_CLOUDFLARE_PROXY_URL`
 *   and `BUN_CACHE_TEST_CLOUDFLARE_PROXY_TOKEN` (its `BUN_CACHE_PROXY_TOKEN`
 *   secret), with the KV namespace bound as `CACHE_KV` (the README's
 *   `wrangler.toml`).
 *
 * Some but not all of a lane's variables set fails, naming the missing ones;
 * a set lane that cannot be reached fails, naming the variable. Each lane runs
 * the conformance kit (with its two-process pass) and the specifics the local
 * Worker cannot show: KV's real 60 s floor and its per-key write rate. Keys
 * are this run's prefix, `bun-cache-test/<pid>-<time>/…`, deleted by exact
 * listing at the end.
 *
 * **Costs and limits.** The REST API allows 1,200 requests per five minutes
 * per token (the client paces under it; one run is a few hundred requests);
 * Workers KV's free plan allows 1,000 writes a day. KV is eventually
 * consistent: a read right after a write is usually, not always, fresh where
 * it was made, so a failure here may be KV's consistency, not the driver —
 * record what was seen.
 */
import process from "node:process";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { CloudflareKvDriverOptions } from "../../lib/drivers/cloudflare-kv";
import { CloudflareKvCacheDriver } from "../../lib/drivers/cloudflare-kv";
import { createCache } from "../../lib/index";
import { runCacheDriverConformance } from "../../lib/testing/index";
import { reportNotConfigured, reportUnreachable } from "./sqlSuite";

/** The variables' common prefix. */
const VAR = "BUN_CACHE_TEST_CLOUDFLARE";

/** The binding name the README's `wrangler.toml` gives the namespace. */
const WORKER_KV_BINDING = "CACHE_KV";

/** This run's prefix. */
const RUN = `bun-cache-test/${process.pid}-${Date.now()}`;

/** A lane: its name, its variables, and the driver options they give. */
interface Lane {
  /** Shown in the titles. */
  name: string;
  /** The variables, by name, and their values. */
  vars: Record<string, string | undefined>;
  /** The driver's options, with `prefix` left to the lane. */
  options: () => Omit<CloudflareKvDriverOptions, "prefix">;
  /** Kit cases this transport cannot pass, with the measured reason. */
  skip: { id: string; reason: string }[];
}

/**
 * Why the REST API skips the kit's `delete` and `clear` cases: they read a key
 * right after deleting it, and through the REST API a deleted key kept being
 * served for 52 s (measured 2026-10-28, from Lagos; an overwrite showed in
 * 0.7 s, and through the Worker both in about 0.4 s). That is KV's eventual
 * consistency, documented as "up to 60 seconds or more", not the driver.
 */
const REST_STALE_DELETE =
  "KV's REST API serves a deleted key for up to a minute (eventual consistency, measured 52 s); the Worker lane runs it";

const lanes: Lane[] = [
  {
    name: "cloudflare-kv, REST API",
    vars: {
      [`${VAR}_ACCOUNT_ID`]: process.env[`${VAR}_ACCOUNT_ID`] || undefined,
      [`${VAR}_API_TOKEN`]: process.env[`${VAR}_API_TOKEN`] || undefined,
      [`${VAR}_KV_NAMESPACE_ID`]:
        process.env[`${VAR}_KV_NAMESPACE_ID`] || undefined,
    },
    options: () => ({
      accountId: process.env[`${VAR}_ACCOUNT_ID`],
      apiToken: process.env[`${VAR}_API_TOKEN`],
      namespaceId: process.env[`${VAR}_KV_NAMESPACE_ID`] ?? "",
    }),
    skip: [
      { id: "delete", reason: REST_STALE_DELETE },
      { id: "clear", reason: REST_STALE_DELETE },
    ],
  },
  {
    name: "cloudflare-kv, Worker",
    vars: {
      [`${VAR}_PROXY_URL`]: process.env[`${VAR}_PROXY_URL`] || undefined,
      [`${VAR}_PROXY_TOKEN`]: process.env[`${VAR}_PROXY_TOKEN`] || undefined,
    },
    options: () => ({
      endpoint: process.env[`${VAR}_PROXY_URL`],
      apiToken: process.env[`${VAR}_PROXY_TOKEN`],
      namespaceId: WORKER_KV_BINDING,
    }),
    skip: [],
  },
];

/** The drivers the lanes made, so the end of the file deletes their keys. */
const made: CloudflareKvCacheDriver[] = [];

// A hook gets bun's default 5 s unless told otherwise: the clean-up lists and
// deletes over the network (measured: it timed out at 5 s on the first run).
afterAll(async () => {
  for (const driver of made) {
    await deleteUnder(driver, `${driver.prefix}/`).catch(() => undefined);
  }
}, 120_000);

/** Deletes exactly the keys under a prefix this run wrote. */
async function deleteUnder(
  driver: CloudflareKvCacheDriver,
  prefix: string,
): Promise<void> {
  let cursor: string | undefined;
  const keys: string[] = [];
  do {
    const page = await driver.client.kvList(laneNamespace(driver), prefix, {
      cursor,
    });
    keys.push(...page.keys);
    cursor = page.cursor;
  } while (cursor !== undefined);
  await driver.client.kvBulkDelete(laneNamespace(driver), keys);
}

/** Each driver's namespace id, remembered when it was made. */
const namespaces = new WeakMap<CloudflareKvCacheDriver, string>();

/** The namespace a lane's driver writes to. */
function laneNamespace(driver: CloudflareKvCacheDriver): string {
  return namespaces.get(driver) ?? "";
}

setDefaultTimeout(120_000);

for (const lane of lanes) {
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

  /** A driver for this lane, under its own prefix. */
  const make = (name: string): CloudflareKvCacheDriver => {
    const options = lane.options();
    const driver = new CloudflareKvCacheDriver({
      ...options,
      prefix: `${RUN}/${name}`,
    });
    namespaces.set(driver, options.namespaceId);
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

  const kitOptions: CloudflareKvDriverOptions = {
    ...lane.options(),
    prefix: `${RUN}/kit`,
  };
  // A driver on the kit's prefix, so the end of the file deletes its keys.
  make("kit");
  await runCacheDriverConformance(
    lane.name,
    () => ({ driver: new CloudflareKvCacheDriver(kitOptions) }),
    {
      crossProcess: {
        module: new URL("../../lib/drivers/cloudflare-kv.ts", import.meta.url)
          .pathname,
        export: "cloudflareKvDriver",
        options: kitOptions,
      },
      skip: lane.skip,
    },
  );

  describe(`${lane.name}: what the local Worker cannot show`, () => {
    test("KV accepts a 2 s entry (written with KV's 60 s floor), and the read check expires it on time", async () => {
      const driver = make("floor");
      const cache = createCache({ driver });
      await cache.set("k", "v", { ttl: 2_000 });
      expect(await cache.get("k")).toBe("v");
      await Bun.sleep(2_200);
      expect(await cache.get("k")).toBeUndefined();
      await cache.close();
    });

    test("a second write to one key within a second is retried and lands (KV's per-key write rate)", async () => {
      const driver = make("rate");
      const value = (n: number) => ({
        key: "hot",
        value: new Uint8Array([n]),
        expiresAt: null,
        tags: [],
      });
      await driver.set("ns", value(1));
      await driver.set("ns", value(2));
      await driver.set("ns", value(3));
      // eslint-disable-next-line no-console -- the live lane reports what it measured
      console.info(
        `${lane.name}: three writes to one key answered ${driver.client.rateLimited} 429(s)`,
      );
      expect((await driver.get("ns", "hot"))?.value).toEqual(
        new Uint8Array([3]),
      );
    });

    test("stamps read back through bulk/get as text", async () => {
      const driver = make("stamps");
      const at = Date.now();
      await driver.setStamps("ns", ["a", "b"], at, at + 120_000);
      const stamps = await driver.getStamps("ns", ["a", "b", "unset"]);
      expect(stamps.get("a")).toBe(at);
      expect(stamps.get("b")).toBe(at);
      expect(stamps.has("unset")).toBe(false);
    });
  });
}
