import type { ReactNode } from "react";
import { cx } from "../../components/classNames";
import "./logs.css";

/**
 * The scrolling monospace line list both log views draw with: a job's logs
 * (plain strings, paged) and a run's captured output (structured lines,
 * tailed). Only the presentation is shared — what a line *is*, and how it is
 * fetched, differs too much to share more.
 */

/** One line, as the list renders it. */
export interface LogLineView {
  /** Identity of the line: a job log's line number, a run log's `seq`. */
  id: string | number;
  /** The number shown in the gutter; omitted for no gutter. */
  number?: number;
  /** The line's text, rendered verbatim (whitespace preserved). */
  text: string;
  /** Shown between the gutter and the text: a run line's time, stream and level. */
  prefix?: ReactNode;
  /** Shown after the text: a marker that capture cut the line, say. */
  suffix?: ReactNode;
  /** Extra class names on the line. */
  className?: string;
}

/** Props of {@link LogLines}. */
export interface LogLinesProps {
  /** Accessible name of the list. */
  label: string;
  /** The lines, in the order they are shown. */
  items: readonly LogLineView[];
  /** Extra class names on the list. */
  className?: string;
}

/** An ordered list of log lines in a fixed-height scroll box. */
export function LogLines({ label, items, className }: LogLinesProps) {
  return (
    <ol
      className={cx("log-lines", className)}
      aria-label={label}
    >
      {items.map((line) => (
        <li
          key={line.id}
          className={cx("log-line", line.className)}
        >
          {line.number !== undefined && (
            <span
              className="log-number"
              aria-hidden="true"
            >
              {line.number}
            </span>
          )}
          {line.prefix}
          <code className="log-text">{line.text}</code>
          {line.suffix}
        </li>
      ))}
    </ol>
  );
}
