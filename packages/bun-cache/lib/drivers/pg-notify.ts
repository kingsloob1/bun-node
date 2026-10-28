/**
 * Postgres `LISTEN`/`NOTIFY` as the multi-tier bus (plan §4.2), shared by the
 * Postgres driver's own bus and `pgBus()` so the two speak the same wire: a
 * JSON {@link BusMessage} per notification, on a channel derived from the
 * store's table names.
 *
 * - **Payloads** are capped below Postgres's 8,000 bytes: past it, the
 *   message becomes a `clear` of its namespace (keeping its origin), which
 *   every subscriber can act on conservatively.
 * - **Gaps**: Bun's listener reconnects on its own and re-runs `onlisten`;
 *   each re-run is reported as a gap, since notifications sent while it was
 *   down are lost (measured: a terminated backend reconnects in ~250 ms).
 */
import { Buffer } from "node:buffer";
import type { SQL } from "bun";
import type { BusMessage } from "../core/types";
import type { SqlCacheTable } from "./sql-tables";
import { sqlCacheStoreKey } from "./sql-tables";

/**
 * The largest `NOTIFY` payload sent as is, in bytes. Postgres refuses 8,000
 * and above ("payload string too long", measured for the plan); a message
 * past this becomes a `clear` of its namespace.
 */
export const MAX_NOTIFY_PAYLOAD_BYTES = 7_900;

/** A live `LISTEN` registration. */
export interface PgSubscription {
  /** Stops listening. */
  unlisten: () => Promise<void>;
}

/**
 * The bus channel of a store: `bun_cache_` + a hash of its table names
 * (`sqlCacheStoreKey`), so two clients on the same tables share it and two on
 * different tables never do.
 */
export function pgChannel(tables: Record<SqlCacheTable, string>): string {
  return `bun_cache_${Bun.hash(sqlCacheStoreKey(tables)).toString(36)}`;
}

/** Publishes one message on `channel`; one past the payload cap goes out as a `clear` of its namespace. */
export async function pgNotify(
  sql: SQL,
  channel: string,
  message: BusMessage,
): Promise<void> {
  let payload = JSON.stringify(message);
  if (Buffer.byteLength(payload) > MAX_NOTIFY_PAYLOAD_BYTES) {
    // Too many keys for one notification: every subscriber drops the whole
    // namespace instead, which is always a safe reading of "these changed".
    // The origin stays, so the publisher still skips its own message.
    const flush: BusMessage = {
      type: "clear",
      namespace: message.namespace,
      at: message.at,
      ...(message.origin === undefined ? {} : { origin: message.origin }),
    };
    payload = JSON.stringify(flush);
  }
  await sql.notify(channel, payload);
}

/**
 * Listens on `channel`; answers the unsubscribe function. Each registration
 * is added to `subscriptions` (and removed by its unsubscribe), so the owner
 * can stop them all on close.
 */
export async function pgListen(
  sql: SQL,
  channel: string,
  onMessage: (message: BusMessage) => void,
  onGap: () => void,
  subscriptions: Set<PgSubscription>,
): Promise<() => Promise<void>> {
  let listening = false;
  const subscription = await sql.listen(
    channel,
    (payload) => {
      let message: BusMessage;
      try {
        message = JSON.parse(payload) as BusMessage;
      } catch {
        // Not ours (another client NOTIFYing the channel): nothing to act on.
        return;
      }
      onMessage(message);
    },
    () => {
      // Runs once the LISTEN is acknowledged, and again after every
      // reconnect: anything notified while it was down is lost — a gap.
      if (listening) {
        onGap();
      }
      listening = true;
    },
  );
  subscriptions.add(subscription);
  return async () => {
    if (subscriptions.delete(subscription)) {
      await subscription.unlisten();
    }
  };
}

/** Stops every registration in `subscriptions`, ignoring failures (a client already closed). */
export async function pgUnlistenAll(
  subscriptions: Set<PgSubscription>,
): Promise<void> {
  const all = [...subscriptions];
  subscriptions.clear();
  for (const subscription of all) {
    await subscription.unlisten().catch(() => undefined);
  }
}
