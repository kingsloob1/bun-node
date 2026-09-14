import type { Backend } from "./types";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * Which backends this machine can actually run, and where they live.
 *
 * The benchmarks deliberately use different databases from the test suite
 * (`bun_jobs_bench`, Redis database 14) so a long benchmark cannot disturb a
 * test run, and a test run cannot make a benchmark look slow.
 */

/** Default connection strings, each overridable by the matching environment variable. */
export const BACKEND_URLS: Record<Backend, string> = {
  memory: "",
  file: "",
  sqlite: "",
  redis: process.env.BUN_JOBS_BENCH_REDIS_URL ?? "redis://127.0.0.1:6379/14",
  postgres:
    process.env.BUN_JOBS_BENCH_POSTGRES_URL ??
    "postgres://bunjobs:bunjobs@127.0.0.1:5432/bun_jobs_bench",
  mongodb:
    process.env.BUN_JOBS_BENCH_MONGODB_URL ??
    "mongodb://127.0.0.1:27017/bun_jobs_bench",
};

/** The environment variable that points each networked backend somewhere else. */
export const BACKEND_ENV_VAR: Partial<Record<Backend, string>> = {
  redis: "BUN_JOBS_BENCH_REDIS_URL",
  postgres: "BUN_JOBS_BENCH_POSTGRES_URL",
  mongodb: "BUN_JOBS_BENCH_MONGODB_URL",
};

/** A scratch directory for the file and sqlite backends, created on first use. */
let scratch: string | undefined;

/** Returns a per-process scratch directory, creating it once. */
export function scratchDir(): string {
  scratch ??= mkdtempSync(join(tmpdir(), "bun-jobs-bench-"));
  return scratch;
}

/** Resolves the connection string a backend should be driven with. */
export function backendUrl(backend: Backend): string {
  if (backend === "sqlite") return `sqlite://${join(scratchDir(), "bench.db")}`;
  if (backend === "file") return join(scratchDir(), "file-driver");
  return BACKEND_URLS[backend];
}

/**
 * Whether a backend answers. Networked backends get a real connection rather
 * than an open-port check, because a port that accepts but never authenticates
 * would let every contender on it report a spurious zero.
 */
export async function backendAvailable(backend: Backend): Promise<boolean> {
  if (backend === "memory" || backend === "file" || backend === "sqlite") {
    return true;
  }

  const url = backendUrl(backend);
  if (!url) return false;

  try {
    if (backend === "redis") {
      const { RedisClient } = await import("bun");
      const client = new RedisClient(url, { connectionTimeout: 2000 });
      await client.connect();
      await client.send("PING", []);
      client.close();
      return true;
    }

    if (backend === "postgres") {
      const { SQL } = await import("bun");
      const sql = new SQL(url, { max: 1, connectionTimeout: 2 });
      await sql.unsafe("select 1");
      await sql.close();
      return true;
    }

    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(url, { serverSelectionTimeoutMS: 2000 });
    await client.connect();
    await client.db().command({ ping: 1 });
    await client.close();
    return true;
  } catch {
    return false;
  }
}

/** The line printed when a backend is missing, so a skip is never silent. */
export function unavailableHint(backend: Backend): string {
  const variable = BACKEND_ENV_VAR[backend];
  const where = variable ? `${variable}=<url>` : "";
  return `${backend} is not reachable at ${backendUrl(backend) || "(unset)"}${
    where ? ` — set ${where}, or run scripts/setup-databases.ts --docker` : ""
  }`;
}
