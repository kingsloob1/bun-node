/**
 * Layer L9 on the throttle foundation (layers.md L9.1): bun-security ships
 * no rate limiter of its own. Each limit of the policy is a bun-common
 * `throttle()` with that one named limit, over the engine's one
 * `ThrottleStore`; the engine decides which limits apply to a request and
 * under which key, and the throttle counts it — its algorithms, its window
 * placement, its store calls, its fail-open on a store error.
 *
 * A new policy reuses the throttle of a limit whose id and algorithm are
 * unchanged, through `ThrottleHandler.update()` (the run-time update plan
 * §20.2 asked the foundation for), so its counts carry over while its window
 * stays the same; `explain()` reads through `peek()`, which consumes nothing.
 *
 * The throttle is a bun-common middleware, `(req, res, next)`, and the
 * engine decides from facts, not from a `BunRequest` (a plain `Bun.serve`
 * has none). So it is called with a stand-in request: an empty object whose
 * key the limit's `key` function looks up in a `WeakMap`, as bun-nest's
 * throttler guard does with real requests, and a stand-in response that says
 * its headers are sent, so the throttle sets none. The throttle reads
 * nothing else from either with `headers: false`, `scope: "global"`, no
 * `skip` and no refunds (bun-common `lib/throttle.ts`, `situate` and
 * `conclude`); `__tests__/engine/limits.test.ts` pins that down. A
 * request-free entry into the foundation's counting would remove the
 * stand-ins: kingsloob1/bun-node#791.
 */
import { getThrottleResults, throttle } from "@kingsleyweb/bun-common";
import type {
  BunRequest,
  BunResponse,
  Logger,
  ThrottleHandler,
  ThrottleResult,
  ThrottleStore,
} from "@kingsleyweb/bun-common";
import type { CompiledLimit } from "../policy/compile";
import { isThenable } from "./maybe";
import type { MaybePromise } from "./maybe";

/** Each stand-in request's key. */
const KEYS = new WeakMap<object, string>();

/** The stand-in response: its headers already sent, so the throttle sets none. */
const RESPONSE: Pick<BunResponse, "headersSent"> = Object.freeze({
  headersSent: true,
});

/** The limit's `key`: the one the engine put beside the stand-in. */
function standInKey(req: object): string {
  return KEYS.get(req) ?? "";
}

/** The throttle's `onLimited` and `next`: the engine reads the results itself. */
function ignore(): undefined {
  return undefined;
}

/**
 * The stand-in, typed as what the throttle's signature names. The throttle
 * only keys `WeakMap`s with it and reads `route` (absent), see above.
 */
function asRequest(standIn: object): BunRequest {
  return standIn as BunRequest;
}

/** The stand-in response, typed as the throttle's signature names it. */
function asResponse(standIn: Pick<BunResponse, "headersSent">): BunResponse {
  return standIn as BunResponse;
}

/** One limit's throttle, and the shape it was built for. */
interface Built {
  /** The throttle. */
  readonly handler: ThrottleHandler;
  /** The algorithm it was built with (fixed for a throttle's life). */
  readonly algorithm: CompiledLimit["algorithm"];
  /** The key prefix it was built with. */
  readonly prefix: string;
}

/** The throttles of one policy, by limit id. */
export type LimitSet = ReadonlyMap<string, ThrottleHandler>;

/** The spec a throttle is built or updated with. */
function specOf(limit: CompiledLimit) {
  return {
    limits: {
      [limit.id]: {
        limit: limit.limit,
        window: { ms: limit.window },
        allowSubSecond: limit.window < 1000,
        key: standInKey,
        cost: limit.cost,
      },
    },
  };
}

/** Builds and keeps the engine's throttles. */
export class Limiter {
  /** The throttles in force, by limit id. */
  #built = new Map<string, Built>();

  constructor(
    /** Where every limit counts. */
    readonly store: ThrottleStore,
    /** The clock. */
    private readonly now: () => number,
    /** Where the throttles log a store failure. */
    private readonly logger: Logger,
  ) {}

  /**
   * The throttles for `limits` under `prefix`, ready to swap in with
   * {@link commit}: built anew where a limit is new, its algorithm changed or
   * the prefix moved, otherwise the old one, updated at commit. Throws the
   * throttle's `ConfigError` (a `gcra` limit on a store without
   * `consumeGcra`) and changes nothing.
   */
  prepare(
    limits: readonly CompiledLimit[],
    prefix: string,
  ): { readonly set: LimitSet; readonly commit: () => void } {
    const next = new Map<string, Built>();
    const updates: (() => void)[] = [];
    for (const limit of limits) {
      const old = this.#built.get(limit.id);
      if (
        old !== undefined &&
        old.algorithm === limit.algorithm &&
        old.prefix === prefix
      ) {
        next.set(limit.id, old);
        updates.push(() => old.handler.update(specOf(limit)));
        continue;
      }
      next.set(limit.id, {
        handler: throttle({
          ...specOf(limit),
          store: this.store,
          prefix,
          scope: "global",
          algorithm: limit.algorithm,
          headers: false,
          failMode: "open",
          logger: this.logger,
          onLimited: ignore,
          now: this.now,
        }),
        algorithm: limit.algorithm,
        prefix,
      });
    }
    const set = new Map<string, ThrottleHandler>();
    for (const [id, built] of next) set.set(id, built.handler);
    return {
      set,
      commit: () => {
        for (const update of updates) update();
        this.#built = next;
      },
    };
  }

  /**
   * Counts one request under `key` against `handler`'s limit (or, with
   * `peek`, reads what it would count, consuming nothing): its result, or
   * `undefined` when the store failed and the throttle let the request
   * through (it logs that). A failing peek rejects.
   */
  count(
    handler: ThrottleHandler,
    key: string,
    peek: boolean,
  ): MaybePromise<ThrottleResult | undefined> {
    const standIn = {};
    KEYS.set(standIn, key);
    const req = asRequest(standIn);
    if (peek) {
      const peeked = handler.peek(req);
      return isThenable(peeked)
        ? Promise.resolve(peeked).then((results) => results[0])
        : peeked[0];
    }
    const outcome: unknown = handler(req, asResponse(RESPONSE), ignore);
    if (isThenable(outcome)) {
      return Promise.resolve(outcome).then(() => getThrottleResults(req)?.[0]);
    }
    return getThrottleResults(req)?.[0];
  }
}
