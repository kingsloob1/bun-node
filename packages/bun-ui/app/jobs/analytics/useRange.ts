import type { TimeRange } from "./range";
import { useCallback } from "react";
import { useQueryParam } from "../routing";
import { readRange, writeRange } from "./range";

/**
 * The analytics range, in the URL, so a view is shareable and survives a
 * reload. `key` names the parameter: the page-wide one is `range`, a section
 * with its own control uses its own key (`jobsRange`, …), which is what the
 * "apply to the whole page" toggle switches between.
 */
export function useRange(key: string): [TimeRange, (next: TimeRange) => void] {
  const [raw, setRaw] = useQueryParam(key);
  const set = useCallback(
    (next: TimeRange) => setRaw(writeRange(next) ?? ""),
    [setRaw],
  );
  return [readRange(raw || null), set];
}

/**
 * Whether the range control applies to the whole page (one control for every
 * section) or to each section separately. Stored in the URL as `rangeScope`,
 * so a shared link carries it; `page` is the default, since comparing
 * sections over one window is what a dashboard is for.
 */
export function useRangeScope(): [boolean, (applyToPage: boolean) => void] {
  const [raw, setRaw] = useQueryParam("rangeScope");
  const applyToPage = raw !== "section";
  const set = useCallback(
    (next: boolean) => setRaw(next ? "" : "section"),
    [setRaw],
  );
  return [applyToPage, set];
}
