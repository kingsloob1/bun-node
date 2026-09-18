import type { PageWindow } from "./pagerState";
import { useId } from "react";
import { Button } from "./Button";
import { cx } from "./classNames";
import { DEFAULT_PAGE_SIZES, pagerState, pageSizeOptions } from "./pagerState";

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
  /** Disables every control, e.g. while a page loads. */
  disabled?: boolean;
  /** Extra class names. */
  className?: string;
}

/** Offset/limit paging: the range, prev/next, and a page-size select. Purely controlled. */
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
  disabled = false,
  className,
}: PagerProps) {
  const sizeId = useId();
  const state = pagerState({ offset, limit, total, itemCount, hasMore });
  const sizes = pageSizeOptions(pageSizes, limit, maxPageSize);
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
