import type { PageWindow } from "./pagerState";
import { useState } from "react";

/**
 * Paging a table whose rows are already in the browser.
 *
 * Several screens read a whole list in one request — the Overview's queues,
 * the live workers, the runners, a queue's repeat series — and a table of a
 * few hundred rows is unreadable however it was fetched. These cut that list
 * into pages without re-reading anything, so what a screen fetches, polls and
 * is allowed to see is unchanged.
 *
 * The arithmetic is here, once, so a screen keeping its window in the URL
 * ({@link clientWindow}) and one keeping it in component state
 * ({@link useClientPage}) clamp and hide the pager the same way.
 */

/** The window a table actually shows, and whether it is worth a pager. */
export interface ClientWindow extends PageWindow {
  /**
   * Whether the rows outnumber one page, and so a pager belongs on the table.
   * A table that fits one page must not grow prev/next, a page select and a
   * size select that change nothing.
   */
  paged: boolean;
}

/**
 * The window to show: the one asked for, clamped to the rows there are now,
 * and moved to hold a pinned row.
 *
 * Clamping matters because these lists poll: rows go while the reader is on
 * the last page, and an unclamped window would show an empty table with no
 * hint that anything is left. It lands on the **last page with rows** rather
 * than the first, so a shrinking list keeps the reader where they were.
 *
 * @param total The rows the page is cut from.
 * @param window The window asked for (from the URL, or component state).
 * @param pinnedIndex The index of a row that must be on the page whatever page
 * was chosen — a row the URL addresses, such as the run whose log is open.
 * `-1` (the default) pins nothing.
 */
export function clientWindow(
  total: number,
  window: PageWindow,
  pinnedIndex = -1,
): ClientWindow {
  const limit = Math.max(1, Math.floor(window.limit));
  const lastStart = Math.max(0, Math.ceil(total / limit) - 1) * limit;
  const chosen = Math.min(Math.max(0, Math.floor(window.offset)), lastStart);
  const pinned =
    pinnedIndex >= 0 &&
    pinnedIndex < total &&
    (pinnedIndex < chosen || pinnedIndex >= chosen + limit);
  return {
    offset: pinned ? Math.floor(pinnedIndex / limit) * limit : chosen,
    limit,
    paged: total > limit,
  };
}

/** A page of rows, and what a `Pager` over them needs. */
export interface ClientPage<T> extends ClientWindow {
  /** The rows on the page, cut from the rows passed in. */
  rows: T[];
  /** Every row the page was cut from, which the pager shows as "of N". */
  total: number;
  /** Takes the window a `Pager` asks for. */
  onChange: (next: PageWindow) => void;
}

/**
 * A page of rows kept in component state, with the pager's window clamped by
 * {@link clientWindow}.
 *
 * @param rows Every row, already filtered and ordered as the table shows them.
 * @param defaultSize Rows per page to start with, or `null` for no paging at
 * all: every row on one page, and `paged` false. (`null` is for a shared table
 * whose callers opt in — see `WorkerTable`.)
 * @param pinnedIndex A row that must be on the page, as {@link clientWindow}.
 */
export function useClientPage<T>(
  rows: readonly T[],
  defaultSize: number | null,
  pinnedIndex = -1,
): ClientPage<T> {
  const [asked, setAsked] = useState<PageWindow>(() => ({
    offset: 0,
    limit: Math.max(1, defaultSize ?? 1),
  }));
  const total = rows.length;
  if (defaultSize === null) {
    return {
      rows: [...rows],
      offset: 0,
      limit: Math.max(1, total),
      total,
      paged: false,
      onChange: setAsked,
    };
  }
  const window = clientWindow(total, asked, pinnedIndex);
  return {
    rows: rows.slice(window.offset, window.offset + window.limit),
    ...window,
    total,
    onChange: setAsked,
  };
}
