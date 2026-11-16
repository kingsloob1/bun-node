/**
 * Counted rules (layers.md §0.2, plan D23): "N occurrences of an event
 * within W for one key → an action for B". The counters live in the engine's
 * `ThrottleStore`, the throttle foundation's store, as a fixed window: an
 * `increment` that sets the counter's lifetime only when it creates it,
 * ConcaveHR's `INCR` + `EXPIRE NX`. A shared store (bun-cache's
 * `cacheThrottleStore`) therefore shares them across processes with no other
 * change.
 *
 * When a count reaches the threshold the counter is deleted (one burst, one
 * trip) and the engine bans the rule's key (layer L4, `bans.ts`).
 *
 * With a shared store (topologies.md §3.2) a rule's counters are in its
 * throttle store unless the rule's `state` is `local`. When that store
 * fails, `onStoreError: "local"` counts the occurrence in the engine's own
 * store against the threshold's local share (÷ `state.nodes`, at least 1),
 * and `"open"` does not count it.
 */
import type { Logger, ThrottleStore } from "@kingsleyweb/bun-common";
import type { CompiledCountedRule } from "../policy/compile";
import { then } from "./maybe";
import type { MaybePromise } from "./maybe";

/** What counting one occurrence did. */
export interface CountOutcome {
  /** The count after this occurrence (before the trip cleared it); `undefined` when the store failed. */
  readonly count: number | undefined;
  /** Whether it reached the threshold. */
  readonly tripped: boolean;
  /** The threshold it was counted against: the rule's, or its local share after the shared store failed. */
  readonly threshold?: number;
}

/** How often a store failure is logged at most. */
const WARN_EVERY_MS = 10_000;

/** Not counted: the store failed. */
const NOT_COUNTED: CountOutcome = Object.freeze({
  count: undefined,
  tripped: false,
});

/** The counters. */
export class CountedState {
  /** When a store failure was last logged. */
  #lastWarn = Number.NEGATIVE_INFINITY;

  constructor(
    /** The engine's own store. */
    private readonly local: ThrottleStore,
    /** The shared store's throttle store, if the engine has one. */
    private readonly shared: ThrottleStore | undefined,
    /** Where a store failure is logged. */
    private readonly logger: Logger,
  ) {}

  /** The store key of a rule's counter for `key`. */
  #counter(prefix: string, rule: CompiledCountedRule, key: string): string {
    return `${prefix}:counted:${rule.id}:${rule.window}:${key}`;
  }

  /** Logs a store failure, at most once every 10 s. */
  #warn(store: ThrottleStore, error: unknown, now: number, then: string): void {
    if (now - this.#lastWarn < WARN_EVERY_MS) return;
    this.#lastWarn = now;
    this.logger.warn(
      `bun-security: throttle store "${store.name}" failed; counted-rule occurrences are ${then}`,
      { error },
    );
  }

  /**
   * Counts one occurrence of `rule`'s event under `key`. With `writes` off
   * (`explain()`) it only reads, and answers what counting would do. A trip
   * deletes the counter (or, on a store without `delete`, takes the count
   * back); the caller records the trip.
   */
  count(
    prefix: string,
    rule: CompiledCountedRule,
    key: string,
    writes: boolean,
    now: number,
    nodes: number,
  ): MaybePromise<CountOutcome> {
    const shared =
      rule.state === "local" ? undefined : (this.shared ?? undefined);
    if (shared === undefined) {
      return this.#count(
        this.local,
        prefix,
        rule,
        key,
        rule.threshold,
        writes,
        (error) => {
          this.#warn(this.local, error, now, "not counted");
          return NOT_COUNTED;
        },
      );
    }
    return this.#count(
      shared,
      prefix,
      rule,
      key,
      rule.threshold,
      writes,
      (error) => {
        if (rule.onStoreError === "open") {
          this.#warn(shared, error, now, "not counted (onStoreError open)");
          return NOT_COUNTED;
        }
        this.#warn(
          shared,
          error,
          now,
          "counted in this process at their local share",
        );
        const share = Math.max(1, Math.floor(rule.threshold / nodes));
        return this.#count(
          this.local,
          `${prefix}:local-share`,
          rule,
          key,
          share,
          writes,
          () => NOT_COUNTED,
        );
      },
    );
  }

  /** One count in `store` against `threshold`; `failed` decides on a store failure. */
  #count(
    store: ThrottleStore,
    prefix: string,
    rule: CompiledCountedRule,
    key: string,
    threshold: number,
    writes: boolean,
    failed: (error: unknown) => MaybePromise<CountOutcome>,
  ): MaybePromise<CountOutcome> {
    const counter = this.#counter(prefix, rule, key);
    let counted: MaybePromise<number | undefined>;
    try {
      counted = writes
        ? store.increment(counter, 1, rule.window)
        : then(store.get(counter), (value) => Number(value ?? 0) + 1);
    } catch (error) {
      return failed(error);
    }
    const settle = (value: number | undefined): MaybePromise<CountOutcome> => {
      const count = Number(value ?? 0);
      if (count < threshold) return { count, tripped: false, threshold };
      if (!writes) return { count, tripped: true, threshold };
      let cleared: MaybePromise<unknown>;
      try {
        cleared =
          store.delete === undefined
            ? store.increment(counter, -count, 1)
            : store.delete(counter);
      } catch {
        return { count, tripped: true, threshold };
      }
      const done = (): CountOutcome => ({ count, tripped: true, threshold });
      return cleared instanceof Promise ? cleared.then(done, done) : done();
    };
    if (counted instanceof Promise) return counted.then(settle, failed);
    return settle(counted);
  }
}
