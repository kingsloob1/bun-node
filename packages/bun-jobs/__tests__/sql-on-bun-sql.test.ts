/**
 * bun-jobs on bun-sql (PR-D0b, bun-security plan §15.1a): bun-jobs' SQL
 * dialect is bun-sql's plus the job queue's claim members, under the same
 * name; the schema renderers, the sync, the page cursors and the collation
 * guard are bun-sql's, re-exported; and every refusal still throws bun-jobs'
 * own `ConfigError` (`code: "CONFIG"`), through bun-sql's error seam.
 *
 * The negative controls are bun-sql called without the seam: it throws
 * bun-common's `ConfigError`, which is not bun-jobs', so a module that
 * dropped the seam fails here rather than turning a `400 INVALID_ARGUMENT`
 * into a `500`.
 */
import type { SqlAdapter } from "../lib/drivers/sql/dialect";
import { ConfigError as CommonConfigError } from "@kingsleyweb/bun-common";
import { decodePageCursor as sharedDecode } from "@kingsleyweb/bun-sql/cursor";
import {
  detectAdapter as sharedDetect,
  dialectFor as sharedDialectFor,
} from "@kingsleyweb/bun-sql/dialect";
import * as sharedSchema from "@kingsleyweb/bun-sql/schema";
import * as sharedSync from "@kingsleyweb/bun-sql/sync";
import { describe, expect, it } from "bun:test";
import { decodePageCursor, encodePageCursor } from "../lib/drivers/pageCursor";
import { resolveSyncOptions } from "../lib/drivers/schemaSync";
import {
  claimCollationWarning,
  noteCollationChecked,
  resetCollationWarnings,
} from "../lib/drivers/sql/collation-guard";
import { detectAdapter, dialectFor } from "../lib/drivers/sql/dialect";
import {
  createSchema,
  renderColumn,
  renderIndex,
  renderIndexColumn,
} from "../lib/drivers/sql/schema";
import { JOBS_SQL } from "../lib/drivers/sql/seam";
import {
  collationDrift,
  collationDriftWarning,
  compareColumn,
  readColumns,
  syncSqlSchema,
} from "../lib/drivers/sql/sync";
import { ConfigError } from "../lib/shared/errors";

const ADAPTERS: SqlAdapter[] = ["postgres", "mysql", "mariadb", "sqlite"];

/** The members bun-jobs adds to bun-sql's dialect. */
const CLAIM_MEMBERS = [
  "claim",
  "claimById",
  "claimCandidate",
  "claimIndexNamesId",
  "claimNeedsTransaction",
  "claimOrderAfter",
  "claimWindowEnd",
  "stampType",
];

/** What `run` threw. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("bun-jobs' dialect is bun-sql's plus the claim members", () => {
  for (const adapter of ADAPTERS) {
    it(`${adapter}: every bun-sql member is bun-sql's own, through bun-jobs' seam`, () => {
      const jobs = dialectFor(adapter) as unknown as Record<string, unknown>;
      const shared = sharedDialectFor(adapter, JOBS_SQL) as unknown as Record<
        string,
        unknown
      >;
      for (const key of Object.keys(shared)) {
        expect({ key, same: jobs[key] === shared[key] }).toEqual({
          key,
          same: true,
        });
      }
      expect(
        Object.keys(jobs)
          .filter((key) => !(key in shared))
          .sort(),
      ).toEqual(CLAIM_MEMBERS);
    });

    it(`${adapter}: the negative control, bun-sql's default dialect, is another set`, () => {
      const jobs = dialectFor(adapter);
      const unseamed = sharedDialectFor(adapter);
      // Built for bun-common's error maker, so its throwing members differ.
      expect(jobs.jsonOrBit === unseamed.jsonOrBit).toBe(false);
      const error = thrown(() => unseamed.jsonOrBit("opts", "m", 0));
      expect(error).toBeInstanceOf(CommonConfigError);
      expect(error).not.toBeInstanceOf(ConfigError);
    });

    it(`${adapter}: a refusing member throws bun-jobs' ConfigError`, () => {
      const error = thrown(() => dialectFor(adapter).jsonOrBit("opts", "m", 0));
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe("CONFIG");
      expect((error as Error).message).toBe(
        "A JSON bit must be a positive integer, not 0",
      );
    });
  }

  it("the SQLite write lock is shared: bun-jobs uses one dialect object per engine", () => {
    expect(dialectFor("sqlite")).toBe(dialectFor("sqlite"));
    expect(dialectFor("sqlite").transaction).toBe(
      sharedDialectFor("sqlite", JOBS_SQL).transaction,
    );
  });

  it("dialectFor and detectAdapter refuse with bun-jobs' ConfigError", () => {
    for (const run of [
      () => dialectFor("oracle" as SqlAdapter),
      () => detectAdapter(undefined),
      () => detectAdapter("oracle://h/db"),
    ]) {
      const error = thrown(run);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe("CONFIG");
    }
    expect(
      (thrown(() => detectAdapter("oracle://h/db")) as Error).message,
    ).toBe('Cannot tell which SQL engine "oracle://h/db" is');
    // The negative control: bun-sql without the seam.
    const unseamed = thrown(() => sharedDetect("oracle://h/db"));
    expect(unseamed).toBeInstanceOf(CommonConfigError);
    expect(unseamed).not.toBeInstanceOf(ConfigError);
  });
});

describe("the rest of the SQL layer is bun-sql's", () => {
  it("re-exports the renderers and the sync unchanged", () => {
    expect(renderColumn).toBe(sharedSchema.renderColumn);
    expect(renderIndex).toBe(sharedSchema.renderIndex);
    expect(renderIndexColumn).toBe(sharedSchema.renderIndexColumn);
    expect(syncSqlSchema).toBe(sharedSync.syncSqlSchema);
    expect(readColumns).toBe(sharedSync.readColumns);
    expect(compareColumn).toBe(sharedSync.compareColumn);
    expect(collationDrift).toBe(sharedSync.collationDrift);
    expect(resolveSyncOptions).toBe(sharedSync.resolveSyncOptions);
  });

  it("names the jobs tables in the drift warning", () => {
    const drift = [
      {
        table: "bun_jobs_jobs",
        column: "id",
        found: "utf8mb4_general_ci",
        expected: "utf8mb4_0900_bin",
      },
    ] as unknown as Parameters<typeof collationDriftWarning>[0];
    expect(collationDriftWarning(drift).message).toContain(
      "1 identifier column of the jobs tables compares",
    );
    // The negative control: bun-sql's own default subject.
    expect(sharedSync.collationDriftWarning(drift).message).toContain(
      "1 identifier column of the tables compares",
    );
  });

  it("createSchema refuses a table with no name with bun-jobs' ConfigError", () => {
    const names = {
      jobs: "j",
      locks: "l",
      kv: "",
      events: "e",
      logs: "g",
      run_logs: "r",
      workers: "w",
      metrics: "m",
    };
    const error = thrown(() => createSchema(names, dialectFor("sqlite")));
    expect(error).toBeInstanceOf(ConfigError);
  });

  it("a cursor not minted for the walk is bun-jobs' ConfigError", () => {
    const cursor = encodePageCursor("rh1.", "runs", ["n"], [5, "id"]);
    expect(
      decodePageCursor(cursor, "rh1.", "runs", ["n"], ["number", "string"]),
    ).toEqual([5, "id"]);
    for (const run of [
      () => decodePageCursor("rh1.@@", "rh1.", "runs", ["n"], ["number"]),
      () =>
        decodePageCursor(
          cursor,
          "rh1.",
          "runs",
          ["other"],
          ["number", "string"],
        ),
    ]) {
      const error = thrown(run);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe("CONFIG");
    }
    // The negative control: bun-sql without the seam.
    const unseamed = thrown(() =>
      sharedDecode(cursor, "rh1.", "runs", ["other"], ["number", "string"]),
    );
    expect(unseamed).toBeInstanceOf(CommonConfigError);
    expect(unseamed).not.toBeInstanceOf(ConfigError);
  });

  it("the collation guard keeps bun-jobs' registered slot, so older copies share it", () => {
    const slot = Symbol.for("@kingsleyweb/bun-jobs/collation-drift-checked");
    const host = globalThis as unknown as Record<
      symbol,
      Set<string> | undefined
    >;
    resetCollationWarnings();
    try {
      expect(claimCollationWarning("k1")).toBe(true);
      expect(claimCollationWarning("k1")).toBe(false);
      expect(host[slot]?.has("k1")).toBe(true);
      // A key an older copy of bun-jobs recorded on the same slot is seen.
      host[slot]?.add("k2");
      expect(claimCollationWarning("k2")).toBe(false);
      noteCollationChecked(["k3"]);
      expect(host[slot]?.has("k3")).toBe(true);
      // The negative control: a guard under another name does not see them.
      const other = sharedSync.createCollationGuard("d0b-test/other-slot");
      expect(other.claim("k1")).toBe(true);
      other.reset();
    } finally {
      resetCollationWarnings();
    }
    expect(host[slot]?.size).toBe(0);
  });
});
