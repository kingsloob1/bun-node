/**
 * The global failure-rate rule (layers.md L11.2, "global failure ratio";
 * the `login.failure-rate` preset): sign-in failures across every client of
 * a route marked `login`, against the route's own baseline.
 *
 * Why it exists: a spray that uses a fresh address for every attempt, each
 * at a different username, never repeats a key, so no per-address,
 * per-username or distinct-count rule sees it (T2's attack suite: 60 of 60
 * answered). What it cannot hide is the route's failures as a whole.
 *
 * Counting: every `auth.failure` and `auth.success` on a `login` route adds
 * to two sets of time slots in the shared store (S4's, or this process's
 * without one): the window's (five slots, a fifth of `window` each) and the
 * baseline's (24 slots). A read sums the slots that cover the window or the
 * baseline, the oldest weighted by its overlap. So the counts are the
 * fleet's, whichever process saw the attempt.
 *
 * The baseline is the route's history before the window (the baseline's
 * slots less the window's counts), so an attack does not raise the bar it
 * is measured against.
 *
 * Tripping: the window holds at least `minFailures` failures, and its
 * failure ratio is at least `factor` × the baseline's (the baseline's taken
 * as at least 5 %, the threshold at most 90 %). A ratio, not a count: a
 * surge of ordinary sign-ins (a Monday morning) raises failures and
 * successes alike and trips nothing. Once tripped it holds for `hold` after
 * the ratio is back under.
 *
 * Cost: a request reads a cached state (no store call). The state is
 * refreshed in the background: at most once a second after an outcome, and
 * every 10 s otherwise, each refresh one read per slot.
 */
import type { Logger, ThrottleStore } from "@kingsleyweb/bun-common";
import type { MaybePromise } from "../engine/maybe";
import type { CompiledFailureRate } from "./compile";
import { all, then } from "../engine/maybe";

/** The lowest baseline failure ratio the threshold is built on. */
const FLOOR_RATIO = 0.05;

/** The highest failure-ratio threshold. */
const CEILING_RATIO = 0.9;

/** How stale a state may be before a read refreshes it, ms. */
const REFRESH_MS = 10_000;

/** The least time between two refreshes an outcome asks for, ms. */
const OUTCOME_REFRESH_MS = 1_000;

/** The most routes kept. */
const MAX_ROUTES = 256;

/** One route's failure rate, as last read. */
export interface FailureRateState {
  /** The route (`"POST /login"`). */
  readonly route: string;
  /** Whether the rule is tripped. */
  readonly tripped: boolean;
  /** Since when, epoch ms, while tripped. */
  readonly since: number | undefined;
  /** Failures in the window. */
  readonly failures: number;
  /** Attempts (failures and successes) in the window. */
  readonly attempts: number;
  /** The window's failure ratio. */
  readonly ratio: number;
  /** The baseline's failure ratio (the history before the window). */
  readonly baselineRatio: number;
  /** When it was read, epoch ms. */
  readonly readAt: number;
}

/** What the watch needs from the engine. */
export interface FailureRateDeps {
  /** This process's counters. */
  readonly local: ThrottleStore;
  /** The shared store's counters, if any. */
  readonly shared: ThrottleStore | undefined;
  /** Raised once each time a route trips. */
  readonly tripped: (state: FailureRateState, now: number) => void;
  /** Where failures are logged. */
  readonly logger: Logger;
}

/** One route's entry. */
interface Entry {
  /** The state as last read. */
  state: FailureRateState | undefined;
  /** When the condition last held, epoch ms. */
  heldAt: number | undefined;
  /** When it tripped, epoch ms. */
  since: number | undefined;
  /** The refresh running, if any. */
  refreshing: Promise<void> | undefined;
  /** When the last refresh started, epoch ms. */
  startedAt: number;
  /** What the last refresh read with: the rule, the key prefix and the route. */
  source:
    | {
        readonly rate: CompiledFailureRate;
        readonly prefix: string;
        readonly route: string;
      }
    | undefined;
}

/** The engine's watch of every `login` route's failure rate. */
export class FailureRateWatch {
  readonly #routes = new Map<string, Entry>();
  #lastWarn = Number.NEGATIVE_INFINITY;

  constructor(
    /** What it needs from the engine. */
    private readonly deps: FailureRateDeps,
  ) {}

  /** Runs `op` on the shared store, or this process's when there is none or it fails. */
  #store<T>(
    op: (store: ThrottleStore) => MaybePromise<T>,
    now: number,
  ): MaybePromise<T> {
    const shared = this.deps.shared;
    if (shared === undefined) return op(this.deps.local);
    const fallback = (error: unknown): MaybePromise<T> => {
      if (now - this.#lastWarn >= 10_000) {
        this.#lastWarn = now;
        this.deps.logger.warn(
          "bun-security: the shared store failed for the failure-rate rule; counting in this process",
          { error },
        );
      }
      return op(this.deps.local);
    };
    try {
      const result = op(shared);
      return result instanceof Promise ? result.catch(fallback) : result;
    } catch (error) {
      return fallback(error);
    }
  }

  /** A route's entry, made on first use; the oldest is dropped past {@link MAX_ROUTES}. */
  #entry(key: string): Entry {
    let entry = this.#routes.get(key);
    if (entry === undefined) {
      if (this.#routes.size >= MAX_ROUTES) {
        const oldest = this.#routes.keys().next().value;
        if (oldest !== undefined) this.#routes.delete(oldest);
      }
      entry = {
        state: undefined,
        heldAt: undefined,
        since: undefined,
        refreshing: undefined,
        startedAt: Number.NEGATIVE_INFINITY,
        source: undefined,
      };
      this.#routes.set(key, entry);
    }
    return entry;
  }

  /** The counter key of one slot. */
  #key(prefix: string, route: string, series: string, slot: number): string {
    return `${prefix}:login:fr:${route}:${series}:${slot}`;
  }

  /**
   * Counts an outcome of `route` (a failure or a success) in the window's
   * and the baseline's slots, then refreshes the route's state if it is a
   * second old.
   */
  record(
    rate: CompiledFailureRate,
    prefix: string,
    route: string,
    failed: boolean,
    now: number,
  ): MaybePromise<void> {
    const short = Math.floor(now / rate.slot);
    const long = Math.floor(now / rate.baselineSlot);
    const counted = this.#store(
      (store) =>
        all([
          store.increment(
            this.#key(prefix, route, failed ? "f" : "s", short),
            1,
            rate.window + rate.slot,
          ),
          store.increment(
            this.#key(prefix, route, failed ? "F" : "S", long),
            1,
            rate.baseline + rate.baselineSlot,
          ),
        ]),
      now,
    );
    return then(counted, () => {
      const entry = this.#entry(`${prefix}|${route}`);
      if (now - entry.startedAt >= OUTCOME_REFRESH_MS) {
        void this.refresh(rate, prefix, route, now);
      }
    });
  }

  /**
   * The route's state as last read (no store call); refreshes it in the
   * background when it is older than 10 s. `undefined` before the first
   * read.
   */
  state(
    rate: CompiledFailureRate,
    prefix: string,
    route: string,
    now: number,
  ): FailureRateState | undefined {
    const entry = this.#entry(`${prefix}|${route}`);
    if (entry.refreshing === undefined && now - entry.startedAt >= REFRESH_MS) {
      void this.refresh(rate, prefix, route, now);
    }
    const state = entry.state;
    if (state === undefined) return undefined;
    // A hold that ran out since the last read ends the trip now.
    if (
      state.tripped &&
      (entry.heldAt === undefined || now - entry.heldAt > rate.hold)
    ) {
      return { ...state, tripped: false, since: undefined };
    }
    return state;
  }

  /** Reads the route's counts and decides whether it is tripped. Never rejects. */
  refresh(
    rate: CompiledFailureRate,
    prefix: string,
    route: string,
    now: number,
  ): Promise<void> {
    const entry = this.#entry(`${prefix}|${route}`);
    if (entry.refreshing !== undefined) return entry.refreshing;
    entry.startedAt = now;
    entry.source = { rate, prefix, route };
    entry.refreshing = this.#read(rate, prefix, route, now)
      .then((read) => {
        const { failures, successes } = read;
        // The baseline is the route's history before the window, so an
        // attack does not raise the bar it is measured against.
        const baseFailures = Math.max(0, read.baseFailures - failures);
        const baseSuccesses = Math.max(0, read.baseSuccesses - successes);
        const attempts = failures + successes;
        const baseAttempts = baseFailures + baseSuccesses;
        const ratio = attempts === 0 ? 0 : failures / attempts;
        const baselineRatio =
          baseAttempts === 0 ? 0 : baseFailures / baseAttempts;
        const threshold = Math.min(
          CEILING_RATIO,
          rate.factor * Math.max(baselineRatio, FLOOR_RATIO),
        );
        const holds = failures >= rate.minFailures && ratio >= threshold;
        if (holds) entry.heldAt = now;
        const tripped =
          entry.heldAt !== undefined && now - entry.heldAt <= rate.hold;
        const started = tripped && entry.since === undefined;
        if (tripped) entry.since ??= now;
        else entry.since = undefined;
        entry.state = Object.freeze({
          route,
          tripped,
          since: entry.since,
          failures: Math.round(failures),
          attempts: Math.round(attempts),
          ratio,
          baselineRatio,
          readAt: now,
        });
        if (started) this.deps.tripped(entry.state, now);
      })
      .catch((error: unknown) => {
        this.deps.logger.warn(
          "bun-security: the failure-rate rule could not read its counts",
          { error },
        );
      })
      .finally(() => {
        entry.refreshing = undefined;
      });
    return entry.refreshing;
  }

  /** Sums the slots covering the window and the baseline, the oldest weighted by overlap. */
  async #read(
    rate: CompiledFailureRate,
    prefix: string,
    route: string,
    now: number,
  ): Promise<{
    failures: number;
    successes: number;
    baseFailures: number;
    baseSuccesses: number;
  }> {
    const sum = async (
      series: string,
      slot: number,
      span: number,
    ): Promise<number> => {
      const last = Math.floor(now / slot);
      const first = Math.floor((now - span) / slot);
      // The oldest slot counts by the part of it inside the span.
      const overlap = 1 - ((now - span) % slot) / slot;
      const reads: MaybePromise<number | undefined>[] = [];
      for (let at = first; at <= last; at++) {
        reads.push(
          this.#store(
            (store) => store.get(this.#key(prefix, route, series, at)),
            now,
          ),
        );
      }
      const counts = await Promise.all(reads);
      return counts.reduce<number>(
        (total, count, index) =>
          total + Number(count ?? 0) * (index === 0 ? overlap : 1),
        0,
      );
    };
    const [failures, successes, baseFailures, baseSuccesses] =
      await Promise.all([
        sum("f", rate.slot, rate.window),
        sum("s", rate.slot, rate.window),
        sum("F", rate.baselineSlot, rate.baseline),
        sum("S", rate.baselineSlot, rate.baseline),
      ]);
    return { failures, successes, baseFailures, baseSuccesses };
  }

  /**
   * Counts an answered attempt toward the stricter limit of `respond:
   * "limit"` (with `writes`), or reads it; answers the count.
   */
  attempt(
    rate: CompiledFailureRate,
    prefix: string,
    route: string,
    key: string,
    writes: boolean,
    now: number,
  ): MaybePromise<number> {
    const counter = `${prefix}:login:fr-limit:${route}:${key}:${Math.floor(now / rate.limit.window)}`;
    return this.#store(
      (store) =>
        writes
          ? store.increment(counter, 1, rate.limit.window)
          : then(store.get(counter), (count) => Number(count ?? 0) + 1),
      now,
    );
  }

  /** Reads every route's counts afresh (`flush()`); never rejects. */
  async refreshAll(now: number): Promise<void> {
    const waiting: Promise<void>[] = [];
    for (const entry of this.#routes.values()) {
      if (entry.refreshing !== undefined) waiting.push(entry.refreshing);
    }
    await Promise.all(waiting);
    await Promise.all(
      [...this.#routes.values()].map(async (entry) => {
        const source = entry.source;
        if (source === undefined) return;
        await this.refresh(source.rate, source.prefix, source.route, now);
      }),
    );
  }

  /** Every route's state as last read, for `status()`. */
  status(): readonly FailureRateState[] {
    const out: FailureRateState[] = [];
    for (const entry of this.#routes.values()) {
      if (entry.state !== undefined) out.push(entry.state);
    }
    return Object.freeze(out);
  }

  /** Forgets every route (a policy load that turned the rule off). */
  clear(): void {
    this.#routes.clear();
  }
}
