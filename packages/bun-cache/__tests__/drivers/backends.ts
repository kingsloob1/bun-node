/**
 * The SQL servers bun-cache's driver suites run against (plan §13.2): the
 * same rules as bun-jobs' `__tests__/helpers/backends.ts`.
 *
 * - **Unset**: the backend skips, visibly (`describe.skip("backend X: not
 *   configured")`).
 * - **Set but unreachable**: a named, failing test — a set variable is a
 *   claim of coverage, and a skip, however loud, is still a green run.
 * - **The variable** is `BUN_CACHE_TEST_<X>_URL`, falling back to
 *   `BUN_JOBS_TEST_<X>_URL`, so a machine set up for bun-jobs tests bun-cache
 *   with no extra export. `bun scripts/setup-databases.ts` provides both.
 * - **Own data**: each run's tables carry the prefix `bun_cache_test_<pid>_`,
 *   and the run drops exactly those tables — never a prefix sweep.
 *
 * No `bun:test` here: the visible skip and the named failure are registered
 * by `sqlSuite.ts`.
 */
import process from "node:process";
import { RedisClient, S3Client, SQL } from "bun";
import type { CacheDriver } from "../../lib/index";
import {
  azureBlobDriver,
  mariadbDriver,
  mysqlDriver,
  postgresDriver,
  s3Driver,
} from "../../lib/index";
import { parseBlobList, resolveAzureTarget } from "../../lib/drivers/azure";
import { azureFetch } from "../../lib/drivers/azure-sign";
import type { MysqlDriverOptions } from "../../lib/drivers/mysql";
import type { PostgresDriverOptions } from "../../lib/drivers/postgres";
import { parseS3Url } from "../../lib/drivers/s3";
import { sqlClientOptions } from "../../lib/drivers/sql-connection";

/** One SQL server backend. */
export interface SqlBackend {
  /** `postgres`, `mysql` or `mariadb`, as in the test titles. */
  name: "postgres" | "mysql" | "mariadb";
  /** The variable that points at it (the bun-cache one, even when the URL came from the fallback). */
  variable: string;
  /** The URL, when one is set. */
  url: string | undefined;
  /** The factory's export name in its module, for the kit's two-process pass. */
  exportName: "postgresDriver" | "mysqlDriver" | "mariadbDriver";
  /** The module the factory lives in, as an absolute path. */
  module: string;
  /** Builds a driver on this backend. */
  make: (options: PostgresDriverOptions & MysqlDriverOptions) => CacheDriver;
}

/** Every SQL backend, with its URL resolved from the environment. */
export function sqlBackends(): SqlBackend[] {
  const url = (engine: string): string | undefined =>
    process.env[`BUN_CACHE_TEST_${engine}_URL`] ||
    process.env[`BUN_JOBS_TEST_${engine}_URL`] ||
    undefined;
  const postgresModule = new URL(
    "../../lib/drivers/postgres.ts",
    import.meta.url,
  ).pathname;
  const mysqlModule = new URL("../../lib/drivers/mysql.ts", import.meta.url)
    .pathname;
  return [
    {
      name: "postgres",
      variable: "BUN_CACHE_TEST_POSTGRES_URL",
      url: url("POSTGRES"),
      exportName: "postgresDriver",
      module: postgresModule,
      make: postgresDriver,
    },
    {
      name: "mysql",
      variable: "BUN_CACHE_TEST_MYSQL_URL",
      url: url("MYSQL"),
      exportName: "mysqlDriver",
      module: mysqlModule,
      make: mysqlDriver,
    },
    {
      name: "mariadb",
      variable: "BUN_CACHE_TEST_MARIADB_URL",
      url: url("MARIADB"),
      exportName: "mariadbDriver",
      module: mysqlModule,
      make: mariadbDriver,
    },
  ];
}

/**
 * The MongoDB server bun-cache's suite runs against (`mongodb.test.ts`):
 * `BUN_CACHE_TEST_MONGODB_URL`, falling back to `BUN_JOBS_TEST_MONGODB_URL`,
 * under the same rules as the SQL backends. Each run's collections carry the
 * prefix `bun_cache_test_<pid>_` and are dropped by name.
 */
export function mongoBackend(): {
  /** The variable that points at it (the bun-cache one, even when the URL came from the fallback). */
  variable: string;
  /** The URL, when one is set. */
  url: string | undefined;
} {
  return {
    variable: "BUN_CACHE_TEST_MONGODB_URL",
    url:
      process.env.BUN_CACHE_TEST_MONGODB_URL ||
      process.env.BUN_JOBS_TEST_MONGODB_URL ||
      undefined,
  };
}

/**
 * The single-node MongoDB replica set the change-stream bus is tested on
 * (`mongodb.test.ts` runs its whole suite there too): only
 * `BUN_CACHE_TEST_MONGODB_RS_URL`, with no bun-jobs fallback, because bun-jobs
 * has no replica set. `bun scripts/setup-databases.ts` provides it (a docker
 * container on 27018). The same rules as {@link mongoBackend}: unset skips
 * visibly, set but unreachable fails.
 */
export function mongoRsBackend(): {
  /** The variable that points at it. */
  variable: string;
  /** The URL, when one is set. */
  url: string | undefined;
} {
  return {
    variable: "BUN_CACHE_TEST_MONGODB_RS_URL",
    url: process.env.BUN_CACHE_TEST_MONGODB_RS_URL || undefined,
  };
}

/** The run's table prefix: its own tables, dropped by {@link dropTables}. */
export function runPrefix(suffix = ""): string {
  return `bun_cache_test_${process.pid}_${suffix}`;
}

/** A raw client on a backend's URL, connecting the way the driver does. */
export function rawClient(backend: SqlBackend): SQL {
  return new SQL(sqlClientOptions(backend.name, { url: backend.url! }, "test"));
}

/** Drops exactly the tables a prefix names (never a pattern). */
export async function dropTables(
  backend: SqlBackend,
  prefix: string,
): Promise<void> {
  const sql = rawClient(backend);
  try {
    for (const table of ["entries", "tags", "stamps", "locks", "bus"]) {
      await sql.unsafe(`DROP TABLE IF EXISTS ${prefix}${table}`);
    }
  } finally {
    await sql.close();
  }
}

/** Connects once to see whether the server is there; answers the failure, not a boolean. */
export async function reachError(
  backend: SqlBackend,
): Promise<Error | undefined> {
  const driver = backend.make({
    url: backend.url,
    prefix: runPrefix("probe_"),
  });
  try {
    await driver.connect!();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    await driver.close().catch(() => undefined);
    await dropTables(backend, runPrefix("probe_")).catch(() => undefined);
  }
}

/**
 * The Redis server the bus tests run against (§13.2): `BUN_CACHE_TEST_REDIS_URL`,
 * falling back to `BUN_JOBS_TEST_REDIS_URL`. Pub/sub ignores the database
 * number, so each run's channels carry its pid and a timestamp instead, and
 * leave nothing behind.
 */
export function redisBackend(): {
  /** The variable that points at it. */
  variable: string;
  /** The URL, when one is set. */
  url: string | undefined;
} {
  return {
    variable: "BUN_CACHE_TEST_REDIS_URL",
    url:
      process.env.BUN_CACHE_TEST_REDIS_URL ||
      process.env.BUN_JOBS_TEST_REDIS_URL ||
      undefined,
  };
}

/** Connects once to the Redis server at `url` (within 3 s); answers the failure, not a boolean. */
export async function redisReachError(url: string): Promise<Error | undefined> {
  const client = new RedisClient(url, {
    connectionTimeout: 3_000,
    autoReconnect: false,
  });
  try {
    await client.connect();
    await client.send("PING", []);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    client.close();
  }
}

/**
 * Deletes every key under one of this run's Redis prefixes (`<prefix>:…`).
 * The prefix carries the run's pid and a timestamp, so the `SCAN` it walks
 * matches this run's keys and nobody else's: the exact set it created, never a
 * sweep of a shared prefix. Glob characters in it are escaped.
 */
export async function deleteRedisPrefix(
  url: string,
  prefix: string,
): Promise<number> {
  const client = new RedisClient(url);
  const pattern = `${prefix.replace(/[*?[\]\\]/g, (char) => `\\${char}`)}:*`;
  let cursor = "0";
  let deleted = 0;
  try {
    do {
      const [next, found] = await client.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        1_000,
      );
      cursor = String(next);
      if (found.length > 0) {
        deleted += await client.unlink(...found);
      }
    } while (cursor !== "0");
  } finally {
    client.close();
  }
  return deleted;
}

/**
 * The S3 server the S3 driver's suite runs against (§13.2):
 * `BUN_CACHE_TEST_S3_URL`, falling back to `BUN_JOBS_TEST_S3_URL` — SeaweedFS
 * from `bun scripts/setup-databases.ts`, whose `--print-env` prints both. The
 * URL is the driver's own form, `s3://<key>:<secret>@<host>:<port>/<bucket>?scheme=http`.
 */
export function s3Backend(): {
  /** The variable that points at it. */
  variable: string;
  /** The URL, when one is set. */
  url: string | undefined;
} {
  return {
    variable: "BUN_CACHE_TEST_S3_URL",
    url:
      process.env.BUN_CACHE_TEST_S3_URL ||
      process.env.BUN_JOBS_TEST_S3_URL ||
      undefined,
  };
}

/** Lists the bucket once through the driver (within 5 s); answers the failure, not a boolean. */
export async function s3ReachError(url: string): Promise<Error | undefined> {
  try {
    const driver = s3Driver({
      url,
      prefix: `bun-cache-test/${process.pid}-probe`,
    });
    await Promise.race([
      driver.connect!(),
      Bun.sleep(5_000).then(() => {
        throw new Error("no answer within 5 s");
      }),
    ]);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Deletes every object under one of this run's S3 prefixes (`<prefix>/…`).
 * The prefix carries the run's pid and a timestamp, so the listing it walks
 * holds this run's objects and nobody else's: the exact set it created, never
 * a sweep of a shared prefix.
 */
export async function deleteS3Prefix(
  url: string,
  prefix: string,
): Promise<number> {
  const client = new S3Client(parseS3Url(url));
  let deleted = 0;
  for (;;) {
    const page = await client.list({ prefix: `${prefix}/`, maxKeys: 1000 });
    const keys = (page.contents ?? []).map((object) => object.key);
    if (keys.length === 0) {
      return deleted;
    }
    await Promise.all(keys.map(async (key) => await client.delete(key)));
    deleted += keys.length;
  }
}

/**
 * The Azure Blob Storage server the Azure driver's suite runs against:
 * `BUN_CACHE_TEST_AZURE_URL` — Azurite from `bun scripts/setup-databases.ts`,
 * whose `--print-env` prints it (bun-jobs has no Azure driver, so there is no
 * `BUN_JOBS_TEST_*` fallback). The URL is the driver's own form,
 * `azure://<account>:<key>@<host>:<port>/<account>/<container>?scheme=http`.
 */
export function azureBackend(): {
  /** The variable that points at it. */
  variable: string;
  /** The URL, when one is set. */
  url: string | undefined;
} {
  return {
    variable: "BUN_CACHE_TEST_AZURE_URL",
    url: process.env.BUN_CACHE_TEST_AZURE_URL || undefined,
  };
}

/** Lists the blob container once through the driver (within 5 s); answers the failure, not a boolean. */
export async function azureReachError(url: string): Promise<Error | undefined> {
  try {
    const driver = azureBlobDriver({
      url,
      prefix: `bun-cache-test/${process.pid}-probe`,
    });
    await Promise.race([
      driver.connect!(),
      Bun.sleep(5_000).then(() => {
        throw new Error("no answer within 5 s");
      }),
    ]);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Deletes every blob under one of this run's Azure prefixes (`<prefix>/…`).
 * The prefix carries the run's pid and a timestamp, so the listing it walks
 * holds this run's blobs and nobody else's: the exact set it created, never a
 * sweep of a shared prefix.
 */
export async function deleteAzurePrefix(
  url: string,
  prefix: string,
): Promise<number> {
  const target = resolveAzureTarget({ url });
  let deleted = 0;
  for (;;) {
    const response = await azureFetch(target, {
      method: "GET",
      blob: "",
      query: { restype: "container", comp: "list", prefix: `${prefix}/` },
    });
    const { blobs } = parseBlobList(await response.text());
    if (blobs.length === 0) {
      return deleted;
    }
    await Promise.all(
      blobs.map(async (blob) => {
        const gone = await azureFetch(target, {
          method: "DELETE",
          blob: blob.name,
        });
        await gone.body?.cancel();
      }),
    );
    deleted += blobs.length;
  }
}
