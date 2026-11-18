import type { ReactNode } from "react";
import { cx } from "./classNames";

/** Props of {@link Table}. */
export interface TableProps {
  /** Accessible name of the table (rendered as a visually hidden caption). */
  label: string;
  /** Extra class names on the `<table>`. */
  className?: string;
  /** The `<table>`'s `data-testid`, for tests. */
  testId?: string;
  /** `<thead>` / `<tbody>`. */
  children: ReactNode;
}

/**
 * A table in a scrollable, focusable region with a sticky header. Keyboard
 * users can scroll a wide table because the region is tabbable.
 */
export function Table({ label, className, testId, children }: TableProps) {
  return (
    <div
      className="table-wrap"
      role="region"
      aria-label={label}
      // A scrollable region must be reachable by keyboard.
      tabIndex={0}
    >
      <table
        className={cx("table", className)}
        {...(testId === undefined ? {} : { "data-testid": testId })}
      >
        <caption className="visually-hidden">{label}</caption>
        {children}
      </table>
    </div>
  );
}
