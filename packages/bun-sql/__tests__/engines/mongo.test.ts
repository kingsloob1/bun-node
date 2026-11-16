/**
 * `syncMongoIndexes` on the MongoDB server `BUN_SQL_TEST_MONGODB_URL` (or
 * `BUN_JOBS_TEST_MONGODB_URL`) names: the baseline — indexes just created
 * report no drift — a missing index created, a TTL index created with its
 * expiry, a retired index dropped only because the list names it, an index
 * added by hand left alone, and `dryRun`, `add` and `indexes` honoured.
 *
 * Unset, the suite skips visibly; set but unreachable, it fails, named. Each
 * case's collections carry a prefix of their own and are dropped by name.
 */
import type {
  MongoClientLike,
  MongoIndexDb,
  MongoIndexSchema,
} from "../../lib/index";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { loadMongoClient, syncMongoIndexes } from "../../lib/index";
import {
  mongoBackend,
  reportNotConfigured,
  reportUnreachable,
  runPrefix,
} from "../helpers/backends";

/** What the tests use of a database beyond the index sync. */
interface TestDb extends MongoIndexDb {
  /** Drops a collection; resolves `false` when it did not exist. */
  dropCollection: (name: string) => Promise<boolean>;
  /** Creates a collection. */
  createCollection: (name: string) => Promise<unknown>;
}

const { url, variable } = mongoBackend();

/** Connects, or answers why not. */
async function connect(): Promise<MongoClientLike | Error> {
  try {
    const MongoClient = await loadMongoClient("bun-sql's tests");
    const client = new MongoClient(url!, { serverSelectionTimeoutMS: 3_000 });
    await client.connect();
    return client;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

const connected = url === undefined ? undefined : await connect();

if (url === undefined) {
  reportNotConfigured("mongodb", variable);
} else if (connected instanceof Error) {
  reportUnreachable("mongodb", variable, connected);
} else {
  const client = connected!;
  const db = client.db() as TestDb;
  /** Collections the running case made, dropped as it ends. */
  const made: string[] = [];

  /** A fresh collection name of this run's. */
  const fresh = (label: string): string => {
    const name = `${runPrefix()}${label}`;
    made.push(name);
    return name;
  };

  /** The index names a collection has. */
  const names = async (collection: string): Promise<string[]> =>
    (await db.collection(collection).indexes())
      .map((index) => String(index.name))
      .sort();

  afterEach(async () => {
    for (const name of made.splice(0)) {
      await db.dropCollection(name).catch(() => false);
    }
  });

  afterAll(async () => {
    await client.close();
  });

  describe("mongodb: syncMongoIndexes", () => {
    it("creates what is missing, then reports no drift", async () => {
      const items = fresh("items");
      const schema: MongoIndexSchema = {
        indexes: [
          { collection: items, key: { tenant: 1, at: -1 } },
          { collection: items, key: { exp: 1 }, expireAfterSeconds: 0 },
        ],
      };
      const plan = await syncMongoIndexes(db, schema, { dryRun: true });
      expect(plan).toEqual([
        expect.objectContaining({
          kind: "create-index",
          table: items,
          target: "tenant_1_at_-1",
          applied: false,
          blocking: false,
        }),
        expect.objectContaining({ kind: "create-index", target: "exp_1" }),
      ]);
      // A dry run created nothing.
      expect(await names(items).catch(() => [])).toEqual([]);
      const applied = await syncMongoIndexes(db, schema);
      expect(applied.every((change) => change.applied)).toBe(true);
      expect(await names(items)).toEqual(["_id_", "exp_1", "tenant_1_at_-1"]);
      // The TTL index carries its expiry.
      const ttl = (
        (await db.collection(items).indexes()) as {
          name?: unknown;
          expireAfterSeconds?: unknown;
        }[]
      ).find((index) => index.name === "exp_1");
      expect(ttl?.expireAfterSeconds).toBe(0);
      expect(await syncMongoIndexes(db, schema)).toEqual([]);
    });

    it("drops a retired index only because the list names it; one added by hand stays", async () => {
      const items = fresh("items");
      await db.createCollection(items);
      await db.collection(items).createIndex({ old: 1 });
      await db.collection(items).createIndex({ byHand: 1 });
      const schema: MongoIndexSchema = {
        indexes: [{ collection: items, key: { tenant: 1 } }],
        retired: [{ collection: items, name: "old_1" }],
      };
      const plan = await syncMongoIndexes(db, schema, { dryRun: true });
      expect(plan.map((change) => [change.kind, change.target])).toEqual([
        ["create-index", "tenant_1"],
        ["drop-index", "old_1"],
      ]);
      // indexes: false creates (add) but drops nothing.
      const partial = await syncMongoIndexes(db, schema, { indexes: false });
      expect(partial.map((change) => change.applied)).toEqual([true, false]);
      expect(await names(items)).toContain("old_1");
      await syncMongoIndexes(db, schema);
      expect(await names(items)).toEqual(["_id_", "byHand_1", "tenant_1"]);
      expect(await syncMongoIndexes(db, schema)).toEqual([]);
    });

    it("add and indexes both off create nothing", async () => {
      const items = fresh("items");
      const schema: MongoIndexSchema = {
        indexes: [{ collection: items, key: { a: 1 } }],
      };
      const changes = await syncMongoIndexes(db, schema, {
        add: false,
        indexes: false,
      });
      expect(changes.map((change) => change.applied)).toEqual([false]);
    });

    it("passes collectionOptions to every collection call", async () => {
      const items = fresh("items");
      const seen: unknown[] = [];
      const spy: MongoIndexDb = {
        collection: (name: string, options?: never) => {
          seen.push(options);
          return db.collection(name, options);
        },
      };
      await syncMongoIndexes(
        spy,
        { indexes: [{ collection: items, key: { a: 1 } }] },
        { collectionOptions: { readPreference: "primary" } },
      );
      expect(seen.length).toBeGreaterThan(0);
      expect(
        seen.every(
          (options) =>
            (options as { readPreference?: string })?.readPreference ===
            "primary",
        ),
      ).toBe(true);
    });
  });
}
