/**
 * `createSchema` and `syncSqlSchema` on every engine (SQLite always; Postgres,
 * MySQL and MariaDB when their URLs are set): the baseline — a freshly
 * created schema reports no drift — and every kind of drift a sync repairs or
 * declines to, each built on purpose first. A run against a fresh database
 * alone would pass whether or not any of the repairs worked.
 *
 * Each case's tables carry a prefix of their own and are dropped by name
 * when it ends (`helpers/backends.ts`).
 */
import type { SQL } from "bun";
import type { SqlBackend } from "../helpers/backends";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  collationDrift,
  createSchema,
  dialectFor,
  readColumns,
  resolveSyncOptions,
  syncSqlSchema,
} from "../../lib/index";
import { clientFor, forEachSqlBackend, runPrefix } from "../helpers/backends";
import {
  backendOf,
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

  /** A fresh prefix, with the fixture's tables recorded for dropping. */
  const prefixed = (): string => {
    const prefix = runPrefix();
    const { items, log } = fixtureTables(prefix);
    made.push(items, log);
    return prefix;
  };

  /** Creates the whole fixture under a fresh prefix. */
  const created = async (): Promise<string> => {
    const prefix = prefixed();
    await runStatements(
      sql(),
      dialect,
      createSchema(fixtureDefinition(prefix, dialect), dialect),
    );
    return prefix;
  };

  /** Syncs the fixture under `prefix` with `options`. */
  const sync = async (
    prefix: string,
    options: Parameters<typeof resolveSyncOptions>[0] = {},
  ) =>
    await syncSqlSchema(
      backendOf(sql()),
      dialect,
      fixtureDefinition(prefix, dialect),
      resolveSyncOptions(options),
    );

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

  describe(`${backend.name}: the baseline`, () => {
    it("a freshly created schema reports no drift, dry run or not", async () => {
      const prefix = await created();
      expect(await sync(prefix, { dryRun: true })).toEqual([]);
      expect(await sync(prefix, { alterColumns: true })).toEqual([]);
    });

    it("creating it twice is repeatable", async () => {
      const prefix = await created();
      await runStatements(
        sql(),
        dialect,
        createSchema(fixtureDefinition(prefix, dialect), dialect),
      );
      expect(await sync(prefix)).toEqual([]);
    });

    it("readColumns finds both tables, matched back by name", async () => {
      const prefix = await created();
      const { items, log } = fixtureTables(prefix);
      const columns = await readColumns(backendOf(sql()), dialect, [
        items,
        log,
        `${prefix}absent`,
      ]);
      expect([...columns.keys()].sort()).toEqual([items, log].sort());
      expect(
        columns
          .get(items)!
          .map((row) => String(row.name))
          .sort(),
      ).toEqual(["at", "body", "data", "due", "id", "ip", "n", "name", "note"]);
    });

    it("a table that does not exist yet is left to createSchema: no column change, only its indexes", async () => {
      // As in bun-jobs, where createSchema always runs first: the columns of a
      // missing table are not compared, but its indexes read as missing.
      const prefix = prefixed();
      const plan = await sync(prefix, { dryRun: true });
      expect(plan.length).toBeGreaterThan(0);
      expect(plan.every((change) => change.kind === "create-index")).toBe(true);
    });
  });

  describe(`${backend.name}: drift`, () => {
    it("adds a column the table lacks, as a safe change", async () => {
      const prefix = await created();
      const { log } = fixtureTables(prefix);
      await sql().unsafe(`DROP TABLE ${log}`);
      await sql().unsafe(
        `CREATE TABLE ${log} (seq ${dialect.serialType}, item ${dialect.idType} NOT NULL)`,
      );
      const plan = await sync(prefix, { dryRun: true });
      expect(plan).toContainEqual(
        expect.objectContaining({
          kind: "add-column",
          table: log,
          target: "line",
          blocking: false,
          applied: false,
        }),
      );
      const applied = await sync(prefix);
      expect(applied.find((change) => change.target === "line")?.applied).toBe(
        true,
      );
      expect(await sync(prefix)).toEqual(
        // The log's index went with the table; it is created by the same sync.
        [],
      );
    });

    it("creates an index the table lacks; blocking only on SQLite", async () => {
      const prefix = await created();
      const name = `ix_${prefix}items_at`;
      await sql().unsafe(dialect.dropIndex(name, fixtureTables(prefix).items));
      const plan = await sync(prefix, { dryRun: true });
      expect(plan).toEqual([
        expect.objectContaining({
          kind: "create-index",
          target: name,
          blocking: backend.name === "sqlite",
          applied: false,
        }),
      ]);
      expect((await sync(prefix))[0]?.applied).toBe(true);
      expect(await sync(prefix)).toEqual([]);
    });

    it("drops an ix_ index it no longer defines, and leaves a hand-made one alone", async () => {
      const prefix = await created();
      const { items } = fixtureTables(prefix);
      const retired = `ix_${prefix}items_old`;
      const handMade = `hand_${prefix}items_n`;
      await sql().unsafe(`CREATE INDEX ${retired} ON ${items} (n)`);
      await sql().unsafe(`CREATE INDEX ${handMade} ON ${items} (n, at)`);
      const plan = await sync(prefix, { dryRun: true });
      expect(plan).toEqual([
        expect.objectContaining({
          kind: "drop-index",
          target: retired,
          blocking: false,
        }),
      ]);
      // indexes: false declines it.
      expect((await sync(prefix, { indexes: false }))[0]?.applied).toBe(false);
      expect((await sync(prefix))[0]?.applied).toBe(true);
      expect(await sync(prefix)).toEqual([]);
    });

    it("rebuilds an index whose predicate changed, where the engine has partial indexes", async () => {
      const prefix = await created();
      const { items } = fixtureTables(prefix);
      const name = `ix_${prefix}items_due`;
      await sql().unsafe(dialect.dropIndex(name, items));
      await sql().unsafe(`CREATE INDEX ${name} ON ${items} (due)`);
      const plan = await sync(prefix, { dryRun: true });
      if (dialect.partialIndex("1 = 1") === "") {
        // MySQL and MariaDB index every row anyway: nothing to rebuild.
        expect(plan).toEqual([]);
        return;
      }
      expect(plan.map((change) => change.kind)).toEqual([
        "drop-index",
        "create-index",
      ]);
      await sync(prefix);
      expect(await sync(prefix)).toEqual([]);
    });

    it("rebuilds an index whose columns changed, where the engine lists them", async () => {
      const prefix = await created();
      const { log } = fixtureTables(prefix);
      const name = `ix_${prefix}log_items`;
      await sql().unsafe(dialect.dropIndex(name, log));
      await sql().unsafe(`CREATE INDEX ${name} ON ${log} (item, seq)`);
      const plan = await sync(prefix, { dryRun: true });
      if (backend.name === "mysql" || backend.name === "mariadb") {
        expect(plan.map((change) => change.kind)).toEqual([
          "drop-index",
          "create-index",
        ]);
        await sync(prefix);
        expect(await sync(prefix)).toEqual([]);
      } else {
        // Postgres and SQLite render a definition and compare only its
        // predicate and collations: a column change goes unseen there.
        expect(plan).toEqual([]);
      }
    });

    it("reports a retyped column as blocking and changes it only when asked", async () => {
      const prefix = await created();
      const { log } = fixtureTables(prefix);
      await sql().unsafe(`DROP TABLE ${log}`);
      await sql().unsafe(
        `CREATE TABLE ${log} (seq ${dialect.serialType}, item ${dialect.idType} NOT NULL, line INTEGER)`,
      );
      await sql().unsafe(`CREATE INDEX ix_${prefix}log_items ON ${log} (item)`);
      const plan = await sync(prefix);
      if (backend.name === "sqlite") {
        // SQLite cannot retype a column without rebuilding the table.
        expect(plan).toEqual([]);
        return;
      }
      expect(plan).toEqual([
        expect.objectContaining({
          kind: "alter-column",
          target: "line",
          blocking: true,
          applied: false,
        }),
      ]);
      const applied = await sync(prefix, { alterColumns: true });
      expect(applied[0]?.applied).toBe(true);
      expect(await sync(prefix)).toEqual([]);
    });

    it("applies nothing on a dry run, however much it finds", async () => {
      const prefix = await created();
      const { items } = fixtureTables(prefix);
      await sql().unsafe(dialect.dropIndex(`ix_${prefix}items_at`, items));
      await sql().unsafe(`CREATE INDEX ix_${prefix}items_old ON ${items} (n)`);
      const plan = await sync(prefix, { dryRun: true, alterColumns: true });
      expect(plan).toHaveLength(2);
      expect(plan.every((change) => !change.applied)).toBe(true);
      expect(await sync(prefix, { dryRun: true })).toEqual(plan);
    });

    if (backend.name === "mysql" || backend.name === "mariadb") {
      it("reports an identifier in a case-insensitive collation, with the collation", async () => {
        const prefix = prefixed();
        const definition = fixtureDefinition(prefix, dialect);
        const { items } = fixtureTables(prefix);
        await runStatements(sql(), dialect, createSchema(definition, dialect));
        await sql().unsafe(
          `ALTER TABLE ${items} MODIFY COLUMN id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL`,
        );
        const columns = await readColumns(backendOf(sql()), dialect, [items]);
        expect(collationDrift(dialect, definition.tables, columns)).toEqual([
          expect.objectContaining({
            table: items,
            column: "id",
            found: "utf8mb4_general_ci",
          }),
        ]);
        const plan = await sync(prefix);
        expect(plan).toEqual([
          expect.objectContaining({
            kind: "alter-column",
            target: "id",
            blocking: true,
            applied: false,
            collation: expect.objectContaining({ found: "utf8mb4_general_ci" }),
          }),
        ]);
        await sync(prefix, { alterColumns: true });
        expect(await sync(prefix)).toEqual([]);
      });
    }
  });
}

await forEachSqlBackend(registerSuite);
