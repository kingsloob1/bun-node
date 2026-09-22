import type { PromoteDelayedResult } from "./driver";

/** A `promoteDelayed` answer, read the same way whatever its shape. */
export interface PromotionRead {
  /** How many jobs moved to `waiting`. */
  promoted: number;
  /**
   * The earliest `runAt` still scheduled after the promotion, `null` when
   * none is, or `undefined` when the driver did not say — one written against
   * the older contract, which resolves the count alone. The caller then has
   * to ask `nextDelayedAt` itself.
   */
  nextDueAt: number | null | undefined;
}

/**
 * Reads a `promoteDelayed` answer: a {@link PromoteDelayedResult}, or the
 * plain count an older or custom driver resolves.
 */
export function readPromotion(
  result: number | PromoteDelayedResult,
): PromotionRead {
  if (typeof result === "number") {
    return { promoted: result, nextDueAt: undefined };
  }

  return { promoted: result.promoted, nextDueAt: result.nextDueAt };
}
