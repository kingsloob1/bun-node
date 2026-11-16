/**
 * `cacheStore` on real backends (topologies.md §2.2, §3): Redis, Postgres,
 * MySQL, MariaDB, MongoDB and a SQLite file. On each, two or three engines
 * share one backend: a shared limit is exact across them; a ban and its
 * lift reach the others (through the driver's bus where it has one, the
 * poll otherwise); an engine started later loads the bans (after a
 * snapshot); a counted rule counts across engines; offence scores add up;
 * a hybrid limit holds once synced; distinct counts add up across stores.
 *
 * The rules of the repo's database suites: `BUN_SECURITY_TEST_<X>_URL`,
 * falling back to `BUN_CACHE_TEST_<X>_URL` and `BUN_JOBS_TEST_<X>_URL`;
 * unset skips visibly; set but unreachable fails, naming the backend. Each
 * run keeps its data under its own prefix (`bun_security_test_<pid>_<t>_`)
 * and removes exactly that: its tables, its collections, its keys.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { RedisClient, SQL } from "bun";
import {
  createCache,
  mariadbDriver,
  mongoDriver,
  mysqlDriver,
  postgresDriver,
  redisDriver,
  sqliteDriver,
} from "@kingsleyweb/bun-cache";
import type { CacheDriver } from "@kingsleyweb/bun-cache";
import { DistinctCounts } from "../../lib/engine/distinct";
import { EvictionMonitor } from "../../lib/engine/state";
import { createSecurity } from "../../lib/index";
import type {
  Security,
  SecurityPolicy,
  SharedStateStore,
} from "../../lib/index";
import { cacheStore } from "../../lib/stores/index";
import { facts } from "../helpers";
import { quiet } from "./fleet";

/** The run's own prefix. */
const PREFIX = `bun_security_test_${process.pid}_${Date.now() % 1_000_000}_`;

/** One backend. */
interface Backend {
  /** As in the test titles. */
  readonly name: string;
  /** The variable that points at it. */
  readonly variable: string;
  /** The URL, when one is set (`file:` for SQLite, always). */
  readonly url: string | undefined;
  /** A driver on it, under the run's prefix. */
  readonly make: () => CacheDriver;
  /** Removes what the run wrote. */
  readonly clean: () => Promise<void>;
}

/** The URL for `engine`, from the variables in order. */
function urlOf(engine: string): string | undefined {
  return (
    process.env[`BUN_SECURITY_TEST_${engine}_URL`] ||
    process.env[`BUN_CACHE_TEST_${engine}_URL`] ||
    process.env[`BUN_JOBS_TEST_${engine}_URL`] ||
    undefined
  );
}

/** Drops the run's SQL tables, by name. */
async function dropTables(
  url: string,
  kind: "postgres" | "mysql",
): Promise<void> {
  const parsed = new URL(url);
  const retrieval = parsed.searchParams.get("allowPublicKeyRetrieval");
  parsed.search = "";
  const sql = new SQL({
    url: parsed.toString(),
    ...(kind === "mysql" && retrieval === "true"
      ? { allowPublicKeyRetrieval: true }
      : {}),
  });
  try {
    for (const table of ["entries", "tags", "stamps", "locks", "bus"]) {
      await sql.unsafe(`DROP TABLE IF EXISTS ${PREFIX}${table}`);
    }
  } finally {
    await sql.close();
  }
}

const sqliteDir = mkdtempSync(join(tmpdir(), "bun-security-sqlite-"));

const backends: Backend[] = [
  {
    name: "redis",
    variable: "BUN_CACHE_TEST_REDIS_URL",
    url: urlOf("REDIS"),
    make: () => redisDriver({ url: urlOf("REDIS"), prefix: PREFIX }),
    clean: async () => {
      const client = new RedisClient(urlOf("REDIS"));
      try {
        let cursor = "0";
        do {
          const [next, keys] = (await client.send("SCAN", [
            cursor,
            "MATCH",
            `${PREFIX}:*`,
            "COUNT",
            "1000",
          ])) as [string, string[]];
          cursor = next;
          if (keys.length > 0) await client.send("DEL", keys);
        } while (cursor !== "0");
      } finally {
        client.close();
      }
    },
  },
  {
    name: "postgres",
    variable: "BUN_CACHE_TEST_POSTGRES_URL",
    url: urlOf("POSTGRES"),
    make: () => postgresDriver({ url: urlOf("POSTGRES"), prefix: PREFIX }),
    clean: () => dropTables(urlOf("POSTGRES") ?? "", "postgres"),
  },
  {
    name: "mysql",
    variable: "BUN_CACHE_TEST_MYSQL_URL",
    url: urlOf("MYSQL"),
    make: () => mysqlDriver({ url: urlOf("MYSQL"), prefix: PREFIX }),
    clean: () => dropTables(urlOf("MYSQL") ?? "", "mysql"),
  },
  {
    name: "mariadb",
    variable: "BUN_CACHE_TEST_MARIADB_URL",
    url: urlOf("MARIADB"),
    make: () => mariadbDriver({ url: urlOf("MARIADB"), prefix: PREFIX }),
    clean: () => dropTables(urlOf("MARIADB") ?? "", "mysql"),
  },
  {
    name: "mongodb",
    variable: "BUN_CACHE_TEST_MONGODB_URL",
    url: urlOf("MONGODB"),
    make: () => mongoDriver({ url: urlOf("MONGODB"), prefix: PREFIX }),
    clean: async () => {
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(urlOf("MONGODB") ?? "");
      try {
        const db = client.db();
        for (const name of ["entries", "stamps", "locks", "bus"]) {
          await db
            .collection(`${PREFIX}${name}`)
            .drop()
            .catch(() => undefined);
        }
      } finally {
        await client.close();
      }
    },
  },
  {
    name: "sqlite (file, WAL)",
    variable: "(always: a file under the temporary directory)",
    url: `file:${sqliteDir}`,
    make: () =>
      sqliteDriver({ path: join(sqliteDir, "state.sqlite"), prefix: PREFIX }),
    clean: async () => {
      rmSync(sqliteDir, { recursive: true, force: true });
    },
  },
];

/** Waits until `check` holds, at most `ms`. */
async function until(check: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

for (const backend of backends) {
  if (backend.url === undefined) {
    describe.skip(`backend ${backend.name}: not configured (${backend.variable})`, () => {
      it("skipped", () => {});
    });
    continue;
  }
  describe(`backend ${backend.name}`, () => {
    const drivers: CacheDriver[] = [];
    const stores: SharedStateStore[] = [];
    const engines: Security[] = [];

    /** A store on the backend: its own driver and cache, as another process has. */
    const store = (namespace = "bun-security"): SharedStateStore => {
      const driver = backend.make();
      drivers.push(driver);
      const made = cacheStore(createCache({ driver, logger: quiet }), {
        namespace,
        ...(driver.publish !== undefined && driver.subscribe !== undefined
          ? { bus: driver }
          : {}),
        timeout: "3s",
        pollInterval: "200ms",
        reconcileInterval: "500ms",
        syncInterval: "100ms",
        logger: quiet,
      });
      stores.push(made);
      return made;
    };

    /** An engine on its own store. */
    const engine = (policy: SecurityPolicy, namespace?: string): Security => {
      const security = createSecurity({
        policy,
        store: store(namespace),
        logger: quiet,
      });
      engines.push(security);
      return security;
    };

    afterAll(async () => {
      for (const security of engines) {
        security.close();
        await security.flush();
      }
      for (const made of stores) await made.close();
      for (const driver of drivers) await driver.close().catch(() => undefined);
      await backend.clean();
    });

    it(`is reachable (${backend.variable})`, async () => {
      const driver = backend.make();
      try {
        await driver.connect?.();
      } catch (error) {
        throw new Error(
          `backend ${backend.name} is set (${backend.variable}) but unreachable: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      } finally {
        await driver.close().catch(() => undefined);
      }
    });

    it("a shared limit is exact across engines", async () => {
      const policy: SecurityPolicy = {
        limits: [{ id: "per-ip", limit: 5, window: "1m" }],
      };
      const a = engine(policy, "limits");
      const b = engine(policy, "limits");
      const actions: string[] = [];
      for (let i = 0; i < 8; i++) {
        const decision = await (i % 2 === 0 ? a : b).evaluate(
          facts({ client: "198.51.100.50" }),
        );
        actions.push(decision.action);
      }
      expect(actions).toEqual([
        "allow",
        "allow",
        "allow",
        "allow",
        "allow",
        "block",
        "block",
        "block",
      ]);
    });

    it("a ban and its lift reach the other engines; one started later loads it", async () => {
      const a = engine({}, "bans");
      const b = engine({}, "bans");
      await Promise.all([a.ready(), b.ready()]);
      a.ban({ ip: "203.0.113.50", reason: "probe", by: "ops" });
      a.ban({ ip: "198.51.100.0/24", reason: "range" });
      await a.flush();
      await until(() => b.bans().length === 2);
      expect((await b.evaluate(facts({ client: "198.51.100.9" }))).action).toBe(
        "ban",
      );
      // A reconcile and a snapshot happen on their own; a later engine loads.
      await until(() => (a.status().state.store?.reconciledAt ?? 0) > 0);
      const c = engine({}, "bans");
      await c.ready();
      expect(
        c
          .bans()
          .map((ban) => ban.id)
          .sort(),
      ).toEqual(["cidr:198.51.100.0/24", "ip:203.0.113.50"]);
      b.unban("ip:203.0.113.50");
      await b.flush();
      await until(() => a.bans().length === 1 && c.bans().length === 1);
    });

    it("a counted rule counts across engines, and its ban reaches the others", async () => {
      const policy: SecurityPolicy = {
        service: "auth",
        countedRules: [
          {
            id: "failed",
            event: "auth.failure",
            threshold: 3,
            window: "15m",
            duration: "1h",
          },
        ],
      };
      const a = engine(policy, "counted");
      const b = engine(policy, "counted");
      const client = facts({ client: "198.51.100.51" });
      expect(await a.signal(client, "auth.failure")).toEqual([]);
      expect(await b.signal(client, "auth.failure")).toEqual([]);
      const trip = await a.signal(client, "auth.failure");
      expect(trip.map((hit) => hit.rule)).toEqual(["counted:failed"]);
      await a.flush();
      await until(() => b.bans().length === 1);
    });

    it("offence scores add up across engines once synced", async () => {
      const policy: SecurityPolicy = {
        ladder: {
          steps: [{ score: 10, action: "ban", duration: "1h" }],
          weights: { "probe.hit": 4 },
        },
      };
      const a = engine(policy, "scores");
      const b = engine(policy, "scores");
      const client = facts({ client: "198.51.100.52" });
      await a.signal(client, "probe.hit");
      await a.signal(client, "probe.hit");
      await a.flush();
      await b.signal(client, "probe.hit");
      await b.flush();
      const hits = await b.signal(client, "probe.hit");
      expect(hits.map((hit) => hit.rule)).toEqual(["ladder"]);
    });

    it("a hybrid limit holds across engines once synced", async () => {
      const policy: SecurityPolicy = {
        limits: [{ id: "h", limit: 10, window: "1m", state: "hybrid" }],
      };
      const a = engine(policy, "hybrid");
      const b = engine(policy, "hybrid");
      const client = facts({ client: "198.51.100.53" });
      for (let i = 0; i < 6; i++) {
        expect((await a.evaluate(client)).action).toBe("allow");
        expect((await b.evaluate(client)).action).toBe("allow");
      }
      await a.flush();
      await b.flush();
      await a.flush();
      expect((await a.evaluate(client)).action).toBe("block");
      expect((await b.evaluate(client)).action).toBe("block");
    });

    it("distinct counts add up across stores", async () => {
      const monitor = new EvictionMonitor(
        () => {},
        () => undefined,
      );
      const one = new DistinctCounts(
        store("distinct"),
        10,
        monitor,
        noopLogger,
      );
      const two = new DistinctCounts(
        store("distinct"),
        10,
        monitor,
        noopLogger,
      );
      const count = {
        key: "user:alice",
        window: 60_000,
        state: "shared",
        onStoreError: "open",
      } as const;
      const now = Date.now();
      expect(await one.add({ ...count, element: "203.0.113.1" }, now)).toBe(1);
      expect(await two.add({ ...count, element: "203.0.113.2" }, now)).toBe(2);
      expect(await two.add({ ...count, element: "203.0.113.1" }, now)).toBe(2);
    });
  });
}
