/**
 * The cache lab's drivers (`cache.ts`): every bun-cache driver the playground
 * can switch to, whether it is available here, how to open one, and how to
 * remove exactly the data an opening created.
 *
 * - `memory`, `file` and `sqlite` are always there. The file and SQLite data
 *   live in `playground/.data/cache-<pid>/`, a directory of this process's
 *   own, removed when the playground stops (and, if it was killed first, by
 *   the next start).
 * - The servers are opt-in, through the variables
 *   `bun scripts/setup-databases.ts --print-env` prints:
 *   `BUN_CACHE_TEST_{POSTGRES,MYSQL,MARIADB,REDIS,MONGODB,S3,AZURE}_URL`. An
 *   unset one is listed as unavailable, naming its variable; a set one that
 *   cannot be reached fails the switch, and the lab stays where it was.
 * - Cloudflare KV and D1 need miniflare or an account, so the lab lists them
 *   as unavailable (`examples/bun-cache/04-drivers/` runs them).
 *
 * Every opening gets a prefix naming this process and the opening's number
 * (`bun_cache_playground_<pid>_<n>_` for tables and collections,
 * `bun-cache-playground-<pid>-<n>` for Redis keys, `bun-cache-playground/<pid>-<n>`
 * for objects and blobs), and its cleanup removes exactly what that prefix
 * names: the tables or collections by name, the keys a `SCAN` of the prefix
 * finds, the objects or blobs a listing of it finds. Nothing else on a server
 * is read or written.
 */
import type { CacheDriver } from "@kingsleyweb/bun-cache";
import { RedisClient, S3Client, SQL } from "bun";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  azureBlobDriver,
  fileDriver,
  mariadbDriver,
  memoryDriver,
  mongoDriver,
  mysqlDriver,
  postgresDriver,
  redisDriver,
  s3Driver,
  sqliteDriver,
} from "@kingsleyweb/bun-cache";
import { isAlive } from "./backend";

/** The drivers the lab can switch to. */
export const LAB_DRIVER_KINDS = [
  "memory",
  "file",
  "sqlite",
  "postgres",
  "mysql",
  "mariadb",
  "redis",
  "mongodb",
  "s3",
  "azure",
] as const;

/** One of {@link LAB_DRIVER_KINDS}. */
export type LabDriverKind = (typeof LAB_DRIVER_KINDS)[number];

/** A driver as the page lists it. */
export interface LabDriverInfo {
  /** The driver (also the `driver` query value of the switch). */
  kind: string;
  /** Whether the lab can switch to it here. */
  available: boolean;
  /** The variable naming its server, for a server driver. */
  variable?: string;
  /** Why it is unavailable, when it is. */
  reason?: string;
}

/** An opened driver, with what it created and how to remove that. */
export interface LabDriver {
  /** The driver kind. */
  kind: LabDriverKind;
  /** The driver, for `createCache`. */
  driver: CacheDriver;
  /** Where its data lives (a directory, a file, or the server prefix), for the page and the smoke check; unique per opening. */
  location: string;
  /** Whether the driver evicts down to the lab's cap (`maxEntries`): on the memory driver at once, elsewhere on a sweep. */
  capped: boolean;
}

/** The server variables, as `setup-databases.ts --print-env` prints them. */
const SERVER_VARIABLES: Partial<Record<LabDriverKind, string>> = {
  postgres: "BUN_CACHE_TEST_POSTGRES_URL",
  mysql: "BUN_CACHE_TEST_MYSQL_URL",
  mariadb: "BUN_CACHE_TEST_MARIADB_URL",
  redis: "BUN_CACHE_TEST_REDIS_URL",
  mongodb: "BUN_CACHE_TEST_MONGODB_URL",
  s3: "BUN_CACHE_TEST_S3_URL",
  azure: "BUN_CACHE_TEST_AZURE_URL",
};

/** The entry cap the lab gives every driver that takes one, so "Fill" shows evictions. */
export const LAB_MAX_ENTRIES = 64;

/** Where the file and SQLite openings keep their data. */
const DATA_DIR = join(import.meta.dir, ".data");

/** This process's own directory under `.data/`. */
const OWN_DIR = join(DATA_DIR, `cache-${process.pid}`);

/** Whether this process created `.data/` itself (only then may it remove it, empty, at the end). */
let createdDataDir = false;

/** The SQL tables a prefix names (`bus` is never created on Postgres; dropping it is a no-op there). */
const SQL_TABLES = ["entries", "tags", "stamps", "locks", "bus"];

/** The MongoDB collections a prefix names. */
const MONGO_COLLECTIONS = ["entries", "stamps", "locks", "bus"];

/** Every driver, available here or not, in the page's order. */
export function labDrivers(): LabDriverInfo[] {
  return [
    ...LAB_DRIVER_KINDS.map((kind): LabDriverInfo => {
      const variable = SERVER_VARIABLES[kind];
      if (variable === undefined) {
        return { kind, available: true };
      }
      return process.env[variable]
        ? { kind, available: true, variable }
        : {
            kind,
            available: false,
            variable,
            reason: `${variable} is unset (bun scripts/setup-databases.ts --print-env names it)`,
          };
    }),
    {
      kind: "cloudflare-kv",
      available: false,
      reason:
        "needs miniflare or a Cloudflare account: examples/bun-cache/04-drivers/cloudflare-kv.ts",
    },
    {
      kind: "cloudflare-d1",
      available: false,
      reason:
        "needs miniflare or a Cloudflare account: examples/bun-cache/04-drivers/cloudflare-d1.ts",
    },
  ];
}

/** Whether `kind` names a driver the lab can open here. */
export function isAvailable(kind: string): kind is LabDriverKind {
  return labDrivers().some((info) => info.kind === kind && info.available);
}

/** The server URL of a server driver; throws for a local one or an unset variable. */
function serverUrl(kind: LabDriverKind): string {
  const variable = SERVER_VARIABLES[kind];
  const url = variable === undefined ? undefined : process.env[variable];
  if (url === undefined || url === "") {
    throw new Error(`${kind}: ${variable ?? "no variable"} is unset`);
  }
  return url;
}

/** This process's directory under `.data/`, created on first use. */
function ownDir(): string {
  if (!existsSync(DATA_DIR)) {
    createdDataDir = true;
  }
  mkdirSync(OWN_DIR, { recursive: true });
  return OWN_DIR;
}

/**
 * Opens `kind` as opening number `n` of this run, and checks it answers
 * (`connect`, then `ping`, within 10 s). A driver that does not is closed,
 * its data removed, and the error thrown.
 */
export async function openLabDriver(
  kind: LabDriverKind,
  n: number,
): Promise<LabDriver> {
  const opened = makeDriver(kind, n);
  try {
    await withDeadline(
      (async () => {
        await opened.driver.connect?.();
        await opened.driver.ping?.();
      })(),
      10_000,
      `${kind} did not answer within 10 s`,
    );
  } catch (error) {
    await opened.driver.close().catch(() => undefined);
    await removeLabData(opened).catch(() => undefined);
    throw error;
  }
  return opened;
}

/** Builds the driver for `kind` under opening `n`'s prefix. */
function makeDriver(kind: LabDriverKind, n: number): LabDriver {
  const sqlPrefix = `bun_cache_playground_${process.pid}_${n}_`;
  const objectPrefix = `bun-cache-playground/${process.pid}-${n}`;
  const maxEntries = LAB_MAX_ENTRIES;
  switch (kind) {
    case "memory":
      return {
        kind,
        driver: memoryDriver({ maxEntries }),
        location: `this process's memory (opening ${n})`,
        capped: true,
      };
    case "file": {
      const root = join(ownDir(), `file-${n}`);
      return {
        kind,
        driver: fileDriver({ root, maxEntries }),
        location: root,
        capped: true,
      };
    }
    case "sqlite": {
      const path = join(ownDir(), `sqlite-${n}.db`);
      return {
        kind,
        driver: sqliteDriver({ path, maxEntries }),
        location: path,
        capped: true,
      };
    }
    case "postgres":
      return {
        kind,
        driver: postgresDriver({
          url: serverUrl(kind),
          prefix: sqlPrefix,
          maxEntries,
        }),
        location: sqlPrefix,
        capped: true,
      };
    case "mysql":
    case "mariadb": {
      const make = kind === "mysql" ? mysqlDriver : mariadbDriver;
      return {
        kind,
        driver: make({ url: serverUrl(kind), prefix: sqlPrefix, maxEntries }),
        location: sqlPrefix,
        capped: true,
      };
    }
    case "redis": {
      // No `maxEntries` on Redis: the server's `maxmemory` policy evicts.
      const prefix = `bun-cache-playground-${process.pid}-${n}`;
      return {
        kind,
        driver: redisDriver({ url: serverUrl(kind), prefix }),
        location: prefix,
        capped: false,
      };
    }
    case "mongodb":
      return {
        kind,
        driver: mongoDriver({
          url: serverUrl(kind),
          prefix: sqlPrefix,
          maxEntries,
        }),
        location: sqlPrefix,
        capped: true,
      };
    case "s3":
      return {
        kind,
        driver: s3Driver({
          url: serverUrl(kind),
          prefix: objectPrefix,
          maxEntries,
        }),
        location: objectPrefix,
        capped: true,
      };
    case "azure":
      return {
        kind,
        driver: azureBlobDriver({
          url: serverUrl(kind),
          prefix: objectPrefix,
          maxEntries,
        }),
        location: objectPrefix,
        capped: true,
      };
  }
}

/** Resolves `work`, or rejects with `message` after `ms`. */
async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Removing what an opening created, and finding what is left         */
/* ------------------------------------------------------------------ */

/**
 * Removes the data `opened` created, after its cache is closed: the file
 * driver's directory, the SQLite file and its `-wal`/`-shm`, the prefix's
 * tables or collections by name, or the keys, objects or blobs under its
 * prefix. Answers how many things it removed.
 */
export async function removeLabData(opened: LabDriver): Promise<number> {
  return await visitLabData(opened, true);
}

/**
 * What of `opened`'s data is still there, without removing anything: the
 * smoke check's proof that a stopped playground left nothing behind.
 */
export async function labDataLeft(
  opened: Pick<LabDriver, "kind" | "location">,
): Promise<number> {
  return await visitLabData(opened, false);
}

/** Counts `opened`'s data, removing it when `remove` is set. */
async function visitLabData(
  opened: Pick<LabDriver, "kind" | "location">,
  remove: boolean,
): Promise<number> {
  const { kind, location } = opened;
  switch (kind) {
    case "memory":
      return 0;
    case "file": {
      const found = existsSync(location) ? 1 : 0;
      if (remove) {
        rmSync(location, { recursive: true, force: true });
      }
      return found;
    }
    case "sqlite": {
      const files = [location, `${location}-wal`, `${location}-shm`].filter(
        (file) => existsSync(file),
      );
      if (remove) {
        for (const file of files) {
          rmSync(file, { force: true });
        }
      }
      return files.length;
    }
    case "postgres":
    case "mysql":
    case "mariadb":
      return await visitSqlTables(kind, location, remove);
    case "redis":
      return await visitRedisKeys(location, remove);
    case "mongodb":
      return await visitMongoCollections(location, remove);
    case "s3":
      return await visitS3Objects(location, remove);
    case "azure":
      return await visitAzureBlobs(location, remove);
  }
}

/** A SQL client of our own on `kind`'s server, opened the way the drivers open theirs. */
function sqlClient(kind: LabDriverKind): SQL {
  // Bun honours `allowPublicKeyRetrieval` as an option and ignores it in a
  // URL, so it is moved out of the URL (the drivers do the same).
  const parsed = new URL(serverUrl(kind));
  const wanted = parsed.searchParams.get("allowPublicKeyRetrieval") === "true";
  parsed.searchParams.delete("allowPublicKeyRetrieval");
  return wanted
    ? new SQL({ url: parsed.toString(), allowPublicKeyRetrieval: true })
    : new SQL(parsed.toString());
}

/** The prefix's tables that exist, dropped by name when `remove` is set. */
async function visitSqlTables(
  kind: LabDriverKind,
  prefix: string,
  remove: boolean,
): Promise<number> {
  const client = sqlClient(kind);
  try {
    const schema = kind === "postgres" ? "current_schema()" : "DATABASE()";
    // The names are this module's own (`[a-z0-9_]`), so they are inlined.
    const names = SQL_TABLES.map((table) => `'${prefix}${table}'`).join(", ");
    const rows = await client.unsafe<{ name: string }[]>(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${schema} AND table_name IN (${names})`,
    );
    if (remove) {
      for (const { name } of rows) {
        await client.unsafe(`DROP TABLE IF EXISTS ${name}`);
      }
    }
    return rows.length;
  } finally {
    await client.close();
  }
}

/** The keys under the prefix (a `SCAN` of exactly it), deleted when `remove` is set. */
async function visitRedisKeys(
  prefix: string,
  remove: boolean,
): Promise<number> {
  const client = new RedisClient(serverUrl("redis"));
  try {
    await client.connect();
    const found: string[] = [];
    let cursor = "0";
    do {
      const reply = (await client.send("SCAN", [
        cursor,
        "MATCH",
        `${prefix}:*`,
        "COUNT",
        "1000",
      ])) as [string, string[]];
      cursor = String(reply[0]);
      found.push(...reply[1]);
    } while (cursor !== "0");
    if (remove) {
      for (let at = 0; at < found.length; at += 500) {
        await client.send("DEL", found.slice(at, at + 500));
      }
    }
    return found.length;
  } finally {
    client.close();
  }
}

/** The prefix's collections that exist, dropped by name when `remove` is set. */
async function visitMongoCollections(
  prefix: string,
  remove: boolean,
): Promise<number> {
  // Loaded only when the MongoDB driver is used: `mongodb` is bun-cache's
  // optional peer, so a checkout without it still starts the playground.
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(serverUrl("mongodb"), {
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await client.connect();
    const database = client.db();
    const mine = new Set(MONGO_COLLECTIONS.map((name) => `${prefix}${name}`));
    const existing = (
      await database.listCollections({}, { nameOnly: true }).toArray()
    )
      .map((collection) => collection.name)
      .filter((name) => mine.has(name));
    if (remove) {
      for (const name of existing) {
        await database.dropCollection(name);
      }
    }
    return existing.length;
  } finally {
    await client.close();
  }
}

/** The objects under the prefix, deleted when `remove` is set. */
async function visitS3Objects(
  prefix: string,
  remove: boolean,
): Promise<number> {
  const parsed = new URL(serverUrl("s3"));
  const client = new S3Client({
    accessKeyId: decodeURIComponent(parsed.username),
    secretAccessKey: decodeURIComponent(parsed.password),
    endpoint: `${parsed.searchParams.get("scheme") ?? "https"}://${parsed.host}`,
    bucket: parsed.pathname.replace(/^\//, ""),
    region: parsed.searchParams.get("region") ?? undefined,
  });
  const found: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.list({
      // The trailing slash, so `…/1-1` never matches `…/1-10`.
      prefix: `${prefix}/`,
      maxKeys: 1000,
      ...(token === undefined ? {} : { continuationToken: token }),
    });
    found.push(...(page.contents ?? []).map((object) => object.key));
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token !== undefined);
  if (remove) {
    for (const key of found) {
      await client.delete(key);
    }
  }
  return found.length;
}

/**
 * The blobs under the prefix, deleted when `remove` is set. The listing and
 * the deletes are Shared Key signed here (as `examples/bun-cache/04-drivers/
 * azure.ts` does), so they do not lean on the driver's own signer.
 */
async function visitAzureBlobs(
  prefix: string,
  remove: boolean,
): Promise<number> {
  const parsed = new URL(serverUrl("azure"));
  const account = decodeURIComponent(parsed.username);
  const accountKey = decodeURIComponent(parsed.password);
  const pathParts = parsed.pathname.split("/").filter((part) => part !== "");
  const container = pathParts.pop() ?? "";
  const endpoint = `${parsed.searchParams.get("scheme") ?? "https"}://${parsed.host}${pathParts.map((part) => `/${part}`).join("")}`;

  /** One Shared Key signed request to the container (`blob` empty for the container itself). */
  const signed = async (
    method: "GET" | "DELETE",
    blob: string,
    query: Record<string, string> = {},
  ): Promise<Response> => {
    const target = new URL(
      `${endpoint}/${container}${blob === "" ? "" : `/${blob.split("/").map(encodeURIComponent).join("/")}`}`,
    );
    for (const [name, value] of Object.entries(query)) {
      target.searchParams.append(name, value);
    }
    const headers = {
      "x-ms-date": new Date().toUTCString(),
      "x-ms-version": "2025-01-05",
    };
    // The verb, the eleven standard headers (all empty), the x-ms-* headers,
    // then /<account><path> and each query parameter, sorted by name.
    const resource = [
      `/${account}${target.pathname}`,
      ...[...target.searchParams.keys()]
        .map((name) => name.toLowerCase())
        .toSorted()
        .map((name) => `${name}:${target.searchParams.get(name) ?? ""}`),
    ].join("\n");
    const toSign = `${method}\n${"\n".repeat(11)}x-ms-date:${headers["x-ms-date"]}\nx-ms-version:${headers["x-ms-version"]}\n${resource}`;
    const signature = createHmac("sha256", Buffer.from(accountKey, "base64"))
      .update(toSign)
      .digest("base64");
    return await fetch(target, {
      method,
      headers: {
        ...headers,
        authorization: `SharedKey ${account}:${signature}`,
      },
    });
  };

  const found: string[] = [];
  let marker = "";
  do {
    const response = await signed("GET", "", {
      restype: "container",
      comp: "list",
      prefix: `${prefix}/`,
      ...(marker === "" ? {} : { marker }),
    });
    if (!response.ok) {
      throw new Error(`azure: listing answered ${response.status}`);
    }
    const xml = await response.text();
    for (const [, name] of xml.matchAll(
      /<Blob>[\s\S]*?<Name>([^<]*)<\/Name>/g,
    )) {
      found.push(name ?? "");
    }
    marker = /<NextMarker>([^<]*)<\/NextMarker>/.exec(xml)?.[1] ?? "";
  } while (marker !== "");
  if (remove) {
    for (const name of found) {
      const response = await signed("DELETE", name);
      if (!response.ok && response.status !== 404) {
        throw new Error(`azure: deleting ${name} answered ${response.status}`);
      }
    }
  }
  return found.length;
}

/* ------------------------------------------------------------------ */
/* This process's directory                                           */
/* ------------------------------------------------------------------ */

/**
 * Removes `.data/cache-<pid>/` directories: this process's own when it stops
 * (`"mine"`, after every opening's own cleanup, so only empties are left),
 * and on start any a playground left that was killed first (`"stale"`, its
 * pid gone). `.data/` itself goes too when this process created it and it is
 * now empty.
 */
export function removeCacheDirs(scope: "mine" | "stale"): void {
  let names: string[];
  try {
    names = readdirSync(DATA_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^cache-(\d+)$/.exec(name);
    if (match === null) {
      continue;
    }
    const pid = Number(match[1]);
    if (
      scope === "mine"
        ? pid === process.pid
        : pid !== process.pid && !isAlive(pid)
    ) {
      rmSync(join(DATA_DIR, name), { recursive: true, force: true });
    }
  }
  if (scope === "mine" && createdDataDir) {
    try {
      rmdirSync(DATA_DIR); // only when empty: the jobs backend may use it too
    } catch {
      // not empty: somebody else's files are in it
    }
  }
}

/** This process's own directory under `.data/`, for the page and the smoke check. */
export function ownCacheDir(): string {
  return OWN_DIR;
}
