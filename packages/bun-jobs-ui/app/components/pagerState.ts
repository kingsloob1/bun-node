/** The arithmetic of the `Pager`, pure. */

/** The page sizes offered by default. */
export const DEFAULT_PAGE_SIZES: readonly number[] = [10, 20, 50, 100];

/** A page position: where it starts and how many rows it holds. */
export interface PageWindow {
  /** Rows skipped. */
  offset: number;
  /** Rows per page. */
  limit: number;
}

/** Inputs of {@link pagerState}. */
export interface PagerStateInput extends PageWindow {
  /** Total rows, when the API counted them. */
  total?: number | null;
  /** Rows actually on this page; defaults to `limit` (or what is left of `total`). */
  itemCount?: number;
  /** Whether the API said there are more rows after this page (used when `total` is unknown). */
  hasMore?: boolean;
}

/** What {@link pagerState} works out. */
export interface PagerState {
  /** 1-based index of the first row shown; `0` when the page is empty. */
  from: number;
  /** 1-based index of the last row shown; `0` when the page is empty. */
  to: number;
  /** The range as text: `"1–20 of 345"`, `"1–20"` without a total, `"0 of 0"` / `"No rows"` when empty. */
  text: string;
  /** Whether there is a previous page. */
  hasPrev: boolean;
  /** Whether there is a next page. */
  hasNext: boolean;
}

/** Formats row numbers with the locale's grouping. */
const numberFormat = new Intl.NumberFormat();

/**
 * The pager's arithmetic, pure: the shown range and whether prev/next exist.
 * Without a total, "next" exists when `hasMore` says so, or (when `hasMore`
 * is not given) when the page came back full.
 */
export function pagerState({
  offset,
  limit,
  total,
  itemCount,
  hasMore,
}: PagerStateInput): PagerState {
  const known = typeof total === "number";
  const count = Math.max(
    0,
    itemCount ?? (known ? Math.min(limit, total - offset) : limit),
  );
  const from = count > 0 ? offset + 1 : 0;
  const to = count > 0 ? offset + count : 0;
  const range =
    count > 0
      ? `${numberFormat.format(from)}–${numberFormat.format(to)}`
      : known
        ? "0"
        : "No rows";
  const text = known ? `${range} of ${numberFormat.format(total)}` : range;
  const hasNext = known
    ? offset + limit < total
    : (hasMore ?? (itemCount === undefined ? false : itemCount >= limit));
  return { from, to, text, hasPrev: offset > 0, hasNext };
}

/** The page sizes to offer: the defaults up to `max`, plus the current size and `max` itself. */
export function pageSizeOptions(
  sizes: readonly number[],
  current: number,
  max?: number,
): number[] {
  const bounded = (size: number) =>
    size > 0 && (max === undefined || size <= max);
  const set = new Set(sizes.filter(bounded));
  if (bounded(current)) {
    set.add(current);
  }
  if (
    max !== undefined &&
    max > 0 &&
    (set.size === 0 || max < Math.max(...sizes))
  ) {
    set.add(max);
  }
  return [...set].sort((a, b) => a - b);
}
