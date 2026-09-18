import type { ReactNode } from "react";
import { cx } from "./classNames";

/** Colour of a {@link Badge}. */
export type BadgeTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent";

/** Props of {@link Badge}. */
export interface BadgeProps {
  /** Colour. Defaults to `"neutral"`. */
  tone?: BadgeTone;
  /** A tooltip / longer explanation. */
  title?: string;
  /** Extra class names. */
  className?: string;
  /** The text. */
  children: ReactNode;
}

/** A small status label. */
export function Badge({
  tone = "neutral",
  title,
  className,
  children,
}: BadgeProps) {
  return (
    <span
      className={cx("badge", `badge-${tone}`, className)}
      title={title}
    >
      {children}
    </span>
  );
}

/** Props of {@link Chip}. */
export interface ChipProps {
  /** What the value is, e.g. `"namespace"`. */
  label: string;
  /** The value. */
  value: ReactNode;
  /** A tooltip. */
  title?: string;
}

/** A label/value pair, e.g. `namespace  orders`. */
export function Chip({ label, value, title }: ChipProps) {
  return (
    <span
      className="chip"
      title={title}
    >
      <span className="chip-label">{label}</span>
      <span className="chip-value">{value}</span>
    </span>
  );
}
