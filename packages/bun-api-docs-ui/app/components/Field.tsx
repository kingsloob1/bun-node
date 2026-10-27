import type { ReactNode } from "react";
import type { FieldControlProps } from "./fieldContext";
import { useId, useMemo } from "react";
import { cx } from "./classNames";
import { FieldContext, joinIds } from "./fieldContext";

/** Props of {@link Field}. */
export interface FieldProps {
  /** The visible label, a `<label>` for the control. */
  label: ReactNode;
  /** Help under the control; it describes the control (`aria-describedby`). */
  hint?: ReactNode;
  /** An error under the control; it describes the control and sets `aria-invalid`. Falsy means valid. */
  error?: ReactNode;
  /** Show a required marker and mark the control required. Defaults to `false`. */
  required?: boolean;
  /** The control's id. Defaults to a generated one. */
  id?: string;
  /** Extra class names on the wrapper. */
  className?: string;
  /** The control: one of this kit's inputs (they read the wiring from context), or a render function receiving it for anything else. */
  children: ReactNode | ((control: FieldControlProps) => ReactNode);
}

/**
 * A labelled form row: label, control, hint and error. The kit's inputs
 * ({@link TextInput}, {@link NumberInput}, {@link Select},
 * {@link DateTimeInput}, `JsonEditor`) pick up the id, `aria-describedby`,
 * `aria-invalid` and `required` from it; a plain element can take them from
 * the render-function form of `children`.
 */
export function Field({
  label,
  hint,
  error,
  required = false,
  id,
  className,
  children,
}: FieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const hasError = Boolean(error);
  const control = useMemo<FieldControlProps>(
    () => ({
      id: controlId,
      "aria-describedby": joinIds(hint ? hintId : null, hasError && errorId),
      "aria-invalid": hasError || undefined,
      required: required || undefined,
    }),
    [controlId, hint, hintId, hasError, errorId, required],
  );
  return (
    <div className={cx("field", hasError && "field-invalid", className)}>
      <label
        className="field-label"
        htmlFor={controlId}
      >
        {label}
        {required && (
          <span
            className="field-required"
            aria-hidden="true"
          >
            {" "}
            *
          </span>
        )}
      </label>
      <FieldContext value={control}>
        {typeof children === "function" ? children(control) : children}
      </FieldContext>
      {hint && (
        <p
          id={hintId}
          className="field-hint"
        >
          {hint}
        </p>
      )}
      {hasError && (
        <p
          id={errorId}
          className="field-error"
        >
          {error}
        </p>
      )}
    </div>
  );
}
