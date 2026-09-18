import { cx } from "./classNames";

/** Props of {@link Spinner}. */
export interface SpinnerProps {
  /** What is loading; read by screen readers. Defaults to `"Loading"`. */
  label?: string;
  /** Show the label next to the spinner. Defaults to `false` (screen readers only). */
  showLabel?: boolean;
  /** Extra class names. */
  className?: string;
}

/** A loading indicator with a live `status` role. */
export function Spinner({
  label = "Loading",
  showLabel = false,
  className,
}: SpinnerProps) {
  return (
    <span
      className={cx("spinner-wrap", className)}
      role="status"
    >
      <span
        className="spinner"
        aria-hidden="true"
      />
      <span className={showLabel ? "spinner-label" : "visually-hidden"}>
        {label}
      </span>
    </span>
  );
}
