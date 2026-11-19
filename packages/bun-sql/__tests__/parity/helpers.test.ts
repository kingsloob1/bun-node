/**
 * Parity with the helpers bun-sql moved (PR-D0a): the same inputs through
 * bun-sql's copy and the originals — bun-jobs' connection helpers, lock
 * retry, page cursors, collation guard and drift warning, and bun-cache's
 * `sqlClientOptions` — compared. Behaviour, not text; the one difference
 * allowed is the error class, which the `configError` seam restores (bun-jobs'
 * `ConfigError`, bun-cache's `TypeError`), message for message.
 *
 * Since PR-D0b and PR-D0c bun-jobs' lock retry, cursors and guard and
 * bun-cache's helpers are bun-sql's, so those comparisons now guard the
 * seams (the error class, message for message) rather than a copy.
 *
 * Reads bun-jobs' and bun-cache's source by relative path, which only this
 * repository has. No server is needed.
 */
import { describe, expect, test } from "bun:test";
import * as cacheConnection from "../../../bun-cache/lib/drivers/sql-connection";
import * as jobsCursor from "../../../bun-jobs/lib/drivers/pageCursor";
import * as jobsGuard from "../../../bun-jobs/lib/drivers/sql/collation-guard";
import * as jobsDialect from "../../../bun-jobs/lib/drivers/sql/dialect";
import * as jobsSync from "../../../bun-jobs/lib/drivers/sql/sync";
import * as jobsConnection from "../../../bun-jobs/lib/shared/connection";
import { ConfigError as JobsConfigError } from "../../../bun-jobs/lib/shared/errors";
import * as sql from "../../lib/index";

/** What a call did: its value, or that it threw (the message and class). */
function outcome(run: () => unknown): unknown {
  try {
    return { value: run() };
  } catch (error) {
    return {
      threw: (error as Error).message,
      jobs: error instanceof JobsConfigError,
      type: error instanceof TypeError,
    };
  }
}

/** bun-jobs' error class through the seam. */
const asJobs: sql.SqlErrorOptions = {
  configError: (message, details) => new JobsConfigError(message, details),
};

/** bun-cache's error class through the seam. */
const asCache: sql.SqlErrorOptions = {
  configError: (message) => new TypeError(message),
};

const URLS = [
  "mysql://u:p@127.0.0.1:3307/db",
  "mysql://u:p@127.0.0.1:3307/db?allowPublicKeyRetrieval=true",
  "mysql://u:p@127.0.0.1:3307/db?allowPublicKeyRetrieval=TRUE&ssl=false",
  "mysql://u:p@127.0.0.1:3307/db?ssl=false&allowPublicKeyRetrieval=0",
  "mysql://u:p@127.0.0.1:3307/db?allowPublicKeyRetrieval=yes#frag",
  "mysql://u:p%40x@127.0.0.1:3307/db?allowPublicKeyRetrieval",
  "mysql://u:p@127.0.0.1:3307/db?allowPublicKeyRetrieval=maybe",
  "mariadb://u:p@h1:3306,h2:3307/db?a=1&&allowPublicKeyRetrieval=no&b=2",
  "mysql://u:p@127.0.0.1:3307/db?allowPublicKeyRetrieval=true&allowPublicKeyRetrieval=false",
  "mysql://u:p@127.0.0.1:3307/db?",
];

const INPUTS = [
  { url: "postgres://x@h/db", connection: { host: "ignored" } },
  {
    connection: {
      host: "db",
      port: 5433,
      user: "u s",
      password: "p@ss/word",
      database: "app",
      params: { sslmode: "require" },
    },
  },
  { connection: { tls: true, hosts: [{ host: "b" }, { host: "c", port: 9 }] } },
  { connection: { user: "u", database: 3, allowPublicKeyRetrieval: true } },
  {},
];

const DEFAULTS = [
  { scheme: "postgres", host: "127.0.0.1", port: 5432 },
  { scheme: "mysql", tlsScheme: "mysqls", port: 3306 },
  { scheme: "mariadb", databaseInPath: false },
];

describe("connection helpers against bun-jobs' and bun-cache's", () => {
  test("takeBooleanParam: bun-jobs' answers and refusals, its error class through the seam", () => {
    for (const url of URLS) {
      expect(
        outcome(() =>
          sql.takeBooleanParam(url, "allowPublicKeyRetrieval", asJobs),
        ),
      ).toEqual(
        outcome(() =>
          jobsConnection.takeBooleanParam(url, "allowPublicKeyRetrieval"),
        ),
      );
    }
  });

  test("toConnectionUrl, resolveConnectionUrl and databaseFromUrl", () => {
    for (const input of INPUTS) {
      for (const defaults of DEFAULTS) {
        expect(
          outcome(() =>
            sql.resolveConnectionUrl(input, defaults, "the driver", asJobs),
          ),
        ).toEqual(
          outcome(() =>
            jobsConnection.resolveConnectionUrl(input, defaults, "the driver"),
          ),
        );
        if (input.connection !== undefined) {
          expect(sql.toConnectionUrl(input.connection, defaults)).toBe(
            jobsConnection.toConnectionUrl(input.connection, defaults),
          );
        }
      }
    }
    for (const url of [
      ...URLS,
      "postgres://h/",
      "sqlite://x.db",
      "not a url",
    ]) {
      expect(sql.databaseFromUrl(url)).toBe(
        jobsConnection.databaseFromUrl(url),
      );
    }
  });

  test("sqlClientOptions: bun-cache's for its three engines, its TypeError through the seam", () => {
    for (const adapter of ["postgres", "mysql", "mariadb"] as const) {
      for (const input of [...URLS.map((url) => ({ url })), ...INPUTS]) {
        expect(
          outcome(() => sql.sqlClientOptions(adapter, input, "drv", asCache)),
        ).toEqual(
          outcome(() =>
            cacheConnection.sqlClientOptions(adapter, input, "drv"),
          ),
        );
      }
    }
  });

  test("isTransientLockError, isPublicKeyRetrievalRefusal and withLockRetry", async () => {
    const errors: unknown[] = [
      Object.assign(new Error("x"), { errno: 1213 }),
      Object.assign(new Error("x"), { errno: 1205 }),
      Object.assign(new Error("x"), { errno: 1020 }),
      Object.assign(new Error("x"), { errno: "40P01" }),
      Object.assign(new Error("x"), { code: "40001" }),
      Object.assign(new Error("x"), { sqlState: "40001" }),
      Object.assign(new Error("x"), { code: "SQLITE_BUSY_SNAPSHOT" }),
      new Error("Deadlock found when trying to get lock"),
      new Error("wrapped", {
        cause: Object.assign(new Error("y"), { errno: 1213 }),
      }),
      Object.assign(new Error("x"), {
        code: "ERR_MYSQL_PUBLIC_KEY_RETRIEVAL_NOT_ALLOWED",
      }),
      new Error("w", {
        cause: { code: "ERR_MYSQL_PUBLIC_KEY_RETRIEVAL_NOT_ALLOWED" },
      }),
      new Error("duplicate key"),
      Object.assign(new Error("x"), { errno: 1062 }),
      "a string",
      null,
    ];
    for (const error of errors) {
      expect(sql.isTransientLockError(error)).toBe(
        jobsDialect.isTransientLockError(error),
      );
      expect(sql.isTransientLockError(error)).toBe(
        cacheConnection.isTransientLockError(error),
      );
      expect(sql.isPublicKeyRetrievalRefusal(error)).toBe(
        cacheConnection.isPublicKeyRetrievalRefusal(error),
      );
    }
    for (const retry of [sql.withLockRetry, jobsDialect.withLockRetry]) {
      let calls = 0;
      expect(
        await retry(async () => {
          calls++;
          if (calls < 3) {
            throw Object.assign(new Error("deadlock"), { errno: 1213 });
          }
          return "done";
        }),
      ).toBe("done");
      expect(calls).toBe(3);
      calls = 0;
      await expect(
        retry(async () => {
          calls++;
          throw new Error("syntax error");
        }),
      ).rejects.toThrow("syntax error");
      expect(calls).toBe(1);
    }
  });
});

describe("page cursors against bun-jobs'", () => {
  const walk = ["ns", "queue", 3];
  const key = [1_790_000_000_000, "job:1"];

  test("the same cursor for the same walk and key", () => {
    expect(sql.encodePageCursor("rh1.", "history", walk, key)).toBe(
      jobsCursor.encodePageCursor("rh1.", "history", walk, key),
    );
  });

  test("the same answers and refusals, bun-jobs' class through the seam", () => {
    const good = jobsCursor.encodePageCursor("rh1.", "history", walk, key);
    const cursors = [
      good,
      good.slice(0, -3),
      `xx1.${good.slice(4)}`,
      jobsCursor.encodePageCursor("rh1.", "other", walk, key),
      jobsCursor.encodePageCursor("rh1.", "history", ["ns", "q2", 3], key),
      jobsCursor.encodePageCursor("rh1.", "history", walk, ["x", "job:1"]),
      jobsCursor.encodePageCursor("rh1.", "history", walk, [Number.NaN, "y"]),
      "rh1.!!!",
      "",
    ];
    for (const cursor of cursors) {
      expect(
        outcome(() =>
          sql.decodePageCursor(
            cursor,
            "rh1.",
            "history",
            walk,
            ["number", "string"],
            asJobs,
          ),
        ),
      ).toEqual(
        outcome(() =>
          jobsCursor.decodePageCursor(cursor, "rh1.", "history", walk, [
            "number",
            "string",
          ]),
        ),
      );
    }
  });
});

describe("the collation guard and warning against bun-jobs'", () => {
  test("a guard named as bun-jobs' shares bun-jobs' set", () => {
    const guard = sql.createCollationGuard(
      "@kingsleyweb/bun-jobs/collation-drift-checked",
    );
    jobsGuard.resetCollationWarnings();
    const key = `parity-${process.pid}-${Date.now()}`;
    expect(jobsGuard.claimCollationWarning(key)).toBe(true);
    expect(guard.claim(key)).toBe(false);
    guard.note([`${key}-noted`]);
    expect(jobsGuard.claimCollationWarning(`${key}-noted`)).toBe(false);
    guard.reset();
    expect(jobsGuard.claimCollationWarning(key)).toBe(true);
    jobsGuard.resetCollationWarnings();
  });

  test("the drift warning, named for the jobs tables, is bun-jobs' word for word", () => {
    const drift = [
      {
        table: "bun_jobs_jobs",
        column: "id",
        found: "utf8mb4_general_ci",
        expected: "utf8mb4_nopad_bin",
      },
      {
        table: "bun_jobs_jobs",
        column: "ns",
        found: "utf8mb4_general_ci",
        expected: "utf8mb4_nopad_bin",
      },
      {
        table: "bun_jobs_kv",
        column: "kv_key",
        found: "utf8mb4_uca1400_ai_ci",
        expected: "utf8mb4_nopad_bin",
      },
    ];
    for (const list of [drift, drift.slice(0, 1)]) {
      expect(sql.collationDriftWarning(list, "jobs tables")).toEqual(
        jobsSync.collationDriftWarning(list),
      );
    }
  });
});
