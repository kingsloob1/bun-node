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
 * trip) and the key is **tripped**: every later request under the key, in
 * this process, is refused until the rule's duration ends. Trips are kept in
 * a bounded local table here, the seed of PR-S3's L4 bans (which add
 * the ladder, ban history, scopes and sharing); a trip lasts until its rule
 * is removed from the policy or turned off, at the latest.
 */
import type { Logger, ThrottleStore } from "@kingsleyweb/bun-common";
import type { CompiledCountedRule } from "../policy/compile";
import { then } from "./maybe";
import type { MaybePromise } from "./maybe";
import { BoundedTable } from "./state";
import type { EvictionMonitor } from "./state";

/** A tripped key. */
export interface Trip {
  /** The rule that tripped. */
  readonly rule: string;
  /** When it ends (epoch ms); `Infinity` until the rule goes. */
  readonly until: number;
}

/** What counting one occurrence did. */
export interface CountOutcome {
  /** The count after this occurrence (before the trip cleared it); `undefined` when the store failed. */
  readonly count: number | undefined;
  /** Whether it reached the threshold. */
  readonly tripped: boolean;
}

/** How often a store failure is logged at most. */
const WARN_EVERY_MS = 10_000;

/** The counters and the trips. */
export class CountedState {
  /** Tripped keys, by `<rule>\n<key>`. */
  readonly trips: BoundedTable<Trip>;
  /** When a store failure was last logged. */
  #lastWarn = Number.NEGATIVE_INFINITY;

  constructor(
    /** Where the counters live. */
    private readonly store: ThrottleStore,
    /** The most trips held. */
    maxKeys: number,
    /** Counts evictions. */
    monitor: EvictionMonitor,
    /** Where a store failure is logged. */
    private readonly logger: Logger,
  ) {
    this.trips = new BoundedTable("counted-rule trips", maxKeys, monitor);
  }

  /** The store key of a rule's counter for `key`. */
  #counter(prefix: string, rule: CompiledCountedRule, key: string): string {
    return `${prefix}:counted:${rule.id}:${rule.window}:${key}`;
  }

  /** Logs a store failure, at most once every 10 s; the occurrence is not counted (fail open). */
  #failed(error: unknown, now: number): CountOutcome {
    if (now - this.#lastWarn >= WARN_EVERY_MS) {
      this.#lastWarn = now;
      this.logger.warn(
        `bun-security: throttle store "${this.store.name}" failed; counted-rule occurrences are not counted`,
        { error },
      );
    }
    return { count: undefined, tripped: false };
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
  ): MaybePromise<CountOutcome> {
    const counter = this.#counter(prefix, rule, key);
    let counted: MaybePromise<number | undefined>;
    try {
      counted = writes
        ? this.store.increment(counter, 1, rule.window)
        : then(this.store.get(counter), (value) => Number(value ?? 0) + 1);
    } catch (error) {
      return this.#failed(error, now);
    }
    const settle = (value: number | undefined): MaybePromise<CountOutcome> => {
      const count = Number(value ?? 0);
      if (count < rule.threshold) return { count, tripped: false };
      if (!writes) return { count, tripped: true };
      let cleared: MaybePromise<unknown>;
      try {
        cleared =
          this.store.delete === undefined
            ? this.store.increment(counter, -count, 1)
            : this.store.delete(counter);
      } catch (error) {
        this.#failed(error, now);
        return { count, tripped: true };
      }
      return then(cleared, () => ({ count, tripped: true }));
    };
    const outcome = then(counted, settle);
    return outcome instanceof Promise
      ? outcome.catch((error: unknown) => this.#failed(error, now))
      : outcome;
  }

  /** Records a trip of `rule` for `key` from `now`. */
  trip(rule: CompiledCountedRule, key: string, now: number): Trip {
    const trip: Trip = Object.freeze({
      rule: rule.id,
      until: now + rule.duration,
    });
    this.trips.set(`${rule.id}\n${key}`, trip, now);
    return trip;
  }

  /** The trip in force for `rule` and `key` at `now`, dropping an ended one. */
  tripOf(
    rule: CompiledCountedRule,
    key: string,
    now: number,
    writes: boolean,
  ): Trip | undefined {
    const id = `${rule.id}\n${key}`;
    const trip = this.trips.get(id);
    if (trip === undefined) return undefined;
    if (trip.until <= now) {
      if (writes) this.trips.delete(id);
      return undefined;
    }
    return trip;
  }

  /** Drops the trips of every rule not in `kept` (a new policy removed it or turned it off). */
  prune(kept: ReadonlySet<string>): void {
    for (const [id, trip] of this.trips.entries()) {
      if (!kept.has(trip.rule)) this.trips.delete(id);
    }
  }
}
