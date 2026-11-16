/**
 * bun-sql's own surface, without a server: what each refusing function
 * throws by default (bun-common's `ConfigError`) and through the
 * `configError` seam, `createSchema`'s refusals, the dialects' identity and
 * new column types, the sync defaults, collation guards kept apart by name,
 * and `loadMongoClient`.
 */
import { describe, expect, it } from "bun:test";
import { ConfigError } from "@kingsleyweb/bun-common";
import {
  createCollationGuard,
  createSchema,
  decodePageCursor,
  defaultConfigError,
  detectAdapter,
  dialectFor,
  encodePageCursor,
  keysetAfter,
  loadMongoClient,
  resolveConnectionUrl,
  resolveSyncOptions,
  takeBooleanParam,
} from "../../lib/index";

/** An error class of the caller's own, for the seam. */
class OwnError extends Error {
  constructor(
    message: string,
    /** The offending values. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** The seam, bound to {@link OwnError}. */
const own = {
  configError: (message: string, details?: Record<string, unknown>) =>
    new OwnError(message, details),
};

describe("errors: bun-common's ConfigError by default, the caller's through the seam", () => {
  const refusals: [string, (options?: typeof own) => unknown][] = [
    ["dialectFor", (o) => dialectFor("oracle" as never, o)],
    ["detectAdapter", (o) => detectAdapter("oracle://h", o)],
    ["detectAdapter (no url)", (o) => detectAdapter(undefined, o)],
    ["jsonOrBit", (o) => dialectFor("sqlite", o).jsonOrBit("d", "k", -1)],
    [
      "createSchema",
      (o) =>
        createSchema(
          {
            tables: [],
            indexes: [{ name: "ix_a", table: "missing", columns: ["a"] }],
          },
          dialectFor("sqlite"),
          o,
        ),
    ],
    [
      "resolveConnectionUrl",
      (o) => resolveConnectionUrl({}, { scheme: "x" }, "It", o),
    ],
    [
      "takeBooleanParam",
      (o) => takeBooleanParam("x://h/?flag=perhaps", "flag", o),
    ],
    [
      "decodePageCursor",
      (o) => decodePageCursor("nope", "p1.", "k", [], [], o),
    ],
  ];

  for (const [name, refuse] of refusals) {
    it(name, () => {
      expect(() => refuse()).toThrow(ConfigError);
      let thrown: unknown;
      try {
        refuse(own);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(OwnError);
      expect((thrown as Error).message.length).toBeGreaterThan(0);
    });
  }

  it("defaultConfigError makes bun-common's ConfigError, with its details", () => {
    const error = defaultConfigError("bad", { a: 1 });
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).details).toEqual({ a: 1 });
  });
});

describe("createSchema", () => {
  const dialect = dialectFor("postgres");

  it("refuses a table or an index with no name, and an index on an undefined table", () => {
    expect(() =>
      createSchema(
        { tables: [{ name: "", columns: [], primaryKey: [] }], indexes: [] },
        dialect,
      ),
    ).toThrow("The SQL schema defines a table with no name");
    expect(() =>
      createSchema(
        {
          tables: [{ name: "t", columns: [], primaryKey: [] }],
          indexes: [{ name: "", table: "t", columns: ["a"] }],
        },
        dialect,
      ),
    ).toThrow("The SQL schema defines an index with no name");
    expect(() =>
      createSchema(
        {
          tables: [{ name: "t", columns: [], primaryKey: [] }],
          indexes: [{ name: "ix_u", table: "u", columns: ["a"] }],
        },
        dialect,
      ),
    ).toThrow(`The SQL schema's index "ix_u" is on a table it does not define`);
  });

  it("renders tables then indexes, and leaves out the indexes of an existing table", () => {
    const definition = {
      tables: [
        {
          name: "t",
          primaryKey: ["id"],
          columns: [
            { name: "id", type: dialect.idType, suffix: "NOT NULL" },
            { name: "body", type: dialect.documentType },
          ],
        },
        {
          name: "u",
          primaryKey: [],
          columns: [{ name: "a", type: "INTEGER" }],
        },
      ],
      indexes: [
        {
          name: "ix_t_body",
          table: "t",
          columns: ["id"],
          predicate: "body IS NOT NULL",
        },
        {
          name: "ix_u_a",
          table: "u",
          columns: [{ name: "a", collation: '"C"' }],
        },
      ],
    };
    expect(createSchema(definition, dialect)).toEqual([
      "CREATE TABLE IF NOT EXISTS t (\n      id TEXT NOT NULL,\n      body JSONB,\n      PRIMARY KEY (id)\n    )",
      "CREATE TABLE IF NOT EXISTS u (\n      a INTEGER\n    )",
      "CREATE INDEX IF NOT EXISTS ix_t_body ON t (id) WHERE body IS NOT NULL",
      'CREATE INDEX IF NOT EXISTS ix_u_a ON u (a COLLATE "C")',
    ]);
    expect(
      createSchema(definition, dialect, { existing: new Set(["t"]) }),
    ).toHaveLength(3);
  });
});

describe("dialects", () => {
  it("one dialect object per adapter and error maker", () => {
    expect(dialectFor("mysql")).toBe(dialectFor("mysql"));
    expect(dialectFor("mysql", own)).toBe(dialectFor("mysql", own));
    expect(dialectFor("mysql", own)).not.toBe(dialectFor("mysql"));
  });

  it("the new column types", () => {
    expect(
      (["postgres", "mysql", "mariadb", "sqlite"] as const).map((adapter) => [
        dialectFor(adapter).documentType,
        dialectFor(adapter).inetType,
      ]),
    ).toEqual([
      ["JSONB", "INET"],
      ["JSON", null],
      ["JSON", null],
      ["TEXT", null],
    ]);
    // MariaDB reports JSON as longtext; its normalisation says so, so a fresh
    // document column is no drift.
    expect(dialectFor("mariadb").normalizeType("JSON")).toBe("longtext");
  });

  it("keysetAfter is the dialect's predicate", () => {
    const dialect = dialectFor("mysql");
    const cursor = {
      columns: ["at"],
      values: [1],
      idColumn: "id",
      id: "x",
      direction: "asc" as const,
    };
    expect(keysetAfter(dialect, () => "?", cursor)).toBe(
      dialect.keysetAfter(() => "?", cursor),
    );
  });
});

describe("sync options, cursors, guards, MongoDB", () => {
  it("resolveSyncOptions defaults to everything that cannot block", () => {
    expect(resolveSyncOptions(undefined)).toEqual({
      add: true,
      indexes: true,
      alterColumns: false,
      dryRun: false,
    });
    expect(resolveSyncOptions(true)).toEqual(resolveSyncOptions({}));
    expect(
      resolveSyncOptions({ alterColumns: true, add: false }),
    ).toMatchObject({
      alterColumns: true,
      add: false,
    });
  });

  it("a cursor decodes to its key, and refuses another walk", () => {
    const cursor = encodePageCursor("p1.", "k", ["w"], [3, "id"]);
    expect(
      decodePageCursor(cursor, "p1.", "k", ["w"], ["number", "string"]),
    ).toEqual([3, "id"]);
    expect(() =>
      decodePageCursor(cursor, "p1.", "k", ["v"], ["number", "string"]),
    ).toThrow("this cursor belongs to another walk");
  });

  it("guards with different names keep different sets", () => {
    const a = createCollationGuard(`@test/a-${Date.now()}`);
    const b = createCollationGuard(`@test/b-${Date.now()}`);
    expect(a.claim("k")).toBe(true);
    expect(a.claim("k")).toBe(false);
    expect(b.claim("k")).toBe(true);
    a.reset();
    expect(a.claim("k")).toBe(true);
  });

  it("loadMongoClient answers the MongoClient constructor of the optional peer", async () => {
    const MongoClient = await loadMongoClient("the test");
    expect(typeof MongoClient).toBe("function");
    expect(MongoClient.name).toBe("MongoClient");
  });
});
