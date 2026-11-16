/**
 * Offence scores across processes (topologies.md §3.3): `hybrid`. Each
 * process scores in memory, so the ladder decides with no round trip; every
 * sync interval it adds what it scored since the last sync to the shared
 * score (`scores:<key>`, `{ v, at }`, decayed on read) and takes the merged
 * score back, and merges the ladder's ban history (`hist:<id>`) the same
 * way. A score is approximate by design (a read-modify-write race loses
 * at most one interval's offences). A key scored here within the last ten
 * intervals is read back at each sync even with nothing to add, so another
 * process's offences, or its reset after a ban, reach it while it is in use.
 */
import type { Logger } from "@kingsleyweb/bun-common";
import type { CompiledLadder } from "../policy/compile";
import type { Scores } from "./scores";
import type { SharedStateStore } from "./shared";

/** What a process scored for one key since the last sync. */
interface Pending {
  /** Weight added. */
  add: number;
  /** Whether the score was reset first (a ban). */
  reset: boolean;
}

/** The most keys waiting to sync; past it, the oldest are dropped. */
const MAX_PENDING = 10_000;

/** A shared score, `undefined` when `value` is not one. */
function readScore(value: unknown): { v: number; at: number } | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { v?: unknown }).v !== "number" ||
    typeof (value as { at?: unknown }).at !== "number"
  ) {
    return undefined;
  }
  const { v, at } = value as { v: number; at: number };
  return Number.isFinite(v) && v >= 0 && Number.isFinite(at)
    ? { v, at }
    : undefined;
}

/** Shared ban times, the valid ones. */
function readTimes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .filter((at): at is number => typeof at === "number" && Number.isFinite(at))
    .slice(-64);
}

/** The scores' sync. */
export class ScoreSync {
  /** Offences since the last sync, by address key. */
  #pending = new Map<string, Pending>();
  /** Ban ids whose history changed since the last sync. */
  #banned = new Set<string>();
  /** Keys scored here lately, and when. */
  #active = new Map<string, number>();
  /** The sync in progress. */
  #syncing: Promise<void> | undefined;
  /** When a failure was last logged. */
  #lastWarn = Number.NEGATIVE_INFINITY;

  constructor(
    /** The shared store. */
    private readonly store: SharedStateStore,
    /** The engine's scores. */
    private readonly scores: Scores,
    /** The clock. */
    private readonly now: () => number,
    /** Where failures are logged. */
    private readonly logger: Logger,
    /** How long a key scored here stays read back at each sync, in ms. */
    private readonly activeFor: number,
    /** The store key prefix of the engine's scope (`""` shared, `svc:<id>:` its own). */
    private readonly prefix: () => string = () => "",
  ) {}

  /** Keys waiting to sync. */
  get pending(): number {
    return this.#pending.size + this.#banned.size;
  }

  /** `weight` was added to `key`'s score here. */
  added(key: string, weight: number): void {
    const entry = this.#take(key);
    entry.add += weight;
  }

  /** `key`'s score was reset here. */
  reset(key: string): void {
    const entry = this.#take(key);
    entry.add = 0;
    entry.reset = true;
  }

  /** A ban of `id` was recorded in the ladder's history here. */
  banned(id: string): void {
    this.#banned.add(id);
    if (this.#banned.size > MAX_PENDING) {
      const oldest = this.#banned.values().next();
      if (oldest.done !== true) this.#banned.delete(oldest.value);
    }
  }

  /** The pending entry of `key`, created; `key` marked active. */
  #take(key: string): Pending {
    this.#active.delete(key);
    this.#active.set(key, this.now());
    if (this.#active.size > MAX_PENDING) {
      const oldest = this.#active.keys().next();
      if (oldest.done !== true) this.#active.delete(oldest.value);
    }
    let entry = this.#pending.get(key);
    if (entry === undefined) {
      entry = { add: 0, reset: false };
      this.#pending.set(key, entry);
      if (this.#pending.size > MAX_PENDING) {
        const oldest = this.#pending.keys().next();
        if (oldest.done !== true) this.#pending.delete(oldest.value);
      }
    }
    return entry;
  }

  /** Syncs what is pending with the store (one sync at a time). */
  sync(ladder: CompiledLadder | undefined): Promise<void> {
    this.#syncing ??= this.#sync(ladder).finally(() => {
      this.#syncing = undefined;
    });
    return this.#syncing;
  }

  /** {@link sync}, unguarded. */
  async #sync(ladder: CompiledLadder | undefined): Promise<void> {
    if (ladder === undefined) {
      this.#pending.clear();
      this.#banned.clear();
      return;
    }
    const pending = this.#pending;
    const banned = this.#banned;
    const now = this.now();
    for (const [key, at] of this.#active) {
      if (now - at < this.activeFor) break;
      this.#active.delete(key);
    }
    if (pending.size === 0 && banned.size === 0 && this.#active.size === 0) {
      return;
    }
    this.#pending = new Map();
    this.#banned = new Set();
    const scope = this.prefix();
    try {
      const keys = [...new Set([...pending.keys(), ...this.#active.keys()])];
      if (keys.length > 0) {
        const shared = await this.store.getMany(
          keys.map((key) => `scores:${scope}${key}`),
        );
        const ttl = Math.ceil(ladder.halfLife * 20);
        const writes: Promise<void>[] = [];
        keys.forEach((key, i) => {
          const score = readScore(shared[i]);
          const entry = pending.get(key);
          if (entry === undefined) {
            // Read back only: another process's offences or reset.
            const later = this.#pending.get(key);
            if (score !== undefined && later === undefined) {
              this.scores.set(
                key,
                score.v *
                  0.5 ** (Math.max(0, now - score.at) / ladder.halfLife),
                now,
              );
            }
            return;
          }
          const base =
            entry.reset || score === undefined
              ? 0
              : score.v *
                0.5 ** (Math.max(0, now - score.at) / ladder.halfLife);
          const value = base + entry.add;
          writes.push(
            this.store.set(`scores:${scope}${key}`, { v: value, at: now }, ttl),
          );
          // Offences scored while this sync ran stay on top.
          const later = this.#pending.get(key);
          if (later?.reset !== true) {
            this.scores.set(key, value + (later?.add ?? 0), now);
          }
        });
        await Promise.all(writes);
      }
      const ids = [...banned];
      if (ids.length > 0) {
        const shared = await this.store.getMany(
          ids.map((id) => `hist:${scope}${id}`),
        );
        await Promise.all(
          ids.map((id, i) =>
            this.store.set(
              `hist:${scope}${id}`,
              this.scores.mergeHistory(id, readTimes(shared[i]), now, ladder),
              ladder.memory,
            ),
          ),
        );
      }
    } catch (error) {
      // Kept for the next sync, under what was scored since.
      for (const [key, entry] of pending) {
        const later = this.#pending.get(key);
        if (later === undefined) this.#pending.set(key, entry);
        else if (!later.reset) {
          later.add += entry.add;
          later.reset = entry.reset;
        }
      }
      for (const id of banned) this.#banned.add(id);
      const now = this.now();
      if (now - this.#lastWarn >= 10_000) {
        this.#lastWarn = now;
        this.logger.warn(
          `bun-security: the shared store "${this.store.name}" failed syncing offence scores; scores keep counting in memory`,
          { error },
        );
      }
    }
  }
}
