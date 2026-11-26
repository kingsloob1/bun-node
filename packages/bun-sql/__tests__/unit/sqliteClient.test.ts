/**
 * `sqlClientOptions` and `openSqlClient` on SQLite (#886): every form
 * `detectAdapter` calls SQLite opens a SQLite client, a bare file path
 * included, which Bun alone reads as a Postgres URL. The server engines'
 * options are unchanged: their URL names the engine.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import {
  detectAdapter,
  openSqlClient,
  sqlClientOptions,
} from "../../lib/index";

const DIR = mkdtempSync(join(tmpdir(), "bun-sql-sqlite-client-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

/** The adapter and file Bun's client was opened with. */
function opened(client: unknown): { adapter: string; filename?: unknown } {
  return (client as { options: { adapter: string; filename?: unknown } })
    .options;
}

describe("openSqlClient on SQLite (#886)", () => {
  const file = (name: string) => join(DIR, name);
  const forms: readonly (readonly [string, () => string, string])[] = [
    ["a bare absolute path", () => file("bare.sqlite"), file("bare.sqlite")],
    [
      "a bare relative path",
      () => `./${relative(process.cwd(), file("relative.sqlite"))}`,
      file("relative.sqlite"),
    ],
    [
      "sqlite://",
      () => `sqlite://${file("scheme.sqlite")}`,
      file("scheme.sqlite"),
    ],
    ["file:", () => `file:${file("file.sqlite")}`, file("file.sqlite")],
  ];

  for (const [label, url, path] of forms) {
    it(`opens ${label} as the SQLite file detectAdapter names`, async () => {
      expect(detectAdapter(url())).toBe("sqlite");
      const client = openSqlClient("sqlite", { url: url() }, "test");
      try {
        expect(opened(client).adapter).toBe("sqlite");
        await client.unsafe("CREATE TABLE t (id INTEGER PRIMARY KEY)");
        await client.unsafe("INSERT INTO t (id) VALUES (1)");
        const rows: unknown = await client.unsafe("SELECT id FROM t");
        expect(rows).toEqual([{ id: 1 }]);
      } finally {
        await client.close();
      }
      // The file is the one named, created on the first write.
      expect(existsSync(path)).toBe(true);
    });
  }

  it("opens :memory: in memory", async () => {
    const client = openSqlClient("sqlite", { url: ":memory:" }, "test");
    try {
      expect(opened(client).adapter).toBe("sqlite");
      const rows: unknown = await client.unsafe("SELECT 1 AS one");
      expect(rows).toEqual([{ one: 1 }]);
    } finally {
      await client.close();
    }
  });

  it("names the adapter in sqlClientOptions for SQLite only", () => {
    expect(
      sqlClientOptions("sqlite", { url: "/data/app.sqlite" }, "t"),
    ).toEqual({ adapter: "sqlite", url: "/data/app.sqlite" });
    // The server engines' options are as they were: the URL names them.
    expect(
      sqlClientOptions("postgres", { url: "postgres://h/db" }, "t"),
    ).toEqual({ url: "postgres://h/db" });
    expect(
      sqlClientOptions(
        "mysql",
        { url: "mysql://h/db?allowPublicKeyRetrieval=true" },
        "t",
      ),
    ).toEqual({ url: "mysql://h/db", allowPublicKeyRetrieval: true });
    expect(sqlClientOptions("mariadb", { url: "mariadb://h/db" }, "t")).toEqual(
      { url: "mariadb://h/db" },
    );
  });
});
