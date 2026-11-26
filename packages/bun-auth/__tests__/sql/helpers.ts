/* eslint-disable bun:test/no-export -- shared test helpers, as the root bunfig allows under __tests__/helpers/ */
/**
 * The engines bun-auth's SQL adapter suites run on, and their clean-up.
 *
 * SQLite always runs (in memory, or a temporary file). Each server runs when
 * its URL is set: `BUN_AUTH_TEST_{POSTGRES,MYSQL,MARIADB}_URL`, falling back
 * to bun-jobs' `BUN_JOBS_TEST_*_URL` (`bun scripts/setup-databases.ts
 * --print-env`). An unset URL skips that engine visibly; a set URL whose
 * server cannot be reached fails, so a broken URL never reads as coverage.
 *
 * Every run puts its tables under a prefix of its own (`a6t_<random>_`) and
 * drops exactly the tables it created, by name, never by pattern.
 */
import type { SQL } from "bun";
import type { SqlAdapter } from "@kingsleyweb/bun-sql/dialect";
import type { AuthSchemaChange } from "../../lib/sql";
import { describe, test } from "bun:test";
import { openSqlClient } from "@kingsleyweb/bun-sql/connection";
import { quoteIdentifier } from "../../lib/sql/identifiers";

/** One engine a suite may run on. */
export interface Engine {
  /** The engine's name, as bun-sql's dialects name it. */
  readonly name: SqlAdapter;
  /** The variable its URL came from, or `null` for SQLite. */
  readonly variable: string | null;
  /** The URL, or `undefined` when unset. */
  readonly url: string | undefined;
}

/** The server engines and the variables naming them, in order. */
const SERVERS: readonly {
  /** The engine. */
  name: Exclude<SqlAdapter, "sqlite">;
  /** bun-auth's own variable. */
  own: string;
  /** bun-jobs' variable, the fallback. */
  fallback: string;
}[] = [
  {
    name: "postgres",
    own: "BUN_AUTH_TEST_POSTGRES_URL",
    fallback: "BUN_JOBS_TEST_POSTGRES_URL",
  },
  {
    name: "mysql",
    own: "BUN_AUTH_TEST_MYSQL_URL",
    fallback: "BUN_JOBS_TEST_MYSQL_URL",
  },
  {
    name: "mariadb",
    own: "BUN_AUTH_TEST_MARIADB_URL",
    fallback: "BUN_JOBS_TEST_MARIADB_URL",
  },
];

/** Every engine, SQLite first, each with its URL (or none). */
export function engines(): Engine[] {
  return [
    { name: "sqlite", variable: null, url: ":memory:" },
    ...SERVERS.map((server) => {
      const own = process.env[server.own];
      const fallback = process.env[server.fallback];
      return {
        name: server.name,
        variable: own ? server.own : fallback ? server.fallback : server.own,
        url: own || fallback || undefined,
      };
    }),
  ];
}

/** A random prefix for one run's tables: `a6t_` and six letters or digits. */
export function runPrefix(): string {
  return `a6t_${Math.random().toString(36).slice(2, 8)}_`;
}

/** Opens a client for an engine (MySQL's `allowPublicKeyRetrieval` handled by bun-sql). */
export function openClient(engine: Engine): SQL {
  return openSqlClient(
    engine.name,
    { url: engine.url! },
    `the ${engine.name} test client`,
    {
      connectionTimeout: 10,
    },
  );
}

/**
 * Runs `register` with a connected client for each engine whose URL is set:
 * a `describe` per engine. An unset URL registers a skipped test that says
 * which variable to set; a set URL whose server does not answer registers a
 * failing one.
 */
export async function forEachEngine(
  register: (engine: Engine, client: SQL) => void | Promise<void>,
  only?: SqlAdapter,
): Promise<void> {
  for (const engine of engines().filter((e) => !only || e.name === only)) {
    if (!engine.url) {
      describe(`engine ${engine.name}`, () => {
        test.skip(`${engine.variable} is unset: ${engine.name} not covered`, () => {});
      });
      continue;
    }
    const client = openClient(engine);
    try {
      await client.unsafe("SELECT 1");
    } catch (error) {
      await client.close().catch(() => {});
      describe(`engine ${engine.name}: unreachable`, () => {
        test(`connects to the server ${engine.variable} names`, () => {
          throw new Error(
            `${engine.variable} is set, but the ${engine.name} server could not be reached, so its tests would have been skipped and the run still green. Start it (bun scripts/setup-databases.ts), fix the URL, or unset the variable.\n  ${(error as Error).message}`,
            { cause: error },
          );
        });
      });
      continue;
    }
    await register(engine, client);
  }
}

/** The tables a sync created, by name: what a test later drops. */
export function createdTables(changes: readonly AuthSchemaChange[]): string[] {
  return changes
    .filter((change) => change.kind === "create-table" && change.applied)
    .map((change) => change.table);
}

/** Drops exactly the named tables, if they exist. */
export async function dropTables(
  engine: SqlAdapter,
  client: SQL,
  tables: Iterable<string>,
): Promise<void> {
  for (const table of new Set(tables)) {
    await client.unsafe(
      `DROP TABLE IF EXISTS ${quoteIdentifier(engine, table)}`,
    );
  }
}
