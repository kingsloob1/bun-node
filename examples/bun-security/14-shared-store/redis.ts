/**
 * The shared store on Redis: the same walk as `sqlite.ts`, with bans
 * announced on Redis pub/sub instead of read on the poll.
 *
 * ```bash
 * EXAMPLE_REDIS_URL=redis://127.0.0.1:6379/15 bun 14-shared-store/redis.ts
 * ```
 *
 * - It runs when `EXAMPLE_REDIS_URL` is set and otherwise prints `skipped:`
 *   and exits 0. A URL that is set but unreachable fails.
 * - Every key lives under the prefix `bun-security-example:<pid>`, and the
 *   example deletes exactly the keys that prefix names (a `SCAN` of it,
 *   never `FLUSHDB`) at the end, even when a check failed.
 */
import process from "node:process";
import { RedisClient } from "bun";
import { redisDriver } from "@kingsleyweb/bun-cache";
import { summary } from "../shared/check";
import { show, title } from "../shared/console";
import { walkTheFleet } from "./helpers/fleet";

const url = process.env.EXAMPLE_REDIS_URL;
if (!url) {
  console.log(
    "skipped: set EXAMPLE_REDIS_URL (for instance redis://127.0.0.1:6379/15) to run this example",
  );
  process.exit(0);
}

title("a shared store on Redis");

/** This run's key prefix: it names the process, so a run owns its keys. */
const prefix = `bun-security-example:${process.pid}`;

// No reconnecting: an unreachable server fails at once, where the default
// client retries for about 30 s before giving up.
const raw = new RedisClient(url, {
  autoReconnect: false,
  connectionTimeout: 5000,
});
try {
  await raw.connect();
  await raw.send("PING", []);
} catch (error) {
  raw.close();
  throw new Error("EXAMPLE_REDIS_URL is set but unreachable", { cause: error });
}

/** Every key this run created: a `SCAN` of exactly its prefix. */
async function keysOfRun(): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = (await raw.send("SCAN", [
      cursor,
      "MATCH",
      `${prefix}*`,
      "COUNT",
      "500",
    ])) as [string, string[]];
    found.push(...keys);
    cursor = next;
  } while (cursor !== "0");
  return found;
}

try {
  await walkTheFleet(() => redisDriver({ url, prefix }));
} finally {
  const keys = await keysOfRun();
  show("keys this run wrote, now deleted", keys.length);
  if (keys.length > 0) await raw.send("DEL", keys);
  raw.close();
}

summary();
