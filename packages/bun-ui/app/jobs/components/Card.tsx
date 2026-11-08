import type { ReactNode } from "react";
import { useId } from "react";
import { cx } from "./classNames";

/** Props of {@link Card}. */
export interface CardProps {
  /** Heading, rendered as an `<h2>` that labels the card's region. */
  title?: ReactNode;
  /** Controls shown beside the heading. */
  actions?: ReactNode;
  /** Extra class names. */
  className?: string;
  /** The content. */
  children: ReactNode;
}

/** A bordered surface; with a `title` it is a labelled `<section>`. */
export function Card({ title, actions, className, children }: CardProps) {
  const headingId = useId();
  return (
    <section
      className={cx("card", className)}
      aria-labelledby={title ? headingId : undefined}
    >
      {(title || actions) && (
        <div className="card-header">
          {title && (
            <h2
              id={headingId}
              className="card-title"
            >
              {title}
            </h2>
          )}
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}
