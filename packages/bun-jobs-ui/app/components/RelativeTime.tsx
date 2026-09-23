import { useNow } from "../hooks/useNow";
import { cx } from "./classNames";
import { formatRelativeTime, toEpochMs } from "./formatRelative";

/** Props of {@link RelativeTime}. */
export interface RelativeTimeProps {
  /** The instant: epoch ms, an ISO string or a `Date`. `null`/`undefined` (or invalid) renders "—". */
  value: number | string | Date | null | undefined;
  /** What to render for a missing value. Defaults to `"—"`. */
  fallback?: string;
  /** Extra class names. */
  className?: string;
  /**
   * A note appended to the `<time>`'s tooltip, on its own line under the
   * absolute instant — so a caller can explain the instant without taking
   * the tooltip away from it. Absent leaves the tooltip the instant alone,
   * and it is ignored for a missing value (there is no `<time>` then).
   */
  hint?: string;
}

/**
 * "3m ago" / "in 2h", kept current by the one shared clock (`useNow`),
 * inside a `<time>` whose `dateTime` and `title` carry the absolute ISO
 * instant, so hovering shows exactly when.
 */
export function RelativeTime({
  value,
  fallback = "—",
  className,
  hint,
}: RelativeTimeProps) {
  const ms = toEpochMs(value);
  if (ms === null) {
    return <span className={cx("relative-time", className)}>{fallback}</span>;
  }
  return (
    <TickingTime
      ms={ms}
      className={className}
      hint={hint}
    />
  );
}

/** Props of {@link TickingTime}. */
interface TickingTimeProps {
  /** The instant, epoch ms. */
  ms: number;
  /** Extra class names. */
  className?: string;
  /** A note under the instant in the tooltip. See {@link RelativeTimeProps.hint}. */
  hint?: string;
}

/** The subscribed part, so a missing value never joins the clock. */
function TickingTime({ ms, className, hint }: TickingTimeProps) {
  const now = useNow();
  const iso = new Date(ms).toISOString();
  return (
    <time
      className={cx("relative-time", className)}
      dateTime={iso}
      title={hint === undefined ? iso : `${iso}\n${hint}`}
    >
      {formatRelativeTime(ms, now)}
    </time>
  );
}
