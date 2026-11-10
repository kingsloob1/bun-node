import type { ReactNode } from "react";
import { cx } from "./classNames";

/** One row of a {@link KeyValue}. */
export interface KeyValueItem {
  /** The term, e.g. "Attempts". */
  label: ReactNode;
  /** The value: text or any node. `null`, `undefined` and `""` render the `empty` placeholder. */
  value: ReactNode;
  /** A stable React key; defaults to the label when it is a string, else the index. */
  key?: string;
  /** A short note under the value, e.g. "of 5 allowed". */
  hint?: ReactNode;
}

/** Props of {@link KeyValue}. */
export interface KeyValueProps {
  /** The rows, in order. Falsy entries are skipped, so rows can be conditional inline. */
  items: readonly (KeyValueItem | false | null | undefined)[];
  /** `"grid"` puts label and value side by side; `"stacked"` puts the label above. Defaults to `"grid"`. */
  layout?: "grid" | "stacked";
  /** What a missing value shows. Defaults to `"—"`. */
  empty?: ReactNode;
  /** Extra class names on the `<dl>`. */
  className?: string;
}

/** A summary as a definition list: label/value rows (a job's timings, a queue's settings). */
export function KeyValue({
  items,
  layout = "grid",
  empty = "—",
  className,
}: KeyValueProps) {
  return (
    <dl className={cx("kv", `kv-${layout}`, className)}>
      {items.map((item, index) => {
        if (!item) {
          return null;
        }
        const missing =
          item.value === null || item.value === undefined || item.value === "";
        // The index is only the fallback for a row with neither a key nor a
        // string label.
        const rowKey =
          item.key ??
          (typeof item.label === "string" ? item.label : `row-${index}`);
        return (
          <div
            key={rowKey}
            className="kv-row"
          >
            <dt className="kv-label">{item.label}</dt>
            <dd className={cx("kv-value", missing && "muted")}>
              {missing ? empty : item.value}
              {item.hint && <span className="kv-hint">{item.hint}</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
