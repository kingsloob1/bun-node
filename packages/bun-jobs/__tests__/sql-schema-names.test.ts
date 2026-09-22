import type { SQL } from "bun";
import type { SchemaTableNames } from "../lib/drivers/sql/schema";
import type { SqlAdapter } from "../lib/index";
import process from "node:process";
import { SQL as BunSQL } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import { createSchema, schemaDefinition } from "../lib/drivers/sql/schema";
import { ConfigError, dialectFor, SQL_TABLES } from "../lib/index";
import { takeBooleanParam } from "../lib/shared/connection";

/**
 * The SQL schema refuses a table it uses but was never given a name for.
 *
 * A Postgres table literally named `undefined` was once found on the shared
 * test server: `schema.ts` read `tables.logs` while `SQL_TABLES` did not list
 * `logs` yet, so the driver ran `CREATE TABLE IF NOT EXISTS undefined`. These
 * cases pin the guard that makes that a `ConfigError` naming the key, before
 * any statement is built — and that the normal paths (every table named; the
 * three analytics tables left out) are unchanged.
 *
 * SQLite runs everywhere; the three servers when their URL is set. **Every
 * table this file could create is dropped by its exact name**, never by a
 * `LIKE` sweep: other sessions share these servers.
 */

/** Every table named, the way the driver names them. */
function allNames(prefix: string): Required<SchemaTableNames> {
  return Object.fromEntries(
    SQL_TABLES.map((table) => [table, `${prefix}${table}`]),
  ) as Required<SchemaTableNames>;
}

/** The eight tables alone: a caller that names no analytics table. */
function shippedNames(prefix: string): SchemaTableNames {
  const {
    queue_metrics: _q,
    worker_metrics: _w,
    runner_metrics: _r,
    ...shipped
  } = allNames(prefix);
  return shipped;
}

/**
 * `names` with `key` removed, typed as if it were complete — exactly what the
 * old bug handed the schema: an object the types called whole, missing a key.
 */
function without(
  names: SchemaTableNames,
  key: keyof SchemaTableNames,
): SchemaTableNames {
  const copy: Partial<SchemaTableNames> = { ...names };
  delete copy[key];
  return copy as SchemaTableNames;
}

/** The `ConfigError` `run` throws, or a failure when it throws nothing. */
function configErrorOf(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected a ConfigError, and nothing was thrown");
}

const postgres = dialectFor("postgres");

describe("SQL schema: table names", () => {
  it("keeps a fully named schema unchanged: eleven tables, no undefined anywhere", () => {
    const { tables, indexes } = schemaDefinition(allNames("n_"), postgres);

    expect(tables.map((table) => table.name).sort()).toEqual(
      SQL_TABLES.map((table) => `n_${table}`).sort(),
    );
    expect(indexes.length).toBeGreaterThan(0);
    for (const index of indexes) {
      expect(index.name).not.toContain("undefined");
      expect(index.name.startsWith("ix_n_jobs_")).toBe(true);
    }
    for (const statement of createSchema(allNames("n_"), postgres)) {
      expect(statement).not.toContain("undefined");
    }
  });

  it("still leaves all three analytics tables out when none is named", () => {
    const { tables, indexes } = schemaDefinition(shippedNames("n_"), postgres);

    expect(tables).toHaveLength(8);
    expect(tables.map((table) => table.name)).not.toContain("n_queue_metrics");
    expect(indexes.map((index) => index.name)).not.toContain(
      "ix_n_jobs_qmx_prune",
    );
  });

  // Every key the schema uses, each missing in turn. `logs` is the one that
  // actually leaked; `jobs` is the one every index name is derived from.
  for (const key of SQL_TABLES.filter(
    (table) => !table.endsWith("_metrics") || table === "metrics",
  )) {
    it(`refuses a schema with no name for "${key}"`, () => {
      const error = configErrorOf(() =>
        schemaDefinition(without(allNames("n_"), key), postgres),
      );

      expect(error.message).toContain(`"${key}"`);
      expect(
        createSchema.bind(null, without(allNames("n_"), key), postgres),
      ).toThrow(ConfigError);
    });
  }

  it("refuses an empty or blank name instead of building DDL around it", () => {
    for (const blank of ["", "  "]) {
      const error = configErrorOf(() =>
        schemaDefinition({ ...allNames("n_"), logs: blank }, postgres),
      );
      expect(error.message).toContain(`"logs"`);
    }
  });

  it("refuses a name that is not a string at all", () => {
    const names = {
      ...allNames("n_"),
      jobs: null,
    } as unknown as SchemaTableNames;
    expect(
      configErrorOf(() => schemaDefinition(names, postgres)).message,
    ).toContain(`"jobs"`);
  });

  it("never derives an index name from a missing jobs table", () => {
    // Every index is named `ix_<jobs>_…`, so a missing `jobs` would otherwise
    // name all of them `ix_undefined_…`.
    expect(() =>
      createSchema(without(allNames("n_"), "jobs"), postgres),
    ).toThrow(`"jobs"`);
  });

  it("refuses one analytics table named without the other two", () => {
    // The old behaviour quietly dropped all three, including the one asked
    // for; the schema uses all three together or none.
    const error = configErrorOf(() =>
      schemaDefinition(
        { ...shippedNames("n_"), queue_metrics: "n_queue_metrics" },
        postgres,
      ),
    );
    expect(error.message).toContain(`"worker_metrics"`);

    for (const key of [
      "queue_metrics",
      "worker_metrics",
      "runner_metrics",
    ] as const) {
      expect(() =>
        schemaDefinition(without(allNames("n_"), key), postgres),
      ).toThrow(ConfigError);
    }
  });
});

/* --- against a real database: nothing is created ----------------------- */

/** One engine this file can run against. */
interface Engine {
  /** Which engine. */
  adapter: SqlAdapter;
  /** Its connection URL, or `undefined` when the suite has none. */
  url: string | undefined;
  /** The variable that would provide one. */
  variable: string;
}

const ENGINES: Engine[] = [
  { adapter: "sqlite", url: "sqlite://:memory:", variable: "(always)" },
  {
    adapter: "postgres",
    variable: "BUN_JOBS_TEST_POSTGRES_URL",
    url: process.env.BUN_JOBS_TEST_POSTGRES_URL,
  },
  {
    adapter: "mysql",
    variable: "BUN_JOBS_TEST_MYSQL_URL",
    url: process.env.BUN_JOBS_TEST_MYSQL_URL,
  },
  {
    adapter: "mariadb",
    variable: "BUN_JOBS_TEST_MARIADB_URL",
    url: process.env.BUN_JOBS_TEST_MARIADB_URL,
  },
];

/** Raw clients opened here, closed when the suite ends. */
const clients: SQL[] = [];
/** Exact table names to drop at the end, should any of them exist. */
const toDrop: { client: SQL; table: string }[] = [];

afterAll(async () => {
  for (const { client, table } of toDrop) {
    await client.unsafe(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
  }
  await Promise.allSettled(clients.map(async (each) => await each.close()));
});

/** A raw client, `allowPublicKeyRetrieval` taken out of the URL as Bun needs. */
function rawClient(url: string): SQL {
  const { url: bare, value } = takeBooleanParam(url, "allowPublicKeyRetrieval");
  const client = new BunSQL({
    url: bare,
    ...(value === undefined ? {} : { allowPublicKeyRetrieval: value }),
  });
  clients.push(client);
  return client;
}

/** Which of `names` exist as tables, by exact name. */
async function existing(
  client: SQL,
  adapter: SqlAdapter,
  names: readonly string[],
): Promise<string[]> {
  const list = names.map((name) => `'${name}'`).join(", ");
  const text =
    adapter === "sqlite"
      ? `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${list})`
      : adapter === "postgres"
        ? `SELECT table_name AS name FROM information_schema.tables
           WHERE table_schema = current_schema() AND table_name IN (${list})`
        : `SELECT TABLE_NAME AS name FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${list})`;
  const rows = (await client.unsafe(text)) as { name: string }[];
  return rows.map((row) => row.name).sort();
}

for (const engine of ENGINES) {
  const run = engine.url ? describe : describe.skip;
  const title = engine.url
    ? `SQL schema names on ${engine.adapter}`
    : `SQL schema names on ${engine.adapter} (skipped: ${engine.variable} unset)`;

  run(title, () => {
    it("creates no table when a used table has no name", async () => {
      const client = rawClient(engine.url!);
      const dialect = dialectFor(engine.adapter);
      const prefix = `sng_${Math.random().toString(36).slice(2, 8)}_`;
      const names = allNames(prefix);
      const ours = Object.values(names);
      for (const table of ours) {
        toDrop.push({ client, table });
      }

      // `undefined` may already exist on a shared server from the old leak;
      // it is dropped only if this case is what created it.
      const hadUndefined =
        (await existing(client, engine.adapter, ["undefined"])).length > 0;
      if (!hadUndefined) {
        toDrop.push({ client, table: "undefined" });
      }

      // Exactly the driver's connect loop: build the statements, run each.
      let thrown: unknown;
      try {
        for (const statement of createSchema(without(names, "logs"), dialect)) {
          await client.unsafe(statement);
        }
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as ConfigError).message).toContain(`"logs"`);
      expect(await existing(client, engine.adapter, ours)).toEqual([]);
      if (!hadUndefined) {
        expect(await existing(client, engine.adapter, ["undefined"])).toEqual(
          [],
        );
      }
    }, 30_000);
  });
}
