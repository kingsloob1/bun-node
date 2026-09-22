/**
 * Compile-time assertions that a `DriverConfig` can name every table and
 * collection its driver uses.
 *
 * The `sql` config's `tables` keys and the `mongodb` config's `collections`
 * keys are spelled out in `driver.ts` rather than derived from `SQL_TABLES`
 * and `MONGO_COLLECTIONS`, because both drivers import `driver.ts` and a
 * derivation would make the modules import each other. They drifted once:
 * `run_logs` and the three analytics tables, `runLogs` and `metrics`, were
 * accepted by the drivers and rejected by a typed config. These pin the two
 * sides together in both directions. Checked by the tests typecheck
 * (`bun scripts/typecheck.ts`), not by `bun test`.
 *
 * Every `@ts-expect-error` below is a negative control: if the error ever
 * stops appearing, the build fails on the unused directive.
 */
import type { DriverConfig, MongoCollection, SqlTable } from "../lib/index";

/** `true` only when `A` and `B` are the same type, exactly. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when given `true`. */
function assertTrue<T extends true>(_value?: T): void {}

/** The table names a typed `sql` config accepts. */
type SqlConfigTable = keyof NonNullable<
  Extract<DriverConfig, { type: "sql" }>["tables"]
>;

/** The collection names a typed `mongodb` config accepts. */
type MongoConfigCollection = keyof NonNullable<
  Extract<DriverConfig, { type: "mongodb" }>["collections"]
>;

assertTrue<Equals<SqlConfigTable, SqlTable>>();
assertTrue<Equals<MongoConfigCollection, MongoCollection>>();

// Negative controls: the comparison notices one name missing on either side.
// @ts-expect-error a union short of one table is not the driver's list
assertTrue<Equals<Exclude<SqlConfigTable, "runner_metrics">, SqlTable>>();
// @ts-expect-error a union with one extra collection is not the driver's list
assertTrue<Equals<MongoConfigCollection | "extra", MongoCollection>>();

// The names the drift left out, each renamable through a typed config.
export const sqlConfig: DriverConfig = {
  type: "sql",
  url: "sqlite://:memory:",
  tables: {
    run_logs: "my_run_logs",
    queue_metrics: "my_queue_metrics",
    worker_metrics: "my_worker_metrics",
    runner_metrics: "my_runner_metrics",
  },
};

export const mongoConfig: DriverConfig = {
  type: "mongodb",
  url: "mongodb://localhost/jobs",
  collections: { runLogs: "my_run_logs", metrics: "my_metrics" },
};

export const unknownTable: DriverConfig = {
  type: "sql",
  url: "sqlite://:memory:",
  tables: {
    // @ts-expect-error a table no driver uses is still rejected
    nonsense: "x",
  },
};
