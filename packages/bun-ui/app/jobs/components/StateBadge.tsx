import type { JobState } from "../api/contract";
import { STATE_HINTS, STATE_LABELS } from "../format";
import { cx } from "./classNames";

/** Props of {@link StateBadge}. */
export interface StateBadgeProps {
  /** The job state. */
  state: JobState;
  /** Extra class names. */
  className?: string;
}

/**
 * A job state, colour-coded by the `--state-*` tokens, with a tooltip where
 * the label alone could mislead ({@link STATE_HINTS}: "Retrying" is the
 * `failed` state).
 */
export function StateBadge({ state, className }: StateBadgeProps) {
  return (
    <span
      className={cx("state-badge", `state-${state}`, className)}
      title={STATE_HINTS[state]}
    >
      <span
        className="state-dot"
        aria-hidden="true"
      />
      {STATE_LABELS[state]}
    </span>
  );
}
