/** What every analytics panel reads for: the scope and the range on screen. */
import type { AnalyticsRange } from "./range";
import { createContext, use } from "react";

/** The page's scope and range. */
export interface AnalyticsView {
  /** The scope. */
  readonly scope: string;
  /** The range. */
  readonly range: AnalyticsRange;
}

/** The page's view (set by the analytics screen). */
export const AnalyticsViewContext = createContext<AnalyticsView | null>(null);

/** The page's view; a panel outside the page is a bug. */
export function useAnalyticsView(): AnalyticsView {
  const view = use(AnalyticsViewContext);
  if (view === null)
    throw new Error("an analytics panel outside the analytics page");
  return view;
}
