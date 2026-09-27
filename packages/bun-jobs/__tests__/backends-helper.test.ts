import { describe, expect, it } from "bun:test";
import { serverDriverConfig } from "./helpers/backends";

/**
 * The cross-process suites must run their SQL servers on the shared test
 * tables (`bun_jobs_test_*`), which the current DDL creates, never on the
 * default `bun_jobs_*` tables: a shared server can still hold those in an old
 * driver's shape, and a suite would then test that schema instead.
 */
describe("crossProcessBackends' server configs", () => {
  for (const name of ["postgres", "mysql", "mariadb"]) {
    it(`puts ${name} on the bun_jobs_test_ tables`, () => {
      const config = serverDriverConfig(name, `${name}://u:p@127.0.0.1/db`);
      expect(config).toMatchObject({
        type: "sql",
        tablePrefix: "bun_jobs_test_",
      });
    });
  }

  it("leaves the non-SQL servers without a table prefix", () => {
    expect(
      serverDriverConfig("redis", "redis://127.0.0.1:6379/15"),
    ).not.toHaveProperty("tablePrefix");
    expect(
      serverDriverConfig("mongodb", "mongodb://127.0.0.1/db"),
    ).not.toHaveProperty("tablePrefix");
  });
});
