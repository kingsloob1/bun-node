import { isRangeNotRetained } from "../api/analytics";
import { isApiError } from "../api/errors";
import { ErrorView } from "../components/ErrorView";
import "./analytics.css";

/**
 * A failed analytics read, with the one failure that is not a failure told
 * apart: `RANGE_NOT_RETAINED`.
 *
 * The API answers 400 `RANGE_NOT_RETAINED` when the **whole** range is older
 * than it keeps — deliberately, because a 200 with an empty series would read
 * as "nothing happened". So the UI must not read it as "something broke"
 * either: it says the numbers are gone, from when they are kept, and what to
 * do, and offers no Retry (the same range would fail the same way). Any other
 * error renders as the usual {@link ErrorView}.
 */

/** The `context` a `RANGE_NOT_RETAINED` problem carries. */
interface NotRetainedContext {
  /** The oldest instant kept, epoch ms. */
  retainedFrom?: number;
  /** The resolution, in seconds, that instant is the retention of. */
  resolution?: number;
}

/** Props of {@link AnalyticsError}. */
export interface AnalyticsErrorProps {
  /** What the read failed with. */
  error: unknown;
  /** The heading for any other failure, e.g. "Could not load worker analytics". */
  title: string;
  /** Retries the read; offered for any failure but `RANGE_NOT_RETAINED`. */
  onRetry: () => void;
  /** Test id on the explanation. Defaults to `range-not-retained`. */
  testId?: string;
}

/** A failed analytics read: an explanation for an unretained range, an {@link ErrorView} otherwise. */
export function AnalyticsError({
  error,
  title,
  onRetry,
  testId = "range-not-retained",
}: AnalyticsErrorProps) {
  if (!isApiError(error) || !isRangeNotRetained(error)) {
    return (
      <ErrorView
        error={error}
        title={title}
        onRetry={onRetry}
      />
    );
  }
  const context = error.context as NotRetainedContext;
  const kept =
    typeof context.retainedFrom === "number" &&
    Number.isFinite(context.retainedFrom)
      ? new Date(context.retainedFrom).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : null;
  return (
    <div
      className="range-not-retained"
      role="note"
      data-testid={testId}
    >
      <p className="range-not-retained-title">
        No numbers are kept for this range
      </p>
      <p className="range-not-retained-detail">
        The whole range is older than this API keeps
        {kept ? (
          <>
            {" "}
            — its oldest figure is from <time>{kept}</time>
          </>
        ) : null}
        . That is not the same as nothing happening: whatever was counted then
        is no longer kept. Pick a more recent range.
      </p>
    </div>
  );
}
