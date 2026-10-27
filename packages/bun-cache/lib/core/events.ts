/**
 * The event emitter behind `cache.on` (plan §3.12). Listeners are synchronous
 * and isolated: a throwing listener is logged and never breaks the operation
 * that emitted.
 */
import type { Logger } from "@kingsleyweb/bun-common";
import type { CacheEvent, CacheEventMap } from "./types";

/** The emitter one cache (and its namespace views) shares. */
export class CacheEvents {
  readonly #listeners = new Map<
    CacheEvent,
    Set<(payload: CacheEventMap[CacheEvent]) => void>
  >();

  readonly #logger: Logger;

  constructor(/** Where a throwing listener is reported. */ logger: Logger) {
    this.#logger = logger;
  }

  /** Registers `listener` for `event`; answers an unsubscribe function. */
  on<E extends CacheEvent>(
    event: E,
    listener: (payload: CacheEventMap[E]) => void,
  ): () => void {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    const entry = listener as (payload: CacheEventMap[CacheEvent]) => void;
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  /** Delivers `payload` to `event`'s listeners, synchronously, each isolated from the others' throws. */
  emit<E extends CacheEvent>(event: E, payload: CacheEventMap[E]): void {
    const set = this.#listeners.get(event);
    if (set === undefined) {
      return;
    }
    for (const listener of set) {
      try {
        listener(payload);
      } catch (error) {
        this.#logger.warn(`a cache "${event}" listener threw`, { error });
      }
    }
  }
}
