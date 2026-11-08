import type { ReactNode } from "react";

/** Props of {@link EmptyState}. */
export interface EmptyStateProps {
  /** The headline, e.g. "No queues yet". */
  title: string;
  /** A sentence of explanation. */
  description?: ReactNode;
  /** A follow-up control. */
  action?: ReactNode;
  /**
   * Render the headline as a heading of this level instead of a paragraph.
   * Use `1` when the empty state IS the screen (a not-found or hidden screen
   * has no other `h1`). Defaults to none (a paragraph).
   */
  headingLevel?: 1 | 2 | 3;
}

/** What a list or screen shows when there is nothing to show. */
export function EmptyState({
  title,
  description,
  action,
  headingLevel,
}: EmptyStateProps) {
  const Title = headingLevel ? (`h${headingLevel}` as const) : "p";
  return (
    <div className="empty-state">
      <Title className="empty-state-title">{title}</Title>
      {description && <p className="empty-state-description">{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
