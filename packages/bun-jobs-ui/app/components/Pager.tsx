import type { PageWindow } from "./pagerState";
import { useId, useState } from "react";
import { Button } from "./Button";
import { cx } from "./classNames";
import {
  DEFAULT_PAGE_SIZES,
  formatNumber,
  PAGE_SELECT_MAX,
  pageNumbers,
  pageOffset,
  pagerState,
  pageSizeOptions,
} from "./pagerState";

/** Props of {@link Pager}. */
export interface PagerProps extends PageWindow {
  /** Total rows, when known; without it the range reads "1–20". */
  total?: number | null;
  /** Rows on the current page; improves the range on the last page. */
  itemCount?: number;
  /** Whether the API reports more rows after this page (when there is no total). */
  hasMore?: boolean;
  /** Called with the new window. Changing the size keeps the first visible row on the new page. */
  onChange: (next: PageWindow) => void;
  /** Page sizes to offer. Defaults to {@link DEFAULT_PAGE_SIZES}. */
  pageSizes?: readonly number[];
  /** The API's largest `limit` (e.g. `/meta.limits`); sizes above it are not offered. */
  maxPageSize?: number;
  /** Accessible name of the pager. Defaults to `"Pagination"`. */
  label?: string;
  /**
   * The largest page count still offered as a select of every page; above it
   * the Page control is a bounded number input. Defaults to
   * {@link PAGE_SELECT_MAX}.
   */
  pageSelectMax?: number;
  /** Disables every control, e.g. while a page loads. */
  disabled?: boolean;
  /** Extra class names. */
  className?: string;
}

/**
 * Offset/limit paging: the range, a page-size select, an exact-page control
 * and prev/next. Purely controlled.
 *
 * A pager with no total is a first-class rendering, not a degraded one: a
 * route may report `hasMore` without ever counting. Since neither a select
 * nor a bounded input can be built from an unknown number of pages, the Page
 * control is then replaced by the fact it would have shown — "Page 3", as
 * static text, and only while there is another page to go to. Nothing is
 * rendered disabled and unexplained, and prev/next and the size select stay
 * exactly as usable as they are with a total.
 */
export function Pager({
  offset,
  limit,
  total,
  itemCount,
  hasMore,
  onChange,
  pageSizes = DEFAULT_PAGE_SIZES,
  maxPageSize,
  label = "Pagination",
  pageSelectMax = PAGE_SELECT_MAX,
  disabled = false,
  className,
}: PagerProps) {
  const sizeId = useId();
  const pageId = useId();
  const countId = useId();
  const state = pagerState({ offset, limit, total, itemCount, hasMore });
  const sizes = pageSizeOptions(pageSizes, limit, maxPageSize);
  /**
   * What is typed in the page input before it is committed, and the page it
   * was typed on; `null` shows the current page. Remembering the page keeps a
   * stale draft from outliving a move made elsewhere in the pager — press
   * Next mid-type and the box shows where you now are, not what you typed.
   */
  const [draft, setDraft] = useState<{
    /** The page it was typed on; a move away from that page discards it. */
    page: number;
    /** Exactly what is in the box, including `""` and out-of-range numbers. */
    value: string;
  } | null>(null);
  const { page, pageCount } = state;
  /** The page input's value: the live draft, else the page we are on. */
  const typed = draft !== null && draft.page === page ? draft.value : null;
  /** Moves to the typed/picked page, if it is a page and not the current one. */
  const goToPage = (value: string) => {
    setDraft(null);
    if (pageCount === null) {
      return;
    }
    const wanted = Number.parseInt(value, 10);
    if (!Number.isFinite(wanted)) {
      return;
    }
    const next = pageOffset(wanted, limit, pageCount);
    if (next !== offset) {
      onChange({ offset: next, limit });
    }
  };
  return (
    <nav
      className={cx("pager", className)}
      aria-label={label}
    >
      <span
        className="pager-range"
        aria-live="polite"
      >
        {state.text}
      </span>
      <span className="pager-size">
        <label htmlFor={sizeId}>Rows per page</label>
        <select
          id={sizeId}
          className="input select pager-select"
          value={limit}
          disabled={disabled}
          onChange={(event) => {
            const next = Number(event.target.value);
            onChange({ offset: Math.floor(offset / next) * next, limit: next });
          }}
        >
          {sizes.map((size) => (
            <option
              key={size}
              value={size}
            >
              {size}
            </option>
          ))}
        </select>
      </span>
      {pageCount === null ? (
        // No total, no page count, so nothing to pick from: say where we are
        // instead, and only while there is somewhere else to be.
        (state.hasPrev || state.hasNext) && (
          <span className="pager-page pager-page-static">
            {`Page ${formatNumber(page)}`}
          </span>
        )
      ) : (
        <span className="pager-page">
          <label htmlFor={pageId}>Page</label>
          {pageCount <= pageSelectMax ? (
            <select
              id={pageId}
              className="input select pager-select"
              value={page}
              disabled={disabled}
              aria-describedby={countId}
              onChange={(event) => goToPage(event.target.value)}
            >
              {pageNumbers(pageCount).map((number) => (
                <option
                  key={number}
                  value={number}
                >
                  {number}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={pageId}
              className="input pager-select pager-page-input"
              type="number"
              inputMode="numeric"
              min={1}
              max={pageCount}
              step={1}
              value={typed ?? String(page)}
              disabled={disabled}
              aria-describedby={countId}
              onChange={(event) =>
                setDraft({ page, value: event.target.value })
              }
              onBlur={(event) => goToPage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  goToPage(event.currentTarget.value);
                }
              }}
            />
          )}
          <span
            className="pager-page-count"
            id={countId}
          >
            {`of ${formatNumber(pageCount)}`}
          </span>
        </span>
      )}
      <span className="pager-buttons">
        <Button
          size="sm"
          disabled={disabled || !state.hasPrev}
          onClick={() =>
            onChange({ offset: Math.max(0, offset - limit), limit })
          }
        >
          Previous
        </Button>
        <Button
          size="sm"
          disabled={disabled || !state.hasNext}
          onClick={() => onChange({ offset: offset + limit, limit })}
        >
          Next
        </Button>
      </span>
    </nav>
  );
}
