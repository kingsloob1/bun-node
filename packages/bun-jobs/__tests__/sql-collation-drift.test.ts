import type { LogEvent } from "@kingsleyweb/bun-common";
import type { SqlColumnRow } from "../lib/drivers/sql/sync";
import type { SqlDriverOptions } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { SQL } from "bun";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { resetCollationWarnings } from "../lib/drivers/sql/collation-guard";
import { createSchema, schemaDefinition } from "../lib/drivers/sql/schema";
import {
  collationDrift,
  collationDriftWarning,
  readColumns,
} from "../lib/drivers/sql/sync";
import { dialectFor, resolveDriver, SQL_TABLES, SqlDriver } from "../lib/index";
import { takeBooleanParam } from "../lib/shared/connection";
import { makeTmpDir } from "./helpers";

/**
 * The warning connecting gives for identifier columns in the wrong collation.
 *
 * A MySQL or MariaDB table created before identifiers were declared binary
 * keeps its case- and accent-insensitive collation for good (`CREATE TABLE IF
 * NOT EXISTS`), and returns wrong answers: `Report` and `report` are one key,
 * and a prefix listing's range scan comes back empty. `syncSchema` can repair
 * it, but only a user who knows to ask would. So connecting says so, once.
 *
 * Every server case builds its own tables under a prefix nothing else uses,
 * damages them on purpose, and drops exactly those tables afterwards — never
 * a `LIKE` sweep, and never the default-prefix `bun_jobs_*` tables, which the
 * shared servers keep as they are.
 */

/** The table names under `prefix`, as `schemaDefinition` wants them. */
function tablesFor(prefix: string) {
  return Object.fromEntries(
    SQL_TABLES.map((table) => [table, `${prefix}${table}`]),
  ) as Record<(typeof SQL_TABLES)[number], string>;
}

/** The `warn` records a test logger collected. */
function warnings(events: LogEvent[]): LogEvent[] {
  return events.filter((event) => event.level === "warn");
}

/** Drivers to close when the test that made them ends. */
const drivers: SqlDriver[] = [];

// The warning is given once per process for a set of tables, and `bun test`
// runs every file in one process. Each case uses tables of its own, so no key
// repeats, but a case asserting "exactly one" must not depend on what ran
// before it, in this file or another: it starts from an empty guard.
beforeEach(() => {
  resetCollationWarnings();
});

afterEach(async () => {
  await Promise.allSettled(
    drivers.splice(0, drivers.length).map((driver) => driver.close()),
  );
});

describe("collation drift: the comparison", () => {
  const dialect = dialectFor("mariadb");
  const tables = tablesFor("cd_unit_");
  const definition = schemaDefinition(tables, dialect);

  /**
   * Every column as a freshly created table would report it: the declared
   * collation where there is one, the normalised type throughout.
   */
  function asCreated(): Map<string, SqlColumnRow[]> {
    return new Map(
      definition.tables.map((table) => [
        table.name,
        table.columns.map((column) => ({
          tbl: table.name,
          name: column.name,
          type: dialect.normalizeType(column.type),
          collation: /COLLATE\s+(\w+)/i.exec(column.type)?.[1] ?? null,
        })),
      ]),
    );
  }

  /** `columns` with one column's fields replaced. */
  function altered(
    columns: Map<string, SqlColumnRow[]>,
    table: string,
    column: string,
    change: Partial<SqlColumnRow>,
  ): Map<string, SqlColumnRow[]> {
    columns.set(
      table,
      columns
        .get(table)!
        .map((row) => (row.name === column ? { ...row, ...change } : row)),
    );
    return columns;
  }

  it("finds nothing in a schema as the driver creates it", () => {
    expect(collationDrift(dialect, definition.tables, asCreated())).toEqual([]);
  });

  it("finds an identifier column in another collation", () => {
    const columns = altered(asCreated(), tables.kv, "kv_key", {
      collation: "UTF8MB4_UCA1400_AI_CI",
    });

    expect(collationDrift(dialect, definition.tables, columns)).toEqual([
      {
        table: tables.kv,
        column: "kv_key",
        found: "utf8mb4_uca1400_ai_ci",
        expected: "utf8mb4_nopad_bin",
      },
    ]);
  });

  it("ignores a type difference, which costs speed rather than answers", () => {
    const columns = altered(asCreated(), tables.jobs, "processed_on", {
      type: "int",
    });
    altered(columns, tables.jobs, "data", { type: "mediumtext" });

    expect(collationDrift(dialect, definition.tables, columns)).toEqual([]);
  });

  it("still reports the collation of a column whose type differs too", () => {
    const columns = altered(asCreated(), tables.jobs, "name", {
      type: "mediumtext",
      collation: "utf8mb4_general_ci",
    });

    expect(
      collationDrift(dialect, definition.tables, columns).map((d) => d.column),
    ).toEqual(["name"]);
  });

  it("skips a table that does not exist yet", () => {
    const columns = asCreated();
    columns.delete(tables.kv);

    expect(collationDrift(dialect, definition.tables, columns)).toEqual([]);
  });

  it("says each table once, every column, both collations and the fix", () => {
    const { message, fields } = collationDriftWarning([
      {
        table: "t_kv",
        column: "ns",
        found: "utf8mb4_general_ci",
        expected: "utf8mb4_nopad_bin",
      },
      {
        table: "t_kv",
        column: "kv_key",
        found: "utf8mb4_general_ci",
        expected: "utf8mb4_nopad_bin",
      },
      {
        table: "t_jobs",
        column: "id",
        found: "utf8mb4_bin",
        expected: "utf8mb4_nopad_bin",
      },
    ]);

    expect(message).toStartWith("3 identifier columns");
    expect(message).toContain(
      "t_kv: ns, kv_key (utf8mb4_general_ci, expected utf8mb4_nopad_bin)",
    );
    expect(message).toContain(
      "t_jobs: id (utf8mb4_bin, expected utf8mb4_nopad_bin)",
    );
    expect(message).toContain("syncSchema({ alterColumns: true })");
    expect(message).toContain("lock");
    expect(fields.fix).toBe("syncSchema({ alterColumns: true })");
    expect(fields.columns).toHaveLength(3);
  });
});

describe("collation drift: SQLite", () => {
  it("reads every table's columns in one query, and never warns", async () => {
    const dir = await makeTmpDir("collation-drift");
    const file = join(dir.path, "jobs.db");
    const { logger, events } = createTestLogger();
    const driver = new SqlDriver({ url: `sqlite://${file}`, logger });
    drivers.push(driver);
    await driver.connect();

    // SQLite reports no collation and the driver declares none: `TEXT` is
    // `BINARY`, exact already.
    expect(warnings(events)).toEqual([]);

    const tables = schemaDefinition(
      tablesFor("bun_jobs_"),
      driver.dialect,
    ).tables;
    const sql = new SQL(`sqlite://${file}`);
    try {
      const columns = await readColumns(
        { all: async (text, params) => await sql.unsafe(text, params) },
        driver.dialect,
        tables.map((table) => table.name),
      );
      expect([...columns.keys()].sort()).toEqual(
        tables.map((table) => table.name).sort(),
      );
      for (const table of tables) {
        expect(columns.get(table.name)!.map((row) => row.name)).toEqual(
          table.columns.map((column) => column.name),
        );
      }
    } finally {
      await sql.close();
      await driver.close();
      await dir.cleanup();
    }
  });
});

const POSTGRES = process.env.BUN_JOBS_TEST_POSTGRES_URL;

describe.skipIf(!POSTGRES)("collation drift: Postgres", () => {
  it("never warns: the driver declares no column collation there", async () => {
    const prefix = `cd_pg_${Math.random().toString(36).slice(2, 8)}_`;
    const { logger, events } = createTestLogger();
    const driver = new SqlDriver({
      url: POSTGRES,
      tablePrefix: prefix,
      notify: false,
      logger,
    });
    drivers.push(driver);
    const admin = new SQL(POSTGRES!);

    try {
      await driver.connect();
      expect(warnings(events)).toEqual([]);
    } finally {
      await driver.close();
      for (const table of Object.values(tablesFor(prefix))) {
        await admin
          .unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`)
          .catch(() => undefined);
      }
      await admin.close();
    }
  }, 45_000);
});

/**
 * MySQL and MariaDB, when configured: the engines where the driver declares
 * identifier collations, and where the default is not exact.
 */
const MYSQL_FAMILY: {
  /** Which engine. */
  adapter: "mysql" | "mariadb";
  /** Its server, or undefined when the suite has none. */
  url: string | undefined;
  /** The collation the driver declares for identifiers there. */
  binary: string;
  /**
   * A case- and accent-insensitive collation to damage a column with: the one
   * an older version's tables actually carry on MariaDB 11, and MySQL's
   * classic default.
   */
  legacy: string;
}[] = [
  {
    adapter: "mariadb",
    url: process.env.BUN_JOBS_TEST_MARIADB_URL,
    binary: "utf8mb4_nopad_bin",
    legacy: "utf8mb4_uca1400_ai_ci",
  },
  {
    adapter: "mysql",
    url: process.env.BUN_JOBS_TEST_MYSQL_URL,
    binary: "utf8mb4_0900_bin",
    legacy: "utf8mb4_general_ci",
  },
];

/** Clients opened for the DDL, closed when the file ends. */
const clients: SQL[] = [];

afterAll(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
});

for (const { adapter, url, binary, legacy } of MYSQL_FAMILY) {
  /** Table prefixes this engine's cases made, dropped as each case ends. */
  const prefixes: string[] = [];
  let shared: SQL | undefined;

  /**
   * A client for the DDL the driver has no API for. Takes the URL's
   * `allowPublicKeyRetrieval` as an option, as the driver does: Bun honours it
   * there and ignores it in a URL.
   */
  const client = (): SQL => {
    if (!shared) {
      const { url: bare, value } = takeBooleanParam(
        url!,
        "allowPublicKeyRetrieval",
      );
      shared = new SQL({
        url: bare,
        ...(value === undefined ? {} : { allowPublicKeyRetrieval: value }),
      });
      clients.push(shared);
    }
    return shared;
  };

  /** A prefix nothing else uses, remembered so exactly its tables are dropped. */
  const prefixFor = (label: string): string => {
    const prefix = `cd_${label}_${Math.random().toString(36).slice(2, 8)}_`;
    prefixes.push(prefix);
    return prefix;
  };

  /** A driver over `prefix`'s tables, logging into a fresh test logger. */
  const driverFor = (
    prefix: string,
    options: Partial<SqlDriverOptions> = {},
  ): { driver: SqlDriver; events: LogEvent[] } => {
    const { logger, events } = createTestLogger();
    const driver = new SqlDriver({
      url,
      adapter,
      tablePrefix: prefix,
      logger,
      ...options,
    });
    drivers.push(driver);
    return { driver, events };
  };

  /** Creates `prefix`'s tables as the current driver would, and lets go. */
  const createFresh = async (prefix: string): Promise<void> => {
    const { driver } = driverFor(prefix);
    await driver.connect();
    await driver.close();
  };

  /** Recollates one identifier column, as an older version created it. */
  const recollate = async (
    table: string,
    column: string,
    collation: string,
  ): Promise<void> => {
    await client().unsafe(
      `ALTER TABLE ${table} MODIFY COLUMN ${column} VARCHAR(191) CHARACTER SET utf8mb4 COLLATE ${collation} NOT NULL`,
    );
  };

  describe.skipIf(!url)(`collation drift: ${adapter}`, () => {
    afterEach(async () => {
      // Drivers first, so nothing holds these tables while they are dropped.
      // A driver closed here is closed again by the file's `afterEach`, which
      // is harmless.
      await Promise.allSettled(
        drivers.splice(0, drivers.length).map((driver) => driver.close()),
      );
      for (const prefix of prefixes.splice(0, prefixes.length)) {
        for (const table of SQL_TABLES) {
          await client()
            .unsafe(`DROP TABLE IF EXISTS ${prefix}${table}`)
            .catch(() => undefined);
        }
      }
    });

    it("gives no warning on a schema it just created", async () => {
      const prefix = prefixFor(`${adapter}_fresh`);
      const { driver, events } = driverFor(prefix);
      await driver.connect();

      // Created on this connect, and connected again over existing tables.
      const again = driverFor(prefix);
      await again.driver.connect();

      expect(warnings(events)).toEqual([]);
      expect(warnings(again.events)).toEqual([]);
    }, 45_000);

    it("warns once, naming the table, the column, both collations and the fix", async () => {
      const prefix = prefixFor(`${adapter}_drift`);
      const tables = tablesFor(prefix);
      await createFresh(prefix);
      await recollate(tables.kv, "kv_key", legacy);

      const { driver, events } = driverFor(prefix);
      await driver.connect();

      const warned = warnings(events);
      expect(warned).toHaveLength(1);
      expect(warned[0]!.message).toContain(
        `${tables.kv}: kv_key (${legacy}, expected ${binary})`,
      );
      expect(warned[0]!.message).toContain(
        "syncSchema({ alterColumns: true })",
      );
      expect(warned[0]!.fields).toEqual({
        columns: [
          {
            table: tables.kv,
            column: "kv_key",
            found: legacy,
            expected: binary,
          },
        ],
        fix: "syncSchema({ alterColumns: true })",
      });
      expect(warned[0]!.bindings).toMatchObject({ driver: "sql", adapter });

      // The same columns a sync would rewrite, and marked as such.
      const planned = await driver.syncSchema({ dryRun: true });
      expect(planned.map((c) => [c.kind, c.table, c.target])).toEqual([
        ["alter-column", tables.kv, "kv_key"],
      ]);
      expect(planned[0]!.collation).toEqual({
        found: legacy,
        expected: binary,
      });
    }, 45_000);

    it("warns once per connect, not once per table, over a whole legacy schema", async () => {
      const prefix = prefixFor(`${adapter}_legacy`);
      const tables = tablesFor(prefix);
      const legacyDialect = {
        ...dialectFor(adapter),
        idType: `VARCHAR(191) CHARACTER SET utf8mb4 COLLATE ${legacy}`,
        nameType: `TEXT CHARACTER SET utf8mb4 COLLATE ${legacy}`,
        stampType: `TEXT CHARACTER SET utf8mb4 COLLATE ${legacy}`,
      };
      for (const statement of createSchema(tables, legacyDialect)) {
        await client().unsafe(statement);
      }

      const { driver, events } = driverFor(prefix);
      await driver.connect();

      const warned = warnings(events);
      expect(warned).toHaveLength(1);
      const columns = (
        warned[0]!.fields as { columns: { table: string; column: string }[] }
      ).columns;
      const planned = (await driver.syncSchema({ dryRun: true })).filter(
        (change) => change.collation,
      );
      // Exactly the columns an `alterColumns` sync would recollate.
      expect(columns.map((c) => `${c.table}.${c.column}`).sort()).toEqual(
        planned.map((c) => `${c.table}.${c.target}`).sort(),
      );
      expect(new Set(columns.map((c) => c.table)).size).toBeGreaterThan(3);
      for (const table of new Set(columns.map((c) => c.table))) {
        expect(warned[0]!.message).toContain(`${table}: `);
      }
    }, 60_000);

    it("gives no warning once syncSchema({ alterColumns: true }) has repaired it", async () => {
      const prefix = prefixFor(`${adapter}_fixed`);
      const tables = tablesFor(prefix);
      await createFresh(prefix);
      await recollate(tables.kv, "kv_key", legacy);
      await recollate(tables.jobs, "id", legacy);

      const first = driverFor(prefix);
      await first.driver.connect();
      expect(warnings(first.events)).toHaveLength(1);
      const applied = await first.driver.syncSchema({ alterColumns: true });
      expect(applied.filter((c) => c.collation && c.applied)).toHaveLength(2);

      // The first connect used up the process's warning for these tables, so
      // without a reset the silence below would prove nothing about the repair.
      resetCollationWarnings();
      const second = driverFor(prefix);
      await second.driver.connect();
      expect(warnings(second.events)).toEqual([]);
    }, 60_000);

    it("gives no warning for a type difference alone", async () => {
      const prefix = prefixFor(`${adapter}_type`);
      const tables = tablesFor(prefix);
      await createFresh(prefix);
      await client().unsafe(
        `ALTER TABLE ${tables.jobs} MODIFY COLUMN processed_on INT`,
      );

      const { driver, events } = driverFor(prefix);
      await driver.connect();
      expect(warnings(events)).toEqual([]);

      // The difference is real, and a sync would still report it — as a
      // retype, which is not a correctness problem.
      const planned = await driver.syncSchema({ dryRun: true });
      expect(planned.map((c) => [c.kind, c.target])).toEqual([
        ["alter-column", "processed_on"],
      ]);
      expect(planned[0]!.collation).toBeUndefined();
    }, 45_000);

    it("still warns with syncSchema: true, which leaves collations alone", async () => {
      const prefix = prefixFor(`${adapter}_sync`);
      const tables = tablesFor(prefix);
      await createFresh(prefix);
      await recollate(tables.kv, "kv_key", legacy);

      const { driver, events } = driverFor(prefix, { syncSchema: true });
      await driver.connect();

      const warned = warnings(events);
      expect(warned).toHaveLength(1);
      expect(warned[0]!.message).toContain(`${tables.kv}: kv_key`);
    }, 45_000);

    it("gives no warning when the connect's own sync repairs it", async () => {
      const prefix = prefixFor(`${adapter}_syncfix`);
      const tables = tablesFor(prefix);
      await createFresh(prefix);
      await recollate(tables.kv, "kv_key", legacy);

      const { driver, events } = driverFor(prefix, {
        syncSchema: { alterColumns: true },
      });
      await driver.connect();
      expect(warnings(events)).toEqual([]);

      const [row] = (await client().unsafe(
        `SELECT COLLATION_NAME AS c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${tables.kv}'
            AND COLUMN_NAME = 'kv_key'`,
      )) as { c: string }[];
      expect(row?.c).toBe(binary);
    }, 45_000);

    it("warns through the logger of a component that builds the driver from a config", async () => {
      const prefix = prefixFor(`${adapter}_config`);
      const tables = tablesFor(prefix);
      await createFresh(prefix);
      await recollate(tables.kv, "ns", legacy);

      const { logger, events } = createTestLogger();
      const { driver, owned } = resolveDriver(
        { type: "sql", url: url!, adapter, tablePrefix: prefix },
        undefined,
        logger,
      );
      expect(owned).toBe(true);
      drivers.push(driver as SqlDriver);
      await driver.connect();

      const warned = warnings(events);
      expect(warned).toHaveLength(1);
      expect(warned[0]!.message).toContain(`${tables.kv}: ns (${legacy}`);
    }, 45_000);

    it("warns with a dry-run sync on connect, which applies nothing", async () => {
      const prefix = prefixFor(`${adapter}_dry`);
      const tables = tablesFor(prefix);
      await createFresh(prefix);
      await recollate(tables.kv, "kv_key", legacy);

      const { driver, events } = driverFor(prefix, {
        syncSchema: { alterColumns: true, dryRun: true },
      });
      await driver.connect();
      expect(warnings(events)).toHaveLength(1);
    }, 45_000);
  });
}
