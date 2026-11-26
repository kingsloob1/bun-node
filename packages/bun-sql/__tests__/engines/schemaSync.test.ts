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
import type { SchemaDefinition, SchemaSyncOptions } from "../../lib/index";
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

    it("drops the ix_ indexes of a table with no index left in the definition (#888)", async () => {
      const prefix = await created();
      const { log } = fixtureTables(prefix);
      const handMade = `hand_${prefix}log_line`;
      await sql().unsafe(`CREATE INDEX ${handMade} ON ${log} (seq)`);
      // The log's one index leaves the definition: the table has none left.
      const full = fixtureDefinition(prefix, dialect);
      const definition = {
        ...full,
        indexes: full.indexes.filter((index) => index.table !== log),
      };
      const syncWithout = async (
        options: Parameters<typeof resolveSyncOptions>[0] = {},
      ) =>
        await syncSqlSchema(
          backendOf(sql()),
          dialect,
          definition,
          resolveSyncOptions(options),
        );
      // Reported, even on a dry run; the hand-made index is left alone.
      expect(await syncWithout({ dryRun: true })).toEqual([
        expect.objectContaining({
          kind: "drop-index",
          table: log,
          target: `ix_${prefix}log_items`,
          blocking: false,
          applied: false,
        }),
      ]);
      expect((await syncWithout())[0]?.applied).toBe(true);
      expect(await syncWithout()).toEqual([]);
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

  describe(`${backend.name}: quoted identifiers and unique indexes (#889)`, () => {
    /** A table named as someone else's schema names it: mixed case, reserved words, one unique column. */
    const accounts = (prefix: string, unique = true): SchemaDefinition => {
      const table = `${prefix}Account`;
      return {
        tables: [
          {
            name: table,
            primaryKey: ["id"],
            columns: [
              { name: "id", type: dialect.idType, suffix: "NOT NULL" },
              { name: "user", type: dialect.idType, suffix: "NOT NULL" },
              { name: "key", type: dialect.longTextType },
              { name: "email", type: dialect.idType, suffix: "NOT NULL" },
              { name: "emailVerified", type: "INTEGER" },
            ],
          },
        ],
        indexes: [
          {
            name: `ix_${prefix}account_user`,
            table,
            columns: ["user", "emailVerified"],
          },
          ...(unique
            ? [
                {
                  name: `ux_${prefix}account_email`,
                  table,
                  columns: ["email"],
                  unique: true,
                },
              ]
            : []),
        ],
      };
    };
    /** Creates `definition` quoted, its table recorded (quoted) for dropping. */
    const createQuoted = async (definition: SchemaDefinition) => {
      for (const table of definition.tables)
        made.push(dialect.quote(table.name));
      await runStatements(
        sql(),
        dialect,
        createSchema(definition, dialect, { quoteIdentifiers: true }),
      );
    };
    /** Syncs `definition` with quoted identifiers and `options`. */
    const syncQuoted = async (
      definition: SchemaDefinition,
      options: SchemaSyncOptions = {},
    ) =>
      await syncSqlSchema(
        backendOf(sql()),
        dialect,
        definition,
        resolveSyncOptions({ ...options, quoteIdentifiers: true }),
      );

    it("creates the schema and reads it back with no drift", async () => {
      const definition = accounts(runPrefix());
      await createQuoted(definition);
      expect(await syncQuoted(definition, { dryRun: true })).toEqual([]);
      expect(await syncQuoted(definition)).toEqual([]);
    });

    it("negative control: unquoted, the same names do not survive the engine", async () => {
      const prefix = runPrefix();
      const definition = accounts(prefix);
      made.push(
        definition.tables[0].name,
        dialect.quote(definition.tables[0].name),
      );
      const outcome = await runStatements(
        sql(),
        dialect,
        createSchema(definition, dialect),
      ).then(
        async () =>
          // SQLite takes the words and folds no case: the one engine where
          // the unquoted DDL round-trips.
          (
            await syncSqlSchema(
              backendOf(sql()),
              dialect,
              definition,
              resolveSyncOptions({}),
            )
          ).length === 0
            ? "round-trips"
            : "drifts",
        () => "refused",
      );
      expect(outcome).toBe(
        backend.name === "sqlite" ? "round-trips" : "refused",
      );
    });

    it("adds a missing camelCase column under its quoted name, once", async () => {
      const definition = accounts(runPrefix());
      await createQuoted(definition);
      const table = dialect.quote(definition.tables[0].name);
      if (backend.name === "sqlite") {
        // SQLite drops a column only without an index on it.
        await sql().unsafe(`DROP INDEX ${definition.indexes[0].name}`);
      }
      await sql().unsafe(
        `ALTER TABLE ${table} DROP COLUMN ${dialect.quote("emailVerified")}`,
      );
      const plan = await syncQuoted(definition, { dryRun: true });
      expect(plan).toContainEqual(
        expect.objectContaining({
          kind: "add-column",
          target: "emailVerified",
          statement: expect.stringContaining(dialect.quote("emailVerified")),
        }),
      );
      await syncQuoted(definition);
      expect(await syncQuoted(definition)).toEqual([]);
    });

    it("creates a missing unique index, which then refuses a duplicate", async () => {
      const prefix = runPrefix();
      await createQuoted(accounts(prefix, false));
      const definition = accounts(prefix);
      expect(await syncQuoted(definition, { dryRun: true })).toEqual([
        expect.objectContaining({
          kind: "create-index",
          target: `ux_${prefix}account_email`,
          statement: expect.stringMatching(/^CREATE UNIQUE INDEX /),
        }),
      ]);
      await syncQuoted(definition);
      expect(await syncQuoted(definition)).toEqual([]);
      const table = dialect.quote(definition.tables[0].name);
      const insert = (id: string) =>
        sql().unsafe(
          `INSERT INTO ${table} (${dialect.quote("id")}, ${dialect.quote("user")}, ${dialect.quote("email")}) VALUES ('${id}', 'u', 'a@example.com')`,
        );
      await insert("1");
      await expect(insert("2")).rejects.toThrow();
    });

    it("never drops a unique index: not when it leaves the definition, not when it drifts", async () => {
      const prefix = runPrefix();
      const definition = accounts(prefix);
      await createQuoted(definition);
      const table = definition.tables[0].name;
      // A unique index named in the driver's own convention.
      const uniqueIx = `ix_${prefix}account_key`;
      await sql().unsafe(
        `CREATE UNIQUE INDEX ${uniqueIx} ON ${dialect.quote(table)} (${dialect.quote("email")}, ${dialect.quote("user")})`,
      );
      // Not in the definition: an ix_ index, but unique, so it stays.
      expect(await syncQuoted(definition, { dryRun: true })).toEqual([]);
      // In the definition with other columns: drifted, but unique, so it stays.
      const drifted: SchemaDefinition = {
        ...definition,
        indexes: [
          ...definition.indexes,
          { name: uniqueIx, table, columns: ["email"], unique: true },
        ],
      };
      expect(await syncQuoted(drifted, { dryRun: true })).toEqual([]);
    });

    it("rebuilds unique a plain index the definition now marks unique", async () => {
      const prefix = runPrefix();
      const plain = accounts(prefix, false);
      await createQuoted(plain);
      const definition: SchemaDefinition = {
        ...plain,
        indexes: plain.indexes.map((index) => ({ ...index, unique: true })),
      };
      const plan = await syncQuoted(definition, { dryRun: true });
      expect(plan.map((change) => `${change.kind} ${change.target}`)).toEqual([
        `drop-index ix_${prefix}account_user`,
        `create-index ix_${prefix}account_user`,
      ]);
      await syncQuoted(definition);
      expect(await syncQuoted(definition)).toEqual([]);
    });
  });
}

await forEachSqlBackend(registerSuite);
