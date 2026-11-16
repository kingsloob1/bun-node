/**
 * The dialects' statements on every engine: what each member renders runs,
 * and does what its description says — upserts, inserts that ignore or
 * refuse a taken key, the JSON readers, writers and setters, the scalar
 * helpers, affected-row counts, transactions, the planner statistics, the
 * two new column types, and keyset pages in both directions.
 *
 * Each case's tables carry a prefix of their own and are dropped by name
 * when it ends (`helpers/backends.ts`).
 */
import type { SQL } from "bun";
import type { SqlBackend } from "../helpers/backends";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  createSchema,
  dialectFor,
  keysetAfter,
  withLockRetry,
} from "../../lib/index";
import { clientFor, forEachSqlBackend, runPrefix } from "../helpers/backends";
import {
  fixtureDefinition,
  fixtureTables,
  runStatements,
} from "../helpers/fixture";

/** Registers the suite for one engine. */
function registerSuite(backend: SqlBackend): void {
  const dialect = dialectFor(backend.name);
  let client: SQL | undefined;
  /** The engine's client, opened on first use and closed when the file ends. */
  const sql = (): SQL => (client ??= clientFor(backend));
  /** Tables the running case made, dropped as it ends. */
  const made: string[] = [];

  /** Creates the fixture under a fresh prefix; answers its items table. */
  const items = async (): Promise<string> => {
    const prefix = runPrefix();
    const tables = fixtureTables(prefix);
    made.push(tables.items, tables.log);
    await runStatements(
      sql(),
      dialect,
      createSchema(fixtureDefinition(prefix, dialect), dialect),
    );
    return tables.items;
  };

  /** `n` placeholders in this dialect, from `from`. */
  const placeholders = (n: number, from = 1): string[] =>
    Array.from({ length: n }, (_, at) => dialect.placeholder(from + at));

  /** Inserts one row with only the required columns and `data`. */
  const insert = async (
    table: string,
    id: string,
    at: number,
    data: unknown = {},
  ): Promise<void> => {
    const [a, b, c] = placeholders(3);
    await sql().unsafe(
      `INSERT INTO ${table} (id, at, data) VALUES (${a}, ${b}, ${dialect.jsonParameter(c!)})`,
      [id, at, dialect.jsonIn(data)],
    );
  };

  /** The `data` of one row, decoded. */
  const dataOf = async (table: string, id: string): Promise<unknown> => {
    const [row] = (await sql().unsafe(
      `SELECT data FROM ${table} WHERE id = ${dialect.placeholder(1)}`,
      [id],
    )) as { data: unknown }[];
    return dialect.jsonOut(row?.data, null);
  };

  afterEach(async () => {
    for (const table of made.splice(0)) {
      await sql()
        .unsafe(`DROP TABLE IF EXISTS ${table}`)
        .catch(() => undefined);
    }
  });

  afterAll(async () => {
    await client?.close();
  });

  describe(`${backend.name}: inserts and upserts`, () => {
    it("upsert writes, then overwrites the named columns", async () => {
      const table = await items();
      const statement = dialect.upsert(table, ["id", "at", "n"], ["id"], ["n"]);
      await sql().unsafe(statement, ["a", 1, 1]);
      await sql().unsafe(statement, ["a", 2, 7]);
      const rows = (await sql().unsafe(`SELECT at, n FROM ${table}`)) as {
        at: unknown;
        n: unknown;
      }[];
      expect(rows.map((row) => [Number(row.at), Number(row.n)])).toEqual([
        [1, 7],
      ]);
    });

    it("upsertAlias, upsertOnConflict and upsertIncoming merge with an expression", async () => {
      const table = await items();
      const [a, b, c] = placeholders(3);
      // The stored row's alias where the engine needs one (Postgres: bare,
      // `n` is ambiguous beside EXCLUDED); MySQL and MariaDB read it bare.
      const alias = dialect.upsertAlias;
      const stored = alias === null ? "n" : `${alias}.n`;
      const merge = `INSERT INTO ${table}${alias === null ? "" : ` AS ${alias}`} (id, at, n) VALUES (${a}, ${b}, ${c}) ${dialect.upsertOnConflict(["id"])} n = ${dialect.greatest(stored, dialect.upsertIncoming("n"))}`;
      await sql().unsafe(merge, ["a", 1, 5]);
      await sql().unsafe(merge, ["a", 1, 3]);
      await sql().unsafe(merge, ["a", 1, 9]);
      const [row] = (await sql().unsafe(`SELECT n FROM ${table}`)) as {
        n: unknown;
      }[];
      expect(Number(row?.n)).toBe(9);
    });

    it("insertIgnore and insertIgnoreMany skip a taken key; insertMany refuses it, recognised", async () => {
      const table = await items();
      await sql().unsafe(dialect.insertIgnore(table, ["id", "at"]), ["a", 1]);
      await sql().unsafe(dialect.insertIgnore(table, ["id", "at"]), ["a", 2]);
      await sql().unsafe(dialect.insertIgnoreMany(table, ["id", "at"], 2), [
        "a",
        3,
        "b",
        4,
      ]);
      const rows = (await sql().unsafe(
        `SELECT id, at FROM ${table} ORDER BY id`,
      )) as { id: string; at: unknown }[];
      expect(rows.map((row) => [row.id, Number(row.at)])).toEqual([
        ["a", 1],
        ["b", 4],
      ]);
      let refused: unknown;
      try {
        await sql().unsafe(dialect.insertMany(table, ["id", "at"], 2), [
          "c",
          5,
          "a",
          6,
        ]);
      } catch (error) {
        refused = error;
      }
      expect(dialect.isUniqueViolation(refused)).toBe(true);
      expect(dialect.isUniqueViolation(new Error("something else"))).toBe(
        false,
      );
    });

    it("insertIgnoreFromJson and insertFromJson, where the engine has them, expand one document", async () => {
      const table = await items();
      if (dialect.insertIgnoreFromJson === undefined) {
        expect(dialect.insertFromJson).toBeUndefined();
        return;
      }
      const columns = ["id", "at"];
      const types = [dialect.idType, dialect.timeType];
      await sql().unsafe(dialect.insertFromJson!(table, columns, types), [
        JSON.stringify([
          { id: "a", at: 1 },
          { id: "b", at: 2 },
        ]),
      ]);
      await sql().unsafe(dialect.insertIgnoreFromJson(table, columns, types), [
        JSON.stringify([
          { id: "b", at: 9 },
          { id: "c", at: 3 },
        ]),
      ]);
      const rows = (await sql().unsafe(
        `SELECT id, at FROM ${table} ORDER BY id`,
      )) as { id: string; at: unknown }[];
      expect(rows.map((row) => [row.id, Number(row.at)])).toEqual([
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ]);
    });

    it("limitedIdSubquery lets an update read the table it updates", async () => {
      const table = await items();
      await insert(table, "a", 1);
      await insert(table, "b", 2);
      await sql().unsafe(
        `UPDATE ${table} SET n = 1 WHERE id IN (${dialect.limitedIdSubquery(`SELECT id FROM ${table} ORDER BY at LIMIT 1`)})`,
      );
      const rows = (await sql().unsafe(
        `SELECT id FROM ${table} WHERE n = 1`,
      )) as { id: string }[];
      expect(rows.map((row) => row.id)).toEqual(["a"]);
    });
  });

  describe(`${backend.name}: JSON`, () => {
    it("jsonIn and jsonOut round-trip strings, numbers, objects and null exactly once", async () => {
      const table = await items();
      const values: [string, unknown][] = [
        ["s", "warm"],
        ["d", "42"],
        ["n", 42],
        ["o", { a: [1, "x"], b: null }],
        ["z", null],
      ];
      for (const [id, value] of values) {
        const [a, b, c] = placeholders(3);
        await sql().unsafe(
          `INSERT INTO ${table} (id, at, data) VALUES (${a}, ${b}, ${c})`,
          [id, 1, dialect.jsonIn(value)],
        );
      }
      for (const [id, value] of values) {
        expect(await dataOf(table, id)).toEqual(value);
      }
    });

    it("jsonSetInteger, jsonInteger, jsonSetValues and jsonOrBit edit a document in place", async () => {
      const table = await items();
      await insert(table, "a", 1, { keep: "yes", m: 1 });
      await insert(table, "b", 1, { keep: "no" });
      const p1 = dialect.placeholder(1);
      const p2 = dialect.placeholder(2);
      const p3 = dialect.placeholder(3);
      await sql().unsafe(
        `UPDATE ${table} SET data = ${dialect.jsonSetInteger("data", "v", p1)} WHERE id = ${p2}`,
        [3, "a"],
      );
      const found = (await sql().unsafe(
        `SELECT id FROM ${table} WHERE ${dialect.jsonInteger("data", "v")} = ${p1}`,
        [3],
      )) as { id: string }[];
      expect(found.map((row) => row.id)).toEqual(["a"]);
      await sql().unsafe(
        `UPDATE ${table} SET data = ${dialect.jsonSetValues("data", [
          ["obj", p1],
          ["num", p2],
        ])} WHERE id = ${p3}`,
        [JSON.stringify({ x: [1] }), "7", "a"],
      );
      await sql().unsafe(
        `UPDATE ${table} SET data = ${dialect.jsonOrBit("data", "m", 4)}`,
      );
      expect(await dataOf(table, "a")).toEqual({
        keep: "yes",
        m: 5,
        v: 3,
        obj: { x: [1] },
        num: 7,
      });
      // No `m` to OR into: unchanged.
      expect(await dataOf(table, "b")).toEqual({ keep: "no" });
    });

    it("jsonOrBit refuses a bit that is not a positive integer, with the configured error", () => {
      expect(() => dialect.jsonOrBit("data", "m", 0)).toThrow(
        "A JSON bit must be a positive integer, not 0",
      );
      class Own extends Error {}
      const own = dialectFor(backend.name, {
        configError: (message) => new Own(message),
      });
      expect(() => own.jsonOrBit("data", "m", 1.5)).toThrow(Own);
    });

    it("jsonEmbed stores a value inside an expanded document as jsonIn would", () => {
      expect(dialect.jsonEmbed(undefined)).toBeNull();
      expect(dialect.jsonEmbed({ a: 1 })).toEqual({ a: 1 });
      expect(dialect.jsonEmbed("warm")).toBe(
        backend.name === "postgres" ? '"warm"' : "warm",
      );
    });

    it("documentType holds a document the engine reads into", async () => {
      const table = await items();
      const [a, b, c] = placeholders(3);
      await sql().unsafe(
        `INSERT INTO ${table} (id, at, body) VALUES (${a}, ${b}, ${dialect.jsonParameter(c!)})`,
        ["a", 1, dialect.jsonIn({ k: "v", n: 2 })],
      );
      const [row] = (await sql().unsafe(`SELECT body FROM ${table}`)) as {
        body: unknown;
      }[];
      expect(dialect.jsonOut<unknown>(row?.body, null)).toEqual({
        k: "v",
        n: 2,
      });
      if (backend.name === "postgres") {
        const [field] = (await sql().unsafe(
          `SELECT body->>'k' AS k FROM ${table}`,
        )) as { k: string }[];
        expect(field?.k).toBe("v");
      }
    });
  });

  describe(`${backend.name}: scalars, counts, transactions`, () => {
    it("greatest and least", async () => {
      const [row] = (await sql().unsafe(
        `SELECT ${dialect.greatest("3", "5")} AS g, ${dialect.least("3", "5")} AS l`,
      )) as { g: unknown; l: unknown }[];
      expect([Number(row?.g), Number(row?.l)]).toEqual([5, 3]);
    });

    it("affectedRows counts what a write matched, or changed where countsChangedRows says so", async () => {
      const table = await items();
      await insert(table, "a", 1);
      await insert(table, "b", 1);
      const set = (n: number) =>
        sql().unsafe(
          `UPDATE ${table} SET n = ${dialect.placeholder(1)} WHERE at = ${dialect.placeholder(2)}`,
          [n, 1],
        );
      expect(await dialect.affectedRows(await set(2), sql())).toBe(2);
      expect(await dialect.affectedRows(await set(2), sql())).toBe(
        dialect.countsChangedRows ? 0 : 2,
      );
    });

    it("transaction commits what succeeds and rolls back what throws", async () => {
      const table = await items();
      await dialect.transaction(sql(), async (tx) => {
        await tx.unsafe(dialect.insertIgnore(table, ["id", "at"]), ["a", 1]);
      });
      await expect(
        dialect.transaction(sql(), async (tx) => {
          await tx.unsafe(dialect.insertIgnore(table, ["id", "at"]), ["b", 1]);
          throw new Error("undo");
        }),
      ).rejects.toThrow("undo");
      const rows = (await sql().unsafe(`SELECT id FROM ${table}`)) as {
        id: string;
      }[];
      expect(rows.map((row) => row.id)).toEqual(["a"]);
    });

    it("withLockRetry returns what the work returns", async () => {
      expect(await withLockRetry(async () => 7)).toBe(7);
    });

    it("analyze runs, and estimatedRows answers a number where the engine has one", async () => {
      const table = await items();
      await insert(table, "a", 1);
      const analyze = dialect.analyze(table);
      if (analyze !== null) {
        await sql().unsafe(analyze);
      }
      const estimate = dialect.estimatedRows(table);
      if (estimate === null) {
        expect(backend.name).not.toBe("postgres");
        return;
      }
      const [row] = (await sql().unsafe(estimate)) as { n: unknown }[];
      expect(Number.isFinite(Number(row?.n))).toBe(true);
    });

    it("notifyingInsert still inserts, and signals where the engine can", async () => {
      const table = await items();
      const statement = dialect.notifyingInsert(
        dialect.insertIgnore(table, ["id", "at"]),
        "bun_sql_test",
      );
      expect(statement.includes("pg_notify")).toBe(dialect.supportsListen);
      await sql().unsafe(statement, ["a", 1]);
      const rows = (await sql().unsafe(`SELECT id FROM ${table}`)) as {
        id: string;
      }[];
      expect(rows.map((row) => row.id)).toEqual(["a"]);
    });

    it("inetType holds an address where the engine has one", async () => {
      const table = await items();
      const [a, b, c] = placeholders(3);
      await sql().unsafe(
        `INSERT INTO ${table} (id, at, ip) VALUES (${a}, ${b}, ${c})`,
        ["a", 1, "10.0.0.0/8"],
      );
      if (dialect.inetType === null) {
        const [row] = (await sql().unsafe(`SELECT ip FROM ${table}`)) as {
          ip: string;
        }[];
        expect(row?.ip).toBe("10.0.0.0/8");
        return;
      }
      const inside = (await sql().unsafe(
        `SELECT id FROM ${table} WHERE ip >>= ${dialect.placeholder(1)}::inet`,
        ["10.1.2.3"],
      )) as { id: string }[];
      expect(inside.map((row) => row.id)).toEqual(["a"]);
    });
  });

  describe(`${backend.name}: keyset pages`, () => {
    for (const direction of ["asc", "desc"] as const) {
      it(`walks every row once, in order, ${direction}, ties broken on the id`, async () => {
        const table = await items();
        // Five values of `at`, five rows each: every page boundary is a tie.
        for (let i = 0; i < 25; i++) {
          await insert(table, `r${String(i).padStart(2, "0")}`, i % 5);
        }
        const order = `at ${direction}, id ${direction}`;
        const all = (
          (await sql().unsafe(`SELECT id FROM ${table} ORDER BY ${order}`)) as {
            id: string;
          }[]
        ).map((row) => row.id);
        const seen: string[] = [];
        let last: { at: number; id: string } | undefined;
        for (let pages = 0; pages < 10; pages++) {
          const params: unknown[] = [];
          const bind = (value: unknown): string => {
            params.push(value);
            return dialect.placeholder(params.length);
          };
          const where =
            last === undefined
              ? ""
              : `WHERE ${keysetAfter(dialect, bind, {
                  columns: ["at"],
                  values: [last.at],
                  idColumn: "id",
                  id: last.id,
                  direction,
                })}`;
          const page = (await sql().unsafe(
            `SELECT id, at FROM ${table} ${where} ORDER BY ${order} LIMIT 7`,
            params,
          )) as { id: string; at: unknown }[];
          if (page.length === 0) {
            break;
          }
          seen.push(...page.map((row) => row.id));
          const end = page.at(-1)!;
          last = { at: Number(end.at), id: end.id };
        }
        expect(seen).toEqual(all);
        expect(all).toHaveLength(25);
      });
    }
  });
}

await forEachSqlBackend(registerSuite);
