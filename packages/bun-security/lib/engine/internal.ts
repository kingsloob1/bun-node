/**
 * Internal facts the control plane sets on a throwaway engine (PR-CP7),
 * never part of the public API: a request's account subjects already keyed
 * (a stored event's, replayed by the impact estimate), and state to assume
 * while explaining (the test-a-request tool's "as if this address had sent
 * 299 requests"). Only `explain()` reads `assume`, and it counts the
 * assumption into the engine explaining.
 *
 * So only an engine built as a throwaway (`createSecurity` options carrying
 * {@link THROWAWAY_ENGINE}, which the control plane alone sets) takes them;
 * any other engine refuses facts carrying them with a `TypeError` before it
 * counts anything (the user's decision, 2026-11-17).
 */
import type { RequestFacts } from "./facts";

/** The key the internal facts sit under, on a facts object. */
export const INTERNAL_FACTS: unique symbol = Symbol(
  "bun-security.internalFacts",
);

/** The brand a throwaway engine is built with: an option key no public type names. */
export const THROWAWAY_ENGINE: unique symbol = Symbol(
  "bun-security.throwawayEngine",
);

/** The most a test may assume a limit has counted. */
export const MAX_ASSUMED_COUNT = 1_000_000;

/** What the control plane may set. */
export interface InternalFacts {
  /** The identity's `user`, `apiKey` and `username` are already keyed (as the engines key them): taken as they are. */
  readonly prekeyed?: boolean;
  /** State to assume while explaining. */
  readonly assume?: {
    /** Per limit id: what it has already counted for this request's key, in its current window. */
    readonly limits?: Readonly<Record<string, number>>;
    /** The client address's offence score before this request. */
    readonly score?: number;
  };
}

/** Facts carrying internal facts. */
export type WithInternal = RequestFacts & {
  /** The internal facts. */
  readonly [INTERNAL_FACTS]?: InternalFacts;
};

/** The internal facts of `facts`, if any. */
export function internalOf(facts: RequestFacts): InternalFacts | undefined {
  return (facts as WithInternal)[INTERNAL_FACTS];
}

/** `facts` with internal facts added. */
export function withInternal(
  facts: RequestFacts,
  internal: InternalFacts,
): WithInternal {
  return { ...facts, [INTERNAL_FACTS]: internal };
}
