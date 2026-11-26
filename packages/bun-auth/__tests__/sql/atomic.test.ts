/**
 * `consumeOne` and a guarded `incrementOne` under concurrency, on every
 * engine: what better-auth relies on for single-use tokens and counters.
 * One statement on Postgres and SQLite; a `SELECT … FOR UPDATE` and the write
 * in one transaction on MySQL and MariaDB, which have no `RETURNING`.
 *
 * Each has a negative control: the same operation written as a read, a pause
 * and a write, through the same adapter, lets more than one caller through.
 * It shows the concurrency is real, so the atomic case could fail.
 */
import type { BetterAuthOptions } from "better-auth";
import { afterAll, describe, expect, test } from "bun:test";
import { bunSqlAdapter } from "../../lib/sql";
import { createdTables, dropTables, forEachEngine, runPrefix } from "./helpers";

/** better-auth with its rate limit in the database: a table with a counter. */
const AUTH: BetterAuthOptions = { rateLimit: { storage: "database" } };

/** How many callers race in each case. */
const RACERS = 8;

await forEachEngine(async (engine, client) => {
  const prefix = runPrefix();
  const adapter = bunSqlAdapter({ sql: client, adapter: engine.name, prefix });
  const created = createdTables(await adapter.syncSchema(AUTH));
  const db = adapter(AUTH);

  describe(`atomic operations on ${engine.name}`, () => {
    afterAll(async () => {
      await dropTables(engine.name, client, created);
      await client.close();
    });

    /** A verification row with a fresh identifier. */
    async function token(): Promise<string> {
      const identifier = `${prefix}${crypto.randomUUID()}`;
      await db.create({
        model: "verification",
        data: {
          identifier,
          value: "v",
          expiresAt: new Date(Date.now() + 60_000),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      return identifier;
    }

    test("consumeOne: one of the racers gets the row, the rest get null", async () => {
      const identifier = await token();
      const results = await Promise.all(
        Array.from({ length: RACERS }, async () =>
          db.consumeOne({
            model: "verification",
            where: [{ field: "identifier", value: identifier }],
          }),
        ),
      );
      expect(results.filter((row) => row !== null)).toHaveLength(1);
      expect(
        await db.count({
          model: "verification",
          where: [{ field: "identifier", value: identifier }],
        }),
      ).toBe(0);
    });

    test("negative control: a read-then-delete consume lets several racers through", async () => {
      const identifier = await token();
      const where = [{ field: "identifier", value: identifier }];
      const results = await Promise.all(
        Array.from({ length: RACERS }, async () => {
          const row = await db.findOne({ model: "verification", where });
          await Bun.sleep(20);
          await db.delete({ model: "verification", where });
          return row;
        }),
      );
      expect(results.filter((row) => row !== null).length).toBeGreaterThan(1);
    });

    /** A rate-limit row whose counter starts at `count`. */
    async function counter(count: number): Promise<string> {
      const key = `${prefix}${crypto.randomUUID()}`;
      await db.create({
        model: "rateLimit",
        data: { key, count, lastRequest: Date.now() },
      });
      return key;
    }

    /** The counter's value now. */
    async function valueOf(key: string): Promise<number> {
      const row = await db.findOne<{ count: number }>({
        model: "rateLimit",
        where: [{ field: "key", value: key }],
      });
      return row!.count;
    }

    test("incrementOne: a guarded decrement from 3 lets exactly 3 racers through and stops at 0", async () => {
      const key = await counter(3);
      const results = await Promise.all(
        Array.from({ length: RACERS }, async () =>
          db.incrementOne<{ count: number }>({
            model: "rateLimit",
            where: [
              { field: "key", value: key },
              { field: "count", operator: "gt", value: 0 },
            ],
            increment: { count: -1 },
          }),
        ),
      );
      const winners = results.filter((row) => row !== null);
      expect(winners).toHaveLength(3);
      expect(winners.map((row) => row?.count).sort()).toEqual([0, 1, 2]);
      expect(await valueOf(key)).toBe(0);
    });

    test("negative control: a read-then-write decrement loses updates", async () => {
      const key = await counter(3);
      const where = [{ field: "key", value: key }];
      const results = await Promise.all(
        Array.from({ length: RACERS }, async () => {
          const row = await db.findOne<{ count: number }>({
            model: "rateLimit",
            where,
          });
          if (!row || row.count <= 0) {
            return null;
          }
          await Bun.sleep(20);
          return db.update({
            model: "rateLimit",
            where,
            update: { count: row.count - 1 },
          });
        }),
      );
      expect(results.filter((row) => row !== null).length).toBeGreaterThan(3);
      expect(await valueOf(key)).toBeGreaterThan(0);
    });
  });
});
