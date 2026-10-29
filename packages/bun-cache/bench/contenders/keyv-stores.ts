import type { KeyvStoreAdapter } from "keyv";
import type { Backend, SetupContext } from "../lib/types";
import KeyvMongo from "@keyv/mongo";
import KeyvMysql from "@keyv/mysql";
import KeyvPostgres from "@keyv/postgres";
import KeyvRedis from "@keyv/redis";
import { Keyv } from "keyv";
import {
  deleteRedisPrefix,
  dropMongoCollections,
  dropSqlTables,
} from "../lib/cleanup";
import { splitMysqlUrl } from "../lib/env";

/**
 * Keyv's own store adapters, at the versions that peer on Keyv 5 — the Keyv
 * cache-manager 7.2.9 and cacheable 2.5.0 depend on (plan §14.3). There is
 * none for the file backend, and `@keyv/sqlite` is left out: it runs on the
 * native `sqlite3`, whose binary arrives only through an install script, and
 * this package trusts none (`trustedDependencies: []`).
 */

/** The backends a Keyv store is configured for here. */
export const KEYV_BACKENDS: ReadonlySet<Backend> = new Set([
  "memory",
  "redis",
  "postgres",
  "mysql",
  "mariadb",
  "mongodb",
]);

/** A Keyv instance over one backend's store, with how to remove what it stored. */
export interface KeyvOnBackend {
  /** The Keyv instance, namespaced to the run. */
  keyv: Keyv;
  /** Closes the store's connection, then deletes exactly the run's data. */
  close: () => Promise<void>;
}

/** The run's table or collection name: Keyv's stores keep one each. */
function tableOf(ctx: SetupContext, label: string): string {
  return `${label}_${ctx.run}`;
}

/** A store adapter for one networked backend. */
function storeFor(
  backend: Backend,
  ctx: SetupContext,
  label: string,
): KeyvStoreAdapter | undefined {
  switch (backend) {
    case "redis":
      return new KeyvRedis(ctx.url);
    case "postgres":
      return new KeyvPostgres({ uri: ctx.url, table: tableOf(ctx, label) });
    case "mysql":
    case "mariadb":
      // mysql2 negotiates MySQL 8's key exchange itself; the flag is Bun's.
      return new KeyvMysql({
        uri: splitMysqlUrl(ctx.url).url.replace(/^mariadb:/, "mysql:"),
        table: tableOf(ctx, label),
      });
    case "mongodb":
      return new KeyvMongo(ctx.url, { collection: tableOf(ctx, label) });
    default:
      return undefined;
  }
}

/**
 * A Keyv over `backend`, its namespace (and table or collection) named after
 * the run. `label` tells two libraries' tables apart.
 */
export function keyvFor(
  backend: Backend,
  ctx: SetupContext,
  label: string,
): KeyvOnBackend {
  const namespace = `${label}-${ctx.run}`;
  const store = storeFor(backend, ctx, label);
  const keyv = store ? new Keyv({ store, namespace }) : new Keyv({ namespace });

  return {
    keyv,
    close: async () => {
      if (backend === "redis") {
        // Keyv 5 names a namespaced key `<namespace>::<key>`.
        await deleteRedisPrefix(ctx.url, namespace, "::");
      }
      await keyv.disconnect();
      if (
        backend === "postgres" ||
        backend === "mysql" ||
        backend === "mariadb"
      ) {
        await dropSqlTables(ctx.url, [tableOf(ctx, label)]);
      } else if (backend === "mongodb") {
        await dropMongoCollections(ctx.url, [tableOf(ctx, label)]);
      }
    },
  };
}
