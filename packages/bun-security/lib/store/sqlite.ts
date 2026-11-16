/**
 * `sqliteStore({ path })` (storage.md §5): the security store in one SQLite
 * file — topology (a), and a small (b) on one host. WAL lets several
 * processes share the file (`multiProcess`); writers take the file's write
 * lock with `BEGIN IMMEDIATE`, behind a lock per process and bun-sql's
 * transient-lock retry. The change feed is polled
 * (`capabilities.changeFeed: "poll"`).
 */
import type { SchemaSyncOptions } from "@kingsleyweb/bun-sql";
import type {
  SecurityStoreCapabilities,
  SecurityStoreDriver,
  StoreCodec,
} from "./types";
import { ConfigError } from "@kingsleyweb/bun-common";
import { dialectFor, openSqlClient } from "@kingsleyweb/bun-sql";
import { DEFAULT_STORE_PREFIX, sqlSecurityStore } from "./sql";

/** Options for {@link sqliteStore}. */
export interface SqliteStoreOptions {
  /** The database file (created when missing), or `:memory:` for one connection's private database. */
  readonly path: string;
  /** The table prefix. Default `bun_security_`. */
  readonly prefix?: string;
  /**
   * Run `syncSchema` on connect: `true` for the safe defaults, or its
   * options. Default: off (the schema is created when missing, never
   * changed unasked).
   */
  readonly syncSchema?: boolean | SchemaSyncOptions;
  /** The clock, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /**
   * Encodes every stored body and decodes it on the way out: where
   * storage.md §8's field sealing (PR-D3) plugs in. Default: stored as given.
   */
  readonly codec?: StoreCodec;
}

/** What the SQLite store can do. */
const CAPABILITIES: SecurityStoreCapabilities = Object.freeze({
  durable: true,
  multiProcess: true,
  multiHost: false,
  transactions: true,
  changeFeed: "poll",
  analytics: false,
  cidrQuery: false,
  readOnly: false,
});

/** The security store in a SQLite file; see the module's description. */
export function sqliteStore(options: SqliteStoreOptions): SecurityStoreDriver {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.path !== "string" ||
    options.path.length === 0
  ) {
    throw new ConfigError(
      "sqliteStore(): path must be a file path, or :memory:",
    );
  }
  const url =
    options.path === ":memory:" ? ":memory:" : `sqlite://${options.path}`;
  return sqlSecurityStore({
    name: "sqlite",
    dialect: dialectFor("sqlite"),
    open: () => openSqlClient("sqlite", { url }, "sqliteStore()", { max: 1 }),
    prefix: options.prefix ?? DEFAULT_STORE_PREFIX,
    capabilities: CAPABILITIES,
    syncSchema: options.syncSchema,
    now: options.now ?? Date.now,
    codec: options.codec,
  });
}
