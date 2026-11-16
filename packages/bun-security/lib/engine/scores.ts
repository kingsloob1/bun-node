/**
 * The offence score and the ladder's memory (layers.md §0.2, plan D10): a
 * score per client address key that offences raise and that halves every
 * `halfLife`, and the times of each subject's recent bans, from which an
 * escalating ban's length is `base × factor^(n-1)` (n the bans within
 * `memory`, this one included), capped at `maxBan`. Both tables are bounded
 * by `maxKeys`, their evictions counted.
 */
import type { CompiledLadder } from "../policy/compile";
import { BoundedTable } from "./state";
import type { EvictionMonitor } from "./state";

/** A score and when it was last written. */
interface Score {
  /** The score at {@link at}. */
  readonly value: number;
  /** Epoch ms. */
  readonly at: number;
}

/** The most ban times remembered per subject. */
const MAX_HISTORY = 16;

/** Scores and ban history. */
export class Scores {
  /** Scores by address key. */
  readonly #scores: BoundedTable<Score>;
  /** Recent ban times by ban id, oldest first. */
  readonly #history: BoundedTable<readonly number[]>;

  constructor(maxKeys: number, monitor: EvictionMonitor) {
    this.#scores = new BoundedTable("scores", maxKeys, monitor);
    this.#history = new BoundedTable("ban history", maxKeys, monitor);
  }

  /** Subjects with a score. */
  get size(): number {
    return this.#scores.size;
  }

  /** The score of `key` at `now`, decayed. */
  get(key: string, now: number, ladder: CompiledLadder): number {
    const score = this.#scores.get(key);
    if (score === undefined) return 0;
    return score.value * 0.5 ** (Math.max(0, now - score.at) / ladder.halfLife);
  }

  /** Adds `weight` to `key`'s score; answers the new score. */
  add(
    key: string,
    weight: number,
    now: number,
    ladder: CompiledLadder,
  ): number {
    const value = this.get(key, now, ladder) + weight;
    this.#scores.set(key, { value, at: now }, now);
    return value;
  }

  /**
   * Sets `key`'s score to `value` as of `at` (the shared store's merged
   * score, `scoreSync.ts`), keeping the table's bound.
   */
  set(key: string, value: number, at: number): void {
    this.#scores.set(key, { value, at }, at);
  }

  /** The ban times remembered for `id`, oldest first. */
  history(id: string): readonly number[] {
    return this.#history.get(id) ?? [];
  }

  /**
   * Adds other processes' ban times for `id` (the shared store's history),
   * keeping those within `ladder.memory` of `now`, at most 16.
   */
  mergeHistory(
    id: string,
    times: readonly number[],
    now: number,
    ladder: CompiledLadder,
  ): readonly number[] {
    const merged = [...new Set([...(this.#history.get(id) ?? []), ...times])]
      .filter((at) => now - at < ladder.memory)
      .sort((a, b) => a - b)
      .slice(-MAX_HISTORY);
    this.#history.set(id, merged, now);
    return merged;
  }

  /** Clears `key`'s score (after a ban, or an unban of an automatic one). */
  reset(key: string): void {
    this.#scores.delete(key);
  }

  /**
   * The length of the next escalating ban of `id` at `now`; with `record`,
   * remembers this ban for the next one's length.
   */
  escalate(
    id: string,
    now: number,
    ladder: CompiledLadder,
    record: boolean,
  ): number {
    const recent = (this.#history.get(id) ?? []).filter(
      (at) => now - at < ladder.memory,
    );
    const length = Math.min(
      ladder.maxBan,
      ladder.base * ladder.factor ** recent.length,
    );
    if (record) {
      recent.push(now);
      this.#history.set(id, recent.slice(-MAX_HISTORY), now);
    }
    return length;
  }

  /** Forgets everything. */
  clear(): void {
    this.#scores.clear();
    this.#history.clear();
  }
}
