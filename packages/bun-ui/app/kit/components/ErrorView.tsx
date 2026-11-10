import type { IsApiError } from "./apiProblem";
import { Button } from "./Button";

/** Props of {@link ErrorView}. */
export interface ErrorViewProps {
  /** What failed: an `ApiError` renders its problem fields, anything else a generic message. */
  error: unknown;
  /** A heading override, e.g. "Could not load queues". */
  title?: string;
  /** Offers a retry button when given. */
  onRetry?: () => void;
  /**
   * Render the heading as a heading of this level instead of a paragraph.
   * Use `1` when the error replaces the whole screen, so it still has its
   * `h1`. Defaults to none (a paragraph).
   */
  headingLevel?: 1 | 2 | 3;
}

/** Props of the kit's {@link ErrorView}: a UI's, plus how it recognises its `ApiError`. */
export interface KitErrorViewProps extends ErrorViewProps {
  /** The UI's `isApiError`; its binding (`app/<ui>/components/ErrorView.tsx`) passes it. */
  isApiError: IsApiError;
}

/**
 * Renders a failed request: title, detail, code/status, and validation
 * issues. A UI renders it through its binding, which passes its `isApiError`.
 */
export function ErrorView({
  error,
  title,
  onRetry,
  headingLevel,
  isApiError,
}: KitErrorViewProps) {
  const Title = headingLevel ? (`h${headingLevel}` as const) : "p";
  const api = isApiError(error) ? error : null;
  const heading = title ?? api?.title ?? "Something went wrong";
  const detail =
    api?.detail ?? (error instanceof Error ? error.message : String(error));
  return (
    <div
      className="error-view"
      role="alert"
    >
      <Title className="error-view-title">{heading}</Title>
      {detail && detail !== heading && (
        <p className="error-view-detail">{detail}</p>
      )}
      {api && (
        <p className="error-view-meta">
          <code>{api.code}</code>
          {api.status > 0 && <span> · HTTP {api.status}</span>}
        </p>
      )}
      {api && api.issues.length > 0 && (
        <ul className="error-view-issues">
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
      {onRetry && (
        <Button
          variant="secondary"
          onClick={onRetry}
        >
          Retry
        </Button>
      )}
    </div>
  );
}
