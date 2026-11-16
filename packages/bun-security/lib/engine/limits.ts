/**
 * Layer L9 on the throttle foundation (layers.md L9.1): bun-security ships
 * no rate limiter of its own. Each limit of the policy is a bun-common
 * `throttle()` with that one named limit, counted by key with the
 * throttle's `count()` and read by `explain()` with `peekCount()`, which
 * consumes nothing (kingsloob1/bun-node#791: no stand-in request any more).
 * The engine decides which limits apply to a request and under which key;
 * the throttle counts it — its algorithms, its window placement, its store
 * calls.
 *
 * **Where a limit counts** (topologies.md §3.2) is its `state`: `local` in
 * the engine's own store, `shared` in the shared store's throttle store,
 * `hybrid` in the shared store's hybrid store. A `shared` or `hybrid` limit's
 * throttle fails closed, so a store failure reaches the engine, which does
 * what the limit's `onStoreError` says (§6.1): `local` counts it again in
 * the engine's own store at the local share (the limit ÷ `state.nodes`, at
 * least 1), through a second throttle built on the first failure; `open`
 * lets it through, uncounted; `closed` refuses it `503`. A `local` limit
 * fails open, as before.
 *
 * A new policy reuses the throttle of a limit whose id, algorithm and state
 * are unchanged, through `ThrottleHandler.update()`, so its counts carry
 * over while its window stays the same.
 */
import { ConfigError, throttle } from "@kingsleyweb/bun-common";
import type {
  Logger,
  ThrottleHandler,
  ThrottleResult,
  ThrottleStore,
} from "@kingsleyweb/bun-common";
import type { CompiledLimit } from "../policy/compile";
import type { StateMode } from "../policy/types";
import { isThenable } from "./maybe";
import type { MaybePromise } from "./maybe";

/** The stores limits count in. */
export interface LimitStores {
  /** The engine's own store (`local`, and every limit's local share). */
  readonly local: ThrottleStore;
  /** The shared store's throttle store (`shared`), if the engine has one. */
  readonly shared: ThrottleStore | undefined;
  /** The shared store's hybrid store (`hybrid`), if it has one. */
  readonly hybrid: ThrottleStore | undefined;
}

/** One limit's throttles, and the shape they were built for. */
export interface BuiltLimit {
  /** The throttle where it counts. */
  readonly handler: ThrottleHandler;
  /** The algorithm it was built with (fixed for a throttle's life). */
  readonly algorithm: CompiledLimit["algorithm"];
  /** The key prefix it was built with. */
  readonly prefix: string;
  /** Where it counts. */
  readonly state: StateMode;
  /** The throttle of its local share, built on the first store failure. */
  fallback: ThrottleHandler | undefined;
  /** Its local share. */
  share: number;
}

/** The throttles of one policy, by limit id. */
export type LimitSet = ReadonlyMap<string, BuiltLimit>;

/** What counting one request against one limit came to. */
export type LimitCount =
  | {
      /** Counted. */
      readonly kind: "counted";
      /** The throttle's result. */
      readonly result: ThrottleResult;
      /** Whether it counted in the limit's store, or at its local share after the store failed. */
      readonly via: "store" | "local share";
    }
  | {
      /** The shared store failed and the limit's `onStoreError` is `open` or `closed`. */
      readonly kind: "failed";
      /** `open`: let through; `closed`: refused `503`. */
      readonly mode: "open" | "closed";
    }
  | {
      /** Not counted: a `local` store failed (fail open), or a read failed. */
      readonly kind: "uncounted";
    };

/** Not counted. */
const UNCOUNTED: LimitCount = Object.freeze({ kind: "uncounted" });

/** How often a store failure is logged at most. */
const WARN_EVERY_MS = 10_000;

/** The spec a throttle is built or updated with, at `quota` per window. */
function specOf(limit: CompiledLimit, quota: number) {
  return {
    limits: {
      [limit.id]: {
        limit: quota,
        window: { ms: limit.window },
        allowSubSecond: limit.window < 1000,
        cost: limit.cost,
      },
    },
  };
}

/** Where `limit` counts with `stores`: its `state`, else shared when there is a shared store. */
export function limitState(
  limit: { readonly state: StateMode | undefined },
  stores: Pick<LimitStores, "shared">,
): StateMode {
  return limit.state ?? (stores.shared === undefined ? "local" : "shared");
}

/** Builds and keeps the engine's throttles for one set of limits. */
export class Limiter {
  /** The throttles in force, by limit id. */
  #built = new Map<string, BuiltLimit>();
  /** When a store failure was last logged. */
  #lastWarn = Number.NEGATIVE_INFINITY;

  constructor(
    /** Where limits count. */
    readonly stores: LimitStores,
    /** The clock. */
    private readonly now: () => number,
    /** Where store failures are logged. */
    private readonly logger: Logger,
    /** What the limits are, for messages (`"limit"`, `"message limit"`). */
    private readonly what: string,
  ) {}

  /**
   * The throttles for `limits` under `prefix`, ready to swap in with
   * {@link commit}: built anew where a limit is new or its algorithm, state
   * or the prefix changed, otherwise the old one, updated at commit. Throws
   * bun-common's `ConfigError` (a `gcra` limit on a store without
   * `consumeGcra`; a `shared` or `hybrid` limit without that store) and
   * changes nothing.
   */
  prepare(
    limits: readonly CompiledLimit[],
    prefix: string,
    nodes: number,
  ): { readonly set: LimitSet; readonly commit: () => void } {
    const next = new Map<string, BuiltLimit>();
    const updates: (() => void)[] = [];
    for (const limit of limits) {
      const state = limitState(limit, this.stores);
      const store =
        state === "local"
          ? this.stores.local
          : state === "shared"
            ? this.stores.shared
            : this.stores.hybrid;
      if (store === undefined) {
        throw new ConfigError(
          `bun-security: ${this.what} "${limit.id}" counts in the shared store (state "${state}"), but the engine has ${state === "hybrid" && this.stores.shared !== undefined ? "no hybrid store beside it" : "none"}: give createSecurity a store, such as cacheStore(cache) from @kingsleyweb/bun-security/stores`,
          { limit: limit.id, state },
        );
      }
      const share = Math.max(1, Math.floor(limit.limit / nodes));
      const old = this.#built.get(limit.id);
      if (
        old !== undefined &&
        old.algorithm === limit.algorithm &&
        old.prefix === prefix &&
        old.state === state
      ) {
        next.set(limit.id, old);
        updates.push(() => {
          old.handler.update(specOf(limit, limit.limit));
          old.share = share;
          old.fallback?.update(specOf(limit, share));
        });
        continue;
      }
      next.set(limit.id, {
        handler: throttle({
          ...specOf(limit, limit.limit),
          store,
          prefix,
          scope: "global",
          algorithm: limit.algorithm,
          headers: false,
          failMode: state === "local" ? "open" : "closed",
          logger: this.logger,
          now: this.now,
        }),
        algorithm: limit.algorithm,
        prefix,
        state,
        fallback: undefined,
        share,
      });
    }
    return {
      set: next,
      commit: () => {
        for (const update of updates) update();
        this.#built = next;
      },
    };
  }

  /** The local-share throttle of `built`, built on first use. */
  #fallback(built: BuiltLimit, limit: CompiledLimit): ThrottleHandler {
    built.fallback ??= throttle({
      ...specOf(limit, built.share),
      store: this.stores.local,
      prefix: `${built.prefix}:local-share`,
      scope: "global",
      // The local store may lack GCRA's compare-and-set: the window then.
      algorithm:
        limit.algorithm === "gcra" &&
        this.stores.local.consumeGcra === undefined
          ? "sliding-window"
          : limit.algorithm,
      headers: false,
      failMode: "open",
      logger: this.logger,
      now: this.now,
    });
    return built.fallback;
  }

  /** Logs a store failure, at most once every 10 s. */
  #warn(limit: CompiledLimit, error: unknown): void {
    const now = this.now();
    if (now - this.#lastWarn < WARN_EVERY_MS) return;
    this.#lastWarn = now;
    this.logger.warn(
      `bun-security: the shared store failed counting ${this.what} "${limit.id}"; ${limit.onStoreError === "local" ? "counting at its local share" : limit.onStoreError === "open" ? "letting requests through (onStoreError open)" : "refusing requests (onStoreError closed)"}`,
      { error },
    );
  }

  /**
   * Counts one request under `key` against `limit` (or, with `peek`, reads
   * what it would count, consuming nothing), as {@link LimitCount} says.
   */
  count(
    built: BuiltLimit,
    limit: CompiledLimit,
    key: string,
    peek: boolean,
  ): MaybePromise<LimitCount> {
    const keys = { [limit.id]: key };
    const read = (results: ThrottleResult[]): LimitCount => {
      const result = results[0];
      return result === undefined
        ? UNCOUNTED
        : { kind: "counted", result, via: "store" };
    };
    const failed = (error: unknown): MaybePromise<LimitCount> => {
      if (built.state === "local") return UNCOUNTED;
      if (!peek) this.#warn(limit, error);
      if (limit.onStoreError !== "local") {
        return { kind: "failed", mode: limit.onStoreError };
      }
      const fallback = this.#fallback(built, limit);
      let counted: MaybePromise<ThrottleResult[]>;
      try {
        counted = peek ? fallback.peekCount(keys) : fallback.count(keys);
      } catch {
        return UNCOUNTED;
      }
      const local = (results: ThrottleResult[]): LimitCount => {
        const result = results[0];
        return result === undefined
          ? UNCOUNTED
          : { kind: "counted", result, via: "local share" };
      };
      return isThenable(counted)
        ? Promise.resolve(counted).then(local, () => UNCOUNTED)
        : local(counted);
    };
    let counted: MaybePromise<ThrottleResult[]>;
    try {
      counted = peek
        ? built.handler.peekCount(keys)
        : built.handler.count(keys);
    } catch (error) {
      return failed(error);
    }
    return isThenable(counted)
      ? Promise.resolve(counted).then(read, failed)
      : read(counted);
  }
}
