/**
 * better-auth's own adapter conformance cases (`@better-auth/test-utils/adapter`,
 * 1.7.27) against `bunSqlAdapter` on one engine.
 *
 * The kit is written for vitest, and runs under `bun test` unchanged: Bun
 * resolves `vitest` to `bun:test` (`import.meta.resolve("vitest")` is
 * `bun:test/vitest`; measured 2026-11-26, the sub-plan's evidence E16). No
 * case is ported or skipped.
 *
 * Each better-auth configuration the kit migrates to (its plugins add tables
 * and fields, `generateId: "serial"` turns ids into integers) gets tables of
 * its own, under a prefix derived from the run and the schema, so one
 * configuration's required columns never constrain another's inserts. Every
 * table a sync created is dropped by name when the suite ends.
 *
 * The kit is order-dependent by design: each group of its cases applies the
 * better-auth options and migrations the next relies on. Under
 * `bun test --randomize` it fails on better-auth's own memory adapter too
 * (59 and 44 of 468 with seeds 41854 and 54053; 468 of 468 in file order).
 * An order check runs the other files in `__tests__/sql/`; these run in order.
 */
import type { SQL } from "bun";
import type { BetterAuthOptions } from "better-auth";
import type { Engine } from "./helpers";
import {
  authFlowTestSuite,
  caseInsensitiveTestSuite,
  joinsTestSuite,
  normalTestSuite,
  numberIdTestSuite,
  testAdapter,
  transactionsTestSuite,
  uuidTestSuite,
} from "@better-auth/test-utils/adapter";
import { getAuthTables } from "better-auth/db";
import { bunSqlAdapter } from "../../lib/sql";
import { createdTables, dropTables, runPrefix } from "./helpers";

/** A short hash of a configuration's tables and id mode, for its table prefix. */
function schemaKey(options: BetterAuthOptions): string {
  const tables = Object.entries(getAuthTables(options)).map(([key, table]) => [
    key,
    table.modelName,
    Object.entries(table.fields).map(([field, attribute]) => [
      field,
      attribute.fieldName,
      attribute.type,
      attribute.required,
      attribute.unique,
      attribute.index,
      attribute.bigint,
      attribute.references?.model,
    ]),
    table.indexes,
  ]);
  const text = JSON.stringify([
    options.advanced?.database?.generateId === "serial",
    tables,
  ]);
  return Bun.hash(text).toString(36).slice(0, 6);
}

/** Registers better-auth's adapter suites for `engine` on `client`. */
export async function registerConformance(
  engine: Engine,
  client: SQL,
): Promise<void> {
  const run = runPrefix();
  const prefixFor = (options: BetterAuthOptions) =>
    `${run}${schemaKey(options)}_`;
  const created = new Set<string>();
  const adapterFor = (options: BetterAuthOptions) =>
    bunSqlAdapter({
      sql: client,
      adapter: engine.name,
      prefix: prefixFor(options),
    });

  const { execute } = await testAdapter({
    adapter: (options) => adapterFor(options),
    runMigrations: async (options) => {
      const changes = await adapterFor(options).syncSchema(options);
      for (const table of createdTables(changes)) {
        created.add(table);
      }
    },
    prefixTests: engine.name,
    tests: [
      normalTestSuite(),
      transactionsTestSuite(),
      authFlowTestSuite(),
      numberIdTestSuite(),
      joinsTestSuite(),
      uuidTestSuite(),
      caseInsensitiveTestSuite(),
    ],
    onFinish: async () => {
      await dropTables(engine.name, client, created);
      await client.close();
    },
  });
  execute();
}
