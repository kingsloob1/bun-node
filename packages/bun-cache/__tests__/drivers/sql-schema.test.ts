/**
 * bun-cache's schema sync on bun-sql's (PR-D0c), on SQLite (`bun:sqlite`):
 * the definitions in `lib/drivers/sql-schema.ts` match the driver's DDL (a
 * schema it created answers `[]`), a drifted file is reported and repaired
 * unless `dryRun`, the `syncSchema` option repairs it before anything else
 * runs, and a sync that fails fails the open. The server engines' half is in
 * `sqlSuite.ts`, D1's in `cloudflare-d1.test.ts`.
 *
 * The negative controls are the drifted files themselves: each case that
 * answers `[]` has a twin that does not.
 */
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, test } from "bun:test";
import type { StoredEntry } from "../../lib/index";
import { sqliteDriver } from "../../lib/index";
import {
  describeChange,
  sqlCacheSchema,
  toCacheChange,
} from "../../lib/drivers/sql-schema";
import {
  resolveSqlCacheTables,
  sqlCacheIndexName,
} from "../../lib/drivers/sql-tables";

const dir = await mkdtemp(
  join(tmpdir(), `bun-cache-sql-schema-${process.pid}-`),
);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let serial = 0;
/** A fresh file path. */
const file = (): string => join(dir, `f${++serial}.db`);

/** An entry. */
const entry = (key: string): StoredEntry => ({
  key,
  value: new Uint8Array([1]),
  expiresAt: null,
  tags: ["t"],
});

/** The default tables' names. */
const TABLES = resolveSqlCacheTables("test", "bun_cache_", undefined);
const KEY_INDEX = sqlCacheIndexName(TABLES.tags, "key");
const MISSING_KEY_INDEX = `create-index ${TABLES.tags}.${KEY_INDEX}: the driver defines it and the table does not have it`;
const MISSING_TG = `add-column ${TABLES.entries}.tg: the driver defines it and the table does not have it`;

/** The indexes on a table, by name. */
function indexesOf(path: string, table: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
        )
        .all(table) as { name: string }[]
    )
      .map((row) => row.name)
      .sort();
  } finally {
    db.close();
  }
}

/** The columns of a table, by name. */
function columnsOf(path: string, table: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map((row) => row.name)
      .sort();
  } finally {
    db.close();
  }
}

/**
 * Creates the default tables in `path`, then drops the entries' `tg`
 * column: the drift. A column, because opening a driver recreates a missing
 * index (`CREATE INDEX IF NOT EXISTS`) but never a missing column.
 */
async function drifted(path: string): Promise<void> {
  const driver = sqliteDriver({ path });
  await driver.connect!();
  await driver.close();
  const db = new Database(path);
  db.run(`ALTER TABLE ${TABLES.entries} DROP COLUMN tg`);
  db.close();
}

describe("the change mapping", () => {
  test("describes a bun-sql change as kind, table.target and reason", () => {
    const change = {
      kind: "create-index" as const,
      table: "t",
      target: "ix_t_a",
      statement: "CREATE INDEX ix_t_a ON t (a)",
      reason: "why",
      blocking: true,
      applied: false,
    };
    expect(describeChange(change)).toBe("create-index t.ix_t_a: why");
    expect(toCacheChange(change)).toEqual({
      description: "create-index t.ix_t_a: why",
      applied: false,
      blocking: true,
    });
  });

  test("the bus table is in a definition only when the engine has it", () => {
    const names = (withBus: boolean) =>
      sqlCacheSchema("postgres", TABLES, withBus).tables.map((t) => t.name);
    expect(names(false)).not.toContain(TABLES.bus);
    expect(names(true)).toContain(TABLES.bus);
  });
});

describe("sqliteDriver on bun-sql's sync", () => {
  test("a schema the driver created answers [], dry run or not", async () => {
    const driver = sqliteDriver({ path: file() });
    expect(await driver.syncSchema!({ dryRun: true })).toEqual([]);
    expect(await driver.syncSchema!()).toEqual([]);
    await driver.close();
  });

  test("tables named outright answer [] too", async () => {
    const driver = sqliteDriver({
      path: file(),
      prefix: "app_",
      tables: { entries: "my_entries", bus: "my_bus" },
    });
    expect(await driver.syncSchema!({ dryRun: true })).toEqual([]);
    await driver.close();
  });

  test("a drifted file: reported under dryRun, repaired without it, then []", async () => {
    const path = file();
    await drifted(path);
    expect(columnsOf(path, TABLES.entries)).not.toContain("tg");

    const driver = sqliteDriver({ path });
    expect(await driver.syncSchema!({ dryRun: true })).toEqual([
      { description: MISSING_TG, applied: false, blocking: false },
    ]);
    expect(columnsOf(path, TABLES.entries)).not.toContain("tg");

    expect(await driver.syncSchema!()).toEqual([
      { description: MISSING_TG, applied: true, blocking: false },
    ]);
    expect(columnsOf(path, TABLES.entries)).toContain("tg");
    expect(await driver.syncSchema!()).toEqual([]);
    await driver.close();
  });

  test("an index lost while the driver is open is reported blocking (an SQLite index build), and rebuilt", async () => {
    const path = file();
    const driver = sqliteDriver({ path });
    await driver.connect!();
    const db = new Database(path);
    db.run(`DROP INDEX "${KEY_INDEX}"`);
    db.close();
    expect(await driver.syncSchema!({ dryRun: true })).toEqual([
      { description: MISSING_KEY_INDEX, applied: false, blocking: true },
    ]);
    expect(await driver.syncSchema!()).toEqual([
      { description: MISSING_KEY_INDEX, applied: true, blocking: true },
    ]);
    expect(indexesOf(path, TABLES.tags)).toEqual([KEY_INDEX]);
    await driver.close();
  });

  test("an index of the operator's is never touched; a stray ix_ one is dropped", async () => {
    const path = file();
    const prepare = sqliteDriver({ path });
    await prepare.connect!();
    await prepare.close();
    const db = new Database(path);
    db.run(`CREATE INDEX op_mine ON ${TABLES.tags} (tag)`);
    db.run(`CREATE INDEX ix_${TABLES.tags}_old ON ${TABLES.tags} (k)`);
    db.close();

    const driver = sqliteDriver({ path });
    expect(await driver.syncSchema!()).toEqual([
      {
        description: `drop-index ${TABLES.tags}.ix_${TABLES.tags}_old: the driver no longer defines it, and it costs a write per row`,
        applied: true,
        blocking: false,
      },
    ]);
    expect(indexesOf(path, TABLES.tags)).toEqual([KEY_INDEX, "op_mine"].sort());
    await driver.close();
  });

  test("the syncSchema option repairs a drifted file before the first operation runs", async () => {
    const path = file();
    await drifted(path);
    const driver = sqliteDriver({ path, syncSchema: true });
    // The write names `tg`: it succeeds only because the column is back.
    await driver.set("ns", entry("k"));
    expect(columnsOf(path, TABLES.entries)).toContain("tg");
    await driver.close();
  });

  test("the negative control: without the option the drift stays", async () => {
    const path = file();
    await drifted(path);
    const driver = sqliteDriver({ path });
    await expect(driver.set("ns", entry("k"))).rejects.toThrow(/tg/);
    expect(columnsOf(path, TABLES.entries)).not.toContain("tg");
    await driver.close();
  });

  test("a sync that fails fails the open, and the next call tries again", async () => {
    const path = file();
    await drifted(path);
    // Read-only: the tables and indexes exist, so creating them is a no-op,
    // but the repair's ADD COLUMN cannot run.
    const readonly = new Database(path, { readonly: true });
    try {
      const driver = sqliteDriver({ database: readonly, syncSchema: true });
      await expect(driver.get("ns", "k")).rejects.toThrow(/readonly/i);
      await expect(driver.connect!()).rejects.toThrow(/readonly/i);
      await driver.close();

      // The negative control: the same file, the same drift, no sync.
      const plain = sqliteDriver({ database: readonly });
      // Opens: the open itself is fine, only the sync could not run.
      expect(await plain.ping!()).toBeUndefined();
      await plain.close();
    } finally {
      readonly.close();
    }
  });
});
