import type { AnalyticsRequest, RangeKey } from "../api/analytics";
import type { MetaAnalyticsDto } from "../api/types";
import type { TimeRange } from "./range";
import {
  analyticsRequest,
  rangeKey,
  requestResolution,
} from "../api/analytics";
import { useMeta } from "../meta/hooks";

/** What {@link useAnalyticsRange} gives a section. */
export interface AnalyticsRangeState {
  /**
   * What this deployment can serve (`meta.analytics`), or `null` when it
   * records nothing — in which case every analytics route is pruned and a
   * section must not read.
   */
  analytics: MetaAnalyticsDto | null;
  /**
   * The key fragment this range caches under. It holds the range's identity
   * (a preset's length, or a custom range's two instants) and the resolution
   * asked for — never the instants a rolling preset happens to resolve to,
   * which would mint a fresh cache entry every bucket. Query keys are hashed
   * structurally, so it need not be referentially stable.
   */
  key: RangeKey;
  /**
   * The request, resolved against the clock **at call time**. Call it inside a
   * query function, never to build a key: a rolling preset must cover a fresh
   * window on every fetch.
   */
  request: () => AnalyticsRequest;
}

/**
 * Turns the range a section shows into the request it sends and the key it
 * caches under, and says what `/meta` reports this deployment can serve.
 *
 * The resolution sent is the one the range wants, whatever the deployment
 * keeps (see `requestResolution`); what was actually **served** comes back in
 * the response's `range.resolution`, with `clamped`/`reason` when it differs,
 * and that is what a caption and an axis are written from.
 */
export function useAnalyticsRange(range: TimeRange): AnalyticsRangeState {
  const analytics = useMeta().analytics ?? null;
  return {
    analytics,
    key: rangeKey(range, requestResolution(range)),
    request: () => analyticsRequest(range),
  };
}
