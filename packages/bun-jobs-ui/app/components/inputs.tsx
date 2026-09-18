import type {
  ChangeEvent,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
} from "react";
import { useId } from "react";
import { cx } from "./classNames";
import { joinIds, useField } from "./fieldContext";
import {
  fromDateTimeLocal,
  localTimeZone,
  parseNumberInput,
  toDateTimeLocal,
} from "./inputValues";

/**
 * The kit's form controls. Inside a {@link Field} each takes its id,
 * `aria-describedby`, `aria-invalid` and `required` from it; explicit props
 * win, and an explicit `aria-describedby` is added to the field's.
 */

/** Wiring props every control accepts. */
interface ControlWiring {
  /** The element id. Defaults to the enclosing field's. */
  id?: string;
  /** Extra description ids, added to the field's. */
  "aria-describedby"?: string;
  /** Invalid state. Defaults to the enclosing field's. */
  "aria-invalid"?: boolean;
  /** Required. Defaults to the enclosing field's. */
  required?: boolean;
}

/** Resolves a control's wiring against the enclosing field. */
function useWiring(props: ControlWiring) {
  const field = useField();
  return {
    id: props.id ?? field?.id,
    "aria-describedby": joinIds(
      field?.["aria-describedby"],
      props["aria-describedby"],
    ),
    "aria-invalid": props["aria-invalid"] ?? field?.["aria-invalid"],
    required: props.required ?? field?.required,
  };
}

/** Native input props the kit's inputs pass through (value and change are typed per control). */
type PassThroughInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  | "value"
  | "defaultValue"
  | "onChange"
  | "type"
  | "id"
  | "aria-describedby"
  | "aria-invalid"
  | "required"
  | "min"
  | "max"
  | "step"
> & {
  /** The underlying `<input>`, e.g. to focus it. */
  ref?: Ref<HTMLInputElement>;
};

/** Props of {@link TextInput}. */
export interface TextInputProps extends PassThroughInputProps, ControlWiring {
  /** The text. */
  value: string;
  /** Called with the new text on each edit. */
  onChange: (value: string, event: ChangeEvent<HTMLInputElement>) => void;
  /** The input type. Defaults to `"text"`. */
  type?: "text" | "search" | "email" | "url" | "password" | "tel";
}

/** A single-line text input. */
export function TextInput({
  value,
  onChange,
  type = "text",
  className,
  ...rest
}: TextInputProps) {
  const wiring = useWiring(rest);
  return (
    <input
      {...rest}
      {...wiring}
      type={type}
      className={cx("input", className)}
      value={value}
      onChange={(event) => onChange(event.target.value, event)}
    />
  );
}

/** Props of {@link NumberInput}. */
export interface NumberInputProps extends PassThroughInputProps, ControlWiring {
  /** The number, or `undefined` for empty. */
  value: number | undefined;
  /** Called with the new number, or `undefined` when the input is empty (or not a number). */
  onChange: (
    value: number | undefined,
    event: ChangeEvent<HTMLInputElement>,
  ) => void;
  /** Smallest allowed value (native validation only; the value is not clamped). */
  min?: number;
  /** Largest allowed value (native validation only; the value is not clamped). */
  max?: number;
  /** Step. Defaults to `1`; pass `"any"` for decimals. */
  step?: number | "any";
}

/** A number input where empty means `undefined`, never `0`. */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  className,
  ...rest
}: NumberInputProps) {
  const wiring = useWiring(rest);
  return (
    <input
      inputMode={step === "any" ? "decimal" : "numeric"}
      {...rest}
      {...wiring}
      type="number"
      className={cx("input", "input-number", className)}
      min={min}
      max={max}
      step={step}
      value={value === undefined || Number.isNaN(value) ? "" : value}
      onChange={(event) =>
        onChange(parseNumberInput(event.target.value), event)
      }
    />
  );
}

/** One option of a {@link Select}. */
export interface SelectOption<V extends string> {
  /** The value. */
  value: V;
  /** The text shown. Defaults to the value. */
  label?: string;
  /** Not selectable. */
  disabled?: boolean;
}

/** Props of {@link Select}. */
export interface SelectProps<V extends string>
  extends
    Omit<
      SelectHTMLAttributes<HTMLSelectElement>,
      | "value"
      | "defaultValue"
      | "onChange"
      | "id"
      | "aria-describedby"
      | "aria-invalid"
      | "required"
      | "multiple"
    >,
    ControlWiring {
  /** The choices. Include `{ value: "", label: "Any" }` (with `""` in `V`) for an "unset" choice. */
  options: readonly SelectOption<V>[];
  /** The selected value. */
  value: V;
  /** Called with the chosen value. */
  onChange: (value: V, event: ChangeEvent<HTMLSelectElement>) => void;
}

/** A native `<select>` over a typed set of string values. */
export function Select<V extends string>({
  options,
  value,
  onChange,
  className,
  ...rest
}: SelectProps<V>) {
  const wiring = useWiring(rest);
  return (
    <select
      {...rest}
      {...wiring}
      className={cx("input", "select", className)}
      value={value}
      onChange={(event) => {
        const chosen = options.find(
          (option) => option.value === event.target.value,
        );
        if (chosen) {
          onChange(chosen.value, event);
        }
      }}
    >
      {options.map((option) => (
        <option
          key={option.value}
          value={option.value}
          disabled={option.disabled}
        >
          {option.label ?? option.value}
        </option>
      ))}
    </select>
  );
}

/** Props of {@link Checkbox}. */
export interface CheckboxProps extends Omit<
  PassThroughInputProps,
  "checked" | "defaultChecked"
> {
  /** Whether it is ticked. */
  checked: boolean;
  /** Called with the new state. */
  onChange: (checked: boolean, event: ChangeEvent<HTMLInputElement>) => void;
  /** The label beside the box; clicking it toggles. */
  label: ReactNode;
  /** Help under the label; it describes the box. */
  hint?: ReactNode;
  /** The element id. Defaults to a generated one. */
  id?: string;
}

/** A checkbox with its own label (it does not need a {@link Field}). */
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  id,
  className,
  ...rest
}: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  return (
    <div className={cx("checkbox", className)}>
      <input
        {...rest}
        id={inputId}
        type="checkbox"
        checked={checked}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.checked, event)}
      />
      <label htmlFor={inputId}>{label}</label>
      {hint && (
        <p
          id={hintId}
          className="field-hint checkbox-hint"
        >
          {hint}
        </p>
      )}
    </div>
  );
}

/** Props of {@link DateTimeInput}. */
export interface DateTimeInputProps
  extends Omit<PassThroughInputProps, "min" | "max">, ControlWiring {
  /** The instant, epoch ms, or `undefined` for empty. */
  value: number | undefined;
  /** Called with the instant (epoch ms) the user picked, or `undefined` when cleared. */
  onChange: (
    value: number | undefined,
    event: ChangeEvent<HTMLInputElement>,
  ) => void;
  /** Earliest allowed instant, epoch ms (native validation only). */
  min?: number;
  /** Latest allowed instant, epoch ms (native validation only). */
  max?: number;
  /** Let the user pick seconds. Defaults to `false` (minute precision). */
  withSeconds?: boolean;
  /** Show the browser's time zone beside the input. Defaults to `true`. */
  showTimeZone?: boolean;
}

/**
 * A `datetime-local` input speaking epoch ms. The wall-clock value is read
 * in the browser's time zone, which is shown beside it (and part of its
 * description), so "09:00" is never ambiguous.
 */
export function DateTimeInput({
  value,
  onChange,
  min,
  max,
  withSeconds = false,
  showTimeZone = true,
  className,
  ...rest
}: DateTimeInputProps) {
  const zoneId = useId();
  const wiring = useWiring(rest);
  return (
    <span className="input-group">
      <input
        {...rest}
        {...wiring}
        aria-describedby={joinIds(
          wiring["aria-describedby"],
          showTimeZone && zoneId,
        )}
        type="datetime-local"
        className={cx("input", "input-datetime", className)}
        step={withSeconds ? 1 : 60}
        min={min === undefined ? undefined : toDateTimeLocal(min, withSeconds)}
        max={max === undefined ? undefined : toDateTimeLocal(max, withSeconds)}
        value={toDateTimeLocal(value, withSeconds)}
        onChange={(event) =>
          onChange(fromDateTimeLocal(event.target.value), event)
        }
      />
      {showTimeZone && (
        <span
          id={zoneId}
          className="input-suffix"
        >
          {localTimeZone()}
        </span>
      )}
    </span>
  );
}
