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
}: RelativeTimeProps) {
  const ms = toEpochMs(value);
  if (ms === null) {
    return <span className={cx("relative-time", className)}>{fallback}</span>;
  }
  return (
    <TickingTime
      ms={ms}
      className={className}
    />
  );
}

/** Props of {@link TickingTime}. */
interface TickingTimeProps {
  /** The instant, epoch ms. */
  ms: number;
  /** Extra class names. */
  className?: string;
}

/** The subscribed part, so a missing value never joins the clock. */
function TickingTime({ ms, className }: TickingTimeProps) {
  const now = useNow();
  const iso = new Date(ms).toISOString();
  return (
    <time
      className={cx("relative-time", className)}
      dateTime={iso}
      title={iso}
    >
      {formatRelativeTime(ms, now)}
    </time>
  );
}
