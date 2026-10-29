import { RedisClient, SQL } from "bun";
import { MongoClient } from "mongodb";
import { splitMysqlUrl } from "./env";

/**
 * Deleting exactly what a run created: by the tables, collections and key
 * prefix its own run id names, never by a pattern another run could match
 * (the repository's shared-test-data rule). The databases themselves are the
 * benchmark's own and stay.
 */

/** A SQL name of the run's own: letters, digits and `_` only, so it can be spliced into a `DROP`. */
const SAFE_NAME = /^\w+$/;

/** Drops the named tables, each by its exact name. */
export async function dropSqlTables(
  url: string,
  tables: readonly string[],
): Promise<void> {
  const split = splitMysqlUrl(url);
  const sql = new SQL(split.url, {
    max: 1,
    ...(split.allowPublicKeyRetrieval ? { allowPublicKeyRetrieval: true } : {}),
  });
  try {
    for (const table of tables) {
      if (!SAFE_NAME.test(table)) {
        throw new TypeError(`refusing to drop ${JSON.stringify(table)}`);
      }
      await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
    }
  } finally {
    await sql.close();
  }
}

/** Drops the named collections of the URL's database, each by its exact name. */
export async function dropMongoCollections(
  url: string,
  collections: readonly string[],
): Promise<void> {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db();
    const present = new Set(
      (await db.listCollections({}, { nameOnly: true }).toArray()).map(
        (each) => each.name,
      ),
    );
    for (const name of collections) {
      if (present.has(name)) {
        await db.dropCollection(name);
      }
    }
  } finally {
    await client.close();
  }
}

/**
 * Deletes every key under the run's own prefix — `<prefix>` followed by a
 * separator, the prefix escaped so its characters match only themselves.
 * The prefix carries the run id, so nothing another run wrote can match.
 */
export async function deleteRedisPrefix(
  url: string,
  prefix: string,
  separator = ":",
): Promise<number> {
  const client = new RedisClient(url);
  const pattern = `${prefix.replace(/[*?[\]\\]/g, (char) => `\\${char}`)}${separator}*`;
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
