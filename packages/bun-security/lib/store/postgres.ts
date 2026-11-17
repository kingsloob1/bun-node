/**
 * `postgresStore({ url })` (storage.md §5, PR-D2): the security store in
 * Postgres, for topologies (b) and (c), on D1's SQL core (`sql.ts`) with
 * bun-sql's Postgres dialect. Several processes and hosts share it.
 *
 * **Change sequence safety.** Postgres commits concurrent transactions in
 * any order, so a sequence number taken first can commit last: a reader that
 * had already read past the later one would skip it for good. The store
 * therefore serialises its writers: every mutating transaction first takes a
 * transaction-scoped advisory lock of its own (`pg_advisory_xact_lock`, one
 * key per table prefix), before it touches a row, and holds it until it
 * commits. The next writer's sequence number is taken only after that, so
 * numbers commit in order and a reader at the head never skips one. Taking it
 * first means no writer ever holds a row another waits for while it waits for
 * the lock, so it cannot deadlock. The cost is that this store's writes run
 * one at a time — fine for configuration, which is written by people. (A
 * transaction-id watermark, `pg_snapshot_xmin`, would let writers run in
 * parallel, but any long transaction anywhere in the database would hold the
 * whole feed back, and its cursor is far harder to get right.)
 *
 * **The feed is pushed**: each change `NOTIFY`s the store's channel in its
 * own transaction, delivered on commit, and `subscribe` `LISTEN`s on a
 * client of its own. A listener that reconnects (Bun re-subscribes by itself)
 * reports a gap, which a follower answers with a reconcile. While `LISTEN`
 * cannot be set up, `subscribe` polls `changesSince` every `pollIntervalMs`
 * instead, and tries `LISTEN` again every 5 s.
 */
import type { SQL } from "bun";
import type {
  ConnectionInput,
  SchemaSyncOptions,
  SqlConnectionOptions,
} from "@kingsleyweb/bun-sql";
import type {
  SecurityStoreCapabilities,
  SecurityStoreDriver,
  StoreCodec,
} from "./types";
import { ConfigError } from "@kingsleyweb/bun-common";
import {
  dialectFor,
  openSqlClient,
  sqlClientOptions,
} from "@kingsleyweb/bun-sql";
import type { SqlSecurityStoreInit } from "./sql";
import { DEFAULT_STORE_PREFIX, sqlSecurityStore, storeTables } from "./sql";

/** Options for {@link postgresStore}. */
export interface PostgresStoreOptions {
  /** The connection URL (`postgres://user:pass@host:5432/db`). */
  readonly url?: string;
  /** The connection described as fields, used when `url` is absent. */
  readonly connection?: SqlConnectionOptions;
  /** The table prefix. Default `bun_security_`. */
  readonly prefix?: string;
  /**
   * Run `syncSchema` on connect: `true` for the safe defaults, or its
   * options. Default: off (the schema is created when missing, never
   * changed unasked).
   */
  readonly syncSchema?: boolean | SchemaSyncOptions;
  /** Most connections the client pools. Bun's default when absent. */
  readonly max?: number;
  /** How often `subscribe` polls while `LISTEN` cannot be set up, ms. Default 250. */
  readonly pollIntervalMs?: number;
  /** The clock, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /**
   * Encodes every stored body and decodes it on the way out: where
   * storage.md §8's field sealing (PR-D3) plugs in. Default: stored as given.
   */
  readonly codec?: StoreCodec;
}

/** What the Postgres store can do. */
const CAPABILITIES: SecurityStoreCapabilities = Object.freeze({
  durable: true,
  multiProcess: true,
  multiHost: true,
  transactions: true,
  changeFeed: "push",
  analytics: false,
  cidrQuery: false,
  readOnly: false,
});

/** The advisory lock class every store's lock lives under: `bsec` as an int4. */
export const ADVISORY_LOCK_CLASS = 0x62_73_65_63;

/** How long `subscribe` waits before trying `LISTEN` again after a failure, ms. */
const RELISTEN_MS = 5_000;

/**
 * The feed's `NOTIFY` channel for a table prefix: the prefix and `changes`,
 * within Postgres' 63-byte identifier limit (the prefix is at most 40).
 */
export function changeChannel(prefix: string): string {
  return `${prefix}changes`;
}

/** The security store in Postgres; see the module's description. */
export function postgresStore(
  options: PostgresStoreOptions,
): SecurityStoreDriver {
  return sqlSecurityStore(postgresInit(options));
}

/**
 * What {@link postgresStore} builds the SQL core from. Internal: the tests
 * wrap its `serialize` and `afterChange` to interleave commits, and pass
 * `seams.listen: false` to exercise the polling fallback.
 */
export function postgresInit(
  options: PostgresStoreOptions,
  seams: {
    /** Whether `subscribe` may `LISTEN`; `false` makes it poll. Default `true`. */
    readonly listen?: boolean;
  } = {},
): SqlSecurityStoreInit {
  if (typeof options !== "object" || options === null) {
    throw new ConfigError("postgresStore(): options must be an object");
  }
  const pollMs = options.pollIntervalMs ?? 250;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) {
    throw new ConfigError(
      "postgresStore(): pollIntervalMs must be a positive whole number of milliseconds",
      { pollIntervalMs: pollMs },
    );
  }
  const input: ConnectionInput = {
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(options.connection === undefined
      ? {}
      : { connection: options.connection }),
  };
  // Refuses a missing URL now, not on first use.
  sqlClientOptions("postgres", input, "postgresStore()");
  const prefix = options.prefix ?? DEFAULT_STORE_PREFIX;
  const channel = changeChannel(prefix);
  /** The client `LISTEN` runs on, opened by the first subscriber. */
  let listener: SQL | undefined;
  /** Every live subscription's stop, so close() can end them. */
  const stops = new Set<() => void>();

  /** The client polling runs on, opened when `LISTEN` cannot be. */
  let poller: SQL | undefined;
  const changes = storeTables(prefix).changes;
  const init: SqlSecurityStoreInit = {
    name: "postgres",
    dialect: dialectFor("postgres"),
    open: () =>
      openSqlClient(
        "postgres",
        input,
        "postgresStore()",
        options.max === undefined ? {} : { max: options.max },
      ),
    prefix,
    capabilities: CAPABILITIES,
    syncSchema: options.syncSchema,
    now: options.now ?? Date.now,
    codec: options.codec,
    serialize: async (tx) => {
      await tx.unsafe("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
        ADVISORY_LOCK_CLASS,
        prefix,
      ]);
    },
    afterChange: async (tx, seq) => {
      await tx.unsafe("SELECT pg_notify($1, $2)", [channel, String(seq)]);
    },
    subscribe: (onHead, onGap) => {
      let stopped = false;
      let unlisten: (() => Promise<void>) | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let head = -1n;

      /** The feed's head, read on the polling client. */
      const readHead = async (): Promise<bigint> => {
        poller ??= openSqlClient("postgres", input, "postgresStore()", {
          max: 1,
        });
        const [row] = (await poller.unsafe(
          `SELECT MAX(seq) AS head FROM ${changes}`,
        )) as { head: number | bigint | string | null }[];
        return row?.head == null ? 0n : BigInt(row.head);
      };

      /** Polls the feed's head; tells `onHead` when it moved. */
      const pollOnce = async (): Promise<void> => {
        try {
          const now = await readHead();
          if (head >= 0n && now > head) onHead(now);
          head = now;
        } catch {
          // The store is down; the follower's reconcile reports that.
        }
      };

      /** Sets up `LISTEN`; falls back to polling while it cannot. */
      const listen = async (): Promise<void> => {
        if (stopped) return;
        try {
          if (seams.listen === false) {
            throw new Error("LISTEN turned off (a test seam)");
          }
          listener ??= openSqlClient("postgres", input, "postgresStore()", {
            max: 1,
          });
          let listening = false;
          const subscription = await listener.listen(
            channel,
            (payload) => {
              let seq: bigint;
              try {
                seq = BigInt(payload);
              } catch {
                return;
              }
              onHead(seq);
            },
            () => {
              // Runs again after every reconnect: what was notified while
              // the connection was down is lost.
              if (listening) onGap();
              listening = true;
            },
          );
          if (stopped) {
            await subscription.unlisten().catch(() => undefined);
            return;
          }
          unlisten = () => subscription.unlisten();
          // A write between subscribe() and the LISTEN's acknowledgement
          // notified no one: push the head as it is now, once.
          void readHead().then(
            (now) => {
              if (!stopped) onHead(now);
            },
            () => undefined,
          );
          if (poll !== undefined) {
            clearInterval(poll);
            poll = undefined;
            // Polling may have missed nothing, but the switch is a seam:
            // reconcile.
            onGap();
          }
        } catch {
          if (poll === undefined) {
            onGap();
            void pollOnce();
            poll = setInterval(() => void pollOnce(), pollMs);
            poll.unref?.();
          }
          retry = setTimeout(() => void listen(), RELISTEN_MS);
          retry.unref?.();
        }
      };

      void listen();
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        stops.delete(stop);
        if (poll !== undefined) clearInterval(poll);
        if (retry !== undefined) clearTimeout(retry);
        void unlisten?.().catch(() => undefined);
      };
      stops.add(stop);
      return stop;
    },
    onClose: async () => {
      for (const stop of [...stops]) stop();
      const client = listener;
      listener = undefined;
      await client?.close().catch(() => undefined);
      const polling = poller;
      poller = undefined;
      await polling?.close().catch(() => undefined);
    },
  };
  return init;
}
