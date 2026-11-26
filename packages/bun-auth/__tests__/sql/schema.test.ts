/**
 * The adapter's schema on every engine: created from empty, synced from a
 * drifted table, planned by a dry run, written as better-auth's CLI script,
 * and created on first use with `syncSchema: true`.
 *
 * The baseline is bun-sql's: a schema the adapter has just created reports
 * no change, so the definitions and the DDL agree on every column type the
 * engine reports back. Its negative control plants a drift and expects it
 * reported.
 */
import type { SqlAdapter } from "@kingsleyweb/bun-sql/dialect";
import type { BetterAuthOptions } from "better-auth";
import type { AuthSchemaChange } from "../../lib/sql";
import { afterAll, describe, expect, test } from "bun:test";
import { getAuthTables } from "better-auth/db";
import {
  admin,
  jwt,
  organization,
  twoFactor,
  username,
} from "better-auth/plugins";
import { bunSqlAdapter } from "../../lib/sql";
import { quoteIdentifier } from "../../lib/sql/identifiers";
import { createdTables, dropTables, forEachEngine, runPrefix } from "./helpers";

/** better-auth with a broad set of plugins, and its rate limit in the database (a `key` column). */
function options(extra: BetterAuthOptions = {}): BetterAuthOptions {
  return {
    emailAndPassword: { enabled: true },
    plugins: [
      twoFactor(),
      organization({ teams: { enabled: true } }),
      admin(),
      username(),
      jwt(),
    ],
    rateLimit: { storage: "database" },
    ...extra,
  };
}

/** The changes, as `kind table/target applied`, for a readable failure. */
function summary(changes: readonly AuthSchemaChange[]): string[] {
  return changes.map(
    (change) =>
      `${change.kind} ${change.table}/${change.target} ${change.applied ? "applied" : "pending"}`,
  );
}

/** The statements of a script better-auth's CLI would write, comments left out. */
function statementsOf(script: string): string[] {
  return script
    .split(/;\n/)
    .map((part) =>
      part
        .split("\n")
        .filter((line) => !line.startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((part) => part.length > 0);
}

await forEachEngine((engine, client) => {
  const name = engine.name;
  const q = (identifier: string) => quoteIdentifier(name, identifier);
  const created = new Set<string>();
  const track = (changes: readonly AuthSchemaChange[]) => {
    for (const table of createdTables(changes)) {
      created.add(table);
    }
    return changes;
  };

  describe(`schema on ${name}`, () => {
    afterAll(async () => {
      await dropTables(name, client, created);
      await client.close();
    });

    for (const ids of ["string", "serial"] as const) {
      test(`from empty (${ids} ids): every table is created, and a second sync finds nothing`, async () => {
        const prefix = runPrefix();
        const auth = options(
          ids === "serial"
            ? { advanced: { database: { generateId: "serial" } } }
            : {},
        );
        const adapter = bunSqlAdapter({ sql: client, adapter: name, prefix });
        const first = track(await adapter.syncSchema(auth));
        const expected = Object.values(getAuthTables(auth)).map(
          (table) => `${prefix}${table.modelName}`,
        );
        expect(createdTables(first).sort()).toEqual(expected.sort());
        expect(first.every((change) => change.applied)).toBe(true);

        // bun-sql's baseline: what the adapter created matches its definition.
        expect(summary(await adapter.syncSchema(auth))).toEqual([]);

        // Negative control: drop a column the definition has; it is reported.
        await client.unsafe(
          `ALTER TABLE ${q(`${prefix}user`)} DROP COLUMN ${q("image")}`,
        );
        expect(
          summary(await adapter.syncSchema(auth, { dryRun: true })),
        ).toEqual([`add-column ${prefix}user/image pending`]);
      });
    }

    test("a dry run on an empty database plans every table and creates none", async () => {
      const prefix = runPrefix();
      const adapter = bunSqlAdapter({ sql: client, adapter: name, prefix });
      const plan = await adapter.syncSchema(options(), { dryRun: true });
      expect(plan.length).toBeGreaterThan(0);
      expect(plan.some((change) => change.applied)).toBe(false);
      const again = await adapter.syncSchema(options(), { dryRun: true });
      expect(summary(again)).toEqual(summary(plan));
    });

    test("a drifted table: missing columns and unique index added, a stale ix_ index dropped, a retype only when asked", async () => {
      const prefix = runPrefix();
      const user = `${prefix}user`;
      const auth: BetterAuthOptions = { emailAndPassword: { enabled: true } };
      const adapter = bunSqlAdapter({ sql: client, adapter: name, prefix });
      track(await adapter.syncSchema(auth));
      const db = adapter(auth);
      const person = () => ({
        name: "N",
        email: `${prefix}${crypto.randomUUID().slice(0, 8)}@example.com`,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.create({ model: "user", data: person() });

      // Drift it the way an older or hand-edited schema would be: a required
      // and an optional column gone (on a table with a row in it), the email
      // retyped, its unique index gone, a stale `ix_` index and one made by hand.
      const unique = `ux_${user.toLowerCase()}_email`;
      const stale = `ix_${user}_stale`.toLowerCase();
      const handMade = `hand_${prefix}created`.toLowerCase();
      await client.unsafe(`ALTER TABLE ${q(user)} DROP COLUMN ${q("image")}`);
      await client.unsafe(
        `ALTER TABLE ${q(user)} DROP COLUMN ${q("emailVerified")}`,
      );
      await client.unsafe(
        name === "postgres" || name === "sqlite"
          ? `DROP INDEX ${unique}`
          : `DROP INDEX ${unique} ON ${q(user)}`,
      );
      const retype = name !== "sqlite";
      if (name === "postgres") {
        await client.unsafe(
          `ALTER TABLE ${q(user)} ALTER COLUMN ${q("email")} TYPE VARCHAR(100)`,
        );
      } else if (retype) {
        // The adapter's type in a case-insensitive collation: a collation drift.
        await client.unsafe(
          `ALTER TABLE ${q(user)} MODIFY COLUMN ${q("email")} VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL`,
        );
      }
      await client.unsafe(
        `CREATE INDEX ${stale} ON ${q(user)} (${q("updatedAt")})`,
      );
      await client.unsafe(
        `CREATE INDEX ${handMade} ON ${q(user)} (${q("createdAt")})`,
      );

      const changes = await adapter.syncSchema(auth);
      expect(summary(changes).sort()).toEqual(
        [
          `add-column ${user}/image applied`,
          `add-column ${user}/emailVerified applied`,
          ...(retype ? [`alter-column ${user}/email pending`] : []),
          `drop-index ${user}/${stale} applied`,
          `create-index ${user}/${unique} applied`,
        ].sort(),
      );
      if (retype) {
        const alter = changes.find((change) => change.kind === "alter-column")!;
        expect(alter.blocking).toBe(true);
        if (name !== "postgres") {
          expect(alter.collation).toEqual({
            found: "utf8mb4_general_ci",
            expected: binaryCollation(name),
          });
        }
      }

      // Only the retype is left, and the hand-made index is never touched.
      expect(summary(await adapter.syncSchema(auth, { dryRun: true }))).toEqual(
        retype ? [`alter-column ${user}/email pending`] : [],
      );
      const indexes: { name: string }[] = await client.unsafe(
        indexListQuery(name),
        [user],
      );
      expect(indexes.map((row) => String(row.name))).toContain(handMade);

      if (retype) {
        expect(
          summary(await adapter.syncSchema(auth, { alterColumns: true })),
        ).toEqual([`alter-column ${user}/email applied`]);
        expect(summary(await adapter.syncSchema(auth))).toEqual([]);
      }

      // Columns added to a populated table are nullable, so the old row stays
      // and a new user still goes in.
      expect(await db.count({ model: "user" })).toBe(1);
      await db.create({ model: "user", data: person() });
      expect(await db.count({ model: "user" })).toBe(2);
    });

    test("better-auth's CLI script (createSchema) builds the schema a sync then finds complete", async () => {
      const prefix = runPrefix();
      const adapter = bunSqlAdapter({ sql: client, adapter: name, prefix });
      const auth = options();
      const generated = await adapter(auth).createSchema!(auth, "auth.sql");
      expect(generated.path).toBe("auth.sql");
      expect(generated.code).toContain(
        `CREATE TABLE IF NOT EXISTS ${q(`${prefix}user`)}`,
      );
      for (const statement of statementsOf(generated.code)) {
        await client.unsafe(statement);
      }
      for (const table of Object.values(getAuthTables(auth))) {
        created.add(`${prefix}${table.modelName}`);
      }
      expect(summary(await adapter.syncSchema(auth))).toEqual([]);
    });

    test("syncSchema: true creates the tables before the first query", async () => {
      const prefix = runPrefix();
      const auth: BetterAuthOptions = { emailAndPassword: { enabled: true } };
      for (const table of Object.values(getAuthTables(auth))) {
        created.add(`${prefix}${table.modelName}`);
      }
      const db = bunSqlAdapter({
        sql: client,
        adapter: name,
        prefix,
        syncSchema: true,
      })(auth);
      expect(await db.count({ model: "user" })).toBe(0);
      const check = bunSqlAdapter({ sql: client, adapter: name, prefix });
      expect(summary(await check.syncSchema(auth))).toEqual([]);
    });
  });
});

/** The exact (binary, NO PAD) collation bun-sql gives identifiers on MySQL or MariaDB. */
function binaryCollation(engine: SqlAdapter): string {
  return engine === "mysql" ? "utf8mb4_0900_bin" : "utf8mb4_nopad_bin";
}

/** A query listing a table's index names, the table bound as its one parameter. */
function indexListQuery(engine: SqlAdapter): string {
  switch (engine) {
    case "postgres":
      return "SELECT indexname AS name FROM pg_indexes WHERE tablename = $1";
    case "sqlite":
      return "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?";
    default:
      return "SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?";
  }
}
