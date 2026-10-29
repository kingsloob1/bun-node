import type { Backend } from "./types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * Which backends this machine can run, and where they live.
 *
 * The benchmark uses databases of its own (plan §14.3): **`bun_cache_bench`**
 * on Postgres, MySQL, MariaDB and MongoDB, and Redis database **12** — bun-jobs'
 * tests use 15, its bench 14, bun-cache's tests 13 or 15 — so a long run
 * cannot disturb a test suite, and a test run cannot make a figure look slow.
 * Inside them, every child names what it creates after its own run id and
 * deletes exactly that when it ends.
 */

/** The environment variable that points each networked backend somewhere else. */
export const BACKEND_ENV_VAR: Partial<Record<Backend, string>> = {
  redis: "BUN_CACHE_BENCH_REDIS_URL",
  postgres: "BUN_CACHE_BENCH_POSTGRES_URL",
  mysql: "BUN_CACHE_BENCH_MYSQL_URL",
  mariadb: "BUN_CACHE_BENCH_MARIADB_URL",
  mongodb: "BUN_CACHE_BENCH_MONGODB_URL",
};

/**
 * The default connection strings, for the servers `scripts/setup-databases.ts`
 * provides. MariaDB is 3306 and MySQL 3307 (the two conflict on 3306, so MySQL
 * runs as a container); MySQL's URL allows public-key retrieval, which the
 * drivers take out of the URL and pass as an option.
 */
const DEFAULT_URLS: Record<Backend, string> = {
  memory: "",
  file: "",
  sqlite: "",
  redis: "redis://127.0.0.1:6379/12",
  postgres: "postgres://bunjobs:bunjobs@127.0.0.1:5432/bun_cache_bench",
  mysql:
    "mysql://bunjobs:bunjobs@127.0.0.1:3307/bun_cache_bench?allowPublicKeyRetrieval=true",
  mariadb: "mariadb://bunjobs:bunjobs@127.0.0.1:3306/bun_cache_bench",
  mongodb: "mongodb://127.0.0.1:27017/bun_cache_bench",
};

/** Resolves the connection string a backend is driven with; empty for the in-process ones. */
export function backendUrl(backend: Backend): string {
  const variable = BACKEND_ENV_VAR[backend];
  return (variable && process.env[variable]) || DEFAULT_URLS[backend];
}

/** Takes `allowPublicKeyRetrieval` out of a MySQL URL, since Bun's `SQL` honours it only as an option. */
export function splitMysqlUrl(url: string): {
  /** The URL without the flag. */
  url: string;
  /** Whether the URL asked for it. */
  allowPublicKeyRetrieval: boolean;
} {
  const parsed = new URL(url);
  const allow = parsed.searchParams.get("allowPublicKeyRetrieval") === "true";
  parsed.searchParams.delete("allowPublicKeyRetrieval");
  return { url: parsed.toString(), allowPublicKeyRetrieval: allow };
}

/**
 * Whether a backend answers. A networked backend gets a real query rather
 * than an open-port check, because a port that accepts but never
 * authenticates would let every contender on it report a spurious zero.
 */
export async function backendAvailable(backend: Backend): Promise<boolean> {
  if (backend === "memory" || backend === "file" || backend === "sqlite") {
    return true;
  }

  const url = backendUrl(backend);
  try {
    if (backend === "redis") {
      const { RedisClient } = await import("bun");
      const client = new RedisClient(url, { connectionTimeout: 2000 });
      await client.connect();
      await client.send("PING", []);
      client.close();
      return true;
    }

    if (backend === "mongodb") {
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(url, { serverSelectionTimeoutMS: 2000 });
      await client.connect();
      await client.db().command({ ping: 1 });
      await client.close();
      return true;
    }

    const { SQL } = await import("bun");
    const split = splitMysqlUrl(url);
    const sql = new SQL(split.url, {
      max: 1,
      connectionTimeout: 2,
      ...(split.allowPublicKeyRetrieval
        ? { allowPublicKeyRetrieval: true }
        : {}),
    });
    await sql.unsafe("select 1");
    await sql.close();
    return true;
  } catch {
    return false;
  }
}

/** The line printed when a backend is missing, so a skip is never silent. */
export function unavailableHint(backend: Backend): string {
  const variable = BACKEND_ENV_VAR[backend];
  return `${backend} is not reachable at ${backendUrl(backend) || "(unset)"}${
    variable
      ? ` — set ${variable}=<url>, or see bench/README.md (Setup) for the database it expects`
      : ""
  }`;
}

/** Creates a child's own scratch directory, removed by {@link removeScratch}. */
export function makeScratch(): string {
  return mkdtempSync(join(tmpdir(), "bun-cache-bench-"));
}

/** Removes a child's scratch directory (its own, by the exact path {@link makeScratch} returned). */
export function removeScratch(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
