import { isApiError } from "../api/errors";
import { Button } from "./Button";
import { cx } from "./classNames";

/** Props of {@link ProblemBanner}. */
export interface ProblemBannerProps {
  /** What failed: an `ApiError` shows its title, code, detail, context and issues; anything else its message. */
  error: unknown;
  /** A heading override, e.g. "Could not save limits". Defaults to the problem's title. */
  title?: string;
  /** Offers a Retry button when given. */
  onRetry?: () => void;
  /** Offers a Dismiss button when given. */
  onDismiss?: () => void;
  /** Extra class names. */
  className?: string;
}

/** Formats one context value for the banner: strings as-is, the rest as JSON. */
function contextText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A compact, inline error for a panel or a dialog: one line of title and
 * code, the detail, the problem's `context` as `key=value` chips, and any
 * validation issues. {@link ErrorView} is the full-size version for a screen.
 */
export function ProblemBanner({
  error,
  title,
  onRetry,
  onDismiss,
  className,
}: ProblemBannerProps) {
  const api = isApiError(error) ? error : null;
  const heading = title ?? api?.title ?? "Something went wrong";
  const detail =
    api?.detail ?? (error instanceof Error ? error.message : String(error));
  const context = api ? Object.entries(api.context) : [];
  return (
    <div
      className={cx("problem-banner", className)}
      role="alert"
    >
      <div className="problem-banner-main">
        <p className="problem-banner-title">
          <strong>{heading}</strong>
          {api && (
            <code className="problem-banner-code">
              {api.code}
              {api.status > 0 ? ` · ${api.status}` : ""}
            </code>
          )}
        </p>
        {detail && detail !== heading && (
          <p className="problem-banner-detail">{detail}</p>
        )}
        {context.length > 0 && (
          <ul
            className="problem-banner-context"
            aria-label="Context"
          >
            {context.map(([key, value]) => (
              <li key={key}>
                <span className="problem-banner-key">{key}</span>=
                <code>{contextText(value)}</code>
              </li>
            ))}
          </ul>
        )}
        {api && api.issues.length > 0 && (
          <ul className="problem-banner-issues">
            {api.issues.map((issue) => (
              <li key={`${issue.target}:${issue.path}:${issue.message}`}>
                <code>
                  {issue.target}
                  {issue.path ? `.${issue.path}` : ""}
                </code>{" "}
                {issue.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      {(onRetry || onDismiss) && (
        <div className="problem-banner-actions">
          {onRetry && (
            <Button
              size="sm"
              onClick={onRetry}
            >
              Retry
            </Button>
          )}
          {onDismiss && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onDismiss}
            >
              Dismiss
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
