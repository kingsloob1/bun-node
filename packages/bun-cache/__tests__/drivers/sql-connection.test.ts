/**
 * The drift test for the connection helpers bun-cache copied from bun-jobs
 * (plan §8.3): the same inputs through both copies, compared — behaviour,
 * not text. A fix that lands in one copy and not the other fails here.
 *
 * bun-jobs is not a dependency of bun-cache, so its source is imported by
 * relative path: this test only exists inside the repository.
 *
 * Also pinned: the Bun behaviour the MySQL handling exists for — Bun ignores
 * `allowPublicKeyRetrieval` in a URL and honours it only as an option. When
 * Bun starts reading the parameter, the "Bun ignores it" case fails, and the
 * extraction can go (in both packages).
 *
 * No server is needed: `new SQL(...)` connects lazily, and `options` is read
 * without a connection.
 */
import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import * as jobsConnection from "../../../bun-jobs/lib/shared/connection";
import * as jobsDialect from "../../../bun-jobs/lib/drivers/sql/dialect";
import {
  isTransientLockError,
  resolveConnectionUrl,
  sqlClientOptions,
  takeBooleanParam,
  toConnectionUrl,
  withLockRetry,
} from "../../lib/drivers/sql-connection";

/** What a call did: its value, or that it threw (and what it said). */
function outcome(run: () => unknown): unknown {
  try {
    return { value: run() };
  } catch (error) {
    return { threw: (error as Error).message };
  }
}

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

describe("drift: bun-cache's copied connection helpers behave like bun-jobs'", () => {
  test("takeBooleanParam", () => {
    for (const url of URLS) {
      expect(
        outcome(() => takeBooleanParam(url, "allowPublicKeyRetrieval")),
      ).toEqual(
        outcome(() =>
          jobsConnection.takeBooleanParam(url, "allowPublicKeyRetrieval"),
        ),
      );
    }
  });

  test("toConnectionUrl and resolveConnectionUrl", () => {
    const inputs = [
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
      {
        connection: {
          tls: true,
          hosts: [{ host: "b" }, { host: "c", port: 9 }],
        },
      },
      { connection: { user: "u", database: 3 } },
      {},
    ];
    const defaults = [
      { scheme: "postgres", host: "127.0.0.1", port: 5432 },
      { scheme: "mysql", tlsScheme: "mysqls", port: 3306 },
      { scheme: "mariadb", databaseInPath: false },
    ];
    for (const input of inputs) {
      for (const each of defaults) {
        expect(
          outcome(() => resolveConnectionUrl(input, each, "the driver")),
        ).toEqual(
          outcome(() =>
            jobsConnection.resolveConnectionUrl(input, each, "the driver"),
          ),
        );
        if (input.connection !== undefined) {
          expect(toConnectionUrl(input.connection, each)).toBe(
            jobsConnection.toConnectionUrl(input.connection, each),
          );
        }
      }
    }
  });

  test("isTransientLockError", () => {
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
      new Error("duplicate key"),
      Object.assign(new Error("x"), { errno: 1062 }),
      "a string",
      null,
    ];
    for (const error of errors) {
      expect(isTransientLockError(error)).toBe(
        jobsDialect.isTransientLockError(error),
      );
    }
  });

  test("withLockRetry retries transient errors and rethrows the rest, like bun-jobs'", async () => {
    for (const retry of [withLockRetry, jobsDialect.withLockRetry]) {
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

describe("the MySQL allowPublicKeyRetrieval handling", () => {
  test("Bun ignores the parameter in a URL (why it is taken out)", () => {
    const client = new SQL({
      url: "mysql://u:p@127.0.0.1:3307/db?allowPublicKeyRetrieval=true",
    });
    expect(client.options.allowPublicKeyRetrieval).not.toBe(true);
    void client.close();
  });

  test("sqlClientOptions moves it from the URL into the option Bun honours", () => {
    const opts = sqlClientOptions(
      "mysql",
      {
        url: "mysql://u:p@127.0.0.1:3307/db?ssl=false&allowPublicKeyRetrieval=true",
      },
      "mysqlDriver",
    );
    expect(opts).toEqual({
      url: "mysql://u:p@127.0.0.1:3307/db?ssl=false",
      allowPublicKeyRetrieval: true,
    });
    const client = new SQL(opts);
    expect(client.options.allowPublicKeyRetrieval).toBe(true);
    void client.close();
  });

  test("the URL wins over the connection field; the field is used without a URL", () => {
    expect(
      sqlClientOptions(
        "mariadb",
        {
          url: "mariadb://u@h/db?allowPublicKeyRetrieval=false",
          connection: { allowPublicKeyRetrieval: true },
        },
        "mariadbDriver",
      ).allowPublicKeyRetrieval,
    ).toBe(false);
    expect(
      sqlClientOptions(
        "mysql",
        { connection: { host: "h", allowPublicKeyRetrieval: true } },
        "mysqlDriver",
      ),
    ).toEqual({ url: "mysql://h:3306/", allowPublicKeyRetrieval: true });
  });

  test("Postgres keeps every parameter in the URL", () => {
    expect(
      sqlClientOptions(
        "postgres",
        { url: "postgres://h/db?allowPublicKeyRetrieval=true&sslmode=disable" },
        "postgresDriver",
      ),
    ).toEqual({
      url: "postgres://h/db?allowPublicKeyRetrieval=true&sslmode=disable",
    });
  });

  test("a malformed value is refused", () => {
    expect(() =>
      sqlClientOptions(
        "mysql",
        { url: "mysql://h/db?allowPublicKeyRetrieval=perhaps" },
        "mysqlDriver",
      ),
    ).toThrow(TypeError);
  });
});
