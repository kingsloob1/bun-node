/**
 * Parity with bun-jobs' dialects. Written for PR-D0a, when bun-jobs still
 * had its own copy: for each engine, every member bun-sql shares with
 * bun-jobs' `SqlDialect` answers the same — every constant, and every
 * statement rendered from the same arguments — so the move could not change
 * a byte bun-jobs sends.
 *
 * Since PR-D0b bun-jobs' dialect is bun-sql's (made through bun-jobs' error
 * seam) plus the job queue's claim members, so the comparisons now guard the
 * seam and the composition: bun-jobs' dialect has every bun-sql member,
 * `documentType` and `inetType` included, and exactly the claim members
 * beside them, and a refusal is still bun-jobs' `ConfigError`. Byte parity
 * with bun-jobs' former copy was measured once, before it was deleted (the
 * PR's evidence); bun-jobs' `__tests__/sql-on-bun-sql.test.ts` checks that
 * each shared member is bun-sql's own.
 *
 * Reads bun-jobs' source by relative path, which only this repository has:
 * bun-sql takes no dependency on bun-jobs.
 */
import type { SqlAdapter, SqlDialect } from "../../lib/index";
import { describe, expect, it } from "bun:test";
import { dialectFor as jobsDialectFor } from "../../../bun-jobs/lib/drivers/sql/dialect";
import { ConfigError as JobsConfigError } from "../../../bun-jobs/lib/shared/errors";
import { dialectFor } from "../../lib/index";

/** bun-jobs' members bun-sql leaves to bun-jobs. */
const JOBS_ONLY = [
  "claim",
  "claimById",
  "claimCandidate",
  "claimIndexNamesId",
  "claimNeedsTransaction",
  "claimOrderAfter",
  "claimWindowEnd",
  "stampType",
];

/** bun-sql's members bun-jobs' claim layer does not use (it has them, since PR-D0b). */
const SQL_ONLY = ["documentType", "inetType"];

/** A placeholder binder for the keyset predicate, numbering from 1. */
function binder(dialect: SqlDialect): (value: unknown) => string {
  let count = 0;
  return () => {
    count += 1;
    return dialect.placeholder(count);
  };
}

/** Errors shaped as each engine's client raises them, for the classifiers. */
const ERRORS: unknown[] = [
  new Error("plain"),
  { errno: 1213 },
  { code: "40001" },
  { code: "23505" },
  { errno: 1062 },
  { code: "ER_DUP_ENTRY" },
  { code: "SQLITE_CONSTRAINT_PRIMARYKEY" },
  { message: "UNIQUE constraint failed: t.id" },
  { message: "x", cause: { errno: 1061 } },
  { code: "42P07" },
  { code: "42710" },
  { errno: 1176 },
  { message: "index ix_a already exists" },
  { message: "duplicate key value violates unique constraint" },
];

/**
 * Every shared function member called with the same arguments; the answer
 * compared. One entry per member, so a member missing from this list fails
 * the coverage check below.
 */
const CALLS: Record<string, (dialect: SqlDialect) => unknown> = {
  placeholder: (d) => [1, 2, 10].map((n) => d.placeholder(n)),
  partialIndex: (d) => d.partialIndex("lock_expires_at IS NOT NULL"),
  describeColumns: (d) => [
    d.describeColumns(["a"]),
    d.describeColumns(["a", "b", "c"]),
  ],
  describeIndexes: (d) => d.describeIndexes("t"),
  addColumn: (d) => d.addColumn("t", "c INTEGER NOT NULL DEFAULT 0"),
  alterColumnType: (d) => [
    d.alterColumnType("t", "c", "BIGINT"),
    d.alterColumnType("t", "c", "BIGINT", "NOT NULL"),
  ],
  alterColumnTypes: (d) =>
    d.alterColumnTypes("t", [
      { column: "a", type: "BIGINT" },
      { column: "b", type: "TEXT", suffix: "NOT NULL" },
    ]),
  isDuplicateIndex: (d) => ERRORS.map((error) => d.isDuplicateIndex(error)),
  isConcurrentCreate: (d) => ERRORS.map((error) => d.isConcurrentCreate(error)),
  dropIndex: (d) => d.dropIndex("ix_t_a", "t"),
  quote: (d) => [d.quote("user"), d.quote('we"ird`name')],
  normalizeType: (d) =>
    [
      "VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin",
      "character varying",
      "integer",
      "int8",
      "double precision",
      "timestamp with time zone",
      "JSON",
      "jsonb",
      "longtext",
      "BIGSERIAL PRIMARY KEY",
    ].map((type) => d.normalizeType(type)),
  jsonSetInteger: (d) => d.jsonSetInteger("opts", "priority", d.placeholder(3)),
  jsonInteger: (d) => d.jsonInteger("state", "version"),
  jsonParameter: (d) => d.jsonParameter(d.placeholder(2)),
  jsonSetValues: (d) => [
    d.jsonSetValues("opts", []),
    d.jsonSetValues("opts", [
      ["attempts", d.placeholder(1)],
      ["backoff", d.placeholder(2)],
    ]),
  ],
  jsonOrBit: (d) => d.jsonOrBit("opts", "explicit", 4),
  keysetAfter: (d) =>
    (["asc", "desc"] as const).flatMap((direction) => [
      d.keysetAfter(binder(d), {
        columns: ["priority"],
        values: [1],
        idColumn: "id",
        id: "x",
        direction,
      }),
      d.keysetAfter(binder(d), {
        columns: ["priority", "created_at"],
        values: [1, 2],
        idColumn: 'id COLLATE "C"',
        id: "x",
        direction,
      }),
    ]),
  indexHint: (d) => d.indexHint("ix_t_claim"),
  isMissingHintedIndex: (d) =>
    ERRORS.map((error) => d.isMissingHintedIndex(error)),
  insertIgnore: (d) => [
    d.insertIgnore("t", ["a", "b"]),
    d.insertIgnore("t", ["a", "b"], ["?", "CAST(? AS INTEGER)"]),
  ],
  insertIgnoreFromJson: (d) =>
    d.insertIgnoreFromJson?.("t", ["a", "b"], ["TEXT", "BIGINT"]),
  insertIgnoreMany: (d) => d.insertIgnoreMany("t", ["a", "b"], 3),
  insertFromJson: (d) =>
    d.insertFromJson?.("t", ["a", "b"], ["TEXT", "BIGINT"]),
  insertMany: (d) => d.insertMany("t", ["a", "b"], 3),
  isUniqueViolation: (d) => ERRORS.map((error) => d.isUniqueViolation(error)),
  upsert: (d) => d.upsert("t", ["a", "b", "c"], ["a"], ["b", "c"]),
  upsertOnConflict: (d) => d.upsertOnConflict(["a", "b"]),
  upsertIncoming: (d) => d.upsertIncoming("c"),
  greatest: (d) => d.greatest("a", "b"),
  least: (d) => d.least("a", "b"),
  limitedIdSubquery: (d) => d.limitedIdSubquery("SELECT id FROM t LIMIT 1"),
  affectedRows: async (d) => {
    const results: unknown[] = [
      { count: 3 },
      { affectedRows: 2 },
      { count: 1, affectedRows: 5 },
    ];
    const answers: unknown[] = [];
    for (const result of results) {
      answers.push(
        await d
          .affectedRows(result, undefined as never)
          .catch((error: Error) => error.message),
      );
    }
    return answers;
  },
  notifyingInsert: (d) =>
    d.notifyingInsert("INSERT INTO t (id) VALUES ($1)", "chan"),
  // Not callable without a server (the engine suites run it): the source,
  // whitespace collapsed, since bun-sql's dialects sit one level deeper.
  transaction: (d) => String(d.transaction).replace(/\s+/g, " "),
  analyze: (d) => d.analyze("t"),
  estimatedRows: (d) => d.estimatedRows("t"),
  jsonOut: (d) =>
    [null, undefined, '"warm"', "warm", '{"a":1}', { a: 1 }, 42, "42"].map(
      (value) => d.jsonOut(value, "fallback"),
    ),
  jsonIn: (d) =>
    [undefined, null, "warm", { a: 1 }, 42].map((value) => d.jsonIn(value)),
  jsonEmbed: (d) =>
    [undefined, null, "warm", { a: 1 }, 42].map((value) => d.jsonEmbed(value)),
};

const ADAPTERS: SqlAdapter[] = ["postgres", "mysql", "mariadb", "sqlite"];

describe("bun-sql's dialects against bun-jobs'", () => {
  for (const adapter of ADAPTERS) {
    const ours = dialectFor(adapter) as unknown as Record<string, unknown>;
    const theirs = jobsDialectFor(adapter) as unknown as Record<
      string,
      unknown
    >;

    it(`${adapter}: bun-jobs has every bun-sql member, the two new types included, and exactly the claim members beside them`, () => {
      const mine = Object.keys(ours).sort();
      const jobs = Object.keys(theirs).sort();
      expect(jobs.filter((key) => !mine.includes(key))).toEqual(JOBS_ONLY);
      expect(mine.filter((key) => !jobs.includes(key))).toEqual([]);
      expect(SQL_ONLY.filter((key) => !jobs.includes(key))).toEqual([]);
    });

    it(`${adapter}: every shared constant is equal`, () => {
      for (const key of Object.keys(ours)) {
        if (typeof ours[key] === "function") {
          continue;
        }
        expect({ key, value: ours[key] }).toEqual({ key, value: theirs[key] });
      }
    });

    it(`${adapter}: every shared function renders the same from the same arguments`, async () => {
      const functions = Object.keys(ours).filter(
        (key) => typeof ours[key] === "function",
      );
      // Coverage: a shared function with no call here fails, so a new member
      // cannot slip past the comparison.
      expect(functions.filter((key) => !(key in CALLS))).toEqual([]);
      for (const key of functions) {
        const call = CALLS[key]!;
        expect({
          key,
          answer: await call(ours as unknown as SqlDialect),
        }).toEqual({
          key,
          answer: await call(theirs as unknown as SqlDialect),
        });
      }
    });

    it(`${adapter}: jsonOrBit refuses alike, and throws bun-jobs' class through the seam`, () => {
      const bound = dialectFor(adapter, {
        configError: (message, details) =>
          new JobsConfigError(message, details),
      });
      let mine: unknown;
      let jobs: unknown;
      try {
        bound.jsonOrBit("opts", "m", 0);
      } catch (error) {
        mine = error;
      }
      try {
        (theirs as unknown as SqlDialect).jsonOrBit("opts", "m", 0);
      } catch (error) {
        jobs = error;
      }
      expect(mine).toBeInstanceOf(JobsConfigError);
      expect((mine as Error).message).toBe((jobs as Error).message);
    });
  }

  it("dialectFor and detectAdapter refuse alike", async () => {
    const { detectAdapter: jobsDetect } =
      await import("../../../bun-jobs/lib/drivers/sql/dialect");
    const { detectAdapter } = await import("../../lib/index");
    const urls = [
      "postgres://h/db",
      "postgresql://h/db",
      "mysql://h/db",
      "mariadb://h/db",
      "sqlite://x.db",
      "file:x.db",
      ":memory:",
      "/abs/x.db",
      "./rel.db",
    ];
    for (const url of urls) {
      expect(detectAdapter(url)).toBe(jobsDetect(url));
    }
    for (const bad of [undefined, "", "oracle://h/db", "x.db"]) {
      const message = (fn: () => unknown): string => {
        try {
          fn();
          return "no error";
        } catch (error) {
          return (error as Error).message;
        }
      };
      expect(message(() => detectAdapter(bad))).toBe(
        message(() => jobsDetect(bad)),
      );
    }
    const refused = (fn: () => unknown): string => {
      try {
        fn();
        return "no error";
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(refused(() => dialectFor("oracle" as SqlAdapter))).toBe(
      refused(() => jobsDialectFor("oracle" as SqlAdapter)),
    );
  });
});
