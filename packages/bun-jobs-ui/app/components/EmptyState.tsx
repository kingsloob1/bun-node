import type { ReactNode } from "react";

/** Props of {@link EmptyState}. */
export interface EmptyStateProps {
  /** The headline, e.g. "No queues yet". */
  title: string;
  /** A sentence of explanation. */
  description?: ReactNode;
  /** A follow-up control. */
  action?: ReactNode;
}

/** What a list or screen shows when there is nothing to show. */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <p className="empty-state-title">{title}</p>
      {description && <p className="empty-state-description">{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
