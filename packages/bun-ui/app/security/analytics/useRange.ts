/** The analytics page's range in the URL (`?range=`), beside the scope. */
import type { AnalyticsRange } from "./range";
import { useCallback, useMemo } from "react";
import { useRouter } from "../routing";
import { ANALYTICS_RANGE } from "./range";

/** The URL parameter. */
export const RANGE_PARAM = "range";

/** The range on screen, and how to change it. */
export function useRange(): {
  readonly range: AnalyticsRange;
  readonly setRange: (range: AnalyticsRange) => void;
} {
  const { location, navigate } = useRouter();
  const raw = new URLSearchParams(location.search).get(RANGE_PARAM);
  const range = useMemo(() => ANALYTICS_RANGE.readRange(raw), [raw]);
  const setRange = useCallback(
    (next: AnalyticsRange) => {
      const params = new URLSearchParams(location.search);
      const written = ANALYTICS_RANGE.writeRange(next);
      if (written === null) params.delete(RANGE_PARAM);
      else params.set(RANGE_PARAM, written);
      const query = params.toString();
      navigate(`${location.path ?? "/"}${query === "" ? "" : `?${query}`}`);
    },
    [location.path, location.search, navigate],
  );
  return { range, setRange };
}
