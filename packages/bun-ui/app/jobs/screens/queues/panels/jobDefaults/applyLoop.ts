import type { ApplyJobDefaultsResultDto } from "../../../../api/types";

/**
 * The client side of `POST /queues/:queue/job-defaults/apply`: one call
 * examines at most `limit` jobs and answers a cursor (`next`), so rewriting a
 * backlog is a loop of calls until `done`. It stops early when asked to
 * (Cancel, checked between batches: a batch already sent completes on the
 * server either way), and on the first failure, keeping what was done and the
 * cursor to resume from.
 */

/** What a walk did so far, summed over its batches. */
export interface ApplyTotals {
  /** Jobs looked at. */
  examined: number;
  /** Jobs at least one of whose options changed (or would, in a dry run). */
  rewritten: number;
  /** Jobs that already had every value. */
  unchanged: number;
  /** Jobs left alone because every changing key was passed explicitly on their `add()`. */
  skippedExplicit: number;
  /** Jobs added before bun-jobs recorded which options were explicit, left alone. */
  skippedUnmarked: number;
  /** Jobs that left the walked states before their write (a lower bound). */
  moved: number;
  /** Rewritten jobs whose attempts made already reach the new `attempts`: each gets one final attempt. Part of `rewritten`. */
  exhausted: number;
  /** Calls answered. */
  batches: number;
}

/** Totals before the first batch. */
export function emptyTotals(): ApplyTotals {
  return {
    examined: 0,
    rewritten: 0,
    unchanged: 0,
    skippedExplicit: 0,
    skippedUnmarked: 0,
    moved: 0,
    exhausted: 0,
    batches: 0,
  };
}

/** Totals with one more batch's answer added. */
export function addBatch(
  totals: ApplyTotals,
  result: ApplyJobDefaultsResultDto,
): ApplyTotals {
  return {
    examined: totals.examined + result.examined,
    rewritten: totals.rewritten + result.rewritten,
    unchanged: totals.unchanged + result.unchanged,
    skippedExplicit: totals.skippedExplicit + result.skippedExplicit,
    skippedUnmarked: totals.skippedUnmarked + result.skippedUnmarked,
    moved: totals.moved + result.moved,
    exhausted: totals.exhausted + result.exhausted,
    batches: totals.batches + 1,
  };
}

/** How a walk ended. */
export type ApplyOutcome =
  | {
      /** Every batch answered; the walk is complete. */
      status: "done";
      /** What it did. */
      totals: ApplyTotals;
    }
  | {
      /** Stopped between batches because the user asked. */
      status: "cancelled";
      /** What it did before stopping. */
      totals: ApplyTotals;
      /** Where a later walk would continue. */
      cursor: string;
    }
  | {
      /** A call failed. */
      status: "failed";
      /** What it did before the failure. */
      totals: ApplyTotals;
      /** The cursor the failed call was sent with (`undefined` for the first), to resume from. */
      cursor: string | undefined;
      /** The failure, usually an `ApiError`. */
      error: unknown;
    };

/** Options of {@link runApplyLoop}. */
export interface RunApplyLoopOptions {
  /** Sends one call, continuing from `cursor` (`undefined` for the first). */
  request: (cursor: string | undefined) => Promise<ApplyJobDefaultsResultDto>;
  /** The cursor to start from, to resume a stopped walk. Defaults to the start. */
  cursor?: string;
  /** Totals to add to, when resuming. Defaults to {@link emptyTotals}. */
  totals?: ApplyTotals;
  /** Called after each batch with the running totals. */
  onBatch?: (totals: ApplyTotals, result: ApplyJobDefaultsResultDto) => void;
  /** Asked before each call after the first: `true` stops the walk there. */
  shouldStop: () => boolean;
}

/**
 * Calls `request` repeatedly, `cursor` → `next`, until an answer is `done`,
 * `shouldStop()` says so between batches, or a call fails. Never throws: a
 * failure is an outcome carrying the totals so far. An answer that is not
 * done but repeats the cursor it was sent (the walk would never end) is a
 * failure too.
 */
export async function runApplyLoop(
  options: RunApplyLoopOptions,
): Promise<ApplyOutcome> {
  let cursor = options.cursor;
  let totals = options.totals ?? emptyTotals();
  let first = true;
  for (;;) {
    if (!first && cursor !== undefined && options.shouldStop()) {
      return { status: "cancelled", totals, cursor };
    }
    first = false;
    let result: ApplyJobDefaultsResultDto;
    try {
      result = await options.request(cursor);
    } catch (error) {
      return { status: "failed", totals, cursor, error };
    }
    totals = addBatch(totals, result);
    options.onBatch?.(totals, result);
    if (result.done || result.next === null) {
      return { status: "done", totals };
    }
    if (result.next === cursor) {
      return {
        status: "failed",
        totals,
        cursor,
        error: new Error(
          "The API answered the same cursor it was sent, so the walk would never end.",
        ),
      };
    }
    cursor = result.next;
  }
}
