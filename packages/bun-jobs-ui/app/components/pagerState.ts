/** The arithmetic of the `Pager`, pure. */

/** The page sizes offered by default. */
export const DEFAULT_PAGE_SIZES: readonly number[] = [10, 20, 50, 100];

/**
 * The largest page count still offered as a `<select>` of every page.
 * Beyond it the pager shows a bounded number input instead: a thousand-option
 * listbox is slow to build and impossible to scan, and typing "437" beats
 * scrolling to it.
 */
export const PAGE_SELECT_MAX = 100;

/** A page position: where it starts and how many rows it holds. */
export interface PageWindow {
  /** Rows skipped. */
  offset: number;
  /** Rows per page. */
  limit: number;
}

/**
 * One move a `Pager` asks for: the window it wants, and how it was made.
 *
 * The extra fields exist for a list paged by **cursor**, where Previous and
 * Next walk rather than count. A pager without
 * {@link PagerWalk} never sets either, so a caller that reads
 * `offset` and `limit` alone — every list but the queue's jobs — sees exactly
 * what it saw before.
 */
export interface PageMove extends PageWindow {
  /**
   * Set when Previous or Next moved a **walked** list. The caller follows its
   * walk's cursor; `offset` then repeats the offset the pager was given
   * (there is no new one to report, and on a page whose backend did not count
   * what precedes it there is no old one either — it is `0`).
   */
  step?: "next" | "prev";
  /**
   * Whether only the page size changed. A walked list keeps its cursor for
   * one of these, so the page it re-reads starts at the row it starts at now;
   * `offset`/`limit` are the window a list paged by offset should move to.
   */
  resize?: boolean;
}

/**
 * Cursor navigation for a `Pager`: what it may walk, and whether this page
 * knows where it sits. Omitted by every list that pages by offset alone.
 */
export interface PagerWalk {
  /**
   * Whether Next can walk on — the API minted a cursor for the page after
   * this one (`page.next`). When it is false Next still moves by offset if
   * there is a next page, which is what a list the API refuses to walk (the
   * Active tab) falls back to.
   */
  canNext: boolean;
  /** Whether Previous can walk back to a page this walk has already shown. */
  canPrev: boolean;
  /**
   * Whether this page's row numbers are unknown: a walked page whose backend
   * did not count what precedes it (`page.offset` absent — SQL and MongoDB,
   * deliberately). The range then counts the rows shown rather than
   * numbering them, and no page number is offered, because nothing here knows
   * which page this is. Defaults to `false`.
   */
  unnumbered?: boolean;
  /**
   * A sentence explaining what walking this list does and does not show,
   * put on Previous and Next while they walk. Omit it for no tooltip.
   */
  hint?: string;
}

/** Inputs of {@link pagerState}. */
export interface PagerStateInput extends PageWindow {
  /** Total rows, when the API counted them. */
  total?: number | null;
  /** Rows actually on this page; defaults to `limit` (or what is left of `total`). */
  itemCount?: number;
  /** Whether the API said there are more rows after this page (used when `total` is unknown). */
  hasMore?: boolean;
  /**
   * Whether this page's row numbers are unknown ({@link PagerWalk.unnumbered}):
   * the range counts the rows instead of numbering them, `from`/`to` are `0`,
   * and there is no page count. Defaults to `false`.
   */
  unnumbered?: boolean;
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
  /**
   * 1-based number of the page shown. Clamped into `1…pageCount` when the
   * total is known, so an offset past the end reads as the last page rather
   * than as a page that does not exist.
   */
  page: number;
  /**
   * How many pages there are, or `null` when the total is unknown — then
   * nothing can say how many pages follow this one. An empty result is one
   * (empty) page, never zero.
   */
  pageCount: number | null;
}

/** Formats row numbers with the locale's grouping. */
const numberFormat = new Intl.NumberFormat();

/** Formats a count with the locale's grouping, as the range text does. */
export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

/**
 * The pager's arithmetic, pure: the shown range and whether prev/next exist.
 * Without a total, "next" exists when `hasMore` says so, or (when `hasMore`
 * is not given) when the page came back full.
 *
 * With `unnumbered` the range counts the rows rather than numbering them,
 * since nothing knows where the page sits: "1–20" would be a guess, and a
 * guess that reads like a fact is worse than a count.
 */
export function pagerState({
  offset,
  limit,
  total,
  itemCount,
  hasMore,
  unnumbered,
}: PagerStateInput): PagerState {
  const known = typeof total === "number";
  if (unnumbered === true) {
    const shown = Math.max(0, itemCount ?? limit);
    const rows = `${numberFormat.format(shown)} ${shown === 1 ? "row" : "rows"}`;
    return {
      from: 0,
      to: 0,
      text:
        shown === 0
          ? known
            ? `No rows of ${numberFormat.format(total)}`
            : "No rows"
          : known
            ? `${rows} of ${numberFormat.format(total)}`
            : rows,
      // Where the page sits is unknown, so an offset step back is not a move
      // anything here can work out: only the walk can go back.
      hasPrev: false,
      hasNext: hasMore ?? shown >= limit,
      page: 1,
      pageCount: null,
    };
  }
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
  const pageCount =
    known && limit > 0 ? Math.max(1, Math.ceil(total / limit)) : null;
  const onPage = limit > 0 ? Math.floor(offset / limit) + 1 : 1;
  const page = Math.max(1, Math.min(onPage, pageCount ?? onPage));
  return { from, to, text, hasPrev: offset > 0, hasNext, page, pageCount };
}

/**
 * The offset of a 1-based page, clamped into `1…pageCount` when one is given
 * — the inverse of {@link PagerState.page}, and pure.
 */
export function pageOffset(
  page: number,
  limit: number,
  pageCount?: number | null,
): number {
  const last =
    typeof pageCount === "number" && pageCount > 0
      ? pageCount
      : Number.POSITIVE_INFINITY;
  const wanted = Math.floor(page);
  const clamped = Math.min(
    Math.max(Number.isFinite(wanted) ? wanted : 1, 1),
    last,
  );
  return (clamped - 1) * Math.max(0, limit);
}

/** Every page number, `1…pageCount`, for a select listing them all. */
export function pageNumbers(pageCount: number): number[] {
  const count = Number.isFinite(pageCount)
    ? Math.max(0, Math.floor(pageCount))
    : 0;
  return Array.from({ length: count }, (_unused, index) => index + 1);
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
