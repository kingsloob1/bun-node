/**
 * `pgBus()` (plan §4.2): the multi-tier bus over Postgres `LISTEN`/`NOTIFY`
 * on its own, for a cache whose shared tier is not Postgres (S3 or a file
 * share as L2, Postgres to keep the L1s coherent). It is the Postgres
 * driver's own bus code (`lib/drivers/pg-notify.ts`), so by default it uses
 * the same channel as a `postgresDriver` on the same `prefix`/`tables`, and
 * the two interoperate.
 */
import type { SQL } from "bun";
import type { BusMessage, CacheBus } from "../core/types";
import { DEFAULT_SQL_PREFIX } from "../drivers/sql-base";
import type { ConnectionInput } from "../drivers/sql-connection";
import { openSqlClient } from "../drivers/sql-connection";
import type { PgSubscription } from "../drivers/pg-notify";
import {
  pgChannel,
  pgListen,
  pgNotify,
  pgUnlistenAll,
} from "../drivers/pg-notify";
import type { SqlCacheTable } from "../drivers/sql-tables";
import { resolveSqlCacheTables } from "../drivers/sql-tables";

/** `pgBus()`'s options: a URL, connection fields or an open client, and the channel. */
export interface PgBusOptions extends ConnectionInput {
  /**
   * An already-open `Bun.SQL` to use instead of building one. The bus never
   * closes a client it was given; `url`/`connection` are then ignored.
   */
  sql?: SQL;
  /**
   * The channel, used as is: an SQL identifier of at most 63 characters.
   * Defaults to the channel a `postgresDriver` with the same `prefix` and
   * `tables` uses (`bun_cache_` + a hash of the table names), so a bus and a
   * driver on one store share it.
   */
  channel?: string;
  /** The driver's table prefix the default channel is derived from. Defaults to `bun_cache_`, the driver's. */
  prefix?: string;
  /** The driver's exact table names the default channel is derived from, as `postgresDriver` takes them. */
  tables?: Partial<Record<Exclude<SqlCacheTable, "bus">, string>>;
  /** The most connections the pool of a client the bus builds holds. Bun's default (10) when absent. */
  max?: number;
}

/** The Postgres bus. See the module header and {@link PgBusOptions}. */
class PgBus implements CacheBus {
  /** `"postgres"`. */
  readonly name = "postgres";
  /** The channel it publishes and listens on. Internal; read by the tests. */
  readonly channel: string;
  /** The client every `NOTIFY` and `LISTEN` runs on. */
  readonly #sql: SQL;
  /** Whether the client is the bus's own, so `close()` closes it. */
  readonly #ownsClient: boolean;
  /** Live `LISTEN` registrations, removed by `close()`. */
  readonly #subscriptions = new Set<PgSubscription>();
  /** Set once `close()` ran. */
  #closed = false;

  constructor(
    /** The options; see {@link PgBusOptions}. */ options: PgBusOptions,
  ) {
    const prefix = options.prefix ?? DEFAULT_SQL_PREFIX;
    if (!/^[a-z_]\w{0,47}$/i.test(prefix)) {
      throw new TypeError(
        `pgBus: prefix must be letters, digits and _, starting with a letter or _, at most 48 characters; got ${JSON.stringify(prefix)}`,
      );
    }
    if (
      options.channel !== undefined &&
      !/^[a-z_]\w{0,62}$/i.test(options.channel)
    ) {
      throw new TypeError(
        `pgBus: channel must be an SQL identifier of at most 63 characters; got ${JSON.stringify(options.channel)}`,
      );
    }
    this.channel =
      options.channel ??
      pgChannel(
        resolveSqlCacheTables("pgBus", prefix, options.tables, [
          "entries",
          "tags",
          "stamps",
          "locks",
        ]),
      );
    this.#ownsClient = options.sql === undefined;
    this.#sql =
      options.sql ?? openSqlClient("postgres", options, "pgBus", options.max);
  }

  async publish(message: BusMessage): Promise<void> {
    this.#assertOpen();
    await pgNotify(this.#sql, this.channel, message);
  }

  async subscribe(
    onMessage: (message: BusMessage) => void,
    onGap: () => void,
  ): Promise<() => Promise<void>> {
    this.#assertOpen();
    return await pgListen(
      this.#sql,
      this.channel,
      onMessage,
      onGap,
      this.#subscriptions,
    );
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await pgUnlistenAll(this.#subscriptions);
    if (this.#ownsClient) {
      await this.#sql.close();
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("the postgres cache bus is closed");
    }
  }
}

/**
 * A multi-tier bus over Postgres `LISTEN`/`NOTIFY` (§4.2), for `createCache`'s
 * `bus` option: a URL, or {@link PgBusOptions}. The cache's `close()` closes
 * it (and the client, when the bus built it).
 */
export function pgBus(options: string | PgBusOptions): CacheBus {
  return new PgBus(typeof options === "string" ? { url: options } : options);
}
