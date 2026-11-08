import type { TimeRange } from "../analytics/range";
import type { ApiClient } from "./client";
import type { AddedByStateDto } from "./types";
import { rangeBounds } from "../analytics/range";

/**
 * `GET /overview/added`: of the jobs added during a range, how many are in
 * each state now. Served only where `meta.features.addedByState` is `true`;
 * nothing here may be called otherwise (the route does not exist there).
 *
 * Imported only by the Overview's lazy added-by-state group, so none of it
 * reaches the entry bundle.
 */

/** How often the group re-reads: it counts job records, so far slower than the Overview's 5 s (the contract asks for 15–30 s). */
export const ADDED_BY_STATE_POLL_MS = 20_000;

/**
 * The `from`/`to` one read sends: the range resolved against `now`.
 *
 * Sent as is. The API refuses a span over `MAX_ADDED_BY_STATE_SPAN_MS`, and no
 * range the app can hold is longer: the range model caps every span at
 * `MAX_RANGE_MS`, which is not above it (`addedByState.test.ts` holds that,
 * so a contract change that splits the two fails there, not in a user's
 * Overview).
 */
export function addedByStateRequest(
  range: TimeRange,
  now = Date.now(),
): {
  /** Start, epoch ms, inclusive. */
  from: number;
  /** End, epoch ms, exclusive. */
  to: number;
} {
  return rangeBounds(range, now);
}

/**
 * The query key of one read. A preset is keyed by its length, a custom range
 * by its instants — as the analytics keys are — so a rolling window is one
 * entry that refetches. Deliberately not under `["overview"]`: the live
 * updates invalidate that prefix on every job event, which would turn this
 * slow poll into one read per event.
 */
export function addedByStateKey(range: TimeRange) {
  return [
    "addedByState",
    range.kind === "preset"
      ? { seconds: range.seconds }
      : { from: range.from, to: range.to },
  ] as const;
}

/** `GET /overview/added?from&to`, summed over every queue the caller may see. */
export function getAddedByState(
  api: ApiClient,
  range: TimeRange,
  signal?: AbortSignal,
): Promise<AddedByStateDto> {
  const { from, to } = addedByStateRequest(range);
  return api.request("GET", "/overview/added", {
    query: { from, to },
    signal,
  });
}
