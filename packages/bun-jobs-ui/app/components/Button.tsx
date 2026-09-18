import type { ButtonHTMLAttributes } from "react";
import { cx } from "./classNames";

/** Visual weight of a {@link Button}. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** Props of {@link Button}. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual weight. Defaults to `"secondary"`. */
  variant?: ButtonVariant;
  /** Size. Defaults to `"md"`. */
  size?: "sm" | "md";
}

/** A button; `type="button"` unless told otherwise, so it never submits a form by accident. */
export function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx(
        "btn",
        `btn-${variant}`,
        size === "sm" && "btn-sm",
        className,
      )}
    />
  );
}
