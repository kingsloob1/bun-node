/**
 * Distinct counts (layers.md L9.2, L11.2): how many different usernames one
 * address tried, how many addresses one account was tried from, within a
 * fixed window. They are not rate limits: a HyperLogLog per key in the
 * shared store (`pfAdd`/`pfCount`, bun-cache's `distinctCount`), keyed by
 * the window's index; in this process, an exact set per key, bounded by
 * `maxKeys` keys and {@link MAX_LOCAL_ELEMENTS} elements each (a count past
 * that reads as the bound: the thresholds that use it are small). When the
 * shared store fails, `onStoreError: "local"` counts here instead and
 * `"open"` answers `undefined` (not counted). PR-S7's credential-stuffing
 * signals are its consumers.
 */
import type { Logger } from "@kingsleyweb/bun-common";
import { then } from "./maybe";
import type { MaybePromise } from "./maybe";
import type { SharedStateStore } from "./shared";
import { BoundedTable } from "./state";
import type { EvictionMonitor } from "./state";

/** The most elements one local key holds. */
export const MAX_LOCAL_ELEMENTS = 1_024;

/** What a distinct count is asked. */
export interface DistinctCount {
  /** What is counted per (`ip:203.0.113.9`), with the counter's own name in it. */
  readonly key: string;
  /** The element seen (a username, an address). */
  readonly element: string;
  /** The window, in milliseconds. */
  readonly window: number;
  /** Where it counts. */
  readonly state: "local" | "shared";
  /** When the shared store fails. */
  readonly onStoreError: "local" | "open";
}

/** One local window's elements. */
interface LocalSet {
  /** The elements. */
  readonly items: Set<string>;
  /** When the window ends. */
  readonly ends: number;
}

/** Distinct counts, local and shared. */
export class DistinctCounts {
  /** The local sets, by key and window. */
  readonly #local: BoundedTable<LocalSet>;
  /** When a failure was last logged. */
  #lastWarn = Number.NEGATIVE_INFINITY;

  constructor(
    /** The shared store, if any. */
    private readonly store: SharedStateStore | undefined,
    /** The bound on local keys. */
    maxKeys: number,
    /** Counts evictions. */
    monitor: EvictionMonitor,
    /** Where failures are logged. */
    private readonly logger: Logger,
  ) {
    this.#local = new BoundedTable("distinct counts", maxKeys, monitor);
  }

  /** Local keys held. */
  get size(): number {
    return this.#local.size;
  }

  /**
   * Adds `count.element` under `count.key` in the window holding `now` and
   * answers how many distinct elements the window has seen, this one
   * included; `undefined` when the shared store failed and the count is
   * `open`.
   */
  add(count: DistinctCount, now: number): MaybePromise<number | undefined> {
    const index = Math.floor(now / count.window);
    if (count.state === "local" || this.store === undefined) {
      return this.#addLocal(count, index, now);
    }
    const key = `d:${count.window}:${index}:${count.key}`;
    const store = this.store;
    const shared = store
      .pfAdd(key, [count.element], count.window * 2)
      .then(() => store.pfCount(key));
    return shared.catch((error: unknown) => {
      if (now - this.#lastWarn >= 10_000) {
        this.#lastWarn = now;
        this.logger.warn(
          `bun-security: the shared store "${store.name}" failed a distinct count; ${count.onStoreError === "local" ? "counting in this process" : "not counted"}`,
          { error },
        );
      }
      return count.onStoreError === "local"
        ? this.#addLocal(count, index, now)
        : undefined;
    });
  }

  /** The count in this process. */
  #addLocal(count: DistinctCount, index: number, now: number): number {
    const key = `${count.window}:${index}:${count.key}`;
    let set = this.#local.get(key);
    if (set === undefined || set.ends <= now) {
      set = { items: new Set(), ends: (index + 1) * count.window };
      this.#local.set(key, set, now);
    }
    if (set.items.size < MAX_LOCAL_ELEMENTS) set.items.add(count.element);
    return set.items.size;
  }

  /** What {@link add} would answer, adding nothing (for `explain()`). */
  peek(count: DistinctCount, now: number): MaybePromise<number | undefined> {
    const index = Math.floor(now / count.window);
    const local = (): number => {
      const set = this.#local.get(`${count.window}:${index}:${count.key}`);
      if (set === undefined || set.ends <= now) return 1;
      return set.items.has(count.element) ||
        set.items.size >= MAX_LOCAL_ELEMENTS
        ? set.items.size
        : set.items.size + 1;
    };
    if (count.state === "local" || this.store === undefined) return local();
    // A sketch cannot say whether it holds an element: the count as it is,
    // plus this one at most.
    return then(
      this.store
        .pfCount(`d:${count.window}:${index}:${count.key}`)
        .catch(() => undefined),
      (counted) =>
        counted === undefined
          ? count.onStoreError === "local"
            ? local()
            : undefined
          : counted + 1,
    );
  }

  /** Forgets the local sets. */
  clear(): void {
    this.#local.clear();
  }
}
