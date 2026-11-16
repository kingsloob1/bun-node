/**
 * Parity with bun-jobs' schema and sync (PR-D0a): bun-jobs' own table
 * definitions — all eleven tables, every index — rendered by bun-sql give
 * the same DDL as bun-jobs renders, on every engine; and on every reachable
 * server, bun-sql's sync finds no drift in the schema bun-jobs' code
 * creates, and the same changes as bun-jobs' sync in one drifted on
 * purpose. So moving bun-jobs onto bun-sql (PR-D0b) cannot change what it
 * creates or what a sync reports.
 *
 * Reads bun-jobs' source by relative path, which only this repository has.
 */
import type { SQL } from "bun";
import type { SqlAdapter } from "../../lib/index";
import type { SqlBackend } from "../helpers/backends";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { resolveSyncOptions as jobsResolve } from "../../../bun-jobs/lib/drivers/schemaSync";
import { dialectFor as jobsDialectFor } from "../../../bun-jobs/lib/drivers/sql/dialect";
import {
  createSchema as jobsCreateSchema,
  renderIndex as jobsRenderIndex,
  schemaDefinition,
} from "../../../bun-jobs/lib/drivers/sql/schema";
import { SQL_TABLES } from "../../../bun-jobs/lib/drivers/sql/sql-driver";
import { syncSqlSchema as jobsSync } from "../../../bun-jobs/lib/drivers/sql/sync";
import {
  createSchema,
  dialectFor,
  renderIndex,
  resolveSyncOptions,
  syncSqlSchema,
} from "../../lib/index";
import { clientFor, forEachSqlBackend, runPrefix } from "../helpers/backends";
import { backendOf, runStatements } from "../helpers/fixture";

/** bun-jobs' table names under `prefix`, every one of them. */
function jobsNames(
  prefix: string,
): Record<(typeof SQL_TABLES)[number], string> {
  return Object.fromEntries(
    SQL_TABLES.map((table) => [table, `${prefix}${table}`]),
  ) as Record<(typeof SQL_TABLES)[number], string>;
}

/** The eight tables without the analytics three. */
function shippedNames(prefix: string) {
  const {
    queue_metrics: _q,
    worker_metrics: _w,
    runner_metrics: _r,
    ...rest
  } = jobsNames(prefix);
  return rest;
}

const ADAPTERS: SqlAdapter[] = ["postgres", "mysql", "mariadb", "sqlite"];

describe("bun-jobs' schema rendered by bun-sql", () => {
  for (const adapter of ADAPTERS) {
    it(`${adapter}: createSchema gives bun-jobs' DDL, byte for byte`, () => {
      const jobs = jobsDialectFor(adapter);
      const ours = dialectFor(adapter);
      for (const names of [jobsNames("bj_"), shippedNames("bj_")]) {
        const definition = schemaDefinition(names, jobs);
        const existing = new Set([names.jobs, names.kv]);
        expect(createSchema(definition, ours)).toEqual(
          jobsCreateSchema(names, jobs),
        );
        expect(createSchema(definition, ours, { existing })).toEqual(
          jobsCreateSchema(names, jobs, existing),
        );
        for (const index of definition.indexes) {
          expect(renderIndex(index, ours, true)).toBe(
            jobsRenderIndex(index, jobs, true),
          );
        }
      }
    });
  }

  it("the comparison catches one changed byte (the control)", () => {
    const jobs = jobsDialectFor("postgres");
    const names = jobsNames("bj_");
    const definition = schemaDefinition(names, jobs);
    const ours = { ...dialectFor("postgres"), concurrentIndex: "" };
    expect(
      definition.indexes.some(
        (index) =>
          renderIndex(index, ours, true) !== jobsRenderIndex(index, jobs, true),
      ),
    ).toBe(true);
  });
});

/** Registers the server parity cases for one engine. */
function registerSuite(backend: SqlBackend): void {
  const jobs = jobsDialectFor(backend.name);
  const ours = dialectFor(backend.name);
  let client: SQL | undefined;
  /** The engine's client, opened on first use and closed when the file ends. */
  const sql = (): SQL => (client ??= clientFor(backend));
  /** Prefixes whose eleven tables the running case made. */
  const made: string[] = [];

  afterEach(async () => {
    for (const prefix of made.splice(0)) {
      for (const table of Object.values(jobsNames(prefix))) {
        await sql()
          .unsafe(`DROP TABLE IF EXISTS ${table}`)
          .catch(() => undefined);
      }
    }
  });

  afterAll(async () => {
    await client?.close();
  });

  /** bun-jobs' schema, created by bun-jobs' code under a fresh prefix. */
  const created = async (): Promise<string> => {
    const prefix = runPrefix();
    made.push(prefix);
    await runStatements(sql(), jobs, jobsCreateSchema(jobsNames(prefix), jobs));
    return prefix;
  };

  /** Both syncs' dry-run plans over bun-jobs' definition. */
  const plans = async (prefix: string) => {
    const definition = schemaDefinition(jobsNames(prefix), jobs);
    const backendSql = backendOf(sql());
    return {
      ours: await syncSqlSchema(
        backendSql,
        ours,
        definition,
        resolveSyncOptions({ dryRun: true }),
      ),
      jobs: await jobsSync(
        backendSql,
        jobs,
        definition,
        jobsResolve({ dryRun: true }),
      ),
    };
  };

  describe(`${backend.name}: bun-jobs' schema against bun-sql's sync`, () => {
    it("no drift in what bun-jobs creates, by either sync", async () => {
      const prefix = await created();
      const { ours: mine, jobs: theirs } = await plans(prefix);
      expect(mine).toEqual([]);
      expect(theirs).toEqual([]);
    });

    it("the same changes as bun-jobs' sync for a schema drifted on purpose", async () => {
      const prefix = await created();
      const names = jobsNames(prefix);
      const definition = schemaDefinition(names, jobs);
      const dropped = definition.indexes[0]!;
      await sql().unsafe(jobs.dropIndex(dropped.name, dropped.table));
      // A retired index on a table the definition indexes, and an extra
      // column (which a sync ignores).
      await sql().unsafe(
        `CREATE INDEX ix_${prefix}retired ON ${dropped.table} (ns)`,
      );
      await sql().unsafe(jobs.addColumn(names.events, "extra INTEGER"));
      if (backend.name !== "sqlite") {
        await sql().unsafe(
          jobs.alterColumnType(names.metrics, "bucket", "INTEGER", "NOT NULL")!,
        );
      }
      const { ours: mine, jobs: theirs } = await plans(prefix);
      expect(mine.map((change) => change.kind).sort()).toEqual(
        backend.name === "sqlite"
          ? ["create-index", "drop-index"]
          : ["alter-column", "create-index", "drop-index"],
      );
      expect(mine).toEqual(theirs);
      // Applied by bun-sql, then bun-jobs' sync finds nothing left.
      await syncSqlSchema(
        backendOf(sql()),
        ours,
        definition,
        resolveSyncOptions({ alterColumns: true }),
      );
      const after = await plans(prefix);
      expect(after.jobs).toEqual([]);
      expect(after.ours).toEqual([]);
    });
  });
}

await forEachSqlBackend(registerSuite);
