/**
 * Type-level assertions for the MongoDB driver (plan §7.6): its `client`
 * option is typed structurally (`MongoClientLike`), so this package never
 * names the optional peer — and a **real** `MongoClient` must still satisfy
 * it, or lending the driver an application's own client stops compiling
 * (bun-jobs measured that variance trap on its own `*Like` types). The
 * `@ts-expect-error` is the negative control.
 *
 * Checked by `bun run check`, not by `bun test`.
 */
import type { MongoClient } from "mongodb";
import type { MongoClientLike, MongoDriverOptions } from "../lib/index";
import { mongoDriver } from "../lib/index";

declare const client: MongoClient;

// A real client is a MongoClientLike, and the option takes it.
export const _like: MongoClientLike = client;
export const _driver = mongoDriver({ client, database: "app" });
export const _options: MongoDriverOptions = {
  url: "mongodb://127.0.0.1:27017/app",
  prefix: "app_cache_",
  collections: { entries: "app_entries", bus: "app_bus" },
  maxEntries: 10_000,
  syncSchema: { dryRun: true },
};

export const _badCollection: MongoDriverOptions = {
  // @ts-expect-error — `jobs` is not one of the driver's collections.
  collections: { jobs: "x" },
};
