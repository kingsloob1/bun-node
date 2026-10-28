/**
 * An encrypted cache on the server drivers (the encryption plan, PR-E1): the
 * value round-trips with nothing readable in the stored bytes, an entry whose
 * tags were stripped in the store (its clear copy and the tag index) still
 * misses after `invalidateTags`, and a raised clear expiry gains nothing — on
 * Postgres, MySQL, MariaDB and Redis, where the tag index lives apart from
 * the entry. The memory, SQLite and file drivers are covered in
 * `core/encryption-attacks.test.ts`.
 *
 * A backend whose URL is unset skips visibly; one whose URL is set but
 * unreachable fails, naming the variable. Test data: this run's own tables
 * (`bun_cache_test_<pid>_enc_`) and Redis prefix, dropped by name.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import process from "node:process";
import type { CacheDriver } from "../../lib/index";
import { createCache, redisDriver } from "../../lib/index";
import {
  deleteRedisPrefix,
  dropTables,
  reachError,
  redisBackend,
  redisReachError,
  runPrefix,
  sqlBackends,
} from "./backends";
import { reportNotConfigured, reportUnreachable } from "./sqlSuite";

/** The ring every cache here uses. */
const RING = [{ id: "e1", key: new Uint8Array(32).fill(5) }];

/** A value nobody could miss in a dump. */
const SENTINEL = "bun-cache-encrypted-driver-sentinel";

/** Registers the encrypted-cache cases on `make()`'s driver. */
function registerCases(
  name: string,
  make: (namespace: string) => CacheDriver,
): void {
  describe(`encrypted cache on ${name}`, () => {
    /** A cache over a fresh driver, in its own namespace. */
    function open(namespace: string): {
      cache: ReturnType<typeof createCache>;
      driver: CacheDriver;
    } {
      const driver = make(namespace);
      const cache = createCache({
        driver,
        namespace,
        sweepInterval: 0,
        encrypt: { keys: RING },
      });
      return { cache, driver };
    }

    test("the value round-trips, and the stored bytes hold no plaintext", async () => {
      const { cache, driver } = open("enc_roundtrip");
      try {
        await cache.set("user:42", { name: SENTINEL }, { tags: ["users"] });
        expect(await cache.get("user:42")).toEqual({ name: SENTINEL });
        const stored = await driver.get("enc_roundtrip", "user:42");
        expect(Buffer.from(stored!.value).includes(SENTINEL)).toBe(false);
        expect(Buffer.from(stored!.value.subarray(0, 2)).toString()).toBe("BE");
      } finally {
        await cache.close();
      }
    });

    test("stripped tags gain nothing: the entry misses after invalidateTags", async () => {
      const { cache, driver } = open("enc_strip");
      try {
        await cache.set("report", SENTINEL, { tags: ["org:7"] });
        const stored = (await driver.get("enc_strip", "report"))!;
        // Out of the tag index too: deleted, then written back untagged.
        await driver.delete("enc_strip", ["report"]);
        await driver.set("enc_strip", { ...stored, tags: [] });
        await Bun.sleep(2);
        await cache.invalidateTags(["org:7"]);
        expect(await cache.get("report")).toBeUndefined();
        const peer = open("enc_strip");
        try {
          expect(await peer.cache.get("report")).toBeUndefined();
        } finally {
          await peer.cache.close();
        }
      } finally {
        await cache.close();
      }
    });

    test("a raised clear expiry gains nothing", async () => {
      const { cache, driver } = open("enc_expiry");
      try {
        // Long enough that a loaded machine still reads it back before it
        // expires (a 50 ms TTL did not, under the parallel suite).
        await cache.set("k", SENTINEL, { ttl: 1_000 });
        const stored = await driver.get("enc_expiry", "k");
        if (stored === undefined) {
          throw new Error("the entry expired before the test could raise it");
        }
        await driver.set("enc_expiry", {
          ...stored,
          expiresAt: Date.now() + 3_600_000,
        });
        await Bun.sleep(1_100);
        expect(await cache.getEntry("k")).toBeUndefined();
      } finally {
        await cache.close();
      }
    });
  });
}

for (const backend of sqlBackends()) {
  if (backend.url === undefined) {
    reportNotConfigured(backend.name, backend.variable);
    continue;
  }
  const unreachable = await reachError(backend);
  if (unreachable !== undefined) {
    reportUnreachable(backend.name, backend.variable, unreachable);
    continue;
  }
  const prefix = runPrefix("enc_");
  registerCases(backend.name, () => backend.make({ url: backend.url, prefix }));
  afterAll(async () => {
    await dropTables(backend, prefix);
  });
}

const redis = redisBackend();
if (redis.url === undefined) {
  reportNotConfigured("redis", redis.variable);
} else {
  const url = redis.url;
  const unreachable = await redisReachError(url);
  if (unreachable !== undefined) {
    reportUnreachable("redis", redis.variable, unreachable);
  } else {
    const prefix = `bun_cache_test_${process.pid}_${Date.now()}_enc`;
    registerCases("redis", () => redisDriver({ url, prefix }));
    afterAll(async () => {
      await deleteRedisPrefix(url, prefix);
    });
  }
}
