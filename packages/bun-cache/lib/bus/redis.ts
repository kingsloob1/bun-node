/**
 * `redisBus()` (plan §4.2): the multi-tier bus over Redis pub/sub, through
 * Bun's `RedisClient`. One channel, `<prefix>:bus`; a JSON
 * {@link BusMessage} per `PUBLISH`.
 *
 * - **Connections.** Publishes go out on the command client (the one given,
 *   or one the bus opens); subscriptions on a `duplicate()` of it, since a
 *   connection in subscribe mode runs nothing else. The duplicate is always
 *   the bus's own and is closed by `close()`; a given client never is.
 * - **Reconnects are gaps.** Bun reconnects a dropped connection, but never
 *   resubscribes it: the new connection has no channels while Bun still
 *   holds their listeners (bun-jobs' Redis driver found this). So
 *   `onconnect` sends a raw `SUBSCRIBE` — `subscribe()` again would add a
 *   second listener — and reports a gap: whatever was published while the
 *   connection was down is lost (measured: after `CLIENT KILL`, Bun
 *   reconnected in about a second and delivery resumed). A subscriber
 *   connection Bun gave up on is revived every 2 s.
 * - **Pub/sub ignores the database number**: a channel is server-wide, so
 *   two deployments on one server share a bus unless their `prefix` (or
 *   `channel`) differs.
 */
import process from "node:process";
import { RedisClient } from "bun";
import type { BusMessage, CacheBus } from "../core/types";

/** How often a subscriber connection Bun gave up reconnecting is revived, in ms. */
const REVIVE_EVERY_MS = 2_000;

/** `redisBus()`'s options: a URL or an open client, and the channel. */
export interface RedisBusOptions {
  /** The server, as a `redis://` or `rediss://` URL. Ignored when `client` is given. */
  url?: string;
  /**
   * An already-open `RedisClient` to publish on (the subscriber connection is
   * a `duplicate()` of it, so it inherits its options). Never closed by the
   * bus.
   */
  client?: RedisClient;
  /** The channel's prefix: the channel is `<prefix>:bus`. Defaults to `bun-cache`. */
  prefix?: string;
  /** The channel, used as is; overrides `prefix`. */
  channel?: string;
}

/** The Redis bus. See the module header and {@link RedisBusOptions}. */
class RedisBus implements CacheBus {
  /** `"redis"`. */
  readonly name = "redis";
  /** The channel it publishes and subscribes on. */
  readonly channel: string;
  /**
   * The subscriber connection's `CLIENT SETNAME`, set on every (re)connect,
   * so an operator — or a test forcing a reconnect — can find it in
   * `CLIENT LIST`. Internal; read by the tests.
   */
  readonly connectionName = `bun-cache-bus-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  /** The options. */
  readonly #options: RedisBusOptions;
  /** The command client, once opened. */
  #client: Promise<RedisClient> | undefined;
  /** The subscriber connection, once opened. */
  #subscriber: Promise<RedisClient> | undefined;
  /** The subscribers: each message goes to every one; each gap too. */
  readonly #listeners = new Set<{
    /** The message callback. */
    onMessage: (message: BusMessage) => void;
    /** The gap callback. */
    onGap: () => void;
  }>();
  /** The revive timer, while there are subscribers. */
  #revive: ReturnType<typeof setInterval> | undefined;
  /** Set once `close()` ran. */
  #closed = false;

  constructor(
    /** The options; see {@link RedisBusOptions}. */ options: RedisBusOptions,
  ) {
    if (options.client === undefined && !options.url) {
      throw new TypeError("redisBus needs either a url or a client");
    }
    if (options.channel !== undefined && options.channel === "") {
      throw new TypeError("redisBus: channel must not be empty");
    }
    this.#options = options;
    this.channel = options.channel ?? `${options.prefix ?? "bun-cache"}:bus`;
  }

  /** The command client: the given one, or one opened on first use. */
  async #commandClient(): Promise<RedisClient> {
    this.#client ??= (async () => {
      const client = this.#options.client ?? new RedisClient(this.#options.url);
      await client.connect();
      return client;
    })();
    try {
      return await this.#client;
    } catch (error) {
      this.#client = undefined;
      throw error;
    }
  }

  /** The subscriber connection, opened once (a promise, so two first subscribes share it). */
  async #subscriberClient(): Promise<RedisClient> {
    this.#subscriber ??= (async () => {
      const client = await this.#commandClient();
      const subscriber = await client.duplicate();
      await subscriber.connect();
      await subscriber.send("CLIENT", ["SETNAME", this.connectionName]);
      await subscriber.subscribe(this.channel, (payload) => {
        this.#deliver(payload);
      });
      // Set once it is connected and subscribed, so it runs on reconnects
      // only: put the channel back on the server, and report the gap.
      subscriber.onconnect = () => {
        subscriber
          .send("CLIENT", ["SETNAME", this.connectionName])
          .catch(() => {});
        subscriber.send("SUBSCRIBE", [this.channel]).catch(() => {});
        for (const listener of this.#listeners) {
          listener.onGap();
        }
      };
      return subscriber;
    })();
    try {
      return await this.#subscriber;
    } catch (error) {
      this.#subscriber = undefined;
      throw error;
    }
  }

  /** Parses one payload and hands it to every subscriber; a payload that is not JSON is not ours. */
  #deliver(payload: string): void {
    let message: BusMessage;
    try {
      message = JSON.parse(payload) as BusMessage;
    } catch {
      return;
    }
    for (const listener of this.#listeners) {
      listener.onMessage(message);
    }
  }

  async publish(message: BusMessage): Promise<void> {
    this.#assertOpen();
    const client = await this.#commandClient();
    await client.publish(this.channel, JSON.stringify(message));
  }

  async subscribe(
    onMessage: (message: BusMessage) => void,
    onGap: () => void,
  ): Promise<() => Promise<void>> {
    this.#assertOpen();
    await this.#subscriberClient();
    const listener = { onMessage, onGap };
    this.#listeners.add(listener);
    this.#revive ??= setInterval(() => {
      void this.#reviveSubscriber();
    }, REVIVE_EVERY_MS);
    this.#revive.unref?.();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0 && this.#revive !== undefined) {
        clearInterval(this.#revive);
        this.#revive = undefined;
      }
      return Promise.resolve();
    };
  }

  /** Reconnects the subscriber when Bun has given up on it; its `onconnect` restores the channel. Best effort. */
  async #reviveSubscriber(): Promise<void> {
    try {
      const subscriber = await this.#subscriber;
      if (subscriber !== undefined && !subscriber.connected) {
        await subscriber.connect();
      }
    } catch {
      // The next revival tries again.
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#revive !== undefined) {
      clearInterval(this.#revive);
      this.#revive = undefined;
    }
    this.#listeners.clear();
    const subscriber = await this.#subscriber?.catch(() => undefined);
    this.#subscriber = undefined;
    if (subscriber !== undefined) {
      subscriber.onconnect = null;
      await subscriber.unsubscribe(this.channel).catch(() => {});
      subscriber.close();
    }
    const client = await this.#client?.catch(() => undefined);
    this.#client = undefined;
    if (client !== undefined && this.#options.client === undefined) {
      client.close();
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("the redis cache bus is closed");
    }
  }
}

/**
 * A multi-tier bus over Redis pub/sub (§4.2), for `createCache`'s `bus`
 * option: a URL, or {@link RedisBusOptions}. The cache's `close()` closes it
 * (and the connections it opened).
 */
export function redisBus(options: string | RedisBusOptions): CacheBus {
  return new RedisBus(typeof options === "string" ? { url: options } : options);
}
