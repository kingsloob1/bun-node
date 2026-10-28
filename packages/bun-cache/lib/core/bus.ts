/**
 * The cache's side of the multi-tier bus (plan §4.2): which bus a cache uses
 * (`bus: "auto"` → the driver's own), the origin id that lets a cache skip its
 * own messages, publishes batched per microtask, and a subscription that
 * retries until it holds — telling the cache to flush its L1 each time it
 * (re)subscribes, since nothing published before then reached it.
 */
import type { BusMessage, CacheBus, CacheDriver } from "./types";

/** At most this many keys per published message; a longer batch is split. */
const MAX_KEYS_PER_MESSAGE = 100;

/** The first resubscribe delay after a failed subscribe, in ms; doubled per failure up to {@link MAX_RETRY_MS}. */
const FIRST_RETRY_MS = 500;

/** The longest resubscribe delay, in ms. */
const MAX_RETRY_MS = 30_000;

/**
 * The driver's own bus as a {@link CacheBus}, or `undefined` when it has none
 * (`capabilities.bus: "none"`, or no `publish`/`subscribe`). Its `close` is a
 * no-op: the driver's `close()` stops its bus.
 */
export function driverBus(driver: CacheDriver): CacheBus | undefined {
  const { publish, subscribe } = driver;
  if (
    driver.capabilities.bus === "none" ||
    publish === undefined ||
    subscribe === undefined
  ) {
    return undefined;
  }
  return {
    name: driver.name,
    publish: async (message) => {
      await publish.call(driver, message);
    },
    subscribe: async (onMessage, onGap) =>
      await subscribe.call(driver, onMessage, onGap),
    close: async () => {},
  };
}

/** What a {@link BusLink} tells the cache. */
export interface BusLinkHandlers {
  /** Another cache's message. */
  onMessage: (message: BusMessage) => void;
  /** The subscription (re)started, or the bus reported a gap: messages may have been missed. */
  onFlush: () => void;
  /** Publishing or subscribing failed. */
  onError: (error: unknown) => void;
}

/** One cache's connection to its bus. */
export class BusLink {
  /** The bus. */
  readonly bus: CacheBus;
  /** This cache's origin id, stamped on every message it publishes. */
  readonly origin: string = crypto.randomUUID();
  /** Whether the cache's `close()` closes the bus (an explicit one; the driver's is the driver's). */
  readonly #owned: boolean;
  /** The cache's callbacks. */
  readonly #handlers: BusLinkHandlers;
  /** The messages waiting for this microtask's publish. */
  #queue: BusMessage[] = [];
  /** The publish the queued messages will go out in. */
  #pending: Promise<void> | undefined;
  /** Publishes not yet settled, so `close()` can wait for them. */
  readonly #inFlight = new Set<Promise<void>>();
  /** The unsubscribe function, once subscribed. */
  #unsubscribe: (() => Promise<void>) | undefined;
  /** The resubscribe timer after a failure. */
  #retry: ReturnType<typeof setTimeout> | undefined;
  /** Set by `close()`. */
  #closed = false;

  constructor(
    /** The bus to publish and subscribe on. */ bus: CacheBus,
    /** Whether the cache owns it (closes it on `close()`). */ owned: boolean,
    /** The cache's callbacks. */ handlers: BusLinkHandlers,
  ) {
    this.bus = bus;
    this.#owned = owned;
    this.#handlers = handlers;
  }

  /** Starts subscribing; retries with backoff until it holds or `close()` runs. */
  start(): void {
    void this.#subscribe(0);
  }

  async #subscribe(attempt: number): Promise<void> {
    this.#retry = undefined;
    try {
      const unsubscribe = await this.bus.subscribe(
        (message) => {
          if (message.origin !== this.origin) {
            this.#handlers.onMessage(message);
          }
        },
        () => {
          this.#handlers.onFlush();
        },
      );
      if (this.#closed) {
        await unsubscribe();
        return;
      }
      this.#unsubscribe = unsubscribe;
      // Whatever was published before this point never reached us.
      this.#handlers.onFlush();
    } catch (error) {
      this.#handlers.onError(error);
      if (this.#closed) {
        return;
      }
      this.#retry = setTimeout(
        () => {
          void this.#subscribe(attempt + 1);
        },
        Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** attempt),
      );
      this.#retry.unref?.();
    }
  }

  /**
   * Publishes `message` with this cache's origin, batched with the others
   * queued in the same microtask (`set` and `delete` keys merged per
   * namespace). Resolves once the batch is out; never rejects — a failure
   * goes to `onError`.
   */
  publish(message: BusMessage): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }
    this.#queue.push({ ...message, origin: this.origin });
    this.#pending ??= new Promise<void>((resolve) => {
      queueMicrotask(() => {
        const batch = mergeMessages(this.#queue);
        this.#queue = [];
        this.#pending = undefined;
        const sent = Promise.all(
          batch.map(async (each) => {
            try {
              await this.bus.publish(each);
            } catch (error) {
              this.#handlers.onError(error);
            }
          }),
        ).then(() => {});
        this.#inFlight.add(sent);
        void sent.finally(() => {
          this.#inFlight.delete(sent);
        });
        resolve(sent);
      });
    });
    return this.#pending;
  }

  /** Waits for queued publishes, unsubscribes, and closes the bus when the cache owns it. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    await this.#pending;
    await Promise.all(this.#inFlight);
    this.#closed = true;
    if (this.#retry !== undefined) {
      clearTimeout(this.#retry);
      this.#retry = undefined;
    }
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    await unsubscribe?.().catch((error: unknown) => {
      this.#handlers.onError(error);
    });
    if (this.#owned) {
      await this.bus.close();
    }
  }
}

/** Merges a microtask's messages: `set` and `delete` keys per namespace (at most {@link MAX_KEYS_PER_MESSAGE} a message), the rest as they are, in order. */
function mergeMessages(queue: readonly BusMessage[]): BusMessage[] {
  const out: BusMessage[] = [];
  const merged = new Map<string, { message: BusMessage; keys: Set<string> }>();
  for (const message of queue) {
    if (
      (message.type === "set" || message.type === "delete") &&
      message.keys !== undefined
    ) {
      const id = `${message.type}\n${message.namespace}`;
      let group = merged.get(id);
      if (group === undefined) {
        group = { message, keys: new Set() };
        merged.set(id, group);
        out.push(message);
      }
      for (const key of message.keys) {
        group.keys.add(key);
      }
    } else {
      out.push(message);
    }
  }
  return out.flatMap((message) => {
    const group =
      message.keys === undefined
        ? undefined
        : merged.get(`${message.type}\n${message.namespace}`);
    if (group === undefined || group.message !== message) {
      return [message];
    }
    const keys = [...group.keys];
    const chunks: BusMessage[] = [];
    for (let at = 0; at < keys.length; at += MAX_KEYS_PER_MESSAGE) {
      chunks.push({
        ...message,
        keys: keys.slice(at, at + MAX_KEYS_PER_MESSAGE),
      });
    }
    return chunks;
  });
}
