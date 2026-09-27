import type { LogEvent } from "@kingsleyweb/bun-common";
import type {
  BunRunnerOptions,
  DriverConfig,
  ExecutionMode,
  RunRecord,
} from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import { SQL } from "bun";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  claimCollationWarning,
  noteCollationChecked,
  resetCollationWarnings,
} from "../lib/drivers/sql/collation-guard";
import { collationKeysForRuns } from "../lib/drivers/sql/sql-driver";
import {
  BunRunner,
  MemoryDriver,
  runnerKey,
  SQL_TABLES,
  SqlDriver,
} from "../lib/index";
import { takeBooleanParam } from "../lib/shared/connection";
import { testNamespace } from "./helpers";

/**
 * The collation warning, said once.
 *
 * `sql-collation-drift.test.ts` covers what the warning says and when there
 * is drift to warn about. This file covers how often: once per process for a
 * set of tables however many drivers connect to them, and never again from a
 * runner's spawned or worker runs, whose drivers are built afresh from
 * `ctx.driverConfig` in a process or realm that has not seen the warning.
 *
 * The guard is process-wide and `bun test` runs every file in one process, so
 * every case starts from an empty one (`resetCollationWarnings`), and every
 * server case uses tables under a prefix of its own, dropped exactly —
 * never a `LIKE` sweep, never the shared default-prefix `bun_jobs_*` tables.
 */

beforeEach(() => {
  resetCollationWarnings();
});

/** The `warn` records a test logger collected. */
function warnings(events: LogEvent[]): LogEvent[] {
  return events.filter((event) => event.level === "warn");
}

/** Whether a text is the collation warning, or holds it. */
function isCollationWarning(text: string): boolean {
  return text.includes("identifier column") && text.includes("alterColumns");
}

/** The guard key a driver checks under, read as a runner reads it. */
async function keyOf(driver: SqlDriver): Promise<string> {
  const [key] = await collationKeysForRuns(driver, undefined, noopLogger);
  return key!;
}

/** Every table name under `prefix`, in the order a guard key lists them. */
function tableList(prefix: string): string {
  return SQL_TABLES.map((table) => `${prefix}${table}`).join(",");
}

describe("collation warning: the guard", () => {
  it("claims a key once, and again only after a reset", () => {
    expect(claimCollationWarning("a")).toBe(true);
    expect(claimCollationWarning("a")).toBe(false);
    expect(claimCollationWarning("b")).toBe(true);

    resetCollationWarnings();
    expect(claimCollationWarning("a")).toBe(true);
  });

  it("treats a key a parent checked as already claimed", () => {
    noteCollationChecked(["checked"]);
    expect(claimCollationWarning("checked")).toBe(false);
    expect(claimCollationWarning("unchecked")).toBe(true);
  });

  it("is shared through globalThis, so a second copy of the package sees it", () => {
    claimCollationWarning("shared");
    const slot = (globalThis as unknown as Record<symbol, Set<string>>)[
      Symbol.for("@kingsleyweb/bun-jobs/collation-drift-checked")
    ];
    expect(slot?.has("shared")).toBe(true);
  });
});

describe("collation warning: the key", () => {
  const opened: SqlDriver[] = [];

  afterEach(async () => {
    // Never connected: the clients are lazy, so closing them touches nothing.
    await Promise.allSettled(opened.splice(0).map((d) => d.close()));
  });

  /** A driver that is never connected, for its key alone. */
  const lazy = (options: ConstructorParameters<typeof SqlDriver>[0]) => {
    const driver = new SqlDriver({
      notify: false,
      logger: noopLogger,
      ...options,
    });
    opened.push(driver);
    return driver;
  };

  it("names the server, database and tables, and no credentials", async () => {
    const key = await keyOf(
      lazy({
        url: "mysql://someone:s3cret-pw@DB.Example:3307/jobs?allowPublicKeyRetrieval=true",
        tablePrefix: "p_",
      }),
    );

    expect(key).toBe(`mysql://db.example:3307/jobs#${tableList("p_")}`);
    expect(key).not.toContain("s3cret");
    expect(key).not.toContain("someone");
    expect(key).not.toContain("allowPublicKeyRetrieval");
  });

  it("is the same for a URL and for connection fields, default port filled in", async () => {
    const fromUrl = await keyOf(
      lazy({ url: "mariadb://u:p@127.0.0.1/jobs", tablePrefix: "q_" }),
    );
    const fromFields = await keyOf(
      lazy({
        adapter: "mariadb",
        connection: {
          host: "127.0.0.1",
          user: "other",
          password: "different",
          database: "jobs",
        },
        tablePrefix: "q_",
      }),
    );

    expect(fromUrl).toBe(`mariadb://127.0.0.1:3306/jobs#${tableList("q_")}`);
    expect(fromFields).toBe(fromUrl);
  });

  it("differs by prefix, by database and by table override", async () => {
    const base = { url: "mysql://u@h:3306/jobs", tablePrefix: "a_" };
    const keys = new Set([
      await keyOf(lazy(base)),
      await keyOf(lazy({ ...base, tablePrefix: "b_" })),
      await keyOf(lazy({ ...base, url: "mysql://u@h:3306/other" })),
      await keyOf(lazy({ ...base, tables: { kv: "custom_kv" } })),
    ]);

    expect(keys.size).toBe(4);
  });

  it("follows a shared client's target", async () => {
    const sql = new SQL({ url: "mysql://u:pw@h:3306/jobs" });
    try {
      const shared = await keyOf(
        lazy({ sql, adapter: "mysql", tablePrefix: "s_" }),
      );
      const own = await keyOf(
        lazy({ url: "mysql://x@h:3306/jobs", tablePrefix: "s_" }),
      );
      expect(shared).toBe(own);
    } finally {
      await sql.close();
    }
  });
});

describe("collation warning: a childDriver the runner cannot reach", () => {
  it("hands no key over, so the run's own driver checks; never throws or warns", async () => {
    const { logger, events } = createTestLogger();
    // Nothing listens on port 1: the check fails at once.
    const keys = await collationKeysForRuns(
      new MemoryDriver(),
      {
        type: "sql",
        adapter: "mariadb",
        url: "mariadb://u:p@127.0.0.1:1/none",
      },
      logger,
    );

    expect(keys).toEqual([]);
    expect(warnings(events)).toEqual([]);
  });

  it("hands no key over for an engine that never warns, or a connect that repairs", async () => {
    const own = new MemoryDriver();
    expect(
      await collationKeysForRuns(
        own,
        { type: "sql", url: "postgres://u@127.0.0.1:1/none" },
        noopLogger,
      ),
    ).toEqual([]);
    expect(
      await collationKeysForRuns(
        own,
        {
          type: "sql",
          url: "mysql://u@127.0.0.1:1/none",
          syncSchema: { alterColumns: true },
        },
        noopLogger,
      ),
    ).toEqual([]);
    expect(
      await collationKeysForRuns(own, { type: "memory" }, noopLogger),
    ).toEqual([]);
  });
});

/**
 * MySQL and MariaDB, when configured: the engines where the warning can fire.
 */
const MYSQL_FAMILY: {
  /** Which engine. */
  adapter: "mysql" | "mariadb";
  /** Its server, or undefined when the suite has none. */
  url: string | undefined;
  /** A case-insensitive collation to damage a column with. */
  legacy: string;
}[] = [
  {
    adapter: "mariadb",
    url: process.env.BUN_JOBS_TEST_MARIADB_URL,
    legacy: "utf8mb4_uca1400_ai_ci",
  },
  {
    adapter: "mysql",
    url: process.env.BUN_JOBS_TEST_MYSQL_URL,
    legacy: "utf8mb4_general_ci",
  },
];

/** Clients opened for the DDL, closed when the file ends. */
const clients: SQL[] = [];

afterAll(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
});

const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

for (const { adapter, url, legacy } of MYSQL_FAMILY) {
  /** Table prefixes this engine's cases made, dropped as each case ends. */
  const prefixes: string[] = [];
  /** Drivers to close before the tables go. */
  const drivers: SqlDriver[] = [];
  /** Runners to stop before the tables go. */
  const runners: BunRunner<any, any>[] = [];
  let shared: SQL | undefined;

  /** A client for the DDL; `allowPublicKeyRetrieval` as an option, as the driver does. */
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
    const prefix = `cw_${label}_${Math.random().toString(36).slice(2, 8)}_`;
    prefixes.push(prefix);
    return prefix;
  };

  /** The driver config for `prefix`'s tables. */
  const configFor = (prefix: string): DriverConfig => ({
    type: "sql",
    url: url!,
    adapter,
    tablePrefix: prefix,
  });

  /** A driver over `prefix`'s tables, logging into a fresh test logger. */
  const driverFor = (
    prefix: string,
  ): { driver: SqlDriver; events: LogEvent[] } => {
    const { logger, events } = createTestLogger();
    const driver = new SqlDriver({
      url,
      adapter,
      tablePrefix: prefix,
      notify: false,
      logger,
    });
    drivers.push(driver);
    return { driver, events };
  };

  /** Creates `prefix`'s tables, then recollates `kv_key` as an older version had it. */
  const drifted = async (prefix: string): Promise<void> => {
    const driver = new SqlDriver({
      url,
      adapter,
      tablePrefix: prefix,
      notify: false,
      logger: noopLogger,
    });
    await driver.connect();
    await driver.close();
    await client().unsafe(
      `ALTER TABLE ${prefix}kv MODIFY COLUMN kv_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE ${legacy} NOT NULL`,
    );
  };

  /** Creates `prefix`'s tables as the current driver would: no drift. */
  const clean = async (prefix: string): Promise<void> => {
    const driver = new SqlDriver({
      url,
      adapter,
      tablePrefix: prefix,
      notify: false,
      logger: noopLogger,
    });
    await driver.connect();
    await driver.close();
  };

  describe.skipIf(!url)(`collation warning once: ${adapter}`, () => {
    afterEach(async () => {
      await Promise.allSettled(
        runners.splice(0).map((runner) => runner.stop({ force: true })),
      );
      await Promise.allSettled(drivers.splice(0).map((d) => d.close()));
      for (const prefix of prefixes.splice(0)) {
        for (const table of SQL_TABLES) {
          await client()
            .unsafe(`DROP TABLE IF EXISTS ${prefix}${table}`)
            .catch(() => undefined);
        }
      }
    });

    it("warns once across two drivers over the same tables", async () => {
      const prefix = prefixFor(`${adapter}_twice`);
      await drifted(prefix);

      const first = driverFor(prefix);
      await first.driver.connect();
      const second = driverFor(prefix);
      await second.driver.connect();

      expect(warnings(first.events)).toHaveLength(1);
      expect(warnings(second.events)).toEqual([]);

      // The control: it was the guard that kept the second one quiet, not an
      // absence of drift — with the guard emptied, a third driver warns.
      resetCollationWarnings();
      const third = driverFor(prefix);
      await third.driver.connect();
      expect(warnings(third.events)).toHaveLength(1);
    }, 60_000);

    it("warns once when two drivers connect at the same moment", async () => {
      const prefix = prefixFor(`${adapter}_race`);
      await drifted(prefix);

      const a = driverFor(prefix);
      const b = driverFor(prefix);
      await Promise.all([a.driver.connect(), b.driver.connect()]);

      expect(warnings([...a.events, ...b.events])).toHaveLength(1);
    }, 60_000);

    it("warns again for another prefix, once", async () => {
      const one = prefixFor(`${adapter}_one`);
      const two = prefixFor(`${adapter}_two`);
      await drifted(one);
      await drifted(two);

      const events: LogEvent[] = [];
      for (const prefix of [one, two, one, two]) {
        const connected = driverFor(prefix);
        await connected.driver.connect();
        events.push(...connected.events);
      }

      const warned = warnings(events);
      expect(warned).toHaveLength(2);
      expect(warned[0]!.message).toContain(`${one}kv: kv_key`);
      expect(warned[1]!.message).toContain(`${two}kv: kv_key`);
    }, 60_000);

    /** A runner over `driver`, with its logger's events, stopped after the case. */
    const runnerFor = (
      mode: ExecutionMode,
      options: Partial<BunRunnerOptions<any>>,
    ): { runner: BunRunner<any, any>; events: LogEvent[] } => {
      const { logger, events } = createTestLogger();
      const runner = new BunRunner({
        id: "collation",
        namespace: testNamespace(),
        file: fixture("collation-connect"),
        executionMode: mode,
        waitToExit: false,
        logger,
        ...options,
      } as BunRunnerOptions<any>);
      runners.push(runner);
      return { runner, events };
    };

    /** Runs one trigger to completion and reports its record. */
    const runOnce = async (runner: BunRunner<any, any>): Promise<RunRecord> => {
      const settled = new Promise<RunRecord>((resolve) => {
        runner.once("finished", (record) => resolve(record));
        runner.once("failed", (record) => resolve(record));
      });
      await runner.trigger();
      return await settled;
    };

    /** Every line of one run's stored log, as text. */
    const logOf = async (
      runner: BunRunner<any, any>,
      runId: string,
    ): Promise<string[]> => {
      const page = await runner.driver.getRunLog!(
        runner.namespace,
        runnerKey(runner.id),
        runId,
        { offset: 0, limit: 10_000, order: "asc" },
      );
      return page.lines.map((line) => line.text);
    };

    for (const mode of ["child-process", "worker-thread"] as const) {
      it(`${mode}: the runner warns once, and no run's log repeats it`, async () => {
        const prefix = prefixFor(
          `${adapter}_${mode === "child-process" ? "cp" : "wt"}`,
        );
        await drifted(prefix);

        // `driver` a config, so it is also what each run is handed.
        const { runner, events } = runnerFor(mode, {
          driver: configFor(prefix),
        });
        await runner.start();

        for (let run = 0; run < 3; run += 1) {
          const record = await runOnce(runner);
          expect(record.status).toBe("success");
          expect(record.result).toEqual({ connected: true });
          const lines = await logOf(runner, record.runId);
          expect(lines.filter(isCollationWarning)).toEqual([]);
        }

        const warned = warnings(events);
        expect(warned).toHaveLength(1);
        expect(warned[0]!.message).toContain(`${prefix}kv: kv_key`);
        // Through the runner's own logger, bindings and all.
        expect(warned[0]!.bindings).toMatchObject({
          runnerId: "collation",
          driver: "sql",
          adapter,
        });
      }, 90_000);
    }

    it("checks a childDriver on other tables once, at start, and no run repeats it", async () => {
      const own = prefixFor(`${adapter}_own`);
      const child = prefixFor(`${adapter}_child`);
      await clean(own);
      await drifted(child);

      const { runner, events } = runnerFor("child-process", {
        driver: configFor(own),
        childDriver: configFor(child),
      });
      await runner.start();

      // At start, before any run: the check is started by `start()`.
      const deadline = Date.now() + 10_000;
      while (warnings(events).length === 0 && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      expect(warnings(events)).toHaveLength(1);

      for (let run = 0; run < 3; run += 1) {
        const record = await runOnce(runner);
        expect(record.status).toBe("success");
        const lines = await logOf(runner, record.runId);
        expect(lines.filter(isCollationWarning)).toEqual([]);
      }

      const warned = warnings(events);
      expect(warned).toHaveLength(1);
      expect(warned[0]!.message).toContain(`${child}kv: kv_key`);
      expect(warned[0]!.message).not.toContain(own);

      // Read-only: the check at start created nothing in the child's schema
      // beyond what `drifted` made, and changed no collation.
      const [row] = (await client().unsafe(
        `SELECT COLLATION_NAME AS c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${child}kv'
            AND COLUMN_NAME = 'kv_key'`,
      )) as { c: string }[];
      expect(row?.c).toBe(legacy);
    }, 90_000);
  });
}
