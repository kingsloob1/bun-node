/**
 * The SQL adapter's pure parts, with no database: quoting and index names,
 * the `where` compiler, the column types per engine, the CLI script and the
 * option errors.
 */
import type { CleanedWhere } from "better-auth/adapters";
import type { AuthSchemaChange } from "../../lib/sql";
import { describe, expect, test } from "bun:test";
import { ConfigError } from "@kingsleyweb/bun-common/lib/errors";
import { dialectFor } from "@kingsleyweb/bun-sql/dialect";
import { getAuthTables } from "better-auth/db";
import { bunSqlAdapter } from "../../lib/sql";
import { indexName, quoteIdentifier } from "../../lib/sql/identifiers";
import { buildAuthSchema } from "../../lib/sql/schema";
import { renderScript } from "../../lib/sql/sync";
import { compileWhere, createBinder } from "../../lib/sql/where";

/** A cleaned `where` clause with better-auth's defaults filled in. */
function clause(
  part: Partial<CleanedWhere> & Pick<CleanedWhere, "field" | "value">,
): CleanedWhere {
  return { operator: "eq", connector: "AND", mode: "sensitive", ...part };
}

describe("identifiers", () => {
  test("quotes for each engine, doubling the quote inside", () => {
    expect(quoteIdentifier("postgres", "user")).toBe('"user"');
    expect(quoteIdentifier("sqlite", 'we"ird')).toBe('"we""ird"');
    expect(quoteIdentifier("mysql", "key")).toBe("`key`");
    expect(quoteIdentifier("mariadb", "a`b")).toBe("`a``b`");
  });

  test("index names: lowercase, prefixed by kind and table, at most 63 bytes", () => {
    expect(indexName("ix", "auth_session", ["userId"])).toBe(
      "ix_auth_session_userid",
    );
    expect(indexName("ux", "user", ["email"])).toBe("ux_user_email");
    const long = indexName("ix", "a_very_long_table_prefix_organizationRole", [
      "organizationId",
      "role",
    ]);
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^ix_[\da-z_]+_[\da-f]{8}$/);
    // Two long names that differ only past the cut stay distinct.
    expect(long).not.toBe(
      indexName("ix", "a_very_long_table_prefix_organizationRole", [
        "organizationId",
        "roles",
      ]),
    );
    // A character that is not a word character is replaced, and the name hashed.
    expect(indexName("ix", "t-1", ["a"])).toMatch(/^ix_t_1_a_[\da-f]{8}$/);
  });
});

describe("where", () => {
  const column = (field: string) => `"${field}"`;

  test("binds every value, in order, with the engine's placeholders", () => {
    for (const [engine, first, second] of [
      ["postgres", "$1", "$2"],
      ["sqlite", "?", "?"],
    ] as const) {
      const binder = createBinder(dialectFor(engine).placeholder);
      const sql = compileWhere(
        engine,
        [
          clause({ field: "a", value: 1 }),
          clause({ field: "b", operator: "gt", value: 2 }),
        ],
        column,
        binder,
      );
      expect(sql).toBe(`("a" = ${first}) AND ("b" > ${second})`);
      expect(binder.params).toEqual([1, 2]);
    }
  });

  test("AND clauses all hold, OR clauses form one group", () => {
    const binder = createBinder(dialectFor("postgres").placeholder);
    expect(
      compileWhere(
        "postgres",
        [
          clause({ field: "a", value: 1 }),
          clause({ field: "b", value: 2, connector: "OR" }),
          clause({ field: "c", value: 3, connector: "OR" }),
        ],
        column,
        binder,
      ),
    ).toBe('("a" = $1) AND (("b" = $2) OR ("c" = $3))');
  });

  test("null, empty lists and lowercasing", () => {
    const binder = createBinder(dialectFor("mysql").placeholder);
    expect(
      compileWhere(
        "mysql",
        [clause({ field: "a", value: null })],
        column,
        binder,
      ),
    ).toBe('("a" IS NULL)');
    expect(
      compileWhere(
        "mysql",
        [clause({ field: "a", operator: "ne", value: null })],
        column,
        binder,
      ),
    ).toBe('("a" IS NOT NULL)');
    expect(
      compileWhere(
        "mysql",
        [clause({ field: "a", operator: "in", value: [] })],
        column,
        binder,
      ),
    ).toBe("(1 = 0)");
    expect(
      compileWhere(
        "mysql",
        [clause({ field: "a", operator: "not_in", value: [] })],
        column,
        binder,
      ),
    ).toBe("(1 = 1)");
    const insensitive = createBinder(dialectFor("mysql").placeholder);
    expect(
      compileWhere(
        "mysql",
        [clause({ field: "e", value: "Ada@X.com", mode: "insensitive" })],
        column,
        insensitive,
      ),
    ).toBe('(LOWER("e") = ?)');
    expect(insensitive.params).toEqual(["ada@x.com"]);
  });

  test("patterns escape their own wildcards; SQLite uses GLOB to stay case-sensitive", () => {
    const postgres = createBinder(dialectFor("postgres").placeholder);
    expect(
      compileWhere(
        "postgres",
        [clause({ field: "n", operator: "contains", value: "50%_off!" })],
        column,
        postgres,
      ),
    ).toBe(`("n" LIKE $1 ESCAPE '!')`);
    expect(postgres.params).toEqual(["%50!%!_off!!%"]);

    const ilike = createBinder(dialectFor("postgres").placeholder);
    expect(
      compileWhere(
        "postgres",
        [
          clause({
            field: "n",
            operator: "starts_with",
            value: "Ab",
            mode: "insensitive",
          }),
        ],
        column,
        ilike,
      ),
    ).toBe(`("n" ILIKE $1 ESCAPE '!')`);
    expect(ilike.params).toEqual(["ab%"]);

    const sqlite = createBinder(dialectFor("sqlite").placeholder);
    expect(
      compileWhere(
        "sqlite",
        [clause({ field: "n", operator: "ends_with", value: "a*b?[c" })],
        column,
        sqlite,
      ),
    ).toBe('("n" GLOB ?)');
    expect(sqlite.params).toEqual(["*a[*]b[?][[]c"]);
  });
});

describe("schema", () => {
  const tables = getAuthTables({ emailAndPassword: { enabled: true } });

  /** The `user` table's columns as `name type suffix`, for one engine. */
  function userColumns(
    engine: "postgres" | "mysql" | "mariadb" | "sqlite",
    numericIds = false,
  ) {
    const schema = buildAuthSchema(tables, {
      engine,
      dialect: dialectFor(engine),
      prefix: "p_",
      usePlural: false,
      numericIds,
    });
    const user = schema.byModel.get("user")!;
    return {
      name: user.name,
      columns: Object.fromEntries(
        user.columns.map((c) => [
          c.name,
          `${c.type}${c.suffix ? ` ${c.suffix}` : ""}`,
        ]),
      ),
      uniques: user.uniques.map((index) => index.name),
      primaryKey: user.primaryKey,
    };
  }

  test("Postgres: TEXT, BOOLEAN, TIMESTAMPTZ(3); email unique", () => {
    const user = userColumns("postgres");
    expect(user.name).toBe("p_user");
    expect(user.columns).toMatchObject({
      id: "TEXT NOT NULL",
      email: "TEXT NOT NULL",
      emailVerified: "BOOLEAN NOT NULL",
      image: "TEXT",
      createdAt: "TIMESTAMPTZ(3) NOT NULL",
    });
    expect(user.uniques).toEqual(["ux_p_user_email"]);
  });

  test("MySQL: identifiers VARCHAR(191) and other text MEDIUMTEXT, both in the binary collation", () => {
    const user = userColumns("mysql");
    expect(user.columns).toMatchObject({
      id: "VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL",
      email:
        "VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL",
      image: "MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL",
      emailVerified: "TINYINT(1) NOT NULL",
      createdAt: "DATETIME(3) NOT NULL",
    });
    expect(userColumns("mariadb").columns.id).toContain("utf8mb4_nopad_bin");
  });

  test("SQLite: dates as ISO text; serial ids carry their primary key inline", () => {
    expect(userColumns("sqlite").columns.createdAt).toBe("TEXT NOT NULL");
    const serial = userColumns("sqlite", true);
    expect(serial.columns.id).toBe("INTEGER PRIMARY KEY AUTOINCREMENT");
    expect(serial.primaryKey).toEqual([]);
    expect(userColumns("postgres", true).columns.id).toBe("BIGSERIAL NOT NULL");
  });

  test("a reference to an id has the id's type; usePlural pluralises; disableMigrations leaves a table out", () => {
    const schema = buildAuthSchema(
      {
        ...tables,
        extra: { modelName: "extra", fields: {}, disableMigrations: true },
      },
      {
        engine: "mysql",
        dialect: dialectFor("mysql"),
        prefix: "",
        usePlural: true,
        numericIds: false,
      },
    );
    const session = schema.byModel.get("sessions")!;
    expect(session.columns.find((c) => c.name === "userId")!.type).toBe(
      dialectFor("mysql").idType,
    );
    expect(schema.tables.map((t) => t.name)).not.toContain("extras");
  });
});

describe("the CLI script", () => {
  const change = (
    kind: AuthSchemaChange["kind"],
    statement: string,
  ): AuthSchemaChange => ({
    kind,
    table: "t",
    target: "c",
    statement,
    reason: "a reason",
    blocking: kind === "alter-column",
    applied: false,
  });

  test("writes what a default sync applies, and a retype only as a comment", () => {
    const script = renderScript([
      change("create-table", "CREATE TABLE IF NOT EXISTS t (\n  c TEXT\n)"),
      change("alter-column", "ALTER TABLE t ALTER COLUMN c TYPE TEXT"),
    ]);
    expect(script).toContain("CREATE TABLE IF NOT EXISTS t (\n  c TEXT\n);");
    expect(script).toContain("-- ALTER TABLE t ALTER COLUMN c TYPE TEXT;");
    expect(script).not.toMatch(/^ALTER TABLE/m);
  });

  test("says so when there is nothing to do", () => {
    expect(renderScript([])).toBe("-- better-auth's tables are up to date.\n");
  });
});

describe("options", () => {
  test("needs a client, a URL or a connection with an adapter", () => {
    expect(() => bunSqlAdapter({})).toThrow(ConfigError);
    expect(() => bunSqlAdapter({ connection: { host: "db" } })).toThrow(
      ConfigError,
    );
    expect(() => bunSqlAdapter({ url: "redis://localhost" })).toThrow(
      ConfigError,
    );
  });

  test("detects the engine from the URL, and SQLite from a bare path", async () => {
    const memory = bunSqlAdapter({ url: ":memory:" });
    expect(memory.engine).toBe("sqlite");
    await memory.close();
    for (const [url, engine] of [
      ["postgres://u@127.0.0.1:1/x", "postgres"],
      ["mariadb://u@127.0.0.1:1/x", "mariadb"],
    ] as const) {
      // A client is opened but never connects: nothing is queried.
      const adapter = bunSqlAdapter({ url });
      expect(adapter.engine).toBe(engine);
      await adapter.close();
    }
  });
});
