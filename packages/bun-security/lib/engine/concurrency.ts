/**
 * Layer L1's request counts (layers.md L1): requests in flight per client
 * address and in all, local to the process. A request holds a **slot** from
 * the moment the engine admits it until the integration calls `complete()`
 * for it; only requests the integration tracks (`evaluate(facts, { track:
 * true })`) take one, so a caller that never completes cannot lock anyone
 * out.
 *
 * As a guard against a lost `complete()` anyway, a slot older than the
 * policy's `releaseAfter` stops counting: slots are kept oldest first, and
 * each new one first expires up to two old ones (constant work per request).
 * The slots are bounded by `maxKeys`; past it the oldest is dropped and
 * counted as an eviction.
 */
import type { EvictionMonitor } from "./state";

/** One admitted request's slot. */
export interface Slot {
  /** The client's address key; `undefined` for a request counted in the total only. */
  readonly ip: string | undefined;
  /** When it was taken (epoch ms). */
  readonly start: number;
}

/** How many old slots each new one checks for expiry. */
const SWEEP_PER_SLOT = 2;

/** The slots in flight. */
export class InFlight {
  /** Live slots, oldest first. */
  readonly #slots = new Set<Slot>();
  /** Live slots per address key. */
  readonly #perIp = new Map<string, number>();

  constructor(
    /** The most slots held. */
    private readonly maxKeys: number,
    /** Counts evictions. */
    private readonly monitor: EvictionMonitor,
  ) {}

  /** Slots in flight in all. */
  get total(): number {
    return this.#slots.size;
  }

  /** Addresses with a slot in flight. */
  get clients(): number {
    return this.#perIp.size;
  }

  /** Slots in flight for one address key. */
  of(ip: string): number {
    return this.#perIp.get(ip) ?? 0;
  }

  /** Expires slots older than `releaseAfter` (at most `limit` of them). */
  expire(now: number, releaseAfter: number, limit = SWEEP_PER_SLOT): void {
    let checked = 0;
    for (const slot of this.#slots) {
      if (checked++ >= limit || now - slot.start <= releaseAfter) break;
      this.release(slot);
    }
  }

  /** Takes a slot for `ip` (or the total only). */
  take(ip: string | undefined, now: number, releaseAfter: number): Slot {
    this.expire(now, releaseAfter);
    this.monitor.inserted(now);
    while (this.#slots.size >= this.maxKeys) {
      const oldest = this.#slots.values().next();
      if (oldest.done === true) break;
      this.release(oldest.value);
      this.monitor.evicted("in-flight", now);
    }
    const slot: Slot = { ip, start: now };
    this.#slots.add(slot);
    if (ip !== undefined) this.#perIp.set(ip, (this.#perIp.get(ip) ?? 0) + 1);
    return slot;
  }

  /** Gives a slot back; a slot already given back (or expired) is ignored. */
  release(slot: Slot): void {
    if (!this.#slots.delete(slot)) return;
    if (slot.ip === undefined) return;
    const left = (this.#perIp.get(slot.ip) ?? 1) - 1;
    if (left <= 0) this.#perIp.delete(slot.ip);
    else this.#perIp.set(slot.ip, left);
  }

  /** Gives every slot back. */
  clear(): void {
    this.#slots.clear();
    this.#perIp.clear();
  }
}
